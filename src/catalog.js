// @ts-check
// Capability discovery by name (oep-core §7.2-§7.4).
//
//   list request : flags(u8: bit0 exact) first(u16) prefix_len(u8) prefix
//   list result  : total(u16) count(u8) count x (len(u8) entry) [TLV]     oep.core (fn 0) is the first entry
//   list entry   : fn(u16) instance(u16) revision(u8) flags(u8) name_len(u8) name
//   describe     : request fn(u16) first(u16); result more(u8) then TLVs (tag u8, len u8 or 0xFF + u16, value;
//                  tag bit 7 = critical). A describe is declarations only (core §7.3): the host caches it while the
//                  probe's boot_id stays the same.
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
  for (let i = 0; i < count; i++) {
    const e = rd.element();
    const fn = e.u16(), instance = e.u16(), revision = e.u8(), flags = e.u8(), n = e.u8();
    entries.push({ fn, instance, revision, flags, name: e.text(n) });
  }
  rd.tail();
  return { total, entries };
}

/** @param {number} fn @param {number} first */
export function packDescribeRequest(fn, first) { return new Writer().u16(fn).u16(first).done(); }

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
 * The common describe tags decoded; interface-specific and unknown ones kept raw, in order.
 * @typedef {object} Description
 * @property {Map<number, number[]>} roles         role -> the channels it may take
 * @property {Map<number, [number, number][]>} groups  group -> (role, channel) of a fixed pin set
 * @property {number | null} maxClockHz
 * @property {number | null} minClockHz
 * @property {number | null} maxLength
 * @property {number | null} features
 * @property {number | null} implementation
 * @property {[number, Uint8Array][]} specific      tags 0x40 and up
 * @property {number[]} unknownCritical
 */

/** @param {[number, Uint8Array][]} tlvs @returns {Description} */
export function decodeDescription(tlvs) {
  /** @type {Description} */
  const d = { roles: new Map(), groups: new Map(), maxClockHz: null, minClockHz: null, maxLength: null, features: null,
    implementation: null, specific: [], unknownCritical: [] };
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
    else if (t >= INTERFACE_TAG_FIRST) d.specific.push([tag, v]);
    else if (tag & CRITICAL) d.unknownCritical.push(tag);
  }
  for (const [role, chans] of d.roles) d.roles.set(role, [...new Set(chans)].sort((a, b) => a - b));
  return d;
}

export { splitTlvs };
