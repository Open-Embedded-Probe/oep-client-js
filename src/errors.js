// @ts-check
// What the probe (or the link) said no to. `rejection(result)` picks the class by the reject reason.

import * as reg from './registry.js';
import { getU16, getU32, text } from './bytes.js';
import { OepError, ProtocolError, ShortPayload, REJECT, splitTlvs, Tail } from './message.js';

export { OepError, ProtocolError, ShortPayload };

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
export class NoSession extends Rejected {}
export class Busy extends Rejected {}
export class NoConnection extends Rejected {}
export class Unsupported extends Rejected {
  /** The critical tag it could not handle (none: a fixed-part value). */
  get tag() { return this.result.payload.length ? this.result.payload[0] : null; }
}

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
}

/** @type {Record<number, typeof Rejected>} */
const BY_REASON = {
  [REJECT.locked]: Locked, [REJECT.no_session]: NoSession, [REJECT.busy]: Busy, [REJECT.no_connection]: NoConnection,
  [REJECT.unsupported]: Unsupported, [REJECT.unavailable]: Unavailable,
};

/** @param {import('./message.js').Result} result */
export function rejection(result) { return new (BY_REASON[result.detail] ?? Rejected)(result); }
