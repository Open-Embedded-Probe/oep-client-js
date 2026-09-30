// @ts-check
// Collect a probe's declared capabilities (list + describe of every fn, paged) into plain objects, and render them as
// text (like `oep dump`) or JSON. Everything goes through a Host, so a web page can use it as it is.
//
//   const caps = await collect(hst);
//   caps.offers.map(describeOffer)     // plain data, one object per interface
//   toText(caps)                       // the text `oep dump` prints

import { hex } from './bytes.js';
import * as catalog from './catalog.js';
import * as m from './message.js';
import { KNOWN, ranges } from './interfaces.js';
import { kind } from './names.js';

/** @typedef {{ entry: catalog.ListEntry, description: catalog.Description, tlvs: [number, Uint8Array][] }} Offer */
/**
 * @typedef {object} Capabilities
 * @property {number} revision      the protocol revision confirm answered
 * @property {number} maxFrame
 * @property {Offer[]} offers
 * @property {{ confirm: number, list: number, describe: number }} requests   how many were sent
 */

/**
 * Every interface the probe lists under `prefix` (exact: that name only) with its describe, paged. No lock.
 * @param {import('./host.js').Host} hst @param {string} prefix @param {boolean} exact @returns {Promise<Capabilities>}
 */
export async function collect(hst, prefix = '', exact = false) {
  const had = hst.limits !== null;
  const limits = await hst.confirmed();
  /** @type {Capabilities} */
  const caps = { revision: limits.revision, maxFrame: limits.maxFrame, offers: [],
    requests: { confirm: had ? 0 : 1, list: 0, describe: 0 } };
  /** @type {catalog.ListEntry[]} */
  const entries = [];
  for (;;) {
    const r = await hst.request(m.CORE_FN, m.OP.list, catalog.packListRequest(prefix, exact, entries.length), { locked: false });
    caps.requests.list++;
    const { total, entries: page } = catalog.unpackListResult(r.payload);
    entries.push(...page);
    if (!page.length || entries.length >= total) break;
  }
  for (const e of entries) hst.revisions.set(e.fn, e.revision);
  for (const entry of entries) {
    /** @type {[number, Uint8Array][]} */
    const tlvs = [];
    for (;;) {
      const p = (await hst.request(m.CORE_FN, m.OP.describe, catalog.packDescribeRequest(entry.fn, tlvs.length), { locked: false })).payload;
      caps.requests.describe++;
      const page = m.splitTlvs(p.slice(1));
      tlvs.push(...page);
      if (!p[0] || !page.length) break;
    }
    caps.offers.push({ entry, description: catalog.decodeDescription(tlvs), tlvs });
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
 * @property {'standard' | 'local' | 'uuid' | 'domain'} namespace
 * @property {boolean} known                         this host has a table entry for the name
 * @property {string} [summary]
 * @property {Record<string, string>} [roles]        role name -> channel ranges ('0-2,5')
 * @property {Record<string, Record<string, number>>} [pinGroups]  group -> role name -> channel
 * @property {number} [maxClockHz]
 * @property {number} [minClockHz]
 * @property {number} [maxLength]
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

/** @param {Offer} o @returns {OfferRow} */
export function describeOffer(o) {
  const { name } = o.entry;
  const k = Object.hasOwn(KNOWN, name) ? KNOWN[name] : null;
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
  if (d.unknownCritical.length) out.unusable = `unknown critical tags ${d.unknownCritical.map((t) => `0x${t.toString(16)}`).join(', ')}`;
  return out;
}

/** Everything collected as plain data (the shape `toJson` writes).
 * @param {Capabilities} caps */
export function toData(caps) {
  return { revision: caps.revision, maxFrame: caps.maxFrame, requests: { ...caps.requests }, interfaces: caps.offers.map(describeOffer) };
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

/** The text `oep dump` prints: one block per instance, its interfaces and what they declare.
 * @param {Capabilities} caps */
export function toText(caps) {
  const rows = caps.offers.map(describeOffer);
  const lines = [`OEP revision ${caps.revision}, max frame ${caps.maxFrame} bytes; `
    + `${rows.length} interfaces in ${caps.requests.list} list and ${caps.requests.describe} describe requests`, ''];
  /** @type {Map<number, OfferRow[]>} */
  const byInstance = new Map();
  for (const r of rows) byInstance.set(r.instance, [...(byInstance.get(r.instance) ?? []), r]);
  const pad = ' '.repeat(14);
  for (const [inst, group] of byInstance) {
    group.forEach((r, i) => {
      const head = i === 0 ? `instance ${String(inst).padEnd(3)}` : ' '.repeat(12);
      const tag = r.known ? '' : '   (not known to this host)';
      lines.push(`${head} fn ${String(r.fn).padEnd(3)} ${r.name}  rev ${r.revision}${tag}`);
    });
    for (const r of group) {
      if (group.length > 1) lines.push(`${pad}[${r.name}]`);
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
      if (r.features?.length) lines.push(`${pad}  features: ${r.features.join(', ')}`);
      if (r.implementation) lines.push(`${pad}  implementation: ${r.implementation}`);
      for (const [k, v] of Object.entries(r.declares ?? {})) lines.push(`${pad}  ${k}: ${v}`);
      if (r.unusable) lines.push(`${pad}  UNUSABLE: ${r.unusable}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
