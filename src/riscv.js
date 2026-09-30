// @ts-check
// oep.wire.rvswd / oep.wire.swio and oep.target.riscv-dm, revision 1 (oep-spec oep-if-debug §1-§4).
//
// The host knows the target; the probe only moves wires and DMI. Everything chip-specific (flash controller, RAM
// loaders, register meanings) stays on this side.
//
// common §3: wire and target results carry a status (ok, wait, line, fault, timeout, state; any other value is a
// failure). A request the probe ran but that did not get through is completed failed (nothing done) or partial (some
// done) with the success shape, so `done` and `status` say how far it went: this module throws TargetError with them.

import * as reg from './registry.js';
import { Writer, concat, getU16, getU32 } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { Failed, OepError, Rejected, rejection } from './errors.js';
import { Interface, describe } from './core.js';

export const STATUS = reg.STATUS;
export const OK = STATUS.ok;
export const TIMEOUT = STATUS.timeout;
/** @type {Record<number, string>} */
export const STATUS_NAMES = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));
const RV = reg.TARGET_RISCV_DM;
const RVSWD = reg.WIRE_RVSWD;
export const STEP = RV.enum.dmi_step;
export const STEP_WRITE = STEP.write, STEP_READ = STEP.read, STEP_POLL_READS = STEP.poll_reads;
export const STEP_WAIT_US = STEP.wait_us, STEP_POLL_US = STEP.poll_us;
/** @type {Record<number, number>} bytes per step kind, the kind included (§4.1) */
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

/** oep.wire.<link>: scan / attach / detach / connections. The shared part; each link's attach takes its own arguments. */
export class WireBase extends Interface {
  static SCAN = WOP.scan;
  static ATTACH = WOP.attach;
  static DETACH = WOP.detach;
  static ATTACH_UNDER_RESET = WOP.attach_under_reset;
  static CONNECTIONS = WOP.connections;
  static REVISION = 1;
  static TAG_MAX_SPEED = RVSWD.tlv.attach.max_speed;
  static TAG_PINS = RVSWD.tlv.attach.pins;      // swdio(u16) swclk(u16, 0xFFFF on one wire), critical (§1)
  static TAG_SKIP = RVSWD.tlv.scan.skip;        // scan, count 0 only: pairs of the count-0 list to skip (§1)
  static TAG_FORCE = RVSWD.tlv.detach.force;
  static NO_SLOT = 0xFF;

  /**
   * Try `pairs` of [swdio, swclk]; none = every pair the probe allows and nothing holds (describe's channel_group /
   * role_channels, §1). A pair the probe does not allow, or one whose pins something holds, refuses the whole scan
   * (rejected unavailable). The probe tries at most 255 pairs a request and stops early when its answer would not fit
   * one frame; this goes on until every pair is tried (count 0: with skip until tried = 0).
   * @param {[number, number][] | null} pairs @returns {Promise<Found[]>}
   */
  async scan(pairs = null) {
    /** @type {Found[]} */
    const out = [];
    let left = [...(pairs ?? [])];
    const listed = left.length > 0;
    let skip = 0;
    for (;;) {
      const chunk = left.slice(0, 255);
      const w = new Writer().u8(chunk.length);
      for (const [d, c] of chunk) w.u16(d).u16(c);
      if (!listed && skip) w.raw(m.tlv(WireBase.TAG_SKIP, u16(skip)));
      const rd = new m.Reader((await this.call(WireBase.SCAN, w.done())).payload);
      const tried = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {
        const e = rd.element();   // len(u8)-prefixed: read what this client knows of it (core §2.3)
        const kind = e.u8(), dio = e.u16(), clk = e.u16(), status = e.u32();
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

  /** The wire's live connections, in the order they were made (§2.1, lock-free). @returns {Promise<ConnectionInfo[]>} */
  async connections() {
    const rd = new m.Reader((await this.call(WireBase.CONNECTIONS, new Uint8Array(), { locked: false })).payload);
    /** @type {ConnectionInfo[]} */
    const out = [];
    const count = rd.u8();
    for (let i = 0; i < count; i++) {
      const e = rd.element();
      const conn = e.u16(), dio = e.u16(), clk = e.u16(), speedHz = e.u32(), users = e.u8(), slot = e.u8();
      const scheme = e.u8(), tid = e.bytes(e.u8());
      out.push({ conn, pins: [dio, clk], speedHz, users, slot, targetId: scheme ? [scheme, tid] : null });
    }
    rd.tail();
    return out;
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

const IDLE_CLOCK = RVSWD.enum.idle_clock;

/** oep.wire.rvswd / oep.wire.swio (CH32 debug links to a RISC-V debug module). swio: `Wire.open(hst, { name: 'oep.wire.swio' })`. */
export class Wire extends WireBase {
  static NAME = 'oep.wire.rvswd';
  static ROLE_RESET = RVSWD.enum.pin_role.reset;
  static TAG_IDLE_CLOCK = RVSWD.tlv.attach.idle_clock;
  static IDLE_CLOCK = IDLE_CLOCK;
  static RUN = RVSWD.enum.attach_method.run;
  static HALT = RVSWD.enum.attach_method.halt;
  static TAG_TARGET_ID = RVSWD.tlv.attach_answer.target_id;
  static SCHEME_WCH_DMI_7F = RVSWD.enum.target_id_scheme.wch_dmi_7f;

  hadReset = false;
  existing = false;
  speedHz = 0;
  /** @type {number[]} */ ignored = [];
  /** @type {[number, Uint8Array] | null} (scheme, value) the last attach read, or null */ targetId = null;
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

  /** The channels attachUnderReset may take (describe role_channels, role reset). There is no default reset line: the
   * host names one every time (§3). */
  async resetChannels() {
    const out = new Set();
    for (const [tag, v] of await describe(this.host, this.fn)) {
      if ((tag & ~m.TAG_CRITICAL) === catalog.COMMON.role_channels && v[0] === Wire.ROLE_RESET) {
        for (const c of catalog.bitmapToChannels(getU16(v, 1), v.slice(3))) out.add(c);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * -> { conn, dmstatus }. Attaching an attached wire returns its connection as it is (this.existing). this.hadReset:
   * a pending havereset was acknowledged first (a V00x's DMSTATUS halt / run bits stay frozen until then);
   * this.speedHz: the speed the probe chose; maxSpeed: a ceiling the probe must keep (critical); idleClock: 'high' /
   * 'low', how rvswd rests SWCLK (critical). Both are the target's, known by the host (§3). this.targetId: [scheme,
   * value] of the target's identity when the probe could read one.
   * @param {{ halt?: boolean, maxSpeed?: number | null, pins?: [number, number] | null, idleClock?: 'high' | 'low' | null }} [opts]
   */
  async attach({ halt = true, maxSpeed = null, pins = null, idleClock = null } = {}) {
    const body = concat([halt ? Wire.HALT : Wire.RUN], this.speedTlv(maxSpeed), this.pinsTlv(pins), this.idleTlv(idleClock));
    const rd = new m.Reader((await this.call(Wire.ATTACH, body)).payload);
    const conn = rd.u16(), dmstatus = rd.u32(), flags = rd.u8();
    this.speedHz = rd.u32();
    this.hadReset = !!(flags & 1); this.existing = !!(flags & 2);
    const tail = rd.tail();
    this.ignored = tail.ignored;
    this.takeTargetId(tail);
    return { conn, dmstatus };
  }

  /**
   * Hold the target in reset through `channel` (always named: there is no default reset line; the probe allows
   * resetChannels()), attach, release and halt it at once - the way back from firmware that turns the debug pins into
   * GPIOs. -> { conn, dpc }
   * @param {number} channel
   * @param {{ holdMs?: number, maxSpeed?: number | null, pins?: [number, number] | null, idleClock?: 'high' | 'low' | null }} [opts]
   */
  async attachUnderReset(channel, { holdMs = 20, maxSpeed = null, pins = null, idleClock = null } = {}) {
    const body = concat(new Writer().u16(channel).u16(holdMs).done(), this.speedTlv(maxSpeed), this.pinsTlv(pins),
      this.idleTlv(idleClock));
    const rd = new m.Reader((await this.call(Wire.ATTACH_UNDER_RESET, body)).payload);
    const conn = rd.u16(), dpc = rd.u32();
    this.speedHz = rd.u32();
    this.takeTargetId(rd.tail());
    return { conn, dpc };
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

/** @typedef {{ status: number, stopped: boolean, dpc: number, elapsedUs: number, values: number[] }} RunResult
 * stopped: the hart halted on its own (ebreak) before timeoutMs; values: the registers asked for in `outs`, in order */

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

/** §4.1: the reads and polls among the first `done` steps, plus the failed step's last value when it is a poll that
 * timed out (a poll whose read failed on the line adds nothing).
 * @param {number[]} kinds @param {number} done @param {number} status */
export function dmiValueCount(kinds, done, status) {
  let n = kinds.slice(0, done).filter((k) => VALUE_STEPS.has(k)).length;
  if (status === TIMEOUT && done < kinds.length && POLL_STEPS.has(kinds[done])) n += 1;
  return n;
}

/** oep.target.riscv-dm on one connection (every request starts with the connection, u16). Build with
 * `await RiscvDm.on(host, conn)`. */
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
  static NO_TIMEOUT = 0xFFFFFFFF;
  static DPC = 0x07B1;

  /** @param {import('./host.js').Host} hst @param {number} conn @param {{ fn?: number, name?: string }} [opts] */
  static async on(hst, conn, { fn, name } = {}) {
    return /** @type {RiscvDm} */ (await RiscvDm.open(hst, { fn, name, prefix: u16(conn) }));
  }

  get conn() { return getU16(this.prefix); }

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
    const r = await this.request(RiscvDm.RESET, body.done());
    const rd = ran(r);
    const status = rd.u8(), flags = rd.u8(), attempts = rd.u8(), pc = rd.u32();
    rd.tail();
    check('reset', r, status);
    return { flags, attempts, pc };
  }

  /** Reset and let it run (confirm: seen running). method: METHOD_* (critical; none: the probe chooses) (§4.3).
   * @param {{ confirm?: boolean, method?: number | null }} [opts] */
  reset({ confirm = true, method = null } = {}) {
    return this.resetMode(confirm ? RiscvDm.RESET_RUN_CONFIRM : RiscvDm.RESET_RUN, method);
  }

  /** Reset and stop before the first instruction (haltreq held through the reset). -> dpc
   * @param {{ method?: number | null }} [opts] */
  async resetHalt({ method = null } = {}) { return (await this.resetMode(RiscvDm.RESET_HALT, method)).pc; }

  /** One instruction (dcsr.step, one resume, privilege kept). -> { moved, before, after } (dpc before / after, §4.2) */
  async step() {
    const r = await this.request(RiscvDm.STEP);
    const rd = ran(r);
    const status = rd.u8(), moved = rd.u8() !== 0, before = rd.u32(), after = rd.u32();
    rd.tail();
    check('step', r, status);
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

  /** pc, timeoutMs (null: no limit), the registers to set, then the registers to read back (`outs`) (§4.4).
   * @param {number} pc @param {[number, number][]} regs @param {{ timeoutMs?: number | null, outs?: number[] }} [opts] */
  static runBody(pc, regs, { timeoutMs = 200, outs = [REG_A0] } = {}) {
    const w = new Writer().u32(pc).u32(timeoutMs === null ? RiscvDm.NO_TIMEOUT : timeoutMs).u8(regs.length);
    for (const [r, v] of regs) w.u16(r).u32(v);
    w.u8(outs.length);
    for (const r of outs) w.u16(r);
    return w.done();
  }

  /** Decode a run result (any known outcome) without judging it. @param {m.Result} result @param {number} nOut
   * @returns {RunResult} */
  static runResult(result, nOut = 1) {
    const rd = ran(result);
    const status = rd.u8(), stopped = rd.u8() !== 0, dpc = rd.u32(), elapsedUs = rd.u32();
    const values = rd.words(nOut);
    rd.tail();
    return { status, stopped, dpc, elapsedUs, values };
  }

  /** Set registers and dpc (dcsr.ebreakm, prv = M), resume, wait for the hart's own ebreak (forced halt at the
   * timeout: stopped false, status timeout - returned, not thrown). Other statuses throw TargetError (§4.4).
   * @param {number} pc @param {[number, number][]} regs @param {{ timeoutMs?: number | null, outs?: number[] }} [opts] */
  async run(pc, regs, { timeoutMs = 200, outs = [REG_A0] } = {}) {
    const r = await this.request(RiscvDm.RUN, RiscvDm.runBody(pc, regs, { timeoutMs, outs }));
    const res = RiscvDm.runResult(r, outs.length);
    if (res.status === TIMEOUT && !res.stopped) return res;
    check('run', r, res.status);
    return res;
  }

  /** Run a step list (the step* builders, concatenated or as a list). -> { done: steps done, values: one per read and
   * poll step }. A list that stopped early throws StepListError (with what it did read): a caller cannot mistake an
   * unfinished poll for a met one (§4.1).
   * @param {Uint8Array | Uint8Array[]} steps */
  async dmi(steps) {
    const raw = Array.isArray(steps) ? concat(...steps) : steps;
    const kinds = countSteps(raw);
    const r = await this.request(RiscvDm.DMI, concat(u16(kinds.length), raw));
    const rd = ran(r);
    const done = rd.u16(), status = rd.u8();
    const values = rd.words(dmiValueCount(kinds, done, status));
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
 * For a probe without attach_under_reset (§3): pull `channel` low through oep.fixture.gpio (fn `gpioFn`), then send
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
  for (let i = 0; i < tries; i++) {
    await hst.call(gpioFn, GPIO.op.set, gpioSetBody(channel, GPIO.enum.mode.open_drain_low));
    await sleep(lowMs);
    const [release, attach] = await hst.pipeline([[gpioFn, GPIO.op.set, gpioSetBody(channel, GPIO.enum.mode.open_drain_release)],
      wire.req(Wire.ATTACH, Uint8Array.of(Wire.HALT))]);
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
