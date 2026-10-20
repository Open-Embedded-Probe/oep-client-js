// @ts-check
// oep.fixture.logic / oep.fixture.analog / oep.fixture.capture-group revision 1 (oep-spec interfaces/oep-if-capture.ja.md:
// §1 layouts, §2 segments, §3 operations, §3.7 calibration, §4 groups). Numbers from `registry`.
//
// Times are the probe's one clock (ns since its boot, comparable within one boot_id, u64: BigInt): estimates with an
// uncertainty, the probe's known corrections applied. Stream positions are u64 too (BigInt). Analog values are always
// raw; the probe's 1st-order scale, its calibration data and its reference are for the host to choose from.
//
// Every start begins a new generation (u32: 1 at the first start after boot, 0 only before the first start; a start
// past 0xFFFFFFFF is refused unavailable cause 2 until a reboot; compared for equality only): segment serials and
// positions count from 0 inside it, and read and release name it, so a read sent for the last capture never returns
// the next one's bytes (oep-if-capture §0, §3.2). The client keeps it (`LogicCapture.generation`, from start / status /
// the group's start) and passes it on; `readSegment` takes the segment's own. Every event carries the generation it
// was made in (segment, stopped, triggered; the group's events the group's): one of an earlier start may come after
// the start's answer (core §10.4), so `nextEvent` passes over it (`staleEvents`). Segment serials wrap (core §2.6) and
// segments pages by common §1.3.
//
// configure (§3.3's contract, checked before sending - RangeError): mode and rate always; samples in modes 1 and 2,
// never in mode 3; segments in mode 2 only; pretrigger only with a trigger (type other than 0); rate, samples and
// segments 1 or more; a type 0 trigger goes as role 0 value 0. The table's TLVs go without the critical bit (every
// probe of the interface implements them); format, carriage, block_max and trigger_opts go critical. A value the probe
// cannot honour is refused unsupported with the tag as received (core §2.3) - which one, when several apply, is the
// probe's choice, so this client never relies on the order. The probe rounds samples down to its limit and the answer
// (Config.samples / .segments) is what holds.
//
// Data formats (§1): 0 the packed samples, 1 the logic blocks (`blocks`, `columns`: captureblocks.js), 4 the test
// counter. Streaming (§3.4): every data frame carries its generation and its segment (segment_info: the segment's
// position, the samples taken so far, start_ns and its uncertainty) and stays inside that segment;
// `Received.segments` keeps what the frames said.
//
// Errors (§2.2): a segment's bytes may arrive before the segment ends; when the track stops in error, status's
// write_pos is the start of the segment not kept and the bytes received at or past it are dropped
// (`Received.dropFrom`, `LogicCapture.finish` does it).

import * as reg from './registry.js';
import { Writer, getU16, getU32, getU64, text } from './bytes.js';
import * as m from './message.js';
import { Failed, ProtocolError, Timeout } from './errors.js';
import { Interface, describe } from './core.js';
import * as blocks from './captureblocks.js';

const CAP = reg.FIXTURE_LOGIC;
const ANA = reg.FIXTURE_ANALOG;
const GRP = reg.FIXTURE_CAPTURE_GROUP;

// configure TLVs; bit 7 of a tag = critical (the probe must reject what it cannot do)
const C = CAP.tlv.configure;
export const MODE = C.mode, RATE = C.rate, SAMPLES = C.samples, SEGMENTS = C.segments, TRIGGER = C.trigger;
export const PRETRIGGER = C.pretrigger, TRIGGER_OPTS = C.trigger_opts, FORMAT = C.format, CARRIAGE = C.carriage;
export const BLOCK_MAX = C.block_max;
/** analog only: the input range per channel */
export const FRONTEND = ANA.tlv.configure.frontend;
const A = ANA.tlv.configure_answer;
export const ACTUAL_RATE = A.actual_rate, LAYOUT = A.layout, ACTUAL_SAMPLES = A.actual_samples;
export const ACTUAL_SEGMENTS = A.actual_segments, SCALE = A.scale, SKEW = A.skew, FRONTEND_USED = A.frontend_used;
export const REFERENCE = A.reference, ANSWER_FORMAT = A.format, ANSWER_BLOCK = A.block, STREAM_BUFFER = A.stream_buffer;
export const JUDGE_LATENCY = A.judge_latency_ns;
export const DATA_FORMAT = CAP.enum.data_format;
export const LOGIC_CARRIAGE = CAP.enum.logic_carriage;
export const FACTORY = ANA.tlv.calibration_answer.factory, VREFINT = ANA.tlv.calibration_answer.vrefint;
/** status's TLV: why the state is 6 */
export const STATUS_ERROR = CAP.tlv.status_answer.error;
/** a data frame's TLV: its generation (always there in streaming) */
export const DATA_GENERATION = CAP.tlv.data.generation;
/** a streaming data frame's TLV: its segment - position samples start_ns uncertainty (§3.4) */
export const SEGMENT_INFO = CAP.tlv.data.segment_info;
/** @type {Record<number, string>} */
export const REFERENCE_SOURCE = Object.fromEntries(Object.entries(ANA.enum.reference_source).map(([k, v]) => [v, k]));
export const CRITICAL = m.TAG_CRITICAL;
export const ONE_SHOT = CAP.enum.mode.one_shot, REPEAT = CAP.enum.mode.repeat, STREAMING = CAP.enum.mode.streaming;
const LT = CAP.enum.trigger, AT = ANA.enum.trigger;   // logic: immediate / level / edge / linked; analog: cross_up / cross_down
export const IMMEDIATE = LT.immediate, LEVEL = LT.level, EDGE = LT.edge, LINKED = LT.linked;
export const CROSS_UP = AT.cross_up, CROSS_DOWN = AT.cross_down;
/** @type {Record<string, number>} */
export const STATE = CAP.enum.state;
/** @type {Record<string, number>} */
export const STOPPED_REASON = CAP.enum.stopped_reason;
/** @type {Record<number, string>} */
export const STOPPED_REASONS = Object.fromEntries(Object.entries(CAP.enum.stopped_reason).map(([k, v]) => [v, k]));
/** status's flags: dropped, slipped, rearm_waiting (reset at start) @type {Record<string, number>} */
export const STATUS_FLAG = CAP.enum.status_flag;
/** state 6's reason -> its name @type {Record<number, string>} */
export const ERRORS = Object.fromEntries(Object.entries(CAP.enum.error).map(([k, v]) => [v, k]));
/** @type {Record<string, number>} */
export const SEGMENT_FLAG = CAP.enum.segment_flag;
export const SEGMENT_GAP = SEGMENT_FLAG.gap, SEGMENT_SHORT = SEGMENT_FLAG.short, SEGMENT_SLIPPED = SEGMENT_FLAG.slipped;
export const SEGMENT_REARM = SEGMENT_FLAG.rearm;
// events (oep-core §10, role 0x03); the group's stopped is numbered as the tracks' (§4.2)
export const EVENT_SEGMENT = CAP.event.segment, EVENT_STOPPED = CAP.event.stopped, EVENT_TRIGGERED = CAP.event.triggered;
export const GROUP_EVENT_TRIGGERED = GRP.event.triggered, GROUP_EVENT_STOPPED = GRP.event.stopped;
export const NO_TIME = 0xffffffffffffffffn;
const NO_INDEX = 0xffffffff;
/** a triggered event's record when there is none (§3.10) */
export const NO_RECORD = 0xffffffff;
/** serial u32, sample u64, trigger_ns u64, uncertainty_ns u32 (§3.10) */
export const TRIGGER_RECORD_BYTES = 24;
/** read's flags bit1 (§3.2): the bytes asked for are gone, the answer moved on */
export const READ_GAP = 0x02;

/** @param {Uint8Array} payload */
export function tlvs(payload) { return m.splitTlvs(payload); }

/** read() asked for bytes the probe no longer has (§3.2: a position re-used or pushed on - the answer moved on to the
 * next readable position, gap set): `position` is where readable data starts (write_pos when none is left). */
export class ReadGap extends ProtocolError {
  /** @param {bigint} asked @param {bigint} position */
  constructor(asked, position) {
    super(`capture read at ${asked}: those bytes are gone, readable from ${position} (oep-if-capture §3.2)`);
    this.asked = asked; this.position = position;
  }
}

/** serial u32, position u64, samples u32, start_ns u64, start_uncertainty_ns u32, trigger_index u32, flags u8,
 * generation u32 (oep-if-capture §2) */
export const SEGMENT_BYTES = 37;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

export class Segment {
  /**
   * @param {number} serial @param {bigint} position @param {number} samples
   * @param {bigint} startNs            the first sample's time on the probe's clock (an estimate)
   * @param {number} startUncertaintyNs +- of startNs (a guide, not a promise)
   * @param {number | null} triggerIndex @param {number} flags
   * @param {number} generation         the start this segment belongs to (read / release name it)
   */
  constructor(serial, position, samples, startNs, startUncertaintyNs, triggerIndex, flags, generation = 0) {
    this.serial = serial; this.position = position; this.samples = samples; this.startNs = startNs;
    this.startUncertaintyNs = startUncertaintyNs; this.triggerIndex = triggerIndex; this.flags = flags;
    this.generation = generation;
  }

  /** flags bit0: a gap before this segment (no free segment, or pushed out). */
  get gap() { return (this.flags & SEGMENT_GAP) !== 0; }
  /** flags bit1: ended short (stop). */
  get short() { return (this.flags & SEGMENT_SHORT) !== 0; }
  /** flags bit2: the time base bent inside the segment - a sample taken one sample period or more late (§2). */
  get slipped() { return (this.flags & SEGMENT_SLIPPED) !== 0; }
  /** flags bit3: rearm 1's segment, begun by its own trigger (§2.1). */
  get rearm() { return (this.flags & SEGMENT_REARM) !== 0; }

  /** @param {m.Reader} rd */
  static read(rd) {
    const serial = rd.u32(), position = rd.u64(), samples = rd.u32(), startNs = rd.u64(), unc = rd.u32();
    const trig = rd.u32(), flags = rd.u8(), generation = rd.u32();
    return new Segment(serial, position, samples, startNs, unc, trig === NO_INDEX ? null : trig, flags, generation);
  }

  /** @param {Uint8Array} b */
  static unpack(b) { return Segment.read(new m.Reader(b)); }
}

/** What configure answered: the probe's actual values (oep-if-capture §3.3). */
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
    /** @type {Map<number, number>} analog, per channel (role) */ this.skewNs = new Map();
    /** @type {Map<number, number>} analog, per channel (signed) */ this.zero = new Map();
    /** @type {Map<number, number>} analog, nV per value, per channel (signed: an inverting frontend) */ this.scaleNv = new Map();
    /** @type {Map<number, number>} analog: the frontend each channel took */ this.frontend = new Map();
    /** @type {{ source: string, mv: number, measured: boolean | string } | null} analog: the ADC's reference (an unknown
     * how as its number in text) */ this.reference = null;
    /** what this host asked */ this.pretrigger = 0;
    /** the data format in use (§1; absent: 0) */ this.format = 0;
    /** formats 1 / 2: L */ this.block = 0;
    /** @type {number | null} streaming: the most bytes held unsent (§3.3; null: not said) */ this.streamBuffer = null;
    /** @type {number | null} judging a group's trigger source condition: the longest to know it (§3.3, §4.4) */
    this.judgeLatencyNs = null;
    /** @type {number[]} format 1: the raw channels' roles (as asked) */ this.rawRoles = [];
    /** @type {Map<number, number>} format 1: events role -> D (as asked) */ this.eventD = new Map();
  }

  /** The actual rate in Hz (a float; rateNum / rateDen exactly). */
  get rate() { return this.rateDen ? this.rateNum / this.rateDen : 0; }

  /** Length of one segment in the stream (§1.1 rule 4). */
  get bytes() { return segmentBytes(this, this.samples); }

  /** Streaming: how long the host may stop reading before the probe drops, in s (§3.3: stream_buffer over the data
   * rate; formats 1 / 2: pass their worst bandwidth, a lower bound). null when the probe does not say.
   * @param {number | null} [worstBytesPerS] */
  tolerableDelayS(worstBytesPerS = null) {
    if (this.streamBuffer === null) return null;
    const rate = worstBytesPerS ?? this.rate * (this.width ? this.width / 8 : (this.order.length * this.slot) / 8);
    return rate ? this.streamBuffer / rate : null;
  }
}

/** Bytes of `samples` samples in the packed layout (§1.1 rule 4, §1.2 rule 3).
 * @param {Config} c @param {number} samples */
export function segmentBytes(c, samples) {
  if (c.width) return Math.floor((samples * c.width + 7) / 8);
  return Math.floor((samples * c.order.length * c.slot) / 8);
}

/** configure's answer TLVs (§3.3). A tag that does not repeat is taken from its first copy only, and a value not of its
 * defined length (layout: its count and length) is broken and not used - nor replaced by a later copy (core §2.3).
 * scale, skew and frontend_used repeat, one per role.
 * @param {Uint8Array} payload @param {boolean} analog */
export function parseConfig(payload, analog) {
  const c = new Config();
  const once = new Set([ACTUAL_RATE, LAYOUT, ACTUAL_SAMPLES, ACTUAL_SEGMENTS, REFERENCE, ANSWER_FORMAT, ANSWER_BLOCK,
    STREAM_BUFFER, JUDGE_LATENCY]);
  const seen = new Set();
  for (const [tag, v] of tlvs(payload)) {
    if (once.has(tag)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
    }
    if (tag === ACTUAL_RATE && v.length === 8) {
      if (getU32(v, 4)) { c.rateNum = getU32(v); c.rateDen = getU32(v, 4); }
    } else if (tag === LAYOUT && !analog && v.length >= 2 && v.length === 2 + v[1]) {
      c.width = v[0];
      c.positions = Array.from(v.slice(2));
    } else if (tag === LAYOUT && analog && v.length >= 4 && v.length === 4 + v[3]) {
      c.slot = v[0]; c.offset = v[1]; c.bits = v[2];
      c.order = Array.from(v.slice(4));
    } else if (tag === ANSWER_FORMAT && v.length === 1) c.format = v[0];
    else if (tag === ANSWER_BLOCK && v.length === 4) c.block = getU32(v);
    else if (tag === STREAM_BUFFER && v.length === 4) c.streamBuffer = getU32(v);
    else if (tag === JUDGE_LATENCY && v.length === 4) c.judgeLatencyNs = getU32(v);
    else if (tag === ACTUAL_SAMPLES && v.length === 4) c.samples = getU32(v);
    else if (tag === ACTUAL_SEGMENTS && v.length === 4) c.segments = getU32(v);
    else if (tag === SCALE && analog && v.length === 9) {
      const rd = new m.Reader(v);
      const role = rd.u8();
      c.zero.set(role, rd.i32());                     // signed: an inverting frontend (§3.3)
      c.scaleNv.set(role, rd.i32());
    } else if (tag === SKEW && analog && v.length === 5) c.skewNs.set(v[0], getU32(v, 1));
    else if (tag === FRONTEND_USED && analog && v.length === 2) c.frontend.set(v[0], v[1]);
    else if (tag === REFERENCE && analog && v.length === 6) {
      const how = v[5];
      // how: nominal false, measured true; an unknown value is shown as it is, not as nominal (core §2.4)
      const measured = how === ANA.enum.reference_how.measured ? true : how === ANA.enum.reference_how.nominal ? false : String(how);
      c.reference = { source: REFERENCE_SOURCE[v[0]] ?? String(v[0]), mv: getU32(v, 1), measured };
    }
  }
  for (const k of c.order) if (!c.skewNs.has(k)) c.skewNs.set(k, 0);   // a role with no delay may be left out (§3.3)
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
    /** pushes of an earlier generation, dropped */ this.stale = 0;
    /** bytes at or past an error stop's write_pos, dropped */ this.droppedAfterError = 0;
    this.skipped = 0n;
    /** @type {number | null} */ this.expectSeq = null;
    /** @type {Set<number>} events share the fn's seq (they stay on the link for the caller) */ this.eventSeqs = new Set();
    /** @type {Map<bigint, SegmentInfo>} a segment's position -> what its frames said (the latest) */ this.segments = new Map();
    /** @type {number | null} performance.now() at the last keepalive: on from one stream() call to the next with the
     * same Received (a host calling in short slices still keeps the lease) */ this.kept = null;
  }

  get data() { return this.buf.subarray(0, this.length); }

  /** Drop every byte at stream position `position` or later (§2.2: after an error stop, status's write_pos).
   * @param {bigint} position */
  dropFrom(position) {
    if (this.start === null) return;
    let skipped = 0n, from = 0, keep = this.length;
    const gaps = [...this.gaps].sort((a, b) => a[0] - b[0]);
    for (const [index, n] of [...gaps, [this.length, 0]]) {
      if (position < this.start + BigInt(index) + skipped) {
        keep = Math.max(from, Number(position - this.start - skipped));
        break;
      }
      skipped += BigInt(n);
      from = index;
    }
    this.droppedAfterError += this.length - keep;
    this.length = keep;
    this.gaps = this.gaps.filter(([i]) => i < keep);
    this.skipped = this.gaps.reduce((t, [, n]) => t + BigInt(n), 0n);
  }

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

/** A streaming data frame's segment_info (§3.4): the segment's position, the samples taken when the frame was made (1 or
 * more; the final count once the segment ended), startNs and its uncertainty (as §2.2's segment).
 * @typedef {{ position: bigint, samples: number, startNs: bigint, startUncertaintyNs: number }} SegmentInfo */

/** A data frame decoded (core §10.2): generation from its TLV 0x01 and segment from its TLV 0x02, null when the frame
 * carries none (or another length).
 * @typedef {{ fn: number, seq: number, position: bigint, data: Uint8Array, generation: number | null,
 *   segment: SegmentInfo | null }} Push */

/** A data frame (core §10.2: role fn seq position(u64) len(u16) data [TLV]). @param {Uint8Array} f @returns {Push} */
export function unpackPush(f) {
  const rd = new m.Reader(f.slice(13));
  const data = rd.counted(2);
  const tail = rd.tail();
  const g = tail.get(DATA_GENERATION), info = tail.get(SEGMENT_INFO);
  return { fn: getU16(f, 1), seq: getU16(f, 3), position: getU64(f, 5), data, generation: g && g.length === 4 ? getU32(g) : null,
    segment: info && info.length === 24
      ? { position: getU64(info), samples: getU32(info, 8), startNs: getU64(info, 12), startUncertaintyNs: getU32(info, 20) } : null };
}

/** Remove this fn's data pushes (role 0x04) from the link, oldest first.
 * @param {{ pushes: Uint8Array[] }} link @param {number} fn */
export function takePushes(link, fn) {
  /** @type {Uint8Array[]} */ const mine = [];
  /** @type {Uint8Array[]} */ const rest = [];
  for (const f of link.pushes) (frameFn(f) === fn ? mine : rest).push(f);
  link.pushes.splice(0, link.pushes.length, ...rest);
  return mine.map(unpackPush);
}

/** (tail reached, complete) of a generation's stream up to writePos (§2.1 rule 2): `spans` are [generation, start, end]
 * byte ranges received by notification or read. Reaching writePos says only that the end came; the whole is had only
 * when the generation's spans cover 0 .. writePos with no hole - another generation's bytes fill none.
 * @param {[number, bigint, bigint][]} spans @param {number} generation @param {bigint} writePos @returns {[boolean, boolean]} */
export function coverage(spans, generation, writePos) {
  const mine = spans.filter(([g]) => g === generation).map(([, a, b]) => [a, b]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const reached = mine.some(([, b]) => b === writePos);
  let at = 0n;
  for (const [a, b] of mine) {
    if (a > at) break;
    if (b > at) at = b;
  }
  return [reached, at >= writePos];
}

/**
 * A capture event (oep-if-capture §3.4, §4.2; core §10.2 role 0x03): `kind fixed-part [TLV]`. generation: the start it
 * was made in - a track's for a track's event, the group's for the group's. segment: kind segment; reason / error:
 * stopped; serial, triggerIndex, record (null: no record, §3.10), sample (the original sample from the generation's
 * start), triggerNs and uncertaintyNs: a track's triggered; triggerFn (0: force, timer), record, triggerNs,
 * uncertaintyNs: a group's triggered (§4.4). A kind this client does not know comes back with only its payload
 * (generation null); a fixed part shorter than its kind's throws ProtocolError.
 * @typedef {{ fn: number, seq: number, kind: number, payload: Uint8Array, generation: number | null, segment?: Segment,
 *   reason?: number, error?: number, serial?: number, triggerIndex?: number | null, record?: number | null,
 *   sample?: bigint, triggerNs?: bigint, uncertaintyNs?: number, triggerFn?: number }} CaptureEvent
 */

/** @param {Uint8Array} frame  role(0x03) fn(u16) seq(u16) kind(u8) payload @returns {CaptureEvent} */
export function parseEvent(frame) {
  if (frame.length < 6 || frame[0] !== m.ROLE_EVENT) throw new ProtocolError(`not an event frame: ${Array.from(frame, (b) => b.toString(16).padStart(2, '0')).join('')}`);
  const rd = new m.Reader(frame);
  rd.u8();
  const fn = rd.u16(), seq = rd.u16(), kind = rd.u8();
  return { fn, seq, kind, payload: frame.slice(rd.at), generation: null };
}

/** @param {CaptureEvent} e @param {(rd: m.Reader) => void} read */
function fixed(e, read) {
  const rd = new m.Reader(e.payload);
  try {
    read(rd);
  } catch (err) {
    if (err instanceof m.ShortPayload) throw new ProtocolError(`capture event kind ${e.kind} too short`);
    throw err;
  }
  rd.tail();
  return e;
}

/** A track's event. @param {Uint8Array} frame */
export function parseCaptureEvent(frame) {
  const e = parseEvent(frame);
  if (e.kind === EVENT_SEGMENT) return fixed(e, (rd) => { e.segment = Segment.read(rd); e.generation = e.segment.generation; });
  if (e.kind === EVENT_STOPPED) return fixed(e, (rd) => { e.reason = rd.u8(); e.error = rd.u8(); e.generation = rd.u32(); });
  if (e.kind === EVENT_TRIGGERED) {
    return fixed(e, (rd) => {   // serial index record sample(u64) trigger_ns(u64) uncertainty generation (§3.4)
      e.serial = rd.u32();
      const i = rd.u32(), record = rd.u32();
      e.triggerIndex = i === NO_INDEX ? null : i;
      e.record = record === NO_RECORD ? null : record;
      e.sample = rd.u64(); e.triggerNs = rd.u64(); e.uncertaintyNs = rd.u32(); e.generation = rd.u32();
    });
  }
  return e;
}

/** A capture group's event (§4.2, §4.4). @param {Uint8Array} frame */
export function parseGroupEvent(frame) {
  const e = parseEvent(frame);
  if (e.kind === GROUP_EVENT_TRIGGERED) {
    return fixed(e, (rd) => {   // trigger_fn record trigger_ns uncertainty generation (the group's)
      e.triggerFn = rd.u16();
      const record = rd.u32();
      e.record = record === NO_RECORD ? null : record;
      e.triggerNs = rd.u64(); e.uncertaintyNs = rd.u32(); e.generation = rd.u32();
    });
  }
  if (e.kind === GROUP_EVENT_STOPPED) return fixed(e, (rd) => { e.reason = rd.u8(); e.error = rd.u8(); e.generation = rd.u32(); });
  return e;
}

/**
 * The next event of `iface`'s fn (of one of `kinds`) of its current generation; one of another generation is an
 * earlier start's (§3.4, §4.2): passed over and counted in iface.staleEvents. A host that did not start it asks status
 * first. null after timeoutMs.
 * @param {LogicCapture | CaptureGroup} iface @param {(f: Uint8Array) => CaptureEvent} parse
 * @param {number[] | null} kinds @param {number} timeoutMs
 */
async function currentEvent(iface, parse, kinds, timeoutMs) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const f = await iface.host.link.nextEvent((e) => frameFn(e) === iface.fn && (!kinds || kinds.includes(e[5])),
      Math.max(0, deadline - now()));
    if (!f) return null;
    const e = parse(f);
    if (e.generation !== null && iface.generation === null) await iface.status();
    if (e.generation === null || e.generation === iface.generation) return e;
    iface.staleEvents++;
  }
}

/**
 * status's answer (oep-if-capture §3.2). segmentsDone: segments finished; writePos: bytes taken so far (dropped ones
 * counted: the next byte's position); flags: bit0 dropped, bit1 slipped, bit2 rearm_waiting - since start; generation:
 * the current capture's; error: state 6's reason (ERRORS names it), else null; named: the named extensions (core §2.2):
 * a probe's own diagnostics (`CaptureDrops.of`).
 * @typedef {{ state: number, segmentsDone: number, writePos: bigint, flags: number, generation: number, error: number | null,
 *   dropped: boolean, errorName: string | null, named: Map<string, Uint8Array> }} CaptureStatus
 */

/** The Arduino reference firmware's own diagnostics in a capture's status (named extension CAPTURE_DROPS, not an OEP
 * definition): where data a stream dropped went, since start - bytes no free stage took, bytes the transport would not
 * queue, DMA chunks rewritten before they were copied, chunks the harvest queue had no room for - then the way the data
 * goes (zeroCopy: the zero-copy stages; else the store), the stages held, and the memory a capture draws on: internal
 * RAM's and DMA-capable internal RAM's largest free blocks, PSRAM's total (0: none); then the most the stream's buffer
 * held not yet sent since start (bytes; null from a firmware before it). */
export class CaptureDrops {
  static NAME = 'io.github.open-embedded-probe.capture-drops';

  /** @param {number[]} f  the u32 / u8 fields in order */
  constructor(f) {
    this.noStageBytes = f[0]; this.unqueuedBytes = f[1]; this.dmaOverruns = f[2]; this.queueOverflows = f[3];
    this.zeroCopy = !!f[4];
    this.stages = f[5]; this.internalLargest = f[6]; this.dmaLargest = f[7]; this.psramTotal = f[8];
    /** @type {number | null} */ this.bufferPeak = f.length > 9 ? f[9] : null;
  }

  /** -> its fields, or null for data of another length (a form this host does not know): 4 x u32, u8, u8, 3 x u32
   * [, u32 buffer_peak]. @param {Uint8Array} data */
  static unpack(data) {
    if (data.length !== 30 && data.length !== 34) return null;
    const f = [0, 4, 8, 12].map((at) => getU32(data, at));
    f.push(data[16], data[17], ...[18, 22, 26].map((at) => getU32(data, at)));
    if (data.length === 34) f.push(getU32(data, 30));
    return new CaptureDrops(f);
  }

  /** @param {CaptureStatus} status */
  static of(status) {
    const data = status.named.get(CaptureDrops.NAME);
    return data ? CaptureDrops.unpack(data) : null;
  }
}

/** configure's trigger_opts (§3.3): `arm` 1 looks once the pretrigger is there (0: at once, a short segment); `rearm` 1
 * a trigger for every segment (streaming: a record for every event, §2.1, §3.10); `when` 1 a level already true at
 * arming counts; `hysteresis` (analog cross, in ADC values) back that far before the next crossing. The defaults are
 * every probe's; the others as describe's trigger opts says.
 * @typedef {{ arm?: number, rearm?: number, when?: number, hysteresis?: number }} TriggerOpts */

/** A trigger record (§3.10): serial (from 0 in the generation), the original sample from the generation's start,
 * triggerNs and its uncertainty. @typedef {{ serial: number, sample: bigint, triggerNs: bigint, uncertaintyNs: number }} TriggerRecord */

/**
 * @typedef {object} ConfigureOptions
 * @property {number} rate                  Hz (analog: per channel)
 * @property {number} [mode]                ONE_SHOT (default), REPEAT, STREAMING
 * @property {number} [samples]
 * @property {number} [segments]
 * @property {[number, number, number]} [trigger]  (type, role, value)
 * @property {number} [pretrigger]
 * @property {boolean} [query]              ask only (query op, no lock, nothing changes)
 * @property {Map<number, number> | Record<number, number>} [frontends]  analog: role -> frontend (describe frontend)
 * @property {TriggerOpts} [triggerOpts]   sent critical (a probe without it refuses)
 * @property {number} [dataFormat]          DATA_FORMAT: 1 the logic blocks, 4 the test counter (critical)
 * @property {Map<number, number> | Record<number, number>} [events]  format 1: role -> D for the channels carried as
 *   events (the others raw)
 * @property {number[]} [roles]             format 1: the plan's roles (to name the raw channels)
 * @property {number} [blockMax]            format 1: the longest block (critical)
 */

/** Basic logic capture. Channels are the plan's roles 0..C-1. */
export class LogicCapture extends Interface {
  static NAME = 'oep.fixture.logic';
  static REVISION = 1;
  static CONFIGURE = CAP.op.configure; static START = CAP.op.start; static STOP = CAP.op.stop;
  static FORCE = CAP.op.force; static STATUS = CAP.op.status; static READ = CAP.op.read;
  static SEGMENTS = CAP.op.segments; static RELEASE = CAP.op.release; static QUERY_OP = CAP.op.query;
  static TRIGGERS = CAP.op.triggers;
  /** batches of reads sent again after the link's own repeat failed too */ static READ_TRIES = 4;
  /** frame-sized reads per pipeline; a keepalive between batches when a session is open */ static BATCH = 16;

  /** @param {import('./host.js').Host} hst @param {number} fn @param {string} name @param {Uint8Array} prefix */
  constructor(hst, fn, name, prefix = new Uint8Array()) {
    super(hst, fn, name, prefix);
    /** @type {Config | null} */ this.config = null;
    /** @type {number | null} performance.now() at the last start() */ this.armedMs = null;
    /** @type {number | null} the current capture's generation (start / status / the group's start) */ this.generation = null;
    /** events of an earlier generation nextEvent passed over */ this.staleEvents = 0;
  }

  /** @returns {boolean} */
  get analog() { return false; }

  /** The config set by the last configure (throws when there is none). */
  get cfg() {
    if (!this.config) throw new Error(`${this.name}: configure first`);
    return this.config;
  }

  /** -> the probe's actual values. A value the probe cannot honour is refused: Unsupported, .tag = the TLV as sent
   * (§3.3; with several refusals the probe answers any one - nothing here relies on the order). The table's TLVs go
   * without the critical bit; format, carriage, block_max and trigger_opts critical. Rate, samples and segments 1 or
   * more; a type 0 trigger goes as role 0 value 0; samples needed in one-shot and repeat and not taken in streaming;
   * segments repeat's only; a pretrigger needs a trigger (RangeError before sending otherwise). Read Config.samples /
   * .segments: the probe rounds samples down.
   * @param {ConfigureOptions} opts */
  async configure({ rate, mode = ONE_SHOT, samples, segments, trigger, pretrigger, query = false, frontends, triggerOpts,
    dataFormat = 0, events, roles, blockMax }) {
    // §3.3's contract, before anything is sent
    for (const [n, v] of /** @type {[string, number | undefined][]} */ ([['rate', rate], ['samples', samples], ['segments', segments]])) {
      if (v !== undefined && !(v >= 1)) throw new RangeError(`capture configure: ${n} ${v} - 1 or more (oep-if-capture §3.3)`);
    }
    if (trigger !== undefined && trigger[0] === IMMEDIATE) trigger = [IMMEDIATE, 0, 0];   // role and value not used (§3.3)
    if ((mode === ONE_SHOT || mode === REPEAT) && samples === undefined) {
      throw new RangeError('capture configure: samples is required in one-shot and repeat (oep-if-capture §3.3)');
    }
    if (mode === STREAMING && samples !== undefined) throw new RangeError('capture configure: streaming takes no samples (oep-if-capture §3.3)');
    if (segments !== undefined && mode !== REPEAT) throw new RangeError('capture configure: segments is for repeat only (oep-if-capture §3.3)');
    if (pretrigger !== undefined && (trigger === undefined || trigger[0] === IMMEDIATE)) {
      if (pretrigger) throw new RangeError('capture configure: a pretrigger needs a trigger (oep-if-capture §3.3)');
      pretrigger = undefined;                                       // 0 without a trigger: simply not sent
    }
    if (dataFormat === DATA_FORMAT.logic_blocks && roles === undefined) {
      throw new RangeError('capture configure: format 1 needs the plan\'s roles (to name the raw channels)');
    }
    /** @param {Map<number, number> | Record<number, number> | undefined} x @returns {[number, number][]} */
    const pairs = (x) => (x instanceof Map ? [...x] : Object.entries(x ?? {}).map(([k, v]) => /** @type {[number, number]} */ ([Number(k), v])))
      .sort((p, q) => p[0] - q[0]);
    const w = new Writer();
    /** @param {number} tag @param {Uint8Array} value @param {boolean} [critical] */
    const put = (tag, value, critical = false) => w.raw(m.tlv(tag, value, critical));
    put(MODE, Uint8Array.of(mode));
    put(RATE, new Writer().u32(rate).done());
    if (samples !== undefined) put(SAMPLES, new Writer().u32(samples).done());
    if (segments !== undefined) put(SEGMENTS, new Writer().u32(segments).done());
    if (trigger !== undefined) put(TRIGGER, new Writer().u8(trigger[0]).u8(trigger[1]).u32(trigger[2]).done());   // type, role, value (u32)
    if (pretrigger !== undefined) put(PRETRIGGER, new Writer().u32(pretrigger).done());
    for (const [role, f] of pairs(frontends)) put(FRONTEND, Uint8Array.of(role, f));   // analog: the input range
    if (dataFormat) put(FORMAT, Uint8Array.of(dataFormat), true);   // critical: a probe without it refuses (§3.3)
    const eventD = pairs(events);
    for (const [role, d] of eventD) put(CARRIAGE, new Writer().u8(role).u8(LOGIC_CARRIAGE.events).u32(d).done(), true);
    if (blockMax !== undefined) put(BLOCK_MAX, new Writer().u32(blockMax).done(), true);
    if (triggerOpts !== undefined) {
      const { arm = 1, rearm = 0, when = 0, hysteresis = 0 } = triggerOpts;
      put(TRIGGER_OPTS, new Writer().u8(arm).u8(rearm).u8(when).u32(hysteresis).done(), true);
    }
    // query is its own operation: the lock is decided per operation, before the payload is looked at
    const op = query ? LogicCapture.QUERY_OP : LogicCapture.CONFIGURE;
    const c = parseConfig((await this.call(op, w.done(), { locked: !query })).payload, this.analog);
    c.pretrigger = pretrigger ?? 0;
    if (dataFormat === DATA_FORMAT.logic_blocks) {
      c.eventD = new Map(eventD);
      c.rawRoles = [.../** @type {number[]} */ (roles)].sort((x, y) => x - y).filter((r) => !c.eventD.has(r));
    }
    if (mode === ONE_SHOT && !c.segments) c.segments = 1;          // one-shot's answer has no actual_segments (§3.3)
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

  /** The next event of this fn (of one of `kinds`, if given) of the current generation, decoded - one of an earlier
   * start is passed over (staleEvents, §3.4); null after timeoutMs.
   * @param {number[] | null} kinds @param {number} timeoutMs */
  nextEvent(kinds = null, timeoutMs = 1000) { return currentEvent(this, parseCaptureEvent, kinds, timeoutMs); }

  /**
   * Streaming: collect data pushes until `nbytes` have arrived or `ms` have passed (at least one is needed). A
   * position that does not follow the previous push is a probe-side drop (a gap); a seq that skips is a lost frame. A
   * push of another generation than this capture's (a leftover of the start before, oep-if-capture §3.4) is dropped
   * (Received.stale); each push's segment_info goes to Received.segments. The subscription ends with the lock, so the
   * lock is kept alive every `keepaliveMs` while collecting - counted across calls with the same `into` (a host calling
   * in short slices otherwise lost its lease: each call began the count again).
   * @param {{ ms?: number, nbytes?: number, into?: Received, keepaliveMs?: number }} opts
   */
  async stream({ ms, nbytes, into, keepaliveMs = 1000 } = {}) {
    if (ms === undefined && nbytes === undefined) throw new RangeError('stream() needs ms or nbytes');
    const link = this.host.link;
    const got = into ?? new Received();
    const deadline = ms !== undefined ? now() + ms : null;
    let kept = got.kept ?? now();
    /** @type {Push[]} */
    let first = [];
    for (;;) {
      for (const e of link.events) if (frameFn(e) === this.fn) got.eventSeqs.add(getU16(e, 3));
      for (const { seq, position, data, generation, segment } of [...first, ...takePushes(link, this.fn)]) {
        while (got.expectSeq !== null && got.expectSeq !== seq) {
          if (got.eventSeqs.has(got.expectSeq)) got.eventSeqs.delete(got.expectSeq);
          else got.seqLost++;
          got.expectSeq = (got.expectSeq + 1) & 0xffff;
        }
        got.expectSeq = (seq + 1) & 0xffff;
        if (generation !== null && this.generation !== null && generation !== this.generation) {
          got.stale++;                                                  // the generation before: not this capture's bytes
          continue;
        }
        if (segment !== null) got.segments.set(segment.position, segment);   // the latest: samples grow while it is taken
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
      got.kept = kept;
      if (nbytes !== undefined && got.length >= nbytes) return got;
      if (deadline !== null && now() >= deadline) return got;
      const wait = Math.max(0, Math.min(20, deadline !== null ? deadline - now() : 20));
      const f = await link.nextPush((p) => frameFn(p) === this.fn, wait);
      if (f) first = [unpackPush(f)];
    }
  }

  /** Streaming, after stop() or an error stop: collect the pushes still to come, up to the last byte captured
   * (status's write position), or until `timeoutMs`. In state 6 the bytes at or past write_pos are dropped (§2.2).
   * @param {Received} got @param {number} timeoutMs */
  async finish(got, timeoutMs = 5000) {
    const st = await this.status();
    const end = st.writePos;
    if (st.state === STATE.error) {
      await this.stream({ ms: Math.min(100, timeoutMs), into: got });
      got.dropFrom(end);                                            // §2.2: nothing at or past write_pos is data
      return got;
    }
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (got.reached === end) return got;
      await this.stream({ ms: Math.min(100, Math.max(0, deadline - now())), into: got });
    }
    return got;
  }

  /** -> the new capture's generation (also this.generation). A start whose initialisation failed is completed failed
   * with the same fixed part (§3.2): Failed, the state 6 and error read by status() - the generation that fixed part
   * names is taken all the same (read / release name it, §0). */
  async start() {
    let r;
    try {
      r = await this.call(LogicCapture.START);
    } catch (e) {
      const res = /** @type {any} */ (e).result;
      if (e instanceof Failed && res && res.payload.length >= 4) {
        this.generation = getU32(res.payload);
        this.armedMs = now();
      }
      throw e;
    }
    const rd = new m.Reader(r.payload);
    this.generation = rd.u32();
    rd.tail();
    this.armedMs = now();
    return this.generation;
  }

  async stop() { await this.call(LogicCapture.STOP); }

  /** Waiting for the trigger: start now (the segment's triggerIndex marks where). */
  async force() { await this.call(LogicCapture.FORCE); }

  /** Lock-free; it also brings the generation a host that did not start the capture needs for read.
   * @returns {Promise<CaptureStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(LogicCapture.STATUS, new Uint8Array(), { locked: false })).payload);
    const state = rd.u8(), segmentsDone = rd.u32(), writePos = rd.u64(), flags = rd.u8(), generation = rd.u32();
    const tail = rd.tail();
    const err = tail.get(STATUS_ERROR);                             // u8: another length is broken, not used (core §2.3)
    const error = err && err.length === 1 ? err[0] : null;
    this.generation = generation;
    return { state, segmentsDone, writePos, flags, generation, error, dropped: !!(flags & STATUS_FLAG.dropped),
      errorName: error === null ? null : (ERRORS[error] ?? `error 0x${error.toString(16)}`), named: tail.named() };
  }

  /** The generation to name in a request: the one given, else this capture's (a host that did not start it asks status).
   * @param {number | null | undefined} generation */
  async generationOf(generation) {
    if (generation != null) return generation;
    if (this.generation === null) await this.status();
    return /** @type {number} */ (this.generation);
  }

  /** Repeat: segments up to and including `serial` may be reused (of this generation; another one is rejected
   * Unavailable cause 6). In state 5 (no free segment) the probe goes on by itself once there is room.
   * @param {number} serial @param {number | null} [generation] */
  async release(serial, generation = null) {
    await this.call(LogicCapture.RELEASE, new Writer().u32(await this.generationOf(generation)).u32(serial).done());
  }

  /** One answer's segment records from `fromSerial` on (common §1.3: fromSerial included; from serial_done none and
   * more false; a serial no longer kept starts at the oldest kept). @param {number} fromSerial
   * @returns {Promise<{ segments: Segment[], more: boolean }>} */
  async segmentsPage(fromSerial = 0) {
    const rd = new m.Reader((await this.call(LogicCapture.SEGMENTS, new Writer().u32(fromSerial).done(), { locked: false })).payload);
    const more = rd.u8(), n = rd.u8();
    const segments = [];
    for (let i = 0; i < n; i++) segments.push(Segment.read(rd));   // count x segment, no element length (core §2.3)
    rd.tail();
    return { segments, more: !!more };
  }

  /** Every segment record from `fromSerial` on, following `more`: each next page from the last serial + 1 (mod 2^32)
   * until more is false. @param {number} fromSerial */
  async segments(fromSerial = 0) {
    /** @type {Segment[]} */
    const out = [];
    for (;;) {
      const { segments, more } = await this.segmentsPage(fromSerial);
      out.push(...segments);
      if (!more || !segments.length) return out;
      fromSerial = (segments[segments.length - 1].serial + 1) >>> 0;
    }
  }

  /** One answer's trigger records (§3.10) from `fromSerial` on, paged as segments are.
   * @param {number} fromSerial @param {number | null} [generation] @returns {Promise<{ records: TriggerRecord[], more: boolean }>} */
  async triggersPage(fromSerial = 0, generation = null) {
    const body = new Writer().u32(await this.generationOf(generation)).u32(fromSerial).done();
    const rd = new m.Reader((await this.call(LogicCapture.TRIGGERS, body, { locked: false })).payload);
    const more = rd.u8(), n = rd.u8();
    /** @type {TriggerRecord[]} */
    const records = [];
    for (let i = 0; i < n; i++) records.push({ serial: rd.u32(), sample: rd.u64(), triggerNs: rd.u64(), uncertaintyNs: rd.u32() });
    rd.tail();
    return { records, more: !!more };
  }

  /** Every trigger record kept from `fromSerial` on; a jump in the serials is what was overwritten.
   * @param {number} fromSerial @param {number | null} [generation] */
  async triggers(fromSerial = 0, generation = null) {
    /** @type {TriggerRecord[]} */
    const out = [];
    for (;;) {
      const { records, more } = await this.triggersPage(fromSerial, generation);
      out.push(...records);
      if (!more || !records.length) return out;
      fromSerial = (records[records.length - 1].serial + 1) >>> 0;
    }
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
      const st = await this.status();
      const { state } = st;
      if (state === STATE.done) return this.segments();
      if (state === STATE.error) throw new Failed(null, `the capture stopped with an error (${st.errorName ?? 'unknown'})`);
      if (!known.has(state)) throw new ProtocolError(`capture state ${state} is not one this client knows`);
      await sleep(2);
    }
    throw new Timeout('capture did not finish');
  }

  /** the answer's position(u64) flags(u8) len(u16) in front of the data */
  static READ_HEAD = 11;

  /** read's answer (position flags len(u16) data [TLV], §3.2) -> the data, which must start at `asked`: an answer moved
   * on from there (gap: the bytes were re-used or pushed on) holds other bytes - ReadGap.
   * @param {Uint8Array} payload @param {bigint} asked */
  static readData(payload, asked) {
    const rd = new m.Reader(payload);
    const position = rd.u64(), flags = rd.u8();
    const data = rd.counted(2);
    if (flags & READ_GAP) throw new ReadGap(asked, position);
    // at or past write_pos: write_pos, len 0 (no data yet)
    if (position !== asked && data.length) throw new ProtocolError(`capture read at ${asked} answered position ${position} without gap`);
    return data;
  }

  /**
   * Bytes [position, position+length) of the stream, pipelined in frame-sized reads. `generation`: the capture they
   * belong to (default: the one this client saw at start / status); the probe refuses another one as Unavailable
   * (cause 6), so an old read never gets the next capture's bytes. The reads need no lock and go without the session
   * id, so a batch whose answers did not come is simply sent again (reads are not deduplicated, oep-core §5.2). They
   * do not extend the lease: a long read sends a keepalive between batches.
   * @param {bigint | number} position @param {number} length @param {number | null} [generation]
   */
  async read(position, length, generation = null) {
    const pos = BigInt(position);
    const g = await this.generationOf(generation);
    const chunk = Math.min(0xffff, Math.max(1, (await this.host.confirmed()).maxFrame - m.RESULT_HEADER - LogicCapture.READ_HEAD));
    const offsets = [];
    for (let off = 0; off < length; off += chunk) offsets.push(off);
    const out = new Uint8Array(length);
    const B = LogicCapture.BATCH;
    /** @param {bigint} at @param {number} n */
    const body = (at, n) => new Writer().u32(g).u64(at).u16(n).done();
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
        let data = LogicCapture.readData(replies[i].payload, pos + BigInt(off));
        let have = Math.min(data.length, want);
        out.set(data.subarray(0, have), off);
        while (have < want) {                                  // a short answer: read on from where it stopped
          const from = pos + BigInt(off + have);
          data = LogicCapture.readData((await this.call(LogicCapture.READ, body(from, want - have), { locked: false })).payload, from);
          if (!data.length) throw new ProtocolError(`read at ${from} returned nothing`);
          const n = Math.min(data.length, want - have);
          out.set(data.subarray(0, n), off + have);
          have += n;
        }
      }
    }
    return out;
  }

  /** The segment's bytes (of its generation); every onCapture(host) callback gets them as a CaptureRecord.
   * @param {Segment} segment */
  async readSegment(segment) {
    const c = this.cfg;
    const data = c.format === DATA_FORMAT.logic_blocks ? await this.readBlocks(segment)
      : await this.read(segment.position, segmentBytes(c, segment.samples), segment.generation || null);
    const list = recorders.get(this.host);
    if (list && list.length) {
      /** @type {CaptureRecord} */
      const record = { fn: this.fn, name: this.name, config: c, segment, data, armedMs: this.armedMs, readMs: now() };
      for (const cb of [...list]) cb(record);
    }
    return data;
  }

  /** A format 1 segment's bytes: its length is not in its record (§1.3), so it ends where the next segment begins, or
   * at write_pos for the last; read at once, then cut by its blocks' headers. @param {Segment} segment */
  async readBlocks(segment) {
    const after = (await this.segments((segment.serial + 1) >>> 0))
      .filter((x) => x.generation === segment.generation && x.position > segment.position).map((x) => x.position);
    const end = after.length ? after[0] : (await this.status()).writePos;
    const data = await this.read(segment.position, Number(end - segment.position), segment.generation || null);
    return data.slice(0, this.blocksLength(data, segment.samples));
  }

  /** The bytes the blocks of `samples` samples take at the start of `data` (from their headers, §1.3).
   * @param {Uint8Array} data @param {number} samples */
  blocksLength(data, samples) {
    const c = this.cfg;
    const nb = (c.eventD.size + 7) >> 3;
    let at = 0;
    for (let first = 0; first < samples; first += c.block) {
      const r = Math.min(c.block, samples - first);
      if (at + 2 * nb + 4 > data.length) throw new ProtocolError(`format 1: the segment's bytes end inside block ${Math.floor(first / c.block)}`);
      let fallbacks = 0;
      for (let i = 0; i < nb; i++) for (let v = data[at + i]; v; v &= v - 1) fallbacks++;
      const n = getU32(data, at + 2 * nb);
      at += 2 * nb + 4 + Math.floor((r * (c.rawRoles.length + fallbacks) + 7) / 8) + blocks.EVENT_BYTES * n;
    }
    if (at > data.length) throw new ProtocolError("format 1: the segment's bytes end inside its last block");
    return at;
  }

  /** A format 1 segment's bytes -> its blocks (raw channels as bits, events channels as ticks, §1.3).
   * @param {Uint8Array} data @param {number} samples */
  blocks(data, samples) {
    const c = this.cfg;
    return blocks.readLogicBlocks(data, samples, c.rawRoles, c.eventD, c.block);
  }

  /** A format 1 segment's bytes -> role -> its raw bits or its EventColumn over the whole segment, without blocks.
   * @param {Uint8Array} data @param {number} samples */
  columns(data, samples) {
    const c = this.cfg;
    return blocks.segmentColumns(data, samples, c.rawRoles, c.eventD, c.block);
  }

  // ---- the §1.1 layout ------------------------------------------------------------------------------------

  /** Channel k's values, one per sample (§1.1 rules 1-3: bit i·w + pos[k] of the stream, bit j being bit j mod 8 of
   * byte j / 8 - any w 1-128; a sample may cross a byte boundary).
   * @param {Uint8Array} data @param {number} k @param {number} [samples] */
  channel(data, k, samples) {
    const c = this.cfg;
    if (c.format === DATA_FORMAT.logic_blocks) throw new RangeError('a format 1 segment is blocks (§1.3): use blocks() / columns()');
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
 * after the last start, with nominalMv its nominal voltage (what the supply is worked back from).
 * @typedef {{ factory: { frontend: number | null, scheme: string, raw: Uint8Array }[],
 *   vrefint: { raw: number, ns: bigint, nominalMv: number } | null }} Calibration
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

  static CLIP_LOW = -1;
  static CLIP_HIGH = 1;

  /** The probe's own 1st-order reading of a raw value of channel k, (value - zero) x scale_nv (a nominal reference:
   * see reference and calibration() for others). null for a clipped value (§1.2 rule 6: 0 or 2^b - 1, the input's
   * voltage is not known): see clipped() and endsMillivolts().
   * @param {number} k @param {number} value @returns {number | null} */
  millivolts(k, value) {
    return this.clipped(k, value) ? null : this.#linearMv(k, value);
  }

  /** @param {number} k @param {number} value */
  #linearMv(k, value) {
    const c = this.cfg;
    return ((value - (c.zero.get(k) ?? 0)) * (c.scaleNv.get(k) ?? 0)) / 1_000_000;
  }

  /** §1.2 rule 6: 0 when the value is a voltage; CLIP_LOW (-1) when it is the converter's code that means the input was
   * at or below the low end of the frontend's range, CLIP_HIGH (+1) at or above the high end. Codes 0 and 2^b - 1 are
   * the ends; with a negative scale_nv (an inverting frontend) code 0 is the high end.
   * @param {number} k @param {number} value @returns {-1 | 0 | 1} */
  clipped(k, value) {
    let end;
    if (value === 0) end = AnalogCapture.CLIP_LOW;
    else if (value === 2 ** this.cfg.bits - 1) end = AnalogCapture.CLIP_HIGH;
    else return 0;
    return /** @type {-1 | 1} */ ((this.cfg.scaleNv.get(k) ?? 0) < 0 ? -end : end);
  }

  /** [low end, high end] of channel k in mV: rule 4 applied to codes 0 and 2^b - 1, what a clipped value is shown
   * against ("<= low", ">= high"). @param {number} k @returns {[number, number]} */
  endsMillivolts(k) {
    const a = this.#linearMv(k, 0), b = this.#linearMv(k, 2 ** this.cfg.bits - 1);
    return [Math.min(a, b), Math.max(a, b)];
  }

  /** clipped() of each value: 0, CLIP_LOW or CLIP_HIGH. The values themselves stay raw.
   * @param {number} k @param {ArrayLike<number>} values @returns {(-1 | 0 | 1)[]} */
  clipMask(k, values) {
    return Array.from(values, (v) => this.clipped(k, v));
  }

  /** How many values are clipped at each end. @param {number} k @param {ArrayLike<number>} values
   * @returns {{ low: number, high: number }} */
  clipCounts(k, values) {
    const out = { low: 0, high: 0 };
    for (const e of this.clipMask(k, values)) {
      if (e === AnalogCapture.CLIP_LOW) out.low++;
      else if (e === AnalogCapture.CLIP_HIGH) out.high++;
    }
    return out;
  }

  /** @returns {Promise<Calibration>} */
  async calibration() {
    /** @type {Calibration} */
    const out = { factory: [], vrefint: null };
    let seenVrefint = false;
    // a value not of its defined length (factory: its counts and lengths) is broken and not used; vrefint does not
    // repeat: its first copy only, a broken first not replaced by a later one (core §2.3)
    for (const [tag, v] of tlvs((await this.call(AnalogCapture.CALIBRATION, new Uint8Array(), { locked: false })).payload)) {
      if (tag === FACTORY) {                                   // frontend scheme_len scheme raw_len(u16) raw
        if (v.length < 2 || v.length < 4 + v[1] || v.length !== 4 + v[1] + getU16(v, 2 + v[1])) continue;
        const rd = new m.Reader(v);
        const fe = rd.u8();
        const scheme = text(rd.counted(1));
        out.factory.push({ frontend: fe === 0xff ? null : fe, scheme, raw: rd.counted(2) });
      } else if (tag === VREFINT && !seenVrefint) {            // raw(u32) ns(u64) nominal_mv(u32)
        seenVrefint = true;
        if (v.length === 16) out.vrefint = { raw: getU32(v), ns: getU64(v, 4), nominalMv: getU32(v, 12) };
      }
    }
    return out;
  }
}

/** generation: the group's (§4.1; 0 before its first start); trigger (§4.4), once the event happened: the fn that
 * judged it (0: force, timer), its ns and +-ns.
 * @typedef {{ state: number, startNs: bigint | null, generation: number,
 *   trigger: { fn: number, ns: bigint, uncertaintyNs: number } | null }} GroupStatus */

const GROUP_BIND = GRP.tlv.bind;
/** the trigger source's condition types (§4.4) */
export const COND = GRP.enum.trigger_cond;
export const COND_SRC = GRP.enum.cond_src;

/** A condition of the trigger source (§4.4): built with level() / edge() / crossUp() / crossDown() / above() / below() /
 * timer(). `fn` the bound track (0 for timer), `role` its plan role, `kind` enum trigger_cond, `args` the type's
 * arguments packed. */
export class Cond {
  /** @param {number} fn @param {number} role @param {number} kind @param {Uint8Array} args @param {number} [src] */
  constructor(fn, role, kind, args, src = COND_SRC.track) {
    this.fn = fn; this.role = role; this.kind = kind; this.args = args; this.src = src;
    Object.freeze(this);
  }

  /** @param {LogicCapture} track @param {number} role @param {number} level @param {number} [when] */
  static level(track, role, level, when = 0) { return new Cond(track.fn, role, COND.level, Uint8Array.of(level, when)); }
  /** edge 0 rising, 1 falling, 2 both. @param {LogicCapture} track @param {number} role @param {number} [edge] */
  static edge(track, role, edge = 0) { return new Cond(track.fn, role, COND.edge, Uint8Array.of(edge)); }
  /** @param {LogicCapture} track @param {number} role @param {number} value @param {number} [hysteresis] */
  static crossUp(track, role, value, hysteresis = 0) { return new Cond(track.fn, role, COND.cross_up, new Writer().u32(value).u32(hysteresis).done()); }
  /** @param {LogicCapture} track @param {number} role @param {number} value @param {number} [hysteresis] */
  static crossDown(track, role, value, hysteresis = 0) { return new Cond(track.fn, role, COND.cross_down, new Writer().u32(value).u32(hysteresis).done()); }
  /** @param {LogicCapture} track @param {number} role @param {number} value @param {number} [hysteresis] @param {number} [when] */
  static above(track, role, value, hysteresis = 0, when = 0) { return new Cond(track.fn, role, COND.above, new Writer().u32(value).u32(hysteresis).u8(when).done()); }
  /** @param {LogicCapture} track @param {number} role @param {number} value @param {number} [hysteresis] @param {number} [when] */
  static below(track, role, value, hysteresis = 0, when = 0) { return new Cond(track.fn, role, COND.below, new Writer().u32(value).u32(hysteresis).u8(when).done()); }
  /** ns after the stage was entered. @param {bigint | number} ns */
  static timer(ns) { return new Cond(0, 0, COND.timer, new Writer().u64(ns).done()); }
}

/** A stage (§4.4): its terms are OR'd, a term's conditions AND'd; `count` times the OR becomes true; `withinNs` from
 * entering it (0 none); `onTimeout` 0 back to stage 0 when it passes, 1 the "should come" stage (its OR in time goes
 * back to stage 0, the time passing makes it hold). `aborts`: terms that send it back to stage 0.
 * @typedef {{ terms: Cond[][], count?: number, withinNs?: bigint | number, onTimeout?: number, aborts?: Cond[][] }} Stage */

/** The group's trigger source (§4.4): stages in order, the last one holding is the event. */
export class TriggerSource {
  /** @param {Stage[]} stages @param {{ holdoffNs?: bigint | number, arm?: number, rearm?: number }} [opts] */
  constructor(stages, { holdoffNs = 0, arm = 1, rearm = 0 } = {}) {
    this.stages = stages; this.holdoffNs = holdoffNs; this.arm = arm; this.rearm = rearm;
  }

  /** The bind TLVs, every one critical (§4.4). */
  tlvs() {
    const w = new Writer().raw(m.tlv(GROUP_BIND.trigger_source,
      new Writer().u8(this.stages.length).u64(this.holdoffNs).u8(this.arm).u8(this.rearm).done(), true));
    this.stages.forEach((st, k) => {
      w.raw(m.tlv(GROUP_BIND.stage, new Writer().u8(k).u32(st.count ?? 1).u64(st.withinNs ?? 0).u8(st.onTimeout ?? 0).done(), true));
      for (const [part, terms] of /** @type {[number, Cond[][]][]} */ ([[0, st.terms], [1, st.aborts ?? []]])) {
        terms.forEach((conds, term) => {
          for (const c of conds) {
            w.raw(m.tlv(GROUP_BIND.cond, new Writer().u8(k).u8(part).u8(term).u8(c.src).u16(c.fn).u8(c.role).u8(c.kind).raw(c.args).done(), true));
          }
        });
      }
    });
    return w.done();
  }
}

/** capture-group describe's trigger_caps (§4.4): what its trigger source takes - a declaration (core §7.3), bind's
 * answer is the probe's word. `types`: the condition types (enum trigger_cond, bit k = type k); `protocols`: serial's
 * (bit k = protocol k); triggerOutLatencyNs null: no trigger_out. */
export class TriggerCaps {
  /** @param {number[]} f  max_stages max_terms max_conds cross_track types protocols trigger_out_latency_ns */
  constructor(f) {
    this.maxStages = f[0]; this.maxTerms = f[1]; this.maxConds = f[2];
    this.crossTrack = !!f[3];
    this.types = f[4]; this.protocols = f[5];
    /** @type {number | null} */ this.triggerOutLatencyNs = f[6] === 0xffffffff ? null : f[6];
    Object.freeze(this);
  }

  /** -> its fields, or null for a value of another length (a form this host does not know). @param {Uint8Array} v */
  static unpack(v) {
    if (v.length !== 13) return null;
    return new TriggerCaps([v[0], v[1], v[2], v[3], getU32(v, 4), v[8], getU32(v, 9)]);
  }

  /** Whether the condition type `kind` (COND) is declared. @param {number} kind */
  takes(kind) { return kind >= 0 && kind < 32 && ((this.types >>> kind) & 1) === 1; }

  /** The declared condition types by name (COND), in number order. */
  kinds() { return Object.entries(COND).sort((a, b) => a[1] - b[1]).filter(([, k]) => this.takes(k)).map(([n]) => n); }
}

/**
 * oep.fixture.capture-group (§4): tracks (LogicCapture / AnalogCapture, each configured as usual with an immediate
 * trigger, all in one mode) started at once by one request. Each track is read as usual; a track's offset is its first
 * segment's startNs minus the group's startNs (no exact match is promised: each segment's startNs and uncertainty place
 * it). With a trigger source (§4.4, describe features bit 0) every track has the linked trigger and the group's event
 * starts them.
 */
export class CaptureGroup extends Interface {
  static NAME = 'oep.fixture.capture-group';
  static REVISION = 1;
  static BIND = GRP.op.bind; static START = GRP.op.start; static STOP = GRP.op.stop;
  static FORCE = GRP.op.force; static STATUS = GRP.op.status;
  static TRIGGER_CAPS = GRP.tlv.describe.trigger_caps;
  static TAG_STATUS_TRIGGER = GRP.tlv.status_answer.trigger;
  static EVENT_TRIGGERED = GROUP_EVENT_TRIGGERED; static EVENT_STOPPED = GROUP_EVENT_STOPPED;
  static NO_TIME = NO_TIME;

  /** @type {Map<number, number>} fn -> the generation the last start gave each track */
  generations = new Map();
  /** @type {number | null} the group's current generation (start / status, §4.1) */
  generation = null;
  /** the group's events of an earlier generation nextEvent passed over */
  staleEvents = 0;

  /** Bind these configured tracks; [] unbinds. Without `source` they start at once (immediate triggers): a track with a
   * trigger of its own is refused here before sending (RangeError, §4.1). With `source` (§4.4) every track has the
   * linked trigger (with its own pretrigger) and the group's event starts them. The probe refuses a track not in state
   * 1/4/6 or modes apart (Unavailable cause 6, `.fn`), one in another group (cause 4) and more than it takes together
   * (cause 2). @param {LogicCapture[]} tracks @param {TriggerSource | null} [source] */
  async bind(tracks, source = null) {
    for (const t of tracks) {
      if (source === null && t.config && t.config.pretrigger) {
        throw new RangeError(`capture-group bind: fn ${t.fn} has a trigger of its own - a group starts its tracks at once (oep-if-capture §4.1)`);
      }
    }
    const w = new Writer().u8(tracks.length);
    for (const t of tracks) w.u16(t.fn);
    if (source) w.raw(source.tlvs());
    await this.call(CaptureGroup.BIND, w.done());
  }

  /** §4.4: waiting for the event, it happens now (nothing otherwise). */
  async force() { await this.call(CaptureGroup.FORCE); }

  /** describe's trigger_caps (§4.4): what the group's trigger source takes; null when the probe declares none (no
   * trigger source, or a form this host does not know). A declaration: bind still has the last word (§4.3). */
  async triggerCaps() {
    const v = (await describe(this.host, this.fn)).find(([t]) => t === CaptureGroup.TRIGGER_CAPS)?.[1];
    return v ? TriggerCaps.unpack(v) : null;
  }

  /** -> the group's startNs. The answer's fixed part: start_ns generation (the group's) n, then n x (fn, generation) -
   * each bound track's new generation, in bind order (§4.1). this.generation: the group's; this.generations: the
   * tracks' by fn. `tracks`: whose armedMs and generation to set. A start that failed to begin is completed failed with
   * the same fixed form (§4.1): Failed, the generations it names taken first (a stopped track's short segments are read
   * with its new one). @param {LogicCapture[]} tracks */
  async start(tracks = []) {
    let r;
    try {
      r = await this.call(CaptureGroup.START);
    } catch (e) {
      const res = /** @type {any} */ (e).result;
      if (e instanceof Failed && res && res.payload.length >= 13) this.started(res.payload, tracks);
      throw e;
    }
    return this.started(r.payload, tracks);
  }

  /** @param {Uint8Array} payload @param {LogicCapture[]} tracks */
  started(payload, tracks) {
    const rd = new m.Reader(payload);
    const startNs = rd.u64();
    this.generation = rd.u32();
    const n = rd.u8();
    this.generations = new Map();
    for (let i = 0; i < n; i++) { const fn = rd.u16(); this.generations.set(fn, rd.u32()); }
    rd.tail();
    const t = now();
    for (const tr of tracks) {
      tr.armedMs = t;
      const g = this.generations.get(tr.fn);
      if (g !== undefined) tr.generation = g;
    }
    return startNs;
  }

  async stop() { await this.call(CaptureGroup.STOP); }

  /** @returns {Promise<GroupStatus>} */
  async status() {
    const rd = new m.Reader((await this.call(CaptureGroup.STATUS, new Uint8Array(), { locked: false })).payload);
    const state = rd.u8(), start = rd.u64(), generation = rd.u32();
    const trig = rd.tail().get(CaptureGroup.TAG_STATUS_TRIGGER);   // fn(u16) ns(u64) uncertainty(u32)
    this.generation = generation;
    return { state, startNs: start === NO_TIME ? null : start, generation,
      trigger: trig && trig.length === 14 ? { fn: getU16(trig), ns: getU64(trig, 2), uncertaintyNs: getU32(trig, 10) } : null };
  }

  /** The group's next event (of one of `kinds`, if given) of its current generation, decoded - one of an earlier start
   * is passed over (staleEvents, §4.2); null after timeoutMs. The tracks' events stay for each track's nextEvent.
   * @param {number[] | null} kinds @param {number} timeoutMs */
  nextEvent(kinds = null, timeoutMs = 1000) { return currentEvent(this, parseGroupEvent, kinds, timeoutMs); }

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
