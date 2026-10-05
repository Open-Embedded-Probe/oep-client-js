// @ts-check
// The probe's core (fn 0) as the other clients need it: finding interfaces by name, describe, the probe's labels and
// transports, the pin plan, taking the lock - and `Interface`, the base every interface client shares.

import * as reg from './registry.js';
import { Writer, getU16, getU32 } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { OepError } from './errors.js';
import { checkMaxOpMs } from './host.js';

const TAG_ROLE_ASSIGNMENT = reg.CORE.tlv.plan_apply.role_assignment;   // the number 0x10; always sent critical (0x90, core §8)
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

/** fn of the first interface with exactly this name (cached until the probe reboots).
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
 * the probe's boot_id stays the same. fn 0's max_op_ms outside 1..600000 makes the probe NotUsable (C-47).
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
  hst.describes.set(fn, out);
  return [...out];
}

/** The longest one request may take on this probe (oep.core describe max_op_ms, core §7.5): the ceiling of run's
 * timeout_ms, a dmi list's waits, an attach's hold_ms. A probe that declares none (not v1-complete) is taken as the
 * reference firmware's 10000 ms.
 * @param {import('./host.js').Host} hst */
export async function maxOpMs(hst) {
  for (const [tag, v] of await describe(hst, 0)) if ((tag & 0x7f) === D.max_op_ms && v.length >= 4) return getU32(v);
  return reg.REFERENCE.max_op_ms;
}

/** The firmware's fixed channel labels from oep.core's describe (tag 0x46) as [channel, text], in describe order -
 * every one, two channels with the same text included (probe.config §1.3 step (c) finds none then). Text shown as core
 * §2.1 says (`m.shown`). @param {import('./host.js').Host} hst @returns {Promise<[number, string][]>} */
export async function firmwareLabels(hst) {
  return (await describe(hst, 0)).filter(([tag, v]) => (tag & 0x7f) === D.label && v.length >= 2)
    .map(([, v]) => [getU16(v), m.shown(v.slice(2))]);
}

/**
 * oep.core's describe decoded (core §7.5). Text values are shown as core §2.1 says (control characters replaced). labels: the firmware's fixed channel labels (0x46); the labels the settings
 * gave are read from oep.probe.config (config.ProbeConfig.items(), Label). discoverable: the probe also enumerates with the
 * project's USB VID:PID (core §3.3, §7.5). maxOpMs: the longest one request may take.
 * @param {import('./host.js').Host} hst
 */
export async function probeInfo(hst) {
  const info = {
    firmware: /** @type {string | null} */ (null), model: /** @type {string | null} */ (null),
    unitId: /** @type {string | null} */ (null), chip: /** @type {string | null} */ (null),
    profile: /** @type {string | null} */ (null), channels: 0,
    /** @type {number[]} */ reserved: [], /** @type {Map<string, number>} */ labels: new Map(),
    /** @type {{ index: number, kind: number, usbInterface: number }[]} */ transports: [],
    discoverable: false, planRoles: /** @type {number | null} */ (null), maxOpMs: /** @type {number | null} */ (null),
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
    else if (t === D.plan_roles && v.length >= 4) info.planRoles = getU32(v);
    else if (t === D.max_op_ms && v.length >= 4) info.maxOpMs = getU32(v);
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

/** (fn, role, channel) assignments: those fns get these plans, every other fn keeps its own (core §8).
 * @param {import('./host.js').Host} hst @param {[number, number, number][]} assignments */
export async function planApply(hst, assignments) {
  const w = new Writer();
  for (const [fn, role, ch] of assignments) w.u8(TAG_ROLE_ASSIGNMENT | m.TAG_CRITICAL).u8(5).u16(fn).u8(role).u16(ch);
  await hst.call(m.CORE_FN, m.OP.plan_apply, w.done());
}

/** Release the plan of these fns (none: every fn).
 * @param {import('./host.js').Host} hst @param {number[]} fns */
export async function planRelease(hst, fns = []) {
  const w = new Writer().u8(fns.length);
  for (const f of fns) w.u16(f);
  await hst.call(m.CORE_FN, m.OP.plan_release, w.done());
}

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
}
