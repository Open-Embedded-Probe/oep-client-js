// @ts-check
// The probe's settings (oep-spec oep-core §13) and their file (oep-client-python docs/oep-settings-file.ja.md).
//
// The core gathers the settings; each item belongs to an owner - the core (fn 0) or an interface (its fn) - that
// declares it in its describe (setting, setting_choice). fn 0's ops read and write them: get / set / unset (save / state
// with storage, network with the network items). A value is (fn, item number, key) on the wire for one boot; its names
// - the category (`core` or `name/instance`), the flat name (the item's name with the key's name in place of `{}`) and
// the value with references as names - are what a host keeps, shows and writes to a file.
//
//   const st = new Settings(hst);
//   await st.show();                                     // [{ category, name, value, origin }]
//   await st.setNamed('core', { 'channel.GPIO14.label': 'NRST', 'channel.GPIO14.idle': 'pull_up' });
//   await st.save();
//   const doc = await st.export();                       // the settings file (JSON), the user's values only
//   const plan = await st.planImport(doc); await st.applyImport(plan);
//
// Secrets (core §13.5) are never read: get gives no data, the file a { secret: true }.

import * as reg from './registry.js';
import { Writer, concat, equal, fromHex, getU16, getU32, hex, text, utf8 } from './bytes.js';
import * as m from './message.js';
import { describe, listEntries, maxOpMs, offers, require } from './core.js';

const C = reg.CORE;
/** fn 0's settings ops. */
export const OP = Object.freeze({ get: C.op.get, set: C.op.set, unset: C.op.unset, save: C.op.save, state: C.op.state, network: C.op.network });
/** @param {Record<string, number>} e @returns {Record<number, string>} */
const byValue = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [v, k]));
export const FORM = byValue(C.enum.setting_form);
export const KEY_KIND = byValue(C.enum.setting_key_kind);
export const ORIGIN = byValue(C.enum.setting_origin);
export const SECRET = C.enum.setting_flag.secret;
export const STORAGE_STATE = byValue(C.enum.storage_state);
export const STORAGE_REASON = byValue(C.enum.storage_reason);
export const NET_STATE = byValue(C.enum.network_state);
export const NET_REASON = byValue(C.enum.network_reason);
/** A transport kind's short name in a route's name (core §13.3). */
export const ROUTE = byValue(C.enum.route_kind);
const D = C.tlv.describe;
const SETTING = reg.DESCRIBE_COMMON.setting, SETTING_CHOICE = reg.DESCRIBE_COMMON.setting_choice;
const VALUE_HEADER = 8;                                             // fn number key origin len (core §13.5)
/** A network's entry when none is tried or used (op network). */
export const NO_ENTRY = 0xffff;
/** The settings file's form (oep_settings). */
export const FILE_VERSION = 1;
export const CORE_CATEGORY = 'core';
/** The label item (host guide §5.3). */
export const LABEL = 'channel.{}.label';

/** One item as its owner declares it (core §13.2). */
export class Item {
  /** @param {number} fn @param {number} number @param {string} name @param {string} form @param {string} keyKind
   * @param {number} keys @param {number} maxLen @param {number} flags */
  constructor(fn, number, name, form, keyKind, keys, maxLen, flags) {
    this.fn = fn; this.number = number; this.name = name; this.form = form; this.keyKind = keyKind;
    this.keys = keys; this.maxLen = maxLen; this.flags = flags;
    /** @type {Map<number, string>} */ this.choices = new Map();
  }
  get secret() { return (this.flags & SECRET) !== 0; }
}

/** One value as get gives it. @typedef {{ fn: number, number: number, key: number, origin: string, data: Uint8Array }} Value */
/** The storage's state (op state, lock-free; core §13.7). @typedef {{ storage: string, savedGeneration: number, reason: string | null }} State */
/**
 * One netif (op network): state off / connecting / up / waiting, the wifi entry (null: none), the last failure's
 * reason, rssi (dBm, while up on Wi-Fi; else 0), and the address in use ("a.b.c.d/prefix").
 * @typedef {{ netif: string, state: string, entry: number | null, reason: string, rssi: number, address: string | null,
 *   gateway: string | null, dns: string | null }} NetifState
 */
/** @typedef {{ tcpPort: number, netifs: NetifState[] }} Network  tcpPort 0: not listening */
/** @typedef {[number, number, number, Uint8Array]} SetRow  fn, number, key, data */
/** @typedef {[number, number, number]} KeyRow  fn, number, key */
/**
 * What an import does (settings file §4): the values to set and unset (wire rows), the secrets the probe has no value
 * for, and the members that do not resolve on this probe.
 * @typedef {{ sets: SetRow[], unsets: KeyRow[], secretWithoutValue: [string, string][], unresolved: [string, string][],
 *   otherProbe: boolean }} ImportPlan
 */

/** "a.b.c.d" -> 4 bytes (RangeError when it is not one). @param {unknown} s */
function ipBytes(s) {
  const parts = typeof s === 'string' ? s.split('.') : [];
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && +p <= 255)) throw new RangeError(`${JSON.stringify(s)}: not an IPv4 address`);
  return Uint8Array.from(parts.map(Number));
}
/** @param {Uint8Array} b */
const ipText = (b) => Array.from(b.slice(0, 4)).join('.');

/**
 * The names of one probe for one boot (core §13.3): each fn's category and items, the channels', routes' and netifs'
 * names. Built from the probe's describes (`Settings.catalog`), or from TLVs.
 */
export class Catalog {
  /** @param {[number, Uint8Array][]} fn0 @param {{ fn: number, name: string, instance: number, tlvs: [number, Uint8Array][] }[]} interfaces */
  constructor(fn0, interfaces = []) {
    /** @type {Map<number, string>} */ this.category = new Map([[m.CORE_FN, CORE_CATEGORY]]);
    /** @type {Map<number, Item[]>} */ this.items = new Map([[m.CORE_FN, Catalog.itemsOf(m.CORE_FN, fn0)]]);
    for (const { fn, name, instance, tlvs } of interfaces) {
      this.category.set(fn, `${name}/${instance}`);
      this.items.set(fn, Catalog.itemsOf(fn, tlvs));
    }
    /** @type {Map<number, string>} */ this.channel = new Map();
    for (const [tag, v] of fn0) if (tag === D.channel_name && v.length >= 2) this.channel.set(getU16(v), text(v.slice(2)));
    /** @type {Map<number, number>} */
    const kinds = new Map();
    for (const [tag, v] of fn0) if (tag === D.transport && v.length >= 2 && !kinds.has(v[0])) kinds.set(v[0], v[1]);
    /** @type {Map<number, string>} */ this.route = new Map();
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (const index of [...kinds.keys()].sort((a, b) => a - b)) {
      const kind = /** @type {number} */ (kinds.get(index)), short = ROUTE[kind] ?? `kind${kind}`;
      this.route.set(index, `${short}${seen.get(short) ?? 0}`);
      seen.set(short, (seen.get(short) ?? 0) + 1);
    }
    /** @type {Map<number, string>} */ this.netif = new Map();
    for (const [tag, v] of fn0) if (tag === D.netif) this.netif.set(this.netif.size + 1, text(v));
    /** model, unitId, firmware (each when the probe gives it). @type {Record<string, string>} */ this.probe = {};
    for (const [k, tag] of /** @type {[string, number][]} */ ([['model', D.model], ['unitId', D.unit_id], ['firmware', D.firmware]])) {
      const v = fn0.find(([t]) => t === tag)?.[1];
      if (v) this.probe[k] = text(v);
    }
  }

  /** @param {number} fn @param {[number, Uint8Array][]} tlvs @returns {Item[]} */
  static itemsOf(fn, tlvs) {
    /** @type {Item[]} */
    const out = [];
    for (const [tag, v] of tlvs) {
      if (tag === SETTING && v.length >= 6) {
        out.push(new Item(fn, out.length + 1, text(v.slice(6)), FORM[v[0]] ?? String(v[0]), KEY_KIND[v[1]] ?? String(v[1]),
          getU16(v, 2), v[4], v[5]));
      } else if (tag === SETTING_CHOICE && v.length >= 2 && v[0] >= 1 && v[0] <= out.length) {
        out[v[0] - 1].choices.set(v[1], text(v.slice(2)));
      }
    }
    return out;
  }

  /** @param {number} fn @param {number} number @returns {Item | null} */
  item(fn, number) { return this.items.get(fn)?.[number - 1] ?? null; }

  /** @param {string} category @returns {number | null} */
  fnOf(category) {
    for (const [fn, c] of this.category) if (c === category) return fn;
    return null;
  }

  /** @param {string} kind */
  table(kind) { return kind === 'channel' ? this.channel : kind === 'transport' ? this.route : kind === 'netif' ? this.netif : new Map(); }

  // -- names (core §13.3) --
  /** @param {Item} it @param {number} key @returns {string | null} */
  keyName(it, key) {
    if (it.keyKind === 'none') return null;
    if (it.keyKind === 'index') return String(key);
    return this.table(it.keyKind).get(key) ?? null;
  }

  /** @param {Item} it @param {string} name @returns {number | null} */
  keyOf(it, name) {
    if (it.keyKind === 'index') return /^\d+$/.test(name) && +name < it.keys ? +name : null;
    for (const [k, n] of this.table(it.keyKind)) if (n === name) return k;
    return null;
  }

  /** @param {Item} it @param {number} key @returns {string | null} */
  flat(it, key) {
    if (it.keyKind === 'none') return it.name;
    const name = this.keyName(it, key);
    return name === null ? null : it.name.replace('{}', name);
  }

  /** The item and key a flat name names (settings file §2.2): exactly one item, else null.
   * @param {string} category @param {string} flat @returns {[Item, number] | null} */
  resolve(category, flat) {
    const fn = this.fnOf(category);
    if (fn === null) return null;
    /** @type {[Item, number][]} */
    const found = [];
    for (const it of this.items.get(fn) ?? []) {
      if (it.keyKind === 'none') {
        if (flat === it.name) found.push([it, 0]);
        continue;
      }
      const at = it.name.indexOf('{}');
      const head = it.name.slice(0, at), tail = it.name.slice(at + 2);
      if (flat.startsWith(head) && flat.endsWith(tail) && flat.length > head.length + tail.length) {
        const key = this.keyOf(it, flat.slice(head.length, flat.length - tail.length));
        if (key !== null) found.push([it, key]);
      }
    }
    return found.length === 1 ? found[0] : null;
  }

  /** A value as the file writes it (settings file §2.3). @param {Item} it @param {Uint8Array} data @returns {unknown} */
  toJson(it, data) {
    switch (it.form) {
      case 'text': return text(data);
      case 'u32': return getU32(data);
      case 'ipv4': return ipText(data);
      case 'bool': return data[0] !== 0;
      case 'enum': return it.choices.get(data[0]) ?? data[0];
      case 'channel': return this.channel.get(getU16(data)) ?? getU16(data);
      case 'transport': return this.route.get(data[0]) ?? data[0];
      case 'fn': return this.category.get(getU16(data)) ?? getU16(data);
      default: return hex(data);
    }
  }

  /** The wire's data of a file value (RangeError: not this item's form, or a name this probe does not have).
   * @param {Item} it @param {unknown} value @returns {Uint8Array} */
  fromJson(it, value) {
    /** @param {Map<number, string>} table @returns {number | undefined} */
    const back = (table) => { for (const [k, v] of table) if (v === value) return k; return undefined; };
    const fail = () => new RangeError(`${JSON.stringify(value)} is not a value of ${it.name} (${it.form})`);
    /** @type {number | undefined} */
    let n;
    switch (it.form) {
      case 'bytes':
        if (typeof value !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(value)) throw fail();
        return fromHex(value);
      case 'text':
        if (typeof value !== 'string') throw fail();
        return utf8(value);
      case 'u32':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) throw fail();
        return new Writer().u32(value).done();
      case 'ipv4':
        try { return ipBytes(value); } catch { throw fail(); }
      case 'bool':
        if (typeof value !== 'boolean') throw fail();
        return Uint8Array.of(value ? 1 : 0);
      case 'enum': n = back(it.choices); if (n === undefined) throw fail(); return Uint8Array.of(n);
      case 'channel': n = back(this.channel); if (n === undefined) throw fail(); return new Writer().u16(n).done();
      case 'transport': n = back(this.route); if (n === undefined) throw fail(); return Uint8Array.of(n);
      case 'fn': n = back(this.category); if (n === undefined) throw fail(); return new Writer().u16(n).done();
      default: throw fail();
    }
  }

  /** A command line's or a form's text as the file's JSON value of this item. @param {Item} it @param {string} s */
  textValue(it, s) {
    if (it.form === 'u32') {
      const v = Number(s);
      if (!Number.isInteger(v)) throw new RangeError(`${JSON.stringify(s)}: a number`);
      return v;
    }
    if (it.form === 'bool') {
      const t = s.toLowerCase();
      if (!['true', 'false', '1', '0', 'on', 'off'].includes(t)) throw new RangeError(`${JSON.stringify(s)}: true or false`);
      return ['true', '1', 'on'].includes(t);
    }
    return s;
  }
}

/** count values (fn number key origin len data) from get's answer, then the answer's own TLV tail.
 * @param {Uint8Array} data @param {number} count @returns {[Value[], Uint8Array]} */
export function splitValues(data, count) {
  /** @type {Value[]} */
  const out = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + VALUE_HEADER > data.length) throw new m.ProtocolError('get: a value past the answer');
    const n = getU16(data, at + 6);
    if (at + VALUE_HEADER + n > data.length) throw new m.ProtocolError('get: a value\'s data past the answer');
    out.push({ fn: getU16(data, at), number: data[at + 2], key: getU16(data, at + 3), origin: ORIGIN[data[at + 5]] ?? String(data[at + 5]),
      data: data.slice(at + VALUE_HEADER, at + VALUE_HEADER + n) });
    at += VALUE_HEADER + n;
  }
  return [out, data.slice(at)];
}

/** @param {m.Result} r */
function generationOf(r) {
  const rd = new m.Reader(r.payload);
  const generation = rd.u32();
  rd.tail();
  return generation;
}

/** fn 0's settings ops on a host (core §13). */
export class Settings {
  /** @param {import('./host.js').Host} hst */
  constructor(hst) { this.host = hst; }

  /** The names (describe of fn 0 and of every listed fn, cached by the host while its boot_id holds). */
  async catalog() {
    const listed = await listEntries(this.host);
    const interfaces = [];
    for (const e of listed) interfaces.push({ fn: e.fn, name: e.name, instance: e.instance, tlvs: await describe(this.host, e.fn) });
    return new Catalog(await describe(this.host, m.CORE_FN), interfaces);
  }

  /** @param {keyof typeof OP} op */
  offers(op) { return offers(this.host, m.CORE_FN, OP[op]); }

  /** @param {keyof typeof OP} op @param {Uint8Array} [body] @param {{ locked?: boolean, expectMs?: number }} [opts] */
  async call(op, body = new Uint8Array(), opts = {}) {
    await require(this.host, m.CORE_FN, OP[op]);
    return this.host.call(m.CORE_FN, OP[op], body, opts);
  }

  // -- the ops --
  /** -> the generation and every value in get's order, paged. No lock. When the generation changes between pages the
   * settings moved: the read starts over. @returns {Promise<{ generation: number, values: Value[] }>} */
  async get() {
    outer: for (;;) {
      /** @type {Value[]} */
      const values = [];
      /** @type {number | null} */
      let first = null;
      for (;;) {
        const rd = new m.Reader((await this.call('get', new Writer().u16(values.length).done(), { locked: false })).payload);
        const more = rd.u8(), generation = rd.u32(), count = rd.u8();
        const [page, tail] = splitValues(rd.rest(), count);
        m.Tail.parse(tail);                                          // the answer's own TLV tail, not values
        if (first === null) first = generation;
        else if (generation !== first) continue outer;               // changed under us: again from the start
        values.push(...page);
        if (!more || !page.length) return { generation, values };
      }
    }
  }

  /** Rows in requests that each fit max_frame (a set or unset of more values goes as several, each atomic).
   * @param {Uint8Array[]} rows */
  async batches(rows) {
    const limit = (await this.host.confirmed()).maxFrame - m.REQUEST_HEADER - 1;
    /** @type {Uint8Array[][]} */
    const out = [];
    /** @type {Uint8Array[]} */
    let cur = [];
    let size = 0;
    for (const r of rows) {
      if (cur.length && (size + r.length > limit || cur.length === 255)) {
        out.push(cur);
        cur = []; size = 0;
      }
      cur.push(r);
      size += r.length;
    }
    if (cur.length) out.push(cur);
    return out.length ? out : [[]];
  }

  /** [fn, number, key, data] rows -> the new generation. Needs the lock. @param {SetRow[]} values */
  async set(values) {
    let generation = 0;
    const rows = values.map(([fn, n, k, d]) => concat(new Writer().u16(fn).u8(n).u16(k).u16(d.length).done(), d));
    for (const batch of await this.batches(rows)) generation = generationOf(await this.call('set', concat(Uint8Array.of(batch.length), ...batch)));
    return generation;
  }

  /** [fn, number, key]: each back to its default, or no value (core §13.4). -> the new generation. Needs the lock.
   * @param {KeyRow[]} keys */
  async unset(keys) {
    let generation = 0;
    const rows = keys.map(([fn, n, k]) => new Writer().u16(fn).u8(n).u16(k).done());
    for (const batch of await this.batches(rows)) generation = generationOf(await this.call('unset', concat(Uint8Array.of(batch.length), ...batch)));
    return generation;
  }

  /** Save the user's values (a probe with storage). -> the current generation (completed failed throws: `state` says
   * what is kept). Needs the lock. Its argument time is max_op_ms (core §13.7). */
  async save() { return generationOf(await this.call('save', undefined, { expectMs: await maxOpMs(this.host) })); }

  /** The storage's state (op state, lock-free). @returns {Promise<State>} */
  async state() {
    const rd = new m.Reader((await this.call('state', undefined, { locked: false })).payload);
    const storage = rd.u8(), savedGeneration = rd.u32(), why = rd.u8();
    rd.tail();
    return { storage: STORAGE_STATE[storage] ?? String(storage), savedGeneration, reason: why ? (STORAGE_REASON[why] ?? String(why)) : null };
  }

  /** Whether a save would change what is stored (host guide §15 step 4): not when the storage is applied and its
   * saved_generation is the current generation (get's). */
  async needsSave() {
    const st = await this.state();
    return !(st.storage === 'applied' && st.savedGeneration === (await this.get()).generation);
  }

  /** The network now (op network, lock-free): the TCP port and each netif's state. @returns {Promise<Network>} */
  async network() {
    const netifs = (await this.catalog()).netif;
    const rd = new m.Reader((await this.call('network', undefined, { locked: false })).payload);
    const tcpPort = rd.u16(), count = rd.u8();
    /** @type {NetifState[]} */
    const out = [];
    for (let i = 0; i < count; i++) {
      const netif = rd.u8(), state = rd.u8(), entry = rd.u16(), reason = rd.u8(), rssiByte = rd.u8();
      const addr = rd.bytes(4), prefix = rd.u8(), gw = rd.bytes(4), dns = rd.bytes(4);
      /** @param {Uint8Array} b */
      const ip = (b) => (b.some((x) => x) ? ipText(b) : null);
      out.push({ netif: netifs.get(netif) ?? String(netif), state: NET_STATE[state] ?? String(state),
        entry: entry === NO_ENTRY ? null : entry, reason: NET_REASON[reason] ?? String(reason),
        rssi: rssiByte >= 0x80 ? rssiByte - 0x100 : rssiByte, address: ip(addr) ? `${ip(addr)}/${prefix}` : null,
        gateway: ip(gw), dns: ip(dns) });
    }
    rd.tail();
    return { tcpPort, netifs: out };
  }

  // -- by name --
  /** Every value as { category, name (flat), value, origin }; a secret's value is { secret: true }.
   * @returns {Promise<{ category: string, name: string, value: unknown, origin: string, item: Item }[]>} */
  async show() {
    const cat = await this.catalog();
    const out = [];
    for (const v of (await this.get()).values) {
      const it = cat.item(v.fn, v.number);
      if (!it) continue;
      out.push({ category: cat.category.get(v.fn) ?? String(v.fn), name: cat.flat(it, v.key) ?? `${it.name}#${v.key}`,
        value: it.secret ? { secret: true } : cat.toJson(it, v.data), origin: v.origin, item: it });
    }
    return out;
  }

  /** @param {Catalog} cat @param {string} category @param {string} flat */
  static named(cat, category, flat) {
    const got = cat.resolve(category, flat);
    if (!got) throw new RangeError(`${category}: no item ${JSON.stringify(flat)} on this probe`);
    return got;
  }

  /** Values by flat name (JSON values, or text from a form) in one category. Needs the lock.
   * @param {string} category @param {Record<string, unknown>} values */
  async setNamed(category, values) {
    const cat = await this.catalog();
    /** @type {SetRow[]} */
    const rows = [];
    for (const [flat, value] of Object.entries(values)) {
      const [it, key] = Settings.named(cat, category, flat);
      const v = typeof value === 'string' && (it.form === 'u32' || it.form === 'bool') ? cat.textValue(it, value) : value;
      rows.push([it.fn, it.number, key, cat.fromJson(it, v)]);
    }
    return this.set(rows);
  }

  /** @param {string} category @param {string[]} flats */
  async unsetNamed(category, flats) {
    const cat = await this.catalog();
    return this.unset(flats.map((flat) => {
      const [it, key] = Settings.named(cat, category, flat);
      return /** @type {KeyRow} */ ([it.fn, it.number, key]);
    }));
  }

  /** Every user value back to its default or none (then save to empty the storage: core §13.7). null: there was none. */
  async unsetAll() {
    const users = (await this.get()).values.filter((v) => v.origin === 'user').map((v) => /** @type {KeyRow} */ ([v.fn, v.number, v.key]));
    return users.length ? this.unset(users) : null;
  }

  // -- the file (settings file §3, §4) --
  async export() { return exportFile(await this.catalog(), (await this.get()).values); }

  /** @param {unknown} doc */
  async planImport(doc) { return planImport(await this.catalog(), (await this.get()).values, doc); }

  /** Unset first (a disable that replaces an idle), then set. Needs the lock. @param {ImportPlan} plan */
  async applyImport(plan) {
    /** @type {number | null} */
    let generation = null;
    if (plan.unsets.length) generation = await this.unset(plan.unsets);
    if (plan.sets.length) generation = await this.set(plan.sets);
    return generation;
  }
}

/** The settings file of the user's values (settings file §3). @param {Catalog} cat @param {Value[]} values */
export function exportFile(cat, values) {
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {};
  for (const v of values) {
    if (v.origin !== 'user') continue;                               // fixed and default stay with the firmware
    const it = cat.item(v.fn, v.number);
    const flat = it ? cat.flat(it, v.key) : null;
    if (!it || flat === null) continue;
    const category = cat.category.get(v.fn) ?? String(v.fn);
    (out[category] ??= {})[flat] = it.secret ? { secret: true } : cat.toJson(it, v.data);
  }
  const probe = Object.fromEntries(Object.entries(cat.probe).map(([k, v]) => [k === 'unitId' ? 'unit_id' : k, v]));
  return { oep_settings: FILE_VERSION, probe, settings: out };
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file's form (settings file §2): RangeError when it is not one this host reads. @param {unknown} doc
 * @returns {asserts doc is { oep_settings: number, probe?: Record<string, unknown>, settings: Record<string, Record<string, unknown>> }} */
export function checkFile(doc) {
  if (!isObject(doc) || doc.oep_settings !== FILE_VERSION) throw new RangeError(`not a settings file of version ${FILE_VERSION}`);
  if (!isObject(doc.settings) || !Object.values(doc.settings).every(isObject)) {
    throw new RangeError('settings: an object of categories, each an object of values');
  }
}

/** What making the file's user values the probe's takes (settings file §4).
 * @param {Catalog} cat @param {Value[]} current @param {unknown} doc @returns {ImportPlan} */
export function planImport(cat, current, doc) {
  checkFile(doc);
  /** @type {ImportPlan} */
  const plan = { sets: [], unsets: [], secretWithoutValue: [], unresolved: [], otherProbe: false };
  const probe = isObject(doc.probe) ? doc.probe : {};
  const mine = /** @type {Record<string, string | undefined>} */ ({ unit_id: cat.probe.unitId, model: cat.probe.model });
  plan.otherProbe = ['unit_id', 'model'].some((k) => probe[k] !== undefined && probe[k] !== null && probe[k] !== mine[k]);
  /** @param {number} fn @param {number} n @param {number} k */
  const id = (fn, n, k) => `${fn}/${n}/${k}`;
  const have = new Map(current.map((v) => [id(v.fn, v.number, v.key), v]));
  const wanted = new Set();
  for (const [category, members] of Object.entries(doc.settings)) {
    for (const [flat, value] of Object.entries(members)) {
      const got = cat.resolve(category, flat);
      if (!got) { plan.unresolved.push([category, flat]); continue; }
      const [it, key] = got;
      wanted.add(id(it.fn, it.number, key));
      if (it.secret) {
        if (!have.has(id(it.fn, it.number, key))) plan.secretWithoutValue.push([category, flat]);
        continue;
      }
      let data;
      try { data = cat.fromJson(it, value); } catch { plan.unresolved.push([category, flat]); continue; }
      const now = have.get(id(it.fn, it.number, key));
      if (!now || now.origin !== 'user' || !equal(now.data, data)) plan.sets.push([it.fn, it.number, key, data]);
    }
  }
  plan.unsets = current.filter((v) => v.origin === 'user' && !wanted.has(id(v.fn, v.number, v.key)))
    .map((v) => /** @type {KeyRow} */ ([v.fn, v.number, v.key]));
  return plan;
}

// ---- the label convention (host guide §5.3) ---------------------------------------------------------------
/** The line names of the label convention, the registry's standard names: `nrst` a target's reset, `power_hi` high
 * powers it, `power_lo` low powers it, and the debug / UART lines. With several targets, `<port>.<name>`. */
export const LINE_NAMES = Object.freeze(Object.keys(C.line_names));

/** ASCII case folded (only A-Z: the convention compares ignoring ASCII case). @param {string} s */
export function foldName(s) { return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)); }

/** The ports the labels name (host guide §5.3): the distinct S of the "S.N" labels, folded, in order.
 * @param {Iterable<[number, string]>} labels */
export function portsNamed(labels) {
  /** @type {string[]} */
  const out = [];
  for (const [, t] of labels) {
    const dot = t.indexOf('.');
    if (dot > 0 && dot < t.length - 1 && !out.includes(foldName(t.slice(0, dot)))) out.push(foldName(t.slice(0, dot)));
  }
  return out;
}

/**
 * Host guide §5.3 on bare data: labels as [channel, text] - every channel.{}.label value, whatever its origin. In
 * order, stopping at the first step that finds exactly one channel: (a) with a port name (`profile`), a label equal to
 * `<port>.<name>`; (b) only while at most one port is named (`single`; by default from the labels), a label equal to
 * `name`. A step that finds two or more ends the search with none. Texts compare ignoring ASCII case.
 * @param {Iterable<[number, string]>} labels @param {string} name
 * @param {{ profile?: string | null, single?: boolean | null }} [opts] @returns {number | null}
 */
export function lineFromLabels(labels, name, { profile = null, single = null } = {}) {
  const all = [...labels];
  const one = single ?? portsNamed(all).length <= 1;
  const steps = [...(profile !== null && profile !== undefined ? [`${profile}.${name}`] : []), ...(one ? [name] : [])];
  for (const t of steps) {
    const want = foldName(t);
    const found = new Set(all.filter(([, x]) => foldName(x) === want).map(([ch]) => ch));
    if (found.size > 1) return null;                                 // ambiguous at this step: no such line
    if (found.size) return [...found][0];
  }
  return null;
}

/** Every channel label now (channel.{}.label, fixed / default / user) as [channel, text]. A probe without the settings
 * ops: none. @param {import('./host.js').Host} hst @param {string | null} [origin] only the labels of this origin
 * @returns {Promise<[number, string][]>} */
export async function labels(hst, origin = null) {
  if (!await offers(hst, m.CORE_FN, OP.get)) return [];
  const st = new Settings(hst);
  const cat = await st.catalog();
  return (await st.get()).values.filter((v) => v.fn === m.CORE_FN && cat.item(v.fn, v.number)?.name === LABEL
    && (origin === null || v.origin === origin)).map((v) => [v.key, m.shown(v.data)]);
}

/**
 * The channel of the line `name` (LINE_NAMES) by the label convention (host guide §5.3), or null. source: a Host (its
 * labels read with get, no lock) or labels as [channel, text].
 * @param {import('./host.js').Host | Iterable<[number, string]>} source @param {string} name
 * @param {{ profile?: string | null, single?: boolean | null }} [opts] @returns {Promise<number | null>}
 */
export async function findLine(source, name, opts = {}) {
  const found = Symbol.iterator in Object(source) ? [.../** @type {Iterable<[number, string]>} */ (source)]
    : await labels(/** @type {import('./host.js').Host} */ (source));
  return lineFromLabels(found, name, opts);
}
