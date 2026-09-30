// @ts-check
// v1 messages (oep-core §2-§5) and the rules for what follows a payload's fixed part.
//
//   request : role(0x01) corr(u16) fn(u16) op(u8) payload
//             role(0x81) corr(u16) fn(u16) op(u8) session_id(u32) payload     role bit 7 = session_id present
//   result  : role(0x02) corr(u16) resolution(u8) detail(u8) payload
//
// After a result's fixed part come TLVs (tag u8, len u8, value); a host skips tags it does not know. A request may end
// with TLVs; tag bit 7 = critical. Fixed forms grow at their end and readers skip what they do not know (core §2.3);
// an answer list puts each element's length first.

import * as reg from './registry.js';
import { getI32, getU16, getU32, getU64, text, utf8 } from './bytes.js';

export const ROLE_REQUEST = reg.ROLES.request, ROLE_RESULT = reg.ROLES.result;
export const ROLE_EVENT = reg.ROLES.event, ROLE_DATA = reg.ROLES.data;
export const ROLE_SESSION = reg.ROLE_SESSION_FLAG;
export const REQUEST_HEADER = 6, RESULT_HEADER = 5;

export const REJECTED = reg.RESOLUTIONS.rejected, COMPLETED = reg.RESOLUTIONS.completed, ACCEPTED = reg.RESOLUTIONS.accepted;
export const SUCCESS = reg.OUTCOMES.success, FAILED = reg.OUTCOMES.failed, PARTIAL = reg.OUTCOMES.partial;

export const REJECT = reg.REJECT_REASONS;
/** @type {Record<number, string>} */
export const REJECT_NAMES = Object.fromEntries(Object.entries(REJECT).map(([k, v]) => [v, k.replace(/_/g, ' ')]));

export const TAG_CRITICAL = reg.TAG_CRITICAL, TAG_IGNORED = reg.TAG_IGNORED, TAG_INVALID = reg.TAG_INVALID;

export const CORE_FN = 0;
export const OP = reg.CORE.op;
export const CONFIRM_REQUEST = utf8(reg.CONFIRM_REQUEST_MAGIC);
export const CONFIRM_RESULT = utf8(reg.CONFIRM_RESULT_MAGIC);

export class OepError extends Error {}
/** A result that does not fit: wrong correlation, too short, a value this host does not know. */
export class ProtocolError extends OepError {}
/** A payload shorter than its fixed part, or a truncated TLV (a broken result). */
export class ShortPayload extends ProtocolError {}

export class Request {
  /** @param {number} corr @param {number} fn @param {number} op @param {Uint8Array} payload @param {number | null} session */
  constructor(corr, fn, op, payload = new Uint8Array(), session = null) {
    this.corr = corr; this.fn = fn; this.op = op; this.payload = payload; this.session = session;
  }

  pack() {
    const s = this.session !== null;
    const out = new Uint8Array(REQUEST_HEADER + (s ? 4 : 0) + this.payload.length);
    const v = new DataView(out.buffer);
    v.setUint8(0, s ? ROLE_REQUEST | ROLE_SESSION : ROLE_REQUEST);
    v.setUint16(1, this.corr, true);
    v.setUint16(3, this.fn, true);
    v.setUint8(5, this.op);
    if (s) v.setUint32(6, /** @type {number} */ (this.session) >>> 0, true);
    out.set(this.payload, REQUEST_HEADER + (s ? 4 : 0));
    return out;
  }

  /** @param {Uint8Array} data */
  static unpack(data) {
    if (data.length < REQUEST_HEADER) throw new ProtocolError('request shorter than its header');
    const role = data[0];
    if ((role & ~ROLE_SESSION) !== ROLE_REQUEST) throw new ProtocolError(`not a request: role 0x${role.toString(16)}`);
    const corr = getU16(data, 1), fn = getU16(data, 3), op = data[5];
    if (role & ROLE_SESSION) {
      if (data.length < REQUEST_HEADER + 4) throw new ProtocolError('session flag set but no session id');
      return new Request(corr, fn, op, data.slice(REQUEST_HEADER + 4), getU32(data, REQUEST_HEADER));
    }
    return new Request(corr, fn, op, data.slice(REQUEST_HEADER), null);
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

/** One TLV; `critical` sets tag bit 7.
 * @param {number} tag @param {Uint8Array | number[]} value @param {boolean} critical */
export function tlv(tag, value, critical = false) {
  if (value.length > 255) throw new RangeError(`TLV 0x${tag.toString(16)}: value of ${value.length} bytes does not fit`);
  if ((tag & 0x7f) === TAG_IGNORED) throw new RangeError('tag 0x7F is reserved for the ignored list');
  const out = new Uint8Array(2 + value.length);
  out[0] = tag | (critical ? TAG_CRITICAL : 0);
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

/** TLVs in order. A truncated TLV raises ShortPayload.
 * @param {Uint8Array} data @returns {[number, Uint8Array][]} */
export function splitTlvs(data) {
  /** @type {[number, Uint8Array][]} */
  const out = [];
  let pos = 0;
  while (pos < data.length) {
    if (pos + 2 > data.length) throw new ShortPayload('TLV: truncated header');
    const tag = data[pos], n = data[pos + 1];
    if (pos + 2 + n > data.length) throw new ShortPayload(`TLV 0x${tag.toString(16)}: truncated value`);
    out.push([tag, data.slice(pos + 2, pos + 2 + n)]);
    pos += 2 + n;
  }
  return out;
}

/** The TLVs after a result's known part (unknown tags kept), and `ignored`: the request tags the probe ignored (0x7F). */
export class Tail {
  constructor() {
    /** @type {[number, Uint8Array][]} */ this.tlvs = [];
    /** @type {number[]} */ this.ignored = [];
  }
  /** @param {number} tag */ get(tag) { return this.tlvs.find(([t]) => t === tag)?.[1]; }
  /** @param {number} tag */ all(tag) { return this.tlvs.filter(([t]) => (t & 0x7f) === tag).map(([, v]) => v); }
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

/** An answer list's element as sent: len(u8) then the element (core §2.3).
 * @param {Uint8Array} body */
export function element(body) {
  if (body.length > 255) throw new RangeError('a list element is at most 255 bytes');
  const out = new Uint8Array(1 + body.length);
  out[0] = body.length;
  out.set(body, 1);
  return out;
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
  get left() { return this.data.length - this.at; }
  rest() { const v = this.data.slice(this.at); this.at = this.data.length; return v; }
  tail() { return Tail.parse(this.rest()); }
  /** One element of an answer's list: len(u8) then the element; read what you know of it (core §2.3). */
  element() { return new Reader(this.bytes(this.u8())); }
}

/** a - b for values that wrap, as a signed number of `bits` (core §2.6).
 * @param {number} a @param {number} b @param {number} bits */
export function serialDiff(a, b, bits = 32) {
  const m = 2 ** bits;
  const d = (((a - b) % m) + m) % m;
  return d >= m / 2 ? d - m : d;
}
