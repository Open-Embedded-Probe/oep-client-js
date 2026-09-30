// @ts-check
// oep.probe.config revision 1 (oep-spec docs/oep-if-probe-config.ja.md): the probe's settings - plan, labels, idle
// pins, slots, binds - read and set as items, saved when the host says so, and the live slot / bind state.
//
//   const cfg = await ProbeConfig.open(hst);
//   await cfg.set([new Slot({ slot: 0, wireFn, pins: [2, 54], name: 'x035', attach: 'at-boot', retryS: 1 }),
//                  new Bind({ port: 1, mode: 'last-reset', streams: [['slot', 0]] })]);
//   await cfg.save();
//   await cfg.items(), await cfg.state()
//
// An item goes as its TLV; one with only its key removes the item of that key (`remove`). A set replaces the keys it
// carries and keeps the others; the probe checks the whole and changes nothing on a refusal. `canonicalHash` computes
// what get's hash would be for a wanted set of items (probe.config §2), so a host can leave a probe that has it alone.

import * as reg from './registry.js';
import { Writer, concat, getU16, getU32, text, utf8 } from './bytes.js';
import * as m from './message.js';
import { Interface, describe } from './core.js';

const CFG = reg.PROBE_CONFIG;
export const ITEM = CFG.tlv.item;
export const DESCRIBE = CFG.tlv.describe;

/** @param {Record<string, number>} e */
const dashed = (e) => /** @type {Record<string, number>} */ (Object.fromEntries(Object.entries(e).map(([k, v]) => [k.replace(/_/g, '-'), v])));
/** @param {Record<string, number>} e */
const byValue = (e) => /** @type {Record<number, string>} */ (Object.fromEntries(Object.entries(e).map(([k, v]) => [v, k.replace(/_/g, '-')])));

export const ATTACH = dashed(CFG.enum.slot_attach);                 // host, at-boot
export const MODE = dashed(CFG.enum.bind_mode);                     // last-reset, manual, mixed
/** @type {Record<string, number>} */
export const STREAM = { slot: CFG.enum.bind_stream.slot_console, uart: CFG.enum.bind_stream.fixture_uart };
/** @type {Record<string, number>} */
export const MECHANISM = { ...reg.TARGET_CONSOLE.enum.mechanism };  // sdi, dmdata, dmseq
export const IDLE = dashed(CFG.enum.idle_mode);                     // hi-z, pull-up, pull-down
/** @type {Record<string, number>} */
export const IDLE_CLOCK = { ...reg.WIRE_RVSWD.enum.idle_clock };    // a slot's idle_clock (oep-if-debug §3)
export const SLOT_STATE = byValue(CFG.enum.slot_state);
export const BIND_FLOW = byValue(CFG.enum.bind_flow);
export const STORAGE_STATE = byValue(CFG.enum.storage_state);
/** Why a saved configuration was not applied (describe storage, last byte; probe.config §4). */
export const UNREADABLE = /** @type {Record<number, string>} */ ({
  1: 'unreadable form', 2: 'an interface it names is gone or of another revision', 3: 'refused when applied',
});

/** @param {Record<string, number>} table @param {number} value */
function nameOf(table, value) { return Object.keys(table).find((k) => table[k] === value) ?? String(value); }
/** @param {Record<string, number>} table @param {string} name @param {string} what */
function valueOf(table, name, what) {
  const v = table[name];
  if (v === undefined) throw new RangeError(`${what} ${name}: one of ${Object.keys(table).join(', ')}`);
  return v;
}

export class Plan {
  static TAG = ITEM.plan;
  /** @param {{ fn: number, role: number, channel: number }} o */
  constructor({ fn, role, channel }) { this.fn = fn; this.role = role; this.channel = channel; }
  value() { return new Writer().u16(this.fn).u8(this.role).u16(this.channel).done(); }
}

export class Label {
  static TAG = ITEM.label;
  /** @param {{ channel: number, text: string }} o */
  constructor({ channel, text }) { this.channel = channel; this.text = text; }
  value() { return new Writer().u16(this.channel).raw(utf8(this.text)).done(); }
}

export class Idle {
  static TAG = ITEM.idle;
  /** @param {{ channel: number, mode?: string }} o  mode: hi-z, pull-up (default), pull-down */
  constructor({ channel, mode = 'pull-up' }) { this.channel = channel; this.mode = mode; }
  value() { return new Writer().u16(this.channel).u8(valueOf(IDLE, this.mode, 'idle mode')).done(); }
}

/** @typedef {{ scheme: number, mask: Uint8Array, value: Uint8Array }} Lock  the target_id a connection must show */

/**
 * A place a target is wired to (probe.config §1.1). pins: [swdio, swclk], swclk 0xFFFF on one wire (swio).
 * lock: e.g. { scheme: 1, mask: u32 LE, value: u32 LE }.
 */
export class Slot {
  static TAG = ITEM.slot;
  /**
   * @param {{ slot: number, wireFn: number, pins: [number, number], name: string, attach?: string, retryS?: number,
   *   mechanism?: string, lock?: Lock | null, maxSpeed?: number, idleClock?: string }} o
   *   attach: host (default), at-boot; retryS: at-boot: try again every retryS while the target is not there (0: never);
   *   mechanism: sdi, dmdata, dmseq (default); maxSpeed: the line's ceiling in Hz for the probe's own attach (0: none);
   *   idleClock: rvswd: SWCLK while the line rests, high (default) / low
   */
  constructor({ slot, wireFn, pins, name, attach = 'host', retryS = 0, mechanism = 'dmseq', lock = null, maxSpeed = 0,
    idleClock = 'high' }) {
    this.slot = slot; this.wireFn = wireFn; this.pins = pins; this.name = name; this.attach = attach;
    this.retryS = retryS; this.mechanism = mechanism; this.lock = lock; this.maxSpeed = maxSpeed; this.idleClock = idleClock;
  }

  value() {
    const name = utf8(this.name);
    const w = new Writer().u8(this.slot).u16(this.wireFn).u16(this.pins[0]).u16(this.pins[1])
      .u8(valueOf(ATTACH, this.attach, 'attach')).u16(this.attach === 'at-boot' ? this.retryS : 0).u32(this.maxSpeed)
      .u8(valueOf(IDLE_CLOCK, this.idleClock, 'idle clock')).u8(valueOf(MECHANISM, this.mechanism, 'mechanism'))
      .u8(name.length).raw(name);
    if (this.lock === null) return w.u8(0).done();                   // lock_len 0: no lock
    const { scheme, mask, value } = this.lock;
    if (mask.length !== value.length || !mask.length || !scheme) {
      throw new RangeError('a lock has a scheme and a mask and value of the same length, at least 1 byte');
    }
    return w.u8(1 + 2 * mask.length).u8(scheme).raw(mask).raw(value).done();
  }
}

/**
 * What serial port `port` (the describe transport index) carries (probe.config §1.2). streams: ['slot', n] or
 * ['uart', fn]; selected: manual's choice (an index into streams).
 */
export class Bind {
  static TAG = ITEM.bind;
  /** @param {{ port: number, mode?: string, streams?: [string, number][], selected?: number }} o  mode: last-reset (default), manual, mixed */
  constructor({ port, mode = 'last-reset', streams = [], selected = 0 }) {
    this.port = port; this.mode = mode; this.streams = streams; this.selected = selected;
  }
  value() {
    const w = new Writer().u8(this.port).u8(valueOf(MODE, this.mode, 'bind mode')).u8(this.mode === 'manual' ? this.selected : 0)
      .u8(this.streams.length);
    for (const [kind, id] of this.streams) w.u8(valueOf(STREAM, kind, 'stream kind')).u16(id);
    return w.done();
  }
}

/** @typedef {Plan | Label | Idle | Slot | Bind} Item */
/** @typedef {{ tag: number, value: Uint8Array }} RawItem  an item of a tag this client does not know (or a malformed one) */

/** One item as its TLV.
 * @param {Item} it */
export function item(it) { return m.tlv(/** @type {any} */ (it.constructor).TAG, it.value()); }

/** The item that removes the item of this key: kind plan (key fn), label / idle (channel), slot, bind (port).
 * @param {'plan' | 'label' | 'idle' | 'slot' | 'bind'} kind @param {number} key */
export function remove(kind, key) {
  const tag = ITEM[kind];
  if (tag === undefined) throw new RangeError(`no item kind ${kind}`);
  return m.tlv(tag, kind === 'slot' || kind === 'bind' ? Uint8Array.of(key) : new Writer().u16(key).done());
}

/** One item as one of the classes above (an unknown tag or a value too short for its tag: { tag, value }).
 * @param {number} tag @param {Uint8Array} v @returns {Item | RawItem} */
export function decode(tag, v) {
  if (tag === ITEM.plan && v.length === 5) return new Plan({ fn: getU16(v), role: v[2], channel: getU16(v, 3) });
  if (tag === ITEM.label && v.length >= 2) return new Label({ channel: getU16(v), text: text(v.slice(2)) });
  if (tag === ITEM.idle && v.length === 3) return new Idle({ channel: getU16(v), mode: nameOf(IDLE, v[2]) });
  if (tag === ITEM.slot && v.length >= 18) {
    const nameLen = v[16];
    const name = text(v.slice(17, 17 + nameLen));
    const at = 17 + nameLen;
    const lockLen = at < v.length ? v[at] : 0;
    const part = v.slice(at + 1, at + 1 + lockLen);                 // after it: later fields (core §2.3), skipped
    let lock = null;
    if (lockLen >= 3 && part.length === lockLen) {
      const half = (lockLen - 1) >> 1;
      lock = { scheme: part[0], mask: part.slice(1, 1 + half), value: part.slice(1 + half, 1 + 2 * half) };
    }
    return new Slot({ slot: v[0], wireFn: getU16(v, 1), pins: [getU16(v, 3), getU16(v, 5)], name,
      attach: nameOf(ATTACH, v[7]), retryS: getU16(v, 8), maxSpeed: getU32(v, 10), idleClock: nameOf(IDLE_CLOCK, v[14]),
      mechanism: nameOf(MECHANISM, v[15]), lock });
  }
  if (tag === ITEM.bind && v.length >= 4) {
    const n = Math.min(v[3], Math.floor((v.length - 4) / 3));
    /** @type {[string, number][]} */
    const streams = Array.from({ length: n }, (_, k) => [nameOf(STREAM, v[4 + 3 * k]), getU16(v, 5 + 3 * k)]);
    return new Bind({ port: v[0], mode: nameOf(MODE, v[1]), streams, selected: v[2] });
  }
  return { tag, value: v };
}

// ---- the canonical form and its hash (probe.config §2) -------------------------------------------------------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE, as zlib.crc32; core §5.2).
 * @param {Uint8Array} data */
export function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {number} tag */
const keyLen = (tag) => (tag === ITEM.slot || tag === ITEM.bind ? 1 : 2);

/**
 * The items (objects, or item TLV bytes - one or more TLVs each) in the canonical order: tag ascending, then key
 * ascending (plan by (fn, role)), critical bit dropped. Key-only items (removals) are left out; the same key twice
 * throws, as the probe refuses it in one set.
 * @param {(Item | Uint8Array)[]} items @returns {[number, Uint8Array][]}
 */
export function canonical(items) {
  /** @type {{ tag: number, key: number[], value: Uint8Array }[]} */
  const rows = [];
  const seen = new Set();
  for (const it of items) {
    /** @type {[number, Uint8Array][]} */
    const tlvs = it instanceof Uint8Array ? m.splitTlvs(it) : [[/** @type {any} */ (it.constructor).TAG, it.value()]];
    for (const [rawTag, value] of tlvs) {
      const tag = rawTag & 0x7f;
      const n = keyLen(tag);
      if (value.length < n) throw new RangeError(`item 0x${tag.toString(16)}: shorter than its key`);
      if (value.length === n) continue;                              // the key alone: a removal
      const key = n === 1 ? [value[0]] : [getU16(value)];
      if (tag === ITEM.plan) key.push(value[2]);
      const id = `${tag}:${key.join(',')}`;
      if (seen.has(id)) throw new RangeError(`item 0x${tag.toString(16)} key ${key.join(',')} given twice`);
      seen.add(id);
      rows.push({ tag, key, value });
    }
  }
  rows.sort((a, b) => a.tag - b.tag || a.key[0] - b.key[0] || (a.key[1] ?? 0) - (b.key[1] ?? 0));
  return rows.map((r) => [r.tag, r.value]);
}

/** get's hash for a configuration of exactly these items: CRC-32 over the canonical TLVs (probe.config §2).
 * @param {(Item | Uint8Array)[]} items */
export function canonicalHash(items) {
  return crc32(concat(...canonical(items).map(([tag, v]) => m.tlv(tag, v))));
}

// ---- state -----------------------------------------------------------------------------------------------------

/**
 * @typedef {object} SlotState
 * @property {number} slot
 * @property {string} state              connected, absent, lock-mismatch, no-target-id
 * @property {number} connection         0: none
 * @property {number | null} lastTryMs   since the last automatic attach (null: never tried)
 * @property {number} targetIdScheme     0: none
 * @property {Uint8Array | null} targetId
 */
/**
 * @typedef {object} BindState
 * @property {number} port
 * @property {string} mode
 * @property {number | null} selected    null in mixed
 * @property {string} flow               idle, streaming, held
 */
/**
 * @typedef {object} State
 * @property {number} storageBytes       0: no storage
 * @property {string} storage            none, applied, unreadable
 * @property {number} savedHash
 * @property {number | null} saveMaxMs   the longest a save takes
 * @property {number} unreadableReason   0 none, 1 form, 2 an interface gone / of another revision, 3 refused
 * @property {string | null} unreadable  why, when unreadable (probe.config §4)
 * @property {number[]} items            the item tags the probe takes
 * @property {number} slotsMax
 * @property {string[]} bindModes
 * @property {SlotState[]} slots
 * @property {BindState[]} binds
 */

export class ProbeConfig extends Interface {
  static NAME = CFG.name;
  static REVISION = CFG.revision;
  static GET = CFG.op.get;
  static SET = CFG.op.set;
  static SAVE = CFG.op.save;
  static ERASE = CFG.op.erase;

  /** The hash and the items as [tag, value] in the canonical order, paged. No lock.
   * @returns {Promise<{ hash: number, items: [number, Uint8Array][] }>} */
  async get() {
    /** @type {[number, Uint8Array][]} */
    const items = [];
    for (;;) {
      const p = (await this.call(ProbeConfig.GET, new Writer().u16(items.length).done(), { locked: false })).payload;
      const rd = new m.Reader(p);
      const more = rd.u8(), hash = rd.u32();
      const page = m.splitTlvs(rd.rest());
      items.push(...page);
      if (!more || !page.length) return { hash, items };
    }
  }

  /** The current settings, decoded (Plan, Label, Idle, Slot, Bind; { tag, value } for others). */
  async items() { return (await this.get()).items.map(([t, v]) => decode(t, v)); }

  /** Items (objects of the classes above, or item TLV bytes such as remove()) -> the new hash. Needs the lock.
   * @param {(Item | Uint8Array)[]} items */
  async set(items) {
    const body = concat(...items.map((it) => (it instanceof Uint8Array ? it : item(it))));
    return new m.Reader((await this.call(ProbeConfig.SET, body)).payload).u32();
  }

  /** Save the current settings -> their hash. Needs the lock. */
  async save() { return new m.Reader((await this.call(ProbeConfig.SAVE)).payload).u32(); }

  /** Erase what is saved (the current settings stay). Needs the lock. */
  async erase() { await this.call(ProbeConfig.ERASE); }

  /** storage, the items taken, slots_max, bind modes, and the live slot_state / bind_state (lock-free).
   * @returns {Promise<State>} */
  async state() {
    /** @type {State} */
    const st = { storageBytes: 0, storage: 'none', savedHash: 0, saveMaxMs: null, unreadableReason: 0, unreadable: null,
      items: [], slotsMax: 0, bindModes: [], slots: [], binds: [] };
    for (const [rawTag, v] of await describe(this.host, this.fn)) {
      const tag = rawTag & 0x7f;
      if (tag === DESCRIBE.storage && v.length >= 9) {
        st.storageBytes = getU32(v);
        st.storage = STORAGE_STATE[v[4]] ?? String(v[4]);
        st.savedHash = getU32(v, 5);
        if (v.length >= 13) st.saveMaxMs = getU32(v, 9);
        if (v.length >= 14 && v[13]) {
          st.unreadableReason = v[13];
          st.unreadable = UNREADABLE[v[13]] ?? String(v[13]);
        }
      } else if (tag === DESCRIBE.items) st.items = [...v];
      else if (tag === DESCRIBE.slots_max && v.length) st.slotsMax = v[0];
      else if (tag === DESCRIBE.bind_modes && v.length) st.bindModes = Object.keys(MODE).filter((k) => (v[0] >> MODE[k]) & 1);
      else if (tag === DESCRIBE.slot_state && v.length >= 10) {
        const age = getU32(v, 4), tlen = v[9];
        const tid = v.slice(10, 10 + tlen);
        st.slots.push({ slot: v[0], state: SLOT_STATE[v[1]] ?? String(v[1]), connection: getU16(v, 2),
          lastTryMs: age === 0xffffffff ? null : age, targetIdScheme: v[8], targetId: tid.length ? tid : null });
      } else if (tag === DESCRIBE.bind_state && v.length >= 4) {
        st.binds.push({ port: v[0], mode: nameOf(MODE, v[1]), selected: v[2] === 0xff ? null : v[2],
          flow: BIND_FLOW[v[3]] ?? String(v[3]) });
      }
    }
    return st;
  }
}
