// @ts-check
// oep.probe.config (src/config.js) against oep-client-python's fake probe; mirrors its tests/test_config.py as far as
// the TCP fake allows (no reboot / DFU, no CLI).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { u32 } from '../src/bytes.js';
import * as config from '../src/config.js';
import { Bind, Idle, Label, Plan, ProbeConfig, Slot } from '../src/config.js';
import { Rejected, OepError } from '../src/errors.js';
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
  assert.deepEqual([...v.slice(0, 17)], [0, 1, 0, 2, 0, 54, 0, 1, 1, 0, 0x40, 0x42, 0x0f, 0, 1, 2, 4]);
  assert.equal(v[21], 9);                                            // lock_len = 1 + 2 * 4
  assert.equal(v.length, 22 + 9);
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
  assert.deepEqual([...b.value()], [3, 1, 1, 2, 1, 0, 0, 2, 5, 0]);
  assert.deepEqual(config.decode(config.ITEM.bind, b.value()), b);
  assert.deepEqual([...config.remove('bind', 3)], [config.ITEM.bind, 1, 3]);
  assert.deepEqual([...config.remove('plan', 0x105)], [config.ITEM.plan, 2, 5, 1]);
  assert.deepEqual(config.decode(0x33, Uint8Array.of(1)), { tag: 0x33, value: Uint8Array.of(1) });
});

test('the canonical order and hash (probe.config §2)', () => {
  assert.equal(config.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(config.canonicalHash([]), 0);
  const items = [new Label({ channel: 9, text: 'b' }), new Plan({ fn: 5, role: 2, channel: 21 }),
    new Label({ channel: 3, text: 'a' }), new Plan({ fn: 5, role: 1, channel: 20 }), config.remove('slot', 0)];
  const order = config.canonical(items).map(([t, v]) => [t, v[0], v[2]]);
  assert.deepEqual(order, [[1, 5, 1], [1, 5, 2], [2, 3, 97], [2, 9, 98]]);
  // the critical bit is not part of it; the same key twice is refused
  const crit = config.item(new Label({ channel: 3, text: 'a' }));
  crit[0] |= 0x80;
  assert.equal(config.canonicalHash([crit]), config.canonicalHash([new Label({ channel: 3, text: 'a' })]));
  assert.throws(() => config.canonical([new Idle({ channel: 1 }), new Idle({ channel: 1, mode: 'hi-z' })]), RangeError);
});

test('the unreadable reason is the last byte of storage', async () => {
  const storage = Uint8Array.from([0, 16, 0, 0, 2, 1, 2, 3, 4, 20, 0, 0, 0, 2]);
  const payload = Uint8Array.from([0, 0x40, storage.length, ...storage]);
  const hst = /** @type {any} */ ({ request: async () => ({ payload }) });
  const st = await new ProbeConfig(hst, 6, ProbeConfig.NAME).state();
  assert.equal(st.storage, 'unreadable');
  assert.equal(st.storageBytes, 4096);
  assert.equal(st.savedHash, 0x04030201);
  assert.equal(st.saveMaxMs, 20);
  assert.equal(st.unreadableReason, 2);
  assert.match(/** @type {string} */ (st.unreadable), /gone/);
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
    const st = await cfg.state();
    assert.equal(st.slotsMax, 4);
    assert.deepEqual(st.bindModes, ['last-reset', 'manual', 'mixed']);
    assert.equal(st.slots[0].state, 'connected');
    assert.deepEqual(st.slots[0].targetId, u32(TID));
    assert.equal(st.binds[0].port, 3);
    assert.equal(st.binds[0].flow, 'streaming');
    const saved = await cfg.save();
    const after = await cfg.state();
    assert.equal(after.savedHash, saved);
    assert.equal(after.storage, 'applied');
    await cfg.set([config.remove('bind', 3)]);
    assert.deepEqual((await cfg.items()).map((i) => i.constructor.name), ['Slot']);
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
  // removing a key brings the hash back to what the rest gives
  const h = await cfg.set([config.remove('slot', 1), config.remove('label', 20)]);
  assert.equal(h, config.canonicalHash(want.filter((i) => !(i instanceof Slot) && !(i instanceof Label))));
  await cfg.save();
  await cfg.erase();
  assert.equal((await cfg.state()).storage, 'none');
  await hst.end();
}));

test('a one-wire slot on the swio probe', { skip: !haveFake }, () => withFake(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const cfg = await ProbeConfig.open(hst);
  assert.deepEqual((await cfg.state()).bindModes, ['last-reset', 'manual']);
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
