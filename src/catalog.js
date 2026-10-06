// @ts-check
// Capability discovery by name (oep-core §7.2-§7.4).
//
//   list request : flags(u8: bit0 exact) first(u16) prefix_len(u8) prefix
//   list result  : total(u16) count(u8) count x entry [TLV]               fn 0 (the core) has no name and is never listed
//   list entry   : fn(u16) instance(u16) revision(u8) flags(u8) name_len(u8) name
//   describe     : request fn(u16) first(u16); result more(u8) then TLVs (tag u8, len u16, value; tag bit 7 =
//                  critical). A describe is declarations only (core §7.3): the host caches it while the probe's
//                  boot_id stays the same.
//   ops          : the common describe tag 0x09 every fn carries, base(u8) bitmap: bit i set = op base + i is offered
//                  (core §1.2, §7.4) - the one declaration of an fn's ops, the optional ones included. One encoding per
//                  set: 2-33 bytes, base + 8 x bitmap bytes <= 256, bit 0 set, the last byte non-zero (`checkOps`); a
//                  host does not use an fn whose ops breaks this, nor the probe when it is fn 0's
//   channel_group: group(u8) n(u8) then n x (role(u8), channel(u16)): a fixed pin set (core §7.4)

import * as reg from './registry.js';
import { Writer, getU16, getU32, utf8 } from './bytes.js';
import { Reader, splitTlvs } from './message.js';

export const LIST_EXACT = 0x01;
export const COMMON = reg.DESCRIBE_COMMON;
export const CRITICAL = 0x80;
export const INTERFACE_TAG_FIRST = 0x40;
export const IMPLEMENTATIONS = /** @type {Record<number, string>} */ ({ 0: 'unspecified', 1: 'software (bit-bang)', 2: 'peripheral', 3: 'peripheral + DMA/PIO' });

/** @typedef {{ fn: number, instance: number, revision: number, flags: number, name: string }} ListEntry */

/** @param {string} prefix @param {boolean} exact @param {number} first */
export function packListRequest(prefix = '', exact = false, first = 0) {
  const raw = utf8(prefix);
  return new Writer().u8(exact ? LIST_EXACT : 0).u16(first).u8(raw.length).raw(raw).done();
}

/** @param {Uint8Array} payload @returns {{ total: number, entries: ListEntry[] }} */
export function unpackListResult(payload) {
  const rd = new Reader(payload);
  const total = rd.u16(), count = rd.u8();
  /** @type {ListEntry[]} */
  const entries = [];
  for (let i = 0; i < count; i++) {                    // count x entry, no element length (core §2.3)
    const fn = rd.u16(), instance = rd.u16(), revision = rd.u8(), flags = rd.u8(), n = rd.u8();
    entries.push({ fn, instance, revision, flags, name: rd.text(n) });
  }
  rd.tail();
  return { total, entries };
}

/** @param {number} fn @param {number} first */
export function packDescribeRequest(fn, first) { return new Writer().u16(fn).u16(first).done(); }

/** The ops tag's value (core §7.4): base = the lowest op, then the bitmap, as short as it can be - the one encoding of
 * the set. An empty set has none (RangeError).
 * @param {Iterable<number>} ops */
export function packOps(ops) {
  const list = [...new Set(ops)].sort((a, b) => a - b);
  if (!list.length) throw new RangeError('an ops value declares at least one op (core §7.4)');
  if (list[0] < 0 || list[list.length - 1] > 0xff) throw new RangeError('an op is u8');
  const base = list[0];
  const out = new Uint8Array(2 + Math.floor((list[list.length - 1] - base) / 8));
  out[0] = base;
  for (const op of list) out[1 + Math.floor((op - base) / 8)] |= 1 << ((op - base) % 8);
  return out;
}

/** ops values are 2 to this many bytes: base(u8) and a 1-32 byte bitmap (core §7.4). */
export const OPS_MAX_BYTES = 33;

/** Whether an ops value is the one encoding core §7.4 allows: 2-33 bytes, base + 8 x bitmap bytes <= 256 (no bit past op
 * 0xFF), bit 0 set (base is the lowest op), the last byte non-zero. -> '' or why not.
 * @param {Uint8Array} v */
export function checkOps(v) {
  if (v.length < 2 || v.length > OPS_MAX_BYTES) return `ops is ${v.length} bytes (2 to ${OPS_MAX_BYTES})`;
  if (v[0] + 8 * (v.length - 1) > 0x100) return `ops base 0x${v[0].toString(16)} with ${v.length - 1} bitmap bytes goes past op 0xff`;
  if (!(v[1] & 0x01)) return 'ops bit 0 is clear (base is not the lowest op)';
  if (v[v.length - 1] === 0) return 'ops ends with a zero byte';
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

/** A channel_group value (core §7.4: group(u8) n(u8) n x (role(u8) channel(u16))) -> { group, pins }.
 * @param {Uint8Array} v @returns {{ group: number, pins: [number, number][] }} */
export function unpackChannelGroup(v) {
  /** @type {[number, number][]} */
  const pins = [];
  const n = v.length >= 2 ? v[1] : 0;
  for (let i = 0; i < n && 2 + 3 * i + 3 <= v.length; i++) pins.push([v[2 + 3 * i], getU16(v, 3 + 3 * i)]);
  return { group: v[0], pins };
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
 * null when the describe carries none.
 * @typedef {object} Description
 * @property {Map<number, number[]>} roles         role -> the channels it may take
 * @property {Map<number, [number, number][]>} groups  group -> (role, channel) of a fixed pin set
 * @property {number | null} maxClockHz
 * @property {number | null} minClockHz
 * @property {number | null} maxLength
 * @property {number | null} features
 * @property {number | null} implementation
 * @property {Set<number> | null} ops
 * @property {string} opsInvalid                    why an ops value breaks core §7.4's encoding ('' when none does): the
 *                                                  host does not use that fn (fn 0: the probe)
 * @property {[number, Uint8Array][]} specific      tags 0x40 and up
 * @property {number[]} unknownCritical
 */

/** @param {[number, Uint8Array][]} tlvs @returns {Description} */
export function decodeDescription(tlvs) {
  /** @type {Description} */
  const d = { roles: new Map(), groups: new Map(), maxClockHz: null, minClockHz: null, maxLength: null, features: null,
    implementation: null, ops: null, opsInvalid: '', specific: [], unknownCritical: [] };
  for (const [tag, v] of tlvs) {
    const t = tag & ~CRITICAL;
    if (t === COMMON.role_channels) {
      const role = v[0], base = getU16(v, 1);
      d.roles.set(role, [...(d.roles.get(role) ?? []), ...bitmapToChannels(base, v.slice(3))]);
    } else if (t === COMMON.channel_group) {
      const { group, pins } = unpackChannelGroup(v);
      d.groups.set(group, pins);
    } else if (t === COMMON.max_clock_hz) d.maxClockHz = getU32(v);
    else if (t === COMMON.min_clock_hz) d.minClockHz = getU32(v);
    else if (t === COMMON.max_length) d.maxLength = getU16(v);
    else if (t === COMMON.features) d.features = getU32(v);
    else if (t === COMMON.implementation) d.implementation = v[0];
    else if (t === COMMON.ops) {
      d.ops = new Set([...(d.ops ?? []), ...unpackOps(v)]);
      d.opsInvalid ||= checkOps(v);
    }
    else if (t >= INTERFACE_TAG_FIRST) d.specific.push([tag, v]);
    else if (tag & CRITICAL) d.unknownCritical.push(tag);
  }
  for (const [role, chans] of d.roles) d.roles.set(role, [...new Set(chans)].sort((a, b) => a - b));
  return d;
}

export { splitTlvs };
