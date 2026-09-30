// @ts-check
// Little-endian byte helpers (oep-core §2.1: every number is little endian; text is UTF-8 with its length apart).

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** @param {string} s */
export function utf8(s) { return encoder.encode(s); }
/** @param {Uint8Array} b */
export function text(b) { return decoder.decode(b); }

/** @param {...(Uint8Array | number[])} parts */
export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** @param {Uint8Array} b */
export function hex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

/** @param {string} s */
export function fromHex(s) {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Builds a payload front to back. */
export class Writer {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
  }
  /** @param {number} v */ u8(v) { this.bytes.push(v & 0xff); return this; }
  /** @param {number} v */ u16(v) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff); return this; }
  /** @param {number} v */ u32(v) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  /** @param {number} v */ i32(v) { return this.u32(v >>> 0); }
  /** @param {bigint | number} v */ u64(v) {
    const b = BigInt(v);
    this.u32(Number(b & 0xffffffffn));
    return this.u32(Number((b >> 32n) & 0xffffffffn));
  }
  /** @param {Uint8Array | number[]} b */ raw(b) { for (const x of b) this.bytes.push(x); return this; }
  /** @returns {Uint8Array} */ done() { return Uint8Array.from(this.bytes); }
}

/** @param {number} v */ export const u8 = (v) => Uint8Array.of(v & 0xff);
/** @param {number} v */ export const u16 = (v) => new Writer().u16(v).done();
/** @param {number} v */ export const u32 = (v) => new Writer().u32(v).done();

/** @param {Uint8Array} b @param {number} at */
export function getU16(b, at = 0) { return b[at] | (b[at + 1] << 8); }
/** @param {Uint8Array} b @param {number} at */
export function getU32(b, at = 0) { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }
/** @param {Uint8Array} b @param {number} at */
export function getI32(b, at = 0) { return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24); }
/** @param {Uint8Array} b @param {number} at */
export function getU64(b, at = 0) { return BigInt(getU32(b, at)) | (BigInt(getU32(b, at + 4)) << 32n); }
