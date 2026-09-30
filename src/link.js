// @ts-check
// A link to a probe over any transport (oep-core §3): frames the messages, matches results to requests by corr, keeps
// the probe's pushes and events.
//
// Framing follows the kind of transport. A serial port (USB CDC, USB-Serial/JTAG, a UART bridge) carries COBS + CRC
// frames 0x00 <COBS> 0x00 and the probe's raw bytes on the same line: every span between 0x00s is a candidate, and one
// that does not decode is noise (§3.1, §3.4). Vendor bulk, HID and TCP carry length(u16) message; a length that
// cannot be right, or a frame that stops half way, drops what was gathered (the requests waiting then time out and go
// once more).
//
// A request whose answer does not come in time goes once more with the same corr: the probe keeps the lock holder's
// recent results and answers the repeat from them, so a state-changing request does not run twice (§5.2).

import * as reg from './registry.js';
import * as cobs from './cobs.js';
import { ROLE_DATA, ROLE_EVENT, ROLE_RESULT } from './message.js';
import { Timeout } from './errors.js';

const STALL_MS = reg.TIMING.probe_frame_gap_ms;   // a frame whose bytes stop this long is not coming

/**
 * The bytes a transport moves. `start` begins delivering what arrives (onData for every chunk; onClose when the
 * transport ends, with the error if any); `write` sends one chunk whole.
 * @typedef {object} Transport
 * @property {(data: Uint8Array) => Promise<void>} write
 * @property {(onData: (chunk: Uint8Array) => void, onClose: (error?: unknown) => void) => void | Promise<void>} start
 * @property {() => Promise<void>} close
 * @property {'cobs' | 'length'} framing  what the transport carries (serial ports: cobs; bulk, HID, TCP: length)
 * @property {string} [kind]              for display: serial, vendor, hid, tcp
 * @property {number} [maxWrite]          the most one write takes (HID: a report's room); longer writes are split
 */

/** @typedef {{ resolve: (b: Uint8Array) => void, reject: (e: unknown) => void, timer: any, message: Uint8Array, attempt: number }} Pending */

export class Link {
  /**
   * @param {Transport} transport
   * @param {{ timeoutMs?: number, maxFrame?: number }} [options]
   */
  constructor(transport, { timeoutMs = 3000, maxFrame = 0xffff } = {}) {
    this.transport = transport;
    this.framing = transport.framing;
    this.timeoutMs = timeoutMs;
    this.maxFrame = maxFrame;
    this.stats = { retries: 0, noise: 0, corrupt: 0, stale: 0, resyncs: 0, dropped: 0 };
    /** @type {Uint8Array[]} */ this.events = [];
    /** @type {Uint8Array[]} */ this.pushes = [];
    /** @type {Set<(frame: Uint8Array) => void>} */ this.eventListeners = new Set();
    /** @type {Set<(frame: Uint8Array) => void>} */ this.pushListeners = new Set();
    /** @type {Map<number, Pending>} */ this.pending = new Map();
    this.buf = new Uint8Array(0);
    this.lastRx = 0;
    this.closed = false;
    /** @type {unknown} */ this.closeError = undefined;
    this.started = false;
  }

  /** Begin reading (once). */
  async start() {
    if (this.started) return;
    this.started = true;
    await this.transport.start((chunk) => this.onData(chunk), (error) => this.onClose(error));
  }

  /** @param {unknown} error */
  onClose(error) {
    this.closed = true;
    this.closeError = error;
    for (const [corr, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error instanceof Error ? error : new Error('the transport closed'));
      this.pending.delete(corr);
    }
  }

  async close() {
    this.closed = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    await this.transport.close();
  }

  // ---- receiving --------------------------------------------------------------------------------------------

  /** @param {Uint8Array} chunk */
  onData(chunk) {
    const now = Date.now();
    if (this.framing === 'length' && this.buf.length && now - this.lastRx > STALL_MS) {
      this.buf = new Uint8Array(0);   // a frame that stopped half way: its rest is not coming
      this.stats.resyncs++;
    }
    this.lastRx = now;
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    if (this.framing === 'cobs') this.cutCobs();
    else this.cutLength();
  }

  cutCobs() {
    for (;;) {
      const end = this.buf.indexOf(0);
      if (end < 0) return;
      const raw = this.buf.subarray(0, end);
      this.buf = this.buf.slice(end + 1);   // the 0x00 also starts the next candidate
      if (!raw.length) continue;
      let message;
      try {
        message = cobs.unframe(raw);
      } catch {
        this.stats.noise += raw.length;     // the port's raw bytes, or a broken frame: noise, no resend
        continue;
      }
      this.deliver(message);
    }
  }

  cutLength() {
    for (;;) {
      if (this.buf.length < 2) return;
      const length = this.buf[0] | (this.buf[1] << 8);
      if (length === 0) { this.buf = this.buf.slice(2); continue; }   // the reserved keepalive
      if (length > this.maxFrame) {           // the boundaries are lost: start again from what comes next
        this.buf = new Uint8Array(0);
        this.stats.resyncs++;
        return;
      }
      if (this.buf.length < 2 + length) return;
      const message = this.buf.slice(2, 2 + length);
      this.buf = this.buf.slice(2 + length);
      this.deliver(message);
    }
  }

  /** @param {Uint8Array} frame */
  deliver(frame) {
    const role = frame[0];
    if (role === ROLE_RESULT && frame.length >= 3) {
      const corr = frame[1] | (frame[2] << 8);
      const p = this.pending.get(corr);
      if (!p) { this.stats.stale++; return; }   // a late answer to a request already answered, or someone else's
      this.pending.delete(corr);
      clearTimeout(p.timer);
      p.resolve(frame);
    } else if (role === ROLE_EVENT) {
      this.events.push(frame);
      for (const l of this.eventListeners) l(frame);
    } else if (role === ROLE_DATA) {
      this.pushes.push(frame);
      for (const l of this.pushListeners) l(frame);
    } else {
      this.stats.dropped++;                     // a role this client does not handle (§2.4)
    }
  }

  // ---- sending ---------------------------------------------------------------------------------------------

  /** @param {Uint8Array} message */
  framed(message) {
    if (this.framing === 'cobs') return cobs.frame(message);
    if (!message.length || message.length > this.maxFrame) throw new RangeError(`message length ${message.length} outside 1..${this.maxFrame}`);
    const out = new Uint8Array(2 + message.length);
    out[0] = message.length & 0xff;
    out[1] = message.length >> 8;
    out.set(message, 2);
    return out;
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    const max = this.transport.maxWrite;
    if (!max || bytes.length <= max) return this.transport.write(bytes);
    for (let at = 0; at < bytes.length; at += max) await this.transport.write(bytes.subarray(at, at + max));
  }

  /**
   * The answer to one request (its bytes, the corr in them), sent once more after a missing answer (§5.2).
   * @param {Uint8Array} message
   * @returns {Promise<Uint8Array>}
   */
  send(message) {
    if (this.closed) return Promise.reject(this.closeError instanceof Error ? this.closeError : new Error('the link is closed'));
    const corr = message[1] | (message[2] << 8);
    return new Promise((resolve, reject) => {
      /** @type {Pending} */
      const p = { resolve, reject, timer: null, message, attempt: 0 };
      const arm = () => {
        p.timer = setTimeout(() => {
          if (p.attempt === 0) {
            p.attempt = 1;
            this.stats.retries++;
            this.write(this.framed(message)).catch(reject);
            arm();
          } else {
            this.pending.delete(corr);
            reject(new Timeout(`no result from the probe (corr ${corr})`));
          }
        }, this.timeoutMs);
      };
      this.pending.set(corr, p);
      arm();
      this.write(this.framed(message)).catch((e) => { clearTimeout(p.timer); this.pending.delete(corr); reject(e); });
    });
  }

  /**
   * Pipelined: up to maxInflight requests and window bytes outstanding; answers in order.
   * @param {Uint8Array[]} messages @param {{ maxInflight: number, window: number }} limits
   */
  async exchange(messages, { maxInflight, window }) {
    /** @type {Promise<Uint8Array>[]} */
    const answers = [];
    /** @type {{ size: number, done: Promise<unknown> }[]} */
    const flying = [];
    for (const msg of messages) {
      const size = msg.length + 2;
      while (flying.length && (flying.length >= maxInflight || flying.reduce((a, f) => a + f.size, 0) + size > window)) {
        await flying[0].done.catch(() => {});
        flying.shift();
      }
      const answer = this.send(msg);
      answers.push(answer);
      flying.push({ size, done: answer });
    }
    return Promise.all(answers);
  }

  /**
   * The next event (role 0x05) that `match` accepts, taken off the queue; waits up to timeoutMs.
   * @param {(frame: Uint8Array) => boolean} match @param {number} timeoutMs
   */
  nextEvent(match, timeoutMs) {
    return this.nextFrom(this.events, this.eventListeners, match, timeoutMs);
  }

  /** @param {(frame: Uint8Array) => boolean} match @param {number} timeoutMs */
  nextPush(match, timeoutMs) {
    return this.nextFrom(this.pushes, this.pushListeners, match, timeoutMs);
  }

  /**
   * @param {Uint8Array[]} queue @param {Set<(frame: Uint8Array) => void>} listeners
   * @param {(frame: Uint8Array) => boolean} match @param {number} timeoutMs
   * @returns {Promise<Uint8Array | null>}
   */
  nextFrom(queue, listeners, match, timeoutMs) {
    const at = queue.findIndex(match);
    if (at >= 0) return Promise.resolve(queue.splice(at, 1)[0]);
    return new Promise((resolve) => {
      /** @param {Uint8Array} frame */
      const listener = (frame) => {
        if (!match(frame)) return;
        const i = queue.indexOf(frame);
        if (i >= 0) queue.splice(i, 1);
        listeners.delete(listener);
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => { listeners.delete(listener); resolve(null); }, timeoutMs);
      listeners.add(listener);
    });
  }
}
