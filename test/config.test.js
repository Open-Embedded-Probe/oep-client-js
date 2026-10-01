// @ts-check
// oep.probe.config (src/config.js) against oep-client-python's fake probe; mirrors its tests/test_config.py as far as
// the TCP fake allows (no reboot / DFU, no CLI).
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
import { haveFake, startFake } from './fake.js';

/** @param {string[]} args @param {'length' | 'cobs'} framing @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withFake(args, body, framing = 'length') {
  const fake = await startFake(args, framing);
  const hst = await openTcp({ port: fake.port, framing });
  try {
    await body(hst);
  } finally {
    await hst.link.close();
    fake.stop();
  }
}

const TID = 0x035e0601;
const lock = { scheme: 1, mask: u32(0xffffff0f), value: u32(TID & 0xffffff0f) };

test('slot and bind values as probe.config §1.1 / §1.2 say, and back', () => {
  const s = new Slot({ slot: 0, wireFn: 1, pins: [2, 54], name: 'x035', attach: 'at-boot', retryS: 1, lock,
    maxSpeed: 1_000_000, idleClock: 'low' });
  const v = s.value();
  // slot wire_fn swdio swclk attach retry_ms(u32) max_speed_hz(u32) idle_clock mechanism name_len (probe.config §1.1)
  assert.deepEqual([...v.slice(0, 19)], [0, 1, 0, 2, 0, 54, 0, 1, 0xe8, 3, 0, 0, 0x40, 0x42, 0x0f, 0, 1, 2, 4]);
  assert.equal(v[23], 9);                                            // lock_len = 1 + 2 * 4
  assert.equal(v.length, 24 + 9);
  const back = /** @type {Slot} */ (config.decode(config.ITEM.slot, v));
  assert.deepEqual(back, s);
  // bytes after the lock are later fields: skipped
  const longer = /** @type {Slot} */ (config.decode(config.ITEM.slot, Uint8Array.from([...v, 0xaa, 0xbb])));
  assert.deepEqual(longer, s);
  // lock_len 0: no lock; retry_s only goes with at-boot
  const plain = new Slot({ slot: 1, wireFn: 1, pins: [16, 0xffff], name: 'v003', retryS: 5 });
  assert.equal(plain.value().at(-1), 0);
  assert.equal(/** @type {Slot} */ (config.decode(config.ITEM.slot, plain.value())).retryS, 0);
  assert.equal(/** @type {Slot} */ (config.decode(config.ITEM.slot, plain.value())).lock, null);
  assert.throws(() => new Slot({ slot: 0, wireFn: 1, pins: [2, 3], name: 'x', lock: { scheme: 1, mask: u32(1), value: new Uint8Array(2) } }).value(), RangeError);
  const b = new Bind({ port: 3, mode: 'manual', streams: [['slot', 0], ['uart', 5]], selected: 1 });
  assert.deepEqual([...b.value()], [3, 1, 1, 2, 3, 1, 0, 0, 3, 2, 5, 0]);
  assert.deepEqual(config.decode(config.ITEM.bind, b.value()), b);
  // a longer stream's tail is skipped (core §2.3); under 3 is not a bind
  assert.deepEqual(/** @type {Bind} */ (config.decode(config.ITEM.bind, Uint8Array.of(0, 2, 0, 1, 5, 1, 0, 0, 0xef, 0xbe))).streams, [['slot', 0]]);
  assert.ok(!(config.decode(config.ITEM.bind, Uint8Array.of(0, 2, 0, 1, 2, 1, 0)) instanceof Bind));
  // removals are unset's keys: len tag key (probe.config §2)
  assert.deepEqual([...config.remove('bind', 3).encoded()], [2, config.ITEM.bind, 3]);
  assert.deepEqual([...config.remove('plan', 0x105).encoded()], [3, config.ITEM.plan, 5, 1]);
  assert.deepEqual([...config.remove('uart', 7).encoded()], [3, config.ITEM.uart, 7, 0]);
  assert.throws(() => config.remove(/** @type {any} */ ('x'), 1), RangeError);
  // a slot without a console; the uart item
  const none = new Slot({ slot: 2, wireFn: 1, pins: [2, 54], name: 'n', mechanism: 'none' });
  assert.equal(none.value()[17], 0xff);
  assert.equal(/** @type {Slot} */ (config.decode(config.ITEM.slot, none.value())).mechanism, 'none');
  const u = new Uart({ fn: 5, baud: 115200, format: FixtureUart.formatByte(8, 'E', 2) });
  assert.deepEqual([...u.value()], [5, 0, 0, 0xc2, 1, 0, 0b010100]);
  assert.deepEqual(config.decode(config.ITEM.uart, u.value()), u);
  assert.deepEqual(config.decode(0x33, Uint8Array.of(1)), { tag: 0x33, value: Uint8Array.of(1) });
});

test('the canonical order and hash (probe.config §2)', () => {
  assert.equal(config.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(config.canonicalHash([]), 0);
  const items = [new Label({ channel: 9, text: 'b' }), new Plan({ fn: 5, role: 2, channel: 21 }),
    new Label({ channel: 3, text: 'a' }), new Plan({ fn: 5, role: 1, channel: 20 }), new Plan({ fn: 5, role: 1, channel: 19 })];
  const order = config.canonical(items).map(([t, v]) => [t, v[0], v[2], v[3]]);
  assert.deepEqual(order, [[1, 5, 1, 19], [1, 5, 1, 20], [1, 5, 2, 21], [2, 3, 97, undefined], [2, 9, 98, undefined]]);   // plan by (fn, role, channel)
  assert.throws(() => config.canonical([/** @type {any} */ (config.remove('slot', 0))]), RangeError);   // a removal is not an item
  // the hash is over the one TLV encoding (core §2.2): a long label goes in the long form
  const long = new Label({ channel: 1, text: 'x'.repeat(300) });
  assert.equal(config.canonicalHash([long]), config.crc32(m.tlv(config.ITEM.label, long.value())));
  // the critical bit is not part of it; the same key twice is refused
  const crit = config.item(new Label({ channel: 3, text: 'a' }));
  crit[0] |= 0x80;
  assert.equal(config.canonicalHash([crit]), config.canonicalHash([new Label({ channel: 3, text: 'a' })]));
  assert.throws(() => config.canonical([new Idle({ channel: 1 }), new Idle({ channel: 1, mode: 'hi-z' })]), RangeError);
});

test('state is paged by first_slot / first_bind and says why storage is unreadable (probe.config §3.3)', async () => {
  /** @type {number[][]} */
  const asked = [];
  const slot = (/** @type {number} */ n) => m.element(new Writer().u8(n).u8(1).u16(0).u64(0xffffffffffffffffn).u8(0).u8(0).raw([0xee]).done());
  const bind = (/** @type {number} */ p) => m.element(new Writer().u8(p).u8(2).u8(0xff).u8(1).done());
  const hst = /** @type {any} */ ({
    /** @param {number} fn @param {number} op @param {Uint8Array} p */
    async call(fn, op, p) {
      asked.push([...p]);
      const head = new Writer().u8(p[0] === 0 ? 1 : 0).u8(2).u32(0x04030201).u8(2).done();
      const body = p[0] === 0 ? [...head, 2, ...slot(0), ...slot(1), 1, ...bind(3)] : [...head, 1, ...slot(2), 0, 0x41, 1, 7];
      return { payload: Uint8Array.from(body) };
    },
  });
  const st = await new ProbeConfig(hst, 6, ProbeConfig.NAME).state();
  assert.deepEqual(asked, [[0, 0], [2, 1]]);
  assert.equal(st.storage, 'unreadable');
  assert.equal(st.savedHash, 0x04030201);
  assert.equal(st.unreadableReason, 2);
  assert.match(/** @type {string} */ (st.unreadable), /gone/);
  assert.deepEqual(st.slots.map((s) => [s.slot, s.state, s.lastTryAtNs, s.targetId]), [[0, 'absent', null, null], [1, 'absent', null, null], [2, 'absent', null, null]]);
  assert.deepEqual(st.binds, [{ port: 3, mode: 'mixed', selected: null, flow: 'streaming' }]);
});

test('slots and binds round trip and show their state', { skip: !haveFake }, () => withFake(
  ['--profile', 'p4-bench', '--target-id', TID.toString(16)], async (hst) => {
    await hst.open(3000);
    const cfg = await ProbeConfig.open(hst);
    await cfg.set([new Slot({ slot: 0, wireFn: 1, pins: [2, 3], name: 'x035', attach: 'at-boot', retryS: 1, lock }),
      new Bind({ port: 3, mode: 'manual', streams: [['slot', 0], ['uart', 5]], selected: 0 })]);
    const items = await cfg.items();
    assert.deepEqual(items.map((i) => i.constructor.name), ['Slot', 'Bind']);
    const [slot, bind] = /** @type {[Slot, Bind]} */ (items);
    assert.equal(slot.name, 'x035');
    assert.deepEqual(slot.lock, lock);
    assert.deepEqual(bind.streams, [['slot', 0], ['uart', 5]]);
    const declared = await cfg.describe();
    assert.equal(declared.slotsMax, 4);
    assert.deepEqual(declared.bindModes, ['last-reset', 'manual', 'mixed']);
    assert.ok(declared.items.includes(config.ITEM.uart));
    const st = await cfg.state();
    assert.equal(st.slots[0].state, 'connected');
    assert.deepEqual(st.slots[0].targetId, u32(TID));
    assert.ok(st.slots[0].lastTryAtNs !== null && st.slots[0].lastTryAtNs >= 0n);   // the probe's clock, ns
    assert.equal(st.binds[0].port, 3);
    assert.equal(st.binds[0].flow, 'streaming');
    const saved = await cfg.save();
    const after = await cfg.state();
    assert.equal(after.savedHash, saved);
    assert.equal(after.storage, 'applied');
    const h = await cfg.set([config.remove('bind', 3)]);                   // goes as an unset
    assert.deepEqual((await cfg.items()).map((i) => i.constructor.name), ['Slot']);
    assert.equal(h, (await cfg.get()).hash);
    // a slot lock whose scheme the wire does not have: unsupported (undefined: malformed)
    await assert.rejects(cfg.set([new Slot({ slot: 1, wireFn: 1, pins: [4, 5], name: 'l', lock: { scheme: 2, mask: u32(1), value: u32(1) } })]), Unsupported);
    await assert.rejects(cfg.set([new Slot({ slot: 1, wireFn: 1, pins: [4, 5], name: 'l', lock: { scheme: 9, mask: u32(1), value: u32(1) } })]),
      (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);
    await hst.end();
  }));

test('a refused set changes nothing', { skip: !haveFake }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const before = (await cfg.get()).hash;
  // port 1 is vendor bulk, and slot 0 is not there
  await assert.rejects(cfg.set([new Bind({ port: 1, mode: 'last-reset', streams: [['slot', 0]] })]), Rejected);
  assert.equal((await cfg.get()).hash, before);
  await hst.end();
}));

test('plan, label, idle and the hash a host computes', { skip: !haveFake }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const want = [new Idle({ channel: 21, mode: 'pull-up' }), new Label({ channel: 20, text: 'DUT TX' }),
    new Plan({ fn: 5, role: 2, channel: 21 }), new Plan({ fn: 5, role: 1, channel: 20 }),
    new Slot({ slot: 1, wireFn: 1, pins: [4, 5], name: 'l103', attach: 'at-boot', retryS: 1, maxSpeed: 1_000_000, idleClock: 'low' })];
  const setHash = await cfg.set(want);
  const got = await cfg.get();
  assert.equal(got.hash, setHash);
  assert.equal(config.canonicalHash(want), got.hash);
  assert.equal(config.canonicalHash(got.items.map(([t, v]) => config.item(/** @type {config.Item} */ (config.decode(t, v))))), got.hash);
  const items = await cfg.items();
  assert.ok(items.some((i) => i instanceof Label && i.channel === 20 && i.text === 'DUT TX'));
  assert.ok(items.some((i) => i instanceof Idle && i.channel === 21 && i.mode === 'pull-up'));
  const slot = /** @type {Slot} */ (items.find((i) => i instanceof Slot));
  assert.deepEqual([slot.maxSpeed, slot.idleClock], [1_000_000, 'low']);
  // unset by key brings the hash back to what the rest gives
  const h = await cfg.unset([['slot', 1], ['label', 20]]);
  assert.equal(h, config.canonicalHash(want.filter((i) => !(i instanceof Slot) && !(i instanceof Label))));
  await cfg.unset([['slot', 1]]);                                           // a key that is not there: nothing, ok
  await cfg.save();
  await cfg.erase();
  const st = await cfg.state();
  assert.deepEqual([st.storage, st.savedHash], ['none', 0]);
  await hst.end();
}));

test('a one-wire slot on the swio probe', { skip: !haveFake }, () => withFake(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  assert.deepEqual((await cfg.describe()).bindModes, ['last-reset', 'manual']);
  await cfg.set([new Slot({ slot: 0, wireFn: 1, pins: [16, 0xffff], name: 'v003', attach: 'at-boot', retryS: 1 })]);
  const [slot] = /** @type {Slot[]} */ (await cfg.items());
  assert.deepEqual([slot.wireFn, slot.pins], [1, [16, 0xffff]]);
  await hst.end();
}, 'cobs'));

test('slots and a bind the probe booted with', { skip: !haveFake }, () => withFake(
  ['--profile', 'p4-x035', '--slot', 'x035', '--bind', 'mixed'], async (hst) => {
    const cfg = await ProbeConfig.open(hst);
    const { hash, items } = await cfg.get();
    assert.equal(config.canonicalHash(items.map(([t, v]) => config.item(/** @type {config.Item} */ (config.decode(t, v))))), hash);
    const [slot, bind] = /** @type {[Slot, Bind]} */ (items.map(([t, v]) => config.decode(t, v)));
    assert.deepEqual([slot.name, slot.pins, slot.attach, slot.retryS, slot.mechanism], ['x035', [2, 54], 'at-boot', 1, 'dmseq']);
    assert.deepEqual([bind.port, bind.mode, bind.streams], [0, 'mixed', [['slot', 0]]]);
    const st = await cfg.state();
    assert.equal(st.storage, 'applied');
    assert.equal(st.unreadable, null);
    assert.equal(st.savedHash, hash);
    assert.equal(st.slots[0].slot, 0);
    assert.equal(st.binds[0].mode, 'mixed');
    assert.equal(st.binds[0].selected, null);
  }));

test('a probe without settings has no oep.probe.config', { skip: !haveFake }, () => withFake(['--profile', 'rp2350-pins'], async (hst) => {
  await assert.rejects(ProbeConfig.open(hst), OepError);
}));

test('the uart item sets the UART when its plan comes; a session configure wins until the plan goes', { skip: !haveFake }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const uart = await FixtureUart.open(hst);
  const fmt = FixtureUart.formatByte(8, 'E', 2);
  const h = await cfg.set([new Uart({ fn: uart.fn, baud: 9600, format: fmt })]);
  assert.equal(h, (await cfg.get()).hash);
  assert.deepEqual((await cfg.items()).filter((i) => i instanceof Uart), [new Uart({ fn: uart.fn, baud: 9600, format: fmt })]);
  const { planApply, planRelease } = await import('../src/core.js');
  assert.equal((await uart.status()).configured, 'default');              // no plan yet: nothing in force
  await planApply(hst, [[uart.fn, 1, 20], [uart.fn, 2, 21]]);
  assert.deepEqual(await uart.status(), { configured: 'item', baud: 9600, format: fmt, isDefault: false });
  await uart.configure(115200);
  const st = await uart.status();
  assert.deepEqual([st.configured, st.baud], ['session', Math.floor(80_000_000 / Math.floor(80_000_000 / 115200))]);
  await planRelease(hst, [uart.fn]);
  await planApply(hst, [[uart.fn, 1, 20]]);
  assert.equal((await uart.status()).baud, 9600);                          // the item again
  assert.equal((await uart.status()).configured, 'item');
  await cfg.unset([['uart', uart.fn]]);
  assert.deepEqual(await uart.status(), { configured: 'default', baud: 115200, format: 0, isDefault: true });   // the item went
  await cfg.set([new Uart({ fn: uart.fn, baud: 9600, format: fmt })]);
  await assert.rejects(cfg.set([new Uart({ fn: uart.fn, baud: 50_000_000 })]), Unsupported);   // more than 5 % off
  await cfg.unset([['uart', uart.fn]]);
  assert.ok(!(await cfg.items()).some((i) => i instanceof Uart));
  await hst.end();
}));

// ---- the disable item (0x07, probe.config §1): a channel the probe never uses or touches ------------------------

/** rejected unavailable with this cause and channel @param {string} cause @param {number} ch */
const refused = (cause, ch) => (/** @type {any} */ e) => e instanceof Unavailable && e.cause === cause && e.channels.includes(ch)
  && (cause !== 'held_by_settings' || e.holderKind === 'disabled');   // holder_kind 6 next to the channel

test('the disable item: its value, decode, removal and hash', () => {
  const d = new Disable({ channel: 40 });
  assert.equal(config.ITEM.disable, 0x07);
  assert.deepEqual([...config.item(d)], [0x07, 2, 40, 0]);
  assert.deepEqual(config.decode(config.ITEM.disable, d.value()), d);
  assert.deepEqual([...config.remove('disable', 41).encoded()], [3, 0x07, 41, 0]);
  const order = config.canonical([new Disable({ channel: 9 }), new Label({ channel: 1, text: 'NC' }), new Disable({ channel: 3 })]);
  assert.deepEqual(order.map(([t, v]) => [t, v[0]]), [[2, 1], [7, 3], [7, 9]]);
});

test('a disabled channel is refused everywhere with cause 5 and its channel', { skip: !haveFake }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  const h = await cfg.set([new Disable({ channel: 30 }), new Disable({ channel: 4 }), new Label({ channel: 30, text: 'NC' })]);
  assert.equal(h, (await cfg.get()).hash);
  assert.equal(config.canonicalHash(/** @type {config.Item[]} */ (await cfg.items())), h);
  assert.ok((await cfg.items()).some((i) => i instanceof Disable && i.channel === 30));
  await assert.rejects(planApply(hst, [[4, 1, 30]]), refused('held_by_settings', 30));             // plan_apply
  await assert.rejects(cfg.set([new Plan({ fn: 5, role: 1, channel: 30 })]), refused('held_by_settings', 30));   // a settings plan
  await assert.rejects(cfg.set([new Slot({ slot: 0, wireFn: 1, pins: [4, 5], name: 'b' })]), refused('held_by_settings', 4));
  const wire = await Wire.open(hst);
  await assert.rejects(wire.attach({ pins: [4, 5] }), refused('held_by_settings', 4));            // an attach's pins
  await assert.rejects(wire.scan([[4, 5]]), refused('held_by_settings', 4));                       // scan pairs
  assert.deepEqual((await wire.scan()).map((f) => f.pins), [[2, 3], [6, 7]]);                       // count 0 skips it
  const gpio = await Gpio.open(hst);
  await assert.rejects(gpio.set([[30, Gpio.OUTPUT_HIGH]]), (e) => e instanceof GpioUnavailable && e.cause === 'held_by_settings' && e.holderKind === 'disabled' && e.index === 0);
  await assert.rejects(gpio.read([30]), refused('held_by_settings', 30));
  await cfg.unset([['disable', 30]]);                                                              // enabled again
  await planApply(hst, [[4, 1, 30]]);
  await hst.end();
}));

test('disabling a channel in use is cause 1; idle and disable on one channel is malformed', { skip: !haveFake }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
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

test('a disabled reset line', { skip: !haveFake }, () => withFake(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([new Disable({ channel: 23 })]);
  const wire = await Wire.open(hst, { name: 'oep.wire.swio' });
  await assert.rejects(wire.attachUnderReset(23, { holdMs: 5 }), refused('held_by_settings', 23));
  await hst.end();
}, 'cobs'));
