// @ts-check
// oep.fixture.gpio / uart / i2c-target / spi-target and the I2C decoder: request shapes against a scripted link, and
// the gpio / uart flows against the fake probe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat, fromHex, text, utf8 } from '../src/bytes.js';
import { planApply, planRelease } from '../src/core.js';
import { decodeI2c } from '../src/decode.js';
import { Rejected, Unavailable, Unsupported } from '../src/errors.js';
import { FixtureUart, FixtureUartIO, Gpio, GpioUnavailable, I2cTarget, SpiTarget } from '../src/fixture.js';
import { PositionStream } from '../src/console.js';
import { Host } from '../src/host.js';
import * as m from '../src/message.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const UART = 7, I2C = 11, SPI = 12;

/** @typedef {(p: Uint8Array) => [number, number, Uint8Array]} Handler */
/** @param {Uint8Array} [p] @returns {[number, number, Uint8Array]} */
const ok = (p = new Uint8Array()) => [m.COMPLETED, m.SUCCESS, p];

/** A host over a link that answers each (fn, op) from `handlers` and logs [fn, op, payload].
 * @param {Record<string, Handler>} handlers @param {number} maxFrame */
function scripted(handlers, maxFrame = 1024) {
  /** @type {[number, number, Uint8Array][]} */
  const log = [];
  const link = {
    framing: 'length',
    /** @param {Uint8Array} bytes */
    async send(bytes) {
      const req = m.Request.unpack(bytes);
      log.push([req.fn, req.op, req.payload]);
      const h = handlers[`${req.fn}:${req.op}`];
      const [res, detail, payload] = h ? h(req.payload) : [m.REJECTED, m.REJECT.unknown_operation, new Uint8Array()];
      return new m.Result(req.corr, res, detail, payload).pack();
    },
  };
  const hst = new Host(/** @type {any} */ (link));
  hst.limits = { revision: 1, flags: 0, maxFrame, window: 4096, maxInflight: 4, bootId: 1, tail: new m.Tail() };
  hst.revision = 1;
  for (const [name, fn] of /** @type {[string, number][]} */ ([[FixtureUart.NAME, UART], [I2cTarget.NAME, I2C], [SpiTarget.NAME, SPI]])) {
    hst.fns.set(name, fn);
    hst.revisions.set(fn, 1);
  }
  return { hst, log };
}

/** Log every request the host sends over a real link: [fn, op, payload].
 * @param {Host} hst */
function tap(hst) {
  /** @type {[number, number, Uint8Array][]} */
  const log = [];
  const send = hst.link.send.bind(hst.link);
  hst.link.send = (bytes) => {
    const r = m.Request.unpack(bytes);
    log.push([r.fn, r.op, r.payload]);
    return send(bytes);
  };
  return log;
}

test('i2c-target request and answer shapes', async () => {
  const { hst, log } = scripted({
    [`${I2C}:${I2cTarget.CONFIGURE}`]: () => ok(),
    [`${I2C}:${I2cTarget.PRELOAD_TX}`]: () => ok(Uint8Array.of(2)),
    [`${I2C}:${I2cTarget.READ_RX}`]: () => ok(concat(Uint8Array.of(1), new Writer().u16(3).done(), utf8('abc'), Uint8Array.of(1, 8), new Writer().u64(1234).done())),   // TLV ns
    [`${I2C}:${I2cTarget.STATUS}`]: () => ok(new Writer().u8(1).u8(3).u8(0).u8(1).u32(5).u8(2).u32(0).done()),
    [`${I2C}:${I2cTarget.STRETCH}`]: () => ok(),
  });
  const t = await I2cTarget.open(hst);
  await t.configure(0x42, I2cTarget.MODE_PRELOADED_TX);
  assert.deepEqual(log.at(-1)?.[2], Uint8Array.of(0x42, 3));
  assert.equal(await t.preloadTx(Uint8Array.of(0x11, 0x22)), 2);
  assert.deepEqual(log.at(-1)?.[2], Uint8Array.of(2, 0, 0x11, 0x22));
  const rx = await t.readRx();
  assert.equal(rx.pending, 1);
  assert.equal(text(rx.data), 'abc');
  assert.equal(rx.ns, 1234n);
  assert.equal(t.lastNs, 1234n);
  assert.deepEqual(await t.status(), { state: 1, mode: 3, armed: false, queued: 1, rxFrames: 5, txSlots: 2, errors: 0 });
  await t.stretch(50);
  assert.deepEqual(log.at(-1)?.[2], new Writer().u32(50).done());
  assert.deepEqual(t.assignments(50, 52), [[I2C, 1, 50], [I2C, 2, 52]]);
  await assert.rejects(t.armRx(4), Rejected);                  // not scripted: unknown operation
});

test('i2c-target and spi-target declarations from describe', async () => {
  const { hst } = scripted({});
  /** @type {(tag: number, v: Uint8Array) => [number, Uint8Array]} */
  const tlv = (tag, v) => [tag, v];
  hst.describes.set(I2C, [tlv(0x03, new Writer().u16(128).done()), tlv(0x02, new Writer().u32(1_000_000).done()),
    tlv(0x06, new Writer().u32(0b11).done()), tlv(0x40, Uint8Array.of(8)), tlv(0x41, new Writer().u32(100_000).done())]);
  hst.describes.set(SPI, [tlv(0x03, new Writer().u16(64).done()), tlv(0x40, Uint8Array.of(4))]);
  const t = await I2cTarget.open(hst);
  assert.deepEqual(await t.declarations(), { maxLength: 128, maxClockHz: 1_000_000, features: 0b11, queueDepth: 8, maxStretchUs: 100_000 });
  const s = await SpiTarget.open(hst);
  assert.deepEqual(await s.declarations(), { maxLength: 64, maxClockHz: null, features: 0, queueDepth: 4 });
  hst.describes.set(I2C, [tlv(0x06, new Writer().u32(0b01).done())]);
  assert.equal((await t.declarations()).maxStretchUs, null);   // no features bit1: none declared
});

test('spi-target request and answer shapes', async () => {
  const { hst, log } = scripted({
    [`${SPI}:${SpiTarget.ARM}`]: () => ok(),
    [`${SPI}:${SpiTarget.READ_RX}`]: () => ok(concat(Uint8Array.of(0), new Writer().u32(32).u16(4).done(), fromHex('a55a0f01'))),
    [`${SPI}:${SpiTarget.STATUS}`]: () => ok(new Writer().u8(1).u8(0).u8(1).u8(1).u8(0).u32(9).u32(1).done()),
  });
  const t = await SpiTarget.open(hst);
  await t.arm(4, Uint8Array.of(1, 2));
  assert.deepEqual(log.at(-1)?.[2], Uint8Array.of(4, 0, 2, 0, 1, 2));
  assert.deepEqual(await t.readRx(), { pending: 0, bits: 32, data: fromHex('a55a0f01'), ns: null });
  assert.deepEqual(await t.status(), { state: 1, mode: 0, bitOrder: 1, armed: true, queued: 0, transactions: 9, errors: 1 });
  assert.deepEqual(t.assignments(1, 2, 3, 4), [[SPI, 1, 1], [SPI, 2, 2], [SPI, 3, 3], [SPI, 4, 4]]);
});

test('decodeI2c reads start, a byte with its ACK, and stop', () => {
  const scl = [1, 1], sda = [1, 0];                            // START: SDA falls while SCL high
  for (const bit of [1, 0, 1, 0, 0, 1, 0, 1, 0]) {             // 0xA5, then ACK (0)
    scl.push(0, 0, 1, 1);
    sda.push(sda[sda.length - 1], bit, bit, bit);
  }
  scl.push(0, 1, 1);
  sda.push(0, 0, 1);                                           // STOP: SDA rises while SCL high
  const trace = decodeI2c(scl, sda);
  assert.equal(trace.summary(), 'S a5A P');
  assert.deepEqual(trace.bytes(), [[0xa5, true]]);
  assert.deepEqual(trace.sclPeriods.slice(0, 8), [4, 4, 4, 4, 4, 4, 4, 4]);   // samples between SCL rising edges
});

test('FixtureUartIO write splits and waits for the UART', async () => {
  const taken = [256, 0, 100, 44];                             // a chunk, then nothing once, then the rest
  const { hst, log } = scripted({
    [`${UART}:${FixtureUart.WRITE}`]: (p) => {
      const count = new m.Reader(p).u16();
      assert.equal(p.length, 2 + count);
      const took = Math.min(/** @type {number} */ (taken.shift()), count);
      return [m.COMPLETED, took === count ? m.SUCCESS : m.PARTIAL, new Writer().u16(took).done()];   // partial is no error
    },
  });
  const uart = await FixtureUartIO.open(hst, { fn: UART });
  await uart.write(new Uint8Array(400));
  assert.deepEqual(log.filter(([, op]) => op === FixtureUart.WRITE).map(([, , p]) => p.length - 2), [256, 144, 144, 44]);
});

test('FixtureUart.formatByte', () => {
  assert.equal(FixtureUart.formatByte(), FixtureUart.EIGHT_N_1);
  assert.equal(FixtureUart.formatByte(8, 'E', 2), 0b010100);
  assert.equal(FixtureUart.formatByte(7, 'o', 1), 0b1001);
  assert.throws(() => FixtureUart.formatByte(/** @type {any} */ (9)), RangeError);
});

test('gpio set is a list in order, only planned channels', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(5000);
    const log = tap(hst);
    const g = await Gpio.open(hst);
    await planApply(hst, [[g.fn, 1, 23], [g.fn, 1, 5]]);
    await g.set([[23, Gpio.OPEN_DRAIN_LOW], [5, Gpio.OUTPUT_HIGH], [23, Gpio.OPEN_DRAIN_RELEASE]]);
    assert.deepEqual(log.at(-1)?.[2], Uint8Array.of(3, 23, 0, 5, 5, 0, 4, 23, 0, 6));
    assert.deepEqual(await g.read([23, 5]), [1, 1]);
    const raw = await hst.request(g.fn, Gpio.READ, Uint8Array.of(2, 23, 0, 5, 0), { locked: false });
    assert.deepEqual([...raw.payload], [2, 1, 1]);                        // n(u8) n x level [TLV] (fixture §1)
    await assert.rejects(g.set([[5, 8]]), (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);   // not a defined mode
    const e = await g.set([[5, Gpio.OUTPUT_LOW], [40, Gpio.OUTPUT_LOW]]).then(() => null, (x) => x);
    assert.ok(e instanceof GpioUnavailable && e instanceof Unavailable);
    assert.deepEqual(e.channels, [40]);
    assert.equal(e.index, 1);                                  // the channel and its place in the list (fixture §1)
    assert.deepEqual(await g.read([5]), [1]);                  // nothing done
    await g.pulseLow(23, 0);
    assert.deepEqual(log.slice(-2).map(([, , p]) => Array.from(p)), [[1, 23, 0, 5], [1, 23, 0, 6]]);
    const [released] = await hst.pipeline([g.requestRelease(23)]);
    assert.ok(released.succeeded);
    await planRelease(hst);
    await assert.rejects(g.read([23]), Rejected);
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('uart configure with a format, reads that do not consume, write, marks', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(5000);
    const log = tap(hst);
    const io = await FixtureUartIO.open(hst);
    await planApply(hst, [[io.uart.fn, 1, 20], [io.uart.fn, 2, 21]]);
    assert.equal(await io.configure(115200, FixtureUart.formatByte(8, 'E', 2)), Math.floor(80_000_000 / Math.floor(80_000_000 / 115200)));
    assert.deepEqual(log.at(-2)?.[2].slice(4), Uint8Array.of(0x81, 1, 0b010100));   // format: a critical TLV
    assert.deepEqual(await io.read(), new Uint8Array());
    await assert.rejects(io.uart.configure(9600, 0x01), (e) => e instanceof Unsupported && e.tag === 0x81);   // 7N1: defined, not declared
    await assert.rejects(io.uart.configure(9600, 0x80), (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);   // an undefined bit
    await assert.rejects(io.uart.configure(50_000_000), (e) => e instanceof Unsupported && e.tag === null);   // more than 5 % off
    assert.deepEqual(await io.uart.status(), { configured: 'session', baud: io.baud, format: 0b010100, isDefault: false });
    assert.ok((await io.uart.write(utf8('abc'))) > 0);
    await io.uart.mark(7);
    assert.equal((await io.uart.marks()).at(-1)?.detail, 7);
    await io.uart.clear();
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('uart from a saved plan: RX from the configure on, TX, 64-byte frames', { skip: !haveFake }, async () => {
  const fake = await startFake(['--profile', 'esp32-v003', '--uart-plan', '--uart-rx', 'rx %d\\n', '--every', '10']);
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(3000);
    const log = tap(hst);
    const uart = await FixtureUartIO.open(hst);
    assert.ok(await uart.configure(115200) > 0);               // the saved plan: configure works
    assert.ok(await uart.configure(9600) > 0);                 // and again, while it runs
    const line = text(await uart.readUntil('\n', { timeoutMs: 2000 }));
    assert.match(line, /^rx \d+\n$/);                          // the RX side, from the configure on
    await uart.write(new Uint8Array(120));                     // out on TX
    const writes = log.filter(([fn, op]) => fn === uart.uart.fn && op === FixtureUart.WRITE).map(([, , p]) => p.length);
    const frame = (await hst.confirmed()).maxFrame;
    assert.ok(Math.max(...writes) + 10 <= frame);
    assert.equal(writes.reduce((a, w) => a + w - 2, 0), 120);
    await new Promise((r) => setTimeout(r, 100));
    const got = await uart.read(512);
    assert.ok(got.length > 0 && got.length <= frame - 16);               // 64 - 5 - start 8 - flags 1 - len 2
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('the uart stream is the plan\'s and its position never goes back (fixture §2, common §1.1)', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(5000);
    const uart = await FixtureUart.open(hst);
    await assert.rejects(uart.configure(115200), (e) => e instanceof Unavailable && e.cause === 'wrong_state');   // no plan: no stream
    await assert.rejects(uart.read(), Unavailable);
    assert.equal((await uart.status()).configured, 'default');
    await planApply(hst, [[uart.fn, 1, 20]]);                              // RX only: the stream is there, 115200 8N1 by default
    assert.deepEqual(await uart.status(), { configured: 'default', baud: 115200, format: 0, isDefault: true });
    await uart.mark(1);
    const before = (await uart.read(PositionStream.FROM_NOW, 0, 0)).start;
    await planRelease(hst, [uart.fn]);
    await assert.rejects(uart.read(), Unavailable);
    await planApply(hst, [[uart.fn, 1, 20], [uart.fn, 2, 21]]);
    const chunk = await uart.read(PositionStream.FROM_OLDEST);
    assert.equal(chunk.start, before);                                     // from where it left off, nothing kept
    assert.equal(chunk.data.length, 0);
    await uart.mark(2);
    assert.deepEqual((await uart.marks()).map((k) => k.serial), [1]);     // the serials go on too
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});
