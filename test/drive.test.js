// @ts-check
// oep-spec ee562c3: the gpio output strength (fixture §1.1: describe drive_levels, set's drive TLV, the effective
// strength, read's drive TLV), the idle item's drive (probe.config §1), the slot's boot_reset (§1.1) and slot_state's
// reset_at_ns (§3.3), and the at-boot retry with reset (§3.1). Mirrors oep-client-python's
// tests/test_drive_and_boot_reset.py through the TCP fake (fake_serve's --no-drive-levels, --silent-until-reset,
// --boot-reset and --label give a probe without drive_levels and a target that answers only after a reset).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat } from '../src/bytes.js';
import * as config from '../src/config.js';
import { Idle, Label, ProbeConfig, Slot } from '../src/config.js';
import { planApply, planRelease } from '../src/core.js';
import { Rejected } from '../src/errors.js';
import { DRIVE_KIND, Drive, DriveLevels, Gpio } from '../src/fixture.js';
import * as m from '../src/message.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const DRIVE = 0x01;                                    // set's drive TLV / read's answer TLV
const LEVELS = new DriveLevels(2, [5, 10, 20, 40]);
const skip = !haveFake;

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withFake(args, body) {
  const fake = await startFake(args);
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(3000);
    await body(hst);
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
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

/** @param {number} index @param {number} kind @param {number} value @param {boolean} critical */
const driveTlv = (index, kind, value, critical = false) => m.tlv(DRIVE, new Writer().u8(index).u8(kind).u16(value).done(), critical);

/** @param {keyof typeof m.REJECT} reason */
const rejected = (reason) => (/** @type {any} */ e) => e instanceof Rejected && e.reason === m.REJECT[reason];

// ---- the types --------------------------------------------------------------------------------------------------

test('Drive: level / maxMa, a number is a level, kind(u8) value(u16)', () => {
  assert.deepEqual([...Drive.level(3).pack()], [0, 3, 0]);
  assert.deepEqual([...Drive.maxMa(0x1234).pack()], [1, 0x34, 0x12]);
  assert.deepEqual(Drive.of(2), Drive.level(2));
  assert.equal(Drive.of(Drive.maxMa(10)).kind, DRIVE_KIND.max_ma);
  assert.deepEqual(Drive.unpack(Uint8Array.of(1, 10, 0)), Drive.maxMa(10));
  assert.equal(String(Drive.level(1)), 'level 1');
  assert.equal(String(Drive.maxMa(10)), '<= 10 mA');
  assert.deepEqual([...Drive.default().pack()], [2, 0, 0]);                 // kind 2: the default level (fixture §1.1)
  assert.equal(String(Drive.default()), 'default');
  assert.equal(LEVELS.pick(Drive.default()), 2);
  assert.throws(() => new Drive(2, 1).pack(), RangeError);                  // kind 2 carries value 0
  assert.throws(() => new Drive(3, 0).pack(), RangeError);
  assert.throws(() => Drive.level(0x10000).pack(), RangeError);
});

test('DriveLevels.pick', () => {
  assert.deepEqual([0, 4, 5, 15, 20, 39, 40, 1000].map((ma) => LEVELS.pick(Drive.maxMa(ma))), [0, 0, 0, 1, 2, 2, 3, 3]);
  assert.equal(LEVELS.pick(3), 3);
  assert.equal(LEVELS.pick(Drive.level(4)), null);
});

test('setBody: one non-critical drive TLV per element that carries one', () => {
  const body = Gpio.setBody([[20, Gpio.OUTPUT_HIGH, Drive.level(0)], [21, Gpio.OUTPUT_LOW, Drive.maxMa(15)],
    [22, Gpio.OUTPUT_HIGH], [23, Gpio.INPUT_PULLUP, null]]);
  assert.deepEqual(body, concat(Uint8Array.of(4, 20, 0, 4, 21, 0, 3, 22, 0, 4, 23, 0, 1), driveTlv(0, 0, 0), driveTlv(1, 1, 15)));
  assert.deepEqual(Gpio.setBody([[5, 4, 3]]), concat(Uint8Array.of(1, 5, 0, 4), driveTlv(0, 0, 3)));   // a number: a level
});

// ---- describe ---------------------------------------------------------------------------------------------------

test('describe declares the levels on every example profile', { skip }, async () => {
  for (const profile of ['p4-bench', 'p4-x035', 'esp32-v003', 'rp2350-pins']) {
    await withFake(['--profile', profile], async (hst) => {
      const g = await Gpio.open(hst);
      assert.deepEqual(await g.driveLevels(), LEVELS, profile);
      assert.equal(typeof await g.modes(), 'number');
    });
  }
});

// ---- set and read -----------------------------------------------------------------------------------------------

test('set: a drive per element, and readState answers the level in force', { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  const g = await gpioOf(hst, [20, 21, 22, 23]);
  assert.deepEqual(await g.set([[20, Gpio.OUTPUT_HIGH, Drive.level(0)], [21, Gpio.OUTPUT_LOW, Drive.maxMa(15)],
    [22, Gpio.OUTPUT_HIGH], [23, Gpio.INPUT_PULLUP]]), []);
  const st = await g.readState([20, 21, 22, 23]);
  assert.deepEqual(st.levels, [1, 0, 1, 1]);
  assert.deepEqual(st.drive, [0, 1, 2, null]);                     // 22 the default level; 23 not driven: 0xFF
  await g.set([[20, Gpio.OUTPUT_HIGH, 3]]);                        // a number is a level number
  assert.deepEqual((await g.readState([20])).drive, [3]);
  await g.set([[20, Gpio.OPEN_DRAIN_LOW]]);                        // not mode 3 / 4: not driven so
  assert.deepEqual((await g.readState([20])).drive, [null]);
  assert.deepEqual(await g.read([20, 21]), [0, 0]);                // read() stays the levels alone
}));

test('the strength is kept until the next set, which starts again from the idle item or the default', { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await (await ProbeConfig.open(hst)).set([new Idle({ channel: 21, mode: 'output-low', drive: Drive.level(1) })]);
  const g = await gpioOf(hst);
  await g.set([[20, Gpio.OUTPUT_HIGH, 3], [21, Gpio.OUTPUT_HIGH, 3]]);
  await g.set([[22, Gpio.OUTPUT_HIGH]]);                           // another channel's set: 20 / 21 keep theirs
  assert.deepEqual((await g.readState([20, 21, 22])).drive, [3, 3, 2]);
  await g.set([[20, Gpio.OUTPUT_LOW], [21, Gpio.OUTPUT_LOW]]);     // set again without drive: not the last one
  assert.deepEqual((await g.readState([20, 21])).drive, [2, 1]);   // the default; the idle item's drive
}));

test('a plan takes and releases at the idle state\'s strength', { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await (await ProbeConfig.open(hst)).set([new Idle({ channel: 20, mode: 'output-high', drive: Drive.maxMa(10) }),
    new Idle({ channel: 21, mode: 'output-high' }), new Idle({ channel: 22, mode: 'pull-up' })]);
  const g = await gpioOf(hst);
  assert.deepEqual((await g.readState([20, 21, 22])).drive, [1, 2, null]);   // taken: the idle state until the first set
  await g.set([[20, Gpio.OUTPUT_HIGH, 3]]);
  await planApply(hst, [[g.fn, 1, 20], [g.fn, 1, 23]]);            // 20 in both plans: keeps its state and strength
  assert.deepEqual((await g.readState([20])).drive, [3]);
  await planRelease(hst, [g.fn]);
  await gpioOf(hst, [20]);
  assert.deepEqual((await g.readState([20])).drive, [1]);          // released to the idle's, taken in it
}));

for (const [what, tail] of /** @type {[string, Uint8Array][]} */ ([
  ['index n or more', driveTlv(3, 0, 0)],
  ['the same index twice', concat(driveTlv(0, 0, 0), driveTlv(0, 0, 1))],
  ['its element is not mode 3 / 4', driveTlv(1, 0, 0)],
  ['not index kind value', m.tlv(DRIVE, Uint8Array.of(0, 0, 0))],
  ['malformed first, even after an ignored one', concat(driveTlv(0, 0, 9), driveTlv(5, 0, 0))],
  ['malformed before a critical one\'s unsupported', concat(driveTlv(0, 0, 9, true), driveTlv(5, 0, 0))],
])) {
  test(`set's drive malformed rejects the whole request: ${what}`, { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
    const g = await gpioOf(hst);
    await assert.rejects(rawSet(hst, g, [[20, 4], [21, 6], [22, 3]], tail), rejected('malformed'));
    assert.deepEqual((await g.readState([20, 22])).drive, [null, null]);   // nothing applied
  }));
}

test('a drive past the levels is ignored and listed; a critical one is unsupported', { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  await (await ProbeConfig.open(hst)).set([new Idle({ channel: 21, mode: 'output-low', drive: 0 })]);
  const g = await gpioOf(hst);
  assert.deepEqual(await g.set([[20, Gpio.OUTPUT_HIGH, 4], [21, Gpio.OUTPUT_HIGH, Drive.level(9)], [22, Gpio.OUTPUT_HIGH, 1]]),
    [Gpio.TAG_DRIVE, Gpio.TAG_DRIVE]);
  assert.deepEqual((await g.readState([20, 21, 22])).drive, [2, 0, 1]);   // ignored: as if none (default / the idle's)
  await assert.rejects(rawSet(hst, g, [[20, 4]], driveTlv(0, 0, 4, true)), rejected('unsupported'));   // core §2.3
  assert.ok((await rawSet(hst, g, [[20, 4]], driveTlv(0, 0, 3, true))).succeeded);   // a critical one it can honour
}));

test('set lists unknown non-critical TLVs as ignored', { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  const g = await gpioOf(hst);
  const r = await rawSet(hst, g, [[20, 4]], m.tlv(0x22, Uint8Array.of(1)));
  assert.deepEqual(new m.Reader(r.payload).tail().ignored, [0x22]);
}));

test('a probe without drive_levels: none declared, read has no drive, a drive in set is ignored', { skip }, () => withFake(['--profile', 'p4-bench', '--no-drive-levels'], async (hst) => {
  const g = await gpioOf(hst, [20, 21]);
  assert.equal(await g.driveLevels(), null);
  assert.deepEqual(await g.set([[20, Gpio.OUTPUT_HIGH, 1], [21, Gpio.OUTPUT_LOW, Drive.maxMa(5)]]), [DRIVE, DRIVE]);
  const st = await g.readState([20, 21]);
  assert.deepEqual(st.levels, [1, 0]);                             // the modes apply
  assert.equal(st.drive, null);                                    // read carries no drive TLV
  assert.deepEqual(await g.set([[20, Gpio.OUTPUT_LOW]]), []);      // nothing to ignore without a drive
}));

// ---- the idle item's drive --------------------------------------------------------------------------------------

test('the idle item\'s drive encodes and decodes', () => {
  const it = new Idle({ channel: 7, mode: 'output-high', drive: Drive.maxMa(10) });
  assert.deepEqual([...it.value()], [7, 0, 4, 1, 10, 0]);
  assert.deepEqual(config.decode(config.ITEM.idle, it.value()), it);
  assert.deepEqual([...new Idle({ channel: 7, mode: 'output-low', drive: 2 }).value()], [7, 0, 3, 0, 2, 0]);
  assert.equal(/** @type {Idle} */ (config.decode(config.ITEM.idle, Uint8Array.of(7, 0, 4, 2, 0, 0))).drive, null);
  assert.equal(new Idle({ channel: 7 }).drive, null);
  assert.deepEqual([...new Idle({ channel: 7 }).value()], [7, 0, 1, 2, 0, 0]);   // 6 bytes: kind 2, value 0 (§1)
  assert.throws(() => new Idle({ channel: 7, mode: 'pull-up', drive: 1 }).value(), /output-low \/ output-high/);
  assert.throws(() => new Idle({ channel: 7, mode: 'output-high', drive: new Drive(3, 0) }).value(), RangeError);
});

/** @param {number} ch @param {number[]} rest */
const idleTlv = (ch, ...rest) => m.tlv(config.ITEM.idle, Uint8Array.of(ch & 0xff, ch >> 8, ...rest));

for (const [value, reason] of /** @type {[number[], 'malformed' | 'unsupported'][]} */ ([
  [[4], 'malformed'],                                              // 3 bytes: the idle is 6 (probe.config §1)
  [[4, 0], 'malformed'],                                           // 4 bytes
  [[4, 0, 1], 'malformed'],                                        // 5 bytes
  [[4, 3, 0, 0], 'unsupported'],                                   // drive_kind undefined: a later revision's (C-02)
  [[1, 0, 0, 0], 'malformed'],                                     // a drive other than the default on mode 0-2
  [[0, 1, 10, 0], 'malformed'],
  [[4, 2, 1, 0], 'malformed'],                                     // kind 2 with a value other than 0
  [[4, 0, 4, 0], 'unsupported'],                                   // level number = the number of levels
])) {
  test(`idle drive refused ${reason}: ${value.join(' ')}`, { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
    await assert.rejects((await ProbeConfig.open(hst)).set([idleTlv(20, ...value)]), rejected(reason));
  }));
}

test('idle drive forms the probe takes', { skip }, () => withFake(['--profile', 'p4-bench'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([idleTlv(20, 4, 0, 3, 0), idleTlv(21, 3, 1, 1, 0), idleTlv(22, 4, 1, 0xff, 0xff), idleTlv(23, 4, 2, 0, 0)]);
  const idles = /** @type {Idle[]} */ ((await cfg.items()).filter((i) => i instanceof Idle));
  assert.deepEqual(idles.map((i) => i.drive), [Drive.level(3), Drive.maxMa(1), Drive.maxMa(0xffff), null]);   // kind 2: the default
  const g = await gpioOf(hst, [20, 21, 22, 23]);
  assert.deepEqual((await g.readState([20, 21, 22, 23])).drive, [3, 0, 3, 2]);   // a ceiling below every level: level 0
  const r = await hst.call(cfg.fn, ProbeConfig.SET, idleTlv(27, 4, 0, 1, 0, 0xaa));   // 7 bytes: longer than its form
  assert.deepEqual(new m.Reader(r.payload.slice(4)).tail().ignored, [config.ITEM.idle]);   // ignored, not applied (§1)
  await assert.rejects(hst.call(cfg.fn, ProbeConfig.SET, m.tlv(config.ITEM.idle, Uint8Array.of(27, 0, 4, 0, 1, 0, 0xaa), true)),
    rejected('unsupported'));                                      // ... critical: unsupported (core §2.3)
}));

// ---- slot boot_reset ----------------------------------------------------------------------------------------------

const v003 = (/** @type {Partial<ConstructorParameters<typeof Slot>[0]>} */ o = {}) => new Slot({ slot: 0, wireFn: 1,
  pins: [16, 0xffff], name: 'v003', attach: 'at-boot', ...o });

test('slot bootReset goes right after attach and decodes; the item ends with the lock', () => {
  const s = v003({ bootReset: true });
  assert.deepEqual([...s.value().slice(7, 9)], [1, 1]);            // attach at-boot, boot_reset 1
  assert.deepEqual([...s.value().slice(-5)], [...new TextEncoder().encode('v003'), 0]);   // lock_len 0, nothing after
  assert.deepEqual(config.decode(config.ITEM.slot, s.value()), s);
  const lock = { scheme: 1, mask: Uint8Array.of(0xff, 0xff, 0xff, 0xff), value: Uint8Array.of(1, 2, 3, 4) };
  const locked = v003({ bootReset: true, lock });
  assert.deepEqual([...locked.value().slice(-4)], [1, 2, 3, 4]);
  assert.deepEqual(config.decode(config.ITEM.slot, locked.value()), locked);
  const plain = v003();
  assert.equal(plain.value()[8], 0);                               // always there: 0
  assert.equal(/** @type {Slot} */ (config.decode(config.ITEM.slot, plain.value())).bootReset, false);
  assert.throws(() => v003({ attach: 'host', bootReset: true }).value(), /at-boot/);
  assert.equal(config.BOOT_RESET.retry_with_reset, 1);
});

/** A slot item with attach and boot_reset as raw bytes, `extra` after its end. @param {number} attach
 * @param {number} bootReset @param {number[]} extra */
function slotTlv(attach, bootReset, extra = []) {
  const v = v003().value();
  v[7] = attach;
  v[8] = bootReset;
  return m.tlv(config.ITEM.slot, Uint8Array.of(...v, ...extra));
}

test('slot boot_reset: 2 or more, or 1 on a host slot, is malformed', { skip }, () => withFake(['--profile', 'esp32-v003'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  await assert.rejects(cfg.set([slotTlv(1, 2)]), rejected('malformed'));
  await assert.rejects(cfg.set([slotTlv(0, 1)]), rejected('malformed'));
  await cfg.set([slotTlv(0, 0)]);                                  // 0: fine on a host slot
  const r = await hst.call(cfg.fn, ProbeConfig.SET, slotTlv(1, 1, [0x55, 0x66]));   // longer than its form: not applied
  assert.deepEqual(new m.Reader(r.payload.slice(4)).tail().ignored, [config.ITEM.slot]);
  await cfg.set([slotTlv(1, 1)]);
  const [slot] = /** @type {Slot[]} */ ((await cfg.items()).filter((i) => i instanceof Slot));
  assert.equal(slot.bootReset, true);
}));

test('slot_state reset_at_ns is null without a retry with reset; findLine finds the slot\'s nrst on the probe', { skip }, () => withFake(['--profile', 'esp32-v003'], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  await cfg.set([v003({ bootReset: true, retryS: 1 }), new Label({ channel: 23, text: 'V003.NRST' })]);
  const st = await cfg.state();
  assert.equal(st.slots[0].resetAtNs, null);
  assert.equal(await config.findLine(hst, 'v003', 'nrst'), 23);
  assert.equal(await config.findLine(hst, null, 'nrst'), 23);
}));

// ---- the retry with reset (probe.config §3.1) -------------------------------------------------------------------

const SILENT_V003 = ['--profile', 'esp32-v003', '--slot', 'v003', '--silent-until-reset', '0'];   // swio 16, reset 23

test('retry with reset: a target silent until reset attaches after it, and resetAtNs says when', { skip }, () => withFake([...SILENT_V003, '--boot-reset', '--label', '23=v003.nrst'], async (hst) => {
  const [st] = (await (await ProbeConfig.open(hst)).state()).slots;
  assert.equal(st.state, 'connected');
  assert.notEqual(st.connection, 0);
  assert.equal(typeof st.resetAtNs, 'bigint');                     // the probe's clock when it started pulling
  assert.ok(/** @type {bigint} */ (st.resetAtNs) <= /** @type {bigint} */ (st.lastTryAtNs));
}));

test('retry with reset through the firmware label NRST (probe.config §1.3 step (c), PC-1)', { skip }, () => withFake([...SILENT_V003, '--boot-reset'], async (hst) => {
  const [st] = (await (await ProbeConfig.open(hst)).state()).slots;  // no settings label: describe's 23 "NRST" is the line
  assert.equal(st.state, 'connected');
  assert.equal(typeof st.resetAtNs, 'bigint');
}));

for (const [what, args] of /** @type {[string, string[]][]} */ ([
  ['the label ambiguous (two at one step)', ['--boot-reset', '--label', '23=v003.nrst', '--label', '22=V003.NRST']],
  ['the slot does not ask for it', ['--label', '23=v003.nrst']],
])) {
  test(`no retry with reset: ${what}`, { skip }, () => withFake([...SILENT_V003, ...args], async (hst) => {
    const [st] = (await (await ProbeConfig.open(hst)).state()).slots;
    assert.equal(st.state, 'absent');
    assert.equal(st.connection, 0);
    assert.equal(st.resetAtNs, null);
  }));
}
