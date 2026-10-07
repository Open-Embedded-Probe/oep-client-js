// @ts-check
// oep.fixture.logic's multirate (oep-spec interfaces/oep-if-capture.ja.md §5), as oep-client-python's multirate module:
// every channel watched at one base rate, each channel giving values at its own interval d, reduced by its policy.
//
// - Multirate {role, policy, d, param}: one role's configure TLV 0x60 (sent critical, 0xE0). A role sent none is
//   policy sample, d 1 - a D = 1 channel, laid out by the answer's layout as §1.1 does; any other role is reduced.
//   param is sample's phase (0 <= phase < d) or any_active / edge_latch's active level (0 / 1).
// - Declared: describe's 0x60 (policies, minD, maxD, pow2). d = 1 sample is always accepted; minD / maxD bound d >= 2
//   only (2 <= min_d <= max_d, oep-spec dd5a886).
// - Layout {w, pos, L, reduced}: the answer's layout of the D = 1 channels (C may be 0) and block L, with the reduced
//   channels in role order: a segment's stream is blocks of L base samples (the grid restarts at each segment), each
//   the D = 1 part (r*w bits, 0 to a byte) then the reduced part (the values bit-packed in role order, 0 to a byte); the
//   last block of a short segment holds r = samples mod L base samples and only the values that exist (§5.5).

import * as reg from './registry.js';
import { Writer, getU32 } from './bytes.js';

const CAP = reg.FIXTURE_LOGIC;
/** @type {Record<string, number>} sample 0, any_active 1, edge_latch 2; 3 onwards reserved */
export const POLICY = CAP.enum.multirate_policy;
/** @type {Record<number, string>} */
export const POLICY_NAME = Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [v, k]));
export const SAMPLE = POLICY.sample, ANY_ACTIVE = POLICY.any_active, EDGE_LATCH = POLICY.edge_latch;
/** configure TLV 0x60 (sent 0xE0) */ export const TAG = CAP.tlv.configure.multirate;
/** answer TLV 0x60: L(u32) */ export const BLOCK = CAP.tlv.configure_answer.block;
/** describe TLV 0x60: policies min_d max_d pow2 */ export const DECLARED = CAP.tlv.describe.multirate;

/** One role's multirate TLV (§5.2). policy SAMPLE with d 1 is a D = 1 channel (as a role sent nothing). */
export class Multirate {
  /** @param {number} role @param {number} policy @param {number} d @param {number} param  phase / the active level */
  constructor(role, policy = SAMPLE, d = 1, param = 0) {
    this.role = role; this.policy = policy; this.d = d; this.param = param;
  }

  get reduced() { return !(this.policy === SAMPLE && this.d === 1); }

  /** The bits of one value: 2 for edge_latch (bit 0 the level, bit 1 the edge), else 1. */
  get bits() { return this.policy === EDGE_LATCH ? 2 : 1; }

  /** role(u8) policy(u8) d(u32) param(u32) */
  value() { return new Writer().u8(this.role).u8(this.policy).u32(this.d).u32(this.param).done(); }

  /** Why the probe answers rejected malformed (§5.2), or null. */
  malformed() {
    if (this.d === 0) return 'd 0';
    if (this.policy === SAMPLE && this.param >= this.d) return `phase ${this.param} not below d ${this.d}`;
    if ((this.policy === ANY_ACTIVE || this.policy === EDGE_LATCH) && (this.d === 1 || this.param > 1)) {
      return `${POLICY_NAME[this.policy]} with d ${this.d} and param ${this.param} (d 2 or more, param 0 or 1)`;
    }
    return null;
  }

  /** The values a segment of `samples` base samples has (§5.4: only those whose base samples are all in it).
   * @param {number} samples */
  count(samples) {
    if (this.policy === SAMPLE) return Math.max(0, Math.ceil((samples - this.param) / this.d));
    return Math.floor(samples / this.d);
  }

  /** Value k from the channel's levels by base sample of its segment (§5.4).
   * @param {(n: number) => number} level @param {number} k */
  valueAt(level, k) {
    const d = this.d, a = this.param;
    if (this.policy === SAMPLE) return level(k * d + a);
    if (this.policy === ANY_ACTIVE) {
      for (let n = k * d; n < (k + 1) * d; n++) if (level(n) === a) return a;
      return 1 - a;
    }
    let edge = 0;
    for (let n = Math.max(1, k * d); n < (k + 1) * d; n++) if (level(n - 1) !== a && level(n) === a) { edge = 1; break; }
    return level((k + 1) * d - 1) | (edge << 1);
  }

  /** Every value of a segment from its levels by base sample ('0' / '1' characters or numbers).
   * @param {string | number[]} levels */
  values(levels) {
    const lv = Array.from(levels, Number);
    return Array.from({ length: this.count(lv.length) }, (_, k) => this.valueAt((n) => lv[n], k));
  }
}

/** describe 0x60 (§5.1). */
export class Declared {
  /** @param {number} policies @param {number} minD @param {number} maxD @param {boolean | number} pow2  a number past 1: broken */
  constructor(policies, minD, maxD, pow2) { this.policies = policies; this.minD = minD; this.maxD = maxD; this.pow2 = pow2; }

  /** @param {Uint8Array} v */
  static unpack(v) { return new Declared(getU32(v, 0), getU32(v, 4), getU32(v, 8), v[12] > 1 ? v[12] : v[12] !== 0); }

  /** policies bit 0 clear, minD < 2, minD > maxD or pow2 other than 0 / 1: not used, the fn is taken as not declaring
   * multirate (§5.1, oep-spec c6ab5d9). */
  get broken() {
    return !(this.policies & 1) || this.minD < 2 || this.minD > this.maxD || typeof this.pow2 !== 'boolean';
  }

  /** @param {number} policy */
  acceptsPolicy(policy) { return policy in POLICY_NAME && ((this.policies >>> policy) & 1) === 1; }

  /** d 1 is always accepted; d >= 2 within minD .. maxD (minD read as at least 2), powers of 2 only with pow2.
   * @param {number} d */
  acceptsD(d) {
    if (d === 1) return true;
    return Math.max(2, this.minD) <= d && d <= this.maxD && (!this.pow2 || (d & (d - 1)) === 0);
  }

  /** Why the probe answers rejected unsupported (§5.2), or null. @param {Multirate} m */
  refuses(m) {
    if (!this.acceptsPolicy(m.policy)) return `policy ${m.policy} not declared`;
    if (!this.acceptsD(m.d)) return `d ${m.d} not declared (${this.minD}-${this.maxD}${this.pow2 ? ', powers of 2' : ''})`;
    return null;
  }
}

/** What the client checks before sending (RangeError): malformed TLVs, a role twice, and - against the fn's describe -
 * a policy or d it does not declare, or no multirate at all. -> the specs in role order.
 * @param {Multirate[]} specs @param {Declared | null} declared */
export function check(specs, declared) {
  if (!declared) throw new RangeError("multirate: this fn's describe declares no multirate (oep-if-capture §5.1)");
  const roles = specs.map((s) => s.role);
  if (new Set(roles).size !== roles.length) throw new RangeError('multirate: a role given twice (oep-if-capture §5.2)');
  for (const s of specs) {
    const why = s.malformed() ?? declared.refuses(s);
    if (why) throw new RangeError(`multirate role ${s.role}: ${why} (oep-if-capture §5.1, §5.2)`);
  }
  return [...specs].sort((a, b) => a.role - b.role);
}

/** @param {Uint8Array} data @param {number} bit @param {number} n */
function getBits(data, bit, n) {
  let v = 0;
  for (let j = 0; j < n; j++) v |= ((data[(bit + j) >>> 3] >> ((bit + j) & 7)) & 1) << j;
  return v;
}

/** @param {Uint8Array} out @param {number} bit @param {number} value @param {number} n */
function putBits(out, bit, value, n) {
  for (let j = 0; j < n; j++) if ((value >> j) & 1) out[(bit + j) >>> 3] |= 1 << ((bit + j) & 7);
}

/** One segment decoded: d1[k] the k-th D = 1 channel's level at every base sample (role order, pos[k] of the layout);
 * reduced: role -> that reduced channel's values in order (edge_latch: bit 0 level, bit 1 edge).
 * @typedef {{ d1: number[][], reduced: Map<number, number[]> }} Decoded */

/** The data form of a multirate configuration (§5.3, §5.5). */
export class Layout {
  /** @param {number} w @param {number[]} pos @param {number} L @param {Multirate[]} reduced */
  constructor(w, pos, L, reduced) {
    this.w = w; this.pos = pos; this.L = L;
    this.reduced = reduced.filter((s) => s.reduced).sort((a, b) => a.role - b.role);
    for (const s of this.reduced) {
      if (L % s.d) throw new RangeError(`block L ${L} is not a multiple of role ${s.role}'s d ${s.d} (oep-if-capture §5.3)`);
    }
  }

  /** @param {number} r @param {number} samples @param {number} b
   * @returns {{ d1: number, red: { s: Multirate, first: number, n: number }[], bits: number }} */
  parts(r, samples, b) {
    const d1 = this.pos.length ? Math.ceil((r * this.w) / 8) : 0;
    const red = this.reduced.map((s) => {
      const per = this.L / s.d, first = b * per;
      return { s, first, n: Math.max(0, Math.min(first + per, s.count(samples)) - first) };
    });
    return { d1, red, bits: red.reduce((t, x) => t + x.s.bits * x.n, 0) };
  }

  /** B: the bytes of a complete block (§5.1). */
  blockBytes() {
    const d1 = this.pos.length ? Math.ceil((this.L * this.w) / 8) : 0;
    return d1 + Math.ceil(this.reduced.reduce((t, s) => t + (this.L / s.d) * s.bits, 0) / 8);
  }

  /** @param {number} samples */
  segmentBytes(samples) {
    const full = Math.floor(samples / this.L), r = samples % this.L;
    let n = full * this.blockBytes();
    if (r) { const p = this.parts(r, samples, full); n += p.d1 + Math.ceil(p.bits / 8); }
    return n;
  }

  /** @param {Uint8Array} data @param {number} samples @returns {Decoded} */
  decode(data, samples) {
    /** @type {Decoded} */
    const out = { d1: this.pos.map(() => []), reduced: new Map(this.reduced.map((s) => [s.role, []])) };
    let at = 0;
    for (let b = 0; b * this.L < samples; b++) {
      const r = Math.min(this.L, samples - b * this.L);
      const p = this.parts(r, samples, b);
      this.pos.forEach((q, k) => {
        for (let i = 0; i < r; i++) {
          const bit = i * this.w + q;
          out.d1[k].push((data[at + (bit >>> 3)] >> (bit & 7)) & 1);
        }
      });
      at += p.d1;
      const part = data.subarray(at, at + Math.ceil(p.bits / 8));
      let bit = 0;
      for (const { s, n } of p.red) {
        const vals = /** @type {number[]} */ (out.reduced.get(s.role));
        for (let j = 0; j < n; j++) { vals.push(getBits(part, bit, s.bits)); bit += s.bits; }
      }
      at += Math.ceil(p.bits / 8);
    }
    if (at > data.length) throw new RangeError(`multirate segment of ${samples} base samples needs ${at} bytes, got ${data.length}`);
    return out;
  }

  /** The stream of a segment of `samples` base samples, level(role, n) being role's level at base sample n of the
   * segment; d1Roles[k] the role of the layout's k-th D = 1 channel.
   * @param {(role: number, n: number) => number} level @param {number} samples @param {number[]} d1Roles */
  encode(level, samples, d1Roles) {
    /** @type {number[]} */
    const out = [];
    for (let b = 0; b * this.L < samples; b++) {
      const r = Math.min(this.L, samples - b * this.L);
      const p = this.parts(r, samples, b);
      const d1 = new Uint8Array(p.d1);
      for (let i = 0; i < r; i++) {
        this.pos.forEach((q, k) => {
          const bit = i * this.w + q;
          if (level(d1Roles[k], b * this.L + i)) d1[bit >>> 3] |= 1 << (bit & 7);
        });
      }
      out.push(...d1);
      const part = new Uint8Array(Math.ceil(p.bits / 8));
      let bit = 0;
      for (const { s, first, n } of p.red) {
        for (let j = 0; j < n; j++) { putBits(part, bit, s.valueAt((x) => level(s.role, x), first + j), s.bits); bit += s.bits; }
      }
      out.push(...part);
    }
    return Uint8Array.from(out);
  }
}
