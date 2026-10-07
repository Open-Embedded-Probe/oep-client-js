// @ts-check
// Finding probes that serve OEP over TCP on the local network (transports §3, host guide §4.1): DNS-SD (RFC 6763)
// service `_oep._tcp` over mDNS (RFC 6762), with node:dgram alone - no dependency. Node only: a browser cannot send
// mDNS (nor open TCP), so the page never looks for TCP probes.
//
//   for (const p of await browse({ timeoutMs: 2000 })) console.log(p.unitId, p.host, p.port, p.addresses);
//   const one = await findUnit('fafe00000003');           // by its TXT unit_id
//   const hst = await openTcp({ unitId: 'fafe00000003' });  // found so, then describe's unit_id checked
//
// A probe listening on TCP advertises an instance of `_oep._tcp` while it listens: the port is the SRV record's (none
// is fixed), the TXT record carries `unit_id=<unit_id>` (fn 0's describe's; other keys are kept and not looked at), the
// instance and host names are the probe's. A host uses a named probe only when describe's unit_id after opening is the
// one it named (openTcp's `unitId` checks it).
//
// The query is a minimal one-shot browse, as oep-client-python's own (its discovery module without python-zeroconf):
// PTR `_oep._tcp.local` (then SRV / TXT / A for what the answers left out), sent to 224.0.0.251:5353 out of every IPv4
// interface (one send from 0.0.0.0 leaves by one adapter only - on Windows often WSL's vEthernet, not the Wi-Fi) from
// an ephemeral port with the unicast-response bit, so responders answer that socket directly (RFC 6762 §5.4, §6.7); a
// socket on 5353, in the group on every interface, also listens for multicast answers when the port can be shared; the
// answers are merged. IPv4 only.
//
// mDNS stays on the local link: behind a NAT (WSL 2's default network, a VM) or across subnets nothing is found - give
// the probe's address and port then (openTcp({ host, port }); the address is also in probe.config's state over another
// transport: the wifi state's ipv4).
import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';

export const SERVICE = '_oep._tcp.local.';
export const MDNS_GROUP = '224.0.0.251';
export const MDNS_PORT = 5353;
export const T_A = 1, T_PTR = 12, T_TXT = 16, T_SRV = 33;
/** A question's class bit: a unicast response wanted (RFC 6762 §5.4). */
export const QU = 0x8000;

/**
 * One announced probe: the DNS-SD instance (its label), its unit_id (TXT; null when absent), the SRV host and port, the
 * IPv4 addresses of that host, the TXT keys.
 * @typedef {object} Found
 * @property {string} instance
 * @property {string | null} unitId
 * @property {string} host
 * @property {number} port
 * @property {string[]} addresses
 * @property {Record<string, string>} txt
 */

/** Where to open a found probe: { host, port } (the first address, else the host name), or null without an SRV port.
 * @param {Found} f */
export function targetOf(f) {
  const where = f.addresses[0] ?? f.host.replace(/\.$/, '');
  return f.port && where ? { host: where, port: f.port } : null;
}

// ---- the DNS message form (RFC 1035 §4), only what a browse needs ---------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {string} name */
export function encodeName(name) {
  /** @type {number[]} */
  const out = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    const raw = enc.encode(label);
    if (raw.length < 1 || raw.length > 63) throw new RangeError(`DNS label ${JSON.stringify(label)}: 1 to 63 bytes`);
    out.push(raw.length, ...raw);
  }
  out.push(0);
  return out;
}

/** A query with these [name, type] questions, class IN (with the QU bit when `unicast`).
 * @param {[string, number][]} questions @param {number} [id] @param {boolean} [unicast] */
export function query(questions, id = 0, unicast = true) {
  const out = [id >> 8, id & 0xff, 0, 0, 0, questions.length, 0, 0, 0, 0, 0, 0];
  const cls = 1 | (unicast ? QU : 0);
  for (const [name, type] of questions) out.push(...encodeName(name), type >> 8, type & 0xff, cls >> 8, cls & 0xff);
  return Uint8Array.from(out);
}

/** A name at `at` (compression pointers followed, RFC 1035 §4.1.4) -> [name with a trailing dot, the offset past it].
 * @param {Uint8Array} data @param {number} at @returns {[string, number]} */
function readName(data, at) {
  /** @type {string[]} */
  const labels = [];
  let end = -1, jumps = 0;
  for (;;) {
    if (at >= data.length) throw new RangeError('name past the end');
    const n = data[at];
    if ((n & 0xc0) === 0xc0) {
      if (at + 1 >= data.length || jumps > 32) throw new RangeError('bad compression pointer');
      if (end < 0) end = at + 2;
      at = ((n & 0x3f) << 8) | data[at + 1];
      jumps++;
      continue;
    }
    if (n & 0xc0) throw new RangeError('unknown label type');
    if (n === 0) return [`${labels.join('.')}.`, end >= 0 ? end : at + 1];
    if (at + 1 + n > data.length) throw new RangeError('label past the end');
    labels.push(dec.decode(data.subarray(at + 1, at + 1 + n)));
    at += 1 + n;
  }
}

/** @typedef {[string, typeof T_PTR, string] | [string, typeof T_SRV, [string, number]] | [string, typeof T_TXT, Record<string, string>] | [string, typeof T_A, string]} Rec */

/** Every resource record of a response (answers, authority, additional) as [name, type, data]: PTR -> name, SRV ->
 * [target, port], TXT -> { key: value } (keys lower-cased, the first of a key kept), A -> dotted address; other types
 * are left out. A query (QR 0) gives none; a broken record ends the packet (what came before counts).
 * @param {Uint8Array} packet @returns {Rec[]} */
export function records(packet) {
  if (packet.length < 12) return [];
  const u16 = (/** @type {number} */ i) => (packet[i] << 8) | packet[i + 1];
  if (!(packet[2] & 0x80)) return [];
  const qd = u16(4), n = u16(6) + u16(8) + u16(10);
  /** @type {Rec[]} */
  const out = [];
  let at = 12;
  try {
    for (let i = 0; i < qd; i++) at = readName(packet, at)[1] + 4;
    for (let i = 0; i < n; i++) {
      const [name, next] = readName(packet, at);
      at = next;
      if (at + 10 > packet.length) break;
      const type = u16(at), rdlen = u16(at + 8);
      const rdata = at + 10;
      at = rdata + rdlen;
      if (at > packet.length) break;
      if (type === T_PTR) out.push([name, T_PTR, readName(packet, rdata)[0]]);
      else if (type === T_SRV && rdlen >= 7) out.push([name, T_SRV, [readName(packet, rdata + 6)[0], u16(rdata + 4)]]);
      else if (type === T_TXT) {
        /** @type {Record<string, string>} */
        const txt = {};
        for (let j = rdata; j < at;) {
          const len = packet[j];
          const entry = dec.decode(packet.subarray(j + 1, Math.min(j + 1 + len, at)));
          j += 1 + len;
          if (!entry) continue;
          const eq = entry.indexOf('=');
          const key = (eq < 0 ? entry : entry.slice(0, eq)).toLowerCase();
          if (!(key in txt)) txt[key] = eq < 0 ? '' : entry.slice(eq + 1);
        }
        out.push([name, T_TXT, txt]);
      } else if (type === T_A && rdlen === 4) out.push([name, T_A, [...packet.subarray(rdata, at)].join('.')]);
    }
  } catch {
    /* a broken record ends the packet */
  }
  return out;
}

/** What the answers have said so far, and the questions still open (`feed` takes a response packet). */
export class Browser {
  constructor(service = SERVICE) {
    this.service = service.toLowerCase();
    /** @type {Set<string>} */ this.instances = new Set();
    /** @type {Map<string, [string, number]>} */ this.srv = new Map();
    /** @type {Map<string, Record<string, string>>} */ this.txt = new Map();
    /** @type {Map<string, string[]>} */ this.a = new Map();
  }

  /** @param {Uint8Array} packet */
  feed(packet) {
    for (const [name, type, data] of records(packet)) {
      const key = name.toLowerCase();
      if (type === T_PTR && key === this.service) this.instances.add(/** @type {string} */ (data));
      else if (type === T_SRV) this.srv.set(key, /** @type {[string, number]} */ (data));
      else if (type === T_TXT) this.txt.set(key, /** @type {Record<string, string>} */ (data));
      else if (type === T_A) {
        const list = this.a.get(key) ?? [];
        if (!list.includes(/** @type {string} */ (data))) list.push(/** @type {string} */ (data));
        this.a.set(key, list);
      }
    }
  }

  /** The PTR question, and SRV / TXT / A for what is still missing. @returns {[string, number][]} */
  questions() {
    /** @type {[string, number][]} */
    const out = [[this.service, T_PTR]];
    for (const inst of [...this.instances].sort()) {
      const k = inst.toLowerCase();
      if (!this.srv.has(k)) out.push([inst, T_SRV]);
      if (!this.txt.has(k)) out.push([inst, T_TXT]);
      const host = this.srv.get(k)?.[0];
      if (host && !this.a.has(host.toLowerCase())) out.push([host, T_A]);
    }
    return out;
  }

  /** @returns {Found[]} */
  found() {
    return [...this.instances].sort().map((inst) => {
      const k = inst.toLowerCase();
      const [host, port] = this.srv.get(k) ?? ['', 0];
      const txt = this.txt.get(k) ?? {};
      const label = k.endsWith(`.${this.service}`) ? inst.slice(0, inst.length - this.service.length - 1) : inst;
      return { instance: label.replace(/\\032/g, ' '), unitId: txt.unit_id || null, host, port,
        addresses: [...(this.a.get(host.toLowerCase()) ?? [])], txt };
    });
  }
}

/** The IPv4 addresses of this host's interfaces that are up and not internal (os.networkInterfaces()): the query goes
 * out of each, since one send leaves by one adapter only (on Windows often a virtual one, WSL's vEthernet, missing the
 * probes on Wi-Fi). @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} [nets] @returns {string[]} */
export function interfaceAddresses(nets = networkInterfaces()) {
  /** @type {string[]} */
  const out = [];
  for (const list of Object.values(nets)) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || /** @type {unknown} */ (a.family) === 4;
      if (v4 && !a.internal && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** A UDP socket, bound (null when it cannot be). `iface` (an address of this host): the query socket sends out of that
 * interface and is bound to it, so the unicast answers to its queries come back to it; none: the system's choice.
 * `group`: on 5353, in the mDNS group on each of `joins` (none: the system's choice of interface).
 * @param {{ group?: boolean, iface?: string, joins?: string[] }} o @returns {Promise<import('node:dgram').Socket | null>} */
function socketFor({ group = false, iface, joins = [] }) {
  return new Promise((resolve) => {
    const s = createSocket({ type: 'udp4', reuseAddr: group });
    s.once('error', () => { try { s.close(); } catch { /* not open */ } resolve(null); });
    s.bind(group ? { port: MDNS_PORT } : { port: 0, address: iface }, () => {
      try {
        if (group) {
          let joined = 0;
          for (const at of joins.length ? joins : [undefined]) {
            try { s.addMembership(MDNS_GROUP, at); joined++; } catch { /* that interface takes no multicast */ }
          }
          if (!joined) throw new Error('no interface joined the mDNS group');
        } else {
          s.setMulticastTTL(255);
          if (iface) s.setMulticastInterface(iface);
        }
      } catch {
        try { s.close(); } catch { /* not open */ }
        resolve(null);
        return;
      }
      s.removeAllListeners('error');
      s.on('error', () => { /* a late error: nothing more from this socket */ });
      resolve(s);
    });
  });
}

/**
 * Every probe announcing `_oep._tcp` within `timeoutMs` (default 2000), the answers of every interface merged. The query
 * goes out of every IPv4 interface (`interfaces`, default `interfaceAddresses()`: one socket each, bound to that
 * address with its multicast interface set), and once more with the system's choice; it is sent at once and again at
 * 250, 500, 1000 ms gaps (each time with the questions still open). An interface that cannot send multicast is left
 * out; none at all: none found.
 * @param {{ timeoutMs?: number, service?: string, interfaces?: string[] }} [opts] @returns {Promise<Found[]>}
 */
export async function browse({ timeoutMs = 2000, service = SERVICE, interfaces = interfaceAddresses() } = {}) {
  const b = new Browser(service);
  const senders = /** @type {import('node:dgram').Socket[]} */ ((await Promise.all([socketFor({}),
    ...interfaces.map((iface) => socketFor({ iface }))])).filter(Boolean));
  if (!senders.length) return [];
  const g = await socketFor({ group: true, joins: interfaces });   // 5353 taken without sharing: unicast answers only
  const socks = g ? [...senders, g] : senders;
  for (const s of socks) s.on('message', (msg) => b.feed(new Uint8Array(msg.buffer, msg.byteOffset, msg.length)));
  const send = () => {
    const packet = query(b.questions(), randomInt(0x10000));
    for (const s of senders) s.send(packet, MDNS_PORT, MDNS_GROUP, () => { /* no route there: nothing from it */ });
  };
  try {
    const deadline = Date.now() + timeoutMs;
    let gap = 250;
    while (Date.now() < deadline) {
      send();
      await new Promise((r) => setTimeout(r, Math.min(gap, Math.max(0, deadline - Date.now()))));
      gap = Math.min(gap * 2, 1000);
    }
  } finally {
    for (const s of socks) { try { s.close(); } catch { /* closed */ } }
  }
  return b.found();
}

/** The probe whose TXT unit_id is `unitId` (ASCII case ignored) and that has an SRV port. Throws when none answers
 * within `timeoutMs` (default 3000). @param {string} unitId @param {{ timeoutMs?: number, browse?: typeof browse }} [opts] */
export async function findUnit(unitId, { timeoutMs = 3000, browse: look = browse } = {}) {
  const hit = (await look({ timeoutMs })).find((f) => (f.unitId ?? '').toLowerCase() === unitId.toLowerCase() && targetOf(f));
  if (!hit) {
    throw new Error(`no probe with unit_id ${unitId} announces ${SERVICE.replace(/\.$/, '')} on this network (DNS-SD over `
      + 'mDNS stays on the local link: behind a NAT give its address and port)');
  }
  return hit;
}

/** The SRV port of the probe announced on `host` (its host name, with or without .local, or one of its addresses);
 * null when none is found. @param {string} host @param {{ timeoutMs?: number, browse?: typeof browse }} [opts] */
export async function portOf(host, { timeoutMs = 2000, browse: look = browse } = {}) {
  const want = host.toLowerCase().replace(/\.$/, '');
  for (const f of await look({ timeoutMs })) {
    const name = f.host.toLowerCase().replace(/\.$/, '');
    if ((want === name || want === name.replace(/\.local$/, '') || f.addresses.includes(want)) && f.port) return f.port;
  }
  return null;
}
