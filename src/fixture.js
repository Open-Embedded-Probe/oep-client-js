// @ts-check
// oep.fixture.gpio, oep.fixture.uart, oep.fixture.i2c-target and oep.fixture.spi-target, revision 1 (oep-spec
// oep-if-fixture). The capture is in `capture` (oep.fixture.logic / analog).
//
// Plan roles: gpio 1 = line; uart 1 = RX, 2 = TX; i2c-target 1 = SDA, 2 = SCL; spi-target 1 = SCK, 2 = MOSI,
// 3 = MISO, 4 = CS. Only channels the plan assigned can be used.

import * as reg from './registry.js';
import { Writer, concat, getU16, getU32, getU64 } from './bytes.js';
import * as m from './message.js';
import { Unavailable } from './errors.js';
import { Interface, describe } from './core.js';
import { decodeDescription, firstFixed } from './catalog.js';
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
  get indexes() { return this.tlvs.filter(([t, v]) => t === TAG_INDEX && v.length === 1).map(([, v]) => v[0]); }
  /** The first index (none: null). */
  get index() { return this.indexes[0] ?? null; }
}

/**
 * oep.fixture.gpio. `set` applies [channel, mode] pairs in order in one request (pull NRST, then release it); a
 * channel the plan did not assign rejects the whole list as unavailable (GpioUnavailable: .channels, and its position
 * .index, TLV 0x40); a mode the probe does not declare, unsupported (then the same channel / index TLVs). The
 * open-drain modes never drive a line high: the way to move a target's reset line. The output strength is the probe's
 * own (fixture §1: revision 1 defines no strength selection).
 */
export class Gpio extends Interface {
  static NAME = 'oep.fixture.gpio';
  static REVISION = 1;
  static SET = GPIO.op.set;
  static READ = GPIO.op.read;
  static TAG_MODES = GPIO.tlv.describe.modes;
  static INPUT = MODE.input;
  static INPUT_PULLUP = MODE.input_pullup;
  static INPUT_PULLDOWN = MODE.input_pulldown;
  static OUTPUT_LOW = MODE.output_low;
  static OUTPUT_HIGH = MODE.output_high;
  static OPEN_DRAIN_LOW = MODE.open_drain_low;
  static OPEN_DRAIN_RELEASE = MODE.open_drain_release;

  /** n(u8) n x (channel(u16) mode(u8)) (fixture §1). @param {[number, number][]} pairs */
  static setBody(pairs) {
    const w = new Writer().u8(pairs.length);
    for (const [ch, mode] of pairs) w.u16(ch).u8(mode);
    return w.done();
  }

  /** [channel, mode] pairs, applied in order (fixture §1). @param {[number, number][]} pairs @returns {Promise<void>} */
  async set(pairs) {
    try {
      await this.call(Gpio.SET, Gpio.setBody(pairs));
    } catch (e) {
      if (e instanceof Unavailable && !(e instanceof GpioUnavailable)) throw new GpioUnavailable(e.result);
      throw e;
    }
  }

  /** describe modes: a u32 bit set, bit n = mode n (0xFF when not declared). @returns {Promise<number>} */
  async modes() {
    // the first copy, a u32 exactly; bit 7 in an answer is an unknown tag (core §2.2, §2.3)
    const v = firstFixed(await describe(this.host, this.fn), Gpio.TAG_MODES, 4);
    return v ? getU32(v) : 0xff;
  }

  /** @param {number} channel @param {number} mode */
  configure(channel, mode) { return this.set([[channel, mode]]); }

  /** -> one level (0 / 1) per channel. Lock-free. The answer is n(u8) n x level [TLV] (fixture §1).
   * @param {number[]} channels @returns {Promise<number[]>} */
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

/** oep.fixture.uart status (lock-free): the baud and format the UART runs with now (fixture §2); baud 0 and format 0
 * before the first configure and after a failed one (configured false: nothing is received).
 * @typedef {{ baud: number, format: number, configured: boolean }} UartStatus */

/**
 * oep.fixture.uart: one position stream per fn, like the console without a stream number (fixture §2). The stream
 * exists while the plan gives the fn RX or TX; nothing is received until a configure, and received bytes are kept from
 * then on, whatever the session; reconfiguring (it succeeds or fails) keeps them and the position never goes back
 * within one boot. Reads are lock-free and do not consume. TX idles high while planned; write needs TX in the plan and
 * a configure (else unavailable cause 6). marks, clear, mark and write are optional ops (`offers`).
 */
export class FixtureUart extends PositionStream {
  static NAME = 'oep.fixture.uart';
  static REVISION = 1;
  static CONFIGURE = UART.op.configure;
  static STATUS = UART.op.status;
  static READ = UART.op.read;
  static MARKS = UART.op.marks;
  static CLEAR = UART.op.clear;
  static MARK = UART.op.mark;
  static WRITE = UART.op.write;
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
   * -> the actual baud (within 5 % of the one asked, else the probe refuses Unsupported). fmt (formatByte()) goes as
   * its TLV (critical: this host's choice); a format the probe cannot set is refused Unsupported, never run as 8N1;
   * none leaves the default 8N1. An fn whose plan has neither RX nor TX is rejected Unavailable (cause 6). A configure
   * the probe took but could not bring up is completed failed (Failed; its baud is 0): the UART is not configured then,
   * received bytes stay readable, and unsent TX is dropped (fixture §2).
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

  /** baud and format as the UART runs now (lock-free). @returns {Promise<UartStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(FixtureUart.STATUS, new Uint8Array(), { locked: false })).payload);
    const baud = rd.u32(), format = rd.u8();
    rd.tail();
    return { baud, format, configured: baud !== 0 };
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

/** @typedef {{ maxLength: number | null, maxClockHz: number | null, features: number, queueDepth: number | null }} TargetDeclarations
 * A fixture target's describe (fixture §3 / §4): maxLength (bytes a frame / transfer), maxClockHz (the verified bus
 * clock limit), features (bits; 0 when not declared), queueDepth (tag 0x40: frames / transfers the queue holds;
 * i2c-target: also the most unread preload slots). null: not declared. */
/** @typedef {TargetDeclarations & { csSetupNs: number }} SpiTargetDeclarations
 * csSetupNs (tag 0x43, u32; fixture §4): CS active to the first SCK edge, in ns, for MISO's first bit to be sure; 0 when
 * not declared. */
/** @typedef {TargetDeclarations & { maxStretchUs: number | null, internalPullups: boolean }} I2cTargetDeclarations
 * maxStretchUs (tag 0x41, u32): the largest stretchUs stretch() accepts; null when not declared (a probe declares it
 * exactly when its ops offer stretch). internalPullups (features bit2; fixture §3): the probe enables pull-ups of its
 * own on SDA / SCL while configured; without them the bus needs its own. */

/** The describe of fixture target `iface` decoded (cached on the host like every describe).
 * @param {Interface} iface @returns {Promise<{ d: import('./catalog.js').Description, own: Map<number, Uint8Array> }>} */
async function targetDescribe(iface) {
  const tlvs = await describe(iface.host, iface.fn);
  /** @type {Map<number, Uint8Array>} */
  const own = new Map();
  for (const [tag, v] of tlvs) if (!own.has(tag)) own.set(tag, v);   // the first copy; bit 7 in an answer: an unknown tag (core §2.2, §2.3)
  return { d: decodeDescription(tlvs), own };
}

/** @param {Map<number, Uint8Array>} own @param {number} tag */
const ownU8 = (own, tag) => { const v = own.get(tag); return v && v.length === 1 ? v[0] : null; };   // a value without its defined length is broken (core §2.3)
/** @param {Map<number, Uint8Array>} own @param {number} tag */
const ownU32 = (own, tag) => { const v = own.get(tag); return v && v.length === 4 ? getU32(v) : null; };

/** @param {m.Tail} tail @param {number} tag */
const nsOf = (tail, tag) => { const v = tail.get(tag); return v && v.length >= 8 ? getU64(v) : null; };

/** @typedef {{ state: number, queued: number, rxFrames: number, txSlots: number, errors: number }} I2cStatus
 * state 0 not configured, 1 running; queued: frames waiting for readRx; rxFrames: frames queued since configure
 * (overflows not counted); txSlots: preloadTx slots not read yet; errors: writes that overflowed or were over
 * max_length (at most 1 a write). */

/**
 * oep.fixture.i2c-target (fixture §3): the probe as an I2C target at one address, one form: every controller write with
 * data is one frame in the queue (readRx; cut at max_length, errors + 1), every controller read is answered from the
 * preloadTx slots in order (0xFF when none is left). stretch (optional, `offers(I2cTarget.STRETCH)`) holds SCL after
 * each byte.
 */
export class I2cTarget extends Interface {
  static NAME = I2C.name;
  static REVISION = I2C.revision;
  static CONFIGURE = I2C.op.configure;
  static READ_RX = I2C.op.read_rx;
  static PRELOAD_TX = I2C.op.preload_tx;
  static STATUS = I2C.op.status;
  static STRETCH = I2C.op.stretch;
  static ROLE_SDA = I2C.enum.role.sda;
  static ROLE_SCL = I2C.enum.role.scl;
  static TAG_NS = I2C.tlv.read_rx_answer.ns;
  static TAG_QUEUE_DEPTH = I2C.tlv.describe.queue_depth;
  static TAG_MAX_STRETCH_US = I2C.tlv.describe.max_stretch_us;
  static FEATURE_INTERNAL_PULLUPS = I2C.enum.features.internal_pullups;

  /** What the probe declares for this target (describe): maxLength, maxClockHz, features, queueDepth, maxStretchUs,
   * internalPullups. @returns {Promise<I2cTargetDeclarations>} */
  async declarations() {
    const { d, own } = await targetDescribe(this);
    const features = d.features ?? 0;
    return { maxLength: d.maxLength, maxClockHz: d.maxClockHz, features,
      queueDepth: ownU8(own, I2cTarget.TAG_QUEUE_DEPTH), maxStretchUs: ownU32(own, I2cTarget.TAG_MAX_STRETCH_US),
      internalPullups: (features & I2cTarget.FEATURE_INTERNAL_PULLUPS) !== 0 };
  }

  /** Whether the probe enables pull-ups of its own on SDA / SCL while configured (describe features bit2, fixture §3);
   * without them the bus needs its own. */
  async internalPullups() { return (await this.declarations()).internalPullups; }

  /** @type {bigint | null} the STOP or next START that ended the last frame readRx gave (its clock, ns), when it says */
  lastNs = null;

  /** The plan's (fn, role, channel) assignments for core.planApply. @param {number} sda @param {number} scl
   * @returns {[number, number, number][]} */
  assignments(sda, scl) { return [[this.fn, I2cTarget.ROLE_SDA, sda], [this.fn, I2cTarget.ROLE_SCL, scl]]; }

  /** I2C's own reserved addresses (general call, the 10-bit prefix, ...): a probe refuses them unsupported (fixture §3).
   * @type {ReadonlyArray<readonly [number, number]>} */
  static RESERVED_ADDRESSES = Object.freeze([Object.freeze(/** @type {const} */ ([0x00, 0x07])), Object.freeze(/** @type {const} */ ([0x78, 0x7f]))]);

  /** Answer at `address` (7 bits), the target made anew (the queue, the slots and the counts emptied; stretch kept).
   * 0x00-0x07 and 0x78-0x7F are the I2C specification's reserved addresses, which a probe refuses unsupported (fixture
   * §3) - refused here (RangeError) before anything is sent. @param {number} address */
  async configure(address) {
    if (I2cTarget.RESERVED_ADDRESSES.some(([lo, hi]) => address >= lo && address <= hi)) {
      throw new RangeError(`I2C address 0x${address.toString(16).padStart(2, '0')} is reserved (0x00-0x07, 0x78-0x7F; fixture §3)`);
    }
    await this.call(I2cTarget.CONFIGURE, Uint8Array.of(address));
  }

  /** -> frames still queued after this one, the oldest frame (none: empty) and ns: when the probe received it (its
   * clock; TLV ns, else null; also this.lastNs). The answer is pending(u8) count(u16) data [TLV]. */
  async readRx() {
    const rd = new m.Reader((await this.call(I2cTarget.READ_RX)).payload);
    const pending = rd.u8(), data = rd.counted(2);
    this.lastNs = nsOf(rd.tail(), I2cTarget.TAG_NS);
    return { pending, data, ns: this.lastNs };
  }

  /** One slot the controller's next read is answered from (1 to max_length bytes; at most queueDepth unread: then
   * rejected unavailable cause 2). The answer is empty. @param {Uint8Array} data */
  async preloadTx(data) {
    await this.call(I2cTarget.PRELOAD_TX, concat(new Writer().u16(data.length).done(), data));
  }

  /** Lock-free. @returns {Promise<I2cStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(I2cTarget.STATUS, new Uint8Array(), { locked: false })).payload);
    const s = { state: rd.u8(), queued: rd.u8(), rxFrames: rd.u32(), txSlots: rd.u8(), errors: rd.u32() };
    rd.tail();
    return s;
  }

  /** Hold SCL low for stretchUs after each received byte (0 = off); an optional op, offered when the describe's ops set
   * it (`offers(I2cTarget.STRETCH)`; otherwise rejected unknown_operation). Above the
   * declared maxStretchUs: Unsupported. Accepted in any state; configure keeps it, the plan's release clears it.
   * @param {number} stretchUs */
  async stretch(stretchUs) { await this.call(I2cTarget.STRETCH, new Writer().u32(stretchUs).done()); }
}

/** @typedef {{ state: number, mode: number, bitOrder: number, armed: boolean, queued: number, transactions: number, errors: number }} SpiStatus */

/** The wire bits of an spi-target transaction in the order they came (fixture §4): wire bit k is in byte k / 8, at bit
 * 7 - k mod 8 MSB first (bitOrder 0) or k mod 8 LSB first (1); at most the bits `data` holds.
 * @param {Uint8Array} data @param {number} bits @param {number} bitOrder @returns {number[]} */
export function wireBits(data, bits, bitOrder = 0) {
  const n = Math.min(bits, 8 * data.length);
  return Array.from({ length: n }, (_, k) => (data[k >> 3] >> (bitOrder ? k & 7 : 7 - (k & 7))) & 1);
}

/** The inverse of wireBits: the bytes for these wire bits (a partial last byte's missing bits 0).
 * @param {number[]} seq @param {number} bitOrder */
export function packWireBits(seq, bitOrder = 0) {
  const out = new Uint8Array((seq.length + 7) >> 3);
  seq.forEach((b, k) => { if (b) out[k >> 3] |= 1 << (bitOrder ? k & 7 : 7 - (k & 7)); });
  return out;
}

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
  static ROLE_SCK = SPI.enum.role.sck;
  static ROLE_MOSI = SPI.enum.role.mosi;
  static ROLE_MISO = SPI.enum.role.miso;
  static ROLE_CS = SPI.enum.role.cs;
  static MSB_FIRST = 0;
  static LSB_FIRST = 1;
  static TAG_NS = SPI.tlv.read_rx_answer.ns;
  static TAG_QUEUE_DEPTH = SPI.tlv.describe.queue_depth;
  static TAG_CS_SETUP_NS = SPI.tlv.describe.cs_setup_ns;
  static FEATURE_LSB_FIRST = SPI.enum.features.lsb_first;

  /** What the probe declares for this target (describe): maxLength, maxClockHz, features, queueDepth, csSetupNs.
   * @returns {Promise<SpiTargetDeclarations>} */
  async declarations() {
    const { d, own } = await targetDescribe(this);
    return { maxLength: d.maxLength, maxClockHz: d.maxClockHz, features: d.features ?? 0,
      queueDepth: ownU8(own, SpiTarget.TAG_QUEUE_DEPTH), csSetupNs: ownU32(own, SpiTarget.TAG_CS_SETUP_NS) ?? 0 };
  }

  /** The shortest CS-active-to-first-SCK time (ns) for which the probe guarantees MISO carries the first bit, under its
   * normal load (describe tag 0x43, fixture §4); 0 when not declared (MISO is driven at once). A master that starts SCK
   * sooner cannot rely on the first bit: show it to the user. */
  async csSetupNs() { return (await this.declarations()).csSetupNs; }

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

  /** -> transactions still queued, bits clocked (saturating at 0xFFFFFFFF), the MOSI bytes of the oldest finished
   * transaction and ns: when CS went inactive, ending it, on the probe's clock (TLV ns, else null; also this.lastNs).
   * The bytes hold the wire bits as wireBits reads them (fixture §4: bit k in byte k / 8, MSB or LSB first by
   * bit_order, a partial last byte's missing bits 0). */
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
}
