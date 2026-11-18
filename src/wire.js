// @ts-check
// A debug wire's connection check (oep-spec oep-if-debug §1-§3, §5): oep.wire.rvswd, oep.wire.swio or oep.wire.swd
// attached on the pins a wiring names, what answered read (DMSTATUS on the RISC-V wires, DPIDR on SWD), and detached.
// Debugging itself - the debug module, the ADI, memory, run control - is a debugger's (oep-client-python, an IDE).
//
// attach is method 0 (run): the target is not stopped. Its answer is the same on every wire: conn(u32) id(u32)
// flags(u8) speed_hz(u32) [TLV]. A failed attach is completed failed with `status(u8) [TLV]` (common §3): Failed. The
// answer is waited for max_op_ms as its argument time (core §4.4, debug §1).

import * as reg from './registry.js';
import { Writer, concat, getU32 } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { FALLBACK_MAX_OP_MS, Interface, describe, maxOpMs } from './core.js';

const WOP = reg.WIRE_RVSWD.op;   // attach / detach: the same numbers on every wire
const RUN = reg.WIRE_RVSWD.enum.attach_method.run;
const TARGETSEL = reg.WIRE_SWD.tlv.attach.targetsel;
const RESET = reg.WIRE_RVSWD.tlv.attach.reset;

/** The debug wires (core §7.2 names). */
export const WIRES = Object.freeze({ rvswd: 'oep.wire.rvswd', swio: 'oep.wire.swio', swd: 'oep.wire.swd' });

/** When the wire declares no max_clock_hz. */
export const DEFAULT_MAX_SPEED = 1_000_000;

/** One attach's answer: `conn`, `id` (DMSTATUS on rvswd / swio, DPIDR on swd), `flags` (attach_flags), `speedHz`.
 * @typedef {{ conn: number, id: number, flags: number, speedHz: number }} Attached */

/** oep.wire.rvswd / swio / swd: attach and detach only. `Wire.open(hst, { name })` picks the wire. */
export class Wire extends Interface {
  static NAME = WIRES.rvswd;
  static REVISION = 1;
  static ATTACH = WOP.attach;
  static DETACH = WOP.detach;

  /** swio: one wire, swclk 0xFFFF (§3). */
  get oneWire() { return this.name === WIRES.swio; }

  /** swd: the id is DPIDR. */
  get swd() { return this.name === WIRES.swd; }

  /** attach's max_speed: the wire's declared max_clock_hz (its describe), else DEFAULT_MAX_SPEED. */
  async defaultSpeed() {
    // the first copy, a u32 exactly; bit 7 in an answer is an unknown tag (core §2.2, §2.3)
    const v = catalog.firstFixed(await describe(this.host, this.fn), catalog.COMMON.max_clock_hz, 4);
    return v ? getU32(v) : DEFAULT_MAX_SPEED;
  }

  /**
   * A new connection on `pins` [swdio, swclk] (swio: swclk ignored, 0xFFFF sent). maxSpeed: the ceiling (null: the
   * wire's declared one). reset = [channel, holdMs]: hold that reset line low first (critical). targetsel: swd's
   * multidrop target (critical). Pins a live connection holds are refused (unavailable): detach first.
   * @param {{ pins: [number, number], maxSpeed?: number | null, reset?: [number, number] | null, targetsel?: number | null }} opts
   * @returns {Promise<Attached>}
   */
  async attach({ pins, maxSpeed = null, reset = null, targetsel = null }) {
    const clk = this.oneWire ? 0xffff : pins[1];
    let body = new Writer().u8(RUN).u16(pins[0]).u16(clk).u32(maxSpeed ?? await this.defaultSpeed()).done();
    if (reset) body = concat(body, m.tlv(RESET, new Writer().u16(reset[0]).u16(reset[1]).done(), true));
    if (targetsel != null) {
      if (!this.swd) throw new RangeError(`${this.name}: targetsel is swd's`);
      body = concat(body, m.tlv(TARGETSEL, new Writer().u32(targetsel).done(), true));
    }
    let expectMs;
    try { expectMs = await maxOpMs(this.host); } catch { expectMs = FALLBACK_MAX_OP_MS; }
    const rd = new m.Reader((await this.call(Wire.ATTACH, body, { expectMs })).payload);
    const conn = rd.u32(), id = rd.u32(), flags = rd.u8(), speedHz = rd.u32();
    rd.tail();
    return { conn, id, flags, speedHz };
  }

  /** Close the connection (§2). @param {number} conn */
  async detach(conn) { await this.call(Wire.DETACH, new Writer().u32(conn).done()); }

  /**
   * The connection check: attach, read what answered, detach. -> the id (DMSTATUS / DPIDR) and `rp2040Core0` when a
   * plain swd attach got no answer and RP2040's multidrop core 0 (TARGETSEL 0x01002927) did.
   * @param {{ pins: [number, number], maxSpeed?: number | null, reset?: [number, number] | null }} opts
   */
  async check(opts) {
    /** @param {number | null} targetsel */
    const once = async (targetsel) => {
      const a = await this.attach({ ...opts, targetsel });
      await this.detach(a.conn).catch(() => {});
      return a.id;
    };
    try {
      return { id: await once(null), rp2040Core0: false };
    } catch (first) {
      if (!this.swd) throw first;
      try { return { id: await once(RP2040_CORE0), rp2040Core0: true }; } catch { throw first; }
    }
  }
}

/** RP2040's multidrop SWD: core 0 (TARGETSEL, ADIv5.2). */
export const RP2040_CORE0 = 0x01002927;
