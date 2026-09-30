// @ts-check
// oep.target.console revision 1: the target's console as a position stream on a debug connection (oep-spec
// oep-if-console, oep-if-common §1), and ConsoleIO, the same as a plain byte stream.
//
// The position streams of oep.target.console and oep.fixture.uart share their read / marks / clear / mark / write
// operations (same numbers and meanings; the UART has no stream number): `PositionStream` holds them,
// `streamPrefix()` is the stream number or nothing. Positions are u64: bigint throughout.

import * as reg from './registry.js';
import { Writer, concat, utf8 } from './bytes.js';
import * as m from './message.js';
import { Failed, Timeout } from './errors.js';
import { Interface } from './core.js';

const CON = reg.TARGET_CONSOLE;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One mark (common §1.3). serial: per stream, wraps (u32): marks are read on by serial. timeMs: probe uptime in ms
 * (u32, wraps after ~49.7 days).
 * @typedef {{ serial: number, position: bigint, kind: number, timeMs: number, detail: number }} Mark
 */

/**
 * One read's answer: data from position `start`; more: the probe has more after it; gap: bytes before `start` were
 * pushed out (start - the position asked = the bytes lost).
 * @typedef {{ start: bigint, more: boolean, gap: boolean, data: Uint8Array }} Chunk
 */

/** Mark kind -> its name as the spec writes it (link-lost, ...). @type {Record<number, string>} */
export const MARK_NAMES = Object.fromEntries(Object.entries(CON.enum.mark_kind).map(([k, v]) => [v, k.replace(/_/g, '-')]));
export const MARK_KIND = CON.enum.mark_kind;

/** read / marks / clear / mark / write of a position stream (console §1, fixture.uart §2, common §1). */
export class PositionStream extends Interface {
  static READ = CON.op.read;
  static MARKS = CON.op.marks;
  static CLEAR = CON.op.clear;
  static MARK = CON.op.mark;
  static WRITE = CON.op.write;
  static FROM_POSITION = CON.enum.read_from.position;
  static FROM_OLDEST = CON.enum.read_from.oldest;
  static FROM_NOW = CON.enum.read_from.now;
  static FROM_MARK = CON.enum.read_from.last_mark;

  /** What goes in front of every stream op (the console's stream number; the UART: nothing).
   * @returns {Uint8Array} */
  streamPrefix() { return new Uint8Array(); }

  /** @param {Uint8Array} body */
  streamBody(body) { return concat(this.streamPrefix(), body); }

  /**
   * start: FROM_*; arg: a position (FROM_POSITION) or a mark kind (FROM_MARK, 0: any). Lock-free; reading does not
   * consume.
   * @param {number} start @param {bigint | number} arg @param {number} maximum @returns {Promise<Chunk>}
   */
  async read(start = PositionStream.FROM_OLDEST, arg = 0, maximum = 1000) {
    const body = new Writer().u8(start).u64(arg).u16(maximum).done();
    const rd = new m.Reader((await this.call(PositionStream.READ, this.streamBody(body), { locked: false })).payload);
    const pos = rd.u64(), flags = rd.u8();
    return { start: pos, more: !!(flags & 1), gap: !!(flags & 2), data: rd.rest() };   // data ends the result: no tail
  }

  /** @param {bigint | number} position @param {number} maximum */
  readFrom(position, maximum = 1000) { return this.read(PositionStream.FROM_POSITION, position, maximum); }

  /** One answer's marks with serial >= fromSerial (in serial order).
   * @param {number} fromSerial @returns {Promise<{ marks: Mark[], more: boolean }>} */
  async marksPage(fromSerial = 0) {
    const body = new Writer().u32(fromSerial).done();
    const rd = new m.Reader((await this.call(PositionStream.MARKS, this.streamBody(body), { locked: false })).payload);
    const more = rd.u8(), count = rd.u8();
    /** @type {Mark[]} */
    const marks = [];
    for (let i = 0; i < count; i++) {
      const e = rd.element();
      marks.push({ serial: e.u32(), position: e.u64(), kind: e.u8(), timeMs: e.u32(), detail: e.u8() });
    }
    rd.tail();
    return { marks, more: !!more };
  }

  /** Every mark from `fromSerial` on, following `more` (none lost or repeated when several share a position).
   * @param {number} fromSerial */
  async marks(fromSerial = 0) {
    /** @type {Mark[]} */
    const out = [];
    for (;;) {
      const { marks, more } = await this.marksPage(fromSerial);
      out.push(...marks);
      if (!more || !marks.length) return out;
      fromSerial = (marks[marks.length - 1].serial + 1) >>> 0;
    }
  }

  async clear() { await this.call(PositionStream.CLEAR, this.streamPrefix()); }

  /** A host mark (kind host, detail = value). @param {number} value */
  async mark(value) { await this.call(PositionStream.MARK, this.streamBody(Uint8Array.of(value & 0xff))); }

  /** -> bytes accepted (the probe does not buffer; fewer than asked is completed partial, not an error).
   * @param {Uint8Array} data */
  async write(data) {
    const r = await this.request(PositionStream.WRITE, this.streamBody(concat(new Writer().u16(data.length).done(), data)));
    if (r.resolution !== m.COMPLETED || (r.detail !== m.SUCCESS && r.detail !== m.PARTIAL)) throw new Failed(r);
    const rd = new m.Reader(r.payload);
    const accepted = rd.u16();
    rd.tail();
    return accepted;
  }
}

/**
 * oep.target.console: streams on a debug connection, one per (connection, mechanism); reads and marks need no lock.
 * A stream whose connection is lost is closed with a link-lost mark and stays readable until the same place opens
 * the same mechanism again. `await Console.open(host)` finds the interface; `console.open(conn)` opens a stream.
 */
export class Console extends PositionStream {
  static NAME = 'oep.target.console';
  static REVISION = 1;
  static OPEN = CON.op.open;
  static CLOSE = CON.op.close;
  static SDI = CON.enum.mechanism.sdi;
  static DMDATA = CON.enum.mechanism.dmdata;
  static DMSEQ = CON.enum.mechanism.dmseq;

  /** @param {import('./host.js').Host} hst @param {number} fn @param {string} name @param {Uint8Array} prefix */
  constructor(hst, fn, name, prefix = new Uint8Array()) {
    super(hst, fn, name, prefix);
    this.stream = 1;
    this.existing = false;
  }

  streamPrefix() { return new Writer().u16(this.stream).done(); }

  /**
   * -> the stream. An open stream of the same (connection, mechanism) comes back as it is (this.existing): position
   * and marks carry on. An unknown mechanism is rejected unsupported.
   * @param {number} conn @param {number} mechanism
   */
  async open(conn, mechanism = Console.DMSEQ) {
    const rd = new m.Reader((await this.call(Console.OPEN, new Writer().u16(conn).u8(mechanism).done())).payload);
    this.stream = rd.u16();
    this.existing = !!(rd.u8() & 1);
    rd.tail();
    return this.stream;
  }

  async close() { await this.call(Console.CLOSE, this.streamPrefix()); }
}

/**
 * A position stream read from a position onwards, as a plain byte stream (console or fixture UART). JS has no file
 * objects: read() gives what the probe has after `position` (maybe nothing), readAll() everything it has now,
 * readUntil() waits for a pattern, write() splits and waits until the target took all. Bytes a readUntil() read past
 * its pattern are kept for the next read. `lost` counts the bytes the probe pushed out before they were read.
 */
export class StreamIO {
  static MAX_READ = 1000;
  static MAX_WRITE = 64;

  /** @param {PositionStream} source @param {bigint | null} position  null: set by the first read (subclasses) */
  constructor(source, position = null) {
    this.source = source;
    /** @type {bigint | null} */ this.position = position;
    this.lost = 0n;
    this.more = false;
    this.pending = new Uint8Array();
  }

  /**
   * Read from `start` (default: from now, the stream's position at this moment).
   * @template {typeof StreamIO} T
   * @this {T}
   * @param {ConstructorParameters<T>[0]} source @param {bigint | number} [start]
   * @returns {Promise<InstanceType<T>>}
   */
  static async create(source, start) {
    const pos = start === undefined ? (await source.read(PositionStream.FROM_NOW, 0, 0)).start : BigInt(start);
    return /** @type {InstanceType<T>} */ (new this(source, pos));
  }

  /** (read, write) chunk sizes that fit the probe's frame: request header 6 + session 4 + stream prefix + count 2;
   * result header 5 + start 8 + flags 1. */
  async limits() {
    const frame = (await this.source.host.confirmed()).maxFrame;
    const ctor = /** @type {typeof StreamIO} */ (this.constructor);
    const overhead = 12 + this.source.streamPrefix().length;
    return [Math.max(1, Math.min(ctor.MAX_READ, frame - 14)), Math.max(1, Math.min(ctor.MAX_WRITE, frame - overhead))];
  }

  /** Where reading starts when nothing set it. */
  async startPosition() { return (await this.source.read(PositionStream.FROM_NOW, 0, 0)).start; }

  /** Up to n bytes after `position` (none yet: empty). @param {number} n */
  async read(n = 512) {
    if (this.pending.length) {
      const out = this.pending.slice(0, n);
      this.pending = this.pending.slice(out.length);
      return out;
    }
    if (this.position === null) this.position = await this.startPosition();
    const c = await this.source.readFrom(this.position, Math.min(n, (await this.limits())[0]));
    if (c.gap) this.lost += c.start - this.position;   // u64 positions: no wrap
    this.position = c.start + BigInt(c.data.length);
    this.more = c.more;
    return c.data;
  }

  /** Everything the probe has after `position` now, following `more` (up to maxBytes). @param {number} maxBytes */
  async readAll(maxBytes = 1 << 20) {
    /** @type {Uint8Array[]} */
    const parts = [];
    let n = 0;
    do {
      const got = await this.read(Math.min(1000, maxBytes - n));
      if (!got.length) break;
      parts.push(got);
      n += got.length;
    } while ((this.more || this.pending.length) && n < maxBytes);
    return concat(...parts);
  }

  /**
   * Read until `pattern` (bytes or UTF-8 text) arrives -> the bytes up to and including it; what came after stays
   * for the next read. No pattern within timeoutMs: Timeout (what was read stays for the next read too).
   * @param {Uint8Array | string} pattern @param {{ timeoutMs?: number, pollMs?: number }} [opts]
   */
  async readUntil(pattern, { timeoutMs = 5000, pollMs = 10 } = {}) {
    const pat = typeof pattern === 'string' ? utf8(pattern) : pattern;
    const deadline = Date.now() + timeoutMs;
    let got = new Uint8Array();
    for (;;) {
      const at = indexOf(got, pat);
      if (at >= 0) {
        this.pending = concat(got.slice(at + pat.length), this.pending);
        return got.slice(0, at + pat.length);
      }
      if (Date.now() >= deadline) {
        this.pending = concat(got, this.pending);
        throw new Timeout(`no ${JSON.stringify(typeof pattern === 'string' ? pattern : Array.from(pattern))} within ${timeoutMs} ms`);
      }
      const chunk = await this.read(1000);
      got = concat(got, chunk);
      if (!chunk.length) await sleep(pollMs);
    }
  }

  /** All of `data`, in chunks that fit; waits while the target takes nothing. No progress within timeoutMs (when
   * given): Timeout. @param {Uint8Array | string} data @param {{ timeoutMs?: number }} [opts] */
  async write(data, { timeoutMs } = {}) {
    let rest = typeof data === 'string' ? utf8(data) : data;
    const chunk = (await this.limits())[1];
    let since = Date.now();
    while (rest.length) {
      const took = await this.source.write(rest.slice(0, chunk));
      rest = rest.slice(took);
      if (took) since = Date.now();
      else {
        if (timeoutMs !== undefined && Date.now() - since > timeoutMs) throw new Timeout(`the target took nothing for ${timeoutMs} ms`);
        await sleep(5);   // the target has not taken the last chunk yet
      }
    }
  }
}

/** A console stream read from a position onwards (default: from now), as a plain byte stream. Build with
 * `await ConsoleIO.create(console, start?)`. */
export class ConsoleIO extends StreamIO {
  /** @param {Console} console @param {bigint | null} position */
  constructor(console, position = null) {
    super(console, position);
    this.console = console;
  }
}

/** @param {Uint8Array} hay @param {Uint8Array} needle */
function indexOf(hay, needle) {
  if (!needle.length) return 0;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
