// @ts-check
// v1 messages (oep-core §2-§5) and the rules for what follows a payload's fixed part.
//
//   request : role(0x01) corr(u16) fn(u16) op(u8) session_id(u32) payload     10 bytes; session_id 0 = no session
//   result  : role(0x02) corr(u16) resolution(u8) detail(u8) payload
//
// Every fixed form (a fixed part, a TLV's value, a sequence's element, a probe.config item) is fixed by (name, revision)
// and never extended at its end; a sequence is count x element with no element length (core §2.3). After a result's
// fixed part (and any counted list or length-prefixed data) come TLVs (tag u8, len u16, value - core §2.2, one form
// whatever the length); a host skips tags it does not know. A request may end with TLVs; tag bit 7 = critical.

import * as reg from './registry.js';
import { getI32, getU16, getU32, getU64, text, utf8 } from './bytes.js';

export const ROLE_REQUEST = reg.ROLES.request, ROLE_RESULT = reg.ROLES.result;
export const ROLE_EVENT = reg.ROLES.event, ROLE_DATA = reg.ROLES.data;
export const REQUEST_HEADER = 10, RESULT_HEADER = 5;      // core §4.1 / §4.2
/** A request's session_id when it belongs to no session (core §4.1). */
export const NO_SESSION_ID = 0;
/** tag(u8) len(u16) (core §2.2). */
export const TLV_HEADER = 3;

export const REJECTED = reg.RESOLUTIONS.rejected, COMPLETED = reg.RESOLUTIONS.completed, ACCEPTED = reg.RESOLUTIONS.accepted;
export const SUCCESS = reg.OUTCOMES.success, FAILED = reg.OUTCOMES.failed, PARTIAL = reg.OUTCOMES.partial;

export const REJECT = reg.REJECT_REASONS;
/** @type {Record<number, string>} */
export const REJECT_NAMES = Object.fromEntries(Object.entries(REJECT).map(([k, v]) => [v, k.replace(/_/g, ' ')]));

export const TAG_CRITICAL = reg.TAG_CRITICAL, TAG_IGNORED = reg.TAG_IGNORED, TAG_INVALID = reg.TAG_INVALID;
/** The rejected unsupported payload's first byte for a fixed-part value (core §4.3); never a TLV tag. */
export const TAG_FIXED = reg.TAG_RESERVED_ZERO;
/** Every fn's describe: base(u8) bitmap - the ops it offers (core §1.2, §7.4). */
export const TAG_OPS = reg.DESCRIBE_COMMON.ops;

export const CORE_FN = 0;
export const OP = reg.CORE.op;
export const CONFIRM_REQUEST = utf8(reg.CONFIRM_REQUEST_MAGIC);
export const CONFIRM_RESULT = utf8(reg.CONFIRM_RESULT_MAGIC);

export class OepError extends Error {}
/** A result that does not fit: wrong correlation, too short, a value this host does not know. */
export class ProtocolError extends OepError {}
/** A payload shorter than its fixed part, or a truncated TLV (a broken result). */
export class ShortPayload extends ProtocolError {}
/** One request (core §4.1). `session`: the session_id in the header - 0 (null is taken as 0) for a request that
 * belongs to no session, which only an op that needs no lock may be. */
export class Request {
  /** @param {number} corr @param {number} fn @param {number} op @param {Uint8Array} payload @param {number | null} session */
  constructor(corr, fn, op, payload = new Uint8Array(), session = NO_SESSION_ID) {
    this.corr = corr; this.fn = fn; this.op = op; this.payload = payload; this.session = session ?? NO_SESSION_ID;
  }

  pack() {
    const out = new Uint8Array(REQUEST_HEADER + this.payload.length);
    const v = new DataView(out.buffer);
    v.setUint8(0, ROLE_REQUEST);
    v.setUint16(1, this.corr, true);
    v.setUint16(3, this.fn, true);
    v.setUint8(5, this.op);
    v.setUint32(6, this.session >>> 0, true);
    out.set(this.payload, REQUEST_HEADER);
    return out;
  }

  /** @param {Uint8Array} data */
  static unpack(data) {
    if (data.length < REQUEST_HEADER) throw new ProtocolError('request shorter than its header');
    const role = data[0];
    if (role !== ROLE_REQUEST) throw new ProtocolError(`not a request: role 0x${role.toString(16)}`);
    return new Request(getU16(data, 1), getU16(data, 3), data[5], data.slice(REQUEST_HEADER), getU32(data, 6));
  }
}

export class Result {
  /** @param {number} corr @param {number} resolution @param {number} detail @param {Uint8Array} payload */
  constructor(corr, resolution, detail, payload = new Uint8Array()) {
    this.corr = corr; this.resolution = resolution; this.detail = detail; this.payload = payload;
  }

  pack() {
    const out = new Uint8Array(RESULT_HEADER + this.payload.length);
    out[0] = ROLE_RESULT; out[1] = this.corr & 0xff; out[2] = this.corr >> 8; out[3] = this.resolution; out[4] = this.detail;
    out.set(this.payload, RESULT_HEADER);
    return out;
  }

  /** @param {Uint8Array} data */
  static unpack(data) {
    if (data.length < RESULT_HEADER) throw new ShortPayload('result shorter than its header');
    if (data[0] !== ROLE_RESULT) throw new ProtocolError(`not a result: role 0x${data[0].toString(16)}`);
    return new Result(getU16(data, 1), data[3], data[4], data.slice(RESULT_HEADER));
  }

  get succeeded() { return this.resolution === COMPLETED && this.detail === SUCCESS; }
  /** Completed with a known outcome: the payload has the op's result shape (an unknown one is a failure, §2.4). */
  get ran() { return this.resolution === COMPLETED && (this.detail === SUCCESS || this.detail === FAILED || this.detail === PARTIAL); }

  describe() {
    if (this.resolution === REJECTED) return `rejected: ${REJECT_NAMES[this.detail] ?? `reason 0x${this.detail.toString(16)}`}`;
    if (this.resolution === ACCEPTED) return 'accepted';
    if (this.resolution !== COMPLETED) return `unknown resolution 0x${this.resolution.toString(16)}`;
    return /** @type {Record<number, string>} */ ({ [SUCCESS]: 'completed', [FAILED]: 'failed', [PARTIAL]: 'partial' })[this.detail]
      ?? `unknown outcome 0x${this.detail.toString(16)}`;
  }
}

// ---- TLVs ---------------------------------------------------------------------------------------------------

/** One TLV, `tag(u8) len(u16) value` (core §2.2: one form for every length). `critical` sets tag bit 7 (a request
 * argument the probe must honour or refuse).
 * @param {number} tag @param {Uint8Array | number[]} value @param {boolean} critical */
export function tlv(tag, value, critical = false) {
  if (value.length > 0xffff) throw new RangeError(`TLV 0x${tag.toString(16)}: value of ${value.length} bytes does not fit a u16 length`);
  if ((tag & 0x7f) === TAG_IGNORED || tag === TAG_FIXED) throw new RangeError('tags 0x00 and 0x7F are reserved (the unsupported marker, the ignored list)');
  const out = new Uint8Array(TLV_HEADER + value.length);
  out[0] = tag | (critical ? TAG_CRITICAL : 0);
  out[1] = value.length & 0xff; out[2] = value.length >> 8;
  out.set(value, TLV_HEADER);
  return out;
}

/** TLVs in order (core §2.2). A truncated TLV - a header cut short, or a len past the end - throws ShortPayload (the
 * result is broken).
 * @param {Uint8Array} data @returns {[number, Uint8Array][]} */
export function splitTlvs(data) {
  /** @type {[number, Uint8Array][]} */
  const out = [];
  let pos = 0;
  while (pos < data.length) {
    if (pos + TLV_HEADER > data.length) throw new ShortPayload('TLV: truncated header');
    const tag = data[pos];
    const n = getU16(data, pos + 1);
    pos += TLV_HEADER;
    if (pos + n > data.length) throw new ShortPayload(`TLV 0x${tag.toString(16)}: truncated value`);
    out.push([tag, data.slice(pos, pos + n)]);
    pos += n;
  }
  return out;
}

/** The TLVs after a result's known part (unknown tags kept), and `ignored`: the request tags the probe ignored (0x7F). */
export class Tail {
  constructor() {
    /** @type {[number, Uint8Array][]} */ this.tlvs = [];
    /** @type {number[]} */ this.ignored = [];
  }
  /** The first TLV of `tag` (core §2.3: a tag twice in an answer - the host uses the first). @param {number} tag */
  get(tag) { return this.tlvs.find(([t]) => t === tag)?.[1]; }
  /** @param {number} tag */ all(tag) { return this.tlvs.filter(([t]) => (t & 0x7f) === tag).map(([, v]) => v); }
  /** The probe ignored more than it lists (core §2.3, C-04: 0x00 as the last of at most 16 entries): every TLV of the
   * request not listed may have been ignored too. */
  get moreIgnored() { return this.ignored.includes(TAG_FIXED); }
  /** Whether the request's TLV `tag` (its number, bit 7 cleared) may not have taken effect: listed, or not listed but
   * the list ends in 0x00 ("more were ignored"). @param {number} tag */
  mayHaveIgnored(tag) { return this.ignored.includes(tag & 0x7f) || this.moreIgnored; }
  /** @param {Uint8Array} data */
  static parse(data) {
    const t = new Tail();
    for (const [tag, value] of splitTlvs(data)) {
      if (tag === TAG_IGNORED) t.ignored.push(...value);
      else t.tlvs.push([tag, value]);
    }
    return t;
  }
}

/** Reads a result payload's fixed part front to back; too short -> ShortPayload. */
export class Reader {
  /** @param {Uint8Array} data */
  constructor(data) { this.data = data; this.at = 0; }
  /** @param {number} n */
  need(n) {
    if (this.at + n > this.data.length) throw new ShortPayload(`payload of ${this.data.length} bytes: needs ${this.at + n}`);
  }
  u8() { this.need(1); return this.data[this.at++]; }
  u16() { this.need(2); const v = getU16(this.data, this.at); this.at += 2; return v; }
  u32() { this.need(4); const v = getU32(this.data, this.at); this.at += 4; return v; }
  i32() { this.need(4); const v = getI32(this.data, this.at); this.at += 4; return v; }
  u64() { this.need(8); const v = getU64(this.data, this.at); this.at += 8; return v; }
  /** @param {number} n */ bytes(n) { this.need(n); const v = this.data.slice(this.at, this.at + n); this.at += n; return v; }
  /** @param {number} n */ text(n) { return text(this.bytes(n)); }
  /** @param {number} n */ words(n) { return Array.from({ length: n }, () => this.u32()); }
  /** A byte string with its length in front (`width` = the length's bytes: 1, 2 or 4): what every answer carrying
   * data has since core §2.3 put a length on every container. @param {1 | 2 | 4} width */
  counted(width = 2) { return this.bytes(width === 1 ? this.u8() : width === 4 ? this.u32() : this.u16()); }
  get left() { return this.data.length - this.at; }
  /** The rest as bytes (an answer that is a TLV list itself: probe.config get). */
  rest() { const v = this.data.slice(this.at); this.at = this.data.length; return v; }
  /** The TLVs after the known part (core §2.3). */
  tail() { return Tail.parse(this.rest()); }
}

/** Text from an answer, made safe to show (core §2.1): invalid UTF-8 replaced, and every C0 control character
 * (0x00-0x1F) and 0x7F replaced by U+FFFD - an owner or a label can never move a terminal's cursor or colour it.
 * @param {Uint8Array} raw */
export function shown(raw) {
  return text(raw).replace(/[\u0000-\u001f\u007f]/g, '\ufffd');
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text a request may carry (core §2.1): valid UTF-8 without C0 control characters or 0x7F. @param {Uint8Array} raw */
export function validText(raw) {
  let s;
  try { s = strict.decode(raw); } catch { return false; }
  return !/[\u0000-\u001f\u007f]/.test(s);
}

/** a - b for values that wrap (seq u16, serials u32, resource numbers u16), as a signed number of `bits` (core §2.6).
 * @param {number} a @param {number} b @param {number} bits */
export function serialDiff(a, b, bits = 32) {
  const m = 2 ** bits;
  const d = (((a - b) % m) + m) % m;
  return d >= m / 2 ? d - m : d;
}
