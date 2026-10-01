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
//
// port_speed (oep-core §3.5 is the handshake, the host guide §7 the procedure; opt-in: speed.js raiseSpeed): on a
// serial port whose transport can change its rate (`setBaudRate`), the link knows the boot speed (`baseBaud`) and the
// rate now (`baud`). A completed end or port_speed revert puts the link back at the boot speed at once (obligation 6);
// a request unanswered (its resend too) while the rate is raised takes the link back to the boot speed - the probe
// went back by itself -, confirms there (up to OPEN_RETRY_MS: port_speed_idle_max_ms + 1 s, obligation 5; none
// answered = an Error, never back to the raised rate) and goes once more: the link never wedges at a rate the probe
// left; while raised each wait is at most a quarter of the lease, so this ends inside it. In use the link counts the
// frames it sees (good / broken / lost, host guide §7.3.2): at the boot speed into this session's baseline
// (`baseCounts`), raised into the last IN_USE_WINDOW_MS (3 s) - IN_USE_MIN_FRAMES (50) or more of them with more than
// max(2 x baseline, IN_USE_FLOOR 10 %) broken or lost step down at the next safe point: port_speed revert at the raised
// rate, the boot speed, a confirm. Either way the rate is not used again in that session (`speed.steppedDown`,
// `speed.downWhy`, `speed.stepDowns`). After a rate change the link waits SWITCH_SETTLE_MS before its first byte (the
// probe switches once its answer is out; an FTDI lost the first frame sent at once). A raised rate that verified only
// one request at a time keeps that cap (`inflightCap`) on the pipelined exchange until the link is back at the boot
// speed. A committed rate also goes back after idle_ms (at most 3 s) with no good frame: while raised, the link sends a
// keepalive before a request when it has been quiet for `keepaliveMs` (1 s, and under half of the committed idle_ms;
// obligation 4), and `keepAlive()` does the same for a caller that sits idle for long. Opening a serial port (open.js
// connect) retries its first confirm for OPEN_RETRY_MS: a host that raised the speed and died leaves the probe at its
// rate until then (obligation 7).
//
// A serial port that a session holds carries no raw bytes from the probe (oep-core §3.4): a broken candidate there is
// a broken frame, most likely the reply the oldest request waits for, so that request goes once more at once (the
// same corr, answered from the probe's retry table, §5.2) instead of after its timeout. Without a session it is the
// port's raw bytes: noise, skipped.

import * as reg from './registry.js';
import * as cobs from './cobs.js';
import { COMPLETED, CORE_FN, OP, ROLE_DATA, ROLE_EVENT, ROLE_RESULT, ROLE_SESSION, Request, CONFIRM_REQUEST } from './message.js';
import { Timeout } from './errors.js';

/** a serial port's answer bytes in flight at most (Linux cdc_acm lost 8 x 1008 B answer bursts; 7 passed) */
const ANSWER_BURST_MAX = 6144;
const STALL_MS = reg.TIMING.probe_frame_gap_ms;   // a frame whose bytes stop this long is not coming
/** After a baud change, before the first byte at the new rate (an M5Stack ATOM's FTDI lost it at once, core §3.5). */
export const SWITCH_SETTLE_MS = 20;
/** A committed rate goes back after this with no good frame on the port (core §3.5; idle_ms 0 and longer mean it). */
export const IDLE_MAX_MS = reg.TIMING.port_speed_idle_max_ms;
/** Raised: a keepalive once the link has been quiet this long (under half of idle_ms, core §3.5 obligation 4). */
export const KEEPALIVE_MS = 1000;
/** port_speed_idle_max_ms + 1 s: the confirm bound at the boot speed (core §3.5 obligations 5 and 7). */
export const OPEN_RETRY_MS = IDLE_MAX_MS + 1000;
/** Each of those confirms waits this long (at most the link's timeout). */
export const OPEN_TRY_MS = 500;
/** Raised, in use: the frames of the last 3 s are judged (host guide §7.3.2 item 4) ... */
export const IN_USE_WINDOW_MS = 3000;
/** ... none under this many in the window ... */
export const IN_USE_MIN_FRAMES = 50;
/** ... broken + lost over max(2 x baseline, this) steps down for the rest of the session. */
export const IN_USE_FLOOR = 0.10;
/** The step down's revert (step 2) at the raised rate waits this long, never sent again. */
export const STEP_DOWN_WAIT_MS = 200;
/** Raised, in use: each wait for an answer is a quarter of the lease, at least this. */
export const RAISED_WAIT_MIN_MS = 300;
/** A request that may take long on the probe (Host.request expectMs): waited that long and this. */
export const EXPECT_MARGIN_MS = 500;

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
 * @property {number} [baudRate]          a serial port's rate now (what it was opened with, then set)
 * @property {(rate: number) => Promise<void>} [setBaudRate]   a serial port this host opened: change its rate
 * @property {string} [path]              a serial port's OS device path (the port_speed record's key, with the unit_id)
 */

/** @typedef {{ resolve: (b: Uint8Array) => void, reject: (e: unknown) => void, timer: any, message: Uint8Array, attempt: number, arm: () => void }} Pending */

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
    this.resend = true;                      // a missing answer: the request once more with the same corr
    /** @type {number | null} the boot speed every port_speed revert goes back to (serial ports that can change it) */
    this.baseBaud = transport.setBaudRate && transport.baudRate ? transport.baudRate : null;
    /** @type {number | null} the rate the host side runs at now */ this.baud = this.baseBaud;
    /** @type {import('./speed.js').SpeedReport | null} the last raiseSpeed's report */ this.speed = null;
    this.speedLost = 0;                      // times a raised rate was found gone (back to the boot speed)
    this.fallback = true;                    // a raised rate in use (not raiseSpeed's own trial): fall back / step down
    /** @type {[number, boolean][]} raised, in use: (when, bad) per frame of the last IN_USE_WINDOW_MS */ this.window = [];
    this.baselineRatio = 0;                  // raised, in use: the boot speed's ratio the threshold doubles
    /** this session's frames at the boot speed (the baseline: host guide §7.3.2 item 2) */
    this.baseCounts = { good: 0, broken: 0, lost: 0 };
    this.keepaliveMs = KEEPALIVE_MS;         // raised: a keepalive once quiet this long (set from idle_ms at a commit)
    this.stepDue = '';                       // raised, in use: why the link steps down at the next safe point
    /** @type {number | null} ... the window's ratio that decided it */ this.stepRatio = null;
    /** @type {import('./speedrecord.js').SpeedRecord | null} the record raiseSpeed used, if any */ this.record = null;
    /** @type {[string | null, string] | null} its key: the port's path (null in a browser) and the unit_id */ this.recordKey = null;
    /** @type {number | null} the transport index the raised rate is on (the revert names it) */ this.speedPort = null;
    /** @type {Map<number, string>} rates stepped down from in this session -> why (raiseSpeed skips them) */ this.unusable = new Map();
    /** @type {number | null} the session `unusable` belongs to */ this.unusableSession = null;
    /** @type {((op: number, payload: Uint8Array) => Uint8Array) | null} a core request in the session (bound by Host) */ this.sessionFrame = null;
    /** @type {() => number | null} the session's lease (bound by Host; raised: bounds each wait) */ this.lease = () => null;
    /** @type {() => number | null} the session id (bound by Host) */ this.sessionId = () => null;
    this.inflightCap = 0;                    // port_speed: the in-flight requests the raised rate verified with (0: no cap)
    this.answerBurst = ANSWER_BURST_MAX;     // serial ports: answer bytes in flight at most (0: no bound)
    /** @type {() => boolean} a session holds the port (its raw transfer stopped): a broken frame = resend */
    this.held = () => false;
    /** @type {() => number} */ this.corrSource = () => { this.ownCorr = (this.ownCorr % 0xffff) + 1; return this.ownCorr; };
    this.ownCorr = 0x8000;
    /** @type {Promise<boolean> | null} */ this.falling = null;
    /** @type {(() => Uint8Array) | null} a keepalive in the session (bound by Host) */ this.keepaliveFrame = null;
    this.lastTx = Date.now();                // when the link last wrote (raised: quiet for KEEPALIVE_MS = a keepalive)
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
        if (this.held()) {                  // ... unless a session holds the port: then it was a broken frame (§5.2)
          this.count('broken');
          this.resendNow();
        }
        continue;
      }
      this.count('good');                   // a result or a notification that decoded (host guide §7.3.2)
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

  /** A broken frame on a held port: the oldest request still waiting goes once more now (its one resend), not after
   * its timeout. One already sent twice (or sent with resend off) fails at once with cobs.CorruptFrame. */
  resendNow() {
    const first = this.pending.entries().next();
    if (first.done) return;
    const [corr, p] = first.value;
    this.stats.corrupt++;
    if (p.attempt !== 0) {
      clearTimeout(p.timer);
      this.pending.delete(corr);
      p.reject(new cobs.CorruptFrame(`a broken frame for corr ${corr} on a held port`));
      return;
    }
    p.attempt = 1;
    this.stats.retries++;
    clearTimeout(p.timer);
    p.arm();
    this.write(this.framed(p.message)).catch((e) => { clearTimeout(p.timer); this.pending.delete(corr); p.reject(e); });
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
    this.lastTx = Date.now();
    const max = this.transport.maxWrite;
    if (!max || bytes.length <= max) return this.transport.write(bytes);
    for (let at = 0; at < bytes.length; at += max) await this.transport.write(bytes.subarray(at, at + max));
  }

  /**
   * The answer to one request (its bytes, the corr in them), sent once more after a missing answer (§5.2).
   * expectMs: how long it may take on the probe (Host.request): its answer is waited for at least that and
   * EXPECT_MARGIN_MS, at any rate.
   * @param {Uint8Array} message @param {{ expectMs?: number }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async send(message, { expectMs = 0 } = {}) {
    if (this.falling) await this.falling.catch(() => {});   // a step down or fall back under way: after it, at its rate
    await this.keepRaised();
    const at = this.baud;
    let reply;
    try {
      reply = await this.sendOnce(message, { timeoutMs: this.waitMs(expectMs) });
    } catch (e) {
      if (!(e instanceof Timeout || e instanceof cobs.CorruptFrame) || !(await this.speedFallback(e, at))) throw e;
      reply = await this.sendOnce(message, { timeoutMs: this.waitMs(expectMs) });   // once more at the boot speed (the probe answers a repeat from what it kept)
    }
    if (this.baseBaud !== null && this.baud !== this.baseBaud && reverts(message, reply)) {
      await this.setBaud(this.baseBaud);    // the probe went back right after this answer (core §3.5 obligation 6)
      if (this.speed) { this.speed.rate = this.baseBaud; this.speed.chosen = null; }
    }
    if (coreCompleted(message, reply) === OP.open) {
      this.baseCounts = { good: 0, broken: 0, lost: 0 };   // a new session: its baseline starts here
      this.window = [];
    }
    await this.stepDownIfDue();
    return reply;
  }

  /**
   * One request on the wire (its resend after timeoutMs unless `resend` is off).
   * @param {Uint8Array} message @param {{ timeoutMs?: number, resend?: boolean }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  sendOnce(message, { timeoutMs = this.waitMs(), resend = this.resend } = {}) {
    if (this.closed) return Promise.reject(this.closeError instanceof Error ? this.closeError : new Error('the link is closed'));
    const corr = message[1] | (message[2] << 8);
    return new Promise((resolve, reject) => {
      /** @type {Pending} */
      const p = { resolve, reject, timer: null, message, attempt: resend ? 0 : 1, arm: () => {} };
      const arm = () => {
        p.timer = setTimeout(() => {
          this.count('lost');               // no good answer within the wait (host guide §7.3.2)
          if (p.attempt === 0) {
            p.attempt = 1;
            this.stats.retries++;
            this.write(this.framed(message)).catch(reject);
            arm();
          } else {
            this.pending.delete(corr);
            reject(new Timeout(`no result from the probe (corr ${corr})`));
          }
        }, timeoutMs);
      };
      p.arm = arm;
      this.pending.set(corr, p);
      arm();
      this.write(this.framed(message)).catch((e) => { clearTimeout(p.timer); this.pending.delete(corr); reject(e); });
    });
  }

  // ---- port_speed (core §3.5) -------------------------------------------------------------------------------

  /**
   * The host side of the serial port to `rate`, settled (SWITCH_SETTLE_MS); what was gathered so far dropped. The host
   * switches to the baud it asked for; `fallback` (the probe's answer, the rate it really makes) is set only when the
   * platform refuses `rate` (core §3.5 obligation 2). Back at the boot speed, the in-flight cap a raised rate had is
   * gone. -> the rate set.
   * @param {number} rate @param {number | null} [fallback]
   */
  async setBaud(rate, fallback = null) {
    if (!this.transport.setBaudRate) throw new Error('this transport cannot change its rate');
    try {
      await this.transport.setBaudRate(rate);
    } catch (e) {
      if (fallback === null || fallback === rate) throw e;
      await this.transport.setBaudRate(fallback);
      rate = fallback;
    }
    this.baud = rate;
    if (rate === this.baseBaud) this.inflightCap = 0;
    if (this.framing === 'cobs') await new Promise((r) => setTimeout(r, SWITCH_SETTLE_MS));   // the probe switches once its answer is out
    this.buf = new Uint8Array(0);
    return rate;
  }

  /** A confirm straight on the link: true when its answer came (unbroken) within timeoutMs. On a held serial port a
   * broken frame is normally the awaited answer (§5.2), but a confirm sent to re-sync a measurement reads past the
   * broken leftovers of the lost frames it follows: it keeps asking until its own answer or the deadline, not giving
   * up on the first broken one. @param {number} timeoutMs */
  async confirmRaw(timeoutMs) {
    const confirm = new Uint8Array(CONFIRM_REQUEST.length + 2);
    confirm.set(CONFIRM_REQUEST);
    confirm[CONFIRM_REQUEST.length + 1] = 0xff;   // revisions 0..255
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.sendOnce(new Request(this.corrSource(), CORE_FN, OP.confirm, confirm).pack(), { timeoutMs: Math.max(1, deadline - Date.now()), resend: false });
        return true;
      } catch (e) {
        if (e instanceof cobs.CorruptFrame && Date.now() < deadline) continue;   // a leftover read past: ask again
        if (e instanceof Timeout || e instanceof cobs.CorruptFrame) return false;
        throw e;
      }
    }
  }

  /** Confirms, each waiting eachMs, until one is answered (true) or waitMs has passed (false).
   * @param {number} waitMs @param {number} eachMs */
  async confirmWithin(waitMs, eachMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await this.confirmRaw(eachMs)) return true;
      if (Date.now() >= deadline) return false;
    }
  }

  /** At the boot speed again, the probe confirmed there: a confirm every 250 ms up to waitMs (default
   * port_speed_idle_max_ms + 1 s, core §3.5 obligation 5; a probe still trying waits out its verify_ms, one committed
   * reverts at the broken candidates these make - 3 in a row). @param {number} waitMs */
  async backToBase(waitMs = OPEN_RETRY_MS) {
    this.inflightCap = 0;
    if (this.baseBaud === null) return false;
    await this.setBaud(this.baseBaud);
    return this.confirmWithin(waitMs, 250);
  }

  /** A serial port just opened: a confirm at the boot speed, retried for OPEN_RETRY_MS (port_speed_idle_max_ms and a
   * second; at least the link's timeout) - a host that raised the speed and died leaves the probe at that rate until its
   * idle limit runs out (core §3.5 item 6). Rejects with Timeout when none was answered. @param {number} [waitMs] */
  async waitBootSpeed(waitMs = Math.max(OPEN_RETRY_MS, this.timeoutMs)) {
    if (!(await this.confirmWithin(waitMs, Math.min(this.timeoutMs, OPEN_TRY_MS)))) {
      throw new Timeout(`no answer to confirm at ${this.baud ?? 'the port\'s rate'} for ${(waitMs / 1000).toFixed(1)} s`);
    }
  }

  /** The host side runs above the boot speed. */
  raised() { return this.baseBaud !== null && this.baud !== this.baseBaud; }

  /** While a raised rate is in force and a session holds the port: a keepalive when the link has been quiet for
   * `keepaliveMs` (1 s, and under half of the committed idle_ms: core §3.5 obligation 4). The probe goes back to the
   * boot speed after idle_ms (at most 3 s) with no good frame; every request already does this before it goes out, so
   * only a caller that sits idle for long (waiting on a person, a sleep between requests) calls it - often is fine, it
   * sends nothing otherwise. true when one went out. */
  async keepAlive() {
    if (!this.raised() || !this.keepaliveFrame || !this.held()) return false;
    if (Date.now() - this.lastTx < this.keepaliveMs) return false;
    this.lastTx = Date.now();                // before sending: send() asks again and must not recurse
    await this.send(this.keepaliveFrame());
    return true;
  }

  /** keepAlive before a request; a keepalive that fails is left to the request itself to find out. */
  async keepRaised() {
    try {
      await this.keepAlive();
    } catch (e) {
      if (!(e instanceof Timeout || e instanceof cobs.CorruptFrame)) throw e;
    }
  }

  /** A raised rate in force outside raiseSpeed's own trial (where every failure is handled there). */
  inUse() { return this.fallback && this.raised(); }

  /** How long one answer is waited for: the link's timeout; raised and in use, at most a quarter of the session's
   * lease (at least RAISED_WAIT_MIN_MS) - a probe that went back by itself (broken candidates, core §3.5 item 5) hears
   * nothing at the raised rate, and the fall back (both waits, the confirm at the boot speed, the request again there)
   * must end well inside the lease. A request that may take longer on the probe (`expectMs`: a run's timeoutMs, a dmi
   * list's waits, ...; the probe does not count the lease meanwhile, core §6.1) waits at least that and
   * EXPECT_MARGIN_MS, at any rate. @param {number} [expectMs] */
  waitMs(expectMs = 0) {
    const lease = this.inUse() ? this.lease() : null;
    const wait = lease ? Math.min(this.timeoutMs, Math.max(RAISED_WAIT_MIN_MS, lease / 4)) : this.timeoutMs;
    return expectMs > 0 ? Math.max(wait, expectMs + EXPECT_MARGIN_MS) : wait;
  }

  /**
   * One frame the host side saw while a session holds the port: `kind` good / broken / lost (host guide §7.3.2: good =
   * a result or notification that decoded, broken = a candidate that did not, lost = a request with no good answer
   * within its wait). At the boot speed it goes into this session's baseline (`baseCounts`); raised and in use into the
   * 3 s window, judged on every bad one: IN_USE_MIN_FRAMES or more in the window and a ratio over max(2 x baseline,
   * IN_USE_FLOOR) make the link step down at the next safe point.
   * @param {'good' | 'broken' | 'lost'} kind
   */
  count(kind) {
    if (this.baseBaud === null || !this.held()) return;
    if (this.baud === this.baseBaud) { this.baseCounts[kind]++; return; }
    if (!this.inUse()) return;
    const now = Date.now();
    this.window.push([now, kind !== 'good']);
    while (this.window.length && now - this.window[0][0] > IN_USE_WINDOW_MS) this.window.shift();
    if (kind === 'good' || this.stepDue || this.window.length < IN_USE_MIN_FRAMES) return;
    const bad = this.window.filter(([, b]) => b).length;
    const ratio = bad / this.window.length, threshold = Math.max(2 * this.baselineRatio, IN_USE_FLOOR);
    if (ratio > threshold) {
      this.stepRatio = ratio;
      this.stepDue = `${bad} of ${this.window.length} frames broken or lost within ${IN_USE_WINDOW_MS / 1000} s at ${this.baud} `
        + `(${(ratio * 100).toFixed(1)}%, over ${Math.round(threshold * 100)}%)`;
    }
  }

  async stepDownIfDue() {
    if (this.stepDue && this.inUse()) await this.leave(this.stepDue, true);
  }

  /**
   * Leave the raised rate for the rest of the session (one at a time; a second caller waits for the first).
   * revert: port_speed step 2 at it first (STEP_DOWN_WAIT_MS, never sent again: a probe that already went back cannot
   * hear it, and a committed one reverts at the broken candidates the confirms make). Then the boot speed and a
   * confirm there; the rate is unusable for the session and the report says why. Rejects when no confirm is answered.
   * @param {string} why @param {boolean} revert @returns {Promise<boolean>}
   */
  leave(why, revert) {
    if (this.falling) return this.falling;
    const from = /** @type {number} */ (this.baud);
    this.stepDue = '';
    this.window = [];
    this.falling = (async () => {
      try {
        if (revert && this.sessionFrame && this.speedPort !== null) {
          const payload = new Uint8Array(12);
          payload[0] = this.speedPort;
          payload[5] = reg.CORE.enum.port_speed_step.revert;
          const saved = this.fallback;
          this.fallback = false;
          try {
            await this.sendOnce(this.sessionFrame(OP.port_speed, payload), { timeoutMs: STEP_DOWN_WAIT_MS, resend: false });
          } catch { /* lost: the probe goes back by itself */ } finally {
            this.fallback = saved;
          }
        }
        if (!(await this.backToBase())) throw new Error(`the probe answers neither at ${from} nor at the boot speed ${this.baseBaud}`);
        if (!revert) this.speedLost++;
        this.unusable.set(from, why);
        if (this.speed) {
          this.speed.rate = /** @type {number} */ (this.baseBaud);
          this.speed.chosen = null;
          if (!revert) this.speed.lost = true;
          this.speed.steppedDown = true;
          this.speed.downWhy = why;
          this.speed.stepDowns.push({ at: Date.now(), rate: from, why, ratio: this.stepRatio });
        }
        this.stepRatio = null;
        if (this.record && this.recordKey) this.record.note(this.recordKey[0], this.recordKey[1], from, false);
        return true;
      } finally {
        this.falling = null;
      }
    })();
    return this.falling;
  }

  /**
   * A request sent at rate `at` failed (its resend too) while a raised rate was in use. Broken frames (the probe still
   * answers there) or a step down already due: step down (`leave` with the revert). No answer at all: the probe went
   * back by itself (idle_ms, broken candidates, a lapse) - back to the boot speed, confirmed. Either way the rate is not
   * used again in this session. Already back (another request did it): just send again. true = send again.
   * @param {unknown} [e] @param {number | null} [at]
   */
  async speedFallback(e, at = this.baud) {
    if (this.falling) return this.falling;
    if (this.baseBaud === null) return false;
    if (at !== this.baseBaud && this.baud === this.baseBaud && this.unusable.has(/** @type {number} */ (at))) return true;
    if (!this.inUse()) return false;
    const from = this.baud;
    if (this.stepDue || !(e instanceof Timeout)) return this.leave(this.stepDue || `frames kept breaking at ${from}`, true);
    return this.leave(`no answer at ${from} (the probe went back by itself)`, false);
  }

  /**
   * How many requests this link keeps in flight: the probe's max_inflight, a raised rate's inflightCap, and on a
   * serial port the answer-burst bound. A serial port on an OS CDC driver loses answers that burst past what the driver
   * buffers (Linux cdc_acm, HS: 8 KiB; oep-spec docs/link-measurements.ja.md §1.1): on COBS links the answer bytes
   * expected in flight stay under answerBurst.
   * @param {{ maxInflight: number, maxFrame?: number }} limits
   */
  inflightFor({ maxInflight, maxFrame = 0 }) {
    let n = Math.min(maxInflight, this.inflightCap || 255);
    if (this.framing === 'cobs' && this.answerBurst && maxFrame) n = Math.min(n, Math.floor(this.answerBurst / cobs.frameMax(maxFrame)));
    return Math.max(1, n);
  }

  /**
   * Pipelined: up to maxInflight requests (and no more than a raised rate's inflightCap) and window bytes
   * outstanding; answers in order.
   * @param {Uint8Array[]} messages @param {{ maxInflight: number, window: number, maxFrame?: number }} limits
   */
  async exchange(messages, { maxInflight: probeMax, window, maxFrame = 0 }) {
    const maxInflight = this.inflightFor({ maxInflight: probeMax, maxFrame });
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

/** The op of a core request whose answer is completed (any outcome); null for anything else.
 * @param {Uint8Array} message @param {Uint8Array} reply */
function coreCompleted(message, reply) {
  if (message.length < 6 || reply.length < 4 || reply[3] !== COMPLETED || (message[3] | (message[4] << 8)) !== CORE_FN) return null;
  return message[5];
}

/** A completed end, or port_speed's revert: the probe is back at its boot speed once this answer is out.
 * @param {Uint8Array} message @param {Uint8Array} reply */
function reverts(message, reply) {
  const op = coreCompleted(message, reply);
  if (op === OP.end) return true;
  const at = 6 + (message[0] & ROLE_SESSION ? 4 : 0) + 5;   // port(u8) baud(u32) step(u8)
  return op === OP.port_speed && message.length > at && message[at] === reg.CORE.enum.port_speed_step.revert;
}
