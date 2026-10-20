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
// before it answers, so nothing of the probe's own is left in the target between requests. DATA0 that this host's own
// dmi sequences change (readRegister) is the host's to write back before the hart runs (debug §4): the console's
// mailbox lives there (`RiscvDm.dataSaved`, `RiscvDm.restoreData`).
//
// The waits: attach, scan and riscv-dm's reset take as long as the probe needs, up to max_op_ms - their argument time
// (core §4.4, debug §1, §4.3).

import * as reg from './registry.js';
import { Writer, concat, getU16, getU32 } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { Failed, OepError, Rejected, rejection } from './errors.js';
import { FALLBACK_MAX_OP_MS, Interface, describe, maxOpMs } from './core.js';

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
 * step did not succeed (oep-if-debug §4.2, P2-○4): `stepLeft` - the probe could not halt the hart again (it runs,
 * dcsr.step may still be set: halt it and clear dcsr.step); otherwise the hart is halted again (or was not halted to
 * begin with). moved, dpc_before and dpc_after mean something only with status ok - the probe sends 0 otherwise and they
 * are not read: `before` / `after` are null; a halted hart's dpc is read with dmi.
 */
export class StepError extends TargetError {
  /** @param {number} status @param {m.Result} result @param {boolean} stepLeft */
  constructor(status, result, stepLeft) {
    super('step', status, result);
    /** @type {number | null} */ this.before = null;
    /** @type {number | null} */ this.after = null;
    this.stepLeft = stepLeft;
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

/** A scan hit (§3 / §5): kind (the target interface), the pair attach takes back as `pins`, and the row's id(u32) -
 * DMSTATUS on rvswd / swio, DPIDR on swd (its name from the RISC-V wires).
 * @typedef {{ kind: number, pins: [number, number], dmstatus: number }} Found */

/** One live connection (§2.1). targetId: [scheme, value] read at attach (null: none); targetsel: the TARGETSEL the
 * host supplied at attach (swd; null: none); idleClock: rvswd's rest the connection uses, 'high' / 'low' (§3.1; null:
 * not said).
 * @typedef {{ conn: number, pins: [number, number], speedHz: number, targetId: [number, Uint8Array] | null,
 *   targetsel: number | null, idleClock: string | null }} ConnectionInfo */

/** Every target_id scheme defined so far: a u32. */
const TARGET_ID_U32 = new Set(Object.values(reg.COMMON.enum.target_id_scheme));

/** An attach answer's target_id TLV, scheme(u8) value (§1) -> [scheme, value], or null: absent, or a known scheme whose
 * value is not its u32 (a broken TLV is not used, core §2.3). An unknown scheme's value is kept raw (its length is that
 * scheme's). @param {Uint8Array | undefined} v @returns {[number, Uint8Array] | null} */
export function targetIdOf(v) {
  if (!v || !v.length || (TARGET_ID_U32.has(v[0]) && v.length !== 5)) return null;
  return [v[0], v.slice(1)];
}

const SELECTED_TARGET = reg.WIRE_SWD.tlv.connections_answer.selected_target;
const REST = RVSWD.tlv.connections_answer.idle_clock;

const WOP = RVSWD.op;   // scan / attach / detach / connections: the same numbers on every wire
const IDLE_CLOCK = RVSWD.enum.idle_clock;

/** The attach answer's flags, the same on every wire (§3): bit0 havereset_acked, bit2 dormant_woken, bit3 halted (the
 * dpc TLV is valid). */
export const ATTACH_FLAGS = RVSWD.enum.attach_flags;

/** oep.wire.<link>: scan / attach / detach / connections / holds (§0-§2). The shared part; each link's attach takes
 * its own arguments. A failed scan, attach or detach is completed failed with `status(u8) [TLV]` (common §3). attach
 * names its pins in the fixed part (§1): `pins` null takes the wire's one candidate pair (`candidatePairs`). */
export class WireBase extends Interface {
  static SCAN = WOP.scan;
  static ATTACH = WOP.attach;
  static DETACH = WOP.detach;
  static CONNECTIONS = WOP.connections;
  static HOLDS = WOP.holds;
  static REVISION = 1;
  static TAG_RESET = RVSWD.tlv.attach.reset;           // channel(u16) hold_ms(u16), critical: attach under reset (§3)
  static TAG_SCAN_MAX_SPEED = RVSWD.tlv.scan.max_speed;
  static TAG_SCAN_IDLE_CLOCK = RVSWD.tlv.scan.idle_clock;
  static FLAGS = ATTACH_FLAGS;
  /** when the wire declares no max_clock_hz either */
  static DEFAULT_MAX_SPEED = 1_000_000;

  /** the attach_flags byte of the last attach */
  flags = 0;

  /** swio: one wire, swclk 0xFFFF (§3) */
  get oneWire() { return this.name === 'oep.wire.swio'; }

  /** The rest TLVs are rvswd's (§3.1). */
  get isRvswd() { return this.name === 'oep.wire.rvswd'; }

  /** @returns {Promise<catalog.Description>} */
  async description() { return catalog.decodeDescription(await describe(this.host, this.fn)); }

  /**
   * The [swdio, swclk] pairs the wire's describe allows (§1, core §7.4): per channel_group its role 1 / role 2 (kept
   * only when role_channels, listing that role too, has the channel; a role the group does not list from
   * role_channels), else role_channels' role 1 x role 2 without using a channel twice (swio: swclk 0xFFFF).
   * @returns {Promise<[number, number][]>}
   */
  async candidatePairs() {
    const d = await this.description();
    /** @param {Map<number, number>} group @param {number} role */
    const options = (group, role) => {
      const ch = group.get(role);
      if (ch !== undefined) return !d.roles.has(role) || /** @type {number[]} */ (d.roles.get(role)).includes(ch) ? [ch] : [];
      return [...(d.roles.get(role) ?? [])];
    };
    /** @type {[number, number][]} */
    const out = [];
    const groups = d.groups.size ? [...d.groups.values()].map((pins) => new Map(pins)) : [new Map()];
    for (const group of groups) {
      const clks = this.oneWire ? [0xffff] : options(group, 2);
      for (const dio of options(group, 1)) {
        for (const clk of clks) {
          if ((this.oneWire || dio !== clk) && !out.some(([a, b]) => a === dio && b === clk)) out.push([dio, clk]);
        }
      }
    }
    return out;
  }

  /** The pins named, or the wire's one candidate pair. @param {[number, number] | null | undefined} pins
   * @returns {Promise<[number, number]>} */
  async pinsOrOnly(pins) {
    if (pins != null) return pins;
    const pairs = await this.candidatePairs();
    if (pairs.length !== 1) throw new RangeError(`${this.name}: name the pins - the probe allows ${pairs.length} pairs`);
    return pairs[0];
  }

  /** attach's max_speed (the fixed part, never 0): null takes the wire's declared max_clock_hz (its describe, cached),
   * else DEFAULT_MAX_SPEED. The target's ceiling is the host's to know (§1).
   * @param {number | null | undefined} maxSpeed */
  async speedOrDefault(maxSpeed) {
    if (maxSpeed != null) return maxSpeed;
    // the first copy, a u32 exactly; bit 7 in an answer is an unknown tag (core §2.2, §2.3)
    const v = catalog.firstFixed(await describe(this.host, this.fn), catalog.COMMON.max_clock_hz, 4);
    return v ? getU32(v) : WireBase.DEFAULT_MAX_SPEED;
  }

  /** method(u8) swdio(u16) swclk(u16) max_speed(u32): attach's fixed part (§1).
   * @param {number} method @param {[number, number] | null | undefined} pins @param {number | null | undefined} maxSpeed */
  async attachFixed(method, pins, maxSpeed) {
    const [dio, clk] = await this.pinsOrOnly(pins);
    return new Writer().u8(method).u16(dio).u16(clk).u32(await this.speedOrDefault(maxSpeed)).done();
  }

  /** The probe's max_op_ms (core §7.5), FALLBACK_MAX_OP_MS when it cannot be read. */
  async maxOpMs() {
    try { return await maxOpMs(this.host); } catch { return FALLBACK_MAX_OP_MS; }
  }

  /** attach's argument time (core §4.4, debug §1): max_op_ms - the probe answers within it, its search, retries, the
   * reset TLV's hold and the wait for a silent DM included. The host's wait adds host_wait_add_ms and the transfer
   * time. @param {[number, number] | null} [reset] */
  attachMs(reset = null) { return this.maxOpMs(); }

  /** scan's argument time: max_op_ms (debug §1). */
  scanMs() { return this.maxOpMs(); }

  /** [channel, holdMs], critical: hold the reset line (open drain, low) that long, then attach (§3).
   * @param {[number, number] | null | undefined} reset */
  resetTlv(reset) {
    return reset == null ? new Uint8Array() : m.tlv(WireBase.TAG_RESET, new Writer().u16(reset[0]).u16(reset[1]).done(), true);
  }

  /**
   * Try `pairs` of [swdio, swclk]; null = candidatePairs() (the host builds the list: scan has no implicit one, §1). A
   * pair the probe does not allow, or one whose pins something holds, refuses the whole scan (rejected). maxSpeed (null:
   * the wire's slowest speed) and idleClock ('high' / 'low', rvswd only) are the target's line settings (§3). The probe
   * answers how many it tried from the front (at least one while any remain); the rest go in the next request, until
   * every pair is tried.
   * @param {[number, number][] | null} pairs @param {{ maxSpeed?: number | null, idleClock?: 'high' | 'low' | null }} [opts]
   * @returns {Promise<Found[]>}
   */
  async scan(pairs = null, { maxSpeed = null, idleClock = null } = {}) {
    /** @type {Found[]} */
    const out = [];
    let left = [...(pairs ?? await this.candidatePairs())];
    const extra = new Writer();
    if (maxSpeed != null) extra.raw(m.tlv(WireBase.TAG_SCAN_MAX_SPEED, new Writer().u32(maxSpeed).done(), true));
    if (idleClock != null) extra.raw(m.tlv(WireBase.TAG_SCAN_IDLE_CLOCK, [IDLE_CLOCK[idleClock]], true));
    const expectMs = await this.scanMs();
    // count(u8) and 4 bytes a pair after the request's header, the TLVs at the end: at most 255, and what fits max_frame
    const frame = (await this.host.confirmed()).maxFrame;
    const most = Math.max(1, Math.min(255, Math.floor((frame - m.REQUEST_HEADER - 1 - extra.bytes.length) / 4)));
    while (left.length) {
      const chunk = left.slice(0, most);
      const w = new Writer().u8(chunk.length);
      for (const [d, c] of chunk) w.u16(d).u16(c);
      w.raw(extra.done());
      const rd = new m.Reader((await this.call(WireBase.SCAN, w.done(), { expectMs })).payload);
      const tried = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {
        const kind = rd.u8(), dio = rd.u16(), clk = rd.u16(), status = rd.u32();   // 9 bytes, no length (core §2.3)
        out.push({ kind, pins: [dio, clk], dmstatus: status });
      }
      rd.tail();
      if (tried === 0) throw new OepError(`${this.name} scan tried none of ${chunk.length} pairs`);
      left = left.slice(tried);
    }
    return out;
  }

  /** Close the connection and its streams (§2). @param {number} conn */
  async detach(conn) { await this.call(WireBase.DETACH, new Writer().u32(conn).done()); }

  /** The ports this wire holds at their rest after a close (§2.2, lock-free; paged like connections): [[swdio, swclk],
   * rest] - rest: rvswd's idle_clock value (0 high, 1 low), 0 on other wires. Not connections.
   * @returns {Promise<[[number, number], number][]>} */
  async holds() {
    /** @type {[[number, number], number][]} */
    const out = [];
    for (;;) {
      const rd = new m.Reader((await this.call(WireBase.HOLDS, Uint8Array.of(out.length), { locked: false })).payload);
      const more = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {
        const dio = rd.u16(), clk = rd.u16(), rest = rd.u8();
        out.push([[dio, clk], rest]);
      }
      rd.tail();
      if (!more || !count || out.length > 0xff) return out;
    }
  }

  /** The wire's live connections, in the order they were made (§2.1, lock-free; paged: the request is first(u8), the
   * answer `more count × entry [TLV]`, followed until more is 0). swd's selected_target TLVs (entry_index, targetsel)
   * give each entry the TARGETSEL the host supplied; rvswd's idle_clock TLVs (entry_index, idle_clock) its rest.
   * @returns {Promise<ConnectionInfo[]>} */
  async connections() {
    /** @type {ConnectionInfo[]} */
    const out = [];
    const rests = /** @type {Record<number, string>} */ (Object.fromEntries(Object.entries(IDLE_CLOCK).map(([k, v]) => [v, k])));
    for (;;) {
      const rd = new m.Reader((await this.call(WireBase.CONNECTIONS, Uint8Array.of(out.length), { locked: false })).payload);
      const more = rd.u8(), count = rd.u8();
      /** @type {ConnectionInfo[]} */
      const page = [];
      for (let i = 0; i < count; i++) {
        const conn = rd.u32(), dio = rd.u16(), clk = rd.u16(), speedHz = rd.u32();
        const scheme = rd.u8(), tid = rd.bytes(rd.u8());
        page.push({ conn, pins: [dio, clk], speedHz, targetId: scheme ? [scheme, tid] : null, targetsel: null, idleClock: null });
      }
      for (const [tag, v] of m.splitTlvs(rd.rest())) {
        // entry_index(u8) targetsel(u32), repeatable; bit 7 in an answer: an unknown tag (core §2.2, §2.3)
        if (tag === SELECTED_TARGET && v.length === 5 && v[0] < page.length) page[v[0]].targetsel = getU32(v, 1);
        // rvswd: entry_index(u8) idle_clock(u8) for every entry (§2.1, §3.1)
        if (this.isRvswd && tag === REST && v.length === 2 && v[0] < page.length) page[v[0]].idleClock = rests[v[1]] ?? null;
      }
      out.push(...page);
      if (!more || !count || out.length > 0xff) return out;
    }
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
  static TAG_REST = RVSWD.tlv.attach_answer.idle_clock;
  static SCHEME_DMI_7F = reg.COMMON.enum.target_id_scheme.dmi_7f;   // the u32 at DMI 0x7F (debug §3; one scheme space, common)

  hadReset = false;
  /** the hart is halted (attach flags bit3): `dpc` says where */
  halted = false;
  /** @type {number | null} the halted hart's dpc (the answer's TLV 0x11), else null */ dpc = null;
  speedHz = 0;
  /** @type {[number, Uint8Array] | null} (scheme, value) the last attach read, or null */ targetId = null;
  /** @type {string | null} rvswd: the rest the last attach's connection uses, 'high' / 'low' (§3.1; null: not said) */
  idleClock = null;
  /** @type {Map<number, (number | null)[] | Rejected>} channel -> dpc per try (null: attach failed), or the rejection */
  lastSearch = new Map();

  /** @param {m.Tail} tail */
  takeTargetId(tail) { this.targetId = targetIdOf(tail.get(Wire.TAG_TARGET_ID)); }

  /** rvswd only, critical: a probe that cannot rest the line that way must refuse (§3)
   * @param {'high' | 'low' | null | undefined} idleClock */
  idleTlv(idleClock) {
    return idleClock == null ? new Uint8Array() : m.tlv(Wire.TAG_IDLE_CLOCK, [IDLE_CLOCK[idleClock]], true);
  }

  /** The channels an attach's reset TLV may take (describe role_channels, role reset). There is no default reset
   * line: the host names one every time (§3). */
  async resetChannels() { return (await this.description()).roles.get(Wire.ROLE_RESET) ?? []; }

  /** method 1 (halt) is offered only with features bit0 attach_halt (§3). */
  async attachHaltOffered() { return !!(((await this.description()).features ?? 0) & RVSWD.enum.features.attach_halt); }

  /** @typedef {{ halt?: boolean, maxSpeed?: number | null, pins?: [number, number] | null, idleClock?: 'high' | 'low' | null,
   *   reset?: [number, number] | null }} AttachOptions */

  /** The attach request: method, swdio, swclk, max_speed, then the TLVs (§3). @param {AttachOptions} [opts] */
  async attachBody({ halt = true, maxSpeed = null, pins = null, idleClock = null, reset = null } = {}) {
    return concat(await this.attachFixed(halt ? Wire.HALT : Wire.RUN, pins, maxSpeed), this.idleTlv(idleClock), this.resetTlv(reset));
  }

  /**
   * -> { conn, dmstatus }. A new connection every time: pins a live connection holds are refused (unavailable cause 1,
   * §1) - detach first. this.hadReset: a pending havereset was acknowledged first (a V00x's DMSTATUS halt / run bits
   * stay frozen until then); this.halted / this.dpc: the probe saw hart 0 halted and where (attach flags bit3, TLV
   * dpc); this.speedHz: the speed the probe chose; maxSpeed: the ceiling the probe must keep (null: the wire's declared
   * max_clock_hz); idleClock: 'high' / 'low', how rvswd rests SWCLK (critical; sent whenever given, high included).
   * Both are the target's, known by the host (§3). halt is method 1, offered only with features attach_halt. reset =
   * [channel, holdMs]: hold that reset line (one of resetChannels()) low for holdMs, then attach - halting as early as
   * it can with halt - the way back from firmware that turns the debug pins into GPIOs. this.targetId: [scheme, value]
   * of the target's identity when the probe could read one; this.idleClock: rvswd's rest the connection uses. The
   * answer is waited for max_op_ms as its argument time (core §4.4, debug §1).
   * @param {AttachOptions} [opts]
   */
  async attach(opts = {}) {
    const rd = new m.Reader((await this.call(Wire.ATTACH, await this.attachBody(opts), { expectMs: await this.attachMs(opts.reset) })).payload);
    const conn = rd.u32(), dmstatus = rd.u32();
    this.flags = rd.u8();
    this.speedHz = rd.u32();
    this.hadReset = !!(this.flags & ATTACH_FLAGS.havereset_acked);
    this.halted = !!(this.flags & ATTACH_FLAGS.halted);
    const tail = rd.tail();
    this.takeTargetId(tail);
    const dpc = tail.get(Wire.TAG_DPC);
    // dpc is a u32: a value of another length is broken, not used (core §2.3)
    this.dpc = this.halted && dpc && dpc.length === 4 ? getU32(dpc) : null;
    // rvswd: the rest the connection uses, the host's or the probe's choice from target_id (§3.1)
    const rest = this.isRvswd ? tail.get(Wire.TAG_REST) : undefined;
    const names = /** @type {Record<number, string>} */ (Object.fromEntries(Object.entries(IDLE_CLOCK).map(([k, v]) => [v, k])));
    this.idleClock = rest && rest.length === 1 ? names[rest[0]] ?? null : null;
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
   * this.lastSearch: what each channel gave. pins: the debug pins (a scan result's .pins; null: the wire's one
   * candidate pair); a live connection on them is closed first (attach never joins one, §1).
   * @param {number[]} candidates
   * @param {{ resetVector?: number, holdMs?: number, tries?: number, pins?: [number, number] | null }} [opts]
   */
  async findResetLine(candidates, { resetVector = 0, holdMs = 20, tries = 3, pins = null } = {}) {
    const at = await this.pinsOrOnly(pins);
    for (const c of await this.connections()) if (c.pins[0] === at[0] && c.pins[1] === at[1]) await this.detach(c.conn);
    /** @type {number[]} */
    const hits = [];
    this.lastSearch = new Map();
    for (const channel of candidates) {
      /** @type {(number | null)[] | Rejected} */
      let seen = [];
      for (let i = 0; i < tries; i++) {
        let conn, dpc;
        try {
          ({ conn, dpc } = await this.attachUnderReset(channel, { holdMs, pins: at }));
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
          if (dpc === resetVector) await dm.reset();
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
 * the probe could not halt the hart (dpc and values mean nothing); notRun: the preparation (registers, dcsr, pc) failed
 * - the hart was not run and is still halted, the loader did not run (dpc means nothing); an invalid dpc is 0, so
 * runWhere() shows it only when it means something; elapsedUs: from the resumereq that started the hart to the halt
 * seen, made or given up (the probe's measure), 0 when not run; values: the registers asked for in `outs`, in order;
 * unknownStopped: a stopped byte this client does not know, as it came (core §2.4: shown as an unknown value, never as
 * one of the four; its dpc and values are not taken as valid), else null.
 * @typedef {{ status: number, stopped: boolean, notHalted: boolean, notRun: boolean, dpc: number, elapsedUs: number,
 *   values: number[], unknownStopped: number | null }} RunResult */

/** The dpc of a run for a message, never an invalid one (debug §4.4). @param {RunResult} run */
export function runWhere(run) {
  if (run.notRun) return 'not run';
  if (run.unknownStopped !== null) return `stopped 0x${run.unknownStopped.toString(16).padStart(2, '0')} (unknown), dpc unknown`;
  return run.notHalted ? 'not halted, dpc unknown' : `dpc 0x${run.dpc.toString(16)}`;
}

/** run's `stopped`: 0 the limit passed and the probe halted it, 1 stopped on its own, 2 not halted, 3 not run. */
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
 * mandatory there; the host's count is at most it and what the route's max_frame carries (§4.5). */
export class NoMaxLength extends OepError {}

/**
 * The describe common tag max_length (core §7.4) of interface `fn`, in bytes, rounded down to a word: the function's
 * limit, whatever the route (the host's count is at most min(max_length, max_frame - 8 / - 20) / 4 on the route it
 * uses, oep-if-debug §4.5). Throws NoMaxLength when the probe does not declare it (or declares less than one word).
 * @param {import('./host.js').Host} hst @param {number} fn @param {string} name
 */
export async function declaredMaxLength(hst, fn, name) {
  const v = catalog.firstFixed(await describe(hst, fn), catalog.COMMON.max_length, 2);   // the first copy, a u16 (core §2.3)
  if (v) {
    const length = Math.floor(getU16(v) / 4) * 4;
    if (length >= 4) return length;
  }
  throw new NoMaxLength(`${name} (fn ${fn}) declares no usable max_length: read_block / write_block need it (oep-if-debug §4.5)`);
}

/** read_block's answer header 5, done 2, status 1 (§4.5). */
export const READ_BLOCK_OVERHEAD = 8;
/** write_block's request header 10, connection 4, address 4, count 2 (§4.5). */
export const WRITE_BLOCK_OVERHEAD = 20;

/** The words a block op may move on the host's route: min(maxLength, max_frame - overhead) / 4, at least 1.
 * @param {Interface & { maxLength: number | null }} iface @param {number} overhead */
export async function routeWords(iface, overhead) {
  const length = iface.maxLength ?? await declaredMaxLength(iface.host, iface.fn, iface.name);
  let frame = null;
  try { frame = (await iface.host.confirmed()).maxFrame; } catch { /* no route to tell */ }
  return Math.max(1, Math.floor((frame === null ? length : Math.min(length, frame - overhead)) / 4));
}

/**
 * `maxLength` (bytes one read_block / write_block may move, from the probe's describe) and `maxWords` on an interface
 * with block operations (RiscvDm, ArmAdi): read once, on first need; maxWords is the smaller of read_block's and
 * write_block's counts on the route (§4.5). Throws NoMaxLength when the probe declares none.
 * @param {Interface & { maxLength: number | null, maxWords: number | null }} iface @returns {Promise<number>} maxWords
 */
export async function blockWords(iface) {
  if (iface.maxWords === null || iface.maxLength === null) {
    iface.maxLength = await declaredMaxLength(iface.host, iface.fn, iface.name);
    iface.maxWords = Math.min(await routeWords(iface, READ_BLOCK_OVERHEAD), await routeWords(iface, WRITE_BLOCK_OVERHEAD));
  }
  return iface.maxWords;
}

/** oep.target.riscv-dm on one connection (every request starts with the connection, u32). Build with
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
  static RESET_HALT = RV.enum.reset_mode.halt_at_reset;
  static TAG_STEP_LEFT = RV.tlv.step_answer.step_left;
  static DPC = 0x07B1;
  /** The optional ops (debug §4), by name: halt, resume, block (read_block / write_block, a pair), run, reset, step. */
  static OPTIONAL = Object.freeze({ halt: [RV.op.halt], resume: [RV.op.resume], block: [RV.op.read_block, RV.op.write_block],
    run: [RV.op.run], reset: [RV.op.reset], step: [RV.op.step] });

  /** @type {number | null} bytes one block operation may move (describe max_length: the function's limit) */
  maxLength = null;
  /** @type {number | null} words (u32) one block operation either way may move on the route (§4.5) */
  maxWords = null;
  /** @type {number | null} DATA0 as it was before this host's own abstract commands changed it (null: unchanged) */
  dataSaved = null;

  /** @param {import('./host.js').Host} hst @param {number} conn @param {{ fn?: number, name?: string }} [opts] */
  static async on(hst, conn, { fn, name } = {}) {
    const dm = /** @type {RiscvDm} */ (await RiscvDm.open(hst, { fn, name, prefix: new Writer().u32(conn).done() }));
    await dm.blockWords().catch((e) => { if (!(e instanceof NoMaxLength)) throw e; });   // undeclared: null until a block op needs it
    return dm;
  }

  get conn() { return getU32(this.prefix); }

  /** The words one read_block / write_block may move, from the probe's declared max_length (NoMaxLength when none). */
  blockWords() { return blockWords(this); }

  /** The optional ops this probe offers, from its describe's ops tag (debug §4, core §1.2, §7.4): 'halt', 'resume',
   * 'block' (read_block / write_block, offered as a pair), 'run', 'reset', 'step'. Only dmi is always there (debug §4:
   * halt and resume are optional too); an op not offered is answered unknown_operation, and the host builds the same thing from dmi. A describe without an ops tag (not a
   * conforming probe) declares none. @returns {Promise<Set<string>>} */
  async declared() {
    const offered = (await this.ops()) ?? new Set();
    return new Set(Object.entries(RiscvDm.OPTIONAL).filter(([, ops]) => ops.every((op) => offered.has(op))).map(([name]) => name));
  }

  /** reset's argument time (core §4.4): max_op_ms (debug §4.3). */
  async resetMs() {
    try { return await maxOpMs(this.host); } catch { return FALLBACK_MAX_OP_MS; }
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
   * CH32 rule) are the host's (§4.2). DATA0 is written back first (`restoreData`). */
  async resume() {
    await this.restoreData();
    return this.statusOnly('resume', RiscvDm.RESUME);
  }

  /** Write DATA0 back as it was before this host's own abstract commands changed it (debug §4: before the hart runs;
   * readRegister leaves it changed). Nothing when none ran since the hart last ran; resume, step, run and reset call it
   * first. */
  async restoreData() {
    if (this.dataSaved === null) return;
    await this.dmi([RiscvDm.stepWrite(0x04, this.dataSaved)]);
    this.dataSaved = null;
  }

  /** A GPR / CSR of the halted hart through an abstract command (access register, 32 bits) in plain DMI steps, so any
   * probe with dmi does it. A cmderr is cleared, then thrown. DATA0 is left holding the value; its value from before
   * (the console's mailbox, console §3) is read first and kept (`dataSaved`) to be written back before the hart runs
   * (`restoreData`, debug §4).
   * @param {number} regno */
  async readRegister(regno) {
    const save = this.dataSaved === null;
    const { values } = await this.dmi([...(save ? [RiscvDm.stepRead(0x04)] : []),
      RiscvDm.stepWrite(0x17, (0x00220000 | regno) >>> 0), RiscvDm.stepPoll(0x16, 1 << 12, 0, 100), RiscvDm.stepRead(0x04)]);
    if (save) this.dataSaved = /** @type {number} */ (values.shift());
    const cs = values[0], data0 = values[1];
    if ((cs >> 8) & 7) {
      await this.dmi([RiscvDm.stepWrite(0x16, 0x700)]);
      throw new Error(`abstract command for register 0x${regno.toString(16)} failed (cmderr ${(cs >> 8) & 7})`);
    }
    return data0;
  }

  /** reset's answer: status flags(bit0 reached) pc (§4.3); its argument time is max_op_ms - the probe
   * answers within it, a DM silent after the release included (core §4.4). @param {number} mode */
  async resetMode(mode) {
    const r = await this.request(RiscvDm.RESET, new Writer().u8(mode).done(), { expectMs: await this.resetMs() });
    const rd = ran(r);
    const status = rd.u8(), flags = rd.u8(), pc = rd.u32();
    rd.tail();
    check('reset', r, status);
    return { flags, pc };
  }

  /** Reset through ndmreset and let it run (success: the probe saw it running, flags bit0). The reset op never drives a
   * reset line (debug §4.3): a line moves only through attach's reset TLV (`Wire.attachUnderReset`) or a fixture. The
   * hart runs after it, so DATA0 this host's abstract commands changed is written back first (`restoreData`, debug §4).
   * -> { flags, pc } */
  async reset() {
    await this.restoreData();
    return this.resetMode(RiscvDm.RESET_RUN);
  }

  /** Reset and stop before the first instruction (haltreq held through the reset). -> dpc */
  async resetHalt() { return (await this.resetMode(RiscvDm.RESET_HALT)).pc; }

  /** One instruction (dcsr.step, one resume, privilege kept). -> { moved, before, after } (dpc before / after, §4.2). A
   * hart that did not come back, and any status but ok, throws StepError (§4.2, P2-○4) without moved or the dpcs (0
   * unless status ok, not read): `stepLeft` false - the probe halted it with haltreq and restored it (read its dpc with
   * dmi); true (answer TLV step_left) - it could not halt it again: the hart runs and
   * dcsr.step may still be set, so the host halts it and clears dcsr.step. DATA0 is written back first (`restoreData`). */
  async step() {
    await this.restoreData();
    const r = await this.request(RiscvDm.STEP);
    const rd = ran(r);
    const status = rd.u8(), moved = rd.u8() !== 0, before = rd.u32(), after = rd.u32();
    const tail = rd.tail();
    if (status !== OK || !r.succeeded) {
      const left = tail.get(RiscvDm.TAG_STEP_LEFT);                  // length 0; any other is broken, not used (core §2.3)
      throw new StepError(status, r, left !== undefined && !left.length);   // §4.2
    }
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
    return { status, stopped: stopped === RUN_STOPPED.stopped, notHalted: stopped === RUN_STOPPED.not_halted,
      notRun: stopped === RUN_STOPPED.not_run, dpc, elapsedUs, values,
      unknownStopped: Object.values(RUN_STOPPED).includes(stopped) ? null : stopped };
  }

  /** Set registers and dpc (dcsr.ebreakm, prv = M), resume, wait for the hart's own ebreak (forced halt at the
   * timeout: stopped false, status timeout - returned, not thrown; notHalted when the probe could not even stop it).
   * timeoutMs null: the probe's max_op_ms (core §7.5), the most it allows. Other statuses throw TargetError (§4.4) - a
   * preparation that failed (stopped 3) too: the hart was not run, it is still halted, and the error's `result` says so
   * (`RiscvDm.runResult(e.result).notRun`). DATA0 is written back first (`restoreData`).
   * @param {number} pc @param {[number, number][]} regs @param {{ timeoutMs?: number | null, outs?: number[] }} [opts] */
  async run(pc, regs, { timeoutMs = 200, outs = [REG_A0] } = {}) {
    const limit = timeoutMs ?? await maxOpMs(this.host);
    await this.restoreData();
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
 * pins: the debug pins (null: the wire's one candidate pair).
 * @param {import('./host.js').Host} hst @param {Wire} wire @param {number} gpioFn @param {number} channel
 * @param {{ tries?: number, lowMs?: number, pins?: [number, number] | null }} [opts]
 */
export async function attachAfterGpioReset(hst, wire, gpioFn, channel, { tries = 10, lowMs = 20, pins = null } = {}) {
  if (tries < 1) throw new RangeError('tries must be at least 1');
  /** @type {m.Result | null} */
  let last = null;
  const attachReq = wire.req(Wire.ATTACH, await wire.attachBody({ halt: true, pins }));   // built once: its describe is not in the race
  const expectMs = await wire.attachMs();             // max_op_ms is the attach's argument time (core §4.4)
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
      const conn = rd.u32(), dmstatus = rd.u32();
      return { conn, dmstatus };
    }
  }
  throw new Failed(last);
}
