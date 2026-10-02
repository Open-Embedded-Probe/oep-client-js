// @ts-check
// oep.probe.config revision 1 (oep-spec docs/oep-if-probe-config.ja.md): the probe's settings - plan, labels, idle
// pins, slots, binds, fixture UART settings, disabled channels - read and set as items, removed with unset, saved when the host says so,
// and the live slot / bind / storage state as its own lock-free operation (describe is declarations only, core §7.3).
//
//   const cfg = await ProbeConfig.open(hst);
//   await cfg.set([new Slot({ slot: 0, wireFn, pins: [2, 54], name: 'x035', attach: 'at-boot', retryS: 1 }),
//                  new Bind({ port: 1, mode: 'last-reset', streams: [['slot', 0]] })]);
//   await cfg.save();
//   await cfg.items(), await cfg.describe(), await cfg.state()
//   await cfg.unset([['bind', 1]])          // or cfg.set([remove('bind', 1)])
//
// An item goes as its TLV; a set replaces the keys it carries and keeps the others; the probe checks the whole and
// changes nothing on a refusal. The probe keeps each item's bytes as sent and hashes the canonical form (tag order,
// key order, the one TLV encoding): `canonicalHash` computes the same value here, so a host can leave a probe that
// has what it wants alone.

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
export const MECHANISM = { ...reg.TARGET_CONSOLE.enum.mechanism };  // sdi, dmdata, dmseq, none (0xFF: no console)
export const IDLE = dashed(CFG.enum.idle_mode);                     // hi-z, pull-up, pull-down, output-low, output-high
/** @type {Record<string, number>} */
export const IDLE_CLOCK = { ...reg.WIRE_RVSWD.enum.idle_clock };    // a slot's idle_clock (oep-if-debug §3)
export const SLOT_STATE = byValue(CFG.enum.slot_state);
export const BIND_FLOW = byValue(CFG.enum.bind_flow);
export const STORAGE_STATE = byValue(CFG.enum.storage_state);
/** Why a saved configuration was not applied (state's unreadable_reason; probe.config §3.3). */
export const UNREADABLE = /** @type {Record<number, string>} */ ({
  1: 'unreadable form', 2: 'an interface it names is gone or of another revision', 3: 'refused when applied',
});
/** last_try_at_ns: never tried */
export const NEVER_NS = 0xffffffffffffffffn;
/** slot wire_fn swdio swclk attach retry_ms max_speed_hz idle_clock mechanism name_len: the slot's head (§1.1) */
export const SLOT_HEAD = 19;

/** @param {Record<string, number>} table @param {number} value */
function nameOf(table, value) { return Object.keys(table).find((k) => table[k] === value) ?? String(value); }
/** @param {Record<string, number>} table @param {string} name @param {string} what */
function valueOf(table, name, what) {
  const v = table[name];
  if (v === undefined) throw new RangeError(`${what} ${name}: one of ${Object.keys(table).join(', ')}`);
  return v;
}

/** One plan assignment (key (fn, role, channel); the items of one fn make its plan). */
export class Plan {
  static TAG = ITEM.plan;
  /** @param {{ fn: number, role: number, channel: number }} o */
  constructor({ fn, role, channel }) { this.fn = fn; this.role = role; this.channel = channel; }
  key() { return [this.fn, this.role, this.channel]; }
  value() { return new Writer().u16(this.fn).u8(this.role).u16(this.channel).done(); }
}

/** A channel's name given by the settings (the firmware's fixed labels are oep.core's describe). */
export class Label {
  static TAG = ITEM.label;
  /** @param {{ channel: number, text: string }} o */
  constructor({ channel, text }) { this.channel = channel; this.text = text; }
  key() { return [this.channel]; }
  value() { return new Writer().u16(this.channel).raw(utf8(this.text)).done(); }
}

/**
 * The state of a channel no plan or connection uses (probe.config §1): at boot and after every release. An output mode
 * keeps driving that level while the channel is free (a target's power switch kept on), and a gpio plan that takes the
 * channel keeps it until its first set (fixture §1); a probe that cannot drive the channel refuses it unsupported.
 */
export class Idle {
  static TAG = ITEM.idle;
  /** @param {{ channel: number, mode?: string }} o  mode: hi-z, pull-up (default), pull-down, output-low, output-high
   *   (output_low / output_high too: underscores become hyphens) */
  constructor({ channel, mode = 'pull-up' }) { this.channel = channel; this.mode = mode.replace(/_/g, '-'); }
  key() { return [this.channel]; }
  value() { return new Writer().u16(this.channel).u8(valueOf(IDLE, this.mode, 'idle mode')).done(); }
}

/**
 * A fixture UART's baud and format (probe.config §1, item 0x06): applied whenever that fn's plan gets RX or TX (a
 * session's configure wins until the plan is released). format: fixture.FixtureUart.formatByte().
 */
export class Uart {
  static TAG = ITEM.uart;
  /** @param {{ fn: number, baud: number, format?: number }} o */
  constructor({ fn, baud, format = 0 }) { this.fn = fn; this.baud = baud; this.format = format; }
  key() { return [this.fn]; }
  value() { return new Writer().u16(this.fn).u32(this.baud).u8(this.format).done(); }
}

/**
 * A channel the probe never uses or touches (probe.config §1, item 0x07): not on this board, or wired to another part.
 * Any request naming it is refused unavailable (cause 5, held by settings); describe still declares it.
 */
export class Disable {
  static TAG = ITEM.disable;
  /** @param {{ channel: number }} o */
  constructor({ channel }) { this.channel = channel; }
  key() { return [this.channel]; }
  value() { return new Writer().u16(this.channel).done(); }
}

/** @typedef {{ scheme: number, mask: Uint8Array, value: Uint8Array }} Lock  the target_id a connection must show */

/**
 * A place a target is wired to (probe.config §1.1). pins: [swdio, swclk], swclk 0xFFFF on one wire (swio).
 * lock: e.g. { scheme: 1, mask: u32 LE, value: u32 LE }; mask and value are as long as the scheme's value (4 bytes for
 * scheme 1). retryS goes on the wire as retry_ms (u32), maxSpeed as max_speed_hz (u32).
 */
export class Slot {
  static TAG = ITEM.slot;
  /**
   * @param {{ slot: number, wireFn: number, pins: [number, number], name: string, attach?: string, retryS?: number,
   *   mechanism?: string, lock?: Lock | null, maxSpeed?: number, idleClock?: string }} o
   *   attach: host (default), at-boot; retryS: at-boot: try again every retryS seconds while the target is not there
   *   (0: never); mechanism: sdi, dmdata, dmseq (default), none (no console on this slot); maxSpeed: the line's ceiling
   *   in Hz for the probe's own attach (0: none); idleClock: rvswd: SWCLK while the line rests, high (default) / low
   */
  constructor({ slot, wireFn, pins, name, attach = 'host', retryS = 0, mechanism = 'dmseq', lock = null, maxSpeed = 0,
    idleClock = 'high' }) {
    this.slot = slot; this.wireFn = wireFn; this.pins = pins; this.name = name; this.attach = attach;
    this.retryS = retryS; this.mechanism = mechanism; this.lock = lock; this.maxSpeed = maxSpeed; this.idleClock = idleClock;
  }

  key() { return [this.slot]; }

  value() {
    const name = utf8(this.name);
    const retryMs = this.attach === 'at-boot' ? Math.round(this.retryS * 1000) : 0;
    const w = new Writer().u8(this.slot).u16(this.wireFn).u16(this.pins[0]).u16(this.pins[1])
      .u8(valueOf(ATTACH, this.attach, 'attach')).u32(retryMs).u32(this.maxSpeed)
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
  key() { return [this.port]; }
  value() {
    const w = new Writer().u8(this.port).u8(valueOf(MODE, this.mode, 'bind mode')).u8(this.mode === 'manual' ? this.selected : 0)
      .u8(this.streams.length);
    for (const [kind, id] of this.streams) w.u8(3).u8(valueOf(STREAM, kind, 'stream kind')).u16(id);   // len, kind, id
    return w.done();
  }
}

/** @typedef {Plan | Label | Idle | Slot | Bind | Uart | Disable} Item */
/** @typedef {{ tag: number, value: Uint8Array }} RawItem  an item of a tag this client does not know (or a malformed one) */
/** @typedef {'plan' | 'label' | 'idle' | 'slot' | 'bind' | 'uart' | 'disable'} ItemKind */

/** One item as its TLV.
 * @param {Item} it */
export function item(it) { return m.tlv(/** @type {any} */ (it.constructor).TAG, it.value()); }

/** What `remove()` makes: one key for unset (op 0x05). `ProbeConfig.set()` sends these as an unset after its set. */
export class Removal {
  /** @param {ItemKind} kind @param {number} key */
  constructor(kind, key) { this.kind = kind; this.key = key; }
  /** len(u8) tag(u8) key: the key is fn(u16) for plan / uart, channel(u16) for label / idle / disable, slot(u8), port(u8). */
  encoded() {
    const key = this.kind === 'slot' || this.kind === 'bind' ? Uint8Array.of(this.key) : new Writer().u16(this.key).done();
    return new Writer().u8(1 + key.length).u8(ITEM[this.kind]).raw(key).done();
  }
}

/** The removal of the item of this key (for `unset`, or in a `set` list): kind plan (key fn: its whole plan), label /
 * idle / disable (channel), slot, bind (port), uart (fn).
 * @param {ItemKind} kind @param {number} key */
export function remove(kind, key) {
  if (ITEM[kind] === undefined) throw new RangeError(`no item kind ${kind}`);
  return new Removal(kind, key);
}

/** One item as one of the classes above (an unknown tag or a value too short for its tag: { tag, value }). Bytes after
 * the known fields are a later revision's: skipped (core §2.3).
 * @param {number} tag @param {Uint8Array} v @returns {Item | RawItem} */
export function decode(tag, v) {
  if (tag === ITEM.plan && v.length >= 5) return new Plan({ fn: getU16(v), role: v[2], channel: getU16(v, 3) });
  if (tag === ITEM.label && v.length >= 2) return new Label({ channel: getU16(v), text: text(v.slice(2)) });
  if (tag === ITEM.idle && v.length >= 3) return new Idle({ channel: getU16(v), mode: nameOf(IDLE, v[2]) });
  if (tag === ITEM.slot && v.length >= SLOT_HEAD + 1) {
    const nameLen = v[SLOT_HEAD - 1];
    const name = text(v.slice(SLOT_HEAD, SLOT_HEAD + nameLen));
    const at = SLOT_HEAD + nameLen;
    const lockLen = at < v.length ? v[at] : 0;
    const part = v.slice(at + 1, at + 1 + lockLen);                 // after it: later fields (core §2.3), skipped
    let lock = null;
    if (lockLen >= 3 && part.length === lockLen) {
      const half = (lockLen - 1) >> 1;
      lock = { scheme: part[0], mask: part.slice(1, 1 + half), value: part.slice(1 + half, 1 + 2 * half) };
    }
    return new Slot({ slot: v[0], wireFn: getU16(v, 1), pins: [getU16(v, 3), getU16(v, 5)], name,
      attach: nameOf(ATTACH, v[7]), retryS: getU32(v, 8) / 1000, maxSpeed: getU32(v, 12), idleClock: nameOf(IDLE_CLOCK, v[16]),
      mechanism: nameOf(MECHANISM, v[17]), lock });
  }
  if (tag === ITEM.disable && v.length >= 2) return new Disable({ channel: getU16(v) });
  if (tag === ITEM.uart && v.length >= 7) return new Uart({ fn: getU16(v), baud: getU32(v, 2), format: v[6] });
  if (tag === ITEM.bind && v.length >= 4) {
    /** @type {[string, number][]} */
    const streams = [];
    for (let k = 0, at = 4; k < v[3]; k++, at += 1 + v[at]) {   // n × (len, kind, id): a longer one's tail skipped
      if (at >= v.length || v[at] < 3 || at + 1 + v[at] > v.length) return { tag, value: v };
      streams.push([nameOf(STREAM, v[at + 1]), getU16(v, at + 2)]);
    }
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

/** The canonical order's key of one item (probe.config §2): plan (fn, role, channel), label / idle / disable channel,
 * slot, port, uart fn. @param {number} tag @param {Uint8Array} value */
function sortKey(tag, value) {
  if (tag === ITEM.plan && value.length >= 5) return [getU16(value), value[2], getU16(value, 3)];
  if (tag === ITEM.slot || tag === ITEM.bind) return value.length ? [value[0]] : [-1];
  return value.length >= 2 ? [getU16(value)] : [-1];
}

/**
 * The items (objects, or item TLV bytes - one or more TLVs each) in the canonical order: tag ascending, then key
 * ascending (plan by (fn, role, channel)), critical bit dropped. The same key twice throws, as the probe refuses it in
 * one set; a Removal is not an item (it goes as an unset) and throws too.
 * @param {(Item | Uint8Array)[]} items @returns {[number, Uint8Array][]}
 */
export function canonical(items) {
  /** @type {{ tag: number, key: number[], value: Uint8Array }[]} */
  const rows = [];
  const seen = new Set();
  for (const it of items) {
    if (it instanceof Removal) throw new RangeError('a removal is not an item of the configuration (unset sends it)');
    /** @type {[number, Uint8Array][]} */
    const tlvs = it instanceof Uint8Array ? m.splitTlvs(it) : [[/** @type {any} */ (it.constructor).TAG, it.value()]];
    for (const [rawTag, value] of tlvs) {
      const tag = rawTag & 0x7f;
      const key = sortKey(tag, value);
      const id = `${tag}:${key.join(',')}`;
      if (seen.has(id)) throw new RangeError(`item 0x${tag.toString(16)} key ${key.join(',')} given twice`);
      seen.add(id);
      rows.push({ tag, key, value });
    }
  }
  rows.sort((a, b) => a.tag - b.tag || a.key[0] - b.key[0] || (a.key[1] ?? 0) - (b.key[1] ?? 0) || (a.key[2] ?? 0) - (b.key[2] ?? 0));
  return rows.map((r) => [r.tag, r.value]);
}

/** get's hash for a configuration of exactly these items: CRC-32 over the canonical TLVs, in the one encoding of core
 * §2.2 (probe.config §2). @param {(Item | Uint8Array)[]} items */
export function canonicalHash(items) {
  return crc32(concat(...canonical(items).map(([tag, v]) => m.tlv(tag, v))));
}

// ---- declarations and state --------------------------------------------------------------------------------------

/**
 * @typedef {object} SlotState
 * @property {number} slot
 * @property {string} state              connected, absent, lock-mismatch, no-target-id
 * @property {number} connection         0: none
 * @property {bigint | null} lastTryAtNs the probe's clock when it last tried an automatic attach (null: never tried)
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
 * What the probe's describe declares (fixed for one boot): the storage's size, the item tags it takes, how many slots,
 * the bind modes.
 * @typedef {object} Declared
 * @property {number} storageBytes       max_bytes of the canonical form; 0: no storage
 * @property {number[]} items            the item tags the probe takes
 * @property {number} slotsMax
 * @property {string[]} bindModes
 */
/**
 * The live state (op state, lock-free; probe.config §3.3): the saved settings and the slots and binds.
 * @typedef {object} State
 * @property {string} storage            none, applied, unreadable
 * @property {number} savedHash          the saved settings' hash, as applied to this boot's fns (0: none / unreadable)
 * @property {number} unreadableReason   0 none, 1 form, 2 an interface gone / of another revision, 3 refused
 * @property {string | null} unreadable  why, when unreadable
 * @property {SlotState[]} slots
 * @property {BindState[]} binds
 */

/** A save writes the probe's flash: the link waits at least this for its answer (Host.request expectMs). */
export const SAVE_EXPECT_MS = 2000;

export class ProbeConfig extends Interface {
  static NAME = CFG.name;
  static REVISION = CFG.revision;
  static GET = CFG.op.get;
  static SET = CFG.op.set;
  static SAVE = CFG.op.save;
  static ERASE = CFG.op.erase;
  static UNSET = CFG.op.unset;
  static STATE = CFG.op.state;

  /** The hash and the items as [tag, value] in the canonical order, paged. No lock. Every page carries the same hash;
   * when it changes between pages the probe's settings moved and the read starts over.
   * @returns {Promise<{ hash: number, items: [number, Uint8Array][] }>} */
  async get() {
    outer: for (;;) {
      /** @type {[number, Uint8Array][]} */
      const items = [];
      /** @type {number | null} */
      let first = null;
      for (;;) {
        const rd = new m.Reader((await this.call(ProbeConfig.GET, new Writer().u16(items.length).done(), { locked: false })).payload);
        const more = rd.u8(), hash = rd.u32();
        const page = m.splitTlvs(rd.rest());
        if (first === null) first = hash;
        else if (hash !== first) continue outer;                     // changed under us: again from the start
        items.push(...page);
        if (!more || !page.length) return { hash, items };
      }
    }
  }

  /** The current settings, decoded (Plan, Label, Idle, Slot, Bind, Uart, Disable; { tag, value } for others). */
  async items() { return (await this.get()).items.map(([t, v]) => decode(t, v)); }

  /** Items (objects of the classes above, or item TLV bytes) -> the new hash. Removals (`remove()`) in the list go as
   * an unset after the set (two requests; each is atomic by itself). Needs the lock.
   * @param {(Item | Removal | Uint8Array)[]} items */
  async set(items) {
    const removals = /** @type {Removal[]} */ (items.filter((it) => it instanceof Removal));
    const rest = /** @type {(Item | Uint8Array)[]} */ (items.filter((it) => !(it instanceof Removal)));
    let hash = 0;
    if (rest.length || !removals.length) {
      const body = concat(...rest.map((it) => (it instanceof Uint8Array ? it : item(it))));
      hash = ProbeConfig.hashAnswer(await this.call(ProbeConfig.SET, body));
    }
    if (removals.length) hash = await this.unset(removals.map((r) => /** @type {[ItemKind, number]} */ ([r.kind, r.key])));
    return hash;
  }

  /** Remove the items of these [kind, key] (probe.config §2 unset): a key that is not there is nothing; the whole must
   * still be consistent or nothing changes. -> the new hash. Needs the lock.
   * @param {[ItemKind, number][]} keys */
  async unset(keys) {
    const body = concat(Uint8Array.of(keys.length), ...keys.map(([kind, key]) => new Removal(kind, key).encoded()));
    return ProbeConfig.hashAnswer(await this.call(ProbeConfig.UNSET, body));
  }

  /** @param {m.Result} r */
  static hashAnswer(r) {
    const rd = new m.Reader(r.payload);
    const hash = rd.u32();
    rd.tail();
    return hash;
  }

  /** Save the current settings (a probe with storage; the whole is replaced) -> the hash saved. Needs the lock. */
  async save() { return ProbeConfig.hashAnswer(await this.call(ProbeConfig.SAVE, undefined, { expectMs: SAVE_EXPECT_MS })); }

  /** Erase what is saved (the current settings stay). Needs the lock. */
  async erase() { await this.call(ProbeConfig.ERASE); }

  /** The declarations (describe, cached by the host while the probe's boot_id holds). @returns {Promise<Declared>} */
  async describe() {
    /** @type {Declared} */
    const d = { storageBytes: 0, items: [], slotsMax: 0, bindModes: [] };
    for (const [rawTag, v] of await describe(this.host, this.fn)) {
      const tag = rawTag & 0x7f;
      if (tag === DESCRIBE.storage && v.length >= 4) d.storageBytes = getU32(v);
      else if (tag === DESCRIBE.items) d.items = [...v];
      else if (tag === DESCRIBE.slots_max && v.length) d.slotsMax = v[0];
      else if (tag === DESCRIBE.bind_modes && v.length >= 4) {
        const bits = getU32(v);
        d.bindModes = Object.keys(MODE).filter((k) => (bits >>> MODE[k]) & 1);
      }
    }
    return d;
  }

  /** The storage's state and the live slot_state / bind_state (op state, lock-free, paged by first_slot / first_bind).
   * @returns {Promise<State>} */
  async state() {
    /** @type {State} */
    const st = { storage: 'none', savedHash: 0, unreadableReason: 0, unreadable: null, slots: [], binds: [] };
    let firstSlot = 0, firstBind = 0;
    for (;;) {
      const rd = new m.Reader((await this.call(ProbeConfig.STATE, Uint8Array.of(firstSlot, firstBind), { locked: false })).payload);
      const more = rd.u8(), storage = rd.u8();
      st.savedHash = rd.u32();
      const why = rd.u8();
      st.storage = STORAGE_STATE[storage] ?? String(storage);
      st.unreadableReason = why;
      st.unreadable = why ? (UNREADABLE[why] ?? String(why)) : null;
      const nSlots = rd.u8();
      for (let i = 0; i < nSlots; i++) {
        const e = rd.element();
        const slot = e.u8(), state = e.u8(), connection = e.u16(), tried = e.u64(), scheme = e.u8(), tid = e.bytes(e.u8());
        st.slots.push({ slot, state: SLOT_STATE[state] ?? String(state), connection, lastTryAtNs: tried === NEVER_NS ? null : tried,
          targetIdScheme: scheme, targetId: tid.length ? tid : null });
      }
      const nBinds = rd.u8();
      for (let i = 0; i < nBinds; i++) {
        const e = rd.element();
        const port = e.u8(), mode = e.u8(), sel = e.u8(), flow = e.u8();
        st.binds.push({ port, mode: nameOf(MODE, mode), selected: sel === 0xff ? null : sel, flow: BIND_FLOW[flow] ?? String(flow) });
      }
      rd.tail();
      if (!more || !(nSlots || nBinds)) return st;
      firstSlot += nSlots;
      firstBind += nBinds;
    }
  }
}

/** The label names of a target's power and reset lines (host-development-guide §8.1): `nrst` its reset, `power_hi`
 * high powers it, `power_lo` low powers it. On a probe with several slots they are `<slot name>.<name>`. */
export const LINE_NAMES = Object.freeze(['nrst', 'power_hi', 'power_lo']);

/** findLine could not tell which channel is meant; `candidates` holds [label text, channel]. */
export class AmbiguousLine extends Error {
  /** @param {string} message @param {[string, number][]} candidates */
  constructor(message, candidates) { super(message); this.name = 'AmbiguousLine'; this.candidates = candidates; }
}

/**
 * The channel labelled for `name` (nrst, power_hi, power_lo: host-development-guide §8.1), or null when there is none.
 * hstOrItems: a Host (its settings are read: ProbeConfig items, no lock) or the decoded items. slot: the slot's name or
 * number; omitted, the probe's one slot.
 *
 * `<slot>.<name>` first, then the bare `name` - the bare name only while the settings hold at most one slot (a bare name
 * is for a one-slot probe). With several slots and no slot, or two channels with the same label, it throws
 * AmbiguousLine listing the candidates.
 * @param {import('./host.js').Host | (Item | { tag: number, value: Uint8Array })[]} hstOrItems
 * @param {string} name @param {number | string | null} [slot]
 * @returns {Promise<number | null>}
 */
export async function findLine(hstOrItems, name, slot = null) {
  const items = Array.isArray(hstOrItems) ? hstOrItems : await (await ProbeConfig.open(hstOrItems)).items();
  /** @type {[string, number][]} */
  const labels = items.filter((i) => i instanceof Label).map((i) => [/** @type {Label} */ (i).text, /** @type {Label} */ (i).channel]);
  const slots = /** @type {Slot[]} */ (items.filter((i) => i instanceof Slot));
  if (typeof slot === 'number') {
    const named = slots.find((s) => s.slot === slot);
    if (!named) throw new RangeError(`no slot ${slot} in the probe's settings`);
    slot = named.name;
  }
  /** @param {[string, number]} a @param {[string, number]} b */
  const order = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
  if (slot == null && slots.length > 1) {
    const candidates = labels.filter(([t]) => t === name || t.endsWith(`.${name}`)).sort(order);
    if (candidates.length) {
      const listed = candidates.map(([t, c]) => `${t} (channel ${c})`).join(', ');
      throw new AmbiguousLine(`${name}: ${slots.length} slots and no slot given; candidates: ${listed}`, candidates);
    }
    return null;
  }
  if (slot == null && slots.length) slot = slots[0].name;
  const texts = [...(slot != null ? [`${slot}.${name}`] : []), ...(slots.length <= 1 ? [name] : [])];
  for (const t of texts) {
    const found = labels.filter(([x]) => x === t).map(([, c]) => c).sort((a, b) => a - b);
    if (found.length > 1) throw new AmbiguousLine(`${t}: on ${found.length} channels`, found.map((c) => [t, c]));
    if (found.length) return found[0];
  }
  return null;
}
