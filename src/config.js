// @ts-check
// oep.probe.config revision 1 (oep-spec interfaces/oep-if-probe-config.ja.md): the probe's settings - plan, labels, idle
// pins, slots, binds, fixture UART settings, disabled channels, Wi-Fi networks (the passphrase write-only) - read and set
// as items, removed with unset, saved when the host says so, and the live slot / bind / storage / Wi-Fi state as its own
// lock-free operation (describe is declarations only, core §7.3).
//
//   const cfg = await ProbeConfig.open(hst);
//   await cfg.set([new Slot({ slot: 0, wireFn, pins: [2, 54], name: 'x035', attach: 'at-boot', retryS: 1 }),
//                  new Bind({ port: 1, stream: ['slot', 0] })]);
//   if (await cfg.needsSave()) await cfg.save();
//   await cfg.items(), await cfg.describe(), await cfg.state()
//   await cfg.unset([['bind', 1]])          // or cfg.set([remove('bind', 1)])
//   await cfg.set([new Wifi({ index: 0, ssid: 'lab', passphrase })])   // the passphrase is never read back or shown
//
// An item goes as its TLV; a set replaces the keys it carries and keeps the others; the probe checks the whole and
// changes nothing on a refusal. Every item has one form per tag (probe.config §1). The hash is the probe's own u32
// that changes with the settings (probe.config §2): a host never computes it - it compares the items themselves
// (`sameItems`, host guide §15) and uses the hash to see whether the settings moved (get's pages, storage_hash against
// get's hash). `apply(wanted, { save })` leaves a probe that has what it wants alone.

import * as reg from './registry.js';
import { Writer, concat, getU16, getU32, text, utf8 } from './bytes.js';
import * as m from './message.js';
import { Interface, describe, firmwareLabels, maxOpMs } from './core.js';
import { Drive } from './fixture.js';

const CFG = reg.PROBE_CONFIG;
export const ITEM = CFG.tlv.item;
/** A label's text: 1 to this many bytes (probe.config §1). */
export const LABEL_MAX = reg.LIMITS.label_max_bytes;
export const DESCRIBE = CFG.tlv.describe;
/** The state answer's TLVs: wifi (probe.config §3.3). */
export const STATE_TLV = CFG.tlv.state_answer;
/** Items keyed by their first byte (slot, port, index); the others by a u16 (probe.config §2). */
const BYTE_KEYED = [ITEM.slot, ITEM.bind, ITEM.wifi];
/** A wifi item's ssid: 1 to this many bytes (probe.config §1.4). */
export const SSID_MAX = reg.LIMITS.wifi_ssid_max_bytes;
/** A wifi passphrase: PASS_MIN to PASS_MAX bytes of 0x20-0x7E, or PSK_HEX hex digits (probe.config §1.4). */
export const PASS_MIN = reg.LIMITS.wifi_passphrase_min_bytes;
export const PASS_MAX = reg.LIMITS.wifi_passphrase_max_bytes;
export const PSK_HEX = reg.LIMITS.wifi_psk_hex_digits;
/** A probe with the wifi item answers max_frame at least this on every transport: one set of the longest wifi item
 * (probe.config §1.4). */
export const WIFI_MIN_MAX_FRAME = reg.LIMITS.wifi_min_max_frame;
/** pass_len in get: a passphrase is set (none follows); in a set: keep the entry's. */
export const PASS_SET = CFG.enum.wifi_pass_len.hidden;

/** @param {Record<string, number>} e */
const dashed = (e) => /** @type {Record<string, number>} */ (Object.fromEntries(Object.entries(e).map(([k, v]) => [k.replace(/_/g, '-'), v])));
/** @param {Record<string, number>} e */
const byValue = (e) => /** @type {Record<number, string>} */ (Object.fromEntries(Object.entries(e).map(([k, v]) => [v, k.replace(/_/g, '-')])));

export const ATTACH = dashed(CFG.enum.slot_attach);                 // host, at-boot
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
export const WIFI_STATE = byValue(CFG.enum.wifi_state);             // off, connecting, connected, waiting
export const WIFI_REASON = byValue(CFG.enum.wifi_reason);           // none, not-found, auth, no-address, other
/** The wifi state's entry when no entry is tried or used. */
export const NO_ENTRY = CFG.enum.wifi_entry.none;
/** Why a saved configuration was not applied (state's unreadable_reason; probe.config §3.3). */
export const UNREADABLE = /** @type {Record<number, string>} */ ({
  1: 'unreadable form', 2: 'an interface it names is gone or of another revision', 3: 'refused when applied',
});
/** last_try_at_ns: never tried */
export const NEVER_NS = 0xffffffffffffffffn;
/** slot wire_fn swdio swclk attach retry_ms max_speed_hz idle_clock mechanism name_len: the slot's head, then the name
 * (§1.1) */
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

/** A channel's name given by the settings (the firmware's fixed labels are fn 0's describe). */
export class Label {
  static TAG = ITEM.label;
  /** @param {{ channel: number, text: string }} o */
  constructor({ channel, text }) { this.channel = channel; this.text = text; }
  key() { return [this.channel]; }
  value() {
    const raw = utf8(this.text);
    if (raw.length < 1 || raw.length > LABEL_MAX || !m.validText(raw)) {
      // probe.config §1: 1 to 32 bytes (the probe refuses other lengths); this host sends no control characters
      throw new RangeError(`label ${JSON.stringify(this.text)}: 1 to ${LABEL_MAX} bytes of text without control characters`);
    }
    return new Writer().u16(this.channel).raw(raw).done();
  }
}

/**
 * The state of a channel no plan or connection uses (probe.config §1): at boot and after every release. An output mode
 * keeps driving that level while the channel is free (a target's power switch kept on), and a gpio plan that takes the
 * channel keeps it until its first set (fixture §1); a probe that cannot drive the channel refuses it unsupported.
 * drive (output modes only): the strength it drives at (`fixture.Drive`, or a level number; fixture §1.1) - also what a
 * gpio set without its own drive uses on that channel. null: the default level (sent as 0xFF: the item is always 4
 * bytes, probe.config §1; an input mode's drive is not looked at). A level past the probe's drive_levels, or any level
 * on a probe without them, is refused unsupported.
 */
export class Idle {
  static TAG = ITEM.idle;
  /** @param {{ channel: number, mode?: string, drive?: Drive | number | null }} o  mode: hi-z, pull-up (default),
   *   pull-down, output-low, output-high (output_low / output_high too: underscores become hyphens) */
  constructor({ channel, mode = 'pull-up', drive = null }) {
    this.channel = channel; this.mode = mode.replace(/_/g, '-');
    /** @type {Drive | null} */
    this.drive = drive === null || drive === undefined ? null : Drive.of(drive);
  }
  key() { return [this.channel]; }
  /** channel(u16) mode(u8) drive(u8): 4 bytes (probe.config §1). */
  value() {
    const w = new Writer().u16(this.channel).u8(valueOf(IDLE, this.mode, 'idle mode'));
    const drive = this.drive ?? Drive.default();
    if (!drive.isDefault && this.mode !== 'output-low' && this.mode !== 'output-high') {
      throw new RangeError(`idle mode ${this.mode}: a drive goes with output-low / output-high only`);
    }
    return w.raw(drive.pack()).done();                               // drive(u8): a level, 0xFF the default
  }
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

/**
 * A place a target is wired to (probe.config §1.1; the probe checks no target - a host does, with connections' tid).
 * pins: [swdio, swclk], swclk 0xFFFF on one wire (swio). retryS goes on the wire as retry_ms (u32; at-boot slots only,
 * 0 on a host slot), maxSpeed as max_speed_hz (u32). The item ends with the name.
 */
export class Slot {
  static TAG = ITEM.slot;
  /**
   * @param {{ slot: number, wireFn: number, pins: [number, number], name: string, attach?: string, retryS?: number,
   *   mechanism?: string, maxSpeed?: number, idleClock?: string }} o
   *   attach: host (default), at-boot; retryS: at-boot: try again every retryS seconds while the target is not there
   *   (0: never); mechanism: sdi, dmdata, dmseq (default), none (no console on this slot); maxSpeed: the line's ceiling
   *   in Hz for the probe's own attach (0: none); idleClock: rvswd: SWCLK while the line rests, high (default) / low
   */
  constructor({ slot, wireFn, pins, name, attach = 'host', retryS = 0, mechanism = 'dmseq', maxSpeed = 0, idleClock = 'high' }) {
    this.slot = slot; this.wireFn = wireFn; this.pins = pins; this.name = name; this.attach = attach;
    this.retryS = retryS; this.mechanism = mechanism; this.maxSpeed = maxSpeed; this.idleClock = idleClock;
  }

  key() { return [this.slot]; }

  value() {
    const name = utf8(this.name);
    const retryMs = this.attach === 'at-boot' ? Math.round(this.retryS * 1000) : 0;
    return new Writer().u8(this.slot).u16(this.wireFn).u16(this.pins[0]).u16(this.pins[1])
      .u8(valueOf(ATTACH, this.attach, 'attach')).u32(retryMs).u32(this.maxSpeed)
      .u8(valueOf(IDLE_CLOCK, this.idleClock, 'idle clock')).u8(valueOf(MECHANISM, this.mechanism, 'mechanism'))
      .u8(name.length).raw(name).done();
  }
}

/**
 * The one stream serial port `port` (the describe transport index) carries (probe.config §1.2): ['slot', n] - a slot's
 * console - or ['uart', fn] - a fixture UART's RX. Another stream: set the bind again.
 */
export class Bind {
  static TAG = ITEM.bind;
  /** @param {{ port: number, stream: [string, number] }} o */
  constructor({ port, stream }) { this.port = port; this.stream = stream; }
  key() { return [this.port]; }
  /** port(u8) kind(u8) id(u16). */
  value() {
    const [kind, id] = this.stream;
    return new Writer().u8(this.port).u8(valueOf(STREAM, kind, 'stream kind')).u16(id).done();
  }
}

/** A wifi item's passphrase as get shows it: one is set, and a set carrying KEEP keeps the entry's (pass_len 0xFF). */
export const KEEP = Symbol('KEEP');

/** A passphrase as the wifi item takes it (probe.config §1.4): 8 to 63 bytes of 0x20-0x7E, or 64 hex digits. The
 * message never carries the passphrase. @param {Uint8Array} raw */
export function checkPassphrase(raw) {
  const isHex = (/** @type {number} */ b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  if (raw.length === PSK_HEX && raw.every(isHex)) return;
  if (raw.length < PASS_MIN || raw.length > PASS_MAX || raw.some((b) => b < 0x20 || b > 0x7e)) {
    throw new RangeError(`wifi passphrase (${raw.length} bytes): ${PASS_MIN} to ${PASS_MAX} printable ASCII characters or ${PSK_HEX} hex digits`);
  }
}

/** @typedef {string | Uint8Array | typeof KEEP | null} Passphrase */

/**
 * A network the probe joins to serve OEP over TCP (probe.config §1.4, item 0x08, key index; tried in index order).
 * ssid: 1 to 32 bytes. passphrase: null for an open network, `KEEP` for the one the entry has already (get's form: a
 * set with it changes nothing of the passphrase), else 8-63 printable ASCII characters or 64 hex digits.
 *
 * The passphrase is write-only: get never returns it (pass_len 0xFF: one is set, 0: none). Nothing here shows it: it is
 * a private field (not in console.log, util.inspect or JSON.stringify), and toString / toJSON / `shown()` say "set" or
 * "none".
 */
export class Wifi {
  static TAG = ITEM.wifi;
  /** @type {Passphrase} */
  #passphrase;
  /** @param {{ index: number, ssid: string | Uint8Array, passphrase?: Passphrase }} o */
  constructor({ index, ssid, passphrase = null }) { this.index = index; this.ssid = ssid; this.#passphrase = passphrase ?? null; }
  /** The passphrase as given (null, KEEP or the text): for sending only - never print or log it (host guide §15.1). */
  get passphrase() { return this.#passphrase; }
  get ssidBytes() { return typeof this.ssid === 'string' ? utf8(this.ssid) : this.ssid; }
  /** Whether the entry has a passphrase (KEEP or one given). */
  get hasPassphrase() { return this.#passphrase === KEEP || (this.#passphrase !== null && this.#passphrase.length > 0); }
  key() { return [this.index]; }
  /** What may be shown: index, ssid (safe text), passphrase "set" / "none". */
  shown() { return { index: this.index, ssid: m.shown(this.ssidBytes), passphrase: this.hasPassphrase ? 'set' : 'none' }; }
  toJSON() { return this.shown(); }
  toString() {
    const s = this.shown();
    return `Wifi(index=${s.index}, ssid=${JSON.stringify(s.ssid)}, passphrase=${s.passphrase})`;
  }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }
  /** index(u8) ssid_len(u8) ssid pass_len(u8) passphrase (pass_len 0xFF and nothing after: keep it). */
  value() {
    const ssid = this.ssidBytes;
    if (ssid.length < 1 || ssid.length > SSID_MAX) throw new RangeError(`wifi ssid ${JSON.stringify(m.shown(ssid))}: 1 to ${SSID_MAX} bytes`);
    if (!Number.isInteger(this.index) || this.index < 0 || this.index >= 0xff) {
      throw new RangeError(`wifi index ${this.index}: 0 to 254 (below the probe's wifi_max)`);
    }
    const w = new Writer().u8(this.index).u8(ssid.length).raw(ssid);
    const pass = this.#passphrase;
    if (pass === KEEP) return w.u8(PASS_SET).done();
    if (pass === null || pass.length === 0) return w.u8(0).done();
    const raw = typeof pass === 'string' ? utf8(pass) : pass;
    checkPassphrase(raw);
    return w.u8(raw.length).raw(raw).done();
  }
}

/** A wifi item's value as get shows it: the passphrase replaced by pass_len 0xFF when there is one (a value too short
 * for its counts is returned as it is). @param {Uint8Array} value */
export function wifiGetForm(value) {
  if (value.length < 3 || value.length < 3 + value[1]) return value;
  const head = value.slice(0, 2 + value[1]);
  return concat(head, Uint8Array.of(value[2 + value[1]] ? PASS_SET : 0));
}

/** @typedef {Plan | Label | Idle | Slot | Bind | Uart | Disable | Wifi} Item */
/** @typedef {{ tag: number, value: Uint8Array }} RawItem  an item of a tag this client does not know (or a malformed one) */
/** @typedef {'plan' | 'label' | 'idle' | 'slot' | 'bind' | 'uart' | 'disable' | 'wifi'} ItemKind */

/** One item as its TLV.
 * @param {Item} it */
export function item(it) { return m.tlv(/** @type {any} */ (it.constructor).TAG, it.value()); }

/** What `remove()` makes: one key for unset (op 0x05). `ProbeConfig.set()` sends these as an unset after its set. */
export class Removal {
  /** @param {ItemKind} kind @param {number} key */
  constructor(kind, key) { this.kind = kind; this.key = key; }
  /** len(u8) tag(u8) key, len the key's bytes alone (probe.config §2): the key is fn(u16) for plan / uart, channel(u16)
   * for label / idle / disable, slot(u8), port(u8), index(u8) for wifi. */
  encoded() {
    const tag = ITEM[this.kind];
    const key = BYTE_KEYED.includes(tag) ? Uint8Array.of(this.key) : new Writer().u16(this.key).done();
    return new Writer().u8(key.length).u8(tag).raw(key).done();
  }
}

/** The removal of the item of this key (for `unset`, or in a `set` list): kind plan (key fn: its whole plan), label /
 * idle / disable (channel), slot, bind (port), uart (fn), wifi (index).
 * @param {ItemKind} kind @param {number} key */
export function remove(kind, key) {
  if (ITEM[kind] === undefined) throw new RangeError(`no item kind ${kind}`);
  return new Removal(kind, key);
}

/** One item as one of the classes above (an unknown tag or a value too short for its tag: { tag, value }). Bytes after
 * the known fields are not read (every item has one form per tag, probe.config §1).
 * @param {number} tag @param {Uint8Array} v @returns {Item | RawItem} */
export function decode(tag, v) {
  if (tag === ITEM.plan && v.length >= 5) return new Plan({ fn: getU16(v), role: v[2], channel: getU16(v, 3) });
  if (tag === ITEM.label && v.length >= 2) return new Label({ channel: getU16(v), text: text(v.slice(2)) });
  if (tag === ITEM.idle && v.length >= 4) {
    const drive = Drive.unpack(v.slice(3, 4));
    return new Idle({ channel: getU16(v), mode: nameOf(IDLE, v[2]), drive: drive.isDefault ? null : drive });
  }
  if (tag === ITEM.slot && v.length >= SLOT_HEAD) {
    const nameLen = v[SLOT_HEAD - 1];
    const name = text(v.slice(SLOT_HEAD, SLOT_HEAD + nameLen));
    return new Slot({ slot: v[0], wireFn: getU16(v, 1), pins: [getU16(v, 3), getU16(v, 5)], name,
      attach: nameOf(ATTACH, v[7]), retryS: getU32(v, 8) / 1000, maxSpeed: getU32(v, 12), idleClock: nameOf(IDLE_CLOCK, v[16]),
      mechanism: nameOf(MECHANISM, v[17]) });
  }
  if (tag === ITEM.disable && v.length >= 2) return new Disable({ channel: getU16(v) });
  if (tag === ITEM.uart && v.length >= 7) return new Uart({ fn: getU16(v), baud: getU32(v, 2), format: v[6] });
  if (tag === ITEM.bind && v.length >= 4) return new Bind({ port: v[0], stream: [nameOf(STREAM, v[1]), getU16(v, 2)] });
  if (tag === ITEM.wifi && v.length >= 3 && v.length >= 3 + v[1]) {
    const passLen = v[2 + v[1]];
    // get carries no passphrase (pass_len 0xFF: set); one a probe sent anyway is kept, never shown
    const sent = v.slice(3 + v[1], 3 + v[1] + passLen);
    const passphrase = passLen === PASS_SET ? KEEP : passLen ? (sent.length ? sent : KEEP) : null;
    return new Wifi({ index: v[0], ssid: text(v.slice(2, 2 + v[1])), passphrase });
  }
  return { tag, value: v };
}

// ---- comparing items (host guide §15) ---------------------------------------------------------------------------

/** get's order key of one item (probe.config §2): plan (fn, role, channel), label / idle / disable channel, slot,
 * port, uart fn, wifi index. @param {number} tag @param {Uint8Array} value */
function sortKey(tag, value) {
  if (tag === ITEM.plan && value.length >= 5) return [getU16(value), value[2], getU16(value, 3)];
  if (BYTE_KEYED.includes(tag)) return value.length ? [value[0]] : [-1];
  return value.length >= 2 ? [getU16(value)] : [-1];
}

/**
 * The items (objects, or item TLV bytes - one or more TLVs each) as [tag, value] in get's order: tag ascending, then
 * key ascending (plan by (fn, role, channel)), critical bit dropped. The same key twice throws, as the probe refuses it
 * in one set; a Removal is not an item (it goes as an unset) and throws too. asGet: a wifi item's passphrase as get
 * shows it (`wifiGetForm`).
 * @param {(Item | Uint8Array | [number, Uint8Array])[]} items @param {boolean} [asGet]
 * @returns {[number, Uint8Array][]}
 */
export function ordered(items, asGet = false) {
  /** @type {{ tag: number, key: number[], value: Uint8Array }[]} */
  const rows = [];
  const seen = new Set();
  for (const it of items) {
    if (it instanceof Removal) throw new RangeError('a removal is not an item of the configuration (unset sends it)');
    /** @type {[number, Uint8Array][]} */
    const tlvs = it instanceof Uint8Array ? m.splitTlvs(it) : Array.isArray(it) ? [it]
      : [[/** @type {any} */ (it.constructor).TAG, it.value()]];
    for (const [rawTag, value] of tlvs) {
      const tag = rawTag & 0x7f;
      const key = sortKey(tag, value);
      const id = `${tag}:${key.join(',')}`;
      if (seen.has(id)) throw new RangeError(`item 0x${tag.toString(16)} key ${key.join(',')} given twice`);
      seen.add(id);
      rows.push({ tag, key, value: asGet && tag === ITEM.wifi ? wifiGetForm(value) : value });
    }
  }
  rows.sort((a, b) => a.tag - b.tag || a.key[0] - b.key[0] || (a.key[1] ?? 0) - (b.key[1] ?? 0) || (a.key[2] ?? 0) - (b.key[2] ?? 0));
  return rows.map((r) => [r.tag, r.value]);
}

/** Whether two configurations hold the same items, item by item (host guide §15: a host compares what it wants with
 * get's items; the probe's hash is its own and is never computed here). A wifi item compares as get shows it: its
 * passphrase is write-only, so only whether one is set counts - a changed passphrase of the same entry is not seen
 * (set it with `set`; host guide §15.1).
 * @param {(Item | Uint8Array | [number, Uint8Array])[]} a @param {(Item | Uint8Array | [number, Uint8Array])[]} b */
export function sameItems(a, b) {
  const x = ordered(a, true), y = ordered(b, true);
  return x.length === y.length && x.every(([t, v], i) => t === y[i][0] && v.length === y[i][1].length && v.every((byte, k) => byte === y[i][1][k]));
}

/** The kind of an item tag (probe.config §1). @type {Record<number, ItemKind>} */
const KIND = /** @type {any} */ (Object.fromEntries(Object.entries(ITEM).map(([k, v]) => [v, k])));

/** The [kind, key] an unset names for an item (probe.config §2): plan and uart fn(u16), label / idle / disable
 * channel(u16), slot, bind and wifi their first byte. @param {number} tag @param {Uint8Array} value @returns {[ItemKind, number]} */
function keyOf(tag, value) {
  if (BYTE_KEYED.includes(tag)) return [KIND[tag], value[0]];
  return [KIND[tag], getU16(value)];
}

// ---- declarations and state --------------------------------------------------------------------------------------

/**
 * @typedef {object} SlotState
 * @property {number} slot
 * @property {string} state              connected (a connection on its place - which target, the host checks with
 *                                       connections' tid), absent
 * @property {number} connection         0: none
 * @property {bigint | null} lastTryAtNs the probe's clock when it last tried an automatic attach (null: never tried)
 */
/**
 * @typedef {object} BindState
 * @property {number} port
 * @property {string} flow               idle, streaming, held
 */
/**
 * What the probe's describe declares (fixed for one boot): the storage's size, the item tags it takes, how many
 * slots, how many wifi entries.
 * @typedef {object} Declared
 * @property {number} storageBytes       the storage's size; 0: no storage
 * @property {number[]} items            the item tags the probe takes
 * @property {number} slotsMax
 * @property {number} wifiMax            wifi entries (index 0 .. wifiMax - 1); 0: no wifi item
 */

/** The probe's Wi-Fi link (the state answer's wifi TLV, probe.config §3.3). */
export class WifiState {
  /** @param {string} state off, connecting, connected, waiting (every entry failed; it waits, then tries again)
   * @param {number | null} entry the index in use or being tried (null: none)
   * @param {string} reason why the last try failed: none, not-found, auth, no-address, other
   * @param {number | null} rssi dBm, while connected @param {string | null} ipv4 the probe's address, while connected */
  constructor(state, entry, reason, rssi, ipv4) {
    this.state = state; this.entry = entry; this.reason = reason; this.rssi = rssi; this.ipv4 = ipv4;
  }
  /** state(u8) entry(u8) reason(u8) rssi(i8) ipv4(4 bytes). @param {Uint8Array} v */
  static unpack(v) {
    const connected = v[0] === CFG.enum.wifi_state.connected;
    const rssi = v[3] >= 0x80 ? v[3] - 0x100 : v[3];
    const ip = [...v.slice(4, 8)].join('.');
    return new WifiState(WIFI_STATE[v[0]] ?? String(v[0]), v[1] === NO_ENTRY ? null : v[1], WIFI_REASON[v[2]] ?? String(v[2]),
      connected && rssi ? rssi : null, connected && ip !== '0.0.0.0' ? ip : null);
  }
  text() {
    return this.state + (this.entry !== null ? `, entry ${this.entry}` : '') + (this.reason !== 'none' ? `, reason ${this.reason}` : '')
      + (this.rssi !== null ? `, rssi ${this.rssi} dBm` : '') + (this.ipv4 ? `, ip ${this.ipv4}` : '');
  }
}
/**
 * The live state (op state, lock-free; probe.config §3.3): the saved settings and the slots and binds.
 * @typedef {object} State
 * @property {string} storage            none, applied, unreadable
 * @property {number} savedHash          get's hash when the saved settings became the current ones (0: none / unreadable)
 * @property {number} unreadableReason   0 none, 1 form, 2 an interface gone / of another revision, 3 refused
 * @property {string | null} unreadable  why, when unreadable
 * @property {SlotState[]} slots
 * @property {BindState[]} binds
 * @property {WifiState | null} wifi      the Wi-Fi link, on a probe with the wifi item (the last page's)
 */

export class ProbeConfig extends Interface {
  static NAME = CFG.name;
  static REVISION = CFG.revision;
  static GET = CFG.op.get;
  static SET = CFG.op.set;
  static SAVE = CFG.op.save;
  static ERASE = CFG.op.erase;
  static UNSET = CFG.op.unset;
  static STATE = CFG.op.state;

  /** The hash and the items as [tag, value] in get's order (tag, then key), paged. No lock. Every page carries the same hash;
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

  /** The current settings, decoded (Plan, Label, Idle, Slot, Bind, Uart, Disable, Wifi; { tag, value } for others). */
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
      await this.checkFits(body);
      hash = ProbeConfig.hashAnswer(await this.call(ProbeConfig.SET, body));
    }
    if (removals.length) hash = await this.unset(removals.map((r) => /** @type {[ItemKind, number]} */ ([r.kind, r.key])));
    return hash;
  }

  /** A set request longer than the probe's max_frame is refused here, before anything is sent (RangeError): the probe
   * could not take it. One set of the longest wifi item is wifi_min_max_frame (112) bytes, and a probe with the wifi
   * item answers at least that on every transport (probe.config §1.4); several items may need several sets.
   * @param {Uint8Array} body */
  async checkFits(body) {
    const size = m.REQUEST_HEADER + this.prefix.length + body.length;
    const limit = (await this.host.confirmed()).maxFrame;
    if (size <= limit) return;
    const wifi = m.splitTlvs(body).some(([t]) => (t & 0x7f) === ITEM.wifi);
    throw new RangeError(`probe.config set of ${size} bytes exceeds this transport's max_frame ${limit}: `
      + (wifi && limit < WIFI_MIN_MAX_FRAME ? `a probe with the wifi item answers max_frame ${WIFI_MIN_MAX_FRAME} or more on `
        + 'every transport (probe.config §1.4) - this one does not; ' : '')
      + 'send fewer items per set');
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

  /** Save the current settings (a probe with storage; the whole is replaced) -> the hash saved. Needs the lock. The
   * probe answers nothing while it writes: its argument time is max_op_ms (probe.config §2, core §4.4). */
  async save() { return ProbeConfig.hashAnswer(await this.call(ProbeConfig.SAVE, undefined, { expectMs: await maxOpMs(this.host) })); }

  /** Whether a save would change what is stored (host guide §15 step 5): not when the storage is applied and its
   * storage_hash is the current settings' (get's) hash. A flash write wears it and stops the probe meanwhile. */
  async needsSave() {
    const st = await this.state();
    return !(st.storage === 'applied' && st.savedHash === (await this.get()).hash);
  }

  /** Make the probe's settings `wanted` (host guide §15): get, compared item by item (`sameItems`; a wifi item by its
   * ssid and whether it has a passphrase); when they differ, set what is wanted - a wifi entry the probe has as wanted
   * goes with pass_len 0xFF, so no passphrase is sent again (host guide §15.1) - and unset the keys get has and
   * `wanted` does not; with `save`, save when `needsSave`. -> whether anything was sent. Needs the lock when something
   * changes.
   * @param {(Item | Uint8Array)[]} wanted @param {{ save?: boolean }} [opts] */
  async apply(wanted, { save = false } = {}) {
    const have = (await this.get()).items;
    let changed = false;
    if (!sameItems(have, wanted)) {
      const want = ordered(wanted);
      const keys = new Set(want.map(([t, v]) => keyOf(t, v).join(':')));
      const had = new Map(ordered(have, true).map(([t, v]) => [keyOf(t, v).join(':'), v]));
      const same = (/** @type {Uint8Array} */ a, /** @type {Uint8Array | undefined} */ b) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
      await this.set(want.map(([t, v]) => {
        const asGet = t === ITEM.wifi ? wifiGetForm(v) : v;
        return m.tlv(t, t === ITEM.wifi && same(asGet, had.get(keyOf(t, v).join(':'))) ? asGet : v);
      }));
      const gone = [...new Map(have.map(([t, v]) => keyOf(t & 0x7f, v)).filter((k) => !keys.has(k.join(':')))
        .map((k) => [k.join(':'), k])).values()];
      if (gone.length) await this.unset(gone);
      changed = true;
    }
    if (save && await this.needsSave()) {
      await this.save();
      changed = true;
    }
    return changed;
  }

  /** Erase what is saved (the current settings stay). Needs the lock. */
  async erase() { await this.call(ProbeConfig.ERASE); }

  /** The declarations (describe, cached by the host while the probe's boot_id holds). @returns {Promise<Declared>} */
  async describe() {
    /** @type {Declared} */
    const d = { storageBytes: 0, items: [], slotsMax: 0, wifiMax: 0 };
    for (const [rawTag, v] of await describe(this.host, this.fn)) {
      const tag = rawTag & 0x7f;
      if (tag === DESCRIBE.storage && v.length >= 4) d.storageBytes = getU32(v);
      else if (tag === DESCRIBE.items) d.items = [...v];
      else if (tag === DESCRIBE.slots_max && v.length) d.slotsMax = v[0];
      else if (tag === DESCRIBE.wifi_max && v.length) d.wifiMax = v[0];
    }
    return d;
  }

  /** The storage's state, the live slot_state / bind_state (op state, lock-free, paged by first_slot / first_bind)
   * and, on a probe with the wifi item, the Wi-Fi link (`WifiState`).
   * Each page carries storage_state, storage_hash and unreadable_reason as they were when it was answered: the last
   * page's are kept (probe-config §3.3, PC-9). The slots and binds may change between pages too; a caller that needs
   * them to stay the same pages while it holds the lock.
   * @returns {Promise<State>} */
  async state() {
    /** @type {State} */
    const st = { storage: 'none', savedHash: 0, unreadableReason: 0, unreadable: null, slots: [], binds: [], wifi: null };
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
      for (let i = 0; i < nSlots; i++) {   // count x slot_state, no element length (core §2.3)
        const slot = rd.u8(), state = rd.u8(), connection = rd.u16(), tried = rd.u64();
        st.slots.push({ slot, state: SLOT_STATE[state] ?? String(state), connection, lastTryAtNs: tried === NEVER_NS ? null : tried });
      }
      const nBinds = rd.u8();
      for (let i = 0; i < nBinds; i++) {
        const port = rd.u8(), flow = rd.u8();
        st.binds.push({ port, flow: BIND_FLOW[flow] ?? String(flow) });
      }
      const wifi = rd.tail().get(STATE_TLV.wifi);
      if (wifi && wifi.length >= 8) st.wifi = WifiState.unpack(wifi);
      if (!more || !(nSlots || nBinds)) return st;
      firstSlot += nSlots;
      firstBind += nBinds;
    }
  }
}

/** The line names of the label convention (probe.config §1.3), the registry's standard names (PC-2; private ones start
 * with `x-`): `nrst` a target's reset, `power_hi` high powers it, `power_lo` low powers it. Per slot
 * `<slot name>.<name>`; the bare name on settings with at most one slot item. */
export const LINE_NAMES = Object.freeze(Object.keys(CFG.line_names));

/** ASCII case folded (only A-Z: probe.config §1.3 compares ignoring ASCII case). @param {string} text */
export function foldName(text) { return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)); }

/**
 * probe.config §1.3 on bare data: labels as [channel, text] - the settings' label items -, nSlots the settings' slot
 * items, firmware the firmware's fixed labels (fn 0 describe 0x46) as [channel, text]. In order, stopping at the first
 * step that finds exactly one channel: (a) a settings label equal to `<slotName>.<name>`; (b) only with at most one
 * slot item, a settings label equal to `name`; (c) only with at most one slot item, a firmware label equal to `name`
 * (PC-1). A step that finds two or more ends the search with none (no fall-through). Texts compare ignoring ASCII
 * case. slotName null (settings without slot items): steps (b) and (c).
 * @param {Iterable<[number, string]>} labels @param {number} nSlots @param {string | null} slotName @param {string} name
 * @param {Iterable<[number, string]>} [firmware]
 * @returns {number | null}
 */
export function lineFromLabels(labels, nSlots, slotName, name, firmware = []) {
  const settings = [...labels], fixed = [...firmware];
  /** @type {[[number, string][], string][]} */
  const steps = [...(slotName !== null && slotName !== undefined ? [/** @type {[[number, string][], string]} */ ([settings, `${slotName}.${name}`])] : []),
    ...(nSlots <= 1 ? [/** @type {[[number, string][], string]} */ ([settings, name]), /** @type {[[number, string][], string]} */ ([fixed, name])] : [])];
  for (const [source, text] of steps) {
    const want = foldName(text);
    const found = new Set(source.filter(([, t]) => foldName(t) === want).map(([ch]) => ch));
    if (found.size > 1) return null;                                 // ambiguous at this step: no such line
    if (found.size) return [...found][0];
  }
  return null;
}

/**
 * The channel of the line `name` (nrst, power_hi, power_lo: LINE_NAMES) of a slot by the label convention
 * (probe.config §1.3), or null when that slot has no such line. config: a Host (its settings are read with
 * ProbeConfig items, no lock) or the decoded items. slotName: the slot's name or number; null on settings with no slot
 * item (the target connected to the probe) or one (that slot).
 *
 * `<slot>.<name>` first, ignoring ASCII case; then the bare `name`, only when the settings hold at most one slot item;
 * then (PC-1) the firmware's fixed label equal to `name` (fn 0 describe 0x46), on the same condition; two or more
 * channels matching at one step mean no such line. firmware: the fixed labels as [channel, text] - read from the
 * probe's describe when `config` is a Host, none when it is a list of items and this is not given. Throws RangeError
 * for slotName null with several slots, and for a slot number not in the settings.
 * @param {import('./host.js').Host | (Item | { tag: number, value: Uint8Array })[]} config
 * @param {string | number | null} slotName @param {string} name @param {Iterable<[number, string]> | null} [firmware]
 * @returns {Promise<number | null>}
 */
export async function findLine(config, slotName, name, firmware = null) {
  const items = Array.isArray(config) ? config : await (await ProbeConfig.open(config)).items();
  const fixed = firmware ? [...firmware] : Array.isArray(config) ? [] : await firmwareLabels(config);
  const labels = /** @type {Label[]} */ (items.filter((i) => i instanceof Label)).map((l) => /** @type {[number, string]} */ ([l.channel, l.text]));
  const slots = /** @type {Slot[]} */ (items.filter((i) => i instanceof Slot));
  if (typeof slotName === 'number') {
    const named = slots.find((s) => s.slot === slotName);
    if (!named) throw new RangeError(`no slot ${slotName} in the probe's settings`);
    slotName = named.name;
  }
  if ((slotName === null || slotName === undefined) && slots.length > 1) {
    throw new RangeError(`${name}: the settings hold ${slots.length} slots; name the slot`);
  }
  if ((slotName === null || slotName === undefined) && slots.length) slotName = slots[0].name;
  return lineFromLabels(labels, slots.length, slotName ?? null, name, fixed);
}
