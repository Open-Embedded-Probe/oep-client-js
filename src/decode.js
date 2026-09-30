// @ts-check
// Host-side decoders for capture channels (oep.fixture.logic: one value per sample of a channel).

/**
 * kind: start, byte or stop; sample: the sample index where it was recognised; value: the byte (kind byte);
 * ack: true = ACK (SDA low on the 9th clock), null for start / stop.
 * @typedef {{ kind: 'start' | 'byte' | 'stop', sample: number, value: number, ack: boolean | null }} I2cEvent
 */

export class I2cTrace {
  constructor() {
    /** @type {I2cEvent[]} */ this.events = [];
    /** @type {number[]} samples between SCL rising edges */ this.sclPeriods = [];
  }

  /** @returns {[number, boolean][]} [value, ack] of every byte */
  bytes() { return this.events.filter((e) => e.kind === 'byte').map((e) => [e.value, !!e.ack]); }

  /** "S a5A P": S start, P stop, a byte in hex with A (ACK) or N (NACK). */
  summary() {
    return this.events.map((e) => (e.kind === 'byte'
      ? `${e.value.toString(16).padStart(2, '0')}${e.ack ? 'A' : 'N'}` : e.kind === 'start' ? 'S' : 'P')).join(' ');
  }
}

/**
 * Edge-based I2C decode of two channels: START = SDA falling while SCL high, STOP = SDA rising while SCL high, data
 * sampled on SCL rising edges, every 9th bit is the ACK.
 * @param {ArrayLike<number>} scl @param {ArrayLike<number>} sda
 */
export function decodeI2c(scl, sda) {
  const trace = new I2cTrace();
  const n = Math.min(scl.length, sda.length);
  if (!n) return trace;
  /** @type {number[]} */
  let bits = [];
  let inFrame = false;
  /** @type {number | null} */
  let lastRise = null;
  for (let i = 1; i < n; i++) {
    if (scl[i] && scl[i - 1]) {
      if (sda[i - 1] && !sda[i]) {
        trace.events.push({ kind: 'start', sample: i, value: 0, ack: null });
        inFrame = true; bits = [];
      } else if (!sda[i - 1] && sda[i]) {
        trace.events.push({ kind: 'stop', sample: i, value: 0, ack: null });
        inFrame = false; bits = [];
      }
    }
    if (scl[i] && !scl[i - 1]) {   // SCL rising edge: sample SDA
      if (lastRise !== null) trace.sclPeriods.push(i - lastRise);
      lastRise = i;
      if (inFrame) {
        bits.push(sda[i] ? 1 : 0);
        if (bits.length === 9) {
          let value = 0;
          for (const b of bits.slice(0, 8)) value = (value << 1) | b;
          trace.events.push({ kind: 'byte', sample: i, value, ack: bits[8] === 0 });
          bits = [];
        }
      }
    }
  }
  return trace;
}
