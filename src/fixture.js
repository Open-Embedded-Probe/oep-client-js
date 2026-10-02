// @ts-check
// oep.fixture.gpio, oep.fixture.uart, oep.fixture.i2c-target and oep.fixture.spi-target, revision 1 (oep-spec
// oep-if-fixture). The capture is in `capture` (oep.fixture.logic / analog).
//
// Plan roles: gpio 1 = line; uart 1 = RX, 2 = TX; i2c-target 1 = SDA, 2 = SCL; spi-target 1 = SCK, 2 = MOSI,
// 3 = MISO, 4 = CS. Only channels the plan assigned can be used.

import * as reg from './registry.js';
import { Writer, concat, getU32, getU64 } from './bytes.js';
import * as m from './message.js';
import { Unavailable } from './errors.js';
import { Interface, describe } from './core.js';
import { CRITICAL, decodeDescription } from './catalog.js';
import { PositionStream, StreamIO } from './console.js';

const GPIO = reg.FIXTURE_GPIO, UART = reg.FIXTURE_UART, I2C = reg.FIXTURE_I2C_TARGET, SPI = reg.FIXTURE_SPI_TARGET;
const MODE = GPIO.enum.mode;
const TAG_INDEX = GPIO.tlv.unavailable_payload.index;   // 0x40: the list position of what was refused

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fixture.gpio's rejected unavailable (fixture §1): `channels` (core §4.3) and `index`, where in the set list the
 * refused channel stood (TLV 0x40). */
export class GpioUnavailable extends Unavailable {
  /** Every index TLV, in order. */
  get indexes() { return this.tlvs.filter(([t, v]) => (t & 0x7f) === TAG_INDEX && v.length >= 1).map(([, v]) => v[0]); }
  /** The first index (none: null). */
  get index() { return this.indexes[0] ?? null; }
}

/**
 * oep.fixture.gpio. `set` applies [channel, mode] pairs in order in one request (pull NRST, then release it); a
 * channel the plan did not assign or a mode the probe lacks rejects the whole list as unavailable (GpioUnavailable:
 * .channels, and its position .index, TLV 0x40). The open-drain modes never drive a line high: the way to move a
 * target's reset line.
 */
export class Gpio extends Interface {
  static NAME = 'oep.fixture.gpio';
  static REVISION = 1;
  static SET = GPIO.op.set;
  static READ = GPIO.op.read;
  static INPUT = MODE.input;
  static INPUT_PULLUP = MODE.input_pullup;
  static INPUT_PULLDOWN = MODE.input_pulldown;
  static OUTPUT_LOW = MODE.output_low;
  static OUTPUT_HIGH = MODE.output_high;
  static OPEN_DRAIN_LOW = MODE.open_drain_low;
  static OPEN_DRAIN_RELEASE = MODE.open_drain_release;
  static INPUT_PULLUP_PULLDOWN = MODE.input_pullup_pulldown;   // both pulls: a weak mid level

  /** @param {[number, number][]} pairs */
  static setBody(pairs) {
    const w = new Writer().u8(pairs.length);
    for (const [ch, mode] of pairs) w.u16(ch).u8(mode);
    return w.done();
  }

  /** [channel, mode] pairs, applied in order. @param {[number, number][]} pairs */
  async set(pairs) {
    try {
      await this.call(Gpio.SET, Gpio.setBody(pairs));
    } catch (e) {
      if (e instanceof Unavailable && !(e instanceof GpioUnavailable)) throw new GpioUnavailable(e.result);
      throw e;
    }
  }

  /** @param {number} channel @param {number} mode */
  configure(channel, mode) { return this.set([[channel, mode]]); }

  /** -> one level (0 / 1) per channel. Lock-free. The answer is n(u8) n x level [TLV] (fixture §1).
   * @param {number[]} channels */
  async read(channels) {
    const w = new Writer().u8(channels.length);
    for (const c of channels) w.u16(c);
    const rd = new m.Reader((await this.call(Gpio.READ, w.done(), { locked: false })).payload);
    const levels = Array.from(rd.counted(1));
    rd.tail();
    return levels;
  }

  /** @param {number} channel */
  pullLow(channel) { return this.set([[channel, Gpio.OPEN_DRAIN_LOW]]); }

  /** @param {number} channel */
  release(channel) { return this.set([[channel, Gpio.OPEN_DRAIN_RELEASE]]); }

  /** The release as a raw request, to pipeline (Host.pipeline) with whatever must follow it at once.
   * @param {number} channel */
  requestRelease(channel) { return this.req(Gpio.SET, Gpio.setBody([[channel, Gpio.OPEN_DRAIN_RELEASE]])); }

  /** Open-drain low, then released to Hi-Z (never driven high). @param {number} channel @param {number} lowMs */
  async pulseLow(channel, lowMs = 20) {
    await this.pullLow(channel);
    try {
      await sleep(lowMs);
    } finally {
      await this.release(channel);
    }
  }
}

/** oep.fixture.uart status (op 0x07, lock-free): what is in force - 'default' (115200 8N1, nothing set), 'session' (a
 * configure), 'item' (the settings' uart item), 'item_fallback' (the item's baud could not be made when the plan ran
 * the UART: the default applies) - and the baud / format it runs with. isDefault: default or item_fallback.
 * @typedef {{ configured: string, baud: number, format: number, isDefault: boolean }} UartStatus */

/** The status's configured byte -> its name (registry uart_configured). @type {Record<number, string>} */
export const UART_CONFIGURED = Object.fromEntries(Object.entries(UART.enum.uart_configured).map(([k, v]) => [v, k]));

/**
 * oep.fixture.uart: one position stream per fn, like the console without a stream number. The stream exists while
 * the plan gives the fn RX or TX; received bytes are kept from then on, whatever the session, and the position never
 * goes back within one boot (a plan released and applied again carries on). Reads are lock-free and do not consume.
 * TX idles high while planned, before configure too.
 */
export class FixtureUart extends PositionStream {
  static NAME = 'oep.fixture.uart';
  static REVISION = 1;
  static CONFIGURE = UART.op.configure;
  static STATUS = UART.op.status;
  static TAG_FORMAT = UART.tlv.configure.format;
  // format bits: data bits (0 = 8, 1 = 7), parity (0 none, 1 even, 2 odd) << 2, stop bits (0 = 1, 1 = 2) << 4
  static EIGHT_N_1 = 0x00;

  /** @param {7 | 8} dataBits @param {'N' | 'E' | 'O' | string} parity @param {1 | 2} stopBits */
  static formatByte(dataBits = 8, parity = 'N', stopBits = 1) {
    const d = /** @type {Record<number, number>} */ ({ 8: 0, 7: 1 })[dataBits];
    const p = /** @type {Record<string, number>} */ ({ N: 0, E: 1, O: 2 })[parity.toUpperCase()];
    const s = /** @type {Record<number, number>} */ ({ 1: 0, 2: 1 })[stopBits];
    if (d === undefined || p === undefined || s === undefined) throw new RangeError(`no UART format ${dataBits}${parity}${stopBits}`);
    return d | (p << 2) | (s << 4);
  }

  /**
   * -> the actual baud (within 5 % of the one asked, else the probe refuses Unsupported). fmt (formatByte()) goes as a
   * critical TLV: a probe that cannot set it refuses (Unsupported) rather than running 8N1; none leaves the default
   * 8N1. An fn whose plan has neither RX nor TX is rejected Unavailable (cause 6).
   * @param {number} baud @param {number} [fmt]
   */
  async configure(baud, fmt) {
    let body = new Writer().u32(baud).done();
    if (fmt !== undefined && fmt !== null) body = concat(body, m.tlv(FixtureUart.TAG_FORMAT, [fmt], true));
    const rd = new m.Reader((await this.call(FixtureUart.CONFIGURE, body)).payload);
    const actual = rd.u32();
    rd.tail();
    return actual;
  }

  /** configured, baud, format as the UART runs now (lock-free). @returns {Promise<UartStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(FixtureUart.STATUS, new Uint8Array(), { locked: false })).payload);
    const c = rd.u8(), baud = rd.u32(), format = rd.u8();
    rd.tail();
    const configured = UART_CONFIGURED[c] ?? String(c);
    return { configured, baud, format, isDefault: configured === 'default' || configured === 'item_fallback' };
  }
}

/**
 * oep.fixture.uart as a plain byte stream, after a plan gave it RX / TX: configure() starts reading from the
 * stream's position at that moment (earlier bytes are skipped); not configured here, reading starts at the oldest
 * byte kept. write() splits and waits for the UART. Build with `await FixtureUartIO.open(host, { fn })`.
 */
export class FixtureUartIO extends StreamIO {
  static MAX_READ = 480;
  static MAX_WRITE = 256;   // fit the smallest probe frame in use (V003: 512 bytes)

  /** @param {FixtureUart} uart @param {bigint | null} position */
  constructor(uart, position = null) {
    super(uart, position);
    this.uart = uart;
    this.baud = 0;
  }

  /** @param {import('./host.js').Host} hst @param {{ fn?: number, name?: string }} [opts] */
  static async open(hst, opts = {}) { return new FixtureUartIO(await FixtureUart.open(hst, opts)); }

  /** @param {number} baud @param {number} [fmt] */
  async configure(baud, fmt) {
    this.baud = await this.uart.configure(baud, fmt);
    this.position = (await this.uart.read(PositionStream.FROM_NOW, 0, 0)).start;
    this.pending = new Uint8Array();
    return this.baud;
  }

  async startPosition() { return (await this.uart.read(PositionStream.FROM_OLDEST, 0, 0)).start; }
}

/** @typedef {{ state: number, mode: number, armed: boolean, queued: number, rxFrames: number, txSlots: number, errors: number }} I2cStatus
 * state 0 not configured, 1 running; mode: the configure mode; armed: mode 1 waiting for a write; queued: frames
 * waiting for readRx; rxFrames: received so far; txSlots: preloaded and not yet read (mode 3); errors: overflows,
 * receive errors and unarmed writes dropped (u32). */

/** @typedef {{ maxLength: number | null, maxClockHz: number | null, features: number, queueDepth: number | null }} TargetDeclarations
 * A fixture target's describe (fixture §3 / §4): maxLength (bytes a frame / transfer), maxClockHz (the verified bus
 * clock limit), features (bits; 0 when not declared), queueDepth (tag 0x40: frames / transfers the queue holds; i2c
 * mode 3 also the most unread preload slots). null: not declared. */
/** @typedef {TargetDeclarations & { maxStretchUs: number | null }} I2cTargetDeclarations
 * maxStretchUs (tag 0x41, u32): the largest stretchUs stretch() accepts; null when not declared (a probe declares it
 * exactly when features has bit1). */

/** The describe of fixture target `iface` decoded (cached on the host like every describe).
 * @param {Interface} iface @returns {Promise<{ d: import('./catalog.js').Description, own: Map<number, Uint8Array> }>} */
async function targetDescribe(iface) {
  const tlvs = await describe(iface.host, iface.fn);
  /** @type {Map<number, Uint8Array>} */
  const own = new Map();
  for (const [tag, v] of tlvs) if (!own.has(tag & ~CRITICAL)) own.set(tag & ~CRITICAL, v);
  return { d: decodeDescription(tlvs), own };
}

/** @param {Map<number, Uint8Array>} own @param {number} tag */
const ownU8 = (own, tag) => { const v = own.get(tag); return v && v.length >= 1 ? v[0] : null; };
/** @param {Map<number, Uint8Array>} own @param {number} tag */
const ownU32 = (own, tag) => { const v = own.get(tag); return v && v.length >= 4 ? getU32(v) : null; };

/** @param {m.Tail} tail @param {number} tag */
const nsOf = (tail, tag) => { const v = tail.get(tag); return v && v.length >= 8 ? getU64(v) : null; };

/**
 * oep.fixture.i2c-target (fixture §3): the probe as an I2C target. Mode 1 fixed rx (armRx with the exact length),
 * 2 framed rx (a 1-byte length write, then the payload), 3 preloaded tx (slots the controller reads).
 */
export class I2cTarget extends Interface {
  static NAME = I2C.name;
  static REVISION = I2C.revision;
  static CONFIGURE = I2C.op.configure;
  static ARM_RX = I2C.op.arm_rx;
  static READ_RX = I2C.op.read_rx;
  static PRELOAD_TX = I2C.op.preload_tx;
  static STATUS = I2C.op.status;
  static RESET = I2C.op.reset;
  static STRETCH = I2C.op.stretch;
  static MODE_FIXED_RX = I2C.enum.mode.fixed_rx;
  static MODE_FRAMED_RX = I2C.enum.mode.framed_rx;
  static MODE_PRELOADED_TX = I2C.enum.mode.preloaded_tx;
  static ROLE_SDA = I2C.enum.role.sda;
  static ROLE_SCL = I2C.enum.role.scl;
  static TAG_NS = I2C.tlv.read_rx_answer.ns;
  static TAG_QUEUE_DEPTH = I2C.tlv.describe.queue_depth;
  static TAG_MAX_STRETCH_US = I2C.tlv.describe.max_stretch_us;
  static FEATURE_PRELOADED_TX = I2C.enum.features.preloaded_tx;
  static FEATURE_STRETCH = I2C.enum.features.stretch;

  /** What the probe declares for this target (describe): maxLength, maxClockHz, features, queueDepth, maxStretchUs.
   * @returns {Promise<I2cTargetDeclarations>} */
  async declarations() {
    const { d, own } = await targetDescribe(this);
    return { maxLength: d.maxLength, maxClockHz: d.maxClockHz, features: d.features ?? 0,
      queueDepth: ownU8(own, I2cTarget.TAG_QUEUE_DEPTH), maxStretchUs: ownU32(own, I2cTarget.TAG_MAX_STRETCH_US) };
  }

  /** @type {bigint | null} when the probe received the last frame readRx gave (its clock, ns), when it says */
  lastNs = null;

  /** The plan's (fn, role, channel) assignments for core.planApply. @param {number} sda @param {number} scl
   * @returns {[number, number, number][]} */
  assignments(sda, scl) { return [[this.fn, I2cTarget.ROLE_SDA, sda], [this.fn, I2cTarget.ROLE_SCL, scl]]; }

  /** @param {number} address  7-bit @param {number} mode */
  async configure(address, mode) { await this.call(I2cTarget.CONFIGURE, Uint8Array.of(address, mode)); }

  /** @param {number} length */
  async armRx(length) { await this.call(I2cTarget.ARM_RX, new Writer().u16(length).done()); }

  /** -> frames still queued after this one, the oldest frame (none: empty) and ns: when the probe received it (its
   * clock; TLV ns, else null; also this.lastNs). The answer is pending(u8) count(u16) data [TLV]. */
  async readRx() {
    const rd = new m.Reader((await this.call(I2cTarget.READ_RX)).payload);
    const pending = rd.u8(), data = rd.counted(2);
    this.lastNs = nsOf(rd.tail(), I2cTarget.TAG_NS);
    return { pending, data, ns: this.lastNs };
  }

  /** -> the slots preloaded so far (u8, wraps). @param {Uint8Array} data */
  async preloadTx(data) {
    const rd = new m.Reader((await this.call(I2cTarget.PRELOAD_TX, concat(new Writer().u16(data.length).done(), data))).payload);
    const slots = rd.u8();
    rd.tail();
    return slots;
  }

  /** Lock-free. @returns {Promise<I2cStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(I2cTarget.STATUS, new Uint8Array(), { locked: false })).payload);
    const s = { state: rd.u8(), mode: rd.u8(), armed: rd.u8() !== 0, queued: rd.u8(), rxFrames: rd.u32(), txSlots: rd.u8(), errors: rd.u32() };
    rd.tail();
    return s;
  }

  async reset() { await this.call(I2cTarget.RESET); }

  /** Hold SCL low for stretchUs after each received byte (0 = off); probes declaring features bit1 only. Above the
   * declared maxStretchUs: Unsupported. Accepted in any state; configure and reset keep it, the plan's release clears it.
   * @param {number} stretchUs */
  async stretch(stretchUs) { await this.call(I2cTarget.STRETCH, new Writer().u32(stretchUs).done()); }
}

/** @typedef {{ state: number, mode: number, bitOrder: number, armed: boolean, queued: number, transactions: number, errors: number }} SpiStatus */

/**
 * oep.fixture.spi-target (fixture §4): one CS-framed transaction at a time - arm() with the MISO bytes, then readRx()
 * after the controller raised CS.
 */
export class SpiTarget extends Interface {
  static NAME = SPI.name;
  static REVISION = SPI.revision;
  static CONFIGURE = SPI.op.configure;
  static ARM = SPI.op.arm;
  static READ_RX = SPI.op.read_rx;
  static STATUS = SPI.op.status;
  static RESET = SPI.op.reset;
  static ROLE_SCK = SPI.enum.role.sck;
  static ROLE_MOSI = SPI.enum.role.mosi;
  static ROLE_MISO = SPI.enum.role.miso;
  static ROLE_CS = SPI.enum.role.cs;
  static MSB_FIRST = 0;
  static LSB_FIRST = 1;
  static TAG_NS = SPI.tlv.read_rx_answer.ns;
  static TAG_QUEUE_DEPTH = SPI.tlv.describe.queue_depth;
  static FEATURE_LSB_FIRST = SPI.enum.features.lsb_first;

  /** What the probe declares for this target (describe): maxLength, maxClockHz, features, queueDepth.
   * @returns {Promise<TargetDeclarations>} */
  async declarations() {
    const { d, own } = await targetDescribe(this);
    return { maxLength: d.maxLength, maxClockHz: d.maxClockHz, features: d.features ?? 0,
      queueDepth: ownU8(own, SpiTarget.TAG_QUEUE_DEPTH) };
  }

  /** @type {bigint | null} when the last transaction readRx gave ended on the probe's clock (TLV ns), when it says */
  lastNs = null;

  /** @param {number} sck @param {number} mosi @param {number} miso @param {number} cs
   * @returns {[number, number, number][]} */
  assignments(sck, mosi, miso, cs) {
    return [[this.fn, SpiTarget.ROLE_SCK, sck], [this.fn, SpiTarget.ROLE_MOSI, mosi], [this.fn, SpiTarget.ROLE_MISO, miso],
      [this.fn, SpiTarget.ROLE_CS, cs]];
  }

  /** @param {number} mode  SPI mode 0-3 @param {number} bitOrder  MSB_FIRST / LSB_FIRST */
  async configure(mode = 0, bitOrder = 0) { await this.call(SpiTarget.CONFIGURE, Uint8Array.of(mode, bitOrder)); }

  /** Wait for the next transaction: up to `length` bytes, `tx` out on MISO (the rest 0).
   * @param {number} length @param {Uint8Array} tx */
  async arm(length, tx = new Uint8Array()) {
    await this.call(SpiTarget.ARM, concat(new Writer().u16(length).u16(tx.length).done(), tx));
  }

  /** -> transactions still queued, bits clocked, the MOSI bytes of the oldest finished transaction and ns: when it
   * ended on the probe's clock (TLV ns, else null; also this.lastNs). */
  async readRx() {
    const rd = new m.Reader((await this.call(SpiTarget.READ_RX)).payload);
    const pending = rd.u8(), bits = rd.u32(), data = rd.counted(2);
    this.lastNs = nsOf(rd.tail(), SpiTarget.TAG_NS);
    return { pending, bits, data, ns: this.lastNs };
  }

  /** Lock-free. @returns {Promise<SpiStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(SpiTarget.STATUS, new Uint8Array(), { locked: false })).payload);
    const s = { state: rd.u8(), mode: rd.u8(), bitOrder: rd.u8(), armed: rd.u8() !== 0, queued: rd.u8(), transactions: rd.u32(), errors: rd.u32() };
    rd.tail();
    return s;
  }

  async reset() { await this.call(SpiTarget.RESET); }
}
