// @ts-check
// Collect a probe's declared capabilities (list + describe of every fn, paged) into plain objects, and render them as
// text (like `oep dump`) or JSON. Everything goes through a Host, so a web page can use it as it is.
//
//   const caps = await collect(hst);
//   caps.offers.map(describeOffer)     // plain data, one object per interface
//   toText(caps)                       // the text `oep dump` prints

import * as reg from './registry.js';
import { hex } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { CORE_KNOWN, KNOWN, opNames, ranges } from './interfaces.js';
import { kind } from './names.js';

/** @typedef {{ entry: catalog.ListEntry, description: catalog.Description, tlvs: [number, Uint8Array][] }} Offer */
/**
 * @typedef {object} Capabilities
 * @property {number} revision      the protocol revision confirm answered
 * @property {number} maxFrame
 * @property {Offer} core           fn 0, the core: its describe is the probe itself (no name, never listed; core §0, §7.5).
 *                                  Its entry is a stand-in: fn 0, instance 0, name '', the protocol revision
 * @property {Offer[]} offers       what list gave (the core is never among them)
 * @property {{ confirm: number, list: number, describe: number }} requests   how many were sent
 * @property {string[]} missing     what core §1.2 (and an interface's document) requires and the probe did not give
 *                                  (C-10; empty: nothing seen missing)
 */

/** fn 0's describe TLVs every probe gives (core §1.2, §7.5). @type {[number, string][]} */
const REQUIRED_CORE_TAGS = /** @type {const} */ (['unit_id', 'transport', 'max_op_ms', 'discoverable']).map((k) => [reg.CORE.tlv.describe[k], k]);
/** The describe tags an interface's document requires: name -> [tag, its name] (oep-if-restart §1). @type {Record<string, [number, string][]>} */
const REQUIRED_TAGS = { [reg.PROBE_RESTART.name]: [[reg.PROBE_RESTART.tlv.describe.restart_max_ms, 'restart_max_ms']] };

/**
 * core §1.2 (C-10) as far as a lock-free look shows it: confirm's answer carries TLV transport (§7.1),
 * fn 0's describe carries unit_id, transport, max_op_ms, discoverable and ops. -> what is missing (empty: nothing seen
 * missing).
 * @param {{ revision: number, transport: number | null }} limits confirm's answer (Host.limits)
 * @param {[number, Uint8Array][]} coreDescribe fn 0's describe TLVs @returns {string[]}
 */
export function requiredMissing(limits, coreDescribe) {
  const out = [];
  if (limits.revision >= 1 && limits.transport === null) out.push('confirm\'s transport TLV');
  const have = new Set(coreDescribe.map(([tag]) => tag & 0x7f));
  for (const [tag, name] of REQUIRED_CORE_TAGS) if (!have.has(tag)) out.push(`describe of fn 0: ${name}`);
  if (!have.has(m.TAG_OPS)) out.push('describe of fn 0: ops');   // every fn's describe carries it (core §1.2, §7.4)
  return out;
}

/** What an interface's document requires of its describe and `tlvs` lacks (oep.probe.restart: restart_max_ms) ->
 * the lines for `missing`. @param {catalog.ListEntry} entry @param {[number, Uint8Array][]} tlvs @returns {string[]} */
export function interfaceMissing(entry, tlvs) {
  const have = new Set(tlvs.map(([tag]) => tag & 0x7f));
  return (REQUIRED_TAGS[entry.name] ?? []).filter(([tag]) => !have.has(tag))
    .map(([, name]) => `describe of fn ${entry.fn} (${entry.name}): ${name}`);
}

/**
 * Every interface the probe lists under `prefix` (exact: that name only) with its describe, paged. No lock. The
 * confirm (when the host has none yet) asks as Host.confirm does: the revision in use once there is one (core §7.1,
 * C-15). fn 0 (the core, never listed) is described first, always: `core`. `missing`: what core §1.2 requires and the
 * probe did not give. An ops outside core §7.4's encoding shows as `unusable` on its row (fn 0's: the probe).
 * @param {import('./host.js').Host} hst @param {string} prefix @param {boolean} exact @returns {Promise<Capabilities>}
 */
export async function collect(hst, prefix = '', exact = false) {
  const had = hst.limits !== null;
  const limits = await hst.confirmed();
  const requests = { confirm: had ? 0 : 1, list: 0, describe: 0 };
  /** @param {number} fn */
  const describeAll = async (fn) => {
    /** @type {[number, Uint8Array][]} */
    const tlvs = [];
    for (;;) {
      const p = (await hst.request(m.CORE_FN, m.OP.describe, catalog.packDescribeRequest(fn, tlvs.length), { locked: false })).payload;
      requests.describe++;
      const page = m.splitTlvs(p.slice(1));
      tlvs.push(...page);
      if (!p[0] || !page.length) break;
    }
    return tlvs;
  };
  const coreTlvs = await describeAll(m.CORE_FN);
  /** @type {Capabilities} */
  const caps = { revision: limits.revision, maxFrame: limits.maxFrame, offers: [],
    core: { entry: { fn: m.CORE_FN, instance: 0, revision: limits.revision, flags: 0, name: '' },
      description: catalog.decodeDescription(coreTlvs), tlvs: coreTlvs },
    requests, missing: requiredMissing(limits, coreTlvs) };
  /** @type {catalog.ListEntry[]} */
  const entries = [];
  for (;;) {
    const r = await hst.request(m.CORE_FN, m.OP.list, catalog.packListRequest(prefix, exact, entries.length), { locked: false });
    requests.list++;
    const { total, entries: page } = catalog.unpackListResult(r.payload);
    entries.push(...page);
    if (!page.length || entries.length >= total) break;
  }
  for (const e of entries) hst.revisions.set(e.fn, e.revision);
  for (const entry of entries) {
    const tlvs = await describeAll(entry.fn);
    const description = catalog.decodeDescription(tlvs);
    caps.offers.push({ entry, description, tlvs });
    if (limits.revision >= 1 && description.ops === null) caps.missing.push(`describe of fn ${entry.fn}: ops`);
    caps.missing.push(...interfaceMissing(entry, tlvs));
  }
  return caps;
}

// ---- plain data -----------------------------------------------------------------------------------------------

/**
 * One interface as plain data (what JSON carries and what text renders).
 * @typedef {object} OfferRow
 * @property {number} fn
 * @property {number} instance
 * @property {string} name
 * @property {number} revision
 * @property {'oep' | 'local' | 'uuid' | 'domain'} namespace
 * @property {boolean} known                         this host has a table entry for the name
 * @property {string} [summary]
 * @property {Record<string, string>} [roles]        role name -> channel ranges ('0-2,5')
 * @property {Record<string, Record<string, number>>} [pinGroups]  group -> role name -> channel
 * @property {number} [maxClockHz]
 * @property {number} [minClockHz]
 * @property {number} [maxLength]
 * @property {string[]} [ops]                      the ops tag's ops by name (core §7.4)
 * @property {string[]} [features]
 * @property {string} [implementation]
 * @property {Record<string, string>} [declares]     interface-specific tags, decoded (a repeated tag: '; '-joined)
 * @property {string} [unusable]                     unknown critical tags
 */

/** @param {number} bits @param {Record<number, string>} names */
function features(bits, names) {
  /** @type {string[]} */
  const out = [];
  for (let b = 0; b < 32; b++) if ((bits >>> b) & 1) out.push(names[b] ?? `bit${b}`);
  return out;
}

/** One offer as plain data; fn 0 (caps.core, name '') as the core, with fn 0's tags and ops by name.
 * @param {Offer} o @returns {OfferRow} */
export function describeOffer(o) {
  const { name } = o.entry;
  const k = o.entry.fn === m.CORE_FN ? CORE_KNOWN : Object.hasOwn(KNOWN, name) ? KNOWN[name] : null;
  const d = o.description;
  /** @param {number} r */
  const role = (r) => k?.roles[r] ?? `role${r}`;
  /** @type {OfferRow} */
  const out = { fn: o.entry.fn, instance: o.entry.instance, name, revision: o.entry.revision, namespace: kind(name), known: k !== null };
  if (k) out.summary = k.summary;
  if (d.roles.size) {
    out.roles = {};
    for (const [r, ch] of [...d.roles].sort((a, b) => a[0] - b[0])) out.roles[role(r)] = ranges(ch);
  }
  if (d.groups.size) {
    out.pinGroups = {};
    for (const [g, pins] of [...d.groups].sort((a, b) => a[0] - b[0])) {
      out.pinGroups[String(g)] = Object.fromEntries(pins.map(([r, c]) => [role(r), c]));
    }
  }
  if (d.maxClockHz !== null) out.maxClockHz = d.maxClockHz;
  if (d.minClockHz !== null) out.minClockHz = d.minClockHz;
  if (d.maxLength !== null) out.maxLength = d.maxLength;
  if (d.ops !== null) out.ops = opNames(name, d.ops);
  if (d.features !== null) out.features = features(d.features, k?.features ?? {});
  if (d.implementation !== null) out.implementation = catalog.IMPLEMENTATIONS[d.implementation] ?? String(d.implementation);
  /** @type {Record<string, string>} */
  const specific = {};
  for (const [tag, value] of d.specific) {
    const entry = k?.tags[tag & 0x7f];
    const label = entry?.[0] ?? `tag 0x${tag.toString(16).padStart(2, '0')}`;
    let shown;
    try { shown = entry ? entry[1](value) : hex(value); } catch { shown = hex(value); }
    // a tag may repeat (one label per channel): keep every value
    specific[label] = Object.hasOwn(specific, label) ? `${specific[label]}; ${shown}` : shown;
  }
  if (Object.keys(specific).length) out.declares = specific;
  /** @type {string[]} */
  const unusable = [];
  if (d.opsInvalid) unusable.push(`${d.opsInvalid} (core §7.4)`);
  if (d.unknownCritical.length) unusable.push(`unknown critical tags ${d.unknownCritical.map((t) => `0x${t.toString(16)}`).join(', ')}`);
  if (unusable.length) out.unusable = unusable.join('; ');
  return out;
}

/** Everything collected as plain data (the shape `toJson` writes).
 * @param {Capabilities} caps */
export function toData(caps) {
  const { fn, ops, features, implementation, declares, unusable } = describeOffer(caps.core);
  return { revision: caps.revision, maxFrame: caps.maxFrame, requests: { ...caps.requests }, missingRequired: [...caps.missing],
    core: { fn, ops, features, implementation, declares, unusable }, interfaces: caps.offers.map(describeOffer) };
}

/** @param {Capabilities} caps */
export function toJson(caps) { return JSON.stringify(toData(caps), null, 2); }

// ---- text -----------------------------------------------------------------------------------------------------

/** 5000000 -> '5 MHz', 1000 -> '1 kHz', 611 -> '611 Hz'.
 * @param {number} v */
export function hz(v) {
  for (const [unit, div] of /** @type {[string, number][]} */ ([['MHz', 1_000_000], ['kHz', 1_000]])) {
    if (v >= div && v % (div / 1000) === 0) return `${Number((v / div).toPrecision(6))} ${unit}`;
  }
  return `${v} Hz`;
}

/** The lines of one row's declarations, each indented by `pad`. @param {OfferRow} r @param {string} pad */
function rowLines(r, pad) {
  const lines = [];
  if (r.summary) lines.push(`${pad}${r.summary}`);
  if (r.roles) {
    const width = Math.max(...Object.keys(r.roles).map((k) => k.length));
    for (const [role, chans] of Object.entries(r.roles)) lines.push(`${pad}  ${role.padEnd(width)}  channels ${chans}`);
  }
  for (const [g, pins] of Object.entries(r.pinGroups ?? {})) {
    lines.push(`${pad}  pin set ${g}: ${Object.entries(pins).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const limits = [];
  if (r.maxClockHz !== undefined) limits.push(`max ${hz(r.maxClockHz)}`);
  if (r.minClockHz !== undefined) limits.push(`min ${hz(r.minClockHz)}`);
  if (r.maxLength !== undefined) limits.push(`max length ${r.maxLength}`);
  if (limits.length) lines.push(`${pad}  ${limits.join(', ')}`);
  if (r.ops) lines.push(`${pad}  ops: ${r.ops.join(', ') || 'none'}`);
  if (r.features?.length) lines.push(`${pad}  features: ${r.features.join(', ')}`);
  if (r.implementation) lines.push(`${pad}  implementation: ${r.implementation}`);
  for (const [k, v] of Object.entries(r.declares ?? {})) lines.push(`${pad}  ${k}: ${v}`);
  if (r.unusable) lines.push(`${pad}  UNUSABLE: ${r.unusable}`);
  return lines;
}

/** The text `oep dump` prints: the core (fn 0, the probe itself) first, then one block per instance, its interfaces and
 * what they declare.
 * @param {Capabilities} caps */
export function toText(caps) {
  const rows = caps.offers.map(describeOffer);
  const lines = [`OEP revision ${caps.revision}, max frame ${caps.maxFrame} bytes; `
    + `${rows.length} interfaces in ${caps.requests.list} list and ${caps.requests.describe} describe requests`, ''];
  if (caps.missing?.length) lines.splice(1, 0, `MISSING what every probe must give (core §1.2, §7.4): ${caps.missing.join(', ')}`);
  const pad = ' '.repeat(14);
  lines.push(`core         fn 0   (no name; the probe itself)`, ...rowLines(describeOffer(caps.core), pad), '');
  /** @type {Map<number, OfferRow[]>} */
  const byInstance = new Map();
  for (const r of rows) byInstance.set(r.instance, [...(byInstance.get(r.instance) ?? []), r]);
  for (const [inst, group] of byInstance) {
    group.forEach((r, i) => {
      const head = i === 0 ? `instance ${String(inst).padEnd(3)}` : ' '.repeat(12);
      const tag = r.known ? '' : '   (not known to this host)';
      lines.push(`${head} fn ${String(r.fn).padEnd(3)} ${r.name}  rev ${r.revision}${tag}`);
    });
    for (const r of group) {
      if (group.length > 1) lines.push(`${pad}[${r.name}]`);
      lines.push(...rowLines(r, pad));
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
