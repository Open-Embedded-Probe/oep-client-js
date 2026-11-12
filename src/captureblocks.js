// @ts-check
// Reading a capture's data formats beyond 0 (oep-if-capture §1): format 1, the logic blocks (§1.3), as
// oep-client-python's capture_blocks.
//
// A segment of format 1 is a run of blocks of L original samples (the last one r = samples mod L). Each channel is
// carried raw (every sample) or reduced over intervals of D samples, with a fixed number of bits an interval:
// - raw: its bits, a Uint8Array with sample i at bit i mod 8 of byte i / 8 - lossless;
// - sample (the interval's first sample), any_high (the interval's OR), any_low (its AND): one bit an interval;
// - change_latch: two bits an interval - bit 0 the interval's last level, bit 1 whether it changed (from the sample
//   before) - and, at each block's start, the level its first sample is compared with.
// A block's size is fixed by the configuration, so a segment's bytes follow from its samples (segmentBytes).

import { ProtocolError } from './errors.js';
import * as reg from './registry.js';

export const LOGIC_CARRIAGE = reg.FIXTURE_LOGIC.enum.logic_carriage;
export const RAW = LOGIC_CARRIAGE.raw, SAMPLE = LOGIC_CARRIAGE.sample, ANY_HIGH = LOGIC_CARRIAGE.any_high;
export const ANY_LOW = LOGIC_CARRIAGE.any_low, CHANGE_LATCH = LOGIC_CARRIAGE.change_latch;

/** An interval's bits for a reduction (§1.3). @param {number} kind */
export const valueBits = (kind) => (kind === CHANGE_LATCH ? 2 : 1);

/** @typedef {Map<number, [number, number]>} Reduced role -> [carriage, D] */

/** The bytes one block of r samples takes (§1.3): the raw part (r samples of the layout's w bits: `width`, `raw` when
 * null), then the reduced part (a start bit per change_latch channel and every interval's value).
 * @param {number} raw @param {Reduced} reduced @param {number} r @param {number | null} [width] */
export function blockBytes(raw, reduced, r, width = null) {
  let bits = 0;
  for (const [k, d] of reduced.values()) bits += (k === CHANGE_LATCH ? 1 : 0) + Math.ceil(r / d) * valueBits(k);
  const w = width ?? raw;
  return ((r * w + 7) >> 3) + ((bits + 7) >> 3);
}

/** A format 1 segment's bytes: whole blocks of L and the last one.
 * @param {number} samples @param {number} raw @param {Reduced} reduced @param {number} block @param {number | null} [width] */
export function segmentBytes(samples, raw, reduced, block, width = null) {
  const whole = Math.floor(samples / block), rest = samples % block;
  return whole * blockBytes(raw, reduced, block, width) + (rest ? blockBytes(raw, reduced, rest, width) : 0);
}

/** One block of a format 1 segment: samples `first` .. `first + samples - 1` of the segment. `raw`: role -> bits;
 * `values`: role -> the reduced channel's interval values (change_latch's bit 0 the level, bit 1 the change);
 * `starts`: role -> change_latch's level before the block's first sample. */
export class LogicBlock {
  /** @param {number} first @param {number} samples */
  constructor(first, samples) {
    this.first = first; this.samples = samples;
    /** @type {Map<number, Uint8Array>} */ this.raw = new Map();
    /** @type {Map<number, number[]>} */ this.values = new Map();
    /** @type {Map<number, number>} */ this.starts = new Map();
  }
}

/** @param {Uint8Array} data @param {number} at @param {number} j */
const bit = (data, at, j) => (data[at + (j >> 3)] >> (j & 7)) & 1;

/** n bits from bit j of data[at..] (n <= 2 here). @param {Uint8Array} data @param {number} at @param {number} j @param {number} n */
const ubits = (data, at, j, n) => {
  let v = 0;
  for (let k = 0; k < n; k++) v |= bit(data, at, j + k) << k;
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

/**
 * A format 1 segment's bytes (§1.3) -> its blocks. `rawRoles`: the raw channels' roles, `reduced`: role -> [carriage,
 * D] for the others (both as configured; read in role order), `block`: the answer's L, `width` / `positions`: the
 * answer's layout w and pos (rawRoles.length and 0 .. R-1 when null). Bytes left over, or too few, throw ProtocolError.
 * @param {Uint8Array} data @param {number} samples @param {number[]} rawRoles @param {Reduced} reduced
 * @param {number} block @param {number | null} [width] @param {number[] | null} [positions] @returns {LogicBlock[]}
 */
export function readLogicBlocks(data, samples, rawRoles, reduced, block, width = null, positions = null) {
  const raw = [...rawRoles].sort((a, b) => a - b), red = [...reduced.keys()].sort((a, b) => a - b);
  const R = raw.length, w = width ?? R;
  const posOf = positions ? [...positions] : raw.map((_, j) => j);
  const latches = red.filter((role) => /** @type {[number, number]} */ (reduced.get(role))[0] === CHANGE_LATCH);
  /** @type {LogicBlock[]} */
  const out = [];
  let pos = 0;
  for (let first = 0; first < samples; first += block) {
    const r = Math.min(block, samples - first);
    const size = blockBytes(R, reduced, r, w);
    if (pos + size > data.length) throw new ProtocolError(`format 1: block at sample ${first} cut short`);
    const rb = (r * w + 7) >> 3;
    const b = new LogicBlock(first, r);
    if (R) {
      const cols = columns(data, pos, r, w);
      raw.forEach((role, j) => b.raw.set(role, cols[posOf[j]]));
    }
    const part = pos + rb;
    let at = 0;
    for (const role of latches) b.starts.set(role, bit(data, part, at++));
    for (const role of red) {
      const [kind, d] = /** @type {[number, number]} */ (reduced.get(role));
      const nb = valueBits(kind), n = Math.ceil(r / d);
      b.values.set(role, Array.from({ length: n }, (_, j) => ubits(data, part, at + j * nb, nb)));
      at += n * nb;
    }
    out.push(b);
    pos += size;
  }
  if (pos !== data.length) throw new ProtocolError(`format 1: ${data.length - pos} bytes past the segment's ${samples} samples`);
  return out;
}

/** A reduced channel over a whole segment (segmentColumns): its carriage and D, its interval values (`values`; the
 * last one partial when D does not divide the segment) and, for change_latch, the level before the segment's first
 * sample (`startLevel`; else 0).
 * @typedef {{ kind: number, d: number, values: number[], startLevel: number }} ReducedColumn */

/**
 * A format 1 segment (§1.3) read as columns without blocks: role -> a raw channel's bits (sample i at bit i mod 8; the
 * bits past `samples` 0) or a reduced channel's ReducedColumn. A change_latch block's start other than the level its
 * interval before ended on is a broken stream (ProtocolError), as are bytes left over or too few.
 * @param {Uint8Array} data @param {number} samples @param {number[]} rawRoles @param {Reduced} reduced
 * @param {number} block @param {number | null} [width] @param {number[] | null} [positions]
 * @returns {Map<number, Uint8Array | ReducedColumn>}
 */
export function segmentColumns(data, samples, rawRoles, reduced, block, width = null, positions = null) {
  const blocks = readLogicBlocks(data, samples, rawRoles, reduced, block, width, positions);
  /** @type {Map<number, Uint8Array | ReducedColumn>} */
  const out = new Map();
  for (const role of rawRoles) {
    const bits = new Uint8Array((samples + 7) >> 3);
    for (const b of blocks) {
      const src = /** @type {Uint8Array} */ (b.raw.get(role));
      for (let i = 0; i < b.samples; i++) if (bit(src, 0, i)) bits[(b.first + i) >> 3] |= 1 << ((b.first + i) & 7);
    }
    out.set(role, bits);
  }
  for (const [role, [kind, d]] of reduced) {
    /** @type {ReducedColumn} */
    const col = { kind, d, values: [], startLevel: 0 };
    for (const b of blocks) {
      const start = b.starts.get(role);
      if (start !== undefined) {
        if (!col.values.length) col.startLevel = start;
        else if (start !== (col.values[col.values.length - 1] & 1)) {
          throw new ProtocolError(`format 1: role ${role}'s block at sample ${b.first} starts at level ${start}, its interval before ended at ${col.values[col.values.length - 1] & 1}`);
        }
      }
      col.values.push(.../** @type {number[]} */ (b.values.get(role)));
    }
    out.set(role, col);
  }
  return out;
}

/** Bits as readLogicBlocks gives them -> a list of n levels. @param {Uint8Array} bits @param {number} n */
export function bitsList(bits, n) { return Array.from({ length: n }, (_, i) => bit(bits, 0, i)); }

