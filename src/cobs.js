// @ts-check
// Serial-port framing (oep-core §3.1): message + CRC-16 little endian, COBS-encoded, sent as 0x00 <COBS> 0x00.
// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor ("123456789" -> 0x29B1).

export class CorruptFrame extends Error {}

/** @param {Uint8Array} data @param {number} crc */
export function crc16(data, crc = 0xffff) {
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Standard COBS (no delimiter). When the data ends right after a full block no empty block follows (§3.1).
 * @param {Uint8Array} data */
export function encode(data) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  const n = data.length;
  for (;;) {
    let j = i;
    while (j < n && data[j] !== 0 && j - i < 254) j++;
    const code = j - i + 1;
    out.push(code);
    for (let k = i; k < j; k++) out.push(data[k]);
    if (j >= n) return Uint8Array.from(out);
    if (code === 0xff) { i = j; continue; }
    i = j + 1;
  }
}

/** @param {Uint8Array} raw */
export function decode(raw) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const code = raw[i++];
    if (code === 0 || i + code - 1 > n) throw new CorruptFrame('COBS block runs past the frame');
    for (let k = 0; k < code - 1; k++) out.push(raw[i + k]);
    i += code - 1;
    if (code !== 0xff && i < n) out.push(0);
  }
  return Uint8Array.from(out);
}

/** 0x00 <COBS(message + CRC)> 0x00 (the leading delimiter too, §3.1, §3.4).
 * @param {Uint8Array} message */
export function frame(message) {
  const crc = crc16(message);
  const body = new Uint8Array(message.length + 2);
  body.set(message);
  body[message.length] = crc & 0xff;
  body[message.length + 1] = crc >> 8;
  const enc = encode(body);
  const out = new Uint8Array(enc.length + 2);
  out.set(enc, 1);
  return out;
}

/** The bytes between two delimiters (without the 0x00) -> the message.
 * @param {Uint8Array} raw */
export function unframe(raw) {
  const data = decode(raw);
  if (data.length < 3) throw new CorruptFrame('frame shorter than a message and its CRC');
  const body = data.subarray(0, data.length - 2);
  const got = data[data.length - 2] | (data[data.length - 1] << 8);
  if (crc16(body) !== got) throw new CorruptFrame('CRC mismatch');
  return body.slice();
}
