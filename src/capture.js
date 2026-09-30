// @ts-check
// oep.fixture.logic / oep.fixture.analog / oep.fixture.capture-group revision 1 (oep-spec docs/oep-if-capture.ja.md:
// §1 layouts, §2 segments, §3 operations, §3.8 calibration, §4 groups). Numbers from `registry`.
//
// Times are the probe's one clock (ns since its boot, comparable within one boot_id, u64: BigInt): estimates with an
// uncertainty, the probe's known corrections applied. Stream positions are u64 too (BigInt). Analog values are always
// raw; the probe's 1st-order scale, its calibration data and its reference are for the host to choose from.
//
// configure: a TLV the probe cannot honour is refused (rejected unsupported, 0x0B, payload = the tag) when the host
// marked it critical, and otherwise ignored and listed in the answer's ignored TLV (0x7F, oep-core §2.3).

import * as reg from './registry.js';
import { Writer, getU16, getU64, text } from './bytes.js';
import * as m from './message.js';
import { Failed, ProtocolError, Timeout } from './errors.js';
import { Interface } from './core.js';

const CAP = reg.FIXTURE_LOGIC;
const ANA = reg.FIXTURE_ANALOG;
const GRP = reg.FIXTURE_CAPTURE_GROUP;

// configure TLVs; bit 7 of a tag = critical (the probe must reject what it cannot do)
const C = CAP.tlv.configure;
export const MODE = C.mode, RATE = C.rate, SAMPLES = C.samples, SEGMENTS = C.segments, TRIGGER = C.trigger;
export const PRETRIGGER = C.pretrigger, FRONTEND = C.frontend;
const A = ANA.tlv.configure_answer;
export const ACTUAL_RATE = A.actual_rate, LAYOUT = A.layout, ACTUAL_SAMPLES = A.actual_samples;
export const ACTUAL_SEGMENTS = A.actual_segments, TIMING = A.timing, SCALE = A.scale, BLOCKING = A.blocking_ms;
export const SKEW = A.skew, FRONTEND_USED = A.frontend_used, REFERENCE = A.reference, RATE_ACCURACY = A.rate_accuracy;
export const FACTORY = ANA.tlv.calibration_answer.factory, VREFINT = ANA.tlv.calibration_answer.vrefint;
/** @type {Record<number, string>} */
export const REFERENCE_SOURCE = Object.fromEntries(Object.entries(ANA.enum.reference_source).map(([k, v]) => [v, k]));
export const IGNORED = m.TAG_IGNORED;
export const CRITICAL = m.TAG_CRITICAL;
export const ONE_SHOT = CAP.enum.mode.one_shot, REPEAT = CAP.enum.mode.repeat, STREAMING = CAP.enum.mode.streaming;
const T = CAP.enum.trigger;
export const IMMEDIATE = T.immediate, LEVEL = T.level, EDGE = T.edge, CROSS_UP = T.cross_up, CROSS_DOWN = T.cross_down;
/** @type {Record<string, number>} */
export const STATE = CAP.enum.state;
/** @type {Record<string, number>} */
export const STOPPED_REASON = CAP.enum.stopped_reason;
/** @type {Record<string, number>} */
export const SEGMENT_FLAG = CAP.enum.segment_flag;
export const SEGMENT_GAP = SEGMENT_FLAG.gap, SEGMENT_SHORT = SEGMENT_FLAG.short, SEGMENT_SLIPPED = SEGMENT_FLAG.slipped;
// events (oep-core §11, role 0x05)
export const EVENT_SEGMENT = CAP.event.segment, EVENT_STOPPED = CAP.event.stopped, EVENT_TRIGGERED = CAP.event.triggered;
export const GROUP_EVENT_TRIGGERED = GRP.event.triggered, GROUP_EVENT_STOPPED = GRP.event.stopped;
export const NO_TIME = 0xffffffffffffffffn;
const NO_INDEX = 0xffffffff;

/** @param {Uint8Array} payload */
export function tlvs(payload) { return m.splitTlvs(payload); }

/** serial u32, position u64, samples u32, start_ns u64, start_uncertainty_ns u32, trigger_index u32, flags u8 */
export const SEGMENT_BYTES = 33;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

export class Segment {
  /**
   * @param {number} serial @param {bigint} position @param {number} samples
   * @param {bigint} startNs            the first sample's time on the probe's clock (an estimate)
   * @param {number} startUncertaintyNs +- of startNs (a guide, not a promise)
   * @param {number | null} triggerIndex @param {number} flags
   */
  constructor(serial, position, samples, startNs, startUncertaintyNs, triggerIndex, flags) {
    this.serial = serial; this.position = position; this.samples = samples; this.startNs = startNs;
    this.startUncertaintyNs = startUncertaintyNs; this.triggerIndex = triggerIndex; this.flags = flags;
  }

  /** flags bit0: a gap before this segment (no free segment, or pushed out). */
  get gap() { return (this.flags & SEGMENT_GAP) !== 0; }
  /** flags bit1: ended short (stop). */
  get short() { return (this.flags & SEGMENT_SHORT) !== 0; }
  /** flags bit2: the time base bent inside the segment (samples later than the timing answer, oep-if-capture §2). */
  get slipped() { return (this.flags & SEGMENT_SLIPPED) !== 0; }

  /** The known fields from a Reader; what follows them (a later revision's) is left for the caller to skip.
   * @param {m.Reader} rd */
  static read(rd) {
    const serial = rd.u32(), position = rd.u64(), samples = rd.u32(), startNs = rd.u64(), unc = rd.u32();
    const trig = rd.u32(), flags = rd.u8();
    return new Segment(serial, position, samples, startNs, unc, trig === NO_INDEX ? null : trig, flags);
  }

  /** @param {Uint8Array} b */
  static unpack(b) { return Segment.read(new m.Reader(b)); }
}

/** What configure answered: the probe's actual values (logic-capture §5.3). */
export class Config {
  constructor() {
    /** actual rate = rateNum / rateDen Hz (as sent) */
    this.rateNum = 0; this.rateDen = 1;
    /** logic: bits per sample (w) */ this.width = 0;
    /** @type {number[]} logic: bit of channel k within a sample */ this.positions = [];
    /** analog: slot bits (s) */ this.slot = 0;
    /** analog: value offset (o) */ this.offset = 0;
    /** analog: value bits (b) */ this.bits = 0;
    /** @type {number[]} analog: the channel of the m-th slot */ this.order = [];
    this.samples = 0;
    this.segments = 0;
    this.jitterKind = 0;
    this.jitterNs = 0;
    /** rate_accuracy: the rate was measured (else computed from a divider) */ this.rateMeasured = false;
    /** its uncertainty (0: unknown) */ this.ratePpm = 0;
    /** @type {Map<number, number>} analog, per channel (role) */ this.skewNs = new Map();
    /** @type {Map<number, number>} analog, per channel (signed) */ this.zero = new Map();
    /** @type {Map<number, number>} analog, nV per value, per channel (signed: an inverting frontend) */ this.scaleNv = new Map();
    /** @type {Map<number, number>} analog: the frontend each channel took */ this.frontend = new Map();
    /** @type {{ source: string, mv: number, measured: boolean } | null} analog: the ADC's reference */ this.reference = null;
    this.blockingMs = 0;
    /** @type {number[]} */ this.ignored = [];
  }

  /** The actual rate in Hz (a float; rateNum / rateDen exactly). */
  get rate() { return this.rateDen ? this.rateNum / this.rateDen : 0; }

  /** Length of one segment in the stream (§3.0 rule 4). */
  get bytes() { return segmentBytes(this, this.samples); }
}

/** Bytes of `samples` samples in this layout.
 * @param {Config} c @param {number} samples */
export function segmentBytes(c, samples) {
  if (c.width) return Math.floor((samples * c.width + 7) / 8);
  return Math.floor((samples * c.order.length * c.slot) / 8);
}

/** A configure / query answer decoded (unknown tags skipped).
 * @param {Uint8Array} payload @param {boolean} analog */
export function parseConfig(payload, analog) {
  const c = new Config();
  for (const [tag, v] of tlvs(payload)) {
    const rd = new m.Reader(v);
    if (tag === ACTUAL_RATE) { c.rateNum = rd.u32(); c.rateDen = rd.u32(); }
    else if (tag === LAYOUT && !analog) {
      c.width = rd.u8();
      c.positions = Array.from(rd.bytes(rd.u8()));
    } else if (tag === LAYOUT && analog) {
      c.slot = rd.u8(); c.offset = rd.u8(); c.bits = rd.u8();
      c.order = Array.from(rd.bytes(rd.u8()));
    } else if (tag === ACTUAL_SAMPLES) c.samples = rd.u32();
    else if (tag === ACTUAL_SEGMENTS) c.segments = rd.u32();
    else if (tag === TIMING) { c.jitterKind = rd.u8(); c.jitterNs = rd.u32(); }
    else if (tag === RATE_ACCURACY) { c.rateMeasured = rd.u8() === 1; c.ratePpm = rd.u32(); }
    else if (tag === SCALE && analog) {
      const role = rd.u8();
      c.zero.set(role, rd.i32());                     // signed: an inverting frontend (§3.3)
      c.scaleNv.set(role, rd.i32());
    } else if (tag === SKEW && analog) { const role = rd.u8(); c.skewNs.set(role, rd.u32()); }
    else if (tag === FRONTEND_USED && analog) { const role = rd.u8(); c.frontend.set(role, rd.u8()); }
    else if (tag === REFERENCE && analog) {
      const source = rd.u8(), mv = rd.u32(), how = rd.u8();
      c.reference = { source: REFERENCE_SOURCE[source] ?? String(source), mv, measured: how === 1 };
    } else if (tag === BLOCKING) c.blockingMs = rd.u32();
    else if (tag === IGNORED) c.ignored = Array.from(v);
  }
  return c;
}

/**
 * One segment as it was read, for whoever records runs (onCapture(host)): the probe's own words - no pin names, no
 * target (the recorder's caller knows those). armedMs / readMs: performance.now() at start() and at the read.
 * @typedef {{ fn: number, name: string, config: Config, segment: Segment, data: Uint8Array, armedMs: number | null, readMs: number }} CaptureRecord
 */

/** @type {WeakMap<object, ((record: CaptureRecord) => void)[]>} */
const recorders = new WeakMap();

/** The host's capture recorders (Python's Host.on_capture): push a callback; every readSegment() calls each.
 * @param {import('./host.js').Host} hst */
export function onCapture(hst) {
  let list = recorders.get(hst);
  if (!list) { list = []; recorders.set(hst, list); }
  return list;
}

/** What stream() collected: the bytes in arrival order, where the stream skipped (probe-side drops) and lost frames. */
export class Received {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.length = 0;
    /** @type {bigint | null} stream position of data[0] */ this.start = null;
    /** @type {[number, number][]} (index in data where it skipped, bytes skipped) */ this.gaps = [];
    /** push frames missing by seq */ this.seqLost = 0;
    this.frames = 0;
    this.skipped = 0n;
    /** @type {number | null} */ this.expectSeq = null;
    /** @type {Set<number>} events share the fn's seq (they stay on the link for the caller) */ this.eventSeqs = new Set();
  }

  get data() { return this.buf.subarray(0, this.length); }

  /** The stream position just after the last byte collected (null: nothing yet). */
  get reached() { return this.start === null ? null : this.start + BigInt(this.length) + this.skipped; }

  /** @param {Uint8Array} b */
  append(b) {
    if (this.length + b.length > this.buf.length) {
      const grown = new Uint8Array(Math.max(this.buf.length * 2, this.length + b.length));
      grown.set(this.data);
      this.buf = grown;
    }
    this.buf.set(b, this.length);
    this.length += b.length;
  }
}

/** @param {Uint8Array} frame */
const frameFn = (frame) => getU16(frame, 1);

/** @typedef {{ seq: number, position: bigint, data: Uint8Array }} Push */

/** @param {Uint8Array} f @returns {Push} */
function unpackPush(f) {
  // the core header is role fn seq; the capture's payload is position(u64) then data (standard position stream)
  return { seq: getU16(f, 3), position: getU64(f, 5), data: f.slice(13) };
}

/** Remove this fn's data pushes (role 0x06) from the link: [{seq, position, data}], oldest first.
 * @param {{ pushes: Uint8Array[] }} link @param {number} fn */
export function takePushes(link, fn) {
  /** @type {Uint8Array[]} */ const mine = [];
  /** @type {Uint8Array[]} */ const rest = [];
  for (const f of link.pushes) (frameFn(f) === fn ? mine : rest).push(f);
  link.pushes.splice(0, link.pushes.length, ...rest);
  return mine.map(unpackPush);
}

/**
 * A capture track's event (oep-if-capture §3.4) decoded. Bytes after the known fields (a later revision's) are
 * skipped; a kind this client does not know comes back with only its payload.
 * @typedef {{ fn: number, seq: number, kind: number, payload: Uint8Array, segment?: Segment, reason?: number,
 *   serial?: number, triggerIndex?: number | null, triggerNs?: bigint | null, triggerFn?: number }} CaptureEvent
 */

/** @param {Uint8Array} frame  role(0x05) fn(u16) seq(u16) kind(u8) payload @returns {CaptureEvent} */
export function parseEvent(frame) {
  const rd = new m.Reader(frame);
  rd.u8();
  const fn = rd.u16(), seq = rd.u16(), kind = rd.u8();
  return { fn, seq, kind, payload: frame.slice(rd.at) };
}

/** @param {Uint8Array} frame */
export function parseCaptureEvent(frame) {
  const e = parseEvent(frame);
  const rd = new m.Reader(e.payload);
  if (e.kind === EVENT_SEGMENT) e.segment = Segment.read(rd);
  else if (e.kind === EVENT_STOPPED) e.reason = rd.u8();
  else if (e.kind === EVENT_TRIGGERED) {
    e.serial = rd.u32();
    const i = rd.u32();
    e.triggerIndex = i === NO_INDEX ? null : i;
    const ns = rd.u64();
    e.triggerNs = ns === NO_TIME ? null : ns;
  }
  return e;
}

/** A capture group's event (§4.2).
 * @param {Uint8Array} frame */
export function parseGroupEvent(frame) {
  const e = parseEvent(frame);
  const rd = new m.Reader(e.payload);
  if (e.kind === GROUP_EVENT_TRIGGERED) {
    e.triggerFn = rd.u16();
    const ns = rd.u64();
    e.triggerNs = ns === NO_TIME ? null : ns;
  } else if (e.kind === GROUP_EVENT_STOPPED) e.reason = rd.u8();
  return e;
}

/** @typedef {{ state: number, segmentsDone: number, writePos: bigint, flags: number }} CaptureStatus */

/**
 * @typedef {object} ConfigureOptions
 * @property {number} rate                  Hz (analog: per channel)
 * @property {number} [mode]                ONE_SHOT (default), REPEAT, STREAMING
 * @property {number} [samples]
 * @property {number} [segments]
 * @property {[number, number, number]} [trigger]  (type, role, value)
 * @property {number} [pretrigger]
 * @property {boolean} [query]              ask only (query op, no lock, nothing changes)
 * @property {Iterable<number>} [critical]  tags the probe must honour or reject (Unsupported, .tag = the one it cannot)
 * @property {Map<number, number> | Record<number, number>} [frontends]  analog: role -> frontend (describe frontend)
 */

/** Basic logic capture. Channels are the plan's roles 0..C-1. */
export class LogicCapture extends Interface {
  static NAME = 'oep.fixture.logic';
  static REVISION = 1;
  static CONFIGURE = CAP.op.configure; static START = CAP.op.start; static STOP = CAP.op.stop;
  static FORCE = CAP.op.force; static STATUS = CAP.op.status; static READ = CAP.op.read;
  static SEGMENTS = CAP.op.segments; static RELEASE = CAP.op.release; static QUERY_OP = CAP.op.query;
  /** batches of reads sent again after the link's own repeat failed too */ static READ_TRIES = 4;
  /** frame-sized reads per pipeline; a keepalive between batches when a session is open */ static BATCH = 16;

  /** @param {import('./host.js').Host} hst @param {number} fn @param {string} name @param {Uint8Array} prefix */
  constructor(hst, fn, name, prefix = new Uint8Array()) {
    super(hst, fn, name, prefix);
    /** @type {Config | null} */ this.config = null;
    /** @type {number | null} performance.now() at the last start() */ this.armedMs = null;
  }

  /** @returns {boolean} */
  get analog() { return false; }

  /** The config set by the last configure (throws when there is none). */
  get cfg() {
    if (!this.config) throw new Error(`${this.name}: configure first`);
    return this.config;
  }

  /** -> the probe's actual values (Config.ignored: tags the probe ignored).
   * @param {ConfigureOptions} opts */
  async configure({ rate, mode = ONE_SHOT, samples, segments, trigger, pretrigger, query = false, critical = [], frontends }) {
    const crit = new Set(critical);
    const w = new Writer();
    /** @param {number} tag @param {Uint8Array} value */
    const put = (tag, value) => w.raw(m.tlv(tag, value, crit.has(tag)));
    put(MODE, Uint8Array.of(mode));
    put(RATE, new Writer().u32(rate).done());
    if (samples !== undefined) put(SAMPLES, new Writer().u32(samples).done());
    if (segments !== undefined) put(SEGMENTS, new Writer().u32(segments).done());
    if (trigger !== undefined) put(TRIGGER, new Writer().u8(trigger[0]).u8(trigger[1]).u16(trigger[2]).done());
    if (pretrigger !== undefined) put(PRETRIGGER, new Writer().u32(pretrigger).done());
    const fe = frontends instanceof Map ? [...frontends] : Object.entries(frontends ?? {}).map(([k, v]) => [Number(k), v]);
    for (const [role, f] of fe.sort((a, b) => a[0] - b[0])) put(FRONTEND, Uint8Array.of(role, f));   // analog: the input range
    // query is its own operation: the lock is decided per operation, before the payload is looked at
    const op = query ? LogicCapture.QUERY_OP : LogicCapture.CONFIGURE;
    const c = parseConfig((await this.call(op, w.done(), { locked: !query })).payload, this.analog);
    if (!query) this.config = c;
    return c;
  }

  /** configure's values checked without setting anything (no lock).
   * @param {Omit<ConfigureOptions, 'query'>} opts */
  query(opts) { return this.configure({ ...opts, query: true }); }

  /** Events, and in streaming the data pushes (oep-core §11): send when minBytes are ready or maxDelayMs after the
   * first byte (0, 0: as soon as there is anything). */
  subscribe(minBytes = 0, maxDelayMs = 0) { return this.host.subscribe(this.fn, minBytes, maxDelayMs); }

  unsubscribe() { return this.host.unsubscribe(this.fn); }

  /** The next event of this fn (of one of `kinds`, if given), decoded; null after timeoutMs.
   * @param {number[] | null} kinds @param {number} timeoutMs */
  async nextEvent(kinds = null, timeoutMs = 1000) {
    const f = await this.host.link.nextEvent((e) => frameFn(e) === this.fn && (!kinds || kinds.includes(e[5])), timeoutMs);
    return f ? parseCaptureEvent(f) : null;
  }

  /**
   * Streaming: collect data pushes until `nbytes` have arrived or `ms` have passed (at least one is needed). A
   * position that does not follow the previous push is a probe-side drop (a gap); a seq that skips is a lost frame.
   * The subscription ends with the lock, so the lock is kept alive every `keepaliveMs` while collecting.
   * @param {{ ms?: number, nbytes?: number, into?: Received, keepaliveMs?: number }} opts
   */
  async stream({ ms, nbytes, into, keepaliveMs = 1000 } = {}) {
    if (ms === undefined && nbytes === undefined) throw new RangeError('stream() needs ms or nbytes');
    const link = this.host.link;
    const got = into ?? new Received();
    const deadline = ms !== undefined ? now() + ms : null;
    let kept = now();
    /** @type {Push[]} */
    let first = [];
    for (;;) {
      for (const e of link.events) if (frameFn(e) === this.fn) got.eventSeqs.add(getU16(e, 3));
      for (const { seq, position, data } of [...first, ...takePushes(link, this.fn)]) {
        while (got.expectSeq !== null && got.expectSeq !== seq) {
          if (got.eventSeqs.has(got.expectSeq)) got.eventSeqs.delete(got.expectSeq);
          else got.seqLost++;
          got.expectSeq = (got.expectSeq + 1) & 0xffff;
        }
        got.expectSeq = (seq + 1) & 0xffff;
        if (got.start === null) got.start = position;
        else {
          const skipped = position - /** @type {bigint} */ (got.reached);   // u64 positions: no wrap
          if (skipped) { got.gaps.push([got.length, Number(skipped)]); got.skipped += skipped; }
        }
        got.append(data);
        got.frames++;
      }
      first = [];
      if (keepaliveMs && this.host.session !== null && now() - kept >= keepaliveMs) {
        await this.host.keepalive();
        kept = now();
      }
      if (nbytes !== undefined && got.length >= nbytes) return got;
      if (deadline !== null && now() >= deadline) return got;
      const wait = Math.max(0, Math.min(20, deadline !== null ? deadline - now() : 20));
      const f = await link.nextPush((p) => frameFn(p) === this.fn, wait);
      if (f) first = [unpackPush(f)];
    }
  }

  /** Streaming, after stop(): collect the pushes still to come, up to the last byte captured (status's write
   * position), or until `timeoutMs`.
   * @param {Received} got @param {number} timeoutMs */
  async finish(got, timeoutMs = 5000) {
    const end = (await this.status()).writePos;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (got.reached === end) return got;
      await this.stream({ ms: Math.min(100, Math.max(0, deadline - now())), into: got });
    }
    return got;
  }

  /** -> blockingMs (0: the probe keeps answering while it captures). */
  async start() {
    const blocking = new m.Reader((await this.call(LogicCapture.START)).payload).u32();
    this.armedMs = now();
    return blocking;
  }

  async stop() { await this.call(LogicCapture.STOP); }

  /** Waiting for the trigger: start now (the segment's triggerIndex marks where). */
  async force() { await this.call(LogicCapture.FORCE); }

  /** @returns {Promise<CaptureStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(LogicCapture.STATUS, new Uint8Array(), { locked: false })).payload);
    return { state: rd.u8(), segmentsDone: rd.u32(), writePos: rd.u64(), flags: rd.u8() };
  }

  /** Repeat: segments up to `serial` may be reused. @param {number} serial */
  async release(serial) { await this.call(LogicCapture.RELEASE, new Writer().u32(serial).done()); }

  /** @param {number} fromSerial */
  async segments(fromSerial = 0) {
    const rd = new m.Reader((await this.call(LogicCapture.SEGMENTS, new Writer().u32(fromSerial).done(), { locked: false })).payload);
    const n = rd.u8();
    const out = [];
    for (let i = 0; i < n; i++) out.push(Segment.read(rd.element()));
    rd.tail();
    return out;
  }

  /** Poll status until the one-shot is done (or failed). -> its segments. Waiting for a trigger may take longer than
   * the lease: the lock is kept alive every `keepaliveMs` (status needs no lock, so it does not).
   * @param {{ timeoutMs?: number, keepaliveMs?: number }} [opts] */
  async wait({ timeoutMs = 5000, keepaliveMs = 1000 } = {}) {
    const deadline = now() + timeoutMs;
    let kept = now();
    const known = new Set(Object.values(STATE));
    while (now() < deadline) {
      if (keepaliveMs && this.host.session !== null && now() - kept >= keepaliveMs) {
        await this.host.keepalive();
        kept = now();
      }
      const { state } = await this.status();
      if (state === STATE.done) return this.segments();
      if (state === STATE.error) throw new Failed(null, 'the capture stopped with an error');
      if (!known.has(state)) throw new ProtocolError(`capture state ${state} is not one this client knows`);
      await sleep(2);
    }
    throw new Timeout('capture did not finish');
  }

  /**
   * Bytes [position, position+length) of the stream, pipelined in frame-sized reads. The reads need no lock and go
   * without the session id, so a batch whose answers did not come is simply sent again (reads are not deduplicated,
   * oep-core §5.2). They do not extend the lease: a long read sends a keepalive between batches.
   * @param {bigint | number} position @param {number} length
   */
  async read(position, length) {
    const pos = BigInt(position);
    const chunk = Math.max(1, (await this.host.confirmed()).maxFrame - 16);
    const offsets = [];
    for (let off = 0; off < length; off += chunk) offsets.push(off);
    const out = new Uint8Array(length);
    const B = LogicCapture.BATCH;
    /** @param {bigint} at @param {number} n */
    const body = (at, n) => new Writer().u64(at).u32(n).done();
    for (let at = 0; at < offsets.length; at += B) {
      if (at && this.host.session !== null) await this.host.keepalive();
      const batch = offsets.slice(at, at + B);
      /** @type {m.Result[]} */
      let replies = [];
      for (let attempt = 0; ; attempt++) {
        const reqs = batch.map((off) => this.req(LogicCapture.READ, body(pos + BigInt(off), Math.min(chunk, length - off))));
        try {
          replies = await this.host.pipelineCalls(reqs, { locked: false });
          break;
        } catch (e) {
          // the link sent each once more already; a read changes nothing, so the whole batch can go again
          if (!(e instanceof Timeout) || attempt === LogicCapture.READ_TRIES - 1) throw e;
        }
      }
      for (let i = 0; i < batch.length; i++) {
        const off = batch[i];
        const want = Math.min(chunk, length - off);
        let data = replies[i].payload.subarray(9);            // after position(u64) flags(u8)
        let have = Math.min(data.length, want);
        out.set(data.subarray(0, have), off);
        while (have < want) {                                  // a short answer: read on from where it stopped
          const from = pos + BigInt(off + have);
          data = (await this.call(LogicCapture.READ, body(from, want - have), { locked: false })).payload.subarray(9);
          if (!data.length) throw new ProtocolError(`read at ${from} returned nothing`);
          const n = Math.min(data.length, want - have);
          out.set(data.subarray(0, n), off + have);
          have += n;
        }
      }
    }
    return out;
  }

  /** The segment's bytes; every onCapture(host) callback gets them as a CaptureRecord.
   * @param {Segment} segment */
  async readSegment(segment) {
    const c = this.cfg;
    const data = await this.read(segment.position, segmentBytes(c, segment.samples));
    const list = recorders.get(this.host);
    if (list && list.length) {
      /** @type {CaptureRecord} */
      const record = { fn: this.fn, name: this.name, config: c, segment, data, armedMs: this.armedMs, readMs: now() };
      for (const cb of [...list]) cb(record);
    }
    return data;
  }

  // ---- the §3.0 layout ------------------------------------------------------------------------------------

  /** Channel k's values, one per sample (§3.0 rules 1-3).
   * @param {Uint8Array} data @param {number} k @param {number} [samples] */
  channel(data, k, samples) {
    const c = this.cfg;
    const n = samples ?? Math.floor((data.length * 8) / c.width);
    const bit0 = c.positions[k];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const bit = i * c.width + bit0;
      out[i] = (data[bit >>> 3] >> (bit & 7)) & 1;
    }
    return out;
  }

  /**
   * A sigrok session file (.sr, a zip) as bytes: bit k of each sample = channel k, one byte per sample up to 8
   * channels, two (little endian, sigrok's unitsize 2) up to 16. The zip is stored (uncompressed).
   * @param {Uint8Array} data @param {number} samples @param {string[]} [names]
   */
  toSr(data, samples, names) {
    const c = this.cfg;
    const nCh = c.positions.length;
    if (nCh > 16) throw new RangeError('toSr writes up to 16 channels');
    const unit = nCh <= 8 ? 1 : 2;
    const nm = names ?? Array.from({ length: nCh }, (_, k) => `D${k}`);
    const chans = Array.from({ length: nCh }, (_, k) => this.channel(data, k, samples));
    const out = new Uint8Array(samples * unit);
    for (let i = 0; i < samples; i++) {
      let v = 0;
      for (let k = 0; k < nCh; k++) v |= chans[k][i] << k;
      out[i * unit] = v & 0xff;
      if (unit === 2) out[i * unit + 1] = v >> 8;
    }
    const rate = c.rateDen ? Math.floor(c.rateNum / c.rateDen) : 0;
    const meta = ['[global]', 'sigrok version=0.5.2', '', '[device 1]', 'capturefile=logic-1',
      `total probes=${nCh}`, `samplerate=${rate} Hz`, 'total analog=0',
      ...nm.map((s, k) => `probe${k + 1}=${s}`), `unitsize=${unit}`, ''];
    const enc = new TextEncoder();
    return storedZip([['version', enc.encode('2')], ['metadata', enc.encode(meta.join('\n'))], ['logic-1-1', out]]);
  }
}

// ---- a stored zip (sigrok files), no dependencies ------------------------------------------------------------

/** @type {Uint32Array | null} */
let crcTable = null;
/** CRC-32 (zip's, reflected 0xEDB88320). @param {Uint8Array} b */
function crc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {[string, Uint8Array][]} files */
function storedZip(files) {
  const enc = new TextEncoder();
  const local = new Writer();
  const central = new Writer();
  for (const [name, data] of files) {
    const n = enc.encode(name), crc = crc32(data), at = local.bytes.length;
    // version 20, no flags, stored, 1980-01-01 00:00
    local.u32(0x04034b50).u16(20).u16(0).u16(0).u16(0).u16(0x21).u32(crc).u32(data.length).u32(data.length)
      .u16(n.length).u16(0).raw(n).raw(data);
    central.u32(0x02014b50).u16(20).u16(20).u16(0).u16(0).u16(0).u16(0x21).u32(crc).u32(data.length).u32(data.length)
      .u16(n.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(at).raw(n);
  }
  const cd = central.done(), at = local.bytes.length;
  return local.raw(cd).u32(0x06054b50).u16(0).u16(0).u16(files.length).u16(files.length).u32(cd.length).u32(at).u16(0).done();
}

/**
 * What the probe knows for turning an analog value into a voltage (oep-if-capture §3.8), raw: the probe applies none
 * of it. factory: {frontend (null: any), scheme (how to read raw), raw}; vrefint: the internal reference measured
 * after the last start.
 * @typedef {{ factory: { frontend: number | null, scheme: string, raw: Uint8Array }[], vrefint: { raw: number, ns: bigint } | null }} Calibration
 */

/** Basic analog capture (oep.fixture.analog): the same operations as the logic one; values are raw (§1.2). */
export class AnalogCapture extends LogicCapture {
  static NAME = 'oep.fixture.analog';
  static CALIBRATION = ANA.op.calibration;

  get analog() { return true; }

  /** Channel k's raw values (§1.2: slot s bits little endian, the value in bits o .. o+b-1, frames in `order`).
   * @param {Uint8Array} data @param {number} k @param {number} [samples] */
  values(data, k, samples) {
    const c = this.cfg;
    const width = c.slot / 8;
    const frame = width * c.order.length;
    const n = samples ?? Math.floor(data.length / frame);
    const at = c.order.indexOf(k);
    if (at < 0) throw new RangeError(`channel ${k} is not in the layout`);
    const mask = c.bits >= 32 ? 0xffffffff : (1 << c.bits) - 1;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * frame + at * width;
      let v = 0;
      for (let b = width - 1; b >= 0; b--) v = v * 256 + data[p + b];
      out[i] = Math.floor(v / 2 ** c.offset) & mask;
      if (out[i] < 0) out[i] += 2 ** 32;
    }
    return out;
  }

  /** The probe's own 1st-order reading of a raw value of channel k, (value - zero) x scale_nv (a nominal reference:
   * see reference and calibration() for others). @param {number} k @param {number} value */
  millivolts(k, value) {
    const c = this.cfg;
    return ((value - (c.zero.get(k) ?? 0)) * (c.scaleNv.get(k) ?? 0)) / 1_000_000;
  }

  /** @returns {Promise<Calibration>} */
  async calibration() {
    /** @type {Calibration} */
    const out = { factory: [], vrefint: null };
    for (const [tag, v] of tlvs((await this.call(AnalogCapture.CALIBRATION, new Uint8Array(), { locked: false })).payload)) {
      const rd = new m.Reader(v);
      if (tag === FACTORY) {
        const fe = rd.u8(), n = rd.u8();
        out.factory.push({ frontend: fe === 0xff ? null : fe, scheme: text(rd.bytes(n)), raw: rd.rest() });
      } else if (tag === VREFINT) out.vrefint = { raw: rd.u32(), ns: rd.u64() };
    }
    return out;
  }
}

/** @typedef {{ state: number, startNs: bigint | null, triggerNs: bigint | null, triggerFn: number | null }} GroupStatus */

/**
 * oep.fixture.capture-group (§4): tracks (LogicCapture / AnalogCapture, each configured as usual) started together,
 * one of them the trigger. Each track is read as usual; a track's offset is its first segment's startNs minus the
 * group's startNs, and every track's segment marks the trigger's instant (triggerIndex).
 */
export class CaptureGroup extends Interface {
  static NAME = 'oep.fixture.capture-group';
  static REVISION = 1;
  static BIND = GRP.op.bind; static START = GRP.op.start; static STOP = GRP.op.stop;
  static FORCE = GRP.op.force; static STATUS = GRP.op.status;
  static TAG_TRIGGER_TRACK = GRP.tlv.bind.trigger_track;
  static EVENT_TRIGGERED = GROUP_EVENT_TRIGGERED; static EVENT_STOPPED = GROUP_EVENT_STOPPED;
  static NO_TIME = NO_TIME;

  /** Bind these (configured) tracks; [] unbinds. `trigger`: the track whose configure trigger starts them all.
   * @param {LogicCapture[]} tracks @param {LogicCapture | null} trigger */
  async bind(tracks, trigger = null) {
    const w = new Writer().u8(tracks.length);
    for (const t of tracks) w.u16(t.fn);
    if (trigger) w.raw(m.tlv(CaptureGroup.TAG_TRIGGER_TRACK, new Writer().u16(trigger.fn).done(), true));
    await this.call(CaptureGroup.BIND, w.done());
  }

  /** -> {blockingMs, startNs: the group's start}. `tracks`: whose armedMs to set (for records).
   * @param {LogicCapture[]} tracks */
  async start(tracks = []) {
    const rd = new m.Reader((await this.call(CaptureGroup.START)).payload);
    const blockingMs = rd.u32(), startNs = rd.u64();
    const t = now();
    for (const tr of tracks) tr.armedMs = t;
    return { blockingMs, startNs };
  }

  async stop() { await this.call(CaptureGroup.STOP); }

  async force() { await this.call(CaptureGroup.FORCE); }

  /** @returns {Promise<GroupStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(CaptureGroup.STATUS, new Uint8Array(), { locked: false })).payload);
    const state = rd.u8(), start = rd.u64(), trig = rd.u64(), fn = rd.u16();
    return { state, startNs: start === NO_TIME ? null : start, triggerNs: trig === NO_TIME ? null : trig, triggerFn: fn || null };
  }

  /** The group's next event (of one of `kinds`, if given), decoded; null after timeoutMs.
   * @param {number[] | null} kinds @param {number} timeoutMs */
  async nextEvent(kinds = null, timeoutMs = 1000) {
    const f = await this.host.link.nextEvent((e) => frameFn(e) === this.fn && (!kinds || kinds.includes(e[5])), timeoutMs);
    return f ? parseGroupEvent(f) : null;
  }

  subscribe(minBytes = 0, maxDelayMs = 0) { return this.host.subscribe(this.fn, minBytes, maxDelayMs); }

  unsubscribe() { return this.host.unsubscribe(this.fn); }

  /** Poll until every track is done (one-shot). The lock is kept alive every `keepaliveMs` while it waits (a trigger
   * may come later than the lease). @param {{ timeoutMs?: number, keepaliveMs?: number }} [opts] */
  async wait({ timeoutMs = 5000, keepaliveMs = 1000 } = {}) {
    const deadline = now() + timeoutMs;
    let kept = now();
    while (now() < deadline) {
      if (keepaliveMs && this.host.session !== null && now() - kept >= keepaliveMs) {
        await this.host.keepalive();
        kept = now();
      }
      const st = await this.status();
      if (st.state === STATE.done) return st;
      if (st.state === STATE.error) throw new Failed(null, "the group's capture stopped with an error");
      await sleep(2);
    }
    throw new Timeout("the group's capture did not finish");
  }
}
