// @ts-check
// Reading a capture's data formats beyond 0 (oep-if-capture §1): format 1, the logic blocks (§1.3), as
// oep-client-python's capture_blocks.
//
// A segment of format 1 is a run of blocks of L original samples (the last one r = samples mod L). Each block gives:
// - every raw channel, and every events channel the probe carried raw in this block (fallback), as its bits: a
//   Uint8Array with sample i at bit i mod 8 of byte i / 8 - lossless;
// - every other events channel as its ticks: the block's start level and, for each tick of D samples where the level
//   changed, (tick, the level after it, the changes in it - 127 meaning at least 127).
// A fallback block is handed over as raw bits, not turned into events: the reader decides how to keep it.

import { ProtocolError } from './errors.js';

/** state bits 0-6 (§1.3): at least this many changes */
export const COUNT_SATURATED = 127;
/** tick(u16) ch(u8) state(u8) */
export const EVENT_BYTES = 4;

/** An events channel in one block (§1.3): the level before the block's first sample (`startLevel`), and for each tick
 * that changed, its number, the level after it and the changes in it (bit 0-6 of state; 127 saturated). */
export class EventChannel {
  /** @param {number} d @param {number} startLevel */
  constructor(d, startLevel) {
    this.d = d; this.startLevel = startLevel;
    /** @type {number[]} */ this.ticks = [];
    /** @type {number[]} */ this.levels = [];
    /** @type {number[]} */ this.counts = [];
  }
}

/** One block of a format 1 segment: samples `first` .. `first + samples - 1` of the segment. `raw`: role -> bits for the
 * raw channels and this block's fallback channels; `fallback`: the events channels carried raw here; `events`: role ->
 * EventChannel for the others; `startLevels`: role -> the level before the block's first sample for every events
 * channel, fallback ones included (§1.3 start_level: a segment's seam is counted from it). */
export class LogicBlock {
  /** @param {number} first @param {number} samples */
  constructor(first, samples) {
    this.first = first; this.samples = samples;
    /** @type {Map<number, Uint8Array>} */ this.raw = new Map();
    /** @type {Set<number>} */ this.fallback = new Set();
    /** @type {Map<number, EventChannel>} */ this.events = new Map();
    /** @type {Map<number, number>} */ this.startLevels = new Map();
  }
}

/** @param {Uint8Array} data @param {number} at @param {number} j */
const bit = (data, at, j) => (data[at + (j >> 3)] >> (j & 7)) & 1;

/** @param {Uint8Array} data @param {number} at @param {number} n  n <= 4 */
const uint = (data, at, n) => {
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 256 + data[at + i];
  return v;
};

/** The wb-bit samples of a raw part as one bit string per column (§1 bit order).
 * @param {Uint8Array} data @param {number} at @param {number} r @param {number} wb @returns {Uint8Array[]} */
function columns(data, at, r, wb) {
  const out = Array.from({ length: wb }, () => new Uint8Array((r + 7) >> 3));
  for (let i = 0; i < r; i++) {
    for (let k = 0; k < wb; k++) if (bit(data, at, i * wb + k)) out[k][i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/** A format 1 block header's counts: E events channels, nb ceil(E / 8). @param {number} E */
const maskBytes = (E) => (E + 7) >> 3;

/**
 * A format 1 segment's bytes (§1.3) -> its blocks. `rawRoles`: the raw channels' roles, `eventD`: the events channels'
 * role -> D (both as configured; read in role order), `block`: the answer's L. Bytes left over, or too few, throw
 * ProtocolError.
 * @param {Uint8Array} data @param {number} samples @param {number[]} rawRoles @param {Map<number, number>} eventD
 * @param {number} block @returns {LogicBlock[]}
 */
export function readLogicBlocks(data, samples, rawRoles, eventD, block) {
  const raw = [...rawRoles].sort((a, b) => a - b), ev = [...eventD.keys()].sort((a, b) => a - b);
  const E = ev.length, nb = maskBytes(E);
  /** @type {LogicBlock[]} */
  const out = [];
  let pos = 0;
  for (let first = 0; first < samples; first += block) {
    const r = Math.min(block, samples - first);
    if (pos + 2 * nb + 4 > data.length) throw new ProtocolError(`format 1: block at sample ${first} cut short (header)`);
    const fb = Array.from({ length: E }, (_, e) => bit(data, pos, e));
    const start = Array.from({ length: E }, (_, e) => bit(data, pos + nb, e));
    const n = uint(data, pos + 2 * nb, 4);
    pos += 2 * nb + 4;
    const cols = [...raw, ...ev.filter((_, e) => fb[e])];
    const wb = cols.length;
    const rb = (r * wb + 7) >> 3;
    if (pos + rb + EVENT_BYTES * n > data.length) throw new ProtocolError(`format 1: block at sample ${first} cut short (${n} events)`);
    const b = new LogicBlock(first, r);
    ev.forEach((role, e) => { b.startLevels.set(role, start[e]); if (fb[e]) b.fallback.add(role); });
    columns(data, pos, r, wb).forEach((bits, k) => b.raw.set(cols[k], bits));
    pos += rb;
    ev.forEach((role, e) => { if (!fb[e]) b.events.set(role, new EventChannel(/** @type {number} */ (eventD.get(role)), start[e])); });
    let last = -1;
    for (let i = 0; i < n; i++) {
      const tick = data[pos] | (data[pos + 1] << 8), ch = data[pos + 2], state = data[pos + 3];
      pos += EVENT_BYTES;
      if (ch >= E || fb[ch]) throw new ProtocolError(`format 1: an event of channel ${ch} (events ${E}, fallback ${fb})`);
      if (ch < last) throw new ProtocolError('format 1: events not in channel order (§1.3)');
      last = ch;
      const c = /** @type {EventChannel} */ (b.events.get(ev[ch]));
      if (tick >= Math.ceil(r / c.d)) throw new ProtocolError(`format 1: tick ${tick} past the block's ${r} samples (D ${c.d})`);
      c.ticks.push(tick);
      c.levels.push(state >> 7);
      c.counts.push(state & COUNT_SATURATED);
    }
    out.push(b);
  }
  if (pos !== data.length) throw new ProtocolError(`format 1: ${data.length - pos} bytes past the segment's ${samples} samples`);
  return out;
}

/** An events channel over a whole segment (segmentColumns): for each tick of D samples, counted from the segment's
 * first sample, where the level changed - the tick (`quanta`), the level after it, the changes in it (127 meaning at
 * least 127 where the probe sent events; a fallback block's are counted from its samples) - and the level before the
 * segment's first sample (`startLevel`).
 * @typedef {{ quanta: number[], levels: number[], counts: number[], startLevel: number }} EventColumn */

/**
 * A format 1 segment (§1.3) read as columns without blocks: role -> a raw channel's bits (sample i at bit i mod 8; the
 * bits past `samples` 0) or an events channel's EventColumn. A fallback block's samples of an events channel are
 * turned into its ticks the way the probe counts them (the changes in each tick, the level at its end). The same
 * checks as readLogicBlocks (ProtocolError).
 * @param {Uint8Array} data @param {number} samples @param {number[]} rawRoles @param {Map<number, number>} eventD
 * @param {number} block @returns {Map<number, Uint8Array | EventColumn>}
 */
export function segmentColumns(data, samples, rawRoles, eventD, block) {
  const blocks = readLogicBlocks(data, samples, rawRoles, eventD, block);
  /** @type {Map<number, Uint8Array | EventColumn>} */
  const out = new Map();
  for (const role of rawRoles) {
    const bits = new Uint8Array((samples + 7) >> 3);
    for (const b of blocks) {
      const src = /** @type {Uint8Array} */ (b.raw.get(role));
      for (let i = 0; i < b.samples; i++) if (bit(src, 0, i)) bits[(b.first + i) >> 3] |= 1 << ((b.first + i) & 7);
    }
    out.set(role, bits);
  }
  for (const [role, d] of eventD) {
    /** @type {EventColumn} */
    const col = { quanta: [], levels: [], counts: [], startLevel: blocks.length ? /** @type {number} */ (blocks[0].startLevels.get(role)) : 0 };
    for (const b of blocks) {
      const base = Math.floor(b.first / d);
      const c = b.events.get(role);
      if (c) {
        c.ticks.forEach((t, i) => { col.quanta.push(base + t); col.levels.push(c.levels[i]); col.counts.push(c.counts[i]); });
        continue;
      }
      // carried raw here: counted from the samples, the way the probe counts (§1.3)
      const bits = /** @type {Uint8Array} */ (b.raw.get(role));
      let prev = /** @type {number} */ (b.startLevels.get(role));
      for (let t = 0; t * d < b.samples; t++) {
        let changes = 0, level = prev;
        for (let i = t * d; i < Math.min((t + 1) * d, b.samples); i++) {
          level = bit(bits, 0, i);
          if (level !== prev) changes++;
          prev = level;
        }
        if (changes) { col.quanta.push(base + t); col.levels.push(level); col.counts.push(changes); }
      }
    }
    out.set(role, col);
  }
  return out;
}

/** Bits as readLogicBlocks gives them -> a list of n levels. @param {Uint8Array} bits @param {number} n */
export function bitsList(bits, n) { return Array.from({ length: n }, (_, i) => bit(bits, 0, i)); }

/** The most bytes one block of L samples takes (§1.3): 2 ceil(E/8) + 4 + L R / 8 + sum min(L/8, (L/D) 4).
 * @param {number} R @param {number[]} eventD @param {number} block */
export function worstBytes(R, eventD, block) {
  return 2 * maskBytes(eventD.length) + 4 + Math.floor((block * R) / 8)
    + eventD.reduce((t, d) => t + Math.min(Math.floor(block / 8), Math.floor(block / d) * EVENT_BYTES), 0);
}
