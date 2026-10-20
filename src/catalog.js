// @ts-check
// Capability discovery by name (oep-core §7.2-§7.4).
//
//   list request : first(u16)                                            every interface from the first-th; the host
//                                                                         filters by name
//   list result  : total(u16) count(u8) count x entry [TLV]               fn 0 (the core) has no name and is never listed
//   list entry   : fn(u16) instance(u16) revision(u8) name_len(u8) name   6 bytes and the name
//   describe     : request fn(u16) first(u16); result more(u8) then TLVs (tag u8, len u16, value; tag bit 7 =
//                  critical). A describe is declarations only (core §7.3): the host caches it while the probe's
//                  boot_id stays the same.
//   ops          : the common describe tag 0x07 every fn carries, base(u8) bitmap: bit i set = op base + i is offered
//                  (core §1.2, §7.4) - the one declaration of an fn's ops, the optional ones included. A value is
//                  base and a bitmap of 1 byte or more, base + 8 x bitmap bytes <= 256 (`checkOps`); one set may have
//                  several values. A host does not use an fn whose ops breaks this, nor the probe when it is fn 0's
//   channel_group: group(u8) n(u8) then n x (role(u8), channel(u16)): a fixed pin set (core §7.4)

import * as reg from './registry.js';
import { Writer, getU16, getU32, utf8 } from './bytes.js';
import { Reader, shown, splitTlvs } from './message.js';

export const COMMON = reg.DESCRIBE_COMMON;
export const CRITICAL = 0x80;
export const INTERFACE_TAG_FIRST = 0x40;

/** @typedef {{ fn: number, instance: number, revision: number, name: string }} ListEntry */

/** list's request: first(u16) - the entries from the first-th on (core §7.2). @param {number} first */
export function packListRequest(first = 0) {
  return new Writer().u16(first).done();
}

/** @param {Uint8Array} payload @returns {{ total: number, entries: ListEntry[] }} */
export function unpackListResult(payload) {
  const rd = new Reader(payload);
  const total = rd.u16(), count = rd.u8();
  /** @type {ListEntry[]} */
  const entries = [];
  for (let i = 0; i < count; i++) {                    // count x entry, no element length (core §2.3)
    const fn = rd.u16(), instance = rd.u16(), revision = rd.u8(), n = rd.u8();
    entries.push({ fn, instance, revision, name: shown(rd.bytes(n)) });   // shown as core §2.1 says
  }
  rd.tail();
  return { total, entries };
}

/** @param {number} fn @param {number} first */
export function packDescribeRequest(fn, first) { return new Writer().u16(fn).u16(first).done(); }

/** The ops tag's value (core §7.4): base = the lowest op rounded down to a multiple of 8, then the bitmap (any value that
 * names the set is valid; this one never passes op 0xFF and is the spec's own generator's). An empty set has none
 * (RangeError).
 * @param {Iterable<number>} ops */
export function packOps(ops) {
  const list = [...new Set(ops)].sort((a, b) => a - b);
  if (!list.length) throw new RangeError('an ops value declares at least one op (core §7.4)');
  if (list[0] < 0 || list[list.length - 1] > 0xff) throw new RangeError('an op is u8');
  const base = list[0] & ~7;
  const out = new Uint8Array(2 + Math.floor((list[list.length - 1] - base) / 8));
  out[0] = base;
  for (const op of list) out[1 + Math.floor((op - base) / 8)] |= 1 << ((op - base) % 8);
  return out;
}

/** Whether an ops value keeps core §7.4's form: base(u8) and a bitmap of 1 byte or more, base + 8 x bitmap bytes
 * <= 256 (no bit past op 0xFF). -> '' or why not.
 * @param {Uint8Array} v */
export function checkOps(v) {
  if (v.length < 2) return `ops is ${v.length} bytes (base and a bitmap of 1 byte or more)`;
  if (v[0] + 8 * (v.length - 1) > 0x100) return `ops base 0x${v[0].toString(16)} with ${v.length - 1} bitmap bytes goes past op 0xff`;
  return '';
}

/** The ops an ops value declares (bit i of the bitmap = op base + i; bits past 0xFF mean nothing). Reads any value;
 * `checkOps` says whether it may be used.
 * @param {Uint8Array} v @returns {Set<number>} */
export function unpackOps(v) {
  const out = new Set();
  if (!v.length) return out;
  const base = v[0];
  for (let i = 1; i < v.length; i++) {
    for (let b = 0; b < 8; b++) if ((v[i] >> b) & 1 && base + (i - 1) * 8 + b <= 0xff) out.add(base + (i - 1) * 8 + b);
  }
  return out;
}

/** A channel_group value (core §7.4: group(u8) n(u8) n x (role(u8) channel(u16))) -> { group, pins }; a value of another
 * length throws RangeError (broken, core §2.3).
 * @param {Uint8Array} v @returns {{ group: number, pins: [number, number][] }} */
export function unpackChannelGroup(v) {
  if (v.length < 2 || v.length !== 2 + 3 * v[1]) throw new RangeError(`channel_group of ${v.length} bytes`);
  /** @type {[number, number][]} */
  const pins = [];
  for (let i = 0; i < v[1]; i++) pins.push([v[2 + 3 * i], getU16(v, 3 + 3 * i)]);
  return { group: v[0], pins };
}

/** The value of the first TLV `tag` (core §2.3: a tag the definition does not repeat, sent twice - the reader uses the
 * first; a first copy that is broken is not used, and no later copy stands in for it). undefined: no such TLV.
 * @param {[number, Uint8Array][]} tlvs @param {number} tag */
export function firstValue(tlvs, tag) { return tlvs.find(([t]) => t === tag)?.[1]; }

/** The first TLV `tag`'s value when it has its defined length `size` (core §2.3: a value without its definition's length
 * is broken and not used; a later copy never stands in for the first; core §2.2: a tag with bit 7 in an answer is an
 * unknown one, never this tag). undefined: absent or broken.
 * @param {[number, Uint8Array][]} tlvs @param {number} tag @param {number} size */
export function firstFixed(tlvs, tag, size) {
  const v = firstValue(tlvs, tag);
  return v !== undefined && v.length === size ? v : undefined;
}

/** @param {number} base @param {Uint8Array} bitmap */
export function bitmapToChannels(base, bitmap) {
  /** @type {number[]} */
  const out = [];
  bitmap.forEach((byte, i) => { for (let b = 0; b < 8; b++) if ((byte >> b) & 1) out.push(base + i * 8 + b); });
  return out;
}

/** @param {Iterable<number>} channels @returns {[number, Uint8Array]} */
export function channelsToBitmap(channels) {
  const chans = [...new Set(channels)].sort((a, b) => a - b);
  if (!chans.length) return [0, new Uint8Array(0)];
  const base = chans[0];
  const bits = new Uint8Array(Math.floor((chans[chans.length - 1] - base) / 8) + 1);
  for (const c of chans) bits[Math.floor((c - base) / 8)] |= 1 << ((c - base) % 8);
  return [base, bits];
}

/**
 * The common describe tags decoded; interface-specific and unknown ones kept raw, in order. ops: the ops tag (core §7.4),
 * null when the describe carries none or its value breaks core §7.4.
 * @typedef {object} Description
 * @property {Map<number, number[]>} roles         role -> the channels it may take
 * @property {Map<number, [number, number][]>} groups  group -> (role, channel) of a fixed pin set
 * @property {number | null} maxClockHz
 * @property {number | null} minClockHz
 * @property {number | null} maxLength
 * @property {number | null} features
 * @property {Set<number> | null} ops
 * @property {string} opsInvalid                    why the ops value breaks core §7.4's form ('' when it does not): the
 *                                                  host does not use that fn (fn 0: the probe)
 * @property {[number, Uint8Array][]} specific      tags 0x40 and up
 * @property {number[]} unknownCritical
 * @property {number[]} broken                      common tags whose value is not their defined length (not used, §2.3)
 */

/** @param {[number, Uint8Array][]} tlvs @returns {Description} */
export function decodeDescription(tlvs) {
  /** @type {Description} */
  const d = { roles: new Map(), groups: new Map(), maxClockHz: null, minClockHz: null, maxLength: null, features: null,
    ops: null, opsInvalid: '', specific: [], unknownCritical: [], broken: [] };
  /** @type {Record<number, ['maxClockHz' | 'minClockHz' | 'maxLength' | 'features', number]>} */
  const single = { [COMMON.max_clock_hz]: ['maxClockHz', 4], [COMMON.min_clock_hz]: ['minClockHz', 4],
    [COMMON.max_length]: ['maxLength', 2], [COMMON.features]: ['features', 4] };
  const seen = new Set();
  for (const [tag, v] of tlvs) {
    if (tag & CRITICAL) continue;                       // bit 7 in an answer: an unknown tag, skipped (core §2.2)
    if (tag === COMMON.ops || single[tag]) {
      if (seen.has(tag)) continue;                      // a tag sent twice: the first is used (core §2.3)
      seen.add(tag);
    }
    if (tag === COMMON.role_channels) {
      if (v.length < 3) { d.broken.push(tag); continue; }
      const role = v[0], base = getU16(v, 1);
      d.roles.set(role, [...(d.roles.get(role) ?? []), ...bitmapToChannels(base, v.slice(3))]);
    } else if (tag === COMMON.channel_group) {
      try {
        const { group, pins } = unpackChannelGroup(v);
        d.groups.set(group, pins);
      } catch { d.broken.push(tag); }
    } else if (single[tag]) {
      const [name, size] = single[tag];
      if (v.length !== size) { d.broken.push(tag); continue; }   // not its defined length: broken (core §2.3)
      d[name] = size === 2 ? getU16(v) : getU32(v);
    } else if (tag === COMMON.ops) {
      const why = checkOps(v);
      if (why) d.opsInvalid = why;
      else d.ops = unpackOps(v);
    } else if (tag >= INTERFACE_TAG_FIRST) d.specific.push([tag, v]);
    // an unknown non-critical common tag is skipped
  }
  for (const [role, chans] of d.roles) d.roles.set(role, [...new Set(chans)].sort((a, b) => a - b));
  if (d.opsInvalid) d.ops = null;
  return d;
}

export { splitTlvs };
