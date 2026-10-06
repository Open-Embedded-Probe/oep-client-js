// @ts-check
// port_speed (oep-if-link §3 is the handshake, an op of the optional oep.probe.link; the host's procedure is oep-spec docs/host-development-guide.md §17,
// followed here): a faster UART bridge for one session, opt-in. `raiseSpeed` asks a probe that declares it for a
// faster rate on the serial port this host opened (it finds oep.probe.link by name and reads port_speed in its ops).
//
// The minimal form (§17.2, the default): try a candidate -> switch to the requested baud (the probe's answered baud
// only when the platform refuses it: WebSerial `open({ baudRate })`, serialport `update`) -> settle 20 ms -> confirm
// (100 ms, up to 3) -> commit. About 50 ms, no measurement. The full form (`verify: true`, or `flows` given; §17.3): a
// baseline at the boot speed per flow (this session's frames when 60 or more and under 10 %, else 60 measured per flow
// at its n; over 10 % once more at n = 1), then per candidate every flow the caller will use (in = oep.probe.link source,
// out = sink, duplex = both interleaved, each with its in-flight n) for 16 frames at max_frame - 26, a flow failing on
// broken + lost >= 3 and a ratio over max(2 x baseline, 5 %), run once more at n = 1 before giving up on it (then n = 1
// is the link's cap), one failed flow failing the candidate; commit when every flow passed. A failed candidate: revert
// (step 2, at the new rate), the boot speed, confirms up to port_speed_idle_max_ms + 1 s. The report (`host.link.speed`)
// records the baseline, every candidate's flows and the step downs - for budgeting a capture or a write. In use the
// link holds a new rate to a probation first (32 KiB and 1 s, judged as the verify judges a flow: a breakage there is a
// verify failure), then judges the frames of the last 3 s (none under 50) over max(2 x baseline, 10 %); a breakdown
// steps down to the next lower candidate that has not failed in the session, a fresh try -> confirm -> verify ->
// commit, and to the boot speed only when none is left (link.js). `maxTries` bounds the candidates one call tries.
// `record: true` keeps passed / failed rates per (port, unit_id) - a pass 30 days, a failure 1 day, a failure measured
// within 2 s of a breakdown at another rate unknown (speedrecord.js) - and puts passed rates first, failed ones out
// (all failed: the slowest is tried once). The same procedure as oep-client-python's link.raise_speed.

import * as reg from './registry.js';
import * as m from './message.js';
import * as core from './core.js';
import * as cobs from './cobs.js';
import { getU32, text } from './bytes.js';
import { Failed, Rejected, Timeout } from './errors.js';
import { IDLE_MAX_MS, KEEPALIVE_MS, OPEN_RETRY_MS } from './link.js';
import { SpeedRecord, defaultStore, fileStore } from './speedrecord.js';

const OP_PORT_SPEED = reg.PROBE_LINK.op.port_speed;
const STEP = reg.PROBE_LINK.enum.port_speed_step;
const UNIT_ID_TAG = reg.CORE.tlv.describe.unit_id;
const UART_BRIDGE = reg.CORE.enum.transport_kind.uart_bridge;

/** Host guide §17.2: one candidate that passed the measured bridges in small duplex use. */
export const DEFAULT_CANDIDATES = Object.freeze([500000]);
/** probe -> host (oep.probe.link source), host -> probe (sink), both interleaved. */
export const FLOWS = /** @type {const} */ (['in', 'out', 'duplex']);
/** The probe waits this long for the commit (guide §17.2 / §17.3.2: 2000). */
export const VERIFY_MS = 2000;
/** After the switch: confirm, 100 ms each, up to 3 (oep-if-link §3 obligation 2). */
export const CONFIRM_TRIES = 3, CONFIRM_WAIT_MS = 100;
/** Full form: at least this many frames per flow (guide §17.3.2 item 3-3) ... */
export const FLOW_FRAMES = 16;
/** ... a flow fails only on broken + lost of at least this ... */
export const FLOW_FAIL_MIN = 3;
/** ... and a ratio over max(2 x baseline, this) (item 3-4). */
export const VERIFY_FLOOR = 0.05;
/** The boot speed's ratio: this session's frames, or this many measured per flow (item 2). */
export const BASELINE_FRAMES = 60;
/** A flow whose baseline is over this is measured again at n = 1; still over: not raised. */
export const BASELINE_MAX = 0.10;
/** In use, a new rate's first period (guide §17.3.2 item 4): this many bytes both ways ... */
export const PROBATION_BYTES = 32 * 1024;
/** ... and this long since the commit, judged as the verify judges a flow. */
export const PROBATION_MS = 1000;
/** Results measured this soon after a breakdown at another rate are not failures (unknown). */
export const SETTLE_MS = 2000;

/** @typedef {'in' | 'out' | 'duplex'} Flow */
/** @typedef {Flow | [Flow, number?]} FlowSpec  a flow at the most this link keeps in flight, or (flow, n); n 0 = that most */

/**
 * One flow run at one rate (guide §17.5 record): the flow, its in-flight n, frames, broken (an answer came but its
 * content is wrong), lost (no answer within the wait; a broken COBS frame on the held port is read as one), KB/s
 * (1000 B/s), whether it passed, `gone` (the probe stopped answering at this rate: it went back), `ratio` = (broken +
 * lost) / frames, `name` = "flow@n".
 * @typedef {{ flow: Flow, n: number, frames: number, broken: number, lost: number, kbS: number, passed: boolean,
 *   gone: boolean, readonly ratio: number, readonly name: string }} FlowResult
 */

/**
 * One candidate: what the probe said it runs at (`actual`), the rate the host switched to (`switched`), the flows
 * verified (full form; a flow run again at n = 1 appears twice), whether it was committed and why not, `nCap` (the
 * in-flight cap the rate passed with: 1 when a flow needed n = 1, 0 none), the last run's KB/s per flow (null
 * without a measurement), `probation` (committed: 'running', 'passed' or 'failed'; 'off': none), `probationBytes`
 * (moved at the rate in it so far), `settling` (measured within settleMs of a breakdown at another rate: a failure is
 * noted unknown).
 * @typedef {{ rate: number, actual: number | null, switched: number | null, flows: FlowResult[], committed: boolean,
 *   why: string, nCap: number, probation: '' | 'running' | 'passed' | 'failed' | 'off', probationBytes: number,
 *   settling: boolean, readonly inKBs: number | null, readonly outKBs: number | null,
 *   readonly duplexKBs: number | null, flow: (name: Flow) => FlowResult | null }} SpeedTrial
 */

/** A step down in use (guide §17.3.2 item 5): when (ms since the epoch), from which rate, why, the ratio that decided it
 * (the window's or the probation's; null: no answer), the rate the link went to (`to`: the next lower candidate that
 * passed, or the boot speed), whether the rate was still in its probation (then it counts as a verify failure).
 * @typedef {{ at: number, rate: number, why: string, ratio: number | null, to: number | null, probation: boolean }} StepDown */

/**
 * raiseSpeed's answer (also `link.speed`): the boot speed, the rate in force now (`rate`), the committed one (`chosen`,
 * null: the boot speed), every candidate in order, why nothing was tried (`supported` false). `verified`: the full
 * form ran; `baseline`: flow -> the boot speed's ratio (from this session's `baselineFrames` frames, or measured:
 * `baselineFlows`). `lost`: a raised rate was later found gone (the link went back to the boot speed). `steppedDown`:
 * in use, the link left a raised rate (`downWhy`; every one in `stepDowns`, each with the rate it went to). `skipped`:
 * candidates the record left out as failed; `retried`: the slowest candidate, tried although the record marks every one
 * failed; `capped`: candidates maxTries left out. inKBs / outKBs / duplexKBs: the chosen rate's measured throughput
 * (null without a measurement) - for budgeting a transfer.
 * @typedef {{ base: number, supported: boolean, rate: number, chosen: number | null, trials: SpeedTrial[], why: string,
 *   lost: boolean, steppedDown: boolean, downWhy: string, verified: boolean, baseline: Record<string, number>,
 *   baselineFrames: number, baselineFlows: FlowResult[], stepDowns: StepDown[], skipped: number[],
 *   retried: number | null, capped: number[],
 *   readonly inKBs: number | null, readonly outKBs: number | null, readonly duplexKBs: number | null }} SpeedReport
 */

/** @param {Flow} flow @param {number} n @returns {FlowResult} */
export function flowResult(flow, n) {
  return {
    flow, n, frames: 0, broken: 0, lost: 0, kbS: 0, passed: false, gone: false,
    get ratio() { return this.frames ? (this.broken + this.lost) / this.frames : 0; },
    get name() { return `${this.flow}@${this.n}`; },
  };
}

/** @param {number} rate @returns {SpeedTrial} */
function speedTrial(rate) {
  /** @type {SpeedTrial} */
  const t = {
    rate, actual: null, switched: null, flows: [], committed: false, why: '', nCap: 0, probation: '', probationBytes: 0, settling: false,
    flow(name) { return [...this.flows].reverse().find((f) => f.flow === name) ?? null; },
    get inKBs() { const f = this.flow('in'); return f && f.frames ? f.kbS : null; },
    get outKBs() { const f = this.flow('out'); return f && f.frames ? f.kbS : null; },
    get duplexKBs() { const f = this.flow('duplex'); return f && f.frames ? f.kbS : null; },
  };
  return t;
}

/** The committed trial of the rate in force (the last, after step downs). @param {SpeedReport} r */
const chosenTrial = (r) => (r.chosen ? [...r.trials].reverse().find((t) => t.committed && t.rate === r.chosen) ?? null : null);

/** @param {number} base @param {number} rate @returns {SpeedReport} */
function speedReport(base, rate) {
  /** @type {SpeedReport} */
  const r = {
    base, supported: false, rate, chosen: null, trials: [], why: '', lost: false, steppedDown: false, downWhy: '',
    verified: false, baseline: {}, baselineFrames: 0, baselineFlows: [], stepDowns: [], skipped: [], retried: null, capped: [],
    get inKBs() { return chosenTrial(this)?.inKBs ?? null; },
    get outKBs() { return chosenTrial(this)?.outKBs ?? null; },
    get duplexKBs() { return chosenTrial(this)?.duplexKBs ?? null; },
  };
  return r;
}

/** @param {number} port @param {number} baud @param {number} step @param {number} verifyMs @param {number} idleMs */
function request(port, baud, step, verifyMs, idleMs) {
  const out = new Uint8Array(12);
  const v = new DataView(out.buffer);
  v.setUint8(0, port);
  v.setUint32(1, baud, true);
  v.setUint8(5, step);
  v.setUint16(6, verifyMs, true);
  v.setUint32(8, idleMs, true);
  return out;
}

/** confirm's transport from a broker that answers the session ops itself (transports §1, core §7.1): no port of the probe. */
export const RELAYING_BROKER = 0xff;

/** The port this host's requests come in on (the transport TLV of confirm's answer, core §7.1, C-05) when the probe
 * offers oep.probe.link with port_speed in its ops (oep-if-link §1) and that transport is a UART bridge: [the oep.probe.link fn,
 * the port, '']; else nulls and why not.
 * @param {import('./host.js').Host} hst @returns {Promise<[number | null, number | null, string]>} */
export async function speedPort(hst) {
  let fn;
  try { fn = await core.linkFn(hst); } catch (e) {
    if (e instanceof m.OepError && !(e instanceof Rejected)) return [null, null, 'the probe does not offer oep.probe.link'];
    throw e;
  }
  if (!(await core.offers(hst, fn, OP_PORT_SPEED))) return [null, null, 'the probe\'s oep.probe.link does not offer port_speed (its ops)'];
  const index = (hst.limits ?? await hst.confirm()).transport;
  if (index === null || index === undefined) return [null, null, 'the probe\'s confirm names no transport (core §7.1 requires it)'];
  if (index === RELAYING_BROKER) return [null, null, 'a relaying broker answers the confirm (transport 0xFF): no port of this probe to raise'];
  const kind = (await core.probeInfo(hst)).transports.find((t) => t.index === index)?.kind;
  return kind === UART_BRIDGE ? [fn, index, ''] : [null, null, `this host's transport (index ${index}) is not a UART bridge`];
}

/** The probe's unit_id (core §7.5, mandatory) - the record's key with the port. @param {import('./host.js').Host} hst */
export async function unitId(hst) {
  for (const [tag, v] of await core.describe(hst, 0)) if ((tag & 0x7f) === UNIT_ID_TAG && v.length) return text(v);
  return '?';
}

/** @param {unknown} e */
const linkError = (e) => e instanceof Timeout || e instanceof cobs.CorruptFrame;
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A source answer that is completed success with `data` exactly (len(u16) data [TLV]), or a sink answer that is
 * completed success: what a flow counts as good (oep-if-link §2).
 * @param {'in' | 'out'} kind @param {Uint8Array} raw @param {Uint8Array} data */
export function linkAnswerGood(kind, raw, data) {
  try {
    const r = m.Result.unpack(raw);
    if (!r.succeeded) return false;
    if (kind !== 'in') return true;
    const got = core.linkSourceData(r.payload);
    return got.length === data.length && got.every((b, k) => b === data[k]);
  } catch (e) {
    if (e instanceof m.ProtocolError) return false;
    throw e;
  }
}

/** How long one answer of a flow is waited for: four frames' worth on the line per request in flight, at least 300 ms.
 * @param {number} size @param {number} rate @param {number} n */
export function answerWaitMs(size, rate, n) { return Math.max(300, 4 * (size + 24) * 10 / rate * n * 1000 + 100); }

/** A confirm at the rate now, up to CONFIRM_TRIES of CONFIRM_WAIT_MS: true when one came back. @param {import('./link.js').Link} link */
async function confirmAgain(link) {
  for (let i = 0; i < CONFIRM_TRIES; i++) if (await link.confirmRaw(CONFIRM_WAIT_MS)) return true;
  return false;
}

/** A keepalive at the rate in force (no resend) so the lease outlasts a flow; a failure is the flow's to find.
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link */
async function keep(hst, link) {
  if (hst.session === null || !link.keepaliveFrame) return;
  try { await link.sendOnce(link.keepaliveFrame(), { resend: false }); } catch (e) { if (!linkError(e)) throw e; }
}

/**
 * `frames` of one flow at the rate in force, `n` in flight, `size` bytes each, counted as the guide counts (§17.3.2):
 * broken = an answer came but its content is wrong, lost = no answer within the wait (a broken COBS frame on the held
 * port is read as one: the link drops the request at once). After lost frames the link is put in step again with a
 * confirm; when none is answered the probe is not at this rate any more (it went back) and the flow stops there, the
 * frames not sent counted lost (`gone`).
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link
 * @param {Flow} flow @param {number} n @param {number} size @param {number} frames @param {number} rate
 */
export async function flowRun(hst, link, flow, n, size, frames, rate) {
  const res = flowResult(flow, n);
  const limits = await hst.confirmed();
  const inflight = Math.max(1, Math.min(n, Math.floor(limits.window / (size + 24))));   // the probe's window too
  const data = Uint8Array.from({ length: size }, (_, k) => k & 0xff);
  const sizeBody = core.linkSourceRequest(size), sinkBody = core.linkSinkRequest(data);
  const fn = /** @type {number} */ (link.speedFn ?? await core.linkFn(hst));
  const timeoutMs = answerWaitMs(size, rate, n);
  await keep(hst, link);
  let moved = 0;
  const t0 = performance.now();
  while (res.frames < frames) {
    const batch = Math.min(2 * n, frames - res.frames);
    /** @type {('in' | 'out')[]} */
    const kinds = Array.from({ length: batch }, (_, k) => (flow !== 'duplex' ? flow : ((res.frames + k) % 2 === 0 ? 'in' : 'out')));
    const msgs = kinds.map((k) => new m.Request(hst.nextCorr(), fn, k === 'in' ? core.LINK_SOURCE : core.LINK_SINK,
      k === 'in' ? sizeBody : sinkBody).pack());
    /** @type {Promise<Uint8Array>[]} */
    const answers = [];
    for (let i = 0; i < msgs.length; i++) {
      if (i >= inflight) await answers[i - inflight].catch(() => {});
      answers.push(link.sendOnce(msgs[i], { timeoutMs, resend: false }));
    }
    const settled = await Promise.allSettled(answers);
    let lost = 0;
    settled.forEach((st, i) => {
      if (st.status !== 'fulfilled') {
        if (!linkError(st.reason)) throw st.reason;   // the link itself failed (closed): not a frame
        lost++;
        return;
      }
      const good = linkAnswerGood(kinds[i], st.value, data);
      if (good) moved += size; else res.broken++;
    });
    res.lost += lost;
    res.frames += msgs.length;
    if (lost && !(await confirmAgain(link))) {
      res.lost += frames - res.frames;
      res.frames = frames;
      res.gone = true;
      break;
    }
  }
  const seconds = (performance.now() - t0) / 1000;
  res.kbS = seconds > 0 ? moved / seconds / 1000 : 0;
  return res;
}

/**
 * The caller's flows as [flow, n]: n 0 / missing = the most this link keeps in flight (`nMax`), more is capped there;
 * null = every flow at nMax (in, out, duplex).
 * @param {FlowSpec[] | null | undefined} flows @param {number} nMax @returns {[Flow, number][]}
 */
export function resolveFlows(flows, nMax) {
  if (flows == null) return FLOWS.map((f) => [f, nMax]);
  return flows.map((item) => {
    const [flow, n] = typeof item === 'string' ? [item, 0] : [item[0], item[1] ?? 0];
    if (!FLOWS.includes(flow)) throw new RangeError(`flow ${JSON.stringify(flow)}: one of ${FLOWS.join(', ')}`);
    return [flow, Math.max(1, Math.min(Math.trunc(Number(n)) || nMax, nMax))];
  });
}

/**
 * The boot speed's ratio per flow (guide §17.3.2 item 2): `given`, or this session's frames at the boot speed when
 * BASELINE_FRAMES or more were exchanged and under BASELINE_MAX, else BASELINE_FRAMES measured per flow at its n (over
 * BASELINE_MAX: again at n = 1, which then caps that flow). -> '' or why the port is not raised at all.
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link @param {SpeedReport} report
 * @param {[Flow, number][]} flows @param {number | null} given @param {number} size
 */
async function baselineOf(hst, link, report, flows, given, size) {
  if (given !== null) {
    report.baseline = Object.fromEntries(flows.map(([flow]) => [flow, Number(given)]));
    return '';
  }
  const c = link.baseCounts;
  const total = c.good + c.broken + c.lost;
  const base = /** @type {number} */ (link.baseBaud);
  if (total >= BASELINE_FRAMES && (c.broken + c.lost) / total <= BASELINE_MAX) {
    report.baselineFrames = total;
    report.baseline = Object.fromEntries(flows.map(([flow]) => [flow, (c.broken + c.lost) / total]));
    return '';
  }
  for (let i = 0; i < flows.length; i++) {
    const [flow, n] = flows[i];
    let res = await flowRun(hst, link, flow, n, size, BASELINE_FRAMES, base);
    report.baselineFlows.push(res);
    if (res.ratio > BASELINE_MAX && n > 1) {
      res = await flowRun(hst, link, flow, 1, size, BASELINE_FRAMES, base);
      report.baselineFlows.push(res);
      if (res.ratio <= BASELINE_MAX) flows[i] = [flow, 1];
    }
    if (res.ratio > BASELINE_MAX) {
      return `the boot speed ${base} itself loses ${Math.round(res.ratio * 100)}% of ${res.name} frames (over ${Math.round(BASELINE_MAX * 100)}%): not raised`;
    }
    report.baseline[flow] = res.ratio;
  }
  return '';
}

/**
 * Every flow at the new rate (guide §17.3.2 items 3-3 / 3-4): `frames` or more, failing on broken + lost of
 * FLOW_FAIL_MIN or more and a ratio over max(2 x baseline, VERIFY_FLOOR); a failed flow at n > 1 runs again at n = 1
 * (then the trial's nCap is 1). One failed flow fails the candidate (trial.why says which).
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link @param {number} rate
 * @param {SpeedTrial} trial @param {[Flow, number][]} flows @param {Record<string, number>} baseline
 * @param {number} frames @param {number} size
 */
async function verifyFlows(hst, link, rate, trial, flows, baseline, frames, size) {
  for (const [flow, n] of flows) {
    const threshold = Math.max(2 * (baseline[flow] ?? 0), VERIFY_FLOOR);
    let res = flowResult(flow, n), k = n;
    for (k of (n > 1 ? [n, 1] : [n])) {
      res = await flowRun(hst, link, flow, k, size, frames, rate);
      res.passed = !res.gone && !(res.broken + res.lost >= FLOW_FAIL_MIN && res.ratio > threshold);
      trial.flows.push(res);
      if (res.passed || res.gone) break;
    }
    if (res.gone) {
      trial.why = `${res.name}: no answer at ${rate} any more (the probe went back)`;
      return false;
    }
    if (!res.passed) {
      trial.why = `${res.name}: ${res.broken + res.lost} of ${res.frames} frames broken or lost (${Math.round(res.ratio * 100)}%, over ${Math.round(threshold * 100)}%)`;
      return false;
    }
    if (k < n) trial.nCap = 1;
  }
  return true;
}

/**
 * port_speed (oep-oep-if-link §3) on the UART bridge this host opened, by the host guide's §17 procedure: try `candidates`
 * in order and commit the first that passes. The session must be open (the rate lasts as long as it does).
 *
 * The minimal form (§17.2, the default; about 50 ms, no measurement): try -> switch to the requested baud (the probe's
 * answer only when the platform refuses it) -> 20 ms -> confirm (100 ms, up to 3) -> commit. The full form (`verify:
 * true`, or `flows` given; §17.3): first the boot speed's baseline per flow (`baseline` given, this session's frames at
 * the boot speed when 60 or more, else 60 frames measured per flow at its n - over 10 % again at n = 1, still over: not
 * raised), then per candidate every flow for `frames` (16) frames of max_frame - 26 bytes - the quick gate; a flow
 * fails on broken + lost >= 3 and a ratio over max(2 x baseline, 5 %), runs again at n = 1 first (then n = 1 is the
 * link's cap), and one failed flow fails the candidate. `flows`: 'in' | 'out' | 'duplex' or [flow, n] (n 0 = the most
 * this link keeps in flight; default: all three at that n) - verify only what the session will use (§17.3.1).
 *
 * A failed candidate: revert (step 2, at the new rate; its answer need not come), the boot speed, confirms up to
 * port_speed_idle_max_ms + 1 s (an Error when none is answered). verifyMs: how long the probe waits for the commit
 * (default VERIFY_MS 2000, kept a second under the lease). idleMs: once committed, the probe reverts after this long
 * with no good frame (default and at most 3000; 0 and more mean that); the link's keepalive interval is set under half
 * of it.
 *
 * In use (§17.3.2 item 4): the first period at a committed rate is its probation - until `probationBytes` (32 KiB,
 * both ways) have moved and `probationMs` (1000) have passed; 0 and 0: none - judged as the verify judges a flow (3
 * or more broken or lost over max(2 x baseline, 5 %)) or a missed answer: either steps down at once and counts as a
 * verify failure. After it the last 3 s are judged (none under 50 frames): over max(2 x baseline, 10 %) broken or
 * lost, or a missed answer, steps down. A step down: revert, the boot speed, then the next lower candidate of this call
 * that has not failed in this session gets a fresh try -> confirm -> verify -> commit (the boot speed when none is
 * left). A rate that broke in use in this session is not tried again in it, nor any rate above it
 * (`report.stepDowns` says where each step went).
 *
 * `record`: true = this environment's default store (Node: `~/.cache/oep-client/link-speed.json`; a browser:
 * localStorage), or a file path (Node), or a SpeedRecord - passed rates go first, failed ones are skipped
 * (`report.skipped`; when every candidate is marked failed, the slowest is tried once anyway: `report.retried`), and
 * this run's outcomes are written; a failure measured within `settleMs` (2000) of a breakdown at another rate is
 * written unknown (off by default). maxTries: the most candidates tried in this call after the record ordered and
 * filtered them (null = all; the rest: `report.capped`; a step down in use goes only to these). port: the transport
 * index (default: the probe's first UART bridge). A link that cannot change its rate (USB, a broker's TCP) and a probe
 * without the feature are reported not supported and stay at their speed. -> the report, also kept as
 * `host.link.speed`.
 * @param {import('./host.js').Host} hst @param {readonly number[]} [candidates]
 * @param {{ flows?: FlowSpec[] | null, verify?: boolean | null, baseline?: number | null, frames?: number,
 *   verifyMs?: number, idleMs?: number, port?: number, record?: boolean | string | SpeedRecord,
 *   maxTries?: number | null, probationBytes?: number, probationMs?: number, settleMs?: number }} [opts]
 * @returns {Promise<SpeedReport>}
 */
export async function raiseSpeed(hst, candidates = DEFAULT_CANDIDATES, { flows = null, verify = null, baseline = null,
  frames = FLOW_FRAMES, verifyMs, idleMs = IDLE_MAX_MS, port, record = false, maxTries = null,
  probationBytes = PROBATION_BYTES, probationMs = PROBATION_MS, settleMs = SETTLE_MS } = {}) {
  const link = hst.link;
  const base = link.baseBaud;
  const report = speedReport(base ?? 0, link.baud ?? 0);
  link.speed = report;
  if (base === null || link.framing !== 'cobs') {
    report.why = 'the link is not a serial port this host opened';
    return report;
  }
  const [fn, where, why] = await speedPort(hst);
  if (where === null) { report.why = why; return report; }
  link.speedFn = fn;
  if (hst.session === null) throw new m.OepError('raiseSpeed needs an open session (the rate lasts as long as the session)');
  const at = port ?? where;
  report.supported = true;
  const full = verify ?? flows !== null;
  report.verified = full;
  const leaseMs = hst.leaseMs ?? 0;
  const wait = Math.min(65535, verifyMs ?? Math.min(VERIFY_MS, leaseMs ? Math.max(500, leaseMs - 1000) : VERIFY_MS));
  idleMs = idleMs > 0 && idleMs <= IDLE_MAX_MS ? idleMs : IDLE_MAX_MS;
  if (link.unusableSession !== hst.session) {
    link.unusable = new Map();
    link.failed = new Map();
    link.unusableSession = hst.session;
    link.brokeAt = link.brokeRate = null;
  }
  /** @type {SpeedRecord | null} */
  let rec = null;
  if (record) {
    const unit = await unitId(hst);
    if (SpeedRecord.namesAUnit(unit)) {
      rec = record instanceof SpeedRecord ? record : new SpeedRecord(typeof record === 'string' ? await fileStore(record) : await defaultStore());
      link.record = rec;
      link.recordKey = [link.transport.path ?? (typeof process !== 'undefined' && process.versions?.node ? '<stream>' : null), unit];
    } else {                                    // an x- unit_id names no unit: nothing kept (core §7.5, C-24)
      link.record = null;
      link.recordKey = null;
      report.why = `unit_id ${unit} names no unit (core §7.5): no speed record`;
    }
  }
  /** @type {Run} */
  const run = { flowSpecs: flows, flows: [], verify: full, frames, wait, idleMs, at, rec, size: 0,
    probationBytes: Math.max(0, Math.trunc(probationBytes)), probationMs: Math.max(0, probationMs), settleMs };
  link.fallback = false;   // every failure here is handled here
  try {
    return await raise(hst, link, report, [...candidates], run, baseline, maxTries);
  } finally {
    link.fallback = true;
  }
}

/**
 * One raiseSpeed call's settings, kept for its step downs in use.
 * @typedef {{ flowSpecs: FlowSpec[] | null, flows: [Flow, number][], verify: boolean, frames: number, wait: number,
 *   idleMs: number, at: number, rec: SpeedRecord | null, size: number, probationBytes: number, probationMs: number,
 *   settleMs: number }} Run
 */

/** Why `rate` is not tried in this session: it broke in use in it, or it is above a rate that did (no up and down).
 * @param {import('./link.js').Link} link @param {number} rate */
function barred(link, rate) {
  if (link.unusable.has(rate)) return `broke in use earlier in this session (${link.unusable.get(rate)})`;
  if (link.unusable.size) {
    const ceiling = Math.min(...link.unusable.keys());
    if (rate > ceiling) return `above ${ceiling}, which broke in use in this session`;
  }
  return '';
}

/** A port_speed request straight on the line (no wait for a step down under way: raiseSpeed may run inside one).
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link @param {Uint8Array} payload */
async function speedCall(hst, link, payload) {
  const req = new m.Request(hst.nextCorr(), /** @type {number} */ (link.speedFn), OP_PORT_SPEED, payload, hst.session);
  const result = m.Result.unpack(await link.sendOnce(req.pack()));
  if (result.resolution === m.REJECTED) throw new Rejected(result);
  if (!result.succeeded) throw new Failed(result);
  return result;
}

/**
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link @param {SpeedReport} report
 * @param {number[]} candidates @param {Run} run @param {number | null} baseline @param {number | null} maxTries
 */
async function raise(hst, link, report, candidates, run, baseline, maxTries) {
  const limits = await hst.confirmed();
  run.size = core.linkSize(limits.maxFrame);                 // what one source answer carries (oep-if-link §2)
  const nMax = link.inflightFor(limits);
  const key = link.recordKey;
  if (run.rec && key) {
    const { passed, failed } = run.rec.lookup(key[0], key[1]);
    if (candidates.length && candidates.every((r) => failed.includes(r))) {
      const slowest = Math.min(...candidates);   // every one marked failed: the slowest once more
      report.retried = slowest;
      report.skipped = candidates.filter((r) => r !== slowest);
      candidates = [slowest];
    } else {
      report.skipped = candidates.filter((r) => failed.includes(r));
      candidates = [...candidates.filter((r) => passed.includes(r)), ...candidates.filter((r) => !passed.includes(r) && !failed.includes(r))];
    }
  }
  /** @type {number[]} */
  let rates = [];
  for (const rate of candidates) {
    const why = barred(link, rate);
    if (why) { const t = speedTrial(rate); t.why = why; report.trials.push(t); } else rates.push(rate);
  }
  if (maxTries !== null && maxTries !== undefined && rates.length > Math.max(0, maxTries)) {
    report.capped = rates.slice(Math.max(0, maxTries));
    rates = rates.slice(0, Math.max(0, maxTries));
  }
  if (!rates.length) return report;
  if (run.verify) {
    run.flows = resolveFlows(run.flowSpecs, nMax);
    const why = await baselineOf(hst, link, report, run.flows, baseline, run.size);
    if (why) { report.why = why; return report; }
  }
  const session = hst.session;
  link.speedPlan = { rates: [...rates], session, go: (lower) => (hst.session === session ? tryRates(hst, link, report, lower, run) : Promise.resolve(null)) };
  return tryRates(hst, link, report, rates, run);
}

/**
 * Each of `rates` in order until one is committed (raiseSpeed's own loop, also a step down's in use).
 * @param {import('./host.js').Host} hst @param {import('./link.js').Link} link @param {SpeedReport} report
 * @param {number[]} rates @param {Run} run
 */
async function tryRates(hst, link, report, rates, run) {
  const base = /** @type {number} */ (link.baseBaud);
  const { rec, at, wait, idleMs } = run;
  const key = link.recordKey;
  /** @param {SpeedTrial} trial @param {boolean} passed @param {string} phase */
  const note = (trial, passed, phase) => { if (rec && key) rec.note(key[0], key[1], trial.rate, trial.settling && !passed ? null : passed, phase); };
  /** A candidate the line failed: a step down in this session goes below it, the record says so (unknown when measured
   * soon after a breakdown at another rate), and the next results settle from now. @param {SpeedTrial} trial @param {string} phase */
  const failed = (trial, phase) => {
    link.failed.set(trial.rate, trial.why);
    note(trial, false, phase);
    link.brokeAt = performance.now();
    link.brokeRate = trial.rate;
  };
  /** A candidate that did not pass: revert at the rate now (its answer need not come), the boot speed, confirmed within
   * port_speed_idle_max_ms + 1 s (or verify_ms and a second when that is longer). @param {number} rate @param {boolean} revert */
  const back = async (rate, revert) => {
    if (revert) {
      const msg = new m.Request(hst.nextCorr(), /** @type {number} */ (link.speedFn), OP_PORT_SPEED, request(at, rate, STEP.revert, 0, 0), hst.session).pack();
      await link.sendOnce(msg, { timeoutMs: 300, resend: false }).catch(() => {});   // lost at that rate, or the probe is back already
    }
    if (!(await link.backToBase(Math.max(OPEN_RETRY_MS, wait + 1000)))) throw new Error(`after trying ${rate}: no answer at the boot speed ${base}`);
    report.rate = base;
  };

  for (const rate of rates) {
    const trial = speedTrial(rate);
    report.trials.push(trial);
    trial.why = barred(link, rate);
    if (trial.why) continue;
    trial.settling = link.brokeAt !== null && link.brokeRate !== rate && performance.now() - link.brokeAt < run.settleMs;
    let answer;
    try {
      answer = await speedCall(hst, link, request(at, rate, STEP.try, wait, idleMs));
    } catch (e) {
      if (e instanceof Timeout) {
        trial.why = 'no answer to the try';   // it may have switched: wait it out at the boot speed
        await back(rate, false);
        continue;
      }
      if (!(e instanceof Rejected)) throw e;
      if (e.result.detail === m.REJECT.unknown_operation) {
        report.supported = false;
        report.why = 'the probe does not take port_speed (unknown_operation)';
        report.trials.pop();
        return report;
      }
      if (e.result.detail !== m.REJECT.unsupported) {
        trial.why = e.message;
        break;   // wrong port, locked, ...: nothing else will do better
      }
      trial.why = "unsupported: the probe's UART cannot make it";
      note(trial, false, 'try');
      continue;
    }
    trial.actual = getU32(answer.payload);
    try {
      trial.switched = await link.setBaud(rate, trial.actual);   // the requested baud; the probe's only if the platform refuses
    } catch (e) {
      trial.why = `the platform refuses ${rate} and ${trial.actual}: ${e instanceof Error ? e.message : e}`;
      link.baud = rate;                                           // wait the probe out (verify_ms), then the boot speed
      await sleep(wait);
      await back(rate, false);
      note(trial, false, 'try');
      continue;
    }
    if (!(await confirmAgain(link))) {
      trial.why = 'no confirm at the new rate';
      await back(rate, true);
      failed(trial, 'confirm');
      continue;
    }
    if (run.verify && !(await verifyFlows(hst, link, rate, trial, run.flows, report.baseline, run.frames, run.size))) {
      await back(rate, true);
      failed(trial, 'verify');
      continue;
    }
    try {
      await speedCall(hst, link, request(at, rate, STEP.commit, 0, idleMs));
    } catch (e) {
      if (!(e instanceof Timeout || e instanceof Rejected || e instanceof Failed)) throw e;
      trial.why = `the commit failed: ${e.message}`;
      await back(rate, false);
      continue;
    }
    trial.committed = true;
    report.rate = rate;
    report.chosen = rate;
    link.inflightCap = trial.nCap;
    link.speedPort = at;
    link.baselineRatio = Math.max(0, ...Object.values(report.baseline));
    link.keepaliveMs = Math.min(KEEPALIVE_MS, idleMs / 2.5);   // under half of idle_ms (oep-if-link §3 obligation 4)
    link.window = [];
    link.stepDue = '';
    note(trial, true, run.verify ? 'verify' : 'confirm');
    if (run.probationBytes || run.probationMs) {
      trial.probation = 'running';
      link.probation = { rate, trial, bytes: run.probationBytes, ms: run.probationMs, threshold: Math.max(2 * link.baselineRatio, VERIFY_FLOOR),
        started: performance.now(), settling: trial.settling, moved: 0, frames: 0, bad: 0 };
    } else {
      trial.probation = 'off';
      link.probation = null;
    }
    return report;
  }
  return report;
}

/** @param {number} v @param {number} digits */
const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** The report as text: the baseline, a line per flow of every candidate, the step downs, the rate in force.
 * @param {SpeedReport} report */
export function speedText(report) {
  if (!report.supported) return `port_speed not supported: ${report.why} (stays at ${report.rate})\n`;
  const lines = [];
  if (report.verified) {
    const where = report.baselineFrames ? `from ${report.baselineFrames} frames of this session` : `measured, ${BASELINE_FRAMES} frames per flow`;
    const entries = Object.entries(report.baseline);
    lines.push(entries.length ? `baseline at ${report.base} (${where}): ${entries.map(([k, v]) => `${k} ${pct(v)}`).join(', ')}` : `baseline at ${report.base}: none`);
  }
  if (report.skipped.length) lines.push(`skipped (the record says failed): ${report.skipped.join(', ')}`);
  if (report.retried) lines.push(`the record says every candidate failed: ${report.retried} (the slowest) tried once`);
  if (report.capped.length) lines.push(`left out (maxTries): ${report.capped.join(', ')}`);
  lines.push(`${'rate'.padStart(9)} ${'actual'.padStart(9)}  ${'flow'.padEnd(9)} ${'frames'.padStart(6)} ${'broken'.padStart(6)} ${'lost'.padStart(5)} ${'ratio'.padStart(6)} ${'KB/s'.padStart(7)}  result`);
  for (const t of report.trials) {
    const head = `${String(t.rate).padStart(9)} ${String(t.actual ?? '-').padStart(9)}  `;
    const probation = t.probation === 'passed' || t.probation === 'failed' ? `, probation ${t.probation} after ${t.probationBytes} bytes` : '';
    const result = t.committed ? `committed${t.nCap ? ` (in flight ${t.nCap})` : ''}${probation}`
      : `${t.why}${t.settling ? ' (soon after a breakdown: unknown)' : ''}`;
    if (!t.flows.length) {
      lines.push(head + `${'-'.padEnd(9)} ${'-'.padStart(6)} ${'-'.padStart(6)} ${'-'.padStart(5)} ${'-'.padStart(6)} ${'-'.padStart(7)}  ${result}`);
      continue;
    }
    t.flows.forEach((f, i) => {
      lines.push((i === 0 ? head : ' '.repeat(head.length)) + `${f.name.padEnd(9)} ${String(f.frames).padStart(6)} ${String(f.broken).padStart(6)} `
        + `${String(f.lost).padStart(5)} ${pct(f.ratio).padStart(6)} ${f.kbS.toFixed(1).padStart(7)}  ${f.passed ? 'passed' : 'failed'}`);
    });
    lines.push(' '.repeat(head.length) + `-> ${result}`);
  }
  for (const s of report.stepDowns) lines.push(`stepped down from ${s.rate}${s.probation ? ' (in probation)' : ''}: ${s.why}${s.to ? ` -> ${s.to}` : ''}`);
  if (report.steppedDown && !report.chosen) lines.push('the boot speed for the rest of the session');
  lines.push(`in force: ${report.rate}${report.chosen ? ' (raised)' : ' (the boot speed)'}`);
  return lines.join('\n') + '\n';
}
