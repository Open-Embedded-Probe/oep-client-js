// @ts-check
// The host side of the v1 session rules (oep-core §5, §6), over a Link.
//
// Every open picks a random u32 session id (never a counter: after a probe reboot a counter would match an old
// process's id). Role 0x81 (a session id in the header) goes only to a probe whose confirm answered revision 1 or
// more. When the probe's boot_id changes (open, heartbeat), every connection and the plan are gone: `epoch` counts it.

import * as reg from './registry.js';
import { Writer, text, utf8 } from './bytes.js';
import * as m from './message.js';
import { Failed, InUse, Locked, NotV1, Rejected, rejection } from './errors.js';

export const MIN_REVISION = 1, MAX_REVISION = 1;
const OWNER = reg.CORE.tlv.open.owner;

/** @typedef {{ revision: number, flags: number, maxFrame: number, window: number, maxInflight: number, tail: m.Tail }} Limits */
/** @typedef {{ leaseMs: number, bootId: number, resumed: boolean }} Opened */

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomSession() {
  const b = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(b); while (b[0] === 0);
  return b[0];
}

export class Host {
  /** @param {import('./link.js').Link} link */
  constructor(link) {
    this.link = link;
    /** @type {number | null} */ this.session = null;
    /** @type {number | null} */ this.revision = null;
    /** @type {Limits | null} */ this.limits = null;
    this.epoch = 0;
    /** @type {Set<number>} */ this.subscriptions = new Set();
    this.corr = 0;
    /** @type {Map<string, number>} interface name -> fn, until the probe reboots */ this.fns = new Map();
    /** @type {Map<number, number>} fn -> interface revision from list */ this.revisions = new Map();
    /** @type {number | null} */ this.bootId = null;
  }

  nextCorr() { this.corr = (this.corr % 0xffff) + 1; return this.corr; }

  /** @param {boolean} locked */
  async sessionFor(locked) {
    if (!locked || this.session === null) return null;
    await this.requireV1();
    return this.session;
  }

  /**
   * One request. locked: send the session id once a session is open. Rejections throw; any other answer comes back.
   * @param {number} fn @param {number} op @param {Uint8Array} payload @param {{ locked?: boolean }} [opts]
   */
  async request(fn, op, payload = new Uint8Array(), { locked = true } = {}) {
    const req = new m.Request(this.nextCorr(), fn, op, payload, await this.sessionFor(locked));
    const result = m.Result.unpack(await this.link.send(req.pack()));
    if (result.corr !== req.corr) throw new m.ProtocolError(`result for correlation ${result.corr}, expected ${req.corr}`);
    if (result.resolution === m.REJECTED) {
      this.rejected(result);
      throw rejection(result);
    }
    return result;
  }

  /** request() that also throws Failed unless the probe says it worked.
   * @param {number} fn @param {number} op @param {Uint8Array} payload @param {{ locked?: boolean }} [opts] */
  async call(fn, op, payload = new Uint8Array(), opts = {}) {
    const r = await this.request(fn, op, payload, opts);
    if (!r.succeeded) throw new Failed(r);
    return r;
  }

  /** @param {m.Result} result */
  rejected(result) {
    if (result.detail === m.REJECT.no_session) {
      this.subscriptions.clear();
      if (this.bootId === 0) this.lost();
    }
  }

  lost() {
    this.epoch++;
    this.fns.clear();
    this.revisions.clear();
    this.subscriptions.clear();
  }

  /** @param {number} bootId */
  bootIdSeen(bootId) {
    if (this.bootId !== null && bootId !== this.bootId) this.lost();
    this.bootId = bootId;
  }

  /**
   * Several requests in flight (the probe's in-flight and window limits); results in order, rejects NOT thrown.
   * @param {[number, number, Uint8Array][]} requests @param {{ locked?: boolean }} [opts]
   */
  async pipeline(requests, { locked = true } = {}) {
    const session = await this.sessionFor(locked);
    const reqs = requests.map(([fn, op, payload]) => new m.Request(this.nextCorr(), fn, op, payload, session));
    const limits = await this.confirmed();
    const replies = await this.link.exchange(reqs.map((r) => r.pack()), { maxInflight: limits.maxInflight, window: limits.window });
    const results = replies.map((b) => m.Result.unpack(b));
    results.forEach((res, i) => {
      if (res.corr !== reqs[i].corr) throw new m.ProtocolError(`result for correlation ${res.corr}, expected ${reqs[i].corr}`);
      if (res.resolution === m.REJECTED) this.rejected(res);
    });
    return results;
  }

  /** pipeline() for operations that must all work: throws at the first result that did not.
   * @param {[number, number, Uint8Array][]} requests @param {{ locked?: boolean }} [opts] */
  async pipelineCalls(requests, opts = {}) {
    const results = await this.pipeline(requests, opts);
    for (const r of results) {
      if (r.resolution === m.REJECTED) throw rejection(r);
      if (!r.succeeded) throw new Failed(r);
    }
    return results;
  }

  // ---- confirm (§7.1) -------------------------------------------------------------------------------------

  /** Ask for a revision in [minRev, maxRev] -> the probe's limits. Also sets the link's frame limit. */
  async confirm(minRev = MIN_REVISION, maxRev = MAX_REVISION) {
    let r;
    try {
      r = await this.request(m.CORE_FN, m.OP.confirm, new Writer().raw(m.CONFIRM_REQUEST).u8(minRev).u8(maxRev).done(), { locked: false });
    } catch (e) {
      if (e instanceof Rejected && e.result.detail === m.REJECT.malformed) this.revision = 0;
      throw e;
    }
    if (!r.succeeded) throw new Failed(r);
    const rd = new m.Reader(r.payload);
    const magic = rd.bytes(4), revision = rd.u8();
    if (text(magic) !== reg.CONFIRM_RESULT_MAGIC) throw new m.ProtocolError(`confirm answered magic ${text(magic)}`);
    if (revision === 0) {
      this.revision = 0;
      throw new NotV1('the probe speaks OEP revision 0');
    }
    if (revision < minRev || revision > maxRev) throw new m.ProtocolError(`confirm answered revision ${revision}, outside ${minRev}..${maxRev}`);
    const flags = rd.u8(), maxFrame = rd.u16(), window = rd.u32(), maxInflight = rd.u8();
    this.revision = revision;
    this.limits = { revision, flags, maxFrame, window, maxInflight, tail: rd.tail() };
    if (this.link.framing === 'length' && maxFrame) this.link.maxFrame = maxFrame;
    return this.limits;
  }

  /** confirm()'s answer, asked once per host. */
  async confirmed() { return this.limits ?? this.confirm(); }

  async requireV1() {
    if (this.revision === null) {
      try { await this.confirm(); } catch (e) {
        if (this.revision === 0) throw new NotV1('the probe refused the ranged confirm: not a v1 probe');
        throw e;
      }
    }
    if (/** @type {number} */ (this.revision) < 1) throw new NotV1(`the probe speaks OEP revision ${this.revision}`);
  }

  // ---- the session and the lock (§6) -----------------------------------------------------------------------

  /**
   * A new random id unless `session` is given. leaseMs 0 = the probe's default. owner: who holds the lock (shown).
   * @param {number} leaseMs @param {{ force?: boolean, session?: number, owner?: string }} [opts]
   * @returns {Promise<Opened>}
   */
  async open(leaseMs = 0, { force = false, session, owner } = {}) {
    await this.requireV1();
    const sid = session ?? randomSession();
    const w = new Writer().u32(sid).u32(leaseMs).u8(force ? 1 : 0);
    if (owner) w.raw(m.tlv(OWNER, utf8(owner).slice(0, 32)));
    const r = await this.request(m.CORE_FN, m.OP.open, w.done(), { locked: false });
    if (sid !== this.session) this.subscriptions.clear();
    this.session = sid;
    const rd = new m.Reader(r.payload);
    const lease = rd.u32(), bootId = rd.u32(), resumed = rd.u8() !== 0;
    this.bootIdSeen(bootId);
    if (!resumed) this.subscriptions.clear();
    return { leaseMs: lease, bootId, resumed };
  }

  async end() {
    await this.request(m.CORE_FN, m.OP.end);
    this.subscriptions.clear();
  }

  async keepalive() { await this.request(m.CORE_FN, m.OP.keepalive); }

  /** @returns {Promise<{ locked: boolean, remainingMs: number, owner: string | null }>} */
  async lockState() {
    const p = (await this.request(m.CORE_FN, m.OP.lock_state, new Uint8Array(), { locked: false })).payload;
    const rd = new m.Reader(p);
    const locked = rd.u8() !== 0, remainingMs = rd.u32();
    const v = rd.tail().get(reg.CORE.tlv.lock_state_answer.owner);
    return { locked, remainingMs, owner: v ? text(v) : null };
  }

  /**
   * open() the way host guide §2 takes the lock: onlyWayIn (this link is the probe's only transport, a serial port
   * opened exclusively) or force takes it at once; otherwise the holder's lease is waited out, up to waitMs.
   * @param {number} leaseMs @param {{ owner?: string, onlyWayIn?: boolean, waitMs?: number, force?: boolean }} [opts]
   */
  async take(leaseMs = 3000, { owner, onlyWayIn = false, waitMs = 5000, force = false } = {}) {
    if (force || onlyWayIn) return this.open(leaseMs, { force: true, owner });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        return await this.open(leaseMs, { owner });
      } catch (e) {
        if (!(e instanceof Locked)) throw e;
        const left = deadline - Date.now();
        if (left <= 0 || e.remainingMs > left) {
          throw new InUse(`the probe is in use by ${e.owner ?? 'another session'} (lease ${e.remainingMs} ms left, kept going)`);
        }
        await sleep(Math.min(left, e.remainingMs + 50));
      }
    }
  }

  // ---- notifications (§11) ---------------------------------------------------------------------------------

  /** @param {number} fn @param {number} minBytes @param {number} maxDelayMs */
  async subscribe(fn, minBytes = 0, maxDelayMs = 0) {
    await this.call(m.CORE_FN, m.OP.subscribe, new Writer().u16(fn).u16(minBytes).u16(maxDelayMs).done());
    this.subscriptions.add(fn);
  }

  /** @param {number} fn */
  async unsubscribe(fn) {
    await this.call(m.CORE_FN, m.OP.unsubscribe, new Writer().u16(fn).done());
    this.subscriptions.delete(fn);
  }
}
