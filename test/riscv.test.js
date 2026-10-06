// @ts-check
// oep.wire.rvswd / swio and oep.target.riscv-dm: against oep-client-python's fake probe (as its tests/test_interfaces.py
// and test_fake_spec.py), and the host-side parts on a scripted host (as its tests/test_target_parts.py).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writer, fromHex } from '../src/bytes.js';
import * as m from '../src/message.js';
import { Failed, NoConnection, Rejected, Unavailable, Unsupported } from '../src/errors.js';
import { describe, find, planApply } from '../src/core.js';
import { decodeDescription } from '../src/catalog.js';
import * as rv from '../src/riscv.js';
import { RiscvDm, StepListError, TargetError, Wire } from '../src/riscv.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';
import { ScriptedHost, handlers, ok } from './scripted.js';

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withFake(args, body) {
  const fake = await startFake(args);
  const hst = await openTcp({ port: /** @type {any} */ (fake).port });
  try {
    await hst.open(10000);
    await body(hst);
  } finally {
    await hst.link.close();
    /** @type {any} */ (fake).stop();
  }
}

/** Log every request the host sends: [fn, op, payload]. @param {import('../src/host.js').Host} hst */
function tap(hst) {
  /** @type {[number, number, Uint8Array][]} */
  const log = [];
  const send = hst.link.send.bind(hst.link);
  hst.link.send = (bytes) => { const r = m.Request.unpack(bytes); log.push([r.fn, r.op, r.payload]); return send(bytes); };
  return log;
}

/** @param {import('../src/host.js').Host} hst */
async function attached(hst) {
  const wire = await Wire.open(hst);
  const { conn } = await wire.attach({ halt: true });
  return { wire, dm: await RiscvDm.on(hst, conn) };
}

const X035 = ['--profile', 'p4-x035'];
const w = () => new Writer();

// ---- oep.wire.* against the fake ----------------------------------------------------------------------------

test('attach twice returns the same connection; max_speed goes critical', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const log = tap(hst);
  const wire = await Wire.open(hst);
  const { conn, dmstatus } = await wire.attach({ halt: true, maxSpeed: 1_000_000 });
  assert.ok(wire.hadReset && !wire.existing && wire.speedHz === 1_000_000 && (dmstatus & 0x300));
  assert.ok(wire.halted && wire.dpc !== null);                             // flags bit3 + the dpc TLV 0x11
  assert.deepEqual(wire.ignored, []);
  assert.deepEqual([...log.at(-1)?.[2] ?? []], [1, 0x81, 4, 0, ...w().u32(1_000_000).done()]);
  const again = await wire.attach({ halt: false });
  assert.equal(again.conn, conn);
  assert.ok(wire.existing && !wire.hadReset);
  assert.deepEqual([...log.at(-1)?.[2] ?? []], [0, 0x81, 4, 0, ...w().u32(5_000_000).done()]);   // none: the declared max_clock_hz
  await assert.rejects(hst.call(wire.fn, Wire.ATTACH, Uint8Array.of(0)), (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);   // max_speed is required
  const list = await wire.connections();
  assert.equal(list.length, 1);
  assert.equal(list[0].conn, conn);
  assert.deepEqual(list[0].pins, [2, 54]);
  assert.equal(list[0].users & 1, 1);
  assert.equal(list[0].slot, Wire.NO_SLOT);
  assert.equal(list[0].targetId, null);
  await wire.detach(conn, { force: true });
  assert.deepEqual(await wire.connections(), []);
}));

test('scan and attach take the pin pair and refuse one not allowed', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const wire = await Wire.open(hst);
  const found = await wire.scan();
  assert.deepEqual(found.map((f) => f.pins), [[2, 54]]);
  assert.equal(found[0].kind, 1);
  assert.deepEqual((await wire.scan([[2, 54]])).map((f) => f.pins), [[2, 54]]);
  await assert.rejects(wire.scan([[2, 54], [3, 4]]), Rejected);
  await assert.rejects(wire.attach({ halt: false, pins: [3, 4] }), Rejected);
  const { conn } = await wire.attach({ halt: false, pins: found[0].pins });
  assert.ok(conn >= 1);
}));

test('attach reports the target id when the probe reads one', { skip: !haveFake }, () => withFake([...X035, '--target-id', '035E0601'], async (hst) => {
  const wire = await Wire.open(hst);
  await wire.attach({ halt: false });
  assert.deepEqual(wire.targetId, [Wire.SCHEME_WCH_DMI_7F, fromHex('01065e03')]);
  const [c] = await wire.connections();
  assert.deepEqual(c.targetId, [Wire.SCHEME_WCH_DMI_7F, fromHex('01065e03')]);
}));

test('the client scan walks the whole count-0 list (skip until tried = 0)', { skip: !haveFake }, () => withFake(['--profile', 'rp2350-pins'], async (hst) => {
  const wire = await Wire.open(hst);
  let scans = 0;
  const call = wire.call.bind(wire);
  wire.call = (op, body, opts) => { if (op === Wire.SCAN) scans++; return call(op, body, opts); };
  assert.deepEqual((await wire.scan()).map((f) => f.pins), [[0, 1]]);
  assert.equal(scans, Math.ceil((29 * 28) / 255) + 1);   // 255 a request, then the one that answers tried = 0
}));

test('swio: no default reset line, only the declared channels; gpio reset fallback', { skip: !haveFake }, () => withFake(['--profile', 'esp32-v003'], async (hst) => {
  const log = tap(hst);
  const wire = await Wire.open(hst, { name: 'oep.wire.swio' });
  assert.deepEqual(await wire.resetChannels(), [23]);
  await assert.rejects(wire.attachUnderReset(22), (e) => e instanceof Unsupported && e.tag === 0x85);   // not a reset line
  const { conn, dpc } = await wire.attachUnderReset(23, { holdMs: 5 });
  assert.equal(dpc, 0);                                                     // halted before the first instruction
  assert.ok(wire.halted);
  assert.deepEqual([...log.at(-1)?.[2] ?? []], [1, 0x81, 4, 0, ...w().u32(1_000_000).done(), 0x85, 4, 0, 23, 0, 5, 0]);   // the reset TLV
  const again = await wire.attach({ halt: false, reset: [23, 5] });        // an existing connection: the target reset, running
  assert.ok(again.conn === conn && wire.existing && !wire.halted && wire.dpc === null);
  await assert.rejects(wire.attach({ reset: [23, 20000] }), Unsupported);  // longer than max_op_ms
  await assert.rejects(wire.attach({ idleClock: 'low' }), Unsupported);   // rvswd's TLV: unknown and critical on swio
  await wire.detach(conn);
  await planApply(hst, [[4, 1, 23]]);                                      // fixture.gpio takes NRST
  const got = await rv.attachAfterGpioReset(hst, wire, 4, 23, { lowMs: 0 });
  assert.ok(got.conn >= 1);
}));

test('no connection after the connection is gone', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const { wire, dm } = await attached(hst);
  await wire.detach(dm.conn);
  await assert.rejects(dm.halt(), NoConnection);
  await assert.rejects(wire.detach(dm.conn), NoConnection);
  await assert.rejects((await RiscvDm.on(hst, 77)).read32(0), NoConnection);
}));

// ---- oep.target.riscv-dm against the fake -------------------------------------------------------------------

test('dmi counts its steps and a poll that gives up stops the list with its last value', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const { dm } = await attached(hst);
  const steps = [RiscvDm.stepWrite(0x11, 0x382), RiscvDm.stepRead(0x11), RiscvDm.stepDelay(5),
    RiscvDm.stepPoll(0x16, 0x1000, 0, 10), RiscvDm.stepPollTime(0x16, 0x1000, 0, 1000)];
  assert.deepEqual(await dm.dmi(steps), { done: 5, values: [0x382, 0, 0] });
  const raw = await dm.request(RiscvDm.DMI, Uint8Array.from([2, 0, ...steps[0], ...steps[1]]));
  assert.deepEqual([...raw.payload.slice(0, 5)], [2, 0, 0, 1, 0]);          // done status nvals(u16) values [TLV]
  assert.deepEqual(await dm.dmi(Uint8Array.from([...steps[0], ...steps[1]])), { done: 2, values: [0x382] });
  await dm.dmi([RiscvDm.stepWrite(0x16, 0x1000)]);
  const err = await dm.dmi([RiscvDm.stepRead(0x11), RiscvDm.stepPoll(0x16, 0x1000, 0, 3), RiscvDm.stepRead(0x11)]).catch((e) => e);
  assert.ok(err instanceof StepListError);
  assert.equal(err.done, 1);
  assert.equal(err.status, rv.TIMEOUT);
  assert.deepEqual(err.values, [0x382, 0x1000]);
  assert.equal(err.result?.detail, m.PARTIAL);
  assert.throws(() => rv.countSteps(Uint8Array.of(0x09, 0)), RangeError);
  assert.equal(await dm.readRegister(RiscvDm.DPC), 0x100);   // the fake answers access register dpc
}));

test('block access round-trips and reports how far it got', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const { dm } = await attached(hst);
  assert.equal(dm.maxLength, 1000);                                        // from describe (max_frame 1024 - 24), not max_frame
  assert.equal(dm.maxWords, 250);
  assert.equal(await dm.blockWords(), 250);
  const data = w().u32(1).u32(2).u32(3).done();
  await dm.writeBlock(0x20000000, data);
  assert.deepEqual(await dm.readBlock(0x20000000, 3), data);
  await dm.write32(0x20000010, 0xdeadbeef);
  assert.equal(await dm.read32(0x20000010), 0xdeadbeef);
  assert.throws(() => RiscvDm.writeBlockBody(0, Uint8Array.of(1, 2)), RangeError);
}));

test('the fake declares max_length = max_frame - 24 rounded to a word; a block past it is unsupported, an odd address malformed', { skip: !haveFake }, async () => {
  // oep-if-debug §4.5: a probe with block ops declares max_length (bytes, a multiple of 4) so that a read_block answer
  // (5 + 2 + 1 + words) and a write_block request (10 + 2 + 4 + 2 + words) both fit its max_frame
  /** @type {[string, number, number][]} */
  const profiles = [['p4-x035', 1024, 1000], ['esp32-v003', 64, 40]];
  for (const [profile, maxFrame, declared] of profiles) {
    await withFake(['--profile', profile], async (hst) => {
      const limits = await hst.confirmed();
      assert.equal(limits.maxFrame, maxFrame);
      const fn = await find(hst, 'oep.target.riscv-dm');
      const d = decodeDescription(await describe(hst, fn));
      assert.equal(d.maxLength, declared);
      assert.equal(declared, Math.floor((maxFrame - 24) / 4) * 4);
      assert.ok(declared % 4 === 0 && 8 + declared <= maxFrame && 18 + declared <= maxFrame);
    });
  }
  await withFake(X035, async (hst) => {
    const { dm } = await attached(hst);
    const words = 1000 / 4;
    assert.equal((await dm.readBlock(0x20000000, words)).length, 4 * words);
    await assert.rejects(dm.readBlock(0x20000000, words + 1),
      (e) => e instanceof Unsupported && e.tag === null && e.result.payload.length === 1 && e.result.payload[0] === 0);
    await assert.rejects(dm.writeBlock(0x20000000, new Uint8Array(4 * (words + 1))),
      (e) => e instanceof Unsupported && e.result.payload[0] === 0);
    await assert.rejects(dm.writeBlock(0x20000002, new Uint8Array(4 * (words + 1))),   // the address first (core §4.3 order 5)
      (e) => e instanceof Rejected && e.result.detail === m.REJECT.malformed);
    await dm.writeBlock(0x20000000, new Uint8Array(4 * words));
  });
});

test('run returns the registers asked for; a timeout is returned, not thrown', { skip: !haveFake }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oep-run-'));
  const hook = join(dir, 'hook.py');
  writeFileSync(hook, 'def run(target, pc, regs):\n    if pc == 0x3000:\n        return False, pc + 8, 200000\n'
    + '    if pc == 0x4000:\n        target.unstoppable = True\n        return False, pc, 200000\n'
    + '    regs[0x100A], regs[0x100B] = 0, 0x08000100\n    return True, pc + 0xB0, 1234\n');
  await withFake([...X035, '--run-hook', `${hook}:run`], async (hst) => {
    const log = tap(hst);
    const { dm } = await attached(hst);
    const r = await dm.run(0x20000000, [[rv.REG_A0, 5]], { timeoutMs: 100, outs: [rv.REG_A0, rv.REG_A1] });
    assert.deepEqual(r, { status: rv.OK, stopped: true, notHalted: false, dpc: 0x200000B0, elapsedUs: 1234, values: [0, 0x08000100] });
    assert.deepEqual((await dm.run(0x20000000, [], { outs: [], timeoutMs: null })).values, []);
    assert.deepEqual([...log.at(-1)?.[2].slice(6, 10) ?? []], [...w().u32(10000).done()]);   // null: the probe's max_op_ms
    const t = await dm.run(0x3000, []);
    assert.ok(!t.stopped && !t.notHalted && t.status === rv.TIMEOUT);
    assert.deepEqual([t.dpc, t.values], [0x3008, [0]]);                      // stopped 0: halted by the probe, values valid
    await assert.rejects(dm.run(0x20000000, [], { timeoutMs: 0 }), Rejected);
    await assert.rejects(dm.run(0x20000000, [], { timeoutMs: 10001 }), Unsupported);   // over max_op_ms
    const u = await dm.run(0x4000, [], { timeoutMs: 100, outs: [rv.REG_A0, rv.REG_A1] });
    assert.ok(u.notHalted && !u.stopped && u.status === rv.TIMEOUT);
    assert.deepEqual(u.values, []);                                          // stopped 2: nvals 0, dpc means nothing
    const raw = await dm.request(RiscvDm.RUN, RiscvDm.runBody(0x4000, [], { timeoutMs: 100 }));
    assert.equal(raw.detail, m.FAILED);
    assert.deepEqual([raw.payload[1], raw.payload[10]], [2, 0]);            // the shape is always the same
  });
  assert.throws(() => RiscvDm.runBody(0x20000000, [], { timeoutMs: /** @type {any} */ (null) }), RangeError);
});

test('state and unknown statuses are failures; reset method goes critical', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const { dm } = await attached(hst);
  await dm.resume();
  await assert.rejects(dm.step(), (e) => e instanceof TargetError && /state/.test(e.message));
  await assert.rejects(dm.run(0x20000000, []), (e) => e instanceof TargetError && /state/.test(e.message));
  const odd = new m.Result(1, m.COMPLETED, m.SUCCESS, Uint8Array.of(0x42));
  assert.throws(() => rv.check('halt', odd, 0x42), /halt stopped: unknown status 0x42 \(completed\)/);
  assert.equal(await dm.resetHalt({ method: RiscvDm.METHOD_NDMRESET }), 0);
  const e = await dm.reset({ method: 9 }).catch((x) => x);
  assert.ok(e instanceof Unsupported);
  assert.equal(e.tag, 0x81);
  const { flags, attempts } = await dm.reset({ confirm: true });
  assert.ok(flags & 2);
  assert.equal(attempts, 1);
  await dm.halt();
  const s = await dm.step();
  assert.equal(typeof s.moved, 'boolean');
}));

// ---- host-side parts on a scripted host ---------------------------------------------------------------------

test('dmi value count rule', () => {
  const kinds = [rv.STEP_READ, rv.STEP_WRITE, rv.STEP_POLL_US, rv.STEP_WAIT_US];
  assert.equal(rv.dmiValueCount(kinds, 4, rv.OK), 2);
  assert.equal(rv.dmiValueCount(kinds, 2, rv.TIMEOUT), 2);          // the failed poll adds its last value
  assert.equal(rv.dmiValueCount(kinds, 1, rv.STATUS.line), 1);      // a failed write adds nothing
  assert.equal(rv.dmiValueCount(kinds, 2, rv.STATUS.line), 1);      // a poll whose read failed adds nothing
  assert.deepEqual(rv.countSteps(Uint8Array.from([...RiscvDm.stepRead(1), ...RiscvDm.stepDelay(3)])), [rv.STEP_READ, rv.STEP_WAIT_US]);
  assert.equal(rv.statusName(4), 'timeout');
});

test('findResetLine hits the vector, skips disallowed channels and retries failures', async () => {
  /** @type {Record<number, number>} */
  const tries = {};
  const hst = new ScriptedHost(handlers([
    [1, Wire.ATTACH, (p) => {
      const reset = new m.Reader(p.slice(1)).tail().get(0x85);
      assert.ok(reset && p[0] === Wire.HALT);
      const channel = reset[0] | (reset[1] << 8);
      tries[channel] = (tries[channel] ?? 0) + 1;
      if (channel === 9) return [m.REJECTED, m.REJECT.unsupported, Uint8Array.of(0x85)];   // not a reset line on this probe
      if (channel === 5 && tries[5] === 1) return [m.COMPLETED, m.FAILED, Uint8Array.of(4)];   // the attach failed once: status
      const dpc = channel === 2 && tries[2] === 2 ? 0 : 0x1300 + channel;              // the real line, second try
      return ok([...w().u16(1).u32(0xc82).u8(8).u32(1_000_000).done(), ...m.tlv(0x11, w().u32(dpc).done())]);   // halted + dpc
    }],
    [2, RiscvDm.RESUME, () => [m.COMPLETED, m.FAILED, Uint8Array.of(5)]],               // an L103: state
    [2, RiscvDm.RESET, () => ok(w().u8(0).u8(3).u8(1).u32(0x1234).done())],
    [1, Wire.DETACH, () => ok()],
  ]));
  const wire = await Wire.open(hst);
  assert.deepEqual(await wire.findResetLine([3, 9, 2, 5], { tries: 3 }), [2]);
  assert.ok(wire.lastSearch.get(9) instanceof Rejected);
  assert.deepEqual(wire.lastSearch.get(2), [0x1302, 0]);
  assert.deepEqual(wire.lastSearch.get(5), [null, 0x1305, 0x1305]);
  assert.deepEqual(wire.lastSearch.get(3), [0x1303, 0x1303, 0x1303]);
  const resets = hst.log.filter(([fn, op]) => fn === 2 && op === RiscvDm.RESET).map(([, , p]) => [...p]);
  assert.deepEqual(resets, [[1, 0, RiscvDm.RESET_RUN_CONFIRM]]);   // only after the hit: off the vector for real
});

test('attachAfterGpioReset pipelines the release with the attach and retries', async () => {
  /** @type {Uint8Array[]} */
  const attaches = [];
  const hst = new ScriptedHost(handlers([
    [3, 0x01, () => ok()],
    [1, Wire.ATTACH, (p) => {
      attaches.push(p);
      return attaches.length === 3 ? ok(w().u16(1).u32(0xc82).u8(0).u32(1_000_000).done()) : [m.COMPLETED, m.FAILED, Uint8Array.of(2)];
    }],
  ]));
  const wire = await Wire.open(hst);
  assert.deepEqual(await rv.attachAfterGpioReset(hst, wire, 3, 23, { tries: 5, lowMs: 0 }), { conn: 1, dmstatus: 0xc82 });
  assert.equal(attaches.length, 3);
  assert.deepEqual([...attaches[0]], [1, 0x81, 4, 0, ...w().u32(1_000_000).done()]);   // attach with halt, max_speed (required)
  assert.deepEqual(hst.log.slice(0, 3).map(([fn, op]) => [fn, op]), [[3, 1], [3, 1], [1, Wire.ATTACH]]);
  assert.deepEqual([...hst.log[0][2]], [1, 23, 0, 5]);                       // set: n=1, channel 23 open-drain low
  assert.deepEqual([...hst.log[1][2]], [1, 23, 0, 6]);                       // ... then released

  const never = new ScriptedHost(handlers([[3, 0x01, () => ok()], [1, Wire.ATTACH, () => [m.COMPLETED, m.FAILED, new Uint8Array()]]]));
  await assert.rejects(rv.attachAfterGpioReset(never, await Wire.open(never), 3, 23, { tries: 2, lowMs: 0 }), Failed);
});

test('resetHalt and step decode; the method goes as a critical TLV', async () => {
  const hst = new ScriptedHost(handlers([
    [2, RiscvDm.RESET, (p) => ok(p[2] === 2 ? w().u8(0).u8(0).u8(1).u32(0).done() : [])],
    [2, RiscvDm.STEP, () => ok([...w().u8(0).u8(1).u32(0).u32(0x17f0).done(), 0x40, 0x01, 0x00, 0x00])],
  ]));
  const dm = await RiscvDm.on(hst, 1);
  assert.equal(dm.conn, 1);
  assert.equal(await dm.resetHalt(), 0);
  assert.deepEqual([...hst.log[hst.log.length - 1][2]], [1, 0, 2]);          // connection(u16), mode 2
  assert.deepEqual(await dm.step(), { moved: true, before: 0, after: 0x17f0 });   // an unknown TLV after the fixed part: skipped
  await dm.resetHalt({ method: RiscvDm.METHOD_SYSTEM });
  assert.deepEqual([...hst.log[hst.log.length - 1][2]], [1, 0, 2, 0x81, 1, 0, 2]);
});

test('connections are paged with first / more (debug §2.1)', async () => {
  /** @type {number[]} */
  const firsts = [];
  const entry = (/** @type {number} */ c) => w().u16(c).u16(2).u16(54).u32(1_000_000).u8(1).u8(0xff).u8(0).u8(0).done();   // count x entry (core §2.3)
  const hst = new ScriptedHost(handlers([[1, Wire.CONNECTIONS, (p) => {
    firsts.push(p[0]);
    return p[0] < 2 ? ok([1, 2, ...entry(p[0] + 1), ...entry(p[0] + 2)]) : ok([0, 1, ...entry(5), 0x41, 0, 0]);   // an unknown TLV after
  }]]));
  const wire = await Wire.open(hst);
  const list = await wire.connections();
  assert.deepEqual(list.map((c) => c.conn), [1, 2, 5]);
  assert.deepEqual(firsts, [0, 2]);
  assert.deepEqual(list[0], { conn: 1, pins: [2, 54], speedHz: 1_000_000, users: 1, slot: 0xff, targetId: null });
});

test('read_block, dmi and run answers carry their counts; a wrong-kind resource number is unavailable cause 6', { skip: !haveFake }, () => withFake(X035, async (hst) => {
  const { wire, dm } = await attached(hst);
  await dm.writeBlock(0x20000000, w().u32(7).u32(8).done());
  const r = await dm.request(RiscvDm.READ_BLOCK, w().u32(0x20000000).u16(2).done());
  assert.deepEqual([...r.payload.slice(0, 3)], [2, 0, 0]);                  // done(u16) status, then done words [TLV]
  assert.deepEqual(await dm.readBlock(0x20000000, 2), w().u32(7).u32(8).done());
  const { Console } = await import('../src/console.js');
  const con = await Console.open(hst);
  const sid = await con.open(dm.conn);
  const other = await RiscvDm.on(hst, sid);                                 // a stream's number given as a connection
  await assert.rejects(other.halt(), (e) => e instanceof Unavailable && e.cause === 'wrong_state');
  await wire.detach(dm.conn);
}));
