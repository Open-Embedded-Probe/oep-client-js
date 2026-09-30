// @ts-check
// oep.wire.swd and oep.target.arm-adi, revision 1 (oep-spec oep-if-debug §1, §5-§6).
//
// The probe moves raw DP / AP transfers and MEM-AP blocks; everything above - power-up, SELECT (ADIv5
// APSEL/APBANKSEL or ADIv6 AP addresses), CSW, the Cortex-M debug registers - is here, as target knowledge belongs to
// the host.

import * as reg from './registry.js';
import { Writer, concat, getU16 } from './bytes.js';
import * as m from './message.js';
import { OepError, Timeout } from './errors.js';
import { Interface } from './core.js';
import { OK, TargetError, WireBase, ran } from './riscv.js';

export { OK, TargetError, WireBase, check, ran, statusName } from './riscv.js';

export const DP_DPIDR = 0x0, DP_ABORT = 0x0;
export const DP_CTRL_STAT = 0x4;
export const DP_SELECT = 0x8;
export const DP_RDBUFF = 0xC;
const ADI = reg.TARGET_ARM_ADI;
const SWD = reg.WIRE_SWD;

/** @param {number} v */
const hex32 = (v) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** oep.wire.swd (§5). */
export class SwdWire extends WireBase {
  static NAME = 'oep.wire.swd';
  static TAG_TARGETSEL = SWD.tlv.attach.targetsel;

  speedHz = 0;
  existing = false;

  /**
   * -> { conn, dpidr, dormant: woke from dormant }. targetsel (multidrop) and maxSpeed go as critical TLVs: a probe that
   * cannot honour them refuses. this.existing: the wire was attached already (its connection returned).
   * @param {{ targetsel?: number | null, maxSpeed?: number | null, pins?: [number, number] | null }} [opts]
   */
  async attach({ targetsel = null, maxSpeed = null, pins = null } = {}) {
    let body = concat(this.speedTlv(maxSpeed), this.pinsTlv(pins));
    if (targetsel != null) body = concat(body, m.tlv(SwdWire.TAG_TARGETSEL, new Writer().u32(targetsel).done(), true));
    const rd = new m.Reader((await this.call(SwdWire.ATTACH, body)).payload);
    const conn = rd.u16(), dpidr = rd.u32(), flags = rd.u8();
    this.speedHz = rd.u32();
    this.existing = !!(flags & 2);
    rd.tail();
    return { conn, dpidr, dormant: !!(flags & 1) };
  }
}

export class AdiError extends TargetError {}

/** Per transfer in a packed list: true for a read (1 byte), false for a write (1 + 4 bytes) (§6).
 * @param {Uint8Array} steps */
export function transferReads(steps) {
  /** @type {boolean[]} */
  const out = [];
  let at = 0;
  while (at < steps.length) {
    const read = !!(steps[at] & 2);
    out.push(read);
    at += read ? 1 : 5;
  }
  if (at !== steps.length) throw new RangeError('the transfer list ends inside a write');
  return out;
}

/** oep.target.arm-adi on one connection (§6). Build with `await ArmAdi.on(host, conn, { adiv6 })`. */
export class ArmAdi extends Interface {
  static NAME = 'oep.target.arm-adi';
  static REVISION = 1;
  static TRANSFER = ADI.op.transfer;
  static READ_BLOCK = ADI.op.read_block;
  static WRITE_BLOCK = ADI.op.write_block;

  adiv6 = false;
  /** @type {number | null} the SELECT value last written (null: unknown) */ selected = null;
  /** the raw ACK of the last transfer */ lastAck = 0;

  /** @param {import('./host.js').Host} hst @param {number} conn
   * @param {{ adiv6?: boolean, fn?: number, name?: string }} [opts] */
  static async on(hst, conn, { adiv6 = false, fn, name } = {}) {
    const adi = /** @type {ArmAdi} */ (await ArmAdi.open(hst, { fn, name, prefix: new Writer().u16(conn).done() }));
    adi.adiv6 = adiv6;
    return adi;
  }

  get conn() { return getU16(this.prefix); }

  // ---- raw transfers ----

  /** One transfer: req(u8: bit0 APnDP, bit1 RnW, bit2-3 A[3:2]) and, for a write, value(u32).
   * @param {boolean} ap @param {boolean} read @param {number} addr @param {number} value */
  static req(ap, read, addr, value = 0) {
    const w = new Writer().u8((ap ? 1 : 0) | (read ? 2 : 0) | (((addr >> 2) & 3) << 2));
    return read ? w.done() : w.u32(value).done();
  }

  /** A packed transfer list (ArmAdi.req concatenated). -> the values read, in order (an AP read's value arrives one
   * transfer late, as on the wire). A list that stopped throws AdiError (status, done, the values it read; and
   * this.lastAck = the raw ACK of the last transfer).
   * @param {Uint8Array} steps */
  async transfer(steps) {
    const reads = transferReads(steps);
    const r = await this.request(ArmAdi.TRANSFER, concat(new Writer().u16(reads.length).done(), steps));
    const rd = ran(r);
    const done = rd.u16(), status = rd.u8();
    this.lastAck = rd.u8();
    const values = rd.words(reads.slice(0, done).filter(Boolean).length);
    rd.tail();
    if (status !== OK || !r.succeeded || done !== reads.length) {
      throw new AdiError(`transfer (ack 0x${this.lastAck.toString(16)})`, status, r, { done, values });
    }
    return values;
  }

  /** @param {number} addr */
  async dpRead(addr) { return (await this.transfer(ArmAdi.req(false, true, addr)))[0]; }

  /** @param {number} addr @param {number} value */
  async dpWrite(addr, value) { await this.transfer(ArmAdi.req(false, false, addr, value)); }

  /** DP SELECT, written only when it changes. @param {number} value */
  async select(value) {
    const v = value >>> 0;
    if (v !== this.selected) {
      await this.dpWrite(DP_SELECT, v);
      this.selected = v;
    }
  }

  /** ADIv5: ap = APSEL (0..255), reg = register offset in the AP. ADIv6: ap = the AP's base address.
   * @param {number} ap @param {number} reg */
  apSelect(ap, reg) {
    return this.select(this.adiv6 ? (ap + reg) & ~0xF : (ap << 24) | (reg & 0xF0));
  }

  /** @param {number} ap @param {number} reg */
  async apRead(ap, reg) {
    await this.apSelect(ap, reg);
    return (await this.transfer(concat(ArmAdi.req(true, true, reg), ArmAdi.req(false, true, DP_RDBUFF))))[1];   // posted
  }

  /** @param {number} ap @param {number} reg @param {number} value */
  async apWrite(ap, reg, value) {
    await this.apSelect(ap, reg);
    await this.transfer(ArmAdi.req(true, false, reg, value));
  }

  /** Clear sticky errors, request debug + system power, wait for both acks. -> CTRL/STAT */
  async powerUp() {
    await this.dpWrite(DP_ABORT, 0x1E);
    this.selected = null;
    await this.select(0);
    await this.dpWrite(DP_CTRL_STAT, 0x50000000);
    let cs = 0;
    for (let i = 0; i < 100; i++) {
      cs = await this.dpRead(DP_CTRL_STAT);
      if ((cs >>> 29) & 1 && (cs >>> 31) & 1) return cs;
    }
    throw new OepError(`no power-up ack: CTRL/STAT ${hex32(cs)}`);
  }
}

/** One MEM-AP (ADIv5 APSEL or ADIv6 base address) with 32-bit, auto-incrementing access. Build with
 * `await MemAp.open(adi, ap, { cswClear })`. */
export class MemAp {
  /** @param {ArmAdi} adi @param {number} ap @param {number} chunk words per block operation */
  constructor(adi, ap, chunk) {
    this.adi = adi; this.ap = ap; this.chunk = chunk;
    this.base = adi.adiv6 ? 0xD00 : 0x00;   // CSW, TAR, DRW at base + 0x0 / 0x4 / 0xC
  }

  /**
   * Set CSW to 32 bits, AddrInc single. cswSet / cswClear: target-specific CSW bits (protection, security). The
   * RP2350's AHB-APs come up non-secure (CSW bit 30), and its SRAM then faults: pass cswClear: 1 << 30 there
   * (2026-09-24).
   * @param {ArmAdi} adi @param {number} ap @param {{ cswSet?: number, cswClear?: number }} [opts]
   */
  static async open(adi, ap, { cswSet = 0, cswClear = 0 } = {}) {
    // Words per block operation, from the probe's frame limit: request header 6 + session 4 + connection 2 +
    // address 4 + count 2 on the way in (the answer's 5 + done 2 + status 1 is smaller).
    const chunk = Math.max(1, Math.floor(((await adi.host.confirmed()).maxFrame - 18) / 4));
    const mem = new MemAp(adi, ap, chunk);
    const csw = await adi.apRead(ap, mem.base);
    await adi.apWrite(ap, mem.base, ((((csw & ~0x37) | 0x12) | cswSet) & ~cswClear) >>> 0);
    await adi.apSelect(ap, mem.base);   // the bank the block operations assume
    return mem;
  }

  /** Scattered single-word writes in one transfer list (TAR, DRW per word, RDBUFF at the end so the last one has
   * landed): one round trip instead of one per word - what a debug-register sequence needs.
   * @param {[number, number][]} pairs */
  async writeMany(pairs) {
    await this.adi.apSelect(this.ap, this.base);
    const steps = pairs.flatMap(([a, v]) => [ArmAdi.req(true, false, this.base + 0x4, a), ArmAdi.req(true, false, this.base + 0xC, v)]);
    await this.adi.transfer(concat(...steps, ArmAdi.req(false, true, DP_RDBUFF)));
  }

  /** @param {number} address @param {number} words */
  async readBlock(address, words) {
    /** @type {number[]} */
    const out = [];
    for (let off = 0; off < words; off += this.chunk) {
      await this.adi.apSelect(this.ap, this.base);
      const n = Math.min(this.chunk, words - off);
      const r = await this.adi.request(ArmAdi.READ_BLOCK, new Writer().u32(address + off * 4).u16(n).done());
      const rd = ran(r);
      const done = rd.u16(), status = rd.u8();
      const got = rd.words(done);
      rd.tail();
      if (status !== OK || !r.succeeded || done !== n) {
        throw new AdiError('read_block', status, r, { done: off + done, values: [...out, ...got] });
      }
      out.push(...got);
    }
    return out;
  }

  /** @param {number} address @param {number[]} values */
  async writeBlock(address, values) {
    for (let off = 0; off < values.length; off += this.chunk) {
      await this.adi.apSelect(this.ap, this.base);
      const part = values.slice(off, off + this.chunk);
      const w = new Writer().u32(address + off * 4).u16(part.length);
      for (const v of part) w.u32(v);
      const r = await this.adi.request(ArmAdi.WRITE_BLOCK, w.done());
      const rd = ran(r);
      const done = rd.u16(), status = rd.u8();
      rd.tail();
      if (status !== OK || !r.succeeded) throw new AdiError('write_block', status, r, { done: off + done });
    }
  }

  /** @param {number} address */
  async read32(address) { return (await this.readBlock(address, 1))[0]; }

  /** @param {number} address @param {number} value */
  write32(address, value) { return this.writeBlock(address, [value]); }
}

/** What CortexM needs of a MemAp (a test can stand in for one).
 * @typedef {{ read32(a: number): Promise<number>, write32(a: number, v: number): Promise<void>,
 *   writeMany(pairs: [number, number][]): Promise<void> }} MemPort */

/**
 * Armv7-M / Armv8-M core debug through a MEM-AP: halt, resume, core registers through DCRSR / DCRDR, and running a
 * function on the target (arguments in r0-r3, LR at a BKPT in RAM, run until the core halts on it) - the way a
 * host-side flash algorithm drives the target's own ROM or a RAM loader.
 */
export class CortexM {
  static DHCSR = 0xE000EDF0; static DCRSR = 0xE000EDF4; static DCRDR = 0xE000EDF8; static AIRCR = 0xE000ED0C;
  static KEY = 0xA05F0000;
  static C_DEBUGEN = 1; static C_HALT = 2; static C_MASKINTS = 8;
  static S_REGRDY = 1 << 16; static S_HALT = 1 << 17;
  static SP = 13; static LR = 14; static PC = 15; static XPSR = 16;

  /** bkptAt: a word of RAM the target does not need (the return breakpoint goes there); stackTop: where the called
   * function's stack starts (its RAM below is clobbered).
   * @param {MemPort} mem @param {number} bkptAt @param {number} stackTop */
  constructor(mem, bkptAt, stackTop) { this.mem = mem; this.bkptAt = bkptAt; this.stackTop = stackTop; }

  /** @param {number} bits DHCSR with the key */
  dhcsr(bits) { return this.mem.write32(CortexM.DHCSR, (CortexM.KEY | bits) >>> 0); }

  /** @param {number} mask @param {number} timeoutMs */
  async wait(mask, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.mem.read32(CortexM.DHCSR);
      if (v & mask) return v;
      if (Date.now() > deadline) throw new Timeout(`DHCSR ${hex32(v)}: waiting for 0x${mask.toString(16)}`);
    }
  }

  async halted() { return !!((await this.mem.read32(CortexM.DHCSR)) & CortexM.S_HALT); }

  async halt() {
    await this.dhcsr(CortexM.C_DEBUGEN | CortexM.C_HALT);
    await this.wait(CortexM.S_HALT, 1000);
  }

  /** @param {{ maskInts?: boolean }} [opts] */
  resume({ maskInts = false } = {}) { return this.dhcsr(CortexM.C_DEBUGEN | (maskInts ? CortexM.C_MASKINTS : 0)); }

  /** Run, debug off. C_MASKINTS is cleared first: it lives in the debug domain and survives every reset but power-on,
   * and firmware left with it set runs without SysTick / USB interrupts (RP2350, 2026-09-24). */
  async release() {
    await this.dhcsr(CortexM.C_DEBUGEN | CortexM.C_HALT);
    await this.dhcsr(0);
  }

  /** @param {number} n */
  async reg(n) {
    await this.mem.write32(CortexM.DCRSR, n);
    await this.wait(CortexM.S_REGRDY, 1000);
    return this.mem.read32(CortexM.DCRDR);
  }

  /** @param {number} n @param {number} value */
  async setReg(n, value) {
    await this.mem.write32(CortexM.DCRDR, value);
    await this.mem.write32(CortexM.DCRSR, (1 << 16) | n);
    await this.wait(CortexM.S_REGRDY, 1000);
  }

  /** Registers for fn(args...): r0-r3, SP, LR to the breakpoint, PC, Thumb bit, no active exception. The writes go out
   * as one transfer list; a register write takes the core a few cycles and each SWD transfer takes microseconds, so
   * S_REGRDY is checked once at the end rather than after each.
   * @param {number} fn @param {number[]} args */
  async prepareCall(fn, args = []) {
    const xpsr = (((await this.reg(CortexM.XPSR)) | (1 << 24)) & ~0x1FF) >>> 0;
    /** @type {[number, number][]} */
    const regs = [...args.map((v, i) => /** @type {[number, number]} */ ([i, v])), [CortexM.SP, this.stackTop],
      [CortexM.LR, (this.bkptAt | 1) >>> 0], [CortexM.PC, (fn & ~1) >>> 0], [CortexM.XPSR, xpsr]];
    /** @type {[number, number][]} */
    const pairs = [[this.bkptAt, 0xBE00BE00]];   // bkpt #0, twice
    for (const [n, value] of regs) pairs.push([CortexM.DCRDR, value], [CortexM.DCRSR, (1 << 16) | n]);
    await this.mem.writeMany(pairs);
    await this.wait(CortexM.S_REGRDY, 1000);
  }

  /** Run fn(args...) on the halted core with interrupts masked (their handlers may live in flash that the call makes
   * unreadable), wait for the breakpoint, clear the mask, return r0.
   * @param {number} fn @param {number[]} args @param {{ timeoutMs?: number }} [opts] */
  async call(fn, args = [], { timeoutMs = 10000 } = {}) {
    await this.prepareCall(fn, args);
    await this.resume({ maskInts: true });
    await this.wait(CortexM.S_HALT, timeoutMs);
    await this.dhcsr(CortexM.C_DEBUGEN | CortexM.C_HALT);   // MASKINTS off while halted
    const pc = await this.reg(CortexM.PC);
    if (((pc & ~3) >>> 0) !== this.bkptAt) throw new OepError(`stopped at ${hex32(pc)}, not at the return breakpoint`);
    return this.reg(0);
  }

  /** AIRCR.SYSRESETREQ: the core restarts; debug-domain state (DHCSR) survives, so clear the mask first. */
  async sysReset() {
    await this.dhcsr(CortexM.C_DEBUGEN | CortexM.C_HALT);
    await this.mem.write32(CortexM.AIRCR, 0x05FA0004);
  }
}
