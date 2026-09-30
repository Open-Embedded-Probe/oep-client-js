// @ts-check
// oep.wire.swd and oep.target.arm-adi on a scripted host (the fake probe has no SWD), as oep-client-python's
// tests/test_target_parts.py: a tiny ADIv6 DP + one MEM-AP, and a Cortex-M debug core behind a MemAp stand-in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, getU16, getU32 } from '../src/bytes.js';
import * as m from '../src/message.js';
import { AdiError, ArmAdi, CortexM, MemAp, SwdWire, transferReads } from '../src/arm.js';
import { ScriptedHost, handlers, ok } from './scripted.js';

const w = () => new Writer();

/** A tiny ADIv6 DP + one MEM-AP at 0x2000 behind the probe's transfer / block operations. */
class FakeAdi {
  select = 0; csw = 0x43800052; posted = 0;
  /** @type {number[]} */ selects = [];
  /** @type {Map<number, number>} */ mem = new Map();

  /** @param {Uint8Array} p @returns {[number, number, Uint8Array]} */
  transfer(p) {
    const n = getU16(p, 2);
    const out = w();
    let at = 4, done = 0;
    while (at < p.length) {
      const req = p[at++];
      const ap = req & 1, read = (req >> 1) & 1, a = ((req >> 2) & 3) << 2;
      let value = 0;
      if (!read) { value = getU32(p, at); at += 4; }
      if (!ap && !read && a === 0x8) { this.select = value; this.selects.push(value); }
      else if (!ap && read && a === 0xC) out.u32(this.posted);
      else if (!ap && read && a === 0x4) out.u32(0xF0000000);
      else if (ap) {
        const addr = (this.select & ~0xF) | a;
        if (addr === 0x2D00) {
          if (read) { out.u32(this.posted); this.posted = this.csw; } else this.csw = value;
        } else if (addr === 0xE000) {
          return [m.COMPLETED, m.FAILED, Uint8Array.from([...w().u16(done).u8(3).u8(4).done(), ...out.done()])];   // fault, ACK FAULT
        }
      }
      done++;
    }
    assert.equal(done, n);
    return ok([...w().u16(done).u8(0).u8(1).done(), ...out.done()]);
  }

  /** @param {Uint8Array} p @returns {[number, number, Uint8Array]} */
  readBlock(p) {
    const address = getU32(p, 2), count = getU16(p, 6);
    assert.equal(this.select, 0x2D00);                                   // TAR / DRW bank selected
    const out = w().u16(count).u8(0);
    for (let i = 0; i < count; i++) out.u32(this.mem.get(address + 4 * i) ?? address + 4 * i);
    return ok(out.done());
  }

  /** @param {Uint8Array} p @returns {[number, number, Uint8Array]} */
  writeBlock(p) {
    const address = getU32(p, 2), count = getU16(p, 6);
    assert.equal(p.length, 8 + 4 * count);
    for (let i = 0; i < count; i++) this.mem.set(address + 4 * i, getU32(p, 8 + 4 * i));
    return ok(w().u16(count).u8(0).done());
  }
}

function bench() {
  const fake = new FakeAdi();
  const hst = new ScriptedHost(handlers([
    [5, ArmAdi.TRANSFER, (p) => fake.transfer(p)], [5, ArmAdi.READ_BLOCK, (p) => fake.readBlock(p)],
    [5, ArmAdi.WRITE_BLOCK, (p) => fake.writeBlock(p)],
    [4, SwdWire.ATTACH, () => ok(w().u16(1).u32(0x4c013477).u8(1).u32(2_000_000).done())],
  ]));
  return { fake, hst };
}

test('swd attach decodes DPIDR and dormant; targetsel and max_speed go critical', async () => {
  const { hst } = bench();
  const wire = await SwdWire.open(hst);
  assert.deepEqual(await wire.attach(), { conn: 1, dpidr: 0x4c013477, dormant: true });
  await wire.attach({ targetsel: 0x01002927, maxSpeed: 1_000_000 });
  assert.deepEqual([...hst.log[hst.log.length - 1][2]],
    [0x81, 4, ...w().u32(1_000_000).done(), 0x82, 4, ...w().u32(0x01002927).done()]);
  assert.equal(wire.speedHz, 2_000_000);
  assert.ok(!wire.existing);
});

test('ap read uses the ADIv6 SELECT and the posted value; SELECT is cached', async () => {
  const { fake, hst } = bench();
  const adi = await ArmAdi.on(hst, 1, { adiv6: true });
  assert.equal(adi.conn, 1);
  assert.equal(await adi.apRead(0x2000, 0xD00), 0x43800052);
  assert.deepEqual(fake.selects, [0x2D00]);
  await adi.apRead(0x2000, 0xD00);
  assert.deepEqual(fake.selects, [0x2D00]);                               // cached: no second SELECT write
  assert.deepEqual(transferReads(Uint8Array.from([...ArmAdi.req(true, true, 0), ...ArmAdi.req(false, false, 8, 1)])), [true, false]);
  assert.throws(() => transferReads(Uint8Array.of(0, 1)), RangeError);
});

test('power-up clears sticky errors and waits for both acks', async () => {
  const { hst } = bench();
  const adi = await ArmAdi.on(hst, 1);
  assert.equal(await adi.powerUp(), 0xF0000000);
});

test('the MEM-AP sets CSW from the caller and chunks blocks by the frame limit', async () => {
  const { fake, hst } = bench();
  const adi = await ArmAdi.on(hst, 1, { adiv6: true });
  const mem = await MemAp.open(adi, 0x2000, { cswClear: 1 << 30 });
  assert.equal(fake.csw, ((((0x43800052 & ~0x37) | 0x12)) & ~(1 << 30)) >>> 0);
  const words = await mem.readBlock(0x1000, 500);
  assert.deepEqual(words, Array.from({ length: 500 }, (_, i) => 0x1000 + 4 * i));
  const blocks = hst.log.filter(([, op]) => op === ArmAdi.READ_BLOCK).map(([, , p]) => getU16(p, 6));
  assert.deepEqual(blocks, [251, 249]);                                   // (1024 - 18) / 4 words per block
  const values = Array.from({ length: 16 }, (_, i) => i);
  await mem.writeBlock(0x2007F3F0, values);
  assert.deepEqual(await mem.readBlock(0x2007F3F0, 16), values);
  await mem.write32(0x20000000, 0xdeadbeef);
  assert.equal(await mem.read32(0x20000000), 0xdeadbeef);
  await mem.writeMany([[0x20000004, 7]]);
  const last = hst.log[hst.log.length - 1][2];
  assert.equal(getU16(last, 2), 3);                                       // TAR, DRW, RDBUFF
});

test('a transfer fault throws with the step count and the ACK', async () => {
  const { hst } = bench();
  const adi = await ArmAdi.on(hst, 1, { adiv6: true });
  await adi.select(0xE000);
  const e = await adi.transfer(ArmAdi.req(true, true, 0x0)).catch((x) => x);
  assert.ok(e instanceof AdiError);
  assert.match(e.message, /ack 0x4\) stopped after 0: fault \(failed\)/);
  assert.equal(e.status, 3);
  assert.equal(e.done, 0);
  assert.equal(adi.lastAck, 4);
});

/** A MemAp stand-in: DHCSR / DCRSR / DCRDR semantics; letting the core go runs a "function" that returns r0 + r1. */
class FakeCore {
  regs = Array.from({ length: 17 }, () => 0);
  /** @type {Map<number, number>} */ ram = new Map();
  dhcsr = 0; sel = 0; pending = 0;
  /** @type {number[]} */ maskAtRun = [];

  constructor() { this.regs[16] = 0x01000000; }

  /** @param {number} a */
  async read32(a) {
    if (a === CortexM.DHCSR) return (this.dhcsr | CortexM.S_REGRDY) >>> 0;
    if (a === CortexM.DCRDR) return this.regs[this.sel];
    return this.ram.get(a) ?? 0;
  }

  /** @param {number} a @param {number} v */
  async write32(a, v) {
    if (a === CortexM.DHCSR) {
      const wasHalted = this.dhcsr & CortexM.S_HALT;
      this.dhcsr = v & 0xF;
      if (!(v & 2) && wasHalted) this.run();
      if (v & 2) this.dhcsr |= CortexM.S_HALT;
    } else if (a === CortexM.DCRSR) {
      this.sel = v & 0xFF;
      if (v >> 16) this.regs[this.sel] = this.pending;
    } else if (a === CortexM.DCRDR) this.pending = v;
    else this.ram.set(a, v);
  }

  /** @param {[number, number][]} pairs */
  async writeMany(pairs) { for (const [a, v] of pairs) await this.write32(a, v); }

  run() {
    this.maskAtRun.push(this.dhcsr & CortexM.C_MASKINTS);
    assert.equal(this.regs[13], 0x20080000);
    assert.equal(this.regs[14], 0x20040001);
    assert.ok(this.regs[16] & (1 << 24));
    this.regs[0] = this.regs[0] + this.regs[1];
    this.regs[15] = 0x20040000;                                           // returned onto the breakpoint
    this.dhcsr |= CortexM.S_HALT;
  }
}

test('CortexM.call returns r0 and clears C_MASKINTS', async () => {
  const fake = new FakeCore();
  const core = new CortexM(fake, 0x20040000, 0x20080000);
  await core.halt();
  assert.ok(await core.halted());
  assert.equal(await core.call(0x8D, [40, 2]), 42);
  assert.equal(fake.ram.get(0x20040000), 0xBE00BE00);                    // bkpt #0, twice
  assert.deepEqual(fake.maskAtRun, [CortexM.C_MASKINTS]);                 // the call ran with interrupts masked
  assert.equal(fake.dhcsr & CortexM.C_MASKINTS, 0);                       // and cleared after it
  assert.equal(fake.regs[15], 0x20040000);
  await core.setReg(3, 9);
  assert.equal(await core.reg(3), 9);
  await core.sysReset();
  assert.equal(fake.ram.get(CortexM.AIRCR), 0x05FA0004);
  await core.release();
  assert.equal(fake.dhcsr & CortexM.C_DEBUGEN, 0);
});
