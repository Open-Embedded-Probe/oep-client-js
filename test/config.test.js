// @ts-check
// oep.probe.config (src/config.js) against oep-client-python's virtual bench; mirrors its tests/test_config.py as far as
// the TCP virtual bench allows (no reboot / DFU, no CLI).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, u32 } from '../src/bytes.js';
import * as config from '../src/config.js';
import { Bind, Disable, Idle, Label, Plan, ProbeConfig, Slot, Uart } from '../src/config.js';
import { Rejected, OepError, Unavailable, Unsupported } from '../src/errors.js';
import * as m from '../src/message.js';
import { FixtureUart, Gpio, GpioUnavailable } from '../src/fixture.js';
import { planApply, planRelease } from '../src/core.js';
import { Wire } from '../src/riscv.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

/** @param {string[]} args @param {'length' | 'cobs'} framing @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withBench(args, body, framing = 'length') {
  const bench = await startVirtualBench(args, framing);
  const hst = await openTcp({ port: bench.port, framing });
  try {
    await body(hst);
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

const TID = 0x035e0601;

test('slot and bind values as probe.config §1.1 / §1.2 say, and back', () => {
  const s = new Slot({ slot: 0, wireFn: 1, pins: [2, 54], name: 'x035', attach: 'at-boot', retryS: 1,
    maxSpeed: 1_000_000, idleClock: 'low' });
  const v = s.value();
  // slot wire_fn swdio swclk attach retry_ms(u32) max_speed_hz(u32) idle_clock mechanism name_len, then the name (§1.1)
  assert.deepEqual([...v.slice(0, 19)], [0, 1, 0, 2, 0, 54, 0, 1, 0xe8, 3, 0, 0, 0x40, 0x42, 0x0f, 0, 1, 2, 4]);
  assert.equal(v.length, 19 + 4);                                    // the item ends with the name
  assert.deepEqual(config.decode(config.ITEM.slot, v), s);
  // retry_s only goes with at-boot (0 on a host slot)
  const plain = new Slot({ slot: 1, wireFn: 1, pins: [16, 0xffff], name: 'v003', retryS: 5 });
  assert.equal(/** @type {Slot} */ (config.decode(config.ITEM.slot, plain.value())).retryS, 0);
  assert.ok(!('lock' in plain) && !('bootReset' in plain));          // no lock, no boot_reset (probe.config §1.1)
  const b = new Bind({ port: 3, stream: ['uart', 5] });
  assert.deepEqual([...b.value()], [3, 2, 5, 0]);                    // port(u8) kind(u8) id(u16): one stream (§1.2)
  assert.deepEqual(config.decode(config.ITEM.bind, b.value()), b);
  assert.deepEqual(config.decode(config.ITEM.bind, Uint8Array.of(0, 1, 0, 0)), new Bind({ port: 0, stream: ['slot', 0] }));
  // removals are unset's keys: len tag key (probe.config §2)
  assert.deepEqual([...config.remove('bind', 3).encoded()], [2, config.ITEM.bind, 3]);
  assert.deepEqual([...config.remove('plan', 0x105).encoded()], [3, config.ITEM.plan, 5, 1]);
  assert.deepEqual([...config.remove('uart', 7).encoded()], [3, config.ITEM.uart, 7, 0]);
  assert.throws(() => config.remove(/** @type {any} */ ('x'), 1), RangeError);
  // a slot without a console; the uart item
  const none = new Slot({ slot: 2, wireFn: 1, pins: [2, 54], name: 'n', mechanism: 'none' });
  assert.equal(none.value()[17], 0xff);                              // mechanism
  assert.equal(/** @type {Slot} */ (config.decode(config.ITEM.slot, none.value())).mechanism, 'none');
  const u = new Uart({ fn: 5, baud: 115200, format: FixtureUart.formatByte(8, 'E', 2) });
  assert.deepEqual([...u.value()], [5, 0, 0, 0xc2, 1, 0, 0b010100]);
  assert.deepEqual(config.decode(config.ITEM.uart, u.value()), u);
  assert.deepEqual(config.decode(0x33, Uint8Array.of(1)), { tag: 0x33, value: Uint8Array.of(1) });
});

test('get\'s order and comparing items (probe.config §2, host guide §15): the hash is the probe\'s own', () => {
  const items = [new Label({ channel: 9, text: 'b' }), new Plan({ fn: 5, role: 2, channel: 21 }),
    new Label({ channel: 3, text: 'a' }), new Plan({ fn: 5, role: 1, channel: 20 }), new Plan({ fn: 5, role: 1, channel: 19 })];
  const order = config.ordered(items).map(([t, v]) => [t, v[0], v[2], v[3]]);
  assert.deepEqual(order, [[1, 5, 1, 19], [1, 5, 1, 20], [1, 5, 2, 21], [2, 3, 97, undefined], [2, 9, 98, undefined]]);   // plan by (fn, role, channel)
  assert.throws(() => config.ordered([/** @type {any} */ (config.remove('slot', 0))]), RangeError);   // a removal is not an item
  assert.throws(() => config.ordered([new Idle({ channel: 1 }), new Idle({ channel: 1, mode: 'hi-z' })]), RangeError);
  // the same items in any order, as objects or item bytes, the critical bit dropped
  const crit = config.item(new Label({ channel: 3, text: 'a' }));
  crit[0] |= 0x80;
  assert.ok(config.sameItems([...items].reverse(), [...items.filter((i) => !(i instanceof Label && i.channel === 3)), crit]));
  assert.ok(!config.sameItems(items, items.slice(1)));
  assert.ok(!config.sameItems([new Label({ channel: 3, text: 'a' })], [new Label({ channel: 3, text: 'b' })]));
  for (const gone of ['crc32', 'canonical', 'canonicalHash', 'MODE', 'BOOT_RESET']) assert.equal(/** @type {any} */ (config)[gone], undefined, gone);
});

test('state is paged by first_slot / first_bind and says why storage is unreadable (probe.config §3.3)', async () => {
  /** @type {number[][]} */
  const asked = [];
  // slot state connection last_try_at_ns: count x slot_state, no element length (core §2.3); bind: port flow
  const slot = (/** @type {number} */ n) => new Writer().u8(n).u8(1).u16(0).u64(n === 2 ? 7_000_000n : 0xffffffffffffffffn).done();
  const bind = (/** @type {number} */ p) => new Writer().u8(p).u8(1).done();
  const hst = /** @type {any} */ ({
    /** @param {number} fn @param {number} op @param {Uint8Array} p */
    async call(fn, op, p) {
      asked.push([...p]);
      const head = new Writer().u8(p[0] === 0 ? 1 : 0).u8(2).u32(0x04030201).u8(2).done();
      const body = p[0] === 0 ? [...head, 2, ...slot(0), ...slot(1), 1, ...bind(3)] : [...head, 1, ...slot(2), 0, 0x41, 1, 0, 7];
      return { payload: Uint8Array.from(body) };
    },
  });
  const st = await new ProbeConfig(hst, 6, ProbeConfig.NAME).state();
  assert.deepEqual(asked, [[0, 0], [2, 1]]);
  assert.equal(st.storage, 'unreadable');
  assert.equal(st.savedHash, 0x04030201);
  assert.equal(st.unreadableReason, 2);
  assert.match(/** @type {string} */ (st.unreadable), /gone/);
  assert.deepEqual(st.slots.map((s) => [s.slot, s.state, s.lastTryAtNs]), [[0, 'absent', null], [1, 'absent', null], [2, 'absent', 7_000_000n]]);
  assert.deepEqual(st.binds, [{ port: 3, flow: 'streaming' }]);
});

test('slots and binds round trip and show their state; needsSave and apply (host guide §15)', { skip: !haveVirtualBench }, () => withBench(
  ['--profile', 'p4-bench', '--target-id', TID.toString(16)], async (hst) => {
    await hst.open(3000);
    const cfg = await ProbeConfig.open(hst);
    const wanted = [new Slot({ slot: 0, wireFn: 1, pins: [2, 3], name: 'x035', attach: 'at-boot', retryS: 1 }),
      new Bind({ port: 3, stream: ['slot', 0] })];
    const h0 = await cfg.set(wanted);
    const items = await cfg.items();
    assert.deepEqual(items, wanted);
    assert.ok(config.sameItems(/** @type {config.Item[]} */ (items), wanted) && !config.sameItems(/** @type {config.Item[]} */ (items), wanted.slice(0, 1)));
    const declared = await cfg.describe();
    assert.equal(declared.slotsMax, 4);
    assert.ok(!('bindModes' in declared));
    assert.ok(declared.items.includes(config.ITEM.uart));
    const st = await cfg.state();
    assert.equal(st.slots[0].state, 'connected');                         // which target: the host's (connections' tid)
    assert.ok(st.slots[0].connection > 0);
    const [conn] = await (await Wire.open(hst)).connections();
    assert.deepEqual([conn.conn, conn.targetId?.[1]], [st.slots[0].connection, u32(TID)]);
    assert.ok(st.slots[0].lastTryAtNs !== null && st.slots[0].lastTryAtNs >= 0n);   // the probe's clock, ns
    assert.deepEqual(st.binds, [{ port: 3, flow: 'streaming' }]);
    assert.ok(await cfg.needsSave());
    const saved = await cfg.save();
    const after = await cfg.state();
    assert.deepEqual([after.savedHash, after.storage], [saved, 'applied']);
    assert.equal(saved, h0);
    assert.ok(!(await cfg.needsSave()));
    assert.ok(!(await cfg.apply(wanted)) && !(await cfg.apply(wanted, { save: true })));   // the same items: nothing sent
    const h = await cfg.set([config.remove('bind', 3)]);                   // goes as an unset
    assert.deepEqual((await cfg.items()).map((i) => i.constructor.name), ['Slot']);
    assert.equal(h, (await cfg.get()).hash);
    assert.ok(await cfg.needsSave());                                      // the settings moved since the save
    assert.ok(await cfg.apply(wanted, { save: true }));                    // back as wanted, and saved
    assert.ok(config.sameItems(/** @type {config.Item[]} */ (await cfg.items()), wanted) && !(await cfg.needsSave()));
    assert.ok(await cfg.apply([wanted[0]]));                               // the bind unset
    assert.deepEqual((await cfg.items()).map((i) => i.constructor.name), ['Slot']);
    await hst.end();
  }));

test('a refused set changes nothing', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const before = (await cfg.get()).hash;
  // port 1 is vendor bulk, and slot 0 is not there
  await assert.rejects(cfg.set([new Bind({ port: 1, stream: ['slot', 0] })]), Rejected);
  assert.equal((await cfg.get()).hash, before);
  await hst.end();
}));

test('plan, label, idle: the hash moves with the settings', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const want = [new Idle({ channel: 21, mode: 'pull-up' }), new Label({ channel: 20, text: 'DUT TX' }),
    new Plan({ fn: 5, role: 2, channel: 21 }), new Plan({ fn: 5, role: 1, channel: 20 }),
    new Slot({ slot: 1, wireFn: 1, pins: [4, 5], name: 'l103', attach: 'at-boot', retryS: 1, maxSpeed: 1_000_000, idleClock: 'low' })];
  const setHash = await cfg.set(want);
  const got = await cfg.get();
  assert.equal(got.hash, setHash);
  assert.ok(config.sameItems(got.items, want));
  const items = await cfg.items();
  assert.ok(items.some((i) => i instanceof Label && i.channel === 20 && i.text === 'DUT TX'));
  assert.ok(items.some((i) => i instanceof Idle && i.channel === 21 && i.mode === 'pull-up'));
  const slot = /** @type {Slot} */ (items.find((i) => i instanceof Slot));
  assert.deepEqual([slot.maxSpeed, slot.idleClock], [1_000_000, 'low']);
  // unset by key: the rest stays, the hash moves
  const h = await cfg.unset([['slot', 1], ['label', 20]]);
  assert.notEqual(h, setHash);
  assert.ok(config.sameItems((await cfg.get()).items, want.filter((i) => !(i instanceof Slot) && !(i instanceof Label))));
  await cfg.unset([['slot', 1]]);                                           // a key that is not there: nothing, ok
  await cfg.save();
  await cfg.erase();
  const st = await cfg.state();
  assert.deepEqual([st.storage, st.savedHash], ['none', 0]);
  await hst.end();
}));

test('a one-wire slot on the swio probe', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([new Slot({ slot: 0, wireFn: 1, pins: [16, 0xffff], name: 'v003', attach: 'at-boot', retryS: 1 })]);
  const [slot] = /** @type {Slot[]} */ (await cfg.items());
  assert.deepEqual([slot.wireFn, slot.pins], [1, [16, 0xffff]]);
  await hst.end();
}, 'cobs'));

test('slots and a bind the probe booted with', { skip: !haveVirtualBench }, () => withBench(
  ['--profile', 'p4-x035', '--slot', 'x035', '--bind', '0'], async (hst) => {
    const cfg = await ProbeConfig.open(hst);
    const { hash, items } = await cfg.get();
    const [slot, bind] = /** @type {[Slot, Bind]} */ (items.map(([t, v]) => config.decode(t, v)));
    assert.deepEqual([slot.name, slot.pins, slot.attach, slot.retryS, slot.mechanism], ['x035', [2, 54], 'at-boot', 1, 'dmseq']);
    assert.deepEqual([bind.port, bind.stream], [0, ['slot', 0]]);
    const st = await cfg.state();
    assert.equal(st.storage, 'applied');
    assert.equal(st.unreadable, null);
    assert.equal(st.savedHash, hash);                                       // get's hash when the saved settings applied
    assert.equal(st.slots[0].slot, 0);
    assert.deepEqual(st.binds.map((b) => b.port), [0]);
    assert.ok(!(await cfg.needsSave()));
  }));

test('a probe without settings has no oep.probe.config', { skip: !haveVirtualBench }, () => withBench(['--profile', 'rp2350-pins'], async (hst) => {
  await assert.rejects(ProbeConfig.open(hst), OepError);
}));

test('the uart item sets the UART when its plan comes; a session configure wins until the plan goes', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const uart = await FixtureUart.open(hst);
  const fmt = FixtureUart.formatByte(8, 'E', 2);
  const h = await cfg.set([new Uart({ fn: uart.fn, baud: 9600, format: fmt })]);
  assert.equal(h, (await cfg.get()).hash);
  assert.deepEqual((await cfg.items()).filter((i) => i instanceof Uart), [new Uart({ fn: uart.fn, baud: 9600, format: fmt })]);
  const { planApply, planRelease } = await import('../src/core.js');
  assert.deepEqual(await uart.status(), { baud: 115200, format: 0 });      // no plan yet: the default
  await planApply(hst, [[uart.fn, 1, 20], [uart.fn, 2, 21]]);
  assert.deepEqual(await uart.status(), { baud: 9600, format: fmt });      // the item
  await uart.configure(115200);
  assert.deepEqual(await uart.status(), { baud: Math.floor(80_000_000 / Math.floor(80_000_000 / 115200)), format: 0 });   // the session's
  await planRelease(hst, [uart.fn]);
  await planApply(hst, [[uart.fn, 1, 20]]);
  assert.deepEqual(await uart.status(), { baud: 9600, format: fmt });      // the item again
  await cfg.unset([['uart', uart.fn]]);
  assert.deepEqual(await uart.status(), { baud: 115200, format: 0 });      // the item went
  await cfg.set([new Uart({ fn: uart.fn, baud: 9600, format: fmt })]);
  await assert.rejects(cfg.set([new Uart({ fn: uart.fn, baud: 50_000_000 })]), Unsupported);   // more than 5 % off
  await cfg.unset([['uart', uart.fn]]);
  assert.ok(!(await cfg.items()).some((i) => i instanceof Uart));
  await hst.end();
}));

// ---- the disable item (0x07, probe.config §1): a channel the probe never uses or touches ------------------------

/** rejected unavailable with this cause and channel @param {string} cause @param {number} ch */
const refused = (cause, ch) => (/** @type {any} */ e) => e instanceof Unavailable && e.cause === cause && e.channels.includes(ch);

test('the disable item: its value, decode, removal and order', () => {
  const d = new Disable({ channel: 40 });
  assert.equal(config.ITEM.disable, 0x07);
  assert.deepEqual([...config.item(d)], [0x07, 2, 0, 40, 0]);
  assert.deepEqual(config.decode(config.ITEM.disable, d.value()), d);
  assert.deepEqual([...config.remove('disable', 41).encoded()], [3, 0x07, 41, 0]);
  const order = config.ordered([new Disable({ channel: 9 }), new Label({ channel: 1, text: 'NC' }), new Disable({ channel: 3 })]);
  assert.deepEqual(order.map(([t, v]) => [t, v[0]]), [[2, 1], [7, 3], [7, 9]]);
});

test('a disabled channel is refused everywhere with cause 5 and its channel', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const h = await cfg.set([new Disable({ channel: 30 }), new Disable({ channel: 4 }), new Label({ channel: 30, text: 'NC' })]);
  assert.equal(h, (await cfg.get()).hash);
  assert.ok((await cfg.items()).some((i) => i instanceof Disable && i.channel === 30));
  await assert.rejects(planApply(hst, [[4, 1, 30]]), refused('held_by_settings', 30));             // plan_apply
  await assert.rejects(cfg.set([new Plan({ fn: 5, role: 1, channel: 30 })]), refused('held_by_settings', 30));   // a settings plan
  await assert.rejects(cfg.set([new Slot({ slot: 0, wireFn: 1, pins: [4, 5], name: 'b' })]), refused('held_by_settings', 4));
  const wire = await Wire.open(hst);
  await assert.rejects(wire.attach({ pins: [4, 5] }), refused('held_by_settings', 4));            // an attach's pins
  await assert.rejects(wire.scan([[4, 5]]), refused('held_by_settings', 4));                       // scan pairs
  assert.deepEqual((await wire.scan()).map((f) => f.pins), [[2, 3], [6, 7]]);                       // count 0 skips it
  const gpio = await Gpio.open(hst);
  await assert.rejects(gpio.set([[30, Gpio.OUTPUT_HIGH]]), (e) => e instanceof GpioUnavailable && e.cause === 'held_by_settings' && e.index === 0);
  await assert.rejects(gpio.read([30]), refused('held_by_settings', 30));
  await cfg.unset([['disable', 30]]);                                                              // enabled again
  await planApply(hst, [[4, 1, 30]]);
  await hst.end();
}));

test('disabling a channel in use is cause 1; idle and disable on one channel is malformed', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  await planApply(hst, [[4, 1, 30]]);
  await assert.rejects(cfg.set([new Disable({ channel: 30 })]), refused('pin_in_use', 30));
  await planRelease(hst, [4]);
  await cfg.set([new Disable({ channel: 30 })]);
  await assert.rejects(cfg.set([new Idle({ channel: 31 }), new Disable({ channel: 31 })]), (e) => e instanceof Rejected && e.result.detail === m.REJECT.malformed);
  await assert.rejects(cfg.set([new Idle({ channel: 30 })]), (e) => e instanceof Rejected && e.result.detail === m.REJECT.malformed);
  assert.deepEqual((await cfg.items()).filter((i) => i instanceof Idle), []);                      // nothing changed
  await assert.rejects(cfg.set([new Disable({ channel: 24 })]), Unsupported);                      // not a channel it offers
  await hst.end();
}));

test('a disabled reset line', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([new Disable({ channel: 23 })]);
  const wire = await Wire.open(hst, { name: 'oep.wire.swio' });
  await assert.rejects(wire.attachUnderReset(23, { holdMs: 5 }), refused('held_by_settings', 23));
  await hst.end();
}, 'cobs'));

test('idle modes 3 / 4: names, both spellings', () => {
  assert.equal(config.IDLE['output-low'], 3);
  assert.equal(config.IDLE['output-high'], 4);
  assert.deepEqual(new Idle({ channel: 7, mode: 'output_low' }).value(), Uint8Array.of(7, 0, 3, 0xff));   // drive 0xFF: the default (4 bytes)
  assert.equal(new Idle({ channel: 7, mode: 'output_high' }).mode, 'output-high');
  assert.throws(() => new Idle({ channel: 7, mode: 'output-medium' }).value(), RangeError);
  const back = /** @type {Idle} */ (config.decode(config.ITEM.idle, Uint8Array.of(7, 0, 4, 0xff)));
  assert.equal(back.mode, 'output-high');
  assert.equal(back.drive, null);                                    // the default level
});

test('an output idle drives while free, survives the gpio take until the first set, and comes back at release', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([new Idle({ channel: 20, mode: 'output-high' }), new Idle({ channel: 21, mode: 'output-low' }),
    new Label({ channel: 20, text: 'power_hi' })]);
  const gpio = await Gpio.open(hst);
  await planApply(hst, [[gpio.fn, 1, 20], [gpio.fn, 1, 21]]);
  assert.deepEqual(await gpio.read([20, 21]), [1, 0]);                     // taking it changes nothing (fixture §1)
  await gpio.set([[20, Gpio.OUTPUT_LOW]]);
  assert.deepEqual(await gpio.read([20]), [0]);
  await planRelease(hst, [gpio.fn]);
  await planApply(hst, [[gpio.fn, 1, 20]]);
  assert.deepEqual(await gpio.read([20]), [1]);                            // released to the idle, taken in it
  assert.equal(await config.findLine(hst, null, 'power_hi'), 20);
  await hst.end();
}));

const L = (/** @type {number} */ channel, /** @type {string} */ text) => new Label({ channel, text });
const S = (/** @type {number} */ slot, /** @type {string} */ name) => new Slot({ slot, wireFn: 1, pins: [2, 3], name });

test('findLine: <slot>.<name> first, then the bare name on one slot (probe.config §1.3)', async () => {
  const one = [S(0, 'x035'), L(5, 'nrst'), L(6, 'x035.nrst'), L(7, 'power_hi')];
  assert.equal(await config.findLine(one, 'x035', 'nrst'), 6);              // <slot>.<name> first
  assert.equal(await config.findLine(one, null, 'nrst'), 6);                // null: the one slot
  assert.equal(await config.findLine(one, 0, 'nrst'), 6);                   // or its number
  assert.equal(await config.findLine(one, 'x035', 'power_hi'), 7);          // then the bare name (one slot)
  assert.equal(await config.findLine(one, 'x035', 'power_lo'), null);
  assert.equal(await config.findLine([L(7, 'power_lo')], null, 'power_lo'), 7);   // no slot item: the bare name
  await assert.rejects(config.findLine(one, 3, 'nrst'), /no slot 3/);
});

test('findLine ignores ASCII case only', async () => {
  const items = [S(0, 'x035'), L(6, 'X035.NRST'), L(7, 'Power_Hi')];
  assert.equal(await config.findLine(items, 'x035', 'nrst'), 6);
  assert.equal(await config.findLine(items, 'x035', 'POWER_HI'), 7);
  assert.equal(await config.findLine([L(4, 'nrst\u0130')], null, 'nrst\u0069'), null);   // only A-Z fold
  assert.equal(config.foldName('A.Z-az_\u00c9'), 'a.z-az_\u00c9');
});

test('findLine with several slots: no bare name, a slot must be named', async () => {
  const items = [S(0, 'a'), S(1, 'b'), L(5, 'a.nrst'), L(6, 'b.nrst'), L(7, 'power_hi')];
  assert.equal(await config.findLine(items, 'b', 'nrst'), 6);
  assert.equal(await config.findLine(items, 'a', 'power_hi'), null);        // no bare name with two or more slot items
  assert.equal(await config.findLine(items, 'c', 'power_hi'), null);
  await assert.rejects(config.findLine(items, null, 'nrst'), (e) => e instanceof RangeError && /name the slot/.test(e.message));
  assert.equal(/** @type {any} */ (config).AmbiguousLine, undefined);       // gone: ambiguity is no line
});

test('findLine: two or more at one step is no line, without falling through', async () => {
  const two = [S(0, 'a'), L(5, 'a.nrst'), L(6, 'A.Nrst'), L(7, 'nrst')];
  assert.equal(await config.findLine(two, 'a', 'nrst'), null);              // two at the <slot>.<name> step: none (not 7)
  assert.equal(await config.findLine([S(0, 'a'), L(5, 'nrst'), L(6, 'NRST')], 'a', 'nrst'), null);   // two bare ones
  assert.equal(await config.findLine([L(5, 'nrst'), L(6, 'nrst')], null, 'nrst'), null);            // no slot items
  assert.equal(config.lineFromLabels([[5, 'a.nrst'], [6, 'nrst']], 2, 'a', 'nrst'), 5);
  assert.equal(config.lineFromLabels([[6, 'nrst']], 2, 'a', 'nrst'), null);
  assert.equal(config.lineFromLabels([[6, 'nrst'], [6, 'NRST']], 1, 'a', 'nrst'), 6);   // one channel twice: one line
});
