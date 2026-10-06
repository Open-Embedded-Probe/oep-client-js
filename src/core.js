// @ts-check
// The probe's core (fn 0, no name: never in list, core §0) as the other clients need it: finding interfaces by name,
// describe (with the ops check of core §7.4), the probe's labels and transports, taking the lock; the small probe
// interfaces found by name - oep.probe.plan (the pin plan), oep.probe.restart (its restart_max_ms), oep.probe.link (the
// link test) - and `Interface`, the base every interface client shares.

import * as reg from './registry.js';
import { Writer, getU16, getU32 } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { OepError, rejection } from './errors.js';
import { checkMaxOpMs } from './host.js';

const D = reg.CORE.tlv.describe;
export const TRANSPORT_KIND = reg.CORE.enum.transport_kind;
export const SERIAL_KINDS = new Set([TRANSPORT_KIND.uart_bridge, TRANSPORT_KIND.usb_cdc, TRANSPORT_KIND.usb_serial_jtag]);

/** The probe offers the interface in a revision this client does not speak (core §2.7). */
export class UnsupportedRevision extends OepError {}

/** Every list entry under `name` (exact: that name only), paged. The fn -> revision of each is remembered.
 * @param {import('./host.js').Host} hst @param {string} name @param {boolean} exact */
export async function listEntries(hst, name = '', exact = false) {
  /** @type {catalog.ListEntry[]} */
  const entries = [];
  for (;;) {
    const r = await hst.request(m.CORE_FN, m.OP.list, catalog.packListRequest(name, exact, entries.length), { locked: false });
    const { total, entries: page } = catalog.unpackListResult(r.payload);
    entries.push(...page);
    if (!page.length || entries.length >= total) break;
  }
  for (const e of entries) hst.revisions.set(e.fn, e.revision);
  return entries;
}

/** @param {import('./host.js').Host} hst @param {string} name */
export async function findAll(hst, name) { return (await listEntries(hst, name, true)).map((e) => e.fn); }

/** fn of the first interface with exactly this name, or null when the probe lists none (cached until the probe reboots).
 * @param {import('./host.js').Host} hst @param {string} name @returns {Promise<number | null>} */
export async function findOptional(hst, name) {
  const fn = hst.fns.get(name);
  if (fn !== undefined) return fn;
  const fns = await findAll(hst, name);
  if (!fns.length) return null;
  hst.fns.set(name, fns[0]);
  return fns[0];
}

/** fn of the first interface with exactly this name (cached until the probe reboots); throws when the probe lists none.
 * @param {import('./host.js').Host} hst @param {string} name */
export async function find(hst, name) {
  let fn = hst.fns.get(name);
  if (fn === undefined) {
    const fns = await findAll(hst, name);
    if (!fns.length) throw new OepError(`the probe does not offer ${name}`);
    fn = fns[0];
    hst.fns.set(name, fn);
  }
  return fn;
}

/** @param {import('./host.js').Host} hst @param {string} name @param {number} fn */
export async function revision(hst, name, fn) {
  if (!hst.revisions.has(fn)) await listEntries(hst, name, true);
  const rev = hst.revisions.get(fn);
  if (rev === undefined) throw new OepError(`the probe lists no ${name} at fn ${fn}`);
  return rev;
}

/** Every describe TLV of `fn` (0: the probe itself), paged. Declarations only (core §7.3): cached on the host while
 * the probe's boot_id stays the same. fn 0's max_op_ms outside 1..600000 makes the probe NotUsable (C-47). An ops value
 * outside core §7.4's one encoding (`catalog.checkOps`) makes that fn unusable (FnNotUsable, thrown here and by every
 * later request to it) - fn 0's, the probe (NotUsable).
 * @param {import('./host.js').Host} hst @param {number} fn @returns {Promise<[number, Uint8Array][]>} */
export async function describe(hst, fn = 0) {
  const cached = hst.describes.get(fn);
  if (cached) return [...cached];
  /** @type {[number, Uint8Array][]} */
  const out = [];
  for (;;) {
    const p = (await hst.request(m.CORE_FN, m.OP.describe, catalog.packDescribeRequest(fn, out.length), { locked: false })).payload;
    const more = p[0];
    const page = m.splitTlvs(p.slice(1));
    out.push(...page);
    if (!more || !page.length) break;
  }
  if (fn === m.CORE_FN) {
    const v = out.find(([tag, value]) => (tag & 0x7f) === D.max_op_ms && value.length >= 4)?.[1];
    const why = v ? checkMaxOpMs(getU32(v)) : '';
    if (why) hst.notUsable(why);           // not conforming: not used (core §4.4, §7.5, C-47)
  }
  for (const [tag, value] of out) {
    const why = (tag & 0x7f) === m.TAG_OPS ? catalog.checkOps(value) : '';
    if (!why) continue;
    if (fn === m.CORE_FN) hst.notUsable(`describe of fn 0: ${why} (core §7.4), so the probe is not used`);
    hst.fnNotUsable(fn, `describe of fn ${fn}: ${why} (core §7.4), so that fn is not used`);
  }
  hst.describes.set(fn, out);
  return [...out];
}

/** The ops fn's describe declares in its ops tag (core §1.2, §7.4: the one declaration of every op an fn offers, the
 * optional ones included); null when the describe carries none (a probe that does not conform: the host sends and lets
 * the probe answer).
 * @param {import('./host.js').Host} hst @param {number} fn @returns {Promise<Set<number> | null>} */
export async function ops(hst, fn = 0) {
  /** @type {Set<number> | null} */
  let found = null;
  for (const [tag, v] of await describe(hst, fn)) {
    if ((tag & 0x7f) === m.TAG_OPS) found = new Set([...(found ?? []), ...catalog.unpackOps(v)]);
  }
  return found;
}

/** Whether fn offers op by its ops tag (true when the describe declares no ops: unknown, the probe decides).
 * @param {import('./host.js').Host} hst @param {number} fn @param {number} op */
export async function offers(hst, fn, op) {
  const declared = await ops(hst, fn);
  return declared === null || declared.has(op);
}

/** What a request for an op the fn's ops tag does not set gets from the probe (core §1.2, §4.3 order 1): the same
 * Rejected with detail unknown_operation the host throws for that answer - a host that checks ops before sending
 * throws this instead of sending. @returns {import('./errors.js').Rejected} */
export function notOffered() {
  return rejection(new m.Result(0, m.REJECTED, m.REJECT.unknown_operation));
}

/** Throw `notOffered()` when fn's ops tag does not set op (nothing is sent then).
 * @param {import('./host.js').Host} hst @param {number} fn @param {number} op */
export async function require(hst, fn, op) {
  if (!(await offers(hst, fn, op))) throw notOffered();
}

/** The longest one request may take on this probe (fn 0 describe max_op_ms, core §7.5): the ceiling of run's
 * timeout_ms, a dmi list's waits, an attach's hold_ms. A probe that declares none (not v1-complete) is taken as the
 * reference firmware's 10000 ms.
 * @param {import('./host.js').Host} hst */
export async function maxOpMs(hst) {
  for (const [tag, v] of await describe(hst, 0)) if ((tag & 0x7f) === D.max_op_ms && v.length >= 4) return getU32(v);
  return reg.REFERENCE.max_op_ms;
}

/** The longest the probe takes from restart's answer until it answers confirm again on the same transport
 * (oep.probe.restart describe restart_max_ms, oep-if-restart §1; required there). null: the probe lists no
 * oep.probe.restart, or its describe declares none (a probe that does not conform).
 * @param {import('./host.js').Host} hst @returns {Promise<number | null>} */
export async function restartMaxMs(hst) {
  const fn = await findOptional(hst, RESTART_NAME);
  if (fn === null) return null;
  for (const [tag, v] of await describe(hst, fn)) if ((tag & 0x7f) === RESTART_MAX_MS && v.length >= 4) return getU32(v);
  return null;
}

/** The firmware's fixed channel labels from fn 0's describe (tag 0x46) as [channel, text], in describe order -
 * every one, two channels with the same text included (probe.config §1.3 step (c) finds none then). Text shown as core
 * §2.1 says (`m.shown`). @param {import('./host.js').Host} hst @returns {Promise<[number, string][]>} */
export async function firmwareLabels(hst) {
  return (await describe(hst, 0)).filter(([tag, v]) => (tag & 0x7f) === D.label && v.length >= 2)
    .map(([, v]) => [getU16(v), m.shown(v.slice(2))]);
}

/**
 * fn 0's describe decoded (core §7.5). Text values are shown as core §2.1 says (control characters replaced). labels: the firmware's fixed channel labels (0x46); the labels the settings
 * gave are read from oep.probe.config (config.ProbeConfig.items(), Label). discoverable: the probe also enumerates with the
 * project's USB VID:PID (transports §3, core §7.5). maxOpMs: the longest one request may take. ops: fn 0's ops (core
 * §7.4; null: none declared). plan_roles and restart_max_ms are their interfaces' (`planRoles`, `restartMaxMs`).
 * @param {import('./host.js').Host} hst
 */
export async function probeInfo(hst) {
  const info = {
    firmware: /** @type {string | null} */ (null), model: /** @type {string | null} */ (null),
    unitId: /** @type {string | null} */ (null), chip: /** @type {string | null} */ (null),
    profile: /** @type {string | null} */ (null), channels: 0,
    /** @type {number[]} */ reserved: [], /** @type {Map<string, number>} */ labels: new Map(),
    /** @type {{ index: number, kind: number, usbInterface: number }[]} */ transports: [],
    discoverable: false, maxOpMs: /** @type {number | null} */ (null), ops: /** @type {Set<number> | null} */ (null),
    /** @type {[number, Uint8Array][]} */ other: [],
  };
  for (const [tag, v] of await describe(hst, 0)) {
    const t = tag & 0x7f;
    if (t === D.firmware) info.firmware = m.shown(v);
    else if (t === D.model) info.model = m.shown(v);
    else if (t === D.unit_id) info.unitId = m.shown(v);
    else if (t === D.chip) info.chip = m.shown(v);
    else if (t === D.profile) info.profile = m.shown(v);
    else if (t === D.channels) info.channels = getU16(v);
    else if (t === D.reserved) info.reserved = catalog.bitmapToChannels(getU16(v), v.slice(2));
    else if (t === D.label && v.length >= 2) info.labels.set(m.shown(v.slice(2)), getU16(v));
    else if (t === D.transport && v.length >= 2) info.transports.push({ index: v[0], kind: v[1], usbInterface: v.length > 2 ? v[2] : 0xff });
    else if (t === D.discoverable) info.discoverable = v[0] === 1;
    else if (t === D.max_op_ms && v.length >= 4) info.maxOpMs = getU32(v);
    else if (t === m.TAG_OPS) info.ops = new Set([...(info.ops ?? []), ...catalog.unpackOps(v)]);
    else info.other.push([tag, v]);
  }
  return info;
}

/** Take the lock as host guide §6 says: the probe's only transport a serial port this host opened exclusively ->
 * force at once; else wait out the holder's lease.
 * @param {import('./host.js').Host} hst @param {number} leaseMs @param {{ owner?: string, waitMs?: number, force?: boolean, exclusive?: boolean }} [opts] */
export async function take(hst, leaseMs = 3000, { owner, waitMs = 5000, force = false, exclusive = false } = {}) {
  const ways = (await probeInfo(hst)).transports;
  const only = exclusive && ways.length === 1 && SERIAL_KINDS.has(ways[0].kind) && hst.link.framing === 'cobs';
  return hst.take(leaseMs, { owner, onlyWayIn: only, waitMs, force });
}

// ---- oep.probe.plan (oep-if-plan): which channel each role of an interface uses ---------------------------------------
export const PLAN_NAME = reg.PROBE_PLAN.name;
export const PLAN_APPLY = reg.PROBE_PLAN.op.plan_apply, PLAN_RELEASE = reg.PROBE_PLAN.op.plan_release;
const TAG_ROLE_ASSIGNMENT = reg.PROBE_PLAN.tlv.plan_apply.role_assignment;   // 0x10; always sent critical (0x90, oep-if-plan §2.1)
const PLAN_ROLES = reg.PROBE_PLAN.tlv.describe.plan_roles;

/** The fn of the probe's oep.probe.plan (throws when it lists none: a probe whose interfaces have no plan role).
 * @param {import('./host.js').Host} hst */
export function planFn(hst) { return find(hst, PLAN_NAME); }

/** plan_apply's request: one role_assignment TLV, sent critical, per (fn, role, channel) (oep-if-plan §2.1).
 * @param {[number, number, number][]} assignments */
export function planApplyRequest(assignments) {
  const w = new Writer();
  for (const [fn, role, ch] of assignments) w.raw(m.tlv(TAG_ROLE_ASSIGNMENT, new Writer().u16(fn).u8(role).u16(ch).done(), true));
  return w.done();
}

/** (fn, role, channel) assignments: those fns get these plans atomically, every other fn keeps its own (oep-if-plan §2.1),
 * on the probe's oep.probe.plan. @param {import('./host.js').Host} hst @param {[number, number, number][]} assignments */
export async function planApply(hst, assignments) {
  await hst.call(await planFn(hst), PLAN_APPLY, planApplyRequest(assignments));
}

/** Release the plan of these fns (none: every fn; oep-if-plan §2.2), on the probe's oep.probe.plan.
 * @param {import('./host.js').Host} hst @param {number[]} fns */
export async function planRelease(hst, fns = []) {
  const w = new Writer().u8(fns.length);
  for (const f of fns) w.u16(f);
  await hst.call(await planFn(hst), PLAN_RELEASE, w.done());
}

/** The most role assignments the plan holds at once, every fn together (oep.probe.plan describe plan_roles, oep-if-plan
 * §1). null: no oep.probe.plan, or no limit declared. @param {import('./host.js').Host} hst @returns {Promise<number | null>} */
export async function planRoles(hst) {
  const fn = await findOptional(hst, PLAN_NAME);
  if (fn === null) return null;
  for (const [tag, v] of await describe(hst, fn)) if ((tag & 0x7f) === PLAN_ROLES && v.length >= 4) return getU32(v);
  return null;
}

// ---- oep.probe.restart (oep-if-restart): the probe restarts itself, an optional interface ----------------------------
export const RESTART_NAME = reg.PROBE_RESTART.name;
export const RESTART = reg.PROBE_RESTART.op.restart;
const RESTART_MAX_MS = reg.PROBE_RESTART.tlv.describe.restart_max_ms;

/** The fn of the probe's oep.probe.restart (throws when it lists none: restart is optional).
 * @param {import('./host.js').Host} hst */
export function restartFn(hst) { return find(hst, RESTART_NAME); }

/**
 * One interface client: its fn (found by name), its revision checked against the list, and calls that throw unless
 * the probe says it worked. Build with `await Cls.open(host, ...)`.
 */
export class Interface {
  /** @type {string} */ static NAME = '';
  /** @type {number | null} */ static REVISION = null;

  /** @param {import('./host.js').Host} hst @param {number} fn @param {string} name @param {Uint8Array} prefix */
  constructor(hst, fn, name, prefix = new Uint8Array()) {
    this.host = hst; this.fn = fn; this.name = name; this.prefix = prefix;
  }

  /**
   * @template {typeof Interface} T
   * @this {T}
   * @param {import('./host.js').Host} hst
   * @param {{ fn?: number, name?: string, prefix?: Uint8Array }} [opts]
   * @returns {Promise<InstanceType<T>>}
   */
  static async open(hst, { fn, name, prefix } = {}) {
    const n = name ?? this.NAME;
    const f = fn ?? await find(hst, n);
    if (this.REVISION !== null) {
      const rev = await revision(hst, n, f);
      if (rev !== this.REVISION) throw new UnsupportedRevision(`${n} (fn ${f}) is revision ${rev}; this client speaks ${this.REVISION}`);
    }
    return /** @type {InstanceType<T>} */ (new this(hst, f, n, prefix ?? new Uint8Array()));
  }

  /** @param {Uint8Array} body */
  withPrefix(body) {
    if (!this.prefix.length) return body;
    const out = new Uint8Array(this.prefix.length + body.length);
    out.set(this.prefix);
    out.set(body, this.prefix.length);
    return out;
  }

  /** @param {number} op @param {Uint8Array} body @param {{ locked?: boolean, expectMs?: number }} [opts] */
  call(op, body = new Uint8Array(), opts = {}) { return this.host.call(this.fn, op, this.withPrefix(body), opts); }
  /** Rejections throw; completed results of any outcome come back.
   * @param {number} op @param {Uint8Array} body @param {{ locked?: boolean, expectMs?: number }} [opts] */
  request(op, body = new Uint8Array(), opts = {}) { return this.host.request(this.fn, op, this.withPrefix(body), opts); }
  /** The raw (fn, op, payload) of one operation, for Host.pipeline.
   * @param {number} op @param {Uint8Array} body @returns {[number, number, Uint8Array]} */
  req(op, body = new Uint8Array()) { return [this.fn, op, this.withPrefix(body)]; }
  /** The ops this fn's describe declares (core §1.2, §7.4; null: no ops tag). */
  ops() { return ops(this.host, this.fn); }
  /** Whether this fn offers op by its ops tag (an optional op is offered exactly when set). @param {number} op */
  offers(op) { return offers(this.host, this.fn, op); }
}

// ---- oep.probe.link (oep-if-link): the link test and port_speed, an optional interface ------------------------------
export const LINK_NAME = reg.PROBE_LINK.name;
export const LINK_SOURCE = reg.PROBE_LINK.op.source, LINK_SINK = reg.PROBE_LINK.op.sink, LINK_PORT_SPEED = reg.PROBE_LINK.op.port_speed;
/** source's len is at most max_frame minus this (oep-if-link §2: header 5, len 2, the ignored room 19). */
export const LINK_SOURCE_OVERHEAD = reg.LIMITS.link_source_overhead_bytes;

/** The most one source answer carries and one sink request may (oep-if-link §2): max_frame - 26.
 * @param {number} maxFrame */
export function linkSize(maxFrame) { return Math.max(1, maxFrame - LINK_SOURCE_OVERHEAD); }

/** The fn of the probe's oep.probe.link (throws when the probe offers none - the link test and port_speed are optional).
 * @param {import('./host.js').Host} hst */
export function linkFn(hst) { return find(hst, LINK_NAME); }

/** source's request: length(u32). @param {number} size */
export function linkSourceRequest(size) { return new Writer().u32(size).done(); }

/** sink's request: count(u16) data. @param {Uint8Array} data */
export function linkSinkRequest(data) { return new Writer().u16(data.length).raw(data).done(); }

/** source's answer: len(u16) data [TLV] -> data (byte k = k & 0xFF). @param {Uint8Array} payload */
export function linkSourceData(payload) {
  const rd = new m.Reader(payload);
  const data = rd.counted(2);
  rd.tail();
  return data;
}
