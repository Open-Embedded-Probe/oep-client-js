// @ts-check
// oep.target.console revision 1: the target's console as a position stream on a debug connection (oep-spec
// oep-if-console, oep-if-common §1), and ConsoleIO, the same as a plain byte stream.
//
// The position streams of oep.target.console and oep.fixture.uart share their read / marks / clear / mark / write
// operations (same numbers and meanings; the UART has no stream number): `PositionStream` holds them,
// `streamPrefix()` is the stream number or nothing. Positions and the probe's clock (ns) are u64: bigint throughout.
// Every answer is a fixed part, a counted list or length-prefixed data, then TLVs the host skips (core §2.3).

import * as reg from './registry.js';
import { Writer, concat, getU16, text, utf8 } from './bytes.js';
import * as m from './message.js';
import { Failed, Timeout } from './errors.js';
import { Interface, describe } from './core.js';

const CON = reg.TARGET_CONSOLE;
const COMMON = reg.COMMON.enum;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One mark (common §1.3, 22 bytes). serial: per stream, wraps (u32): marks are read on by serial. timeNs: the probe's
 * one clock, ns since its boot (u64, core §2.6a).
 * @typedef {{ serial: number, position: bigint, kind: number, timeNs: bigint, detail: number }} Mark
 */

/**
 * One read's answer: data from position `start`; more: the probe has more after it; gap: bytes before `start` were
 * pushed out (start - the position asked = the bytes lost); tail: the TLVs after the data.
 * @typedef {{ start: bigint, more: boolean, gap: boolean, data: Uint8Array, tail: m.Tail }} Chunk
 */

/** One row of the console's streams answer (oep-if-console §1): a live stream, its connection and mechanism (its name in
 * the probe's list, core §7.7; a number the list lacks as it came).
 * @typedef {{ stream: number, connection: number, mechanism: string | number }} StreamInfo */

/** serial u32, position u64, kind u8, time_ns u64, detail u8 (common §1.3) */
export const MARK_BYTES = 22;
/** The common mark kinds (lost 1, clear 2, host 3) and the console's own (reset 0x40, restart 0x41; console §2).
 * @type {Record<string, number>} */
export const MARK_KIND = { ...COMMON.mark_kind, ...CON.enum.mark_kind };
/** Mark kind -> its name as the spec writes it (link-lost, ...). @type {Record<number, string>} */
export const MARK_NAMES = Object.fromEntries(Object.entries(MARK_KIND).map(([k, v]) => [v, k.replace(/_/g, '-')]));
/** The mark details by kind name (registry common / console enum mark_detail_*): the common ones, then the console's
 * (reset, restart, lost's target_timeout). @type {Record<string, Record<string, number>>} */
export const MARK_DETAIL = {};
for (const enums of [COMMON, CON.enum]) {
  for (const [k, v] of Object.entries(enums)) {
    if (k.startsWith('mark_detail_')) {
      const kind = k.slice('mark_detail_'.length);
      MARK_DETAIL[kind] = { ...(MARK_DETAIL[kind] ?? {}), .../** @type {Record<string, number>} */ (v) };
    }
  }
}
export const READ_FLAGS = COMMON.read_flags;

/** read / marks / clear / mark / write of a position stream (console §1, fixture.uart §2, common §1). */
export class PositionStream extends Interface {
  static READ = CON.op.read;
  static MARKS = CON.op.marks;
  static CLEAR = CON.op.clear;
  static MARK = CON.op.mark;
  static WRITE = CON.op.write;
  static FROM_POSITION = COMMON.read_from.position;
  static FROM_OLDEST = COMMON.read_from.oldest;
  static FROM_NOW = COMMON.read_from.now;
  static FROM_MARK = COMMON.read_from.last_mark;

  /** The op numbers of this stream's interface (each interface numbers its own: console, fixture.uart). */
  get streamOps() { return /** @type {typeof PositionStream} */ (this.constructor); }

  /** What goes in front of every stream op (the console's stream number; the UART: nothing).
   * @returns {Uint8Array} */
  streamPrefix() { return new Uint8Array(); }

  /** @param {Uint8Array} body */
  streamBody(body) { return concat(this.streamPrefix(), body); }

  /**
   * start: FROM_*; arg: a position (FROM_POSITION) or a mark kind (FROM_MARK, 0: any). Lock-free; reading does not
   * consume. The answer is start(u64) flags(u8) len(u16) data [TLV].
   * @param {number} start @param {bigint | number} arg @param {number} maximum @returns {Promise<Chunk>}
   */
  async read(start = PositionStream.FROM_OLDEST, arg = 0, maximum = 1000) {
    const body = new Writer().u8(start).u64(arg).u16(maximum).done();
    const rd = new m.Reader((await this.call(this.streamOps.READ, this.streamBody(body), { locked: false })).payload);
    const pos = rd.u64(), flags = rd.u8();
    const data = rd.counted(2);
    return { start: pos, more: !!(flags & READ_FLAGS.more), gap: !!(flags & READ_FLAGS.gap), data, tail: rd.tail() };
  }

  /** @param {bigint | number} position @param {number} maximum */
  readFrom(position, maximum = 1000) { return this.read(PositionStream.FROM_POSITION, position, maximum); }

  /** One answer's marks from `fromSerial` on, in serial order (common §1.3: fromSerial included; from the serial the
   * next mark gets, none and more false; a serial no longer kept starts at the oldest kept - the serials then jump).
   * @param {number} fromSerial @returns {Promise<{ marks: Mark[], more: boolean }>} */
  async marksPage(fromSerial = 0) {
    const body = new Writer().u32(fromSerial).done();
    const rd = new m.Reader((await this.call(this.streamOps.MARKS, this.streamBody(body), { locked: false })).payload);
    const more = rd.u8(), count = rd.u8();
    /** @type {Mark[]} */
    const marks = [];
    for (let i = 0; i < count; i++) {   // count x mark, no element length (core §2.3)
      marks.push({ serial: rd.u32(), position: rd.u64(), kind: rd.u8(), timeNs: rd.u64(), detail: rd.u8() });
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

  async clear() { await this.call(this.streamOps.CLEAR, this.streamPrefix()); }

  /** A host mark (kind host, detail = value). @param {number} value */
  async mark(value) { await this.call(this.streamOps.MARK, this.streamBody(Uint8Array.of(value & 0xff))); }

  /** -> bytes accepted: what went into the probe's send queue from data's start, min(count, its free space) (common
   * §1.4; delivery is not implied) - a console's queue is the probe's own size (not declared), handed to the target 2
   * (dmseq) or 3 (DMDATA) bytes at a time; an SDI stream's write is unsupported (console §1, §3). Fewer than asked is
   * completed partial, not an error; nothing accepted (the queue full) is completed failed (thrown as Failed):
   * StreamIO.write loops on it.
   * @param {Uint8Array} data */
  async write(data) {
    const r = await this.request(this.streamOps.WRITE, this.streamBody(concat(new Writer().u16(data.length).done(), data)));
    if (r.resolution !== m.COMPLETED || (r.detail !== m.SUCCESS && r.detail !== m.PARTIAL)) throw new Failed(r);
    const rd = new m.Reader(r.payload);
    const accepted = rd.u16();
    rd.tail();
    return accepted;
  }
}

/**
 * oep.target.console: a session's stream on a debug connection, one live stream per connection; reads, marks and the
 * streams list need no lock. close, the connection's release and the session's end release the stream, its buffer and
 * its send queue: read what is wanted first (console §2). A closed stream's number answers no_resource and is never
 * used again. marks, clear, mark and write are optional (`offers`): without marks, read from a mark is unsupported; an
 * SDI stream takes no write (unsupported). `await Console.open(host)` finds the interface; `console.open(conn)` opens a
 * stream.
 */
export class Console extends PositionStream {
  static NAME = 'oep.target.console';
  static REVISION = 1;
  static OPEN = CON.op.open;
  static CLOSE = CON.op.close;
  static STREAMS = CON.op.streams;
  /** the standard mechanisms' names (console §3) */
  static SDI = 'sdi';
  static DMDATA = 'dmdata';
  static DMSEQ = 'dmseq';
  static TAG_MECHANISM = CON.tlv.describe.mechanism;

  /** @param {import('./host.js').Host} hst @param {number} fn @param {string} name @param {Uint8Array} prefix */
  constructor(hst, fn, name, prefix = new Uint8Array()) {
    super(hst, fn, name, prefix);
    this.stream = 1;
  }

  streamPrefix() { return new Writer().u32(this.stream).done(); }

  /** The mechanisms the probe opens, by name, in its order: a named list (describe tag 0x40 repeated, console §1, core
   * §7.7); the number of the k-th is k (from 1). @returns {Promise<string[]>} */
  async mechanisms() {
    return (await describe(this.host, this.fn)).filter(([tag]) => tag === Console.TAG_MECHANISM).map(([, v]) => text(v));
  }

  /** A mechanism's number on the wire: its place in the probe's list (from 1); a name the probe does not list: 0 (the
   * probe refuses it unsupported). @param {string | number} mechanism */
  async mechanismNumber(mechanism) {
    if (typeof mechanism === 'number') return mechanism;
    const names = await this.mechanisms();
    return names.indexOf(mechanism) + 1;
  }

  /**
   * -> a new stream (u32) on the connection (console §2). mechanism: a name (looked up in describe) or the number. A
   * mechanism the probe lacks is rejected Unsupported; a connection with a live stream (any mechanism) is rejected
   * Unavailable (cause 6).
   * @param {number} conn @param {string | number} mechanism
   */
  async open(conn, mechanism = Console.DMSEQ) {
    const body = new Writer().u32(conn).u8(await this.mechanismNumber(mechanism)).done();
    const rd = new m.Reader((await this.call(Console.OPEN, body)).payload);
    this.stream = rd.u32();
    rd.tail();
    return this.stream;
  }

  /** Release the stream, its buffer and its send queue (console §2). */
  async close() { await this.call(Console.CLOSE, this.streamPrefix()); }

  /** The probe's live console streams, in the order they were made (oep-if-console §1, lock-free; paged by first(u16) /
   * more, each page from the number already read, until more 0): how a host without the lock finds a stream's number.
   * @returns {Promise<StreamInfo[]>} */
  async streams() {
    /** @type {StreamInfo[]} */
    const out = [];
    const names = await this.mechanisms();                   // the mechanism by name (core §7.7)
    for (;;) {
      const rd = new m.Reader((await this.call(Console.STREAMS, new Writer().u16(out.length).done(), { locked: false })).payload);   // first(u16)
      const more = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {   // count x entry (core §2.3)
        const stream = rd.u32(), connection = rd.u32(), mech = rd.u8();
        out.push({ stream, connection, mechanism: mech >= 1 && mech <= names.length ? names[mech - 1] : mech });
      }
      rd.tail();
      if (!more || !count || out.length > 0xffff) return out;
    }
  }
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

  /** (read, write) chunk sizes that fit the probe's frame: request header 10 (session_id included) + stream prefix +
   * count 2 (the console's stream u32, none on a fixture UART); result header 5 + start 8 + flags 1 + len 2. */
  async limits() { return [await this.readLimit(), await this.writeLimit()]; }

  async readLimit() {
    const frame = (await this.source.host.confirmed()).maxFrame;
    return Math.max(1, Math.min(/** @type {typeof StreamIO} */ (this.constructor).MAX_READ, frame - 16));
  }

  async writeLimit() {
    const frame = (await this.source.host.confirmed()).maxFrame;
    return Math.max(1, Math.min(await this.writeCap(), frame - 12 - this.source.streamPrefix().length));
  }

  /** The most one write sends (before the frame's limit). */
  async writeCap() { return /** @type {typeof StreamIO} */ (this.constructor).MAX_WRITE; }

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
    const c = await this.source.readFrom(this.position, Math.min(n, await this.readLimit()));
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
    const deadline = performance.now() + timeoutMs;
    let got = new Uint8Array();
    for (;;) {
      const at = indexOf(got, pat);
      if (at >= 0) {
        this.pending = concat(got.slice(at + pat.length), this.pending);
        return got.slice(0, at + pat.length);
      }
      if (performance.now() >= deadline) {
        this.pending = concat(got, this.pending);
        throw new Timeout(`no ${JSON.stringify(typeof pattern === 'string' ? pattern : Array.from(pattern))} within ${timeoutMs} ms`);
      }
      const chunk = await this.read(1000);
      got = concat(got, chunk);
      if (!chunk.length) await sleep(pollMs);
    }
  }

  /** All of `data`, in chunks that fit, each next one from where the last answer's accepted left off (a console's send
   * queue empties 2 or 3 bytes a poll); waits while nothing is accepted. No progress within timeoutMs (when given):
   * Timeout - an SDI console accepts nothing ever (console §3.1). @param {Uint8Array | string} data @param {{ timeoutMs?: number }} [opts] */
  async write(data, { timeoutMs } = {}) {
    let rest = typeof data === 'string' ? utf8(data) : data;
    const chunk = await this.writeLimit();
    let since = performance.now();
    while (rest.length) {
      let took = 0;
      try {
        took = await this.source.write(rest.slice(0, chunk));
      } catch (e) {
        if (!(e instanceof Failed) || !e.result?.ran) throw e;   // accepted 0: the queue was full (completed failed)
      }
      rest = rest.slice(took);
      if (took) since = performance.now();
      else {
        if (timeoutMs !== undefined && performance.now() - since > timeoutMs) throw new Timeout(`the target took nothing for ${timeoutMs} ms`);
        await sleep(5);   // the target has not taken the last chunk yet
      }
    }
  }
}

/** A console stream read from a position onwards (default: from now), as a plain byte stream. Build with
 * `await ConsoleIO.create(console, start?)`. A write chunk is at most what one frame carries; what the probe's send
 * queue takes is its `accepted` (host guide §14: the rest goes after a short wait). */
export class ConsoleIO extends StreamIO {
  /** @param {Console} console @param {bigint | null} position */
  constructor(console, position = null) {
    super(console, position);
    this.console = console;
  }

  /** The frame bounds it (`writeLimit`); the send queue takes what it can. */
  async writeCap() { return 0xffff; }
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
