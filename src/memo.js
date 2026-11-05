// @ts-check
// SPDX-License-Identifier: MIT
// The memo area (oep-spec interfaces/oep-if-memo): named objects a host keeps on the probe, as oep-client-python's
// oep_client.memo.
//
//   const mm = await Memo.open(host);
//   await mm.write('oep.probe.memo/port/x035', utf8(JSON.stringify({ target: 'ch32x035-...' })));   // the lock
//   const data = await mm.read('oep.probe.memo/port/x035');   // MemoTorn when its CRC-32 does not match its crc
//   const entries = await mm.list('oep.probe.memo/');
//
// The probe never reads the objects; names are byte strings compared as they are (1..64 bytes of text). The names and
// contents the spec recommends (oep-if-memo §4) are portRecordName() and the port record.
import * as reg from './registry.js';
import { Writer, getU16, getU32, utf8, text } from './bytes.js';
import * as m from './message.js';
import { Interface, describe } from './core.js';
import { NoResource } from './errors.js';

const R = reg.PROBE_MEMO;
const OP = R.op;
const NAME_MAX = 64;

/** CRC-32/ISO-HDLC (oep-if-memo §1): zlib's; 0 for no data. @param {Uint8Array} b */
export function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string | Uint8Array} v */
function textField(v) {
  const b = typeof v === 'string' ? utf8(v) : v;
  if (b.length > NAME_MAX) throw new RangeError(`memo name / prefix of ${b.length} bytes: at most ${NAME_MAX}`);
  return Uint8Array.of(b.length, ...b);
}

/** An object whose data does not match its crc (oep-if-memo §3): write it again or delete it. */
export class MemoTorn extends m.OepError {}

/** The project's port record's name (oep-if-memo §4.3): the port's name lower-cased. @param {string} port */
export function portRecordName(port) {
  return `${R.name}/port/${port.replace(/[A-Z]/g, (c) => c.toLowerCase())}`;
}

/** @typedef {{ name: Uint8Array, size: number, crc: number }} MemoEntry */

export class Memo extends Interface {
  static NAME = R.name;
  static REVISION = R.revision;

  /** describe's max_object (u32) and max_objects (u16). @returns {Promise<{ maxObject: number, maxObjects: number }>} */
  async limits() {
    const d = new Map(await describe(this.host, this.fn));
    const o = d.get(R.tlv.describe.max_object), n = d.get(R.tlv.describe.max_objects);
    return { maxObject: o ? getU32(o) : 0, maxObjects: n ? getU16(n) : 0 };
  }

  async frame() { return (await this.host.confirmed()).maxFrame; }

  /** @param {string | Uint8Array} [prefix] @returns {Promise<MemoEntry[]>} */
  async list(prefix = '') {
    /** @type {MemoEntry[]} */
    const out = [];
    for (let first = 0; ;) {
      const rd = new m.Reader((await this.call(OP.list, new Writer().u16(first).raw(textField(prefix)).done(), { locked: false })).payload);
      const more = rd.u8(), count = rd.u8();
      for (let i = 0; i < count; i++) {
        const name = rd.bytes(rd.u8());
        out.push({ name, size: rd.u32(), crc: rd.u32() });
      }
      first += count;
      if (!more || !count) return out;
    }
  }

  /** @param {string | Uint8Array} name @param {{ check?: boolean }} [opts] @returns {Promise<Uint8Array>} */
  async read(name, { check = true } = {}) {
    const room = Math.min(0xffff, (await this.frame()) - m.RESULT_HEADER - 10);
    const head = textField(name);
    /** @type {number[]} */
    const data = [];
    let size = -1, crc = 0;
    while (size < 0 || data.length < size) {
      const rd = new m.Reader((await this.call(OP.read, new Writer().raw(head).u32(data.length).u16(room).done(), { locked: false })).payload);
      size = rd.u32(); crc = rd.u32();
      const n = rd.u16();
      if (n === 0 && data.length < size) throw new m.ProtocolError(`memo read gave no data at offset ${data.length} of ${size}`);
      data.push(...rd.bytes(n));
    }
    const out = Uint8Array.from(data);
    if (check && crc32(out) !== crc) throw new MemoTorn(`memo object ${typeof name === 'string' ? name : text(name)}: crc does not match its data`);
    return out;
  }

  /** In parts at the route's max_frame (the lock). @param {string | Uint8Array} name @param {Uint8Array} data */
  async write(name, data) {
    const head = textField(name);
    const room = (await this.frame()) - m.REQUEST_HEADER - head.length - 14;
    const crc = crc32(data);
    for (let at = 0; ;) {
      const part = data.slice(at, at + room);
      await this.call(OP.write, new Writer().raw(head).u32(data.length).u32(at).u32(crc).u16(part.length).raw(part).done());
      at += part.length;
      if (at >= data.length) return;
    }
  }

  /** @param {string | Uint8Array} name */
  async delete(name) { await this.call(OP.delete, textField(name)); }

  /** The port record (oep-if-memo §4.3) as JSON, or null when there is none. @param {string} port */
  async readPortRecord(port) {
    try {
      return JSON.parse(text(await this.read(portRecordName(port))));
    } catch (e) {
      if (e instanceof NoResource) return null;
      throw e;
    }
  }

  /** Merge `fields` into the port record, keeping the members this host does not know (oep-if-memo §4.2: read and write
   * in one locked session). Fields set to null are taken out. @param {string} port @param {Record<string, any>} fields */
  async updatePortRecord(port, fields) {
    const record = (await this.readPortRecord(port)) ?? {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === '') delete record[k]; else record[k] = v;
    }
    const name = portRecordName(port);
    if (!Object.keys(record).length) {
      try { await this.delete(name); } catch { /* there was none */ }
      return record;
    }
    await this.write(name, utf8(JSON.stringify(record)));
    return record;
  }
}
