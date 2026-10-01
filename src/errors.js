// @ts-check
// What the probe (or the link) said no to. `rejection(result)` picks the class by the reject reason.

import * as reg from './registry.js';
import { getU16, getU32, text } from './bytes.js';
import { OepError, ProtocolError, ShortPayload, BadTlv, REJECT, TAG_FIXED, splitTlvs, Tail } from './message.js';

export { OepError, ProtocolError, ShortPayload, BadTlv };

/** The probe refused the request (resolution rejected). */
export class Rejected extends OepError {
  /** @param {import('./message.js').Result} result */
  constructor(result) { super(result.describe()); this.result = result; }
  get reason() { return this.result.detail; }
}

/** The probe ran the request and it did not work (failed / partial), or answered what this host does not know. */
export class Failed extends OepError {
  /** @param {import('./message.js').Result | null} result @param {string} why */
  constructor(result, why = '') { super(why || (result ? result.describe() : 'failed')); this.result = result; }
}

/** The probe does not speak v1. */
export class NotV1 extends OepError {}
/** No answer in time (after the one resend). */
export class Timeout extends OepError {}
/** The lock is held by someone who keeps it going. */
export class InUse extends OepError {}

const OWNER = reg.CORE.tlv.locked_payload.owner;

export class Locked extends Rejected {
  get remainingMs() { return this.result.payload.length >= 4 ? getU32(this.result.payload) : 0; }
  /** The holder's owner text, when its open gave one. */
  get owner() {
    try {
      const v = Tail.parse(this.result.payload.slice(4)).get(OWNER);
      return v ? text(v) : null;
    } catch { return null; }
  }
}
/** rejected no_session: another session came in between (a force among them) and took this session's resources over
 * (core §9); the host opens again. */
export class NoSession extends Rejected {}

/**
 * rejected expired (core §6.2, §9): this session's lease lapsed and the probe swept its resources (plan, connections,
 * streams). Nothing is re-opened silently: the caller opens again (resumed = 2 then) and rebuilds what it had.
 * `leaseMs`: the lease the session had (null when unknown). A session whose lock another id took by force sees Locked
 * while that one holds it, then NoSession (the probe remembers the last id only) - never Expired.
 */
export class Expired extends Rejected {
  /** @param {import('./message.js').Result} result @param {number | null} leaseMs */
  constructor(result, leaseMs = null) {
    super(result);
    this.leaseMs = leaseMs;
    const lease = leaseMs !== null ? ` (lease ${leaseMs} ms)` : '';
    this.message = `session expired${lease}: the lease lapsed and the probe swept this session's resources - open again`;
  }
}
export class Busy extends Rejected {}
export class NoConnection extends Rejected {}

/** rejected unsupported (core §4.3): a critical TLV (`tag`, as received) or a fixed-part value (tag null; the wire says
 * 0x00) the probe cannot handle. `tlvs`: what follows, saying which element (channel, index, fn) when the probe knows. */
export class Unsupported extends Rejected {
  /** The critical tag it could not handle (null: a fixed-part value). */
  get tag() { const p = this.result.payload; return p.length && p[0] !== TAG_FIXED ? p[0] : null; }
  /** @returns {[number, Uint8Array][]} */
  get tlvs() { try { return splitTlvs(this.result.payload.slice(1)); } catch { return []; } }
  /** @param {number} tag */ first(tag) { return this.tlvs.find(([t]) => (t & 0x7f) === tag)?.[1]; }
  /** The channel the probe names (unsupported_payload 0x02), else null. */
  get channel() { const v = this.first(UNS.channel); return v && v.length >= 2 ? getU16(v) : null; }
  /** The fn the probe names (unsupported_payload 0x05), else null. */
  get fn() { const v = this.first(UNS.fn); return v && v.length >= 2 ? getU16(v) : null; }
  /** Where in the request's list the refused element stood (unsupported_payload 0x40), else null. */
  get index() { const v = this.first(UNS.index); return v && v.length >= 1 ? v[0] : null; }
}

const UNS = reg.CORE.tlv.unsupported_payload;

const UNA = reg.CORE.tlv.unavailable_payload;
const CAUSES = Object.fromEntries(Object.entries(reg.CORE.enum.unavailable_cause).map(([k, v]) => [v, k]));
const KINDS = Object.fromEntries(Object.entries(reg.CORE.enum.holder_kind).map(([k, v]) => [v, k]));

/** rejected unavailable (core §4.3): cause, channels, holderFn, holderKind from the payload's TLVs (each may be missing). */
export class Unavailable extends Rejected {
  get tlvs() { try { return splitTlvs(this.result.payload); } catch { return []; } }
  /** @param {number} tag */ first(tag) { return this.tlvs.find(([t]) => (t & 0x7f) === tag)?.[1]; }
  get cause() { const v = this.first(UNA.cause); return v ? (CAUSES[v[0]] ?? String(v[0])) : null; }
  get channels() { return this.tlvs.filter(([t, v]) => (t & 0x7f) === UNA.channel && v.length >= 2).map(([, v]) => getU16(v)); }
  get holderFn() { const v = this.first(UNA.holder_fn); return v && v.length >= 2 ? getU16(v) : null; }
  get holderKind() { const v = this.first(UNA.holder_kind); return v ? (KINDS[v[0]] ?? String(v[0])) : null; }
  /** The fn the probe names (unavailable_payload 0x05), else null. */
  get fn() { const v = this.first(UNA.fn); return v && v.length >= 2 ? getU16(v) : null; }
}

/** @type {Record<number, typeof Rejected>} */
const BY_REASON = {
  [REJECT.locked]: Locked, [REJECT.no_session]: NoSession, [REJECT.busy]: Busy, [REJECT.no_connection]: NoConnection,
  [REJECT.unsupported]: Unsupported, [REJECT.unavailable]: Unavailable,
};

/** The error class a rejected result deserves; `leaseMs` names the lease in an Expired.
 * @param {import('./message.js').Result} result @param {number | null} leaseMs */
export function rejection(result, leaseMs = null) {
  if (result.detail === REJECT.expired) return new Expired(result, leaseMs);
  return new (BY_REASON[result.detail] ?? Rejected)(result);
}
