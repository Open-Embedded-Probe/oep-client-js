// @ts-check
// oep.wire.rvswd / swio and oep.target.riscv-dm: against oep-client-python's virtual bench (as its tests/test_interfaces.py
// and test_virtual_bench_spec.py), and the host-side parts on a scripted host (as its tests/test_target_parts.py).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writer, fromHex } from '../src/bytes.js';
import * as m from '../src/message.js';
import { Failed, NoResource, Rejected, Unavailable, Unsupported } from '../src/errors.js';
import { FALLBACK_MAX_OP_MS, describe, find, planApply } from '../src/core.js';
import * as reg from '../src/registry.js';
import { decodeDescription } from '../src/catalog.js';
import * as rv from '../src/riscv.js';
import { ATTACH_FLAGS, RiscvDm, StepListError, TargetError, Wire } from '../src/riscv.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';
import { ScriptedHost, handlers, ok } from './scripted.js';

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withBench(args, body) {
  const bench = await startVirtualBench(args);
  const hst = await openTcp({ port: /** @type {any} */ (bench).port });
  try {
    await hst.open(10000);
    await body(hst);
  } finally {
    await hst.link.close();
    /** @type {any} */ (bench).stop();
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

// ---- oep.wire.* against the virtual bench ----------------------------------------------------------------------------

/** attach's fixed part: method swdio swclk max_speed (debug §1, §3). @param {number} method @param {[number, number]} pins
 * @param {number} hz */
const attachFixed = (method, [dio, clk], hz) => [...w().u8(method).u16(dio).u16(clk).u32(hz).done()];

test('attach makes a new connection on named pins: pins a live one holds are refused, max_speed 0 malformed (debug §1, §3)', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
  const log = tap(hst);
  const wire = await Wire.open(hst);
  const [pair] = await wire.candidatePairs();                              // the wire's one pair
  const { conn, dmstatus } = await wire.attach({ halt: true, maxSpeed: 1_000_000 });
  assert.ok(wire.hadReset && wire.speedHz === 1_000_000 && (dmstatus & 0x300));
  assert.ok(wire.halted && wire.dpc !== null);                             // flags halted + the dpc TLV
  assert.deepEqual([...log.at(-1)?.[2] ?? []], attachFixed(Wire.HALT, pair, 1_000_000));
  await assert.rejects(wire.attach({ halt: false }), (e) => e instanceof Unavailable && JSON.stringify(e.channels) === `[${pair[0]}]`);
  await assert.rejects(hst.call(wire.fn, Wire.ATTACH, Uint8Array.from(attachFixed(Wire.RUN, pair, 0))),
    (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);
  const list = await wire.connections();
  assert.deepEqual(list.map((c) => [c.conn, c.pins, c.targetsel]), [[conn, pair, null]]);
  await wire.detach(conn);
  const again = await wire.attach({ halt: false });
  assert.ok(again.conn !== conn && !wire.hadReset);
  const declared = /** @type {number} */ ((await wire.description()).maxClockHz);
  assert.deepEqual([...log.at(-1)?.[2] ?? []], attachFixed(Wire.RUN, pair, declared));   // none: the declared max_clock_hz
}));

test('rvswd: idle_clock goes critical whenever given (high included); the connection says the rest it uses (debug §3.1)', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
  const log = tap(hst);
  const wire = await Wire.open(hst);
  const [pair] = await wire.candidatePairs();
  const idle = (/** @type {'high' | 'low'} */ v) => [...m.tlv(Wire.TAG_IDLE_CLOCK, [Wire.IDLE_CLOCK[v]], true)];
  const { conn } = await wire.attach({ halt: false, maxSpeed: 1_000_000, idleClock: 'low' });
  assert.deepEqual([...log.at(-1)?.[2] ?? []], [...attachFixed(Wire.RUN, pair, 1_000_000), ...idle('low')]);
  assert.equal(wire.idleClock, 'low');
  assert.deepEqual((await wire.connections()).map((c) => c.idleClock), ['low']);
  await wire.detach(conn);
  await wire.attach({ halt: false, maxSpeed: 1_000_000, idleClock: 'high' });   // the target's high, sent explicitly
  assert.deepEqual([...log.at(-1)?.[2] ?? []], [...attachFixed(Wire.RUN, pair, 1_000_000), ...idle('high')]);
}));

test('scan and attach take the pin pair and refuse one not allowed', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
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

test('attach reports the target id when the probe reads one', { skip: !haveVirtualBench }, () => withBench([...X035, '--target-id', '035E0601'], async (hst) => {
  const wire = await Wire.open(hst);
  await wire.attach({ halt: false });
  assert.equal(Wire.SCHEME_DMI_7F, 1);                                     // dmi_7f: the u32 at DMI 0x7F (debug §3)
  assert.deepEqual(wire.targetId, [Wire.SCHEME_DMI_7F, fromHex('01065e03')]);
  const [c] = await wire.connections();
  assert.deepEqual(c.targetId, [Wire.SCHEME_DMI_7F, fromHex('01065e03')]);
}));

test('scan without pairs tries the candidate pairs the host builds from describe, in requests of 255 at most (debug §1)', { skip: !haveVirtualBench }, () => withBench(['--profile', 'rp2350-pins'], async (hst) => {
  const wire = await Wire.open(hst);
  const pairs = await wire.candidatePairs();
  assert.ok(pairs.length > 255);
  let scans = 0;
  const call = wire.call.bind(wire);
  wire.call = (op, body, opts) => { if (op === Wire.SCAN) scans++; return call(op, body, opts); };
  const found = await wire.scan();
  assert.ok(found.length >= 1);
  assert.ok(scans >= Math.ceil(pairs.length / 255));                      // the probe tries what fits its answer
}));

test('swio: attach under reset is the reset TLV; no default reset line; gpio reset fallback', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  const log = tap(hst);
  const wire = await Wire.open(hst, { name: 'oep.wire.swio' });
  const [pair] = await wire.candidatePairs();
  assert.equal(pair[1], 0xffff);                                            // one wire
  const [nrst] = await wire.resetChannels();
  const reset = (/** @type {number} */ ch, /** @type {number} */ ms) => [...m.tlv(Wire.TAG_RESET, w().u16(ch).u16(ms).done(), true)];
  const { conn, dpc } = await wire.attachUnderReset(nrst, { holdMs: 30 });
  assert.equal(dpc, 0);                                                     // halted as early as the probe can
  assert.ok(wire.halted);
  assert.deepEqual([...log.at(-1)?.[2] ?? []], [...attachFixed(Wire.HALT, pair, 1_000_000), ...reset(nrst, 30)]);
  await wire.detach(conn);
  const again = await wire.attach({ halt: false, reset: [nrst, 20] });     // a new connection, the target reset while running
  assert.ok(again.conn !== conn && !wire.halted && wire.dpc === null);
  await wire.detach(again.conn);
  const other = (await describe(hst, 0)).length && nrst - 1;
  await assert.rejects(wire.attach({ reset: [other, 20] }), (e) => e instanceof Unsupported && e.tag === (Wire.TAG_RESET | m.TAG_CRITICAL));   // not a reset line
  await assert.rejects(wire.attach({ reset: [nrst, 20000] }), Unsupported);   // longer than max_op_ms
  await assert.rejects(wire.attach({ idleClock: 'low' }), Unsupported);   // rvswd's TLV: unknown and critical on swio
  const gpio = await find(hst, 'oep.fixture.gpio');
  await planApply(hst, [[gpio, 1, nrst]]);                                  // fixture.gpio takes NRST
  const got = await rv.attachAfterGpioReset(hst, wire, gpio, nrst, { lowMs: 0 });
  assert.ok(got.conn >= 1);
}));

test('no connection after the connection is gone', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
  const { wire, dm } = await attached(hst);
  await wire.detach(dm.conn);
  await assert.rejects(dm.halt(), NoResource);
  await assert.rejects(wire.detach(dm.conn), NoResource);
  await assert.rejects((await RiscvDm.on(hst, 77)).read32(0), NoResource);
}));

// ---- oep.target.riscv-dm against the virtual bench -------------------------------------------------------------------

test('dmi counts its steps and a poll that gives up stops the list with its last value', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
  const { dm } = await attached(hst);
  // DMSTATUS (0x11) and ABSTRACTCS's busy are read-only and its cmderr write-1-to-clear (RISC-V Debug, as the virtual bench has
  // them): a value written to be read back or to keep a poll waiting goes in PROGBUF0 (0x20) and DATA0 (0x04)
  const steps = [RiscvDm.stepWrite(0x20, 0x382), RiscvDm.stepRead(0x20), RiscvDm.stepDelay(5),
    RiscvDm.stepPoll(0x16, 0x1000, 0, 10), RiscvDm.stepPollTime(0x16, 0x1000, 0, 1000)];   // busy clear: done at once
  assert.deepEqual(await dm.dmi(steps), { done: 5, values: [0x382, 0, 0] });
  const raw = await dm.request(RiscvDm.DMI, Uint8Array.from([2, 0, ...steps[0], ...steps[1]]));
  assert.deepEqual([...raw.payload.slice(0, 5)], [2, 0, 0, 1, 0]);          // done status nvals(u16) values [TLV]
  assert.deepEqual(await dm.dmi(Uint8Array.from([...steps[0], ...steps[1]])), { done: 2, values: [0x382] });
  await dm.dmi([RiscvDm.stepWrite(0x04, 0x1000)]);                       // bit 12 stays set: the poll gives up
  const err = await dm.dmi([RiscvDm.stepRead(0x20), RiscvDm.stepPoll(0x04, 0x1000, 0, 3), RiscvDm.stepRead(0x20)]).catch((e) => e);
  assert.ok(err instanceof StepListError);
  assert.equal(err.done, 1);
  assert.equal(err.status, rv.TIMEOUT);
  assert.deepEqual(err.values, [0x382, 0x1000]);
  assert.equal(err.result?.detail, m.PARTIAL);
  assert.throws(() => rv.countSteps(Uint8Array.of(0x09, 0)), RangeError);
  assert.equal(await dm.readRegister(RiscvDm.DPC), 0x100);   // the virtual bench answers access register dpc
}));

test('block access round-trips and reports how far it got', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
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

test('the virtual bench declares max_length = max_frame - 24 rounded to a word; a block past it is unsupported, an odd address malformed', { skip: !haveVirtualBench }, async () => {
  // oep-if-debug §4.5: a probe with block ops declares max_length (bytes, a multiple of 4) so that a read_block answer
  // (5 + 2 + 1 + words) and a write_block request (10 + 2 + 4 + 2 + words) both fit its max_frame
  /** @type {[string, number, number][]} */
  const profiles = [['p4-x035', 1024, 1000], ['esp32-v003', 512, 488], ['esp32-v003-64', 64, 40]];   // -64: the smallest max_frame
  for (const [profile, maxFrame, declared] of profiles) {
    await withBench(['--profile', profile], async (hst) => {
      const limits = await hst.confirmed();
      assert.equal(limits.maxFrame, maxFrame);
      const fn = await find(hst, 'oep.target.riscv-dm');
      const d = decodeDescription(await describe(hst, fn));
      assert.equal(d.maxLength, declared);
      assert.equal(declared, Math.floor((maxFrame - 24) / 4) * 4);
      assert.ok(declared % 4 === 0 && 8 + declared <= maxFrame && 18 + declared <= maxFrame);
    });
  }
  await withBench(X035, async (hst) => {
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

test('run returns the registers asked for; a timeout is returned, not thrown', { skip: !haveVirtualBench }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oep-run-'));
  const hook = join(dir, 'hook.py');
  writeFileSync(hook, 'def run(target, pc, regs):\n    if pc == 0x3000:\n        return False, pc + 8, 200000\n'
    + '    if pc == 0x4000:\n        target.unstoppable = True\n        return False, pc, 200000\n'
    + '    regs[0x100A], regs[0x100B] = 0, 0x08000100\n    return True, pc + 0xB0, 1234\n');
  await withBench([...X035, '--run-hook', `${hook}:run`], async (hst) => {
    const log = tap(hst);
    const { dm } = await attached(hst);
    const r = await dm.run(0x20000000, [[rv.REG_A0, 5]], { timeoutMs: 100, outs: [rv.REG_A0, rv.REG_A1] });
    assert.deepEqual(r, { status: rv.OK, stopped: true, notHalted: false, notRun: false, dpc: 0x200000B0, elapsedUs: 1234,
      values: [0, 0x08000100], unknownStopped: null });
    assert.deepEqual((await dm.run(0x20000000, [], { outs: [], timeoutMs: null })).values, []);
    assert.deepEqual([...log.at(-1)?.[2].slice(8, 12) ?? []], [...w().u32(10000).done()]);   // after connection(u32) pc: null, the probe's max_op_ms
    const t = await dm.run(0x3000, []);
    assert.ok(!t.stopped && !t.notHalted && t.status === rv.TIMEOUT);
    assert.deepEqual([t.dpc, t.values], [0x3008, [0]]);                      // stopped 0: halted by the probe, values valid
    const zero = await dm.run(0x20000000, [], { timeoutMs: 0 });       // timeout_ms 0 is not refused (debug §4.4)
    assert.ok(zero.status === rv.OK || zero.status === rv.TIMEOUT);
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

test('state and unknown statuses are failures; reset answers status flags pc', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
  const { dm } = await attached(hst);
  await dm.resume();
  await assert.rejects(dm.step(), (e) => e instanceof TargetError && /state/.test(e.message));
  await assert.rejects(dm.run(0x20000000, []), (e) => e instanceof TargetError && /state/.test(e.message));
  const odd = new m.Result(1, m.COMPLETED, m.SUCCESS, Uint8Array.of(0x42));
  assert.throws(() => rv.check('halt', odd, 0x42), /halt stopped: unknown status 0x42 \(completed\)/);
  assert.equal(await dm.resetHalt(), 0);
  const r = await dm.reset();
  assert.deepEqual(Object.keys(r).sort(), ['flags', 'pc']);               // status flags pc: no method, no attempts (§4.3)
  assert.ok(r.flags & 1);                                                  // bit0 reached
  const raw = await dm.request(RiscvDm.RESET, Uint8Array.of(RiscvDm.RESET_RUN));
  assert.equal(raw.payload.length, 1 + 1 + 4);
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

/** The pair the scripted wire attaches on (it declares none: named every time). */
const PAIR = /** @type {[number, number]} */ ([2, 54]);
/** attach's fixed part in a request: method(u8) swdio swclk max_speed (9 bytes), then the TLVs. */
const ATTACH_FIXED = 9;
/** An attach answer: connection(u32) dmstatus flags speed, then `tail`. @param {number} flags @param {Uint8Array} [tail] */
const attachAnswer = (flags, tail = new Uint8Array()) => ok([...w().u32(1).u32(0xc82).u8(flags).u32(1_000_000).done(), ...tail]);

test('findResetLine hits the vector, skips disallowed channels and retries failures', async () => {
  /** @type {Record<number, number>} */
  const tries = {};
  const RESET_TAG = Wire.TAG_RESET | m.TAG_CRITICAL;
  const hst = new ScriptedHost(handlers([
    [1, Wire.CONNECTIONS, () => ok([0, 0])],                                // none live on the pins
    [1, Wire.ATTACH, (p) => {
      const reset = new m.Reader(p.slice(ATTACH_FIXED)).tail().get(RESET_TAG);
      assert.ok(reset && p[0] === Wire.HALT);
      const channel = reset[0] | (reset[1] << 8);
      tries[channel] = (tries[channel] ?? 0) + 1;
      if (channel === 9) return [m.REJECTED, m.REJECT.unsupported, Uint8Array.of(RESET_TAG)];   // not a reset line on this probe
      if (channel === 5 && tries[5] === 1) return [m.COMPLETED, m.FAILED, Uint8Array.of(reg.STATUS.line)];   // the attach failed once
      const dpc = channel === 2 && tries[2] === 2 ? 0 : 0x1300 + channel;              // the real line, second try
      return attachAnswer(ATTACH_FLAGS.halted, m.tlv(Wire.TAG_DPC, w().u32(dpc).done()));   // halted + dpc
    }],
    [2, RiscvDm.RESUME, () => [m.COMPLETED, m.FAILED, Uint8Array.of(reg.STATUS.state)]],   // an L103: state
    [2, RiscvDm.RESET, () => ok(w().u8(reg.STATUS.ok).u8(1).u32(0x1234).done())],
    [1, Wire.DETACH, () => ok()],
  ]));
  const wire = await Wire.open(hst);
  assert.deepEqual(await wire.findResetLine([3, 9, 2, 5], { tries: 3, pins: PAIR }), [2]);
  assert.ok(wire.lastSearch.get(9) instanceof Rejected);
  assert.deepEqual(wire.lastSearch.get(2), [0x1302, 0]);
  assert.deepEqual(wire.lastSearch.get(5), [null, 0x1305, 0x1305]);
  assert.deepEqual(wire.lastSearch.get(3), [0x1303, 0x1303, 0x1303]);
  const resets = hst.log.filter(([fn, op]) => fn === 2 && op === RiscvDm.RESET).map(([, , p]) => [...p]);
  assert.deepEqual(resets, [[...w().u32(1).u8(RiscvDm.RESET_RUN).done()]]);   // only after the hit: off the vector for real
});

test('attachAfterGpioReset pipelines the release with the attach and retries', async () => {
  const SET = reg.FIXTURE_GPIO.op.set, MODE = reg.FIXTURE_GPIO.enum.mode;
  /** @type {Uint8Array[]} */
  const attaches = [];
  const hst = new ScriptedHost(handlers([
    [3, SET, () => ok()],
    [1, Wire.ATTACH, (p) => {
      attaches.push(p);
      return attaches.length === 3 ? attachAnswer(0) : [m.COMPLETED, m.FAILED, Uint8Array.of(reg.STATUS.line)];
    }],
  ]));
  const wire = await Wire.open(hst);
  assert.deepEqual(await rv.attachAfterGpioReset(hst, wire, 3, 23, { tries: 5, lowMs: 0, pins: PAIR }), { conn: 1, dmstatus: 0xc82 });
  assert.equal(attaches.length, 3);
  // attach with halt on the pins, max_speed: the declared max_clock_hz (none here: the default)
  assert.deepEqual([...attaches[0]], [...w().u8(Wire.HALT).u16(PAIR[0]).u16(PAIR[1]).u32(Wire.DEFAULT_MAX_SPEED).done()]);
  assert.deepEqual(hst.log.slice(0, 3).map(([fn, op]) => [fn, op]), [[3, SET], [3, SET], [1, Wire.ATTACH]]);
  assert.deepEqual([...hst.log[0][2]], [...w().u8(1).u16(23).u8(MODE.open_drain_low).done()]);   // set: channel 23 open-drain low
  assert.deepEqual([...hst.log[1][2]], [...w().u8(1).u16(23).u8(MODE.open_drain_release).done()]);   // ... then released

  const never = new ScriptedHost(handlers([[3, SET, () => ok()], [1, Wire.ATTACH, () => [m.COMPLETED, m.FAILED, new Uint8Array()]]]));
  await assert.rejects(rv.attachAfterGpioReset(never, await Wire.open(never), 3, 23, { tries: 2, lowMs: 0, pins: PAIR }), Failed);
});

test('resetHalt and step decode; reset is the mode alone', async () => {
  const hst = new ScriptedHost(handlers([
    [2, RiscvDm.RESET, (p) => ok(p[4] === RiscvDm.RESET_HALT ? w().u8(reg.STATUS.ok).u8(0).u32(0).done() : [])],
    [2, RiscvDm.STEP, () => ok([...w().u8(reg.STATUS.ok).u8(1).u32(0).u32(0x17f0).done(), ...m.tlv(0x40, Uint8Array.of(0))])],
  ]));
  const dm = await RiscvDm.on(hst, 1);
  assert.equal(dm.conn, 1);
  assert.equal(await dm.resetHalt(), 0);
  assert.deepEqual([...hst.log[hst.log.length - 1][2]], [...w().u32(1).u8(RiscvDm.RESET_HALT).done()]);   // connection(u32), mode
  assert.deepEqual(await dm.step(), { moved: true, before: 0, after: 0x17f0 });   // an unknown TLV after the fixed part: skipped
  assert.equal(/** @type {any} */ (RiscvDm).METHOD_SYSTEM, undefined);   // no reset method (debug §4.3)
});

test('readRegister keeps DATA0 and resume / step / run write it back first (debug §4)', async () => {
  /** @type {Map<number, number>} */
  const dmiRegs = new Map([[0x04, 0xC0FFEE00]]);   // DATA0: the console's mailbox
  const hst = new ScriptedHost(handlers([
    [2, RiscvDm.DMI, (p) => {
      /** @type {number[]} */ const values = [];
      const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
      const n = v.getUint16(4, true);                                   // after connection(u32)
      for (let at = 6, k = 0; k < n; k++) {
        const kind = p[at];
        if (kind === rv.STEP_WRITE) {
          const addr = p[at + 1], val = v.getUint32(at + 2, true);
          if (addr === 0x17) dmiRegs.set(0x04, 0x1234);                 // access register: DATA0 takes the value
          else dmiRegs.set(addr, val);
        } else if (kind === rv.STEP_READ) values.push(dmiRegs.get(p[at + 1]) ?? 0);
        else if (kind === rv.STEP_POLL_READS) values.push(0);           // abstractcs: not busy, no cmderr
        at += rv.STEP_SIZES[kind];
      }
      const out = w().u16(n).u8(0).u16(values.length);
      for (const x of values) out.u32(x);
      return ok(out.done());
    }],
    [2, RiscvDm.RESUME, () => ok([0])],
    [2, RiscvDm.STEP, () => ok(w().u8(0).u8(1).u32(0).u32(4).done())],
  ]));
  const dm = await RiscvDm.on(hst, 1);
  assert.equal(await dm.readRegister(RiscvDm.DPC), 0x1234);
  assert.equal(dm.dataSaved, 0xC0FFEE00);                                // read before the command changed it
  assert.equal(await dm.readRegister(RiscvDm.DPC), 0x1234);
  assert.equal(dm.dataSaved, 0xC0FFEE00);                                // the first value is kept
  await dm.resume();
  assert.equal(dmiRegs.get(0x04), 0xC0FFEE00);                           // written back before the hart ran
  assert.equal(dm.dataSaved, null);
  await dm.readRegister(RiscvDm.DPC);
  await dm.step();
  assert.equal(dmiRegs.get(0x04), 0xC0FFEE00);
  const before = hst.log.length;
  await dm.restoreData();                                                // nothing to write back: nothing sent
  assert.equal(hst.log.length, before);
});

test('attach, scan and reset wait max_op_ms as their argument time (debug §1, §4.3)', async () => {
  const hst = new ScriptedHost(handlers([]));
  hst.describes.set(0, [[reg.CORE.tlv.describe.max_op_ms, w().u32(4321).done()]]);
  const wire = await Wire.open(hst);
  assert.deepEqual([await wire.attachMs(), await wire.attachMs([23, 20]), await wire.scanMs()], [4321, 4321, 4321]);
  const dm = await RiscvDm.on(hst, 1);
  assert.equal(await dm.resetMs(), 4321);
  hst.describes.set(0, []);                                              // a probe that declares none (not conforming)
  assert.equal(await dm.resetMs(), FALLBACK_MAX_OP_MS);
  assert.equal(FALLBACK_MAX_OP_MS, 10000);
  for (const gone of ['ATTACH_BUDGET_MS', 'SCAN_BUDGET_MS', 'RESET_SETTLE_MS']) assert.equal(/** @type {any} */ (rv)[gone], undefined, gone);
});

test('connections are paged with first / more (debug §2.1)', async () => {
  /** @type {number[]} */
  const firsts = [];
  // connection(u32) swdio swclk speed scheme(u8) len(u8) value: count x entry (core §2.3)
  const entry = (/** @type {number} */ c) => w().u32(c).u16(2).u16(54).u32(1_000_000).u8(0).u8(0).done();
  const hst = new ScriptedHost(handlers([[1, Wire.CONNECTIONS, (p) => {
    firsts.push(p[0]);
    return p[0] < 2 ? ok([1, 2, ...entry(p[0] + 1), ...entry(p[0] + 2)]) : ok([0, 1, ...entry(5), ...m.tlv(0x41, new Uint8Array())]);   // an unknown TLV after
  }]]));
  const wire = await Wire.open(hst);
  const list = await wire.connections();
  assert.deepEqual(list.map((c) => c.conn), [1, 2, 5]);
  assert.deepEqual(firsts, [0, 2]);
  assert.deepEqual(list[0], { conn: 1, pins: [2, 54], speedHz: 1_000_000, targetId: null, targetsel: null, idleClock: null });
});

test('read_block, dmi and run answers carry their counts; a wrong-kind resource number is unavailable cause 6', { skip: !haveVirtualBench }, () => withBench(X035, async (hst) => {
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
