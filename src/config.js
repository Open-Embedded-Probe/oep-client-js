// @ts-check
// oep.probe.config revision 1 (oep-spec interfaces/oep-if-probe-config.ja.md): the probe's settings as named items -
// labels, idle states, disabled channels, the serial ports' pass-throughs, the debug wires' rest and hold, the network
// (wifi, ipv4) and the probe's own items - read and set, removed with unset, saved when the host says so; the storage
// state and the network's state as their own lock-free operations (describe is declarations only, core §7.3).
//
//   const cfg = await ProbeConfig.open(hst);
//   await cfg.set([new Label({ channel: 23, text: 'nrst' }), new Idle({ channel: 20, mode: 'pull-up' })]);
//   await cfg.set([new Wifi({ entry: 0, ssid: 'lab', passphrase })]);   // the passphrase is never read back or shown
//   await cfg.set([new Own('com.example.ntp-server', 'pool.ntp.org')]);
//   if (await cfg.needsSave()) await cfg.save();
//   await cfg.items(), await cfg.describe(), await cfg.state(), await cfg.network()
//   await cfg.unset([['idle', 20]])          // or cfg.set([remove('idle', 20)])
//
// Items are named (probe.config §1): the standard names in the registry, a probe's own as reverse-DNS names. The probe
// lists the items it takes in describe (setting); the k-th is item number k on the wire for this boot. An item on the
// wire is number(u8) len(u16) key(u16) data; this client looks the numbers up by name (`describe`, cached per boot_id)
// and never keeps them across boots. A set replaces the (name, key) it carries and keeps the others; the probe checks
// the whole and changes nothing on a refusal. The generation is the probe's change counter within one boot (§2): a host
// compares the items themselves (`sameItems`, host guide §15) and the generation only for equality.

import * as reg from './registry.js';
import { Writer, concat, equal, getU16, getU32, text, utf8 } from './bytes.js';
import * as m from './message.js';
import { Interface, describe, firmwareLabels, maxOpMs } from './core.js';
import { firstFixed } from './catalog.js';

const CFG = reg.PROBE_CONFIG;
/** The standard items' names, in the registry's order (core §7.7). */
export const NAMES = Object.freeze(Object.keys(CFG.names.setting));
/** The numbers a probe uses when it lists the standard items in the registry's order (the virtual bench's profiles do):
 * a convenience for raw requests in tests and tools only - a host looks every number up by name (`ProbeConfig.wire`).
 * Keyed with underscores (console_passthrough, rvswd_rest, wire_hold). @type {Record<string, number>} */
export const ITEM = Object.freeze(Object.fromEntries(NAMES.map((k, i) => [k.replace(/-/g, '_'), i + 1])));
export const DESCRIBE = CFG.tlv.describe;
/** A label's text: 1 to this many bytes (probe.config §1). */
export const LABEL_MAX = reg.LIMITS.label_max_bytes;
/** A wifi item's ssid: 1 to this many bytes (probe.config §1.4). */
export const SSID_MAX = reg.LIMITS.wifi_ssid_max_bytes;
/** A wifi passphrase: PASS_MIN to PASS_MAX bytes of 0x20-0x7E, or PSK_HEX hex digits (probe.config §1.4). */
export const PASS_MIN = 8, PASS_MAX = 63, PSK_HEX = 64;   // probe.config §1.4's table (not in the registry)
/** A probe with the wifi item answers max_frame at least this on every transport: one set of the longest wifi item
 * (probe.config §1.4). */
export const WIFI_MIN_MAX_FRAME = reg.LIMITS.wifi_min_max_frame;
/** pass_len in get: a passphrase is set (none follows); in a set: keep the entry's (probe.config §1.4). */
export const PASS_KEPT = 0xff;
/** A network's entry when none is tried or used (op network). */
export const NO_ENTRY = 0xffff;

/** @param {Record<string, number>} e */
const dashed = (e) => /** @type {Record<string, number>} */ (Object.fromEntries(Object.entries(e).map(([k, v]) => [k.replace(/_/g, '-'), v])));
/** @param {Record<string, number>} e */
const byValue = (e) => /** @type {Record<number, string>} */ (Object.fromEntries(Object.entries(e).map(([k, v]) => [v, k.replace(/_/g, '-')])));

export const IDLE = dashed(CFG.enum.idle_mode);                     // hi-z, pull-up, pull-down, output-low, output-high
export const REST_MODE = dashed(CFG.enum.rvswd_rest_mode);          // rvswd-rest: auto / high / low (debug §3.1)
export const HOLD_MODE = dashed(CFG.enum.wire_hold_mode);           // wire-hold: off / on (debug §2)
export const IPV4_MODE = CFG.enum.ipv4_mode;                        // dhcp, static
export const FORM = CFG.enum.setting_form;                          // named, bytes, text, u32, ipv4, bool
export const FLAG = CFG.enum.setting_flag;                          // secret, restart
export const STORAGE_STATE = byValue(CFG.enum.storage_state);       // none, applied, unreadable, partial
export const UNREADABLE = byValue(CFG.enum.storage_unreadable);     // none, form, item, capacity
export const NET_STATE = byValue(CFG.enum.network_state);           // off, connecting, up, waiting
export const NET_REASON = byValue(CFG.enum.network_reason);         // none, not-found, auth, no-address, other
/** The standard netif names (probe.config §1.3): wifi, ethernet. */
export const NETIFS = Object.freeze(Object.keys(CFG.names.netif));

/** @param {Record<string, number>} table @param {number} value */
function nameOf(table, value) { return Object.keys(table).find((k) => table[k] === value) ?? String(value); }
/** @param {Record<string, number>} table @param {string} name @param {string} what */
function valueOf(table, name, what) {
  const v = table[name];
  if (v === undefined) throw new RangeError(`${what} ${name}: one of ${Object.keys(table).join(', ')}`);
  return v;
}

/** "a.b.c.d" -> 4 bytes (null / '': 0.0.0.0). @param {string | null | undefined} s */
function ipBytes(s) {
  if (!s) return new Uint8Array(4);
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && +p <= 255)) throw new RangeError(`IPv4 address ${s}: a.b.c.d`);
  return Uint8Array.from(parts, Number);
}
/** 4 bytes -> "a.b.c.d" (0.0.0.0: null). @param {Uint8Array} b */
const ipText = (b) => (b.some((x) => x) ? [...b].join('.') : null);

/** A name the settings give a channel (probe.config §1): the probe never moves a line by it; a host may find its
 * lines by the label convention (`findLine`, host guide §5.3). */
export class Label {
  static NAME = 'label';
  /** @param {{ channel: number, text: string }} o */
  constructor({ channel, text }) { this.channel = channel; this.text = text; }
  key() { return this.channel; }
  data() {
    const raw = utf8(this.text);
    if (raw.length < 1 || raw.length > LABEL_MAX || !m.validText(raw)) {
      // probe.config §1: 1 to 32 bytes (the probe refuses other lengths); this host sends no control characters
      throw new RangeError(`label ${JSON.stringify(this.text)}: 1 to ${LABEL_MAX} bytes of text without control characters`);
    }
    return raw;
  }
}

/**
 * The state of a free channel (probe.config §1, core §8): at boot and after every release. An output mode keeps driving
 * that level while the channel is free - a target's power switch kept on - even after the host has gone; a probe that
 * cannot drive the channel refuses it unsupported. The output strength is the probe's own.
 */
export class Idle {
  static NAME = 'idle';
  /** @param {{ channel: number, mode?: string }} o  mode: hi-z, pull-up (default), pull-down, output-low, output-high
   *   (output_low / output_high too: underscores become hyphens) */
  constructor({ channel, mode = 'pull-up' }) { this.channel = channel; this.mode = mode.replace(/_/g, '-'); }
  key() { return this.channel; }
  data() { return Uint8Array.of(valueOf(IDLE, this.mode, 'idle mode')); }
}

/** A channel the probe never drives or sets up (probe.config §1): not on this board, or wired to another part. Any
 * request naming it is refused unavailable (cause 5, held by settings); describe still declares it. */
export class Disable {
  static NAME = 'disable';
  /** @param {{ channel: number }} o */
  constructor({ channel }) { this.channel = channel; }
  key() { return this.channel; }
  data() { return new Uint8Array(); }
}

/**
 * Serial port `port` (fn 0's describe transport index) carries what fixture UART `fn` receives on `rx`, outside the OEP
 * frames, while no session uses the port, the fn or the pin (probe.config §1.1; transports §4): a plain serial monitor on
 * a probe whose one port is a UART bridge sees the target. A host on that port reads those bytes past as noise; its
 * session's request there stops it for the session. format: fixture.FixtureUart.formatByte(). Key: the port.
 */
export class Passthrough {
  static NAME = 'passthrough';
  /** @param {{ port: number, fn: number, rx: number, baud?: number, format?: number }} o */
  constructor({ port, fn, rx, baud = 115200, format = 0 }) {
    this.port = port; this.fn = fn; this.rx = rx; this.baud = baud; this.format = format;
  }
  key() { return this.port; }
  /** fn(u16) rx(u16) baud(u32) format(u8). */
  data() { return new Writer().u16(this.fn).u16(this.rx).u32(this.baud).u8(this.format).done(); }
}

/**
 * How an rvswd attach without idle_clock rests the SWCLK on `channel` (the port's SWCLK; debug §3.1): auto - the probe's
 * choice from the target_id it reads (also with no item) - or high / low fixed, the automatic choice off for that port.
 * An attach's idle_clock TLV still decides.
 */
export class RvswdRest {
  static NAME = 'rvswd-rest';
  /** @param {{ channel: number, mode?: string }} o  mode: auto (default), high, low */
  constructor({ channel, mode = 'auto' }) { this.channel = channel; this.mode = mode; }
  key() { return this.channel; }
  data() { return Uint8Array.of(valueOf(REST_MODE, this.mode, 'rvswd-rest mode')); }
}

/** Whether a debug wire's lines on the port whose SWDIO is `channel` stay held at their rest after its connection closes
 * (debug §2): on - also with no item - or off (back to the free state at once). */
export class WireHold {
  static NAME = 'wire-hold';
  /** @param {{ channel: number, mode?: string }} o  mode: on (default), off */
  constructor({ channel, mode = 'on' }) { this.channel = channel; this.mode = mode; }
  key() { return this.channel; }
  data() { return Uint8Array.of(valueOf(HOLD_MODE, this.mode, 'wire-hold mode')); }
}

/**
 * Serial port `port` carries the target's debug console - read by the probe itself over `wireFn` on (swdio, swclk) with
 * method 0 (no halt, no reset), through console `consoleFn`'s `mechanism` (the position, from 1, in that console's
 * describe mechanism list; console.Console.mechanismNumber) - outside the OEP frames, while no session uses the port or
 * those pins (probe.config §1.2): a target that prints through the debug mailbox, watched with a plain serial monitor.
 * Not an OEP resource (no connection, no stream). swclk 0xFFFF on one wire (swio). Key: the port.
 */
export class ConsolePassthrough {
  static NAME = 'console-passthrough';
  /** @param {{ port: number, wireFn: number, swdio: number, swclk?: number, maxSpeed?: number, consoleFn: number,
   *   mechanism: number }} o */
  constructor({ port, wireFn, swdio, swclk = 0xffff, maxSpeed = 1_000_000, consoleFn, mechanism }) {
    this.port = port; this.wireFn = wireFn; this.swdio = swdio; this.swclk = swclk; this.maxSpeed = maxSpeed;
    this.consoleFn = consoleFn; this.mechanism = mechanism;
  }
  key() { return this.port; }
  /** wire_fn(u16) swdio(u16) swclk(u16) max_speed(u32) console_fn(u16) mechanism(u8). */
  data() {
    return new Writer().u16(this.wireFn).u16(this.swdio).u16(this.swclk).u32(this.maxSpeed).u16(this.consoleFn)
      .u8(this.mechanism).done();
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
 * A Wi-Fi network the probe tries, in entry order (probe.config §1.4; key: the entry). ssid: 1 to 32 bytes. passphrase:
 * null for an open network, `KEEP` for the one the entry has already (get's form: a set with it changes nothing of the
 * passphrase), else 8-63 printable ASCII characters or 64 hex digits.
 *
 * The passphrase is write-only: get never returns it (pass_len 0xFF: one is set, 0: none). Nothing here shows it: it is
 * a private field (not in console.log, util.inspect or JSON.stringify), and toString / toJSON / `shown()` say "set" or
 * "none".
 */
export class Wifi {
  static NAME = 'wifi';
  /** @type {Passphrase} */
  #passphrase;
  /** @param {{ entry: number, ssid: string | Uint8Array, passphrase?: Passphrase }} o */
  constructor({ entry, ssid, passphrase = null }) { this.entry = entry; this.ssid = ssid; this.#passphrase = passphrase ?? null; }
  /** The passphrase as given (null, KEEP or the text): for sending only - never print or log it (host guide §15.1). */
  get passphrase() { return this.#passphrase; }
  get ssidBytes() { return typeof this.ssid === 'string' ? utf8(this.ssid) : this.ssid; }
  /** Whether the entry has a passphrase (KEEP or one given). */
  get hasPassphrase() { return this.#passphrase === KEEP || (this.#passphrase !== null && this.#passphrase.length > 0); }
  key() { return this.entry; }
  /** What may be shown: entry, ssid (safe text), passphrase "set" / "none". */
  shown() { return { entry: this.entry, ssid: m.shown(this.ssidBytes), passphrase: this.hasPassphrase ? 'set' : 'none' }; }
  toJSON() { return this.shown(); }
  toString() {
    const s = this.shown();
    return `Wifi(entry=${s.entry}, ssid=${JSON.stringify(s.ssid)}, passphrase=${s.passphrase})`;
  }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }
  /** ssid_len(u8) ssid pass_len(u8) passphrase (pass_len 0xFF and nothing after: keep it). */
  data() {
    const ssid = this.ssidBytes;
    if (ssid.length < 1 || ssid.length > SSID_MAX) throw new RangeError(`wifi ssid ${JSON.stringify(m.shown(ssid))}: 1 to ${SSID_MAX} bytes`);
    const w = new Writer().u8(ssid.length).raw(ssid);
    const pass = this.#passphrase;
    if (pass === KEEP) return w.u8(PASS_KEPT).done();
    if (pass === null || pass.length === 0) return w.u8(0).done();
    const raw = typeof pass === 'string' ? utf8(pass) : pass;
    checkPassphrase(raw);
    return w.u8(raw.length).raw(raw).done();
  }
}

/** A wifi item's data as get shows it: the passphrase replaced by pass_len 0xFF when there is one (data too short for
 * its counts is returned as it is). @param {Uint8Array} data */
export function wifiGetForm(data) {
  if (data.length < 2 || data.length < 2 + data[0]) return data;
  return concat(data.slice(0, 1 + data[0]), Uint8Array.of(data[1 + data[0]] ? PASS_KEPT : 0));
}

/**
 * How netif `netif` (by name: "wifi", "ethernet" or a probe's own; looked up in describe's netif list) gets its IPv4
 * address (probe.config §1.5): DHCP (address null) or static `address` "a.b.c.d/prefix" with an optional gateway and
 * dns. A netif without this item uses DHCP (§1.3). Key: the netif's number, filled in from describe by ProbeConfig.
 */
export class Ipv4 {
  static NAME = 'ipv4';
  /** @param {{ netif?: string, address?: string | null, gateway?: string | null, dns?: string | null }} [o] */
  constructor({ netif = 'wifi', address = null, gateway = null, dns = null } = {}) {
    this.netif = netif; this.address = address; this.gateway = gateway; this.dns = dns;
    /** the netif's number (from 1), filled in from describe by ProbeConfig */
    this.number = 0;
  }
  key() { return this.number; }
  /** mode(u8) address(4) prefix(u8) gateway(4) dns(4): 14 bytes, all 0 for DHCP. */
  data() {
    if (this.address === null) return new Uint8Array(14);
    const [ip, prefix, ...extra] = this.address.split('/');
    const bits = prefix === undefined ? 32 : Number(prefix);
    if (extra.length || !Number.isInteger(bits) || bits < 1 || bits > 32) throw new RangeError(`ipv4 address ${this.address}: a.b.c.d/prefix`);
    return new Writer().u8(IPV4_MODE.static).raw(ipBytes(ip)).u8(bits).raw(ipBytes(this.gateway)).raw(ipBytes(this.dns)).done();
  }
}

/**
 * A probe's own item (probe.config §1.6) by its reverse-DNS name: `value` a string (text), a number (u32), a boolean, a
 * Uint8Array (bytes) or "a.b.c.d" (ipv4); null for a secret kept as it is. Encoded by the form the probe declares
 * (`ProbeConfig` does it).
 */
export class Own {
  /** @param {string} name @param {string | number | boolean | Uint8Array | null} [value] @param {number} [key] */
  constructor(name, value = null, key = 0) { this.name = name; this.value = value; this.keyNumber = key; }
  get NAME() { return this.name; }
  key() { return this.keyNumber; }
  /** @param {number} form */
  encode(form) {
    const v = this.value;
    if (v === null || v === undefined) return new Uint8Array();
    if (form === FORM.text) return utf8(String(v));
    if (form === FORM.u32) return new Writer().u32(Number(v)).done();
    if (form === FORM.bool) return Uint8Array.of(v ? 1 : 0);
    if (form === FORM.ipv4) return ipBytes(String(v));
    if (v instanceof Uint8Array) return v;
    throw new RangeError(`${this.name}: a bytes item takes a Uint8Array`);
  }
}

/** @typedef {Label | Idle | Disable | Passthrough | RvswdRest | WireHold | ConsolePassthrough | Wifi | Ipv4} Standard */
/** @typedef {Standard | Own} Item */
/** @typedef {[string, number, Uint8Array]} Triple  an item as (name, key, data): one this client does not decode */

/** One standard item on the wire as a probe that lists the standard items in the registry's order numbers it (`ITEM`;
 * tests and tools only): number(u8) len(u16) key(u16) data (probe.config §1). @param {Standard} it */
export function item(it) {
  const name = /** @type {any} */ (it.constructor).NAME;
  const data = it.data();
  return concat(new Writer().u8(ITEM[name.replace(/-/g, '_')]).u16(2 + data.length).u16(it.key()).done(), data);
}

/** What `remove()` makes: one key for unset. `ProbeConfig.set()` sends these as an unset after its set. */
export class Removal {
  /** @param {string} kind @param {number} key */
  constructor(kind, key) { this.kind = kind; this.key = key; }
}

/** The removal of the item of this key (for `unset`, or in a `set` list): a standard name or a probe's own.
 * @param {string} kind @param {number} key */
export function remove(kind, key) { return new Removal(kind.replace(/_/g, '-'), key); }

/** One describe setting (probe.config §4): its item number is its place (from 1). */
export class Setting {
  /** @param {number} number @param {string} name @param {number} form @param {number} keys @param {number} maxLen
   * @param {number} flags */
  constructor(number, name, form, keys, maxLen, flags) {
    this.number = number; this.name = name; this.form = form; this.keys = keys; this.maxLen = maxLen; this.flags = flags;
    Object.freeze(this);
  }
  get secret() { return !!(this.flags & FLAG.secret); }
  get restart() { return !!(this.flags & FLAG.restart); }
}

/**
 * One item as one of the classes above (another, or data not of its name's form: [name, key, data]).
 * @param {string} name @param {number} key @param {Uint8Array} d @param {Setting | null} [setting]
 * @param {readonly string[]} [netifs] @returns {Item | Triple}
 */
export function decode(name, key, d, setting = null, netifs = []) {
  if (name === 'label') return new Label({ channel: key, text: text(d) });
  if (name === 'wire-hold' && d.length === 1 && Object.values(HOLD_MODE).includes(d[0])) return new WireHold({ channel: key, mode: nameOf(HOLD_MODE, d[0]) });
  if (name === 'rvswd-rest' && d.length === 1 && Object.values(REST_MODE).includes(d[0])) return new RvswdRest({ channel: key, mode: nameOf(REST_MODE, d[0]) });
  if (name === 'idle' && d.length === 1) return new Idle({ channel: key, mode: nameOf(IDLE, d[0]) });
  if (name === 'disable' && !d.length) return new Disable({ channel: key });
  if (name === 'passthrough' && d.length === 9) {
    return new Passthrough({ port: key, fn: getU16(d), rx: getU16(d, 2), baud: getU32(d, 4), format: d[8] });
  }
  if (name === 'console-passthrough' && d.length === 13) {
    return new ConsolePassthrough({ port: key, wireFn: getU16(d), swdio: getU16(d, 2), swclk: getU16(d, 4),
      maxSpeed: getU32(d, 6), consoleFn: getU16(d, 10), mechanism: d[12] });
  }
  if (name === 'wifi' && d.length >= 2 && d.length === 2 + d[0]) {
    // get carries no passphrase (pass_len 0xFF: set, 0: none)
    return new Wifi({ entry: key, ssid: text(d.slice(1, 1 + d[0])), passphrase: d[1 + d[0]] === PASS_KEPT ? KEEP : null });
  }
  if (name === 'ipv4' && d.length === 14) {
    const netif = key >= 1 && key <= netifs.length ? netifs[key - 1] : String(key);
    const it = d[0] === IPV4_MODE.dhcp ? new Ipv4({ netif })
      : new Ipv4({ netif, address: `${ipText(d.slice(1, 5))}/${d[5]}`, gateway: ipText(d.slice(6, 10)), dns: ipText(d.slice(10, 14)) });
    it.number = key;
    return it;
  }
  if (setting && setting.form !== FORM.named) {
    const f = setting.form;
    if (setting.secret && !d.length) return new Own(name, null, key);
    if (f === FORM.text) return new Own(name, text(d), key);
    if (f === FORM.u32 && d.length === 4) return new Own(name, getU32(d), key);
    if (f === FORM.bool && d.length === 1) return new Own(name, !!d[0], key);
    if (f === FORM.ipv4 && d.length === 4) return new Own(name, [...d].join('.'), key);
    if (f === FORM.bytes) return new Own(name, d, key);
  }
  return [name, key, d];
}

/** `count` items from `data` -> [the [number, key, data] triples, what follows them: the answer's TLV tail].
 * @param {Uint8Array} data @param {number} count @returns {[[number, number, Uint8Array][], Uint8Array]} */
export function splitItems(data, count) {
  /** @type {[number, number, Uint8Array][]} */
  const out = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 5 > data.length) throw new m.ShortPayload(`item ${out.length} of ${count}: truncated`);
    const number = data[at], n = getU16(data, at + 1), key = getU16(data, at + 3);
    if (n < 2 || at + 3 + n > data.length) throw new m.ShortPayload(`item ${number}: truncated value`);
    out.push([number, key, data.slice(at + 5, at + 3 + n)]);
    at += 3 + n;
  }
  return [out, data.slice(at)];
}

/** An item as the (name, key, data) that compares (a wifi item's passphrase as get shows it: only whether one is set
 * counts - host guide §15.1). Own items need their form: `ProbeConfig.triple`. @param {Item | Triple} it
 * @param {number} [form] @returns {Triple} */
function asGet(it, form) {
  /** @type {Triple} */
  const t = Array.isArray(it) ? it : it instanceof Own ? [it.name, it.key(), it.encode(form ?? FORM.bytes)]
    : [/** @type {any} */ (it.constructor).NAME, it.key(), it.data()];
  return t[0] === 'wifi' ? [t[0], t[1], wifiGetForm(t[2])] : t;
}

/** @param {Triple} t */
const tripleId = (t) => `${t[0]}\u0000${t[1]}\u0000${Array.from(t[2]).join(',')}`;

/** Whether two configurations hold the same items (objects of the classes above or [name, key, data] triples), item by
 * item (host guide §15). A wifi item compares as get shows it: its passphrase is write-only, so a changed passphrase of
 * the same entry is not seen (set it with `set`; host guide §15.1). Own items compare by their value as text and bytes
 * by their form's encoding only through `ProbeConfig.apply`.
 * @param {(Item | Triple)[]} a @param {(Item | Triple)[]} b */
export function sameItems(a, b) {
  const x = a.map((it) => tripleId(asGet(it))).sort(), y = b.map((it) => tripleId(asGet(it))).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** What the probe's describe declares (fixed for one boot): the storage's size (0: no save / erase), the settings in
 * their order (item number = place) and the netifs. */
export class Declared {
  /** @param {number} storageBytes @param {Setting[]} settings @param {string[]} netifs */
  constructor(storageBytes = 0, settings = [], netifs = []) {
    this.storageBytes = storageBytes; this.settings = settings; this.netifs = netifs;
  }
  /** The names of the items the probe takes, in its order. */
  get items() { return this.settings.map((s) => s.name); }
  /** @param {string} name */
  netifNumber(name) {
    const i = this.netifs.indexOf(name);
    if (i < 0) throw new RangeError(`the probe has no netif ${JSON.stringify(name)}`);
    return i + 1;
  }
  /** @param {string} name */
  byName(name) {
    const s = this.settings.find((x) => x.name === name);
    if (!s) throw new RangeError(`the probe takes no item ${JSON.stringify(name)}`);
    return s;
  }
  /** @param {number} number @returns {Setting | null} */
  byNumber(number) { return this.settings[number - 1] ?? null; }
}

/**
 * The storage's state (op state, lock-free; probe.config §3): none, applied, unreadable or partial; the generation the
 * saved settings were saved or applied at (0: none, unreadable or partial); why it is not applied whole.
 * @typedef {{ storage: string, savedGeneration: number, reason: string | null }} State
 */
/**
 * One netif (op network, probe.config §2): state off / connecting / up / waiting, the wifi entry (null: none), the last
 * failure's reason, rssi (dBm, while up on Wi-Fi; else 0), and the address in use ("a.b.c.d/prefix").
 * @typedef {{ netif: string, state: string, entry: number | null, reason: string, rssi: number, address: string | null,
 *   gateway: string | null, dns: string | null }} NetifState
 */
/** @typedef {{ tcpPort: number, netifs: NetifState[] }} Network  tcpPort 0: not listening */

export class ProbeConfig extends Interface {
  static NAME = CFG.name;
  static REVISION = CFG.revision;
  static GET = CFG.op.get;
  static SET = CFG.op.set;
  static SAVE = CFG.op.save;
  static ERASE = CFG.op.erase;
  static UNSET = CFG.op.unset;
  static STATE = CFG.op.state;
  static NETWORK = CFG.op.network;

  /** One item on the wire: number(u8) len(u16) key(u16) data (probe.config §1); the number by name, for this boot.
   * @param {Item} it */
  async wire(it) {
    const [name, key, data] = await this.triple(it);
    return concat(new Writer().u8((await this.describe()).byName(name).number).u16(2 + data.length).u16(key).done(), data);
  }

  /** An item as [name, key, data] (an ipv4's netif and an own item's form from describe). @param {Item | Triple} it
   * @returns {Promise<Triple>} */
  async triple(it) {
    if (Array.isArray(it)) return it;
    const decl = await this.describe();
    if (it instanceof Ipv4) it.number = decl.netifNumber(it.netif);
    if (it instanceof Own) return [it.name, it.key(), it.encode(decl.byName(it.name).form)];
    return [/** @type {any} */ (it.constructor).NAME, it.key(), it.data()];
  }

  /** -> the generation and the items as [name, key, data] in get's order, paged. No lock. Every page carries the
   * generation; when it changes between pages the settings moved and the read starts over.
   * @returns {Promise<{ generation: number, items: Triple[] }>} */
  async get() {
    const decl = await this.describe();
    outer: for (;;) {
      /** @type {Triple[]} */
      const items = [];
      /** @type {number | null} */
      let first = null;
      for (;;) {
        const rd = new m.Reader((await this.call(ProbeConfig.GET, new Writer().u16(items.length).done(), { locked: false })).payload);
        const more = rd.u8(), generation = rd.u32(), count = rd.u8();
        const [page, tail] = splitItems(rd.rest(), count);
        m.Tail.parse(tail);                                          // the answer's own TLV tail, not items
        if (first === null) first = generation;
        else if (generation !== first) continue outer;               // changed under us: again from the start
        for (const [n, k, d] of page) items.push([decl.byNumber(n)?.name ?? String(n), k, d]);
        if (!more || !page.length) return { generation, items };
      }
    }
  }

  /** The current settings, decoded (Label, Idle, Disable, Passthrough, ConsolePassthrough, RvswdRest, WireHold, Wifi,
   * Ipv4, Own; [name, key, data] for others). @returns {Promise<(Item | Triple)[]>} */
  async items() {
    const decl = await this.describe();
    return (await this.get()).items.map(([n, k, d]) => decode(n, k, d, decl.settings.find((s) => s.name === n) ?? null, decl.netifs));
  }

  /** Items (objects of the classes above, or item bytes from `wire` / `item`) -> the new generation. Removals
   * (`remove()`) in the list go as an unset after the set (two requests; each is atomic by itself). Needs the lock.
   * @param {(Item | Removal | Uint8Array)[]} items */
  async set(items) {
    const removals = /** @type {Removal[]} */ (items.filter((it) => it instanceof Removal));
    const rest = /** @type {(Item | Uint8Array)[]} */ (items.filter((it) => !(it instanceof Removal)));
    let generation = 0;
    if (rest.length || !removals.length) {
      const parts = [];
      for (const it of rest) parts.push(it instanceof Uint8Array ? it : await this.wire(it));
      const body = concat(Uint8Array.of(rest.length), ...parts);
      await this.checkFits(body, rest.some((it) => it instanceof Wifi));
      generation = ProbeConfig.generationOf(await this.call(ProbeConfig.SET, body));
    }
    if (removals.length) generation = await this.unset(removals.map((r) => /** @type {[string, number]} */ ([r.kind, r.key])));
    return generation;
  }

  /** A set request longer than the probe's max_frame is refused here, before anything is sent (RangeError): the probe
   * could not take it. One set of the longest wifi item is wifi_min_max_frame bytes, and a probe with the wifi item
   * answers at least that on every transport (probe.config §1.4); several items may need several sets.
   * @param {Uint8Array} body @param {boolean} [wifi] */
  async checkFits(body, wifi = false) {
    const size = m.REQUEST_HEADER + this.prefix.length + body.length;
    const limit = (await this.host.confirmed()).maxFrame;
    if (size <= limit) return;
    throw new RangeError(`probe.config set of ${size} bytes exceeds this transport's max_frame ${limit}: `
      + (wifi && limit < WIFI_MIN_MAX_FRAME ? `a probe with the wifi item answers max_frame ${WIFI_MIN_MAX_FRAME} or more on `
        + 'every transport (probe.config §1.4) - this one does not; ' : '')
      + 'send fewer items per set');
  }

  /** Remove the items of these [name, key] (probe.config §2 unset): a key that is not there is nothing; the whole must
   * still be consistent or nothing changes. -> the new generation. Needs the lock.
   * @param {[string, number][]} keys */
  async unset(keys) {
    const decl = await this.describe();
    const w = new Writer().u8(keys.length);
    for (const [name, key] of keys) w.u8(decl.byName(name.replace(/_/g, '-')).number).u16(key);
    return ProbeConfig.generationOf(await this.call(ProbeConfig.UNSET, w.done()));
  }

  /** @param {m.Result} r */
  static generationOf(r) {
    const rd = new m.Reader(r.payload);
    const generation = rd.u32();
    rd.tail();
    return generation;
  }

  /** Save the current settings (a probe with storage; the whole is replaced). -> the current generation (which by itself
   * does not say the save succeeded: completed failed does, and `state`). Needs the lock. Its argument time is
   * max_op_ms (probe.config §3, core §4.4). */
  async save() { return ProbeConfig.generationOf(await this.call(ProbeConfig.SAVE, undefined, { expectMs: await maxOpMs(this.host) })); }

  /** Whether a save would change what is stored (host guide §15 step 4): not when the storage is applied and its
   * saved_generation is the current generation (get's). */
  async needsSave() {
    const st = await this.state();
    return !(st.storage === 'applied' && st.savedGeneration === (await this.get()).generation);
  }

  /** Make the probe's settings `wanted` (host guide §15): get, compared item by item (`sameItems`; a wifi item by its
   * ssid and whether it has a passphrase); when they differ, unset the keys get has and `wanted` does not (first, so a
   * disable can replace an idle, §1) and set what is wanted - a wifi entry the probe has as wanted goes with pass_len
   * 0xFF, so no passphrase is sent again (host guide §15.1); with `save`, save when `needsSave`. -> whether anything was
   * sent. Needs the lock when something changes.
   * @param {(Item | Triple)[]} wanted @param {{ save?: boolean }} [opts] */
  async apply(wanted, { save = false } = {}) {
    const have = (await this.get()).items;
    /** @type {Triple[]} */
    const want = [];
    for (const it of wanted) want.push(await this.triple(it));
    let changed = false;
    if (!sameItems(have, want)) {
      const keyId = (/** @type {Triple} */ t) => `${t[0]}\u0000${t[1]}`;
      const keys = new Set(want.map(keyId));
      /** @type {Map<string, [string, number]>} */
      const gone = new Map();
      for (const t of have) if (!keys.has(keyId(t))) gone.set(keyId(t), [t[0], t[1]]);
      if (gone.size) await this.unset([...gone.values()]);
      const had = new Map(have.map((t) => [keyId(t), t[2]]));
      const decl = await this.describe();
      await this.set(want.map(([n, k, d]) => {
        const shown = n === 'wifi' ? wifiGetForm(d) : d;
        const had_ = had.get(`${n}\u0000${k}`);
        const data = n === 'wifi' && had_ && equal(shown, had_) ? shown : d;
        return concat(new Writer().u8(decl.byName(n).number).u16(2 + data.length).u16(k).done(), data);
      }));
      changed = true;
    }
    if (save && await this.needsSave()) {
      await this.save();
      changed = true;
    }
    return changed;
  }

  /** Erase what is saved (the current settings stay). Needs the lock. Its argument time is max_op_ms. */
  async erase() { await this.call(ProbeConfig.ERASE, undefined, { expectMs: await maxOpMs(this.host) }); }

  /** The declarations (describe, cached by the host while the probe's boot_id holds: the numbers are for that boot
   * only). @returns {Promise<Declared>} */
  async describe() {
    const tlvs = await describe(this.host, this.fn);
    const storage = firstFixed(tlvs, DESCRIBE.storage, 4);
    /** @type {Setting[]} */
    const settings = [];
    for (const [tag, v] of tlvs) {
      if (tag === DESCRIBE.setting && v.length >= 6) {
        settings.push(new Setting(settings.length + 1, text(v.slice(5)), v[0], getU16(v, 1), v[3], v[4]));
      }
    }
    const netifs = tlvs.filter(([tag]) => tag === DESCRIBE.netif).map(([, v]) => text(v));
    return new Declared(storage ? getU32(storage) : 0, settings, netifs);
  }

  /** The storage's state (op state, lock-free; probe.config §3): storage_state, saved_generation, reason.
   * @returns {Promise<State>} */
  async state() {
    const rd = new m.Reader((await this.call(ProbeConfig.STATE, undefined, { locked: false })).payload);
    const storage = rd.u8(), savedGeneration = rd.u32(), why = rd.u8();
    rd.tail();
    return { storage: STORAGE_STATE[storage] ?? String(storage), savedGeneration, reason: why ? (UNREADABLE[why] ?? String(why)) : null };
  }

  /** The network now (op network, lock-free; probe.config §2): the TCP port and each netif's state.
   * @returns {Promise<Network>} */
  async network() {
    const netifs = (await this.describe()).netifs;
    const rd = new m.Reader((await this.call(ProbeConfig.NETWORK, undefined, { locked: false })).payload);
    const tcpPort = rd.u16(), count = rd.u8();
    /** @type {NetifState[]} */
    const out = [];
    for (let i = 0; i < count; i++) {
      const netif = rd.u8(), state = rd.u8(), entry = rd.u16(), reason = rd.u8(), rssiByte = rd.u8();
      const addr = rd.bytes(4), prefix = rd.u8(), gw = rd.bytes(4), dns = rd.bytes(4);
      out.push({ netif: netif >= 1 && netif <= netifs.length ? netifs[netif - 1] : String(netif),
        state: NET_STATE[state] ?? String(state), entry: entry === NO_ENTRY ? null : entry,
        reason: NET_REASON[reason] ?? String(reason), rssi: rssiByte >= 0x80 ? rssiByte - 0x100 : rssiByte,
        address: addr.some((x) => x) ? `${ipText(addr)}/${prefix}` : null, gateway: ipText(gw), dns: ipText(dns) });
    }
    rd.tail();
    return { tcpPort, netifs: out };
  }
}

/** The line names of the label convention (host guide §5.3), the registry's standard names: `nrst` a target's reset,
 * `power_hi` high powers it, `power_lo` low powers it, and the debug / UART lines. With several targets,
 * `<profile>.<name>` (the host's connection profile name). */
export const LINE_NAMES = Object.freeze(Object.keys(CFG.line_names));

/** ASCII case folded (only A-Z: the convention compares ignoring ASCII case). @param {string} text */
export function foldName(text) { return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)); }

/** The ports the settings' labels name (host guide §5.3): the distinct S of the "S.N" labels, folded, in order.
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
 * Host guide §5.3 on bare data: labels as [channel, text] - the settings' label items - firmware the firmware's fixed
 * labels (fn 0 describe) as [channel, text]. In order, stopping at the first step that finds exactly one channel: (a)
 * with a port name (`profile`), a settings label equal to `<port>.<name>`; (b) only while at most one port is named
 * (`single`; by default from the labels: the distinct S of "S.N"), a settings label equal to `name`; (c) the same, a
 * firmware label equal to `name`. A step that finds two or more ends the search with none (ambiguous). Texts compare
 * ignoring ASCII case.
 * @param {Iterable<[number, string]>} labels @param {string} name
 * @param {{ profile?: string | null, firmware?: Iterable<[number, string]>, single?: boolean | null }} [opts]
 * @returns {number | null}
 */
export function lineFromLabels(labels, name, { profile = null, firmware = [], single = null } = {}) {
  const settings = [...labels], fixed = [...firmware];
  const one = single ?? portsNamed(settings).length <= 1;
  /** @type {[[number, string][], string][]} */
  const steps = [];
  if (profile !== null && profile !== undefined) steps.push([settings, `${profile}.${name}`]);
  if (one) steps.push([settings, name], [fixed, name]);
  for (const [source, t] of steps) {
    const want = foldName(t);
    const found = new Set(source.filter(([, x]) => foldName(x) === want).map(([ch]) => ch));
    if (found.size > 1) return null;                                 // ambiguous at this step: no such line
    if (found.size) return [...found][0];
  }
  return null;
}

/**
 * The channel of the line `name` (nrst, power_hi, power_lo: LINE_NAMES) by the label convention (host guide §5.3), or
 * null. config: a Host (its settings are read with `ProbeConfig.items()`, no lock) or the decoded items. profile: the
 * port's name (the S of its "S.N" labels); `single`: whether at most one port is named (by default from the labels);
 * firmware: the fixed labels as [channel, text] - read from the probe's describe when `config` is a Host, none when it
 * is a list of items and this is not given.
 * @param {import('./host.js').Host | (Item | Triple)[]} config @param {string} name
 * @param {{ profile?: string | null, firmware?: Iterable<[number, string]> | null, single?: boolean | null }} [opts]
 * @returns {Promise<number | null>}
 */
export async function findLine(config, name, { profile = null, firmware = null, single = null } = {}) {
  const items = Array.isArray(config) ? config : await (await ProbeConfig.open(config)).items();
  const fixed = firmware ? [...firmware] : Array.isArray(config) ? [] : await firmwareLabels(config);
  const labels = /** @type {Label[]} */ (items.filter((i) => i instanceof Label)).map((l) => /** @type {[number, string]} */ ([l.channel, l.text]));
  return lineFromLabels(labels, name, { profile, firmware: fixed, single });
}
