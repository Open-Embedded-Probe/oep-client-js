// @ts-check
// port_speed (oep-core §3.5, optional, opt-in): a faster UART bridge for one session. `raiseSpeed` tries the host's
// rates in order on the serial port this host opened: try (answered at the speed now, then the probe switches) -> the
// host switches (WebSerial: close and open the port again at the new rate; Node: serialport's update), waits
// SWITCH_SETTLE_MS and finds the new rate with a confirm (up to 3, 200 ms each: the switch-over may cost the first
// frame) -> a verify both ways with max_frame-sized frames (link_source / link_sink) for verifyBytes or verifySeconds,
// pipelined at the probe's max_inflight and, when frames break there (a line that loses bytes while both ways are busy:
// an M5Stack ATOM's FTDI at 500 kbaud and up), once more one request at a time, counting broken frames and measuring
// KB/s each way -> commit when nothing broke, the in-flight count that passed kept as the link's cap (`inflightCap`); else revert, back to the boot speed and
// confirmed there (a lost revert: the probe's verify_ms waited out), and the next rate. The report stays on the link
// (`host.link.speed`), for budgeting a capture or a write. The same procedure as oep-client-python's link.raise_speed.

import * as reg from './registry.js';
import * as m from './message.js';
import * as core from './core.js';
import { getU32 } from './bytes.js';
import { Rejected, Timeout } from './errors.js';

const OP_PORT_SPEED = reg.CORE.op.port_speed;
const STEP = reg.CORE.enum.port_speed_step;
const PORT_SPEED_TAG = reg.CORE.tlv.describe.port_speed;
const UART_BRIDGE = reg.CORE.enum.transport_kind.uart_bridge;

/**
 * One rate tried: what the probe said it runs at, the verify's bytes, KB/s (1000 B/s) and broken frames each way
 * (in = probe to host, link_source; out = host to probe, link_sink), whether it was committed (why not), and the
 * requests kept in flight the verify passed with (`inflight`, 0: none passed).
 * @typedef {{ rate: number, actual: number | null, inBytes: number, outBytes: number, inKBs: number | null,
 *   outKBs: number | null, brokenIn: number, brokenOut: number, committed: boolean, why: string, inflight: number }} SpeedTrial
 */

/**
 * raiseSpeed's answer (also `link.speed`): the boot speed, the rate in force now (`rate`), the committed one (`chosen`,
 * null: the boot speed), every trial in order, why nothing was tried (`supported` false), `lost` (a raised rate was
 * later found gone), and the chosen rate's measured KB/s (`inKBs` / `outKBs`, null at the boot speed).
 * @typedef {{ base: number, supported: boolean, rate: number, chosen: number | null, trials: SpeedTrial[], why: string,
 *   lost: boolean, inKBs: number | null, outKBs: number | null }} SpeedReport
 */

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

/** The probe's UART bridge (its transport index) when it declares port_speed; else null and why not.
 * @param {import('./host.js').Host} hst @returns {Promise<[number | null, string]>} */
async function speedPort(hst) {
  const tlvs = await core.describe(hst, 0);
  if (!tlvs.some(([tag, v]) => (tag & 0x7f) === PORT_SPEED_TAG && v[0] === 1)) return [null, 'the probe does not declare port_speed'];
  const bridge = (await core.probeInfo(hst)).transports.find((t) => t.kind === UART_BRIDGE);
  return bridge ? [bridge.index, ''] : [null, 'the probe has no UART bridge'];
}

/**
 * Both ways with max_frame-sized frames, `inflight` at a time (default: as the probe allows): up to half of
 * verifyBytes or verifySeconds each (in first, then out). Stops at the first frame that breaks (lost, or its content
 * wrong).
 * @param {import('./host.js').Host} hst @param {number} rate @param {SpeedTrial} trial
 * @param {number} verifyBytes @param {number} verifySeconds @param {number} [inflightAsked]
 */
async function verify(hst, rate, trial, verifyBytes, verifySeconds, inflightAsked) {
  const link = hst.link;
  const limits = await hst.confirmed();
  const inflight = Math.max(1, inflightAsked || limits.maxInflight);
  const nIn = limits.maxFrame - m.RESULT_HEADER;    // link_source: a whole result frame
  const nOut = limits.maxFrame - m.REQUEST_HEADER;  // link_sink: a whole request frame (no session)
  const timeoutMs = Math.max(300, 4000 * ((limits.maxFrame + 8) * 10 / rate) * inflight + 100);
  const sink = Uint8Array.from({ length: nOut }, (_, k) => (k * 7) & 0xff);
  for (const way of /** @type {const} */ (['in', 'out'])) {
    let moved = 0;
    const t0 = performance.now();
    while (moved < verifyBytes / 2 && performance.now() - t0 < verifySeconds * 500) {
      const batch = Array.from({ length: inflight * 2 }, () => new m.Request(hst.nextCorr(), m.CORE_FN,
        way === 'in' ? m.OP.link_source : m.OP.link_sink, way === 'in' ? Uint8Array.of(nIn & 0xff, nIn >> 8, 0, 0) : sink).pack());
      /** @type {Promise<Uint8Array>[]} */
      const answers = [];
      for (let i = 0; i < batch.length; i++) {
        if (i >= inflight) await answers[i - inflight].catch(() => {});
        answers.push(link.sendOnce(batch[i], { timeoutMs, resend: false }));
      }
      const settled = await Promise.allSettled(answers);
      let good = 0;
      for (const s of settled) {
        if (s.status !== 'fulfilled') break;
        const r = m.Result.unpack(s.value);
        const ok = r.succeeded && (way === 'in'
          ? r.payload.length === nIn && r.payload.every((b, k) => b === (k & 0xff))
          : r.payload.length >= 4 && getU32(r.payload) === nOut);
        if (!ok) break;
        good++;
      }
      moved += good * (way === 'in' ? nIn : nOut);
      if (good === batch.length) continue;
      if (way === 'in') trial.brokenIn += batch.length - good;
      else trial.brokenOut += batch.length - good;
      break;
    }
    const seconds = Math.max((performance.now() - t0) / 1000, 1e-6);
    if (way === 'in') { trial.inBytes = moved; trial.inKBs = moved / seconds / 1000; }
    else { trial.outBytes = moved; trial.outKBs = moved / seconds / 1000; }
    if (trial.brokenIn || trial.brokenOut) return false;
  }
  return true;
}

/**
 * port_speed (oep-core §3.5), opt-in: try `rates` in order on the UART bridge this host opened, and commit the first
 * that passes; a rate the probe's UART cannot make is skipped. The session must be open (the rate lasts as long as it
 * does). verifyMs: how long the probe waits for the commit (default verifySeconds + 1.5 s, at most 65535). idleMs: once
 * committed, the probe reverts after this long with no good frame (0: never; the session's end reverts anyway). port:
 * the transport index (default: the probe's first UART bridge). A link that cannot change its rate (USB, a broker's
 * TCP) and a probe without the feature are reported not supported and stay at their speed.
 * @param {import('./host.js').Host} hst @param {number[]} rates
 * @param {{ verifyBytes?: number, verifySeconds?: number, verifyMs?: number, idleMs?: number, port?: number }} [opts]
 * @returns {Promise<SpeedReport>}
 */
export async function raiseSpeed(hst, rates, { verifyBytes = 32768, verifySeconds = 1, verifyMs, idleMs = 0, port } = {}) {
  const link = hst.link;
  const base = link.baseBaud;
  /** @type {SpeedReport} */
  const report = {
    base: base ?? 0, supported: false, rate: link.baud ?? 0, chosen: null, trials: [], why: '', lost: false,
    get inKBs() { return this.chosen ? this.trials.find((t) => t.committed)?.inKBs ?? null : null; },
    get outKBs() { return this.chosen ? this.trials.find((t) => t.committed)?.outKBs ?? null : null; },
  };
  link.speed = report;
  if (base === null || link.framing !== 'cobs') {
    report.why = 'the link is not a serial port this host opened';
    return report;
  }
  const [where, why] = await speedPort(hst);
  if (where === null) { report.why = why; return report; }
  if (hst.session === null) throw new m.OepError('raiseSpeed needs an open session (the rate lasts as long as the session)');
  const at = port ?? where;
  report.supported = true;
  const wait = verifyMs ?? Math.min(65535, Math.round(verifySeconds * 1000) + 1500);
  link.fallback = false;   // every failure here is handled here
  try {
    for (const rate of rates) {
      /** @type {SpeedTrial} */
      const trial = { rate, actual: null, inBytes: 0, outBytes: 0, inKBs: null, outKBs: null, brokenIn: 0, brokenOut: 0, committed: false, why: '', inflight: 0 };
      report.trials.push(trial);
      let answer;
      try {
        answer = await hst.call(m.CORE_FN, OP_PORT_SPEED, request(at, rate, STEP.try, wait, 0));
      } catch (e) {
        if (e instanceof Timeout) {
          trial.why = 'no answer to the try';   // it may have switched: wait it out at the boot speed
          if (!(await link.backToBase(wait + 1500))) throw new Error(`after trying ${rate}: no answer at the boot speed ${base}`);
          continue;
        }
        if (!(e instanceof Rejected)) throw e;
        if (e.result.detail === m.REJECT.unknown_operation) {
          report.supported = false;
          report.why = 'the probe does not take port_speed (unknown_operation)';
          report.trials.pop();
          return report;
        }
        trial.why = e.result.detail === m.REJECT.unsupported ? "unsupported: the probe's UART cannot make it" : e.message;
        if (e.result.detail !== m.REJECT.unsupported) break;   // wrong port, locked, ...: nothing else will do better
        continue;
      }
      trial.actual = getU32(answer.payload);
      await link.setBaud(rate);   // settled (SWITCH_SETTLE_MS) before the first byte
      // the switch-over itself may cost the first frame (bytes in flight while both ends change): a confirm, sent again a
      // couple of times, finds the new rate before anything is measured (core §3.5)
      const heard = await confirmAgain(link);
      let ok = heard;
      // pipelined first (what the host will use); a line that loses bytes while both ways carry at once gets a second
      // verify one request at a time
      const full = Math.max(1, (await hst.confirmed()).maxInflight);
      for (const n of heard ? (full === 1 ? [1] : [full, 1]) : []) {
        trial.brokenIn = trial.brokenOut = 0;
        ok = await verify(hst, rate, trial, verifyBytes, verifySeconds, n);
        if (ok) { trial.inflight = n; break; }
        await confirmAgain(link);   // the broken frames' leftovers read past
      }
      if (ok) {
        try {
          await hst.call(m.CORE_FN, OP_PORT_SPEED, request(at, rate, STEP.commit, 0, idleMs));
          trial.committed = true;
          report.rate = rate;
          report.chosen = rate;
          link.inflightCap = trial.inflight < full ? trial.inflight : 0;
          return report;
        } catch (e) {
          trial.why = `the commit failed: ${e instanceof Error ? e.message : e}`;
        }
      } else {
        trial.why = heard ? 'frames broke' : 'no confirm at the new rate';
        const revert = new m.Request(hst.nextCorr(), m.CORE_FN, OP_PORT_SPEED, request(at, rate, STEP.revert, 0, 0), hst.session).pack();
        await link.sendOnce(revert, { timeoutMs: 300, resend: false }).catch(() => {});   // lost: the probe goes back by itself
      }
      if (!(await link.backToBase(wait + 1500))) throw new Error(`after trying ${rate}: no answer at the boot speed ${base}`);
      report.rate = base;
    }
    return report;
  } finally {
    link.fallback = true;
  }
}

/** A confirm at the rate now, up to 3 tries of 200 ms: true when one came back. @param {import('./link.js').Link} link */
async function confirmAgain(link) {
  for (let i = 0; i < 3; i++) if (await link.confirmRaw(200)) return true;
  return false;
}

/** The report as text: a line per rate tried, then the rate in force. @param {SpeedReport} report */
export function speedText(report) {
  if (!report.supported) return `port_speed not supported: ${report.why} (stays at ${report.rate})\n`;
  /** @param {number | null} v */
  const kb = (v) => (v === null ? '-' : v.toFixed(1)).padStart(8);
  const lines = [`${'rate'.padStart(9)} ${'actual'.padStart(9)} ${'in KB/s'.padStart(8)} ${'out KB/s'.padStart(8)} ${'broken in/out'.padStart(13)}  result`];
  for (const t of report.trials) {
    lines.push(`${String(t.rate).padStart(9)} ${String(t.actual ?? '-').padStart(9)} ${kb(t.inKBs)} ${kb(t.outKBs)} ${`${t.brokenIn}/${t.brokenOut}`.padStart(13)}  ${t.committed ? `committed (in flight ${t.inflight})` : t.why}`);
  }
  lines.push(`in force: ${report.rate}${report.chosen ? ' (raised)' : ' (the boot speed)'}`);
  return lines.join('\n') + '\n';
}
