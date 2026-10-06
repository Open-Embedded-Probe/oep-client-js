// @ts-check
// What the probe (or the link) said no to. `rejection(result)` picks the class by the reject reason.

import * as reg from './registry.js';
import { getU16, getU32 } from './bytes.js';
import { OepError, ProtocolError, ShortPayload, REJECT, TAG_FIXED, splitTlvs, shown, Tail } from './message.js';

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
/** core §5.2 (C-38): a request's resend got no answer either - the transport failed. The outcome of that request, and
 * of every request outstanding with it, is unknown. Nothing else goes out on the transport before the link has
 * recovered with transports §5's confirm (the next request runs it first; when no confirm is answered that request fails
 * with TransportFailed too, `recovery` set, and the transport stays failed: close and open it again). After a recovery,
 * read the state before repeating a state-changing request. `broken`: the resend's answer came broken (a serial port's
 * bad frame), not missing. */
export class TransportFailed extends Timeout {
  /** @param {string} message @param {{ broken?: boolean, recovery?: boolean }} [opts] */
  constructor(message, { broken = false, recovery = false } = {}) { super(message); this.broken = broken; this.recovery = recovery; }
}
/** The probe declared values a conforming probe never does (core §7.1 confirm's bounds, C-20; §7.5 max_op_ms, C-47;
 * §7.4 an fn 0 ops outside its one encoding): this host sends nothing more to it. The message reports the values. */
export class NotUsable extends OepError {}
/** One fn's describe carries an ops value outside core §7.4's one encoding: this host sends nothing more to that fn
 * (until the probe restarts); the rest of the probe stays usable. `fn`: the fn. */
export class FnNotUsable extends OepError {
  /** @param {number} fn @param {string} message */
  constructor(fn, message) { super(message); this.fn = fn; }
}
/** Host.restartProbe (oep-if-restart): after the restart the probe confirmed the boot_id it had before - the restart did not
 * happen as far as this host can tell (a probe whose boot_id source repeated is told apart by nothing else). */
export class NotRestarted extends OepError {}
/** A length-prefixed link lost its frame boundaries (transports §5) and could not find them again, or a request
 * waiting then could not go once more (already resent, or a session request after the resync's blind end). */
export class FramingLost extends OepError {}
/** The lock is held by someone who keeps it going. */
export class InUse extends OepError {}
/** A device or port this host had not identified gave no valid confirm answer (transports §3 probing rule): it was closed
 * and nothing else was sent to it. */
export class NotOepProbe extends OepError {}
/** The device opened by its named unit id (its USB serial) says another unit_id in describe (transports §3): closed. */
export class UnitIdMismatch extends OepError {}

const OWNER = reg.CORE.tlv.locked_payload.owner;

export class Locked extends Rejected {
  get remainingMs() { return this.result.payload.length >= 4 ? getU32(this.result.payload) : 0; }
  /** The holder's owner text, when its open gave one (control characters replaced, core §2.1). */
  get owner() {
    try {
      const v = Tail.parse(this.result.payload.slice(4)).get(OWNER);
      return v ? shown(v) : null;
    } catch { return null; }
  }
}
/** rejected no_session (core §6.2): the request carries a session_id while no session holds the lock - this session
 * ended (end, lease expiry, another session's force and then its end) and the probe released everything it created.
 * Nothing is re-opened silently: the caller opens a new session and builds again (host guide §9). */
export class NoSession extends Rejected {}
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
  /** confirm's refusal (core §7.1, C-15): [min, max] of the protocol revisions the probe handles (TLV 0x01 supported
   * after tag 0x00); null for any other refusal. @returns {[number, number] | null} */
  get supported() {
    if (this.tag !== null) return null;
    const v = this.tlvs.find(([t]) => t === UNS.supported)?.[1];
    return v && v.length >= 2 ? [v[0], v[1]] : null;
  }
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

/** The error class a rejected result deserves.
 * @param {import('./message.js').Result} result */
export function rejection(result) {
  return new (BY_REASON[result.detail] ?? Rejected)(result);
}
