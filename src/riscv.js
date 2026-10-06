// @ts-check
// oep.wire.rvswd / oep.wire.swio and oep.target.riscv-dm, revision 1 (oep-spec oep-if-debug §1-§4).
//
// The host knows the target; the probe only moves wires and DMI. Everything chip-specific (flash controller, RAM
// loaders, register meanings) stays on this side.
//
// common §3: wire and target results carry a status (ok, wait, line, fault, timeout, state; any other value is a
// failure). A request the probe ran but that did not get through is completed failed (nothing done) or partial (some
// done) with the success shape, so `done` and `status` say how far it went: this module throws TargetError with them.
// Every block op is self-contained (oep-if-debug §4): the probe restores the GPRs, DATA0 / DATA1 and abstractauto
// before it answers, so nothing of the probe's own is left in the target between requests.

import * as reg from './registry.js';
import { Writer, concat, getU16, getU32 } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { Failed, OepError, Rejected, rejection } from './errors.js';
import { Interface, describe, maxOpMs } from './core.js';

export const STATUS = reg.STATUS;
export const OK = STATUS.ok;
export const TIMEOUT = STATUS.timeout;
/** @type {Record<number, string>} */
export const STATUS_NAMES = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));
const RV = reg.TARGET_RISCV_DM;
const RVSWD = reg.WIRE_RVSWD;
/** One attach answer at most (oep-if-debug §1): its argument time (core §4.4). */
export const ATTACH_BUDGET_MS = reg.LIMITS.attach_budget_ms;
/** No scan combination starts later than this; a scan's argument time adds one attach to it. */
export const SCAN_BUDGET_MS = reg.LIMITS.scan_budget_ms;
/** After a reset's release, the most a probe waits for a silent DM (attach's reset TLV, riscv-dm reset; debug §3, §4.3):
 * argument time (core §4.4). */
export const RESET_SETTLE_MS = reg.LIMITS.reset_settle_ms;
export const STEP = RV.enum.dmi_step;
export const STEP_WRITE = STEP.write, STEP_READ = STEP.read, STEP_POLL_READS = STEP.poll_reads;
export const STEP_WAIT_US = STEP.wait_us, STEP_POLL_US = STEP.poll_us;
/** @type {Record<number, number>} bytes per step kind, the kind included (§4.1) */
/** The time a step list may take by its waits and time-bounded polls (wait_us, poll_us), in ms (rounded up).
 * @param {Uint8Array} raw */
export function dmiWaitMs(raw) {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let us = 0;
  for (let at = 0; at < raw.length;) {
    const kind = raw[at];
    if (kind === STEP_WAIT_US) us += v.getUint32(at + 1, true);
    else if (kind === STEP_POLL_US) us += v.getUint32(at + 10, true);
    const size = STEP_SIZES[kind];
    if (!size) break;
    at += size;
  }
  return Math.ceil(us / 1000);
}
export const STEP_SIZES = { [STEP_WRITE]: 6, [STEP_READ]: 2, [STEP_POLL_READS]: 12, [STEP_WAIT_US]: 5, [STEP_POLL_US]: 14 };
export const VALUE_STEPS = new Set([STEP_READ, STEP_POLL_READS, STEP_POLL_US]);   // steps that add a value to the result
export const POLL_STEPS = new Set([STEP_POLL_READS, STEP_POLL_US]);               // ... and add their last value when they time out
export const REG_A0 = 0x100A, REG_A1 = 0x100B;

/** @param {number} status */
export function statusName(status) {
  return STATUS_NAMES[status] ?? `unknown status 0x${status.toString(16).padStart(2, '0')}`;
}

/** @param {number} n */
const u16 = (n) => new Writer().u16(n).done();
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A wire or target operation that did not get through: `status` (common §3), `done` (steps / words completed, where
 * the op has it), `values` (what it did read), `data` (the bytes it did read), `result` (the probe's answer).
 */
export class TargetError extends OepError {
  /**
   * @param {string} what @param {number} status @param {m.Result | null} result
   * @param {{ done?: number | null, values?: number[], data?: Uint8Array }} [opts]
   */
  constructor(what, status, result = null, { done = null, values = [], data = new Uint8Array() } = {}) {
    const at = done !== null ? ` after ${done}` : '';
    const outcome = result !== null ? ` (${result.describe()})` : '';
    super(`${what} stopped${at}: ${statusName(status)}${outcome}`);
    this.status = status; this.result = result; this.done = done; this.values = values; this.data = data;
  }
}

/**
 * step did not get the hart back to debug mode (oep-if-debug §4.2, P2-○4): `stepLeft` - the probe could not halt it
 * again (the hart runs, dcsr.step may still be set: halt it and clear dcsr.step); otherwise it is halted again with
 * `after` (dpc) valid.
 */
export class StepError extends TargetError {
  /** @param {number} status @param {m.Result} result @param {number} before @param {number} after @param {boolean} stepLeft */
  constructor(status, result, before, after, stepLeft) {
    super('step', status, result);
    this.before = before; this.after = after; this.stepLeft = stepLeft;
  }
}

/** The payload of a result the probe ran (success, failed or partial: all in the success shape); an unknown
 * resolution or outcome throws Failed (core §2.4).
 * @param {m.Result} result */
export function ran(result) {
  if (!result.ran) throw new Failed(result);
  return new m.Reader(result.payload);
}

/** Success needs outcome success AND status ok; anything else (an unknown status included) throws.
 * @param {string} what @param {m.Result} result @param {number} status
 * @param {{ done?: number | null, values?: number[], data?: Uint8Array }} [opts] */
export function check(what, result, status, opts = {}) {
  if (status !== OK || !result.succeeded) throw new TargetError(what, status, result, opts);
}

/** A scan hit: kind (1 riscv-dm, 2 arm-adi), the pair attach takes back as `pins`, and the raw value (DMSTATUS; DPIDR
 * on swd).
 * @typedef {{ kind: number, pins: [number, number], dmstatus: number }} Found */

/** One live connection (§2.1). users: bit0 the host session, bit1 a slot; slot 0xFF: none; targetId null: none.
 * @typedef {{ conn: number, pins: [number, number], speedHz: number, users: number, slot: number,
 *   targetId: [number, Uint8Array] | null }} ConnectionInfo */

const WOP = RVSWD.op;   // scan / attach / detach / connections: the same numbers on every wire
const IDLE_CLOCK = RVSWD.enum.idle_clock;

/** The attach answer's flags, the same on every wire (§3): bit0 havereset_acked, bit1 existing, bit2 dormant_woken,
 * bit3 halted (the dpc TLV is valid). */
export const ATTACH_FLAGS = RVSWD.enum.attach_flags;

/** oep.wire.<link>: scan / attach / detach / connections. The shared part; each link's attach takes its own arguments.
 * A failed scan, attach or detach is completed failed with `status(u8) [TLV]` (common §3). */
export class WireBase extends Interface {
  static SCAN = WOP.scan;
  static ATTACH = WOP.attach;
  static DETACH = WOP.detach;
  static CONNECTIONS = WOP.connections;
  static REVISION = 1;
  static TAG_MAX_SPEED = RVSWD.tlv.attach.max_speed;   // u32 Hz, critical; attach requires it (§1)
  static TAG_PINS = RVSWD.tlv.attach.pins;             // swdio(u16) swclk(u16, 0xFFFF on one wire), critical (§1)
  static TAG_RESET = RVSWD.tlv.attach.reset;           // channel(u16) hold_ms(u16), critical: attach under reset (§3)
  static TAG_SCAN_MAX_SPEED = RVSWD.tlv.scan.max_speed;
  static TAG_SKIP = RVSWD.tlv.scan.skip;               // scan, count 0 only: pairs of the count-0 list to skip (§1)
  static TAG_SCAN_IDLE_CLOCK = RVSWD.tlv.scan.idle_clock;
  static TAG_FORCE = RVSWD.tlv.detach.force;
  static FLAGS = ATTACH_FLAGS;
  static NO_SLOT = 0xFF;
  /** when the wire declares no max_clock_hz either */
  static DEFAULT_MAX_SPEED = 1_000_000;

  /** the attach_flags byte of the last attach */
  flags = 0;

  /** attach's max_speed is required (malformed without): null takes the wire's declared max_clock_hz (its describe,
   * cached), else DEFAULT_MAX_SPEED. The target's ceiling is the host's to know (§3).
   * @param {number | null | undefined} maxSpeed */
  async speedOrDefault(maxSpeed) {
    if (maxSpeed != null) return maxSpeed;
    for (const [tag, v] of await describe(this.host, this.fn)) {
      if ((tag & ~m.TAG_CRITICAL) === catalog.COMMON.max_clock_hz && v.length >= 4) return getU32(v);
    }
    return WireBase.DEFAULT_MAX_SPEED;
  }

  /** An argument time, at most the probe's max_op_ms (core §4.4). @param {number} ms */
  async budget(ms) {
    try { return Math.min(ms, await maxOpMs(this.host)); } catch { return ms; }
  }

  /** attach's argument time (core §4.4, C-06 / P2-★4): attach_budget_ms, and with the reset TLV its holdMs and
   * reset_settle_ms (the wait for a target that restarts by itself after the release, debug §3), at most max_op_ms - the
   * host's wait for its answer adds host_wait_add_ms and the transfer time. @param {[number, number] | null} [reset] */
  attachMs(reset = null) { return this.budget(ATTACH_BUDGET_MS + (reset ? reset[1] + RESET_SETTLE_MS : 0)); }

  /** scan's argument time: scan_budget_ms + attach_budget_ms (one combination's try), at most max_op_ms. */
  scanMs() { return this.budget(SCAN_BUDGET_MS + ATTACH_BUDGET_MS); }

  /** [channel, holdMs], critical: hold the reset line (open drain, low) that long, then attach (§3).
   * @param {[number, number] | null | undefined} reset */
  resetTlv(reset) {
    return reset == null ? new Uint8Array() : m.tlv(WireBase.TAG_RESET, new Writer().u16(reset[0]).u16(reset[1]).done(), true);
  }

  /**
   * Try `pairs` of [swdio, swclk]; none = every pair the probe allows and nothing holds (describe's channel_group /
   * role_channels, §1). A pair the probe does not allow, or one whose pins something holds, refuses the whole scan
   * (rejected unavailable). maxSpeed (critical; none: the probe's slowest) and idleClock ('high' / 'low', rvswd only,
   * critical) are the target's line settings (§3); they do not change a live connection's settings (a live pair is read
   * over its connection, §1). The probe tries at most 255 pairs a request and stops early when
   * its answer would not fit one frame; this goes on until every pair is tried (count 0: with skip until tried = 0;
   * the probe tries at least one pair while any remain).
   * @param {[number, number][] | null} pairs @param {{ maxSpeed?: number | null, idleClock?: 'high' | 'low' | null }} [opts]
   * @returns {Promise<Found[]>}
   */
  async scan(pairs = null, { maxSpeed = null, idleClock = null } = {}) {
    /** @type {Found[]} */
    const out = [];
    let left = [...(pairs ?? [])];
    const listed = left.length > 0;
    let skip = 0;
    const extra = new Writer();
    if (maxSpeed != null) extra.raw(m.tlv(WireBase.TAG_SCAN_MAX_SPEED, new Writer().u32(maxSpeed).done(), true));
    if (idleClock != null) extra.raw(m.tlv(WireBase.TAG_SCAN_IDLE_CLOCK, [IDLE_CLOCK[idleClock]], true));
    const expectMs = await this.scanMs();
    for (;;) {
      const chunk = left.slice(0, 255);
      const w = new Writer().u8(chunk.length);
      for (const [d, c] of chunk) w.u16(d).u16(c);
      if (!listed && skip) w.raw(m.tlv(WireBase.TAG_SKIP, u16(skip)));
      w.raw(extra.done());
      const rd = new m.Reader((await this.call(WireBase.SCAN, w.done(), { expectMs })).payload);
      const tried = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {
        const kind = rd.u8(), dio = rd.u16(), clk = rd.u16(), status = rd.u32();   // 9 bytes, no length (core §2.3)
        out.push({ kind, pins: [dio, clk], dmstatus: status });
      }
      rd.tail();
      if (tried === 0) return out;
      if (listed) {
        left = left.slice(tried);
        if (!left.length) return out;
      } else skip += tried;
    }
  }

  /** Drop this host session's use of the connection; force: close it though a slot uses it too (§2).
   * @param {number} conn @param {{ force?: boolean }} [opts] */
  async detach(conn, { force = false } = {}) {
    const body = new Writer().u16(conn);
    if (force) body.raw(m.tlv(WireBase.TAG_FORCE, [], true));
    await this.call(WireBase.DETACH, body.done());
  }

  /** The wire's live connections, in the order they were made (§2.1, lock-free; paged: the request is first(u8), the
   * answer `more count × entry [TLV]`, followed until more is 0). @returns {Promise<ConnectionInfo[]>} */
  async connections() {
    /** @type {ConnectionInfo[]} */
    const out = [];
    for (;;) {
      const rd = new m.Reader((await this.call(WireBase.CONNECTIONS, Uint8Array.of(out.length), { locked: false })).payload);
      const more = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {
        const conn = rd.u16(), dio = rd.u16(), clk = rd.u16(), speedHz = rd.u32(), users = rd.u8(), slot = rd.u8();
        const scheme = rd.u8(), tid = rd.bytes(rd.u8());
        out.push({ conn, pins: [dio, clk], speedHz, users, slot, targetId: scheme ? [scheme, tid] : null });
      }
      rd.tail();
      if (!more || !count || out.length > 0xff) return out;
    }
  }

  /** critical: a probe that cannot keep to a ceiling must refuse, not ignore it (core §2.3: safety arguments)
   * @param {number | null | undefined} maxSpeed */
  speedTlv(maxSpeed) {
    return maxSpeed == null ? new Uint8Array() : m.tlv(WireBase.TAG_MAX_SPEED, new Writer().u32(maxSpeed).done(), true);
  }

  /** the pair to attach on (a scan result's .pins); none: the probe's only pair (§1)
   * @param {[number, number] | null | undefined} pins */
  pinsTlv(pins) {
    return pins == null ? new Uint8Array() : m.tlv(WireBase.TAG_PINS, new Writer().u16(pins[0]).u16(pins[1]).done(), true);
  }
}

/** oep.wire.rvswd / oep.wire.swio (CH32 debug links to a RISC-V debug module). swio: `Wire.open(hst, { name: 'oep.wire.swio' })`. */
export class Wire extends WireBase {
  static NAME = 'oep.wire.rvswd';
  static ROLE_RESET = RVSWD.enum.pin_role.reset;
  static TAG_IDLE_CLOCK = RVSWD.tlv.attach.idle_clock;
  static IDLE_CLOCK = IDLE_CLOCK;
  static RUN = RVSWD.enum.attach_method.run;
  static HALT = RVSWD.enum.attach_method.halt;
  static TAG_TARGET_ID = RVSWD.tlv.attach_answer.target_id;
  static TAG_DPC = RVSWD.tlv.attach_answer.dpc;
  static TAG_SEARCH_RETRIES = RVSWD.tlv.attach_answer.search_retries;
  static SCHEME_WCH_DMI_7F = reg.COMMON.enum.target_id_scheme.wch_dmi_7f;   // one scheme space (common)

  hadReset = false;
  existing = false;
  /** the hart is halted (attach flags bit3): `dpc` says where */
  halted = false;
  /** @type {number | null} the halted hart's dpc (the answer's TLV 0x11), else null */ dpc = null;
  speedHz = 0;
  /** @type {number[]} */ ignored = [];
  /** @type {[number, Uint8Array] | null} (scheme, value) the last attach read, or null */ targetId = null;
  /** @type {number | null} the last attach's failed speed-search tries (0xFFFF: 65535 or more; null: not said) */
  searchRetries = null;
  /** @type {Map<number, (number | null)[] | Rejected>} channel -> dpc per try (null: attach failed), or the rejection */
  lastSearch = new Map();

  /** @param {m.Tail} tail */
  takeTargetId(tail) {
    const v = tail.get(Wire.TAG_TARGET_ID);
    this.targetId = v && v.length ? [v[0], v.slice(1)] : null;
  }

  /** rvswd only, critical: a probe that cannot rest the line that way must refuse (§3)
   * @param {'high' | 'low' | null | undefined} idleClock */
  idleTlv(idleClock) {
    return idleClock == null ? new Uint8Array() : m.tlv(Wire.TAG_IDLE_CLOCK, [IDLE_CLOCK[idleClock]], true);
  }

  /** The channels an attach's reset TLV may take (describe role_channels, role reset). There is no default reset
   * line: the host names one every time (§3). */
  async resetChannels() {
    const out = new Set();
    for (const [tag, v] of await describe(this.host, this.fn)) {
      if ((tag & ~m.TAG_CRITICAL) === catalog.COMMON.role_channels && v[0] === Wire.ROLE_RESET) {
        for (const c of catalog.bitmapToChannels(getU16(v, 1), v.slice(3))) out.add(c);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /** @typedef {{ halt?: boolean, maxSpeed?: number | null, pins?: [number, number] | null, idleClock?: 'high' | 'low' | null,
   *   reset?: [number, number] | null }} AttachOptions */

  /** The attach request: method, then the TLVs (max_speed always: it is required). @param {AttachOptions} [opts] */
  async attachBody({ halt = true, maxSpeed = null, pins = null, idleClock = null, reset = null } = {}) {
    return concat([halt ? Wire.HALT : Wire.RUN], this.speedTlv(await this.speedOrDefault(maxSpeed)), this.pinsTlv(pins),
      this.idleTlv(idleClock), this.resetTlv(reset));
  }

  /**
   * -> { conn, dmstatus }. Attaching an attached wire returns its connection as it is (this.existing). this.hadReset:
   * a pending havereset was acknowledged first (a V00x's DMSTATUS halt / run bits stay frozen until then);
   * this.halted / this.dpc: the hart is halted and where (attach flags bit3, TLV dpc); this.speedHz: the speed the
   * probe chose; maxSpeed: the ceiling the probe must keep (critical, required; null: the wire's declared
   * max_clock_hz); idleClock: 'high' / 'low', how rvswd rests SWCLK (critical; sent whenever given, high included).
   * Both are the target's, known by the host (§3). An attach that joins a live connection (a slot's, another
   * session's) changes only what it carries: idleClock null keeps the connection's current rest (null means high only
   * for a new connection), and maxSpeed only lowers its speed (§1) - a caller that knows the target's rest (a slot's
   * idleClock) passes it, high included. reset = [channel, holdMs]: hold that reset line (one of resetChannels()) low for holdMs, then attach -
   * halting before the first instruction with halt - the way back from firmware that turns the debug pins into GPIOs
   * (on an existing connection: the target is reset, mark reset detail 3). this.targetId: [scheme, value] of the
   * target's identity when the probe could read one; this.searchRetries: the answer's failed speed-search tries. The
   * answer is waited for attach_budget_ms (+ holdMs) as its argument time (core §4.4).
   * @param {AttachOptions} [opts]
   */
  async attach(opts = {}) {
    const rd = new m.Reader((await this.call(Wire.ATTACH, await this.attachBody(opts), { expectMs: await this.attachMs(opts.reset) })).payload);
    const conn = rd.u16(), dmstatus = rd.u32();
    this.flags = rd.u8();
    this.speedHz = rd.u32();
    this.hadReset = !!(this.flags & ATTACH_FLAGS.havereset_acked);
    this.existing = !!(this.flags & ATTACH_FLAGS.existing);
    this.halted = !!(this.flags & ATTACH_FLAGS.halted);
    const tail = rd.tail();
    this.ignored = tail.ignored;
    this.takeTargetId(tail);
    const dpc = tail.get(Wire.TAG_DPC);
    this.dpc = this.halted && dpc && dpc.length >= 4 ? getU32(dpc) : null;
    const tries = tail.get(Wire.TAG_SEARCH_RETRIES);                // oep-if-debug §1 (optional)
    this.searchRetries = tries && tries.length >= 2 ? getU16(tries) : null;
    return { conn, dmstatus };
  }

  /**
   * attach({ halt: true, reset: [channel, holdMs] }): hold the target in reset through `channel` (always named: there
   * is no default reset line; the probe allows resetChannels()), attach, release and halt it at once. -> { conn, dpc }
   * (dpc null when the hart was not halted).
   * @param {number} channel
   * @param {{ holdMs?: number, maxSpeed?: number | null, pins?: [number, number] | null, idleClock?: 'high' | 'low' | null }} [opts]
   */
  async attachUnderReset(channel, { holdMs = 20, maxSpeed = null, pins = null, idleClock = null } = {}) {
    const { conn } = await this.attach({ halt: true, maxSpeed, pins, idleClock, reset: [channel, holdMs] });
    return { conn, dpc: this.dpc };
  }

  /**
   * Which of `candidates` resets the target: attach under reset through each, and see where the hart stops. The real
   * line stops it before its first instruction (dpc = resetVector); any other channel leaves the target running, so
   * the halt lands somewhere in its code. A channel counts once any of `tries` lands on the vector: the CH32L103 is
   * caught by polling right after the release (it keeps no haltreq through NRST), which misses now and then (1 in 60
   * after the probe fix of 2026-09-24), while landing on the vector by chance is not a worry. Channels the probe does
   * not allow (rejected) are skipped; a failed attach counts as a miss and is tried again. Each try pulls one channel
   * low (open drain) for holdMs. The target is left running (or halted, where resume is not acknowledged).
   * this.lastSearch: what each channel gave.
   * @param {number[]} candidates @param {{ resetVector?: number, holdMs?: number, tries?: number }} [opts]
   */
  async findResetLine(candidates, { resetVector = 0, holdMs = 20, tries = 3 } = {}) {
    /** @type {number[]} */
    const hits = [];
    this.lastSearch = new Map();
    for (const channel of candidates) {
      /** @type {(number | null)[] | Rejected} */
      let seen = [];
      for (let i = 0; i < tries; i++) {
        let conn, dpc;
        try {
          ({ conn, dpc } = await this.attachUnderReset(channel, { holdMs }));
        } catch (e) {
          if (e instanceof Rejected) { seen = e; break; }      // not a channel this probe allows
          if (e instanceof Failed) { seen.push(null); continue; }   // the attach itself failed: try again
          throw e;
        }
        seen.push(dpc);
        const dm = await RiscvDm.on(this.host, conn);
        try {
          // Leave the vector for real: a hart left halted there reads dpc = vector again through the next, wrong
          // channel (2026-09-24: a CH32L103 whose resume was not acknowledged made the channel after NRST a false
          // hit). A reset-and-run always gets it going.
          if (dpc === resetVector) await dm.reset({ confirm: true });
          else await dm.resume();
        } catch (e) {
          // a CH32L103 raises no allresumeack; a hart left halted mid-code still lands off the vector
          if (!(e instanceof OepError)) throw e;
        } finally {
          await this.detach(conn);
        }
        if (dpc === resetVector) { hits.push(channel); break; }
      }
      this.lastSearch.set(channel, seen);
    }
    return hits;
  }
}

/** A DMI step list that stopped early: `done` = the failed step's index, `values` = what it did read. */
export class StepListError extends TargetError {
  /** @param {number} done @param {number} status @param {number[]} values @param {m.Result | null} result */
  constructor(done, status, values, result = null) { super('step list', status, result, { done, values }); }
}

/** run's answer (§4.4). stopped: the hart halted on its own (ebreak) before timeoutMs; notHalted: the limit passed and
 * the probe could not halt the hart (dpc and values mean nothing); values: the registers asked for in `outs`, in order.
 * @typedef {{ status: number, stopped: boolean, notHalted: boolean, dpc: number, elapsedUs: number, values: number[] }} RunResult */

/** run's `stopped`: 0 the limit passed and the probe halted it, 1 stopped on its own, 2 not halted. */
export const RUN_STOPPED = RV.enum.run_stopped;

/** The kinds of a packed step list, in order (so the count and the value rule need no bookkeeping by callers).
 * @param {Uint8Array} steps */
export function countSteps(steps) {
  /** @type {number[]} */
  const kinds = [];
  let at = 0;
  while (at < steps.length) {
    const kind = steps[at];
    if (!(kind in STEP_SIZES)) throw new RangeError(`DMI step kind 0x${kind.toString(16).padStart(2, '0')} at byte ${at} is not one this client knows`);
    kinds.push(kind);
    at += STEP_SIZES[kind];
  }
  if (at !== steps.length) throw new RangeError('the step list ends inside a step');
  return kinds;
}

/** §4.1's rule for the values a dmi answer carries (the answer counts them itself since nvals; this is the check):
 * the reads and polls among the first `done` steps, plus the failed step's last value when it is a poll that timed out
 * (a poll whose read failed on the line adds nothing).
 * @param {number[]} kinds @param {number} done @param {number} status */
export function dmiValueCount(kinds, done, status) {
  let n = kinds.slice(0, done).filter((k) => VALUE_STEPS.has(k)).length;
  if (status === TIMEOUT && done < kinds.length && POLL_STEPS.has(kinds[done])) n += 1;
  return n;
}

/** The probe declares no max_length for an interface with read_block / write_block. oep-if-debug §4.5 / §6 make it
 * mandatory there, and the host takes its block size from it alone - never from max_frame. */
export class NoMaxLength extends OepError {}

/**
 * The describe common tag max_length (core §7.4) of interface `fn`, in bytes, rounded down to a word. The probe declares
 * it so that both a read_block answer and a write_block request fit its max_frame (oep-if-debug §4.5). Throws
 * NoMaxLength when the probe does not declare it (or declares less than one word).
 * @param {import('./host.js').Host} hst @param {number} fn @param {string} name
 */
export async function declaredMaxLength(hst, fn, name) {
  for (const [tag, v] of await describe(hst, fn)) {
    if ((tag & ~m.TAG_CRITICAL) === catalog.COMMON.max_length && v.length >= 2) {
      const length = Math.floor(getU16(v) / 4) * 4;
      if (length >= 4) return length;
      break;
    }
  }
  throw new NoMaxLength(`${name} (fn ${fn}) declares no usable max_length: read_block / write_block need it `
    + '(oep-if-debug §4.5; the host does not compute a block size from max_frame)');
}

/**
 * `maxLength` (bytes one read_block / write_block may move, from the probe's describe) and `maxWords` on an interface
 * with block operations (RiscvDm, ArmAdi): read once, on first need. Throws NoMaxLength when the probe declares none.
 * @param {Interface & { maxLength: number | null, maxWords: number | null }} iface @returns {Promise<number>} maxWords
 */
export async function blockWords(iface) {
  if (iface.maxWords === null || iface.maxLength === null) {
    iface.maxLength = await declaredMaxLength(iface.host, iface.fn, iface.name);
    iface.maxWords = iface.maxLength / 4;
  }
  return iface.maxWords;
}

/** oep.target.riscv-dm on one connection (every request starts with the connection, u16). Build with
 * `await RiscvDm.on(host, conn)`. `maxLength` (bytes) / `maxWords` bound read_block / write_block: the probe's declared
 * max_length (oep-if-debug §4.5), filled by `on()` when declared, else null (`blockWords()` then throws NoMaxLength). */
export class RiscvDm extends Interface {
  static NAME = 'oep.target.riscv-dm';
  static REVISION = 1;
  static DMI = RV.op.dmi;
  static HALT = RV.op.halt;
  static RESUME = RV.op.resume;
  static RESET = RV.op.reset;
  static READ_BLOCK = RV.op.read_block;
  static WRITE_BLOCK = RV.op.write_block;
  static RUN = RV.op.run;
  static STEP = RV.op.step;
  static RESET_RUN = RV.enum.reset_mode.run;
  static RESET_RUN_CONFIRM = RV.enum.reset_mode.run_verified;
  static RESET_HALT = RV.enum.reset_mode.halt_at_reset;
  static METHOD_DEFAULT = RV.enum.reset_method.probe_default;
  static METHOD_NDMRESET = RV.enum.reset_method.ndmreset;
  static METHOD_SYSTEM = RV.enum.reset_method.system_reset;
  static TAG_RESET_METHOD = RV.tlv.reset.method;
  static TAG_STEP_LEFT = RV.tlv.step_answer.step_left;
  static DPC = 0x07B1;
  /** The optional ops (debug §4), by name: block (read_block / write_block, a pair), run, reset, step. */
  static OPTIONAL = Object.freeze({ block: [RV.op.read_block, RV.op.write_block], run: [RV.op.run], reset: [RV.op.reset],
    step: [RV.op.step] });

  /** @type {number | null} bytes one block operation may move (describe max_length; never computed from max_frame) */
  maxLength = null;
  /** @type {number | null} words (u32) one block operation may move: maxLength / 4 */
  maxWords = null;

  /** @param {import('./host.js').Host} hst @param {number} conn @param {{ fn?: number, name?: string }} [opts] */
  static async on(hst, conn, { fn, name } = {}) {
    const dm = /** @type {RiscvDm} */ (await RiscvDm.open(hst, { fn, name, prefix: u16(conn) }));
    await dm.blockWords().catch((e) => { if (!(e instanceof NoMaxLength)) throw e; });   // undeclared: null until a block op needs it
    return dm;
  }

  get conn() { return getU16(this.prefix); }

  /** The words one read_block / write_block may move, from the probe's declared max_length (NoMaxLength when none). */
  blockWords() { return blockWords(this); }

  /** The optional ops this probe offers, from its describe's ops tag (debug §4, core §1.2, §7.4): 'block' (read_block
   * / write_block, offered as a pair), 'run', 'reset', 'step'. dmi, halt and resume are always there; an op not offered
   * is answered unknown_operation, and the host builds the same thing from dmi. A describe without an ops tag (not a
   * conforming probe) declares none. @returns {Promise<Set<string>>} */
  async declared() {
    const offered = (await this.ops()) ?? new Set();
    return new Set(Object.entries(RiscvDm.OPTIONAL).filter(([, ops]) => ops.every((op) => offered.has(op))).map(([name]) => name));
  }

  /** reset's argument time (core §4.4): reset_settle_ms - the wait for a DM that does not answer while the target
   * restarts by itself after ndmreset (debug §4.3) - at most max_op_ms. */
  async resetMs() {
    try { return Math.min(RESET_SETTLE_MS, await maxOpMs(this.host)); } catch { return RESET_SETTLE_MS; }
  }

  /** @param {string} what @param {number} op */
  async statusOnly(what, op) {
    const r = await this.request(op);
    const rd = ran(r);
    const status = rd.u8();
    rd.tail();
    check(what, r, status);
  }

  /** Idempotent: an already halted hart is ok (§4.2). */
  halt() { return this.statusOnly('halt', RiscvDm.HALT); }

  /** One resumereq; ok = the hart left debug mode (status state if the probe saw it not go). Parts that need more (the
   * CH32 rule) are the host's (§4.2). */
  resume() { return this.statusOnly('resume', RiscvDm.RESUME); }

  /** A GPR / CSR of the halted hart through an abstract command (access register, 32 bits) in plain DMI steps, so any
   * probe with dmi does it. A cmderr is cleared, then thrown.
   * @param {number} regno */
  async readRegister(regno) {
    const { values } = await this.dmi([RiscvDm.stepWrite(0x17, (0x00220000 | regno) >>> 0),
      RiscvDm.stepPoll(0x16, 1 << 12, 0, 100), RiscvDm.stepRead(0x04)]);
    const cs = values[0], data0 = values[1];
    if ((cs >> 8) & 7) {
      await this.dmi([RiscvDm.stepWrite(0x16, 0x700)]);
      throw new Error(`abstract command for register 0x${regno.toString(16)} failed (cmderr ${(cs >> 8) & 7})`);
    }
    return data0;
  }

  /** @param {number} mode @param {number | null} method */
  async resetMode(mode, method) {
    const body = new Writer().u8(mode);
    if (method != null) body.raw(m.tlv(RiscvDm.TAG_RESET_METHOD, [method], true));
    const r = await this.request(RiscvDm.RESET, body.done(), { expectMs: await this.resetMs() });
    const rd = ran(r);
    const status = rd.u8(), flags = rd.u8(), attempts = rd.u8(), pc = rd.u32();
    rd.tail();
    check('reset', r, status);
    return { flags, attempts, pc };
  }

  /** Reset and let it run (confirm: seen running). method: METHOD_* (critical; none or METHOD_DEFAULT: the probe's
   * default, ndmreset in revision 1). The reset op never drives a reset line (debug §4.3): a line moves only through
   * attach's reset TLV (`Wire.attachUnderReset`) or a fixture.
   * @param {{ confirm?: boolean, method?: number | null }} [opts] */
  reset({ confirm = true, method = null } = {}) {
    return this.resetMode(confirm ? RiscvDm.RESET_RUN_CONFIRM : RiscvDm.RESET_RUN, method);
  }

  /** Reset and stop before the first instruction (haltreq held through the reset). -> dpc
   * @param {{ method?: number | null }} [opts] */
  async resetHalt({ method = null } = {}) { return (await this.resetMode(RiscvDm.RESET_HALT, method)).pc; }

  /** One instruction (dcsr.step, one resume, privilege kept). -> { moved, before, after } (dpc before / after, §4.2). A
   * hart that did not come back throws StepError (§4.2, P2-○4): `stepLeft` false - the probe halted it with haltreq
   * and restored it, `after` valid; true (answer TLV step_left) - it could not halt it again: the hart runs and
   * dcsr.step may still be set, so the host halts it and clears dcsr.step. */
  async step() {
    const r = await this.request(RiscvDm.STEP);
    const rd = ran(r);
    const status = rd.u8(), moved = rd.u8() !== 0, before = rd.u32(), after = rd.u32();
    const tail = rd.tail();
    if (status !== OK || !r.succeeded) throw new StepError(status, r, before, after, tail.get(RiscvDm.TAG_STEP_LEFT) !== undefined);
    return { moved, before, after };
  }

  /** `count` words from `address`. A read that stopped throws TargetError (.data = the words it did read).
   * @param {number} address @param {number} count */
  async readBlock(address, count) {
    const r = await this.request(RiscvDm.READ_BLOCK, new Writer().u32(address).u16(count).done());
    const { data, done, status } = RiscvDm.readBlockResult(r);
    if (status !== OK || !r.succeeded || done !== count) throw new TargetError('read_block', status, r, { done, data });
    return data;
  }

  /** -> { data: the words read as bytes, done, status }. @param {m.Result} r */
  static readBlockResult(r) {
    const rd = ran(r);
    const done = rd.u16(), status = rd.u8();
    const data = rd.bytes(4 * done);
    rd.tail();
    return { data, done, status };
  }

  /** @param {number} address @param {Uint8Array} data */
  static writeBlockBody(address, data) {
    if (data.length % 4) throw new RangeError('write_block writes whole words');
    return new Writer().u32(address).u16(data.length / 4).raw(data).done();
  }

  /** @param {number} address @param {Uint8Array} data */
  async writeBlock(address, data) {
    const r = await this.request(RiscvDm.WRITE_BLOCK, RiscvDm.writeBlockBody(address, data));
    const rd = ran(r);
    const done = rd.u16(), status = rd.u8();
    rd.tail();
    check('write_block', r, status, { done });
  }

  /** @param {number} address @param {number} value */
  write32(address, value) { return this.writeBlock(address, new Writer().u32(value).done()); }
  /** @param {number} address */
  async read32(address) { return getU32(await this.readBlock(address, 1)); }

  /** pc, timeoutMs (1 .. the probe's max_op_ms; run() turns null into that ceiling), the registers to set, then the
   * registers to read back (`outs`) (§4.4).
   * @param {number} pc @param {[number, number][]} regs @param {{ timeoutMs?: number, outs?: number[] }} [opts] */
  static runBody(pc, regs, { timeoutMs = 200, outs = [REG_A0] } = {}) {
    if (timeoutMs == null) throw new RangeError("runBody needs a timeoutMs (1 .. the probe's max_op_ms); run({ timeoutMs: null }) takes the probe's ceiling");
    const w = new Writer().u32(pc).u32(timeoutMs).u8(regs.length);
    for (const [r, v] of regs) w.u16(r).u32(v);
    w.u8(outs.length);
    for (const r of outs) w.u16(r);
    return w.done();
  }

  /** Decode a run result (any known outcome) without judging it: `status stopped dpc elapsed_us nvals(u8) values
   * [TLV]` (§4.4; the answer counts its values). @param {m.Result} result @returns {RunResult} */
  static runResult(result) {
    const rd = ran(result);
    const status = rd.u8(), stopped = rd.u8(), dpc = rd.u32(), elapsedUs = rd.u32(), nvals = rd.u8();
    const values = rd.words(nvals);
    rd.tail();
    return { status, stopped: stopped === RUN_STOPPED.stopped, notHalted: stopped === RUN_STOPPED.not_halted, dpc, elapsedUs, values };
  }

  /** Set registers and dpc (dcsr.ebreakm, prv = M), resume, wait for the hart's own ebreak (forced halt at the
   * timeout: stopped false, status timeout - returned, not thrown; notHalted when the probe could not even stop it).
   * timeoutMs null: the probe's max_op_ms (core §7.5), the most it allows. Other statuses throw TargetError (§4.4).
   * @param {number} pc @param {[number, number][]} regs @param {{ timeoutMs?: number | null, outs?: number[] }} [opts] */
  async run(pc, regs, { timeoutMs = 200, outs = [REG_A0] } = {}) {
    const limit = timeoutMs ?? await maxOpMs(this.host);
    const r = await this.request(RiscvDm.RUN, RiscvDm.runBody(pc, regs, { timeoutMs: limit, outs }), { expectMs: limit });
    const res = RiscvDm.runResult(r);
    if (res.status === TIMEOUT && !res.stopped) return res;
    check('run', r, res.status);
    return res;
  }

  /** Run a step list (the step* builders, concatenated or as a list). -> { done: steps done, values: one per read and
   * poll step }. The answer is `done status nvals(u16) values [TLV]` (§4.1). A list that stopped early throws
   * StepListError (with what it did read): a caller cannot mistake an unfinished poll for a met one.
   * @param {Uint8Array | Uint8Array[]} steps */
  async dmi(steps) {
    const raw = Array.isArray(steps) ? concat(...steps) : steps;
    const kinds = countSteps(raw);
    const r = await this.request(RiscvDm.DMI, concat(u16(kinds.length), raw), { expectMs: dmiWaitMs(raw) });
    const rd = ran(r);
    const done = rd.u16(), status = rd.u8(), nvals = rd.u16();
    const values = rd.words(nvals);
    rd.tail();
    if (status !== OK || !r.succeeded || done !== kinds.length) throw new StepListError(done, status, values, r);
    return { done, values };
  }

  /** @param {number} address @param {number} value */
  static stepWrite(address, value) { return new Writer().u8(STEP_WRITE).u8(address).u32(value).done(); }

  /** @param {number} address */
  static stepRead(address) { return new Writer().u8(STEP_READ).u8(address).done(); }

  /** Read until (value & mask) === value, at most maxReads times; adds the last value read (met or not).
   * @param {number} address @param {number} mask @param {number} value @param {number} maxReads */
  static stepPoll(address, mask, value, maxReads) {
    return new Writer().u8(STEP_POLL_READS).u8(address).u32(mask).u32(value).u16(maxReads).done();
  }

  /** @param {number} us */
  static stepDelay(us) { return new Writer().u8(STEP_WAIT_US).u32(us).done(); }

  /** poll bounded by time rather than reads: the same meaning on a slow bit-banged link and a fast one.
   * @param {number} address @param {number} mask @param {number} value @param {number} maxUs */
  static stepPollTime(address, mask, value, maxUs) {
    return new Writer().u8(STEP_POLL_US).u8(address).u32(mask).u32(value).u32(maxUs).done();
  }
}

const GPIO = reg.FIXTURE_GPIO;

/** oep.fixture.gpio set of one (channel, mode) (oep-if-fixture). @param {number} channel @param {number} mode */
function gpioSetBody(channel, mode) { return new Writer().u8(1).u16(channel).u8(mode).done(); }

/**
 * For a probe without the attach reset TLV (§3): pull `channel` low through oep.fixture.gpio (fn `gpioFn`), then send
 * its release and an attach (halt) in one pipeline so the probe starts the attach right after the release, and retry -
 * a race at the edge of the target's reset window (2026-09-24, CH32V003 with SWIO turned off: 2 of 5 pipelined, 0 of 5
 * one request at a time). -> { conn, dmstatus }
 * @param {import('./host.js').Host} hst @param {Wire} wire @param {number} gpioFn @param {number} channel
 * @param {{ tries?: number, lowMs?: number }} [opts]
 */
export async function attachAfterGpioReset(hst, wire, gpioFn, channel, { tries = 10, lowMs = 20 } = {}) {
  if (tries < 1) throw new RangeError('tries must be at least 1');
  /** @type {m.Result | null} */
  let last = null;
  const attachReq = wire.req(Wire.ATTACH, await wire.attachBody({ halt: true }));   // built once: its describe is not in the race
  const expectMs = await wire.attachMs();             // the attach's budget is its argument time (core §4.4)
  for (let i = 0; i < tries; i++) {
    await hst.call(gpioFn, GPIO.op.set, gpioSetBody(channel, GPIO.enum.mode.open_drain_low));
    await sleep(lowMs);
    const [release, attach] = await hst.pipeline([[gpioFn, GPIO.op.set, gpioSetBody(channel, GPIO.enum.mode.open_drain_release)],
      attachReq], { expectMs });
    last = attach;
    if (release.resolution === m.REJECTED) throw rejection(release);   // never leave the reset line held
    if (!release.succeeded) throw new Failed(release);
    if (attach.succeeded) {
      const rd = new m.Reader(attach.payload);
      const conn = rd.u16(), dmstatus = rd.u32();
      return { conn, dmstatus };
    }
  }
  throw new Failed(last);
}
