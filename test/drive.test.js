// @ts-check
// oep-spec 0f455a0: the gpio output strength (fixture §1.1: describe drive_levels, set's drive TLV index(u8) level(u8);
// read carries no drive TLV), the idle item's drive (probe.config §1: 4 bytes, drive(u8)), the slot item without
// boot_reset / lock (§1.1) and slot_state's 12-byte form, connected / absent (§3.3). Mirrors oep-client-python's
// tests/test_drive_and_slots.py through the TCP virtual bench (virtual_bench_serve's --no-drive-levels,
// --silent-until-reset and --label give a probe without drive_levels and a target that answers only after a reset).
// The strength in force is the virtual bench's inner state: over TCP only what the wire says is checked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat } from '../src/bytes.js';
import * as config from '../src/config.js';
import { Idle, Label, ProbeConfig, Slot } from '../src/config.js';
import { planApply } from '../src/core.js';
import { Rejected, Unsupported } from '../src/errors.js';
import { DRIVE_DEFAULT, Drive, DriveLevels, Gpio } from '../src/fixture.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const DRIVE = 0x01;                                    // set's drive TLV
const LEVELS = new DriveLevels(2, [5, 10, 20, 40]);
const skip = !haveVirtualBench;

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withBench(args, body) {
  const bench = await startVirtualBench(args);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    await body(hst);
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

/** @param {import('../src/host.js').Host} hst @param {number[]} channels */
async function gpioOf(hst, channels = [20, 21, 22]) {
  const g = await Gpio.open(hst);
  await planApply(hst, channels.map((ch) => /** @type {[number, number, number]} */ ([g.fn, 1, ch])));
  return g;
}

/** A set request as raw bytes: n x (channel mode), then `tail`.
 * @param {import('../src/host.js').Host} hst @param {Gpio} g @param {[number, number][]} pairs @param {Uint8Array} tail */
function rawSet(hst, g, pairs, tail = new Uint8Array()) {
  return hst.call(g.fn, Gpio.SET, concat(Gpio.setBody(pairs), tail));
}

/** read's raw answer. @param {import('../src/host.js').Host} hst @param {Gpio} g @param {number[]} channels */
async function rawRead(hst, g, channels) {
  const w = new Writer().u8(channels.length);
  for (const c of channels) w.u16(c);
  return [...(await hst.request(g.fn, Gpio.READ, w.done(), { locked: false })).payload];
}

/** @param {number} index @param {number} level @param {boolean} critical */
const driveTlv = (index, level, critical = false) => m.tlv(DRIVE, Uint8Array.of(index, level), critical);

/** @param {keyof typeof m.REJECT} reason */
const rejected = (reason) => (/** @type {any} */ e) => e instanceof Rejected && e.reason === m.REJECT[reason];

// ---- the types --------------------------------------------------------------------------------------------------

test('Drive is a level number (u8), 0xFF the default; DriveLevels.atMost carries an mA between probes', () => {
  assert.deepEqual([0, 4, 5, 15, 20, 39, 40, 1000].map((ma) => LEVELS.atMost(ma)), [0, 0, 0, 1, 2, 2, 3, 3].map((n) => Drive.level(n)));
  assert.equal(LEVELS.pick(3), 3);
  assert.equal(LEVELS.pick(Drive.level(4)), null);
  assert.equal(LEVELS.pick(Drive.default()), 2);
  assert.deepEqual([...Drive.level(3).pack()], [3]);
  assert.deepEqual([...Drive.default().pack()], [0xff]);
  assert.equal(DRIVE_DEFAULT, 0xff);
  assert.ok(Drive.default().isDefault);
  assert.deepEqual(Drive.unpack(Uint8Array.of(1)), Drive.level(1));
  assert.deepEqual(Drive.of(2), Drive.level(2));
  assert.equal(String(Drive.level(1)), 'level 1');
  assert.equal(String(Drive.default()), 'default');
  assert.throws(() => Drive.level(0xff), RangeError);              // 0xFF is the default, not a level number
  assert.throws(() => new Drive(0x100).pack(), RangeError);
  assert.equal(/** @type {any} */ (Drive).maxMa, undefined);
});

test('setBody: one critical drive TLV, index(u8) level(u8), per element that carries one', () => {
  const body = Gpio.setBody([[20, Gpio.OUTPUT_HIGH, Drive.level(0)], [21, Gpio.OUTPUT_LOW, 1],
    [22, Gpio.OUTPUT_HIGH], [23, Gpio.INPUT_PULLUP, null]]);
  assert.deepEqual(body, concat(Uint8Array.of(4, 20, 0, 4, 21, 0, 3, 22, 0, 4, 23, 0, 1), driveTlv(0, 0, true), driveTlv(1, 1, true)));
  assert.deepEqual(Gpio.setBody([[5, 4, Drive.default()]]), concat(Uint8Array.of(1, 5, 0, 4), driveTlv(0, 0xff, true)));
  assert.equal(/** @type {any} */ (Gpio).INPUT_PULLUP_PULLDOWN, undefined);   // mode 7 gone (fixture §1)
  assert.equal(/** @type {any} */ (reg.FIXTURE_GPIO.enum.mode).input_pullup_pulldown, undefined);
});

// ---- describe, set and read ---------------------------------------------------------------------------------------

test('describe declares the levels on every example profile; --no-drive-levels none', { skip }, async () => {
  for (const profile of ['p4-bench', 'p4-x035', 'esp32-v003', 'rp2350-pins']) {
    await withBench(['--profile', profile], async (hst) => {
      const g = await Gpio.open(hst);
      assert.deepEqual(await g.driveLevels(), LEVELS, profile);
      assert.equal(typeof await g.modes(), 'number');
    });
  }
  await withBench(['--profile', 'p4-bench', '--no-drive-levels'], async (hst) => {
    assert.equal(await (await Gpio.open(hst)).driveLevels(), null);
  });
});

test('set: a drive per element; read has no drive TLV', { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const g = await gpioOf(hst, [20, 21, 22, 23]);
  assert.equal(await g.set([[20, Gpio.OUTPUT_HIGH, Drive.level(0)], [21, Gpio.OUTPUT_LOW, 1], [22, Gpio.OUTPUT_HIGH],
    [23, Gpio.INPUT_PULLUP]]), undefined);
  assert.deepEqual(await rawRead(hst, g, [20, 21, 22, 23]), [4, 1, 0, 1, 1]);   // n(u8) n x level, no drive TLV (fixture §1)
  assert.deepEqual(await g.read([20, 21]), [1, 0]);
  await g.set([[20, Gpio.OUTPUT_HIGH, Drive.default()]]);         // 0xFF: the default level
  await g.set([[20, Gpio.OPEN_DRAIN_LOW]]);
  assert.deepEqual(await g.read([20]), [0]);
  assert.equal(/** @type {any} */ (g).readState, undefined);
}));

for (const critical of [false, true]) {
  for (const [what, raw] of /** @type {[string, Uint8Array][]} */ ([
    ['index n or more', driveTlv(3, 0)],
    ['the same index twice', concat(driveTlv(0, 0), driveTlv(0, 1))],
    ['its element is not mode 3 / 4', driveTlv(1, 0)],
    ['not index level: another length', m.tlv(DRIVE, Uint8Array.of(0))],
    ['longer too (core §2.3)', m.tlv(DRIVE, Uint8Array.of(0, 0, 0))],
  ])) {
    test(`set's drive malformed rejects the whole request, critical ${critical}: ${what}`, { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
      const g = await gpioOf(hst);
      await g.set([[20, Gpio.OUTPUT_LOW]]);
      const tail = Uint8Array.from(raw);
      if (critical) tail[0] |= 0x80;                               // an implemented TLV: checked the same with bit 7
      await assert.rejects(rawSet(hst, g, [[20, 4], [21, 6], [22, 3]], tail), rejected('malformed'));
      assert.deepEqual(await g.read([20]), [0], 'nothing applied');   // 20 stays low
    }));
  }
}

test('a drive past the levels is unsupported with the tag as received, bit 7 or not; 0xFF is the default', { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const g = await gpioOf(hst);
  for (const critical of [false, true]) {
    for (const level of [4, 9, 0xfe]) {
      await assert.rejects(rawSet(hst, g, [[20, 4], [21, 3]], concat(driveTlv(0, 1), driveTlv(1, level, critical))),
        (e) => e instanceof Unsupported && e.tag === (DRIVE | (critical ? 0x80 : 0)));
      await assert.rejects(g.set([[20, Gpio.OUTPUT_HIGH, level]]), Unsupported);   // the client's own set: the same
    }
    assert.ok((await rawSet(hst, g, [[20, 4]], driveTlv(0, 0xff, critical))).succeeded);
  }
}));

test('set ignores an unknown TLV silently and refuses an unknown critical one (core §2.3)', { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const g = await gpioOf(hst);
  const r = await rawSet(hst, g, [[20, 4]], m.tlv(0x22, Uint8Array.of(1)));
  assert.ok(r.succeeded && r.payload.length === 0);
  await assert.rejects(rawSet(hst, g, [[20, 3]], m.tlv(0x22, Uint8Array.of(1), true)), (e) => e instanceof Unsupported && e.tag === 0xa2);
  assert.deepEqual(await g.read([20]), [1]);                       // still high: the refused set changed nothing
}));

test('a probe without drive_levels refuses every drive; a set without one works', { skip }, () => withBench(['--profile', 'p4-bench', '--no-drive-levels'], async (hst) => {
  const g = await gpioOf(hst, [20, 21]);
  for (const level of [0, 1, 0xff]) {
    for (const critical of [false, true]) {
      await assert.rejects(rawSet(hst, g, [[20, 4]], driveTlv(0, level, critical)),
        (e) => e instanceof Unsupported && e.tag === (DRIVE | (critical ? 0x80 : 0)));
    }
  }
  await assert.rejects(g.set([[20, Gpio.OUTPUT_HIGH, 1]]), Unsupported);
  await g.set([[20, Gpio.OUTPUT_HIGH], [21, Gpio.OUTPUT_LOW]]);
  assert.deepEqual(await rawRead(hst, g, [20, 21]), [2, 1, 0]);
}));

// ---- the idle item's drive --------------------------------------------------------------------------------------

test('the idle item is 4 bytes: channel(u16) mode(u8) drive(u8), 0xFF the default (probe.config §1)', () => {
  const it = new Idle({ channel: 7, mode: 'output-high', drive: Drive.level(1) });
  assert.deepEqual([...it.value()], [7, 0, 4, 1]);
  assert.deepEqual(config.decode(config.ITEM.idle, it.value()), it);
  assert.deepEqual([...new Idle({ channel: 7, mode: 'output-low', drive: 2 }).value()], [7, 0, 3, 2]);
  assert.deepEqual([...new Idle({ channel: 7, mode: 'pull-up' }).value()], [7, 0, 1, 0xff]);
  assert.deepEqual([...new Idle({ channel: 7, mode: 'output-high' }).value()], [7, 0, 4, 0xff]);
  assert.equal(/** @type {Idle} */ (config.decode(config.ITEM.idle, Uint8Array.of(7, 0, 4, 0xff))).drive, null);   // the default
  assert.deepEqual([...new Idle({ channel: 7, mode: 'output-high', drive: Drive.default() }).value()], [7, 0, 4, 0xff]);
  assert.throws(() => new Idle({ channel: 7, mode: 'pull-up', drive: 1 }).value(), /output-low \/ output-high/);
});

/** @param {number} ch @param {number[]} rest @param {boolean} [critical] */
const idleTlv = (ch, rest, critical = false) => m.tlv(config.ITEM.idle, Uint8Array.of(ch & 0xff, ch >> 8, ...rest), critical);

for (const critical of [false, true]) {
  for (const [value, reason] of /** @type {[number[], 'malformed' | 'unsupported'][]} */ ([
    [[4], 'malformed'],                                            // 3 bytes: the idle is 4 (probe.config §1)
    [[4, 0, 0], 'malformed'],                                      // 5 bytes: longer than its one form, too
    [[4, 1, 0xaa, 0], 'malformed'],
    [[4, 4], 'unsupported'],                                       // a level = the number of levels
    [[3, 9], 'unsupported'],
    [[4, 0xfe], 'unsupported'],
  ])) {
    test(`idle drive refused ${reason}, critical ${critical}: ${value.join(' ')}`, { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
      const cfg = await ProbeConfig.open(hst);
      await assert.rejects(cfg.set([idleTlv(20, value, critical)]), (e) => rejected(reason)(e)
        && (reason !== 'unsupported' || /** @type {Unsupported} */ (e).tag === (config.ITEM.idle | (critical ? 0x80 : 0))));
      assert.deepEqual((await cfg.items()).filter((i) => i instanceof Idle), []);
    }));
  }
}

test('idle drive forms the probe takes; an input idle\'s drive is not looked at', { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([idleTlv(20, [4, 3]), idleTlv(21, [3, 0]), idleTlv(22, [4, 0xff]), idleTlv(26, [1, 5]), idleTlv(27, [2, 0xff])]);
  const idles = /** @type {Idle[]} */ ((await cfg.items()).filter((i) => i instanceof Idle));
  assert.deepEqual(idles.map((i) => [i.channel, i.mode]), [[20, 'output-high'], [21, 'output-low'], [22, 'output-high'], [26, 'pull-up'], [27, 'pull-down']]);
  const g = await gpioOf(hst, [20, 21, 22]);
  assert.deepEqual(await g.read([20, 21, 22]), [1, 0, 1]);         // taken in their idle state
}));

test('a probe without drive_levels refuses an output idle\'s drive', { skip }, () => withBench(['--profile', 'p4-bench', '--no-drive-levels'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  await assert.rejects(cfg.set([new Idle({ channel: 20, mode: 'output-high', drive: Drive.level(0) })]),
    (e) => e instanceof Unsupported && e.tag === config.ITEM.idle);
  await cfg.set([new Idle({ channel: 20, mode: 'output-high' }), idleTlv(21, [1, 3])]);
  await assert.rejects(cfg.set([idleTlv(22, [4, 0xff, 0])]), rejected('malformed'));   // the form rules still hold
}));

// ---- the slot item and slot_state ---------------------------------------------------------------------------------

const v003 = (/** @type {Partial<ConstructorParameters<typeof Slot>[0]>} */ o = {}) => new Slot({ slot: 0, wireFn: 1,
  pins: [16, 0xffff], name: 'v003', attach: 'at-boot', ...o });

test('the slot item has no boot_reset or lock (probe.config §1.1)', () => {
  const s = v003({ retryS: 1.5, maxSpeed: 1_000_000 });
  assert.deepEqual(s.value(), concat(new Writer().u8(0).u16(1).u16(16).u16(0xffff).u8(1).u32(1500).u32(1_000_000).u8(0).u8(2).u8(4).done(),
    new TextEncoder().encode('v003')));
  assert.deepEqual(config.decode(config.ITEM.slot, s.value()), s);
  assert.deepEqual([...v003({ attach: 'host', retryS: 3 }).value().slice(8, 12)], [0, 0, 0, 0]);   // retry_ms 0 on a host slot
  assert.equal(/** @type {any} */ (config).BOOT_RESET, undefined);
  assert.deepEqual(reg.PROBE_CONFIG.enum.slot_state, { connected: 0, absent: 1 });
});

test('a slot item of another length is malformed, critical or not; retry_ms is not looked at on a host slot', { skip }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  const v = v003({ attach: 'host' }).value();
  for (const bad of [concat(v, Uint8Array.of(0x55)), v.slice(0, -1), concat(v, Uint8Array.of(1, 1, 2, 3, 4))]) {
    for (const critical of [false, true]) {
      await assert.rejects(cfg.set([m.tlv(config.ITEM.slot, bad, critical)]), rejected('malformed'));
    }
  }
  assert.deepEqual(await cfg.items(), []);
  const hostRetry = Uint8Array.from(v);
  new DataView(hostRetry.buffer).setUint32(8, 1000, true);         // retry_ms on a host slot: accepted, not used
  await cfg.set([m.tlv(config.ITEM.slot, hostRetry)]);
  const [slot] = /** @type {Slot[]} */ (await cfg.items());
  assert.equal(slot.attach, 'host');
}));

const SILENT_V003 = ['--profile', 'esp32-v003', '--slot', 'v003', '--silent-until-reset', '0'];   // swio 16, reset 23

test('an at-boot slot never resets its target: a silent one stays absent (probe.config §3.1); slot_state is 12 bytes', { skip }, () => withBench([...SILENT_V003, '--label', '23=v003.nrst'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  const p = (await hst.call(cfg.fn, ProbeConfig.STATE, Uint8Array.of(0, 0), { locked: false })).payload;
  assert.equal(p[7], 1);                                           // one slot_state ...
  assert.equal(p.length, 8 + 12 + 1);                              // ... of 12 bytes, then no bind
  const [st] = (await cfg.state()).slots;
  assert.deepEqual([st.state, st.connection], ['absent', 0]);
  assert.ok(st.lastTryAtNs !== null);
  assert.ok(!('resetAtNs' in st) && !('targetId' in st));
  assert.equal(await config.findLine(hst, 'v003', 'nrst'), 23);    // the host's own reset goes through its line
  assert.equal(await config.findLine(hst, null, 'nrst'), 23);
  await cfg.set([new Label({ channel: 22, text: 'x' })]);
}));
