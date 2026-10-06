// @ts-check
// A link to a probe over any transport (oep-core §3): frames the messages, matches results to requests by corr, keeps
// the probe's pushes and events.
//
// Framing follows the kind of transport. A serial port (USB CDC, USB-Serial/JTAG, a UART bridge) carries COBS + CRC
// frames 0x00 <COBS> 0x00 and the probe's raw bytes on the same line: every span between 0x00s is a candidate, and one
// that does not decode is noise (§3.1, §3.4). Vendor bulk, HID and TCP carry length(u16) message, with no CRC: a
// result for no request waiting, a length that cannot be right (over max_frame), a frame that stops half way, or a
// request with no answer in time loses the boundaries, and the link finds them again as transports §5 says (`resync`):
// it reads and discards until the input has been quiet for 50 ms and 250 ms have passed since this host last wrote
// (host_resync_wait_ms: a frame left half written is then dropped by the probe's own gap), sends a confirm and waits for
// the result with its corr (up to 3 tries; other results meanwhile are read past), then the requests still waiting go
// once more with the same corr (§5.2; one already sent twice fails with FramingLost). A frame that stops half way is a
// lost boundary on vendor bulk and HID only: TCP keeps its boundaries and a pause inside a frame is normal there
// (`Transport.keepsBoundaries`, transports §5). When pushes keep the input from going quiet for
// 1 s, the host's unsubscribe and end go out once, blind (both harmless twice); the session requests waiting then are
// not sent again (the session ended). New requests wait for the resync. While the transport is being probed (core
// §3.3) there is no resync: its confirms would be more than the probing rule allows.
//
// A request whose answer does not come in time goes once more with the same corr: the probe keeps the lock holder's
// recent results and answers the repeat from them, so a state-changing request does not run twice (§5.2). When the
// resend gets no answer either, the transport has failed (core §5.2, C-38; host guide §8): TransportFailed is thrown
// (the outcome of that request, and of every request outstanding with it, is unknown) and, before anything else goes
// out, the link recovers with the §5.1 confirm - quiet input, host_resync_wait_ms since its last write, then a confirm
// until the answer with its own corr - on a serial port too (`recoverTransport`; a length-prefixed link has just
// resynced). A changed boot_id in that confirm reaches the host as a reboot: read the state before repeating a
// state-changing request. "In time" is
// never under core §4.4's floor (C-06): the time the request's arguments set (`expectMs`) + host_wait_add_ms (1000 ms)
// + on a serial port the transfer time ((L + max_frame x (1 + notify_pending_max_frames)) x 10 / baud), counted from
// the write or, while several are outstanding, from the answer before it; max_frame is min_max_frame (64) until a
// confirm answer came on the transport, then the latest one's (core §4.4, N-1), the link's own confirms included. The
// link's own short requests (its confirms, port_speed's procedure) keep their own waits.
//
// Frames the probe sends by itself are routed: data pushes and events are kept (`pushes`, `events`), and fn 0's
// heartbeat also goes to the host (`onHeartbeat`), which watches its boot_id like confirm's (core §6.5, §11.2). A
// result shorter than 5 bytes, or an event or data frame shorter than its header, is a broken frame; a request role
// from the probe is dropped (core §2.4, C-36).
//
// port_speed (oep-if-link §3 is the handshake, the host guide §17 the procedure; opt-in: speed.js raiseSpeed): on a
// serial port whose transport can change its rate (`setBaudRate`), the link knows the boot speed (`baseBaud`) and the
// rate now (`baud`). A completed end or port_speed revert puts the link back at the boot speed at once (obligation 6);
// a request unanswered (its resend too) while the rate is raised takes the link back to the boot speed - the probe
// went back by itself -, confirms there (up to OPEN_RETRY_MS: port_speed_idle_max_ms + 1 s, obligation 5; none
// answered = an Error, never back to the raised rate) and goes once more: the link never wedges at a rate the probe
// left; while raised each wait is at most a quarter of the lease, so this ends inside it. In use the link counts the
// frames it sees (good / broken / lost, host guide §17.3.2): at the boot speed into this session's baseline
// (`baseCounts`), raised into the last IN_USE_WINDOW_MS (3 s) - IN_USE_MIN_FRAMES (50) or more of them with more than
// max(2 x baseline, IN_USE_FLOOR 10 %) broken or lost step down at the next safe point: port_speed revert at the raised
// rate, the boot speed, a confirm. A committed rate's first period is its probation (raiseSpeed's probationBytes and
// probationMs: 32 KiB and 1 s), judged as the verify judges a flow (3 or more broken or lost over max(2 x baseline,
// 5 %)): a breakage there is a verify failure and steps down at once. Either way the rate (and anything above it) is
// not used again in that session, and the next lower candidate of that raiseSpeed call that has not failed gets a
// fresh try -> confirm -> verify -> commit (none left: the boot speed) (`speed.steppedDown`, `speed.downWhy`,
// `speed.stepDowns` with `to` and `probation`). After a rate change the link waits SWITCH_SETTLE_MS before its first byte (the
// probe switches once its answer is out; an FTDI lost the first frame sent at once). A raised rate that verified only
// one request at a time keeps that cap (`inflightCap`) on the pipelined exchange until the link is back at the boot
// speed. A committed rate also goes back after idle_ms (at most 3 s) with no good frame: while raised, the link sends a
// keepalive before a request when it has been quiet for `keepaliveMs` (1 s, and under half of the committed idle_ms;
// obligation 4), and `keepAlive()` does the same for a caller that sits idle for long. Opening a serial port (open.js
// connect) retries its first confirm for OPEN_RETRY_MS: a host that raised the speed and died leaves the probe at its
// rate until then (obligation 7).
//
// A serial port that a session holds carries no raw bytes from the probe (transports §4): a broken candidate there is
// a broken frame, most likely the reply the oldest request waits for, so that request goes once more at once (the
// same corr, answered from the probe's retry table, §5.2) instead of after its timeout. Without a session it is the
// port's raw bytes: noise, skipped.

import * as reg from './registry.js';
import * as cobs from './cobs.js';
import { COMPLETED, CORE_FN, OP, REQUEST_HEADER, ROLE_DATA, ROLE_EVENT, ROLE_RESULT, Request, Result, CONFIRM_REQUEST } from './message.js';
import { FramingLost, Timeout, TransportFailed } from './errors.js';
import { getU16, getU32, getU64, text } from './bytes.js';
import { MAX_REVISION, MIN_REVISION } from './host.js';

/** core §4.4's floor: argument time + this + the transfer time (C-06). */
export const WAIT_ADD_MS = reg.TIMING.host_wait_add_ms;
/** max_frame x this of notifications may come before an answer (core §11.4): the transfer time counts them. */
const NOTIFY_PENDING = reg.TIMING.notify_pending_max_frames;
/** Before a resync's confirm, and the first confirm on a length-prefixed port: this long since the host's last write
 * there (transports §5: probe_frame_gap_ms + 50). */
export const RESYNC_WAIT_MS = reg.TIMING.host_resync_wait_ms;

/** a serial port's answer bytes in flight at most (Linux cdc_acm lost 8 x 1008 B answer bursts; 7 passed) */
const ANSWER_BURST_MAX = 6144;
const STALL_MS = reg.TIMING.probe_frame_gap_ms;   // a frame whose bytes stop this long is not coming
/** Length-prefixed links: the resync reads and discards until the input has been quiet this long (transports §5). */
export const RESYNC_QUIET_MS = reg.TIMING.resync_quiet_ms;
/** ... and when it is still not quiet after this, sends the blind stops (unsubscribe, end). */
export const RESYNC_NOISY_MS = 1000;
/** ... confirms (each after a quiet input) before the resync gives up. */
export const RESYNC_TRIES = 3;
/** The link's own confirms (the resync, confirmRaw) ask for the revisions this client handles before the first confirm
 * (core §7.1), and for the revision in use after it (bound by Host: `confirmBody`, C-15). */
const OWN_CONFIRM = Uint8Array.from([...CONFIRM_REQUEST, MIN_REVISION, MAX_REVISION]);
/** The shortest result, data and event frames (core §4.2, §11.1): shorter ones are broken frames (C-36). */
const RESULT_HEADER = 5, DATA_HEADER = 5, EVENT_HEADER = 6;
/** fn 0's heartbeat event (core §11.2): boot_id(u32) uptime_ns(u64). */
const HEARTBEAT = reg.CORE.event.heartbeat;

/** After a baud change, before the first byte at the new rate (an M5Stack ATOM's FTDI lost it at once, oep-if-link §3). */
export const SWITCH_SETTLE_MS = 20;
/** A committed rate goes back after this with no good frame on the port (oep-if-link §3; idle_ms 0 and longer mean it). */
export const IDLE_MAX_MS = reg.TIMING.port_speed_idle_max_ms;
/** Raised: a keepalive once the link has been quiet this long (under half of idle_ms, oep-if-link §3 obligation 4). */
export const KEEPALIVE_MS = 1000;
/** port_speed_idle_max_ms + 1 s: the confirm bound at the boot speed (oep-if-link §3 obligations 5 and 7). */
export const OPEN_RETRY_MS = IDLE_MAX_MS + 1000;
/** Each of those confirms waits this long (at most the link's timeout). */
export const OPEN_TRY_MS = 500;
/** Raised, in use: the frames of the last 3 s are judged (host guide §17.3.2 item 4) ... */
export const IN_USE_WINDOW_MS = 3000;
/** ... none under this many in the window ... */
export const IN_USE_MIN_FRAMES = 50;
/** ... broken + lost over max(2 x baseline, this) steps down for the rest of the session. */
export const IN_USE_FLOOR = 0.10;
/** The step down's revert (step 2) at the raised rate waits this long, never sent again. */
export const STEP_DOWN_WAIT_MS = 200;
/** Raised, in use: each wait for an answer is a quarter of the lease, at least this (never under core §4.4's floor). */
export const RAISED_WAIT_MIN_MS = 300;

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
 * @property {boolean} [keepsBoundaries]  length frames on a stream that keeps them (TCP): a pause inside a frame is
 *   read on, never taken for lost boundaries (transports §5)
 */

/** @typedef {{ resolve: (b: Uint8Array) => void, reject: (e: unknown) => void, timer: any, message: Uint8Array, attempt: number,
 *   resent: boolean, arm: () => void }} Pending */

/**
 * A committed rate's first period in use (host guide §17.3.2 item 4): ends (passed) at a good frame once `bytes` have
 * moved both ways and `ms` have passed since `started`; FLOW_FAIL_MIN (3) or more of its frames broken or lost and a
 * ratio over `threshold` (max(2 x baseline, 5 %)) fail it.
 * @typedef {{ rate: number, trial: import('./speed.js').SpeedTrial, bytes: number, ms: number, threshold: number,
 *   started: number, settling: boolean, moved: number, frames: number, bad: number }} Probation
 */

/**
 * What a step down in use may go to: the candidates the last raiseSpeed would try (after the record and maxTries), for
 * the session it ran in, and how to try some of them (`go`, raiseSpeed's own procedure).
 * @typedef {{ rates: number[], session: number | null, go: (lower: number[]) => Promise<unknown> }} SpeedPlan
 */

/** In probation, a failure needs this many broken or lost frames (as a verify's flow, host guide §17.3.2 item 3-4). */
const PROBATION_FAIL_MIN = 3;

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
    this.stats = { retries: 0, noise: 0, corrupt: 0, stale: 0, resyncs: 0, dropped: 0, heartbeats: 0, recoveries: 0 };
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
    /** this session's frames at the boot speed (the baseline: host guide §17.3.2 item 2) */
    this.baseCounts = { good: 0, broken: 0, lost: 0 };
    this.keepaliveMs = KEEPALIVE_MS;         // raised: a keepalive once quiet this long (set from idle_ms at a commit)
    this.stepDue = '';                       // raised, in use: why the link steps down at the next safe point
    /** @type {number | null} ... the window's ratio that decided it */ this.stepRatio = null;
    /** @type {import('./speedrecord.js').SpeedRecord | null} the record raiseSpeed used, if any */ this.record = null;
    /** @type {[string | null, string] | null} its key: the port's path (null in a browser) and the unit_id */ this.recordKey = null;
    /** @type {number | null} the transport index the raised rate is on (the revert names it) */ this.speedPort = null;
    /** @type {number | null} the probe's oep.link fn, once raiseSpeed found it (oep-if-link) */ this.speedFn = null;
    /** @type {Map<number, string>} rates that broke in use in this session -> why (none at or above again) */ this.unusable = new Map();
    /** @type {Map<number, string>} every rate the line failed in this session (a step down goes below them) */ this.failed = new Map();
    /** @type {Probation | null} raised, in use: the first period at a new rate (host guide §17.3.2 item 4) */ this.probation = null;
    /** @type {SpeedPlan | null} the candidates a step down in use may go to (the lower ones) */ this.speedPlan = null;
    /** @type {number | null} when the link was last back after a breakdown (ms) ... */ this.brokeAt = null;
    /** @type {number | null} ... at this rate (settleMs: results soon after are unknown) */ this.brokeRate = null;
    /** @type {number | null} the session `unusable` belongs to */ this.unusableSession = null;
    /** @type {((op: number, payload: Uint8Array, fn?: number) => Uint8Array) | null} a request in the session (bound by Host) */ this.sessionFrame = null;
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
    this.lastTx = performance.now();         // when the link last wrote (raised: quiet for KEEPALIVE_MS = a keepalive)
    /** @type {Promise<void> | null} length-prefixed: the §5.1 resync under way (new requests wait for it) */ this.resyncing = null;
    this.discarding = false;                 // ... reading and discarding until the input is quiet
    /** @type {{ corr: number, done: (ok: boolean, frame?: Uint8Array) => void } | null} ... its confirm, waiting */ this.resyncWaiter = null;
    /** @type {() => Uint8Array[]} the host's blind stops (unsubscribe every subscription, end; bound by Host) */ this.blind = () => [];
    this.endedBlind = false;                 // the last resync sent the blind end: the session is over
    this.probing = false;                    // the probing rule runs (open.js): no resync
    /** @type {number | null} when this host last wrote to the transport (null: never; transports §5) */ this.lastWrite = null;
    /** @type {number} min_max_frame until a confirm answer, then its max_frame (the wait's transfer time; §4.4, N-1) */
    this.probeMaxFrame = reg.MIN_MAX_FRAME;
    /** @type {(bootId: number, uptimeNs: bigint) => void} fn 0's heartbeat read off the line (bound by Host) */ this.onHeartbeat = () => {};
    /** @type {(bootId: number) => void} the boot_id of the link's own confirms (resync, recovery; bound by Host) */ this.onBootId = () => {};
    this.failedTransport = '';               // why: a resend went unanswered (core §5.2, C-38); recover before anything else
    /** @type {Promise<void> | null} the recovery under way (new requests wait for it) */ this.recovering = null;
    /** @type {number} the floor's host_wait_add_ms (core §4.4) */ this.waitAddMs = WAIT_ADD_MS;
    /** @type {() => Uint8Array} the link's own confirm's payload: the revision in use once bound (Host, C-15) */
    this.confirmBody = () => OWN_CONFIRM;
  }

  /** Begin reading (once). */
  async start() {
    if (this.started) return;
    this.started = true;
    await this.transport.start((chunk) => this.onData(chunk), (error) => this.onClose(error));
  }

  /** A confirm answer's max_frame on this transport (Host.confirm, every one): until the first one the transfer time
   * counts min_max_frame (64), then the latest's (core §4.4, N-1); a length-framed reader bounds frames by it.
   * @param {number} maxFrame */
  limitsSeen(maxFrame) {
    if (!maxFrame) return;
    this.probeMaxFrame = maxFrame;
    if (this.framing === 'length') this.maxFrame = maxFrame;
  }

  /** A confirm answer the link read for itself (resync, recovery, confirmRaw): its boot_id to the host (`onBootId`; a
   * change means a reboot, core §6.5) and its max_frame for the transfer time (core §4.4, N-1). @param {Uint8Array} frame */
  ownConfirmAnswer(frame) {
    let r;
    try { r = Result.unpack(frame); } catch { return; }
    const p = r.payload;
    if (!r.succeeded || p.length < 17 || text(p.subarray(0, 4)) !== reg.CONFIRM_RESULT_MAGIC || p[4] < 1) return;
    this.probeMaxFrame = Math.max(reg.MIN_MAX_FRAME, getU16(p, 6));
    this.onBootId(getU32(p, 13));
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
    const now = performance.now();
    const stalled = this.framing === 'length' && !this.transport.keepsBoundaries && this.buf.length && now - this.lastRx > STALL_MS;
    this.lastRx = now;
    if (this.discarding) return;             // the resync reads and discards until the input is quiet (§5.1)
    if (stalled) {                           // a frame that stopped half way: its rest is not coming
      this.framingLost();
      if (this.discarding) return;           // the resync began: this chunk is discarded too
    }
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
      this.moved(raw.length + 2);
      if (!shortFrame(message)) this.count('good');   // a result or a notification that decoded (host guide §17.3.2)
      this.deliver(message);
    }
  }

  cutLength() {
    for (;;) {
      if (this.buf.length < 2) return;
      const length = this.buf[0] | (this.buf[1] << 8);
      if (length === 0) { this.buf = this.buf.slice(2); continue; }   // the reserved keepalive
      if (length > this.maxFrame) {           // the boundaries are lost (§5.1)
        this.framingLost();
        return;
      }
      if (this.buf.length < 2 + length) return;
      const message = this.buf.slice(2, 2 + length);
      this.buf = this.buf.slice(2 + length);
      this.deliver(message);
    }
  }

  /** One frame that decoded: a result to the request waiting for it; events and data pushes kept (fn 0's heartbeat
   * also to `onHeartbeat`); a request role dropped (core §2.4). A frame shorter than its header is broken (C-36).
   * @param {Uint8Array} frame */
  deliver(frame) {
    const why = shortFrame(frame);
    if (why) { this.broken(frame); return; }
    const role = frame[0];
    if (role === ROLE_RESULT) {
      const corr = frame[1] | (frame[2] << 8);
      if (this.resyncWaiter) {                  // the resync's confirm: any result with its corr proves the boundaries
        if (corr === this.resyncWaiter.corr) this.resyncWaiter.done(true, frame);
        else this.stats.stale++;                // read past until then
        return;
      }
      const p = this.pending.get(corr);
      if (!p) {                                 // a late answer to a request already answered, or someone else's
        this.stats.stale++;
        if (this.framing === 'length') this.framingLost(false);   // no CRC here: the boundaries may be off (§5.1)
        return;
      }
      this.pending.delete(corr);
      clearTimeout(p.timer);
      p.resolve(frame);
      // several outstanding: each one's wait starts again from the answer before it (core §4.4)
      if (!this.resyncing) for (const q of this.pending.values()) { clearTimeout(q.timer); q.arm(); }
    } else if (role === ROLE_EVENT) {
      if (frame[1] === 0 && frame[2] === 0 && frame[5] === HEARTBEAT && frame.length >= EVENT_HEADER + 12) {
        this.stats.heartbeats++;
        this.onHeartbeat(getU32(frame, EVENT_HEADER), getU64(frame, EVENT_HEADER + 4));
      }
      this.events.push(frame);
      for (const l of this.eventListeners) l(frame);
    } else if (role === ROLE_DATA) {
      this.pushes.push(frame);
      for (const l of this.pushListeners) l(frame);
    } else {
      this.stats.dropped++;                     // a role this client does not handle (§2.4)
    }
  }

  /** A frame that decoded but cannot be read (C-36): on a length-framed link the boundaries are in doubt (the §5.1
   * resync follows); on a serial port it is a broken frame like a bad CRC - the awaited answer while a session holds
   * the port (resent at once, §5.2), noise otherwise. @param {Uint8Array} frame */
  broken(frame) {
    if (this.framing === 'length') { this.framingLost(); return; }
    if (this.held()) {
      this.count('broken');
      this.resendNow();
      return;
    }
    this.stats.noise += frame.length;
  }

  /** A broken frame on a held port: the oldest request still waiting goes once more now (its one resend), not after
   * its timeout. One sent with resend off fails at once with cobs.CorruptFrame; one already resent fails the
   * transport (TransportFailed, `broken`; core §5.2, C-38). */
  resendNow() {
    const first = this.pending.entries().next();
    if (first.done) return;
    const [corr, p] = first.value;
    this.stats.corrupt++;
    if (p.attempt !== 0) {
      clearTimeout(p.timer);
      this.pending.delete(corr);
      if (p.resent) p.reject(this.transportFailed(`corr ${corr}: its resend's answer came broken too`, true));
      else p.reject(new cobs.CorruptFrame(`a broken frame for corr ${corr} on a held port`));
      return;
    }
    p.attempt = 1;
    p.resent = true;
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
    this.lastTx = this.lastWrite = performance.now();
    this.moved(bytes.length);
    const max = this.transport.maxWrite;
    if (!max || bytes.length <= max) return this.transport.write(bytes);
    for (let at = 0; at < bytes.length; at += max) await this.transport.write(bytes.subarray(at, at + max));
  }

  /**
   * The answer to one request (its bytes, the corr in them), sent once more after a missing answer (§5.2).
   * expectMs: the time its arguments set on the probe (Host.request): its answer is waited for at least core §4.4's
   * floor (`waitFloorMs`), at any rate.
   * @param {Uint8Array} message @param {{ expectMs?: number }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async send(message, { expectMs = 0 } = {}) {
    if (this.falling) await this.falling.catch(() => {});   // a step down or fall back under way: after it, at its rate
    if (this.failedTransport || this.recovering) await this.recoverTransport();   // nothing else goes out before (§5.2, C-38)
    await this.keepRaised();
    const at = this.baud;
    let reply;
    try {
      reply = await this.sendOnce(message, { timeoutMs: this.waitMs(expectMs, message) });
    } catch (e) {
      if (!(e instanceof Timeout || e instanceof cobs.CorruptFrame) || !(await this.speedFallback(e, at))) throw e;
      this.failedTransport = '';            // the fall back confirmed the probe at the boot speed: recovered
      reply = await this.sendOnce(message, { timeoutMs: this.waitMs(expectMs, message) });   // once more at the boot speed (the probe answers a repeat from what it kept)
    }
    if (this.baseBaud !== null && this.baud !== this.baseBaud && reverts(message, reply, this.speedFn)) {
      await this.setBaud(this.baseBaud);    // the probe went back right after this answer (oep-if-link §3 obligation 6)
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
   * One request on the wire (its resend after timeoutMs unless `resend` is off). The default wait is the link's own
   * (`baseWaitMs`): send() gives a host request core §4.4's floor.
   * @param {Uint8Array} message @param {{ timeoutMs?: number, resend?: boolean }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  sendOnce(message, { timeoutMs = this.baseWaitMs(), resend = this.resend } = {}) {
    if (this.resyncing) return this.resyncing.then(() => this.sendOnce(message, { timeoutMs, resend }));
    if (this.closed) return Promise.reject(this.closeError instanceof Error ? this.closeError : new Error('the link is closed'));
    const corr = message[1] | (message[2] << 8);
    return new Promise((resolve, reject) => {
      /** @type {Pending} */
      const p = { resolve, reject, timer: null, message, attempt: resend ? 0 : 1, resent: false, arm: () => {} };
      /** sent twice and no answer: the transport failed (C-38); sent once (resend off), a plain Timeout */
      const missing = () => (p.resent && !this.probing ? this.transportFailed(`corr ${corr}: no answer to it nor to its resend`, false)
        : new Timeout(`no result from the probe (corr ${corr})`));
      const arm = () => {
        p.timer = setTimeout(() => {
          this.count('lost');               // no good answer within the wait (host guide §17.3.2)
          if (this.framing === 'length' && !this.probing) {
            // length-prefixed: resync first (§5.1), then it goes once more (§5.2) - or, sent twice already, it fails
            if (p.attempt !== 0) {
              this.pending.delete(corr);
              reject(missing());
            }
            this.startResync();
            return;
          }
          if (p.attempt === 0) {
            p.attempt = 1;
            p.resent = true;
            this.stats.retries++;
            this.write(this.framed(message)).catch(reject);
            arm();
          } else {
            this.pending.delete(corr);
            reject(missing());
          }
        }, timeoutMs);
      };
      p.arm = arm;
      this.pending.set(corr, p);
      arm();
      this.write(this.framed(message)).catch((e) => { clearTimeout(p.timer); this.pending.delete(corr); reject(e); });
    });
  }

  // ---- the resync of length-prefixed frames (transports §5) ------------------------------------------------------

  /** The boundaries are lost: what was gathered is dropped. During the resync's confirm that try fails (the next one
   * reads and discards again); otherwise a resync starts (length-prefixed, not while probing).
   * @param {boolean} [drop] drop the buffer (false: a stray result, the rest is still framed as it was) */
  framingLost(drop = true) {
    if (drop) this.buf = new Uint8Array(0);
    if (this.resyncWaiter) { this.buf = new Uint8Array(0); this.resyncWaiter.done(false); return; }
    if (this.framing === 'length' && !this.probing) this.startResync();
  }

  /** Begin the §5.1 resync (once: a second call while it runs joins it). The waits of the requests in flight stop
   * until it is over. */
  startResync() {
    if (this.resyncing) return this.resyncing;
    this.stats.resyncs++;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    const run = this.resync().finally(() => { this.resyncing = null; });
    this.resyncing = run;
    return run;
  }

  /** transports §5: read and discard until the input is quiet for RESYNC_QUIET_MS, then a confirm (a read, safe to send)
   * whose answer, by its corr, proves the boundaries; RESYNC_TRIES of them. Not quiet in RESYNC_NOISY_MS (pushes keep
   * coming): the host's unsubscribe and end go out once, blind. Then the requests still waiting go once more with
   * the same corr; none back: every one fails with FramingLost. Never rejects. */
  async resync() {
    this.endedBlind = false;
    let blindSent = false;
    try {
      for (let i = 0; i < RESYNC_TRIES; i++) {
        this.discarding = true;
        this.buf = new Uint8Array(0);
        while (!(await this.quiet(RESYNC_QUIET_MS, RESYNC_NOISY_MS))) {
          if (blindSent || this.closed) {
            this.failPending(new FramingLost('resync: the input never went quiet, even after unsubscribe and end'));
            return;
          }
          blindSent = true;
          const stops = this.blind();
          if (stops.length) {
            await this.writeAll(stops);
            this.endedBlind = true;          // the session ended: a session request sent again would meet no_session
          }
        }
        await this.settleBeforeConfirm();    // still discarding: 250 ms since the last write (§5.1)
        this.discarding = false;
        this.buf = new Uint8Array(0);
        if (this.closed) break;
        if (await this.resyncConfirm()) {
          this.failedTransport = '';
          await this.resendPending();
          return;
        }
      }
      this.failPending(new FramingLost(`resync: no confirm came back in ${RESYNC_TRIES} tries`));
    } catch (e) {
      this.failPending(e);
    } finally {
      this.discarding = false;
      this.resyncWaiter = null;
    }
  }

  /** transports §5: before a resync's confirm, and the first confirm on a length-prefixed port, host_resync_wait_ms (250 ms
   * = probe_frame_gap_ms + 50) since this host last wrote there - a frame it left half written is then dropped by the
   * probe's own gap, not completed by the confirm. */
  async settleBeforeConfirm() {
    if (this.lastWrite === null) return;
    const left = this.lastWrite + RESYNC_WAIT_MS - performance.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }

  /** The first confirm on a length-prefixed port (transports §5): read and discard until the input has been quiet for
   * RESYNC_QUIET_MS (at most RESYNC_NOISY_MS), and RESYNC_WAIT_MS since this host's last write there. */
  async beforeFirstConfirm() {
    if (this.framing !== 'length') return;
    this.discarding = true;
    try {
      await this.quiet(RESYNC_QUIET_MS, RESYNC_NOISY_MS);
      await this.settleBeforeConfirm();
    } finally {
      this.discarding = false;
      this.buf = new Uint8Array(0);
    }
  }

  /** true once nothing has arrived for quietMs; false when limitMs passed first. @param {number} quietMs @param {number} limitMs */
  async quiet(quietMs, limitMs) {
    const start = performance.now();
    for (;;) {
      const now = performance.now();
      if (now - Math.max(start, this.lastRx) >= quietMs) return true;
      if (now - start >= limitMs || this.closed) return false;
      await new Promise((r) => setTimeout(r, Math.min(10, quietMs)));
    }
  }

  /** The resync's confirm: true when a result with its corr came within the link's wait (its boot_id and max_frame
   * read: `ownConfirmAnswer`). */
  resyncConfirm() {
    const corr = this.corrSource();
    return new Promise((resolve) => {
      /** @param {boolean} ok @param {Uint8Array} [frame] */
      const done = (ok, frame) => {
        clearTimeout(timer);
        this.resyncWaiter = null;
        if (ok && frame) this.ownConfirmAnswer(frame);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), this.baseWaitMs());
      this.resyncWaiter = { corr, done };
      this.write(this.framed(new Request(corr, CORE_FN, OP.confirm, this.confirmBody()).pack())).catch(() => done(false));
    });
  }

  /** After the resync: every request still waiting goes once more with the same corr (§5.2; the probe answers a repeat
   * from what it kept), in the order sent. One sent twice already, and a session request after the blind end, fail. */
  async resendPending() {
    /** @type {Uint8Array[]} */ const again = [];
    for (const [corr, p] of [...this.pending]) {
      if (p.attempt !== 0 || (this.endedBlind && sessionOf(p.message))) {
        this.pending.delete(corr);
        p.reject(new FramingLost(p.attempt !== 0 ? `the frame boundaries were lost again (corr ${corr}, already sent twice)`
          : `the resync ended the session blind (corr ${corr} not sent again)`));
        continue;
      }
      p.attempt = 1;
      p.resent = true;
      this.stats.retries++;
      p.arm();
      again.push(p.message);
    }
    if (again.length) await this.writeAll(again);
  }

  /** Each message in one write (one frame each, transports §2), in order. @param {Uint8Array[]} messages */
  async writeAll(messages) {
    for (const msg of messages) await this.write(this.framed(msg));
  }

  /** @param {unknown} error */
  failPending(error) {
    for (const [corr, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(corr);
      p.reject(error);
    }
  }

  // ---- a failed transport (core §5.2, C-38) ------------------------------------------------------------------

  /** A request's resend went unanswered (or came broken): the transport failed. Every other request outstanding fails
   * with it; on a serial port nothing else goes out before `recoverTransport` (the next request runs it; a
   * length-prefixed link has just started its §5.1 resync). -> the error for the request.
   * @param {string} what @param {boolean} broken */
  transportFailed(what, broken) {
    const why = `a request and its resend got no answer (${what})`;
    if (this.framing !== 'length') {
      this.failedTransport = why;
      this.failPending(new TransportFailed(`${why}: outstanding with it, its outcome is unknown`));
    }
    return new TransportFailed(why, { broken });
  }

  /**
   * core §5.2 / §5.1 (C-38), on every kind of frame, COBS included: read and discard until the input is quiet (at most
   * RESYNC_NOISY_MS), wait host_resync_wait_ms since this host's last write, then a confirm until the answer with its
   * own corr comes (other frames read past); RESYNC_TRIES of them. The confirm's boot_id goes to the host (a reboot,
   * core §6.5). None answered: TransportFailed (`recovery`), and the transport stays failed (close and open it again).
   * A length-prefixed link runs its §5.1 resync. Several callers share one recovery.
   * @param {number} [tries] @returns {Promise<void>}
   */
  recoverTransport(tries = RESYNC_TRIES) {
    if (this.recovering) return this.recovering;
    const run = async () => {
      if (this.framing === 'length') {
        await this.startResync();
      } else {
        let ok = false;
        for (let i = 0; i < tries && !ok && !this.closed; i++) {
          this.discarding = true;
          this.buf = new Uint8Array(0);
          try {
            await this.quiet(RESYNC_QUIET_MS, RESYNC_NOISY_MS);
            await this.settleBeforeConfirm();
          } finally {
            this.discarding = false;
            this.buf = new Uint8Array(0);
          }
          ok = await this.confirmRaw(Math.max(this.timeoutMs, this.waitAddMs + this.transferMs()));
        }
        if (!ok) {
          throw new TransportFailed(`the transport failed (${this.failedTransport || 'a resend went unanswered'}) and no confirm `
            + `came back in ${tries} tries: close and open it again`, { recovery: true });
        }
      }
      this.failedTransport = '';
      this.stats.recoveries++;
    };
    this.recovering = run().finally(() => { this.recovering = null; });
    return this.recovering;
  }

  // ---- port_speed (oep-if-link §3) -------------------------------------------------------------------------------

  /**
   * The host side of the serial port to `rate`, settled (SWITCH_SETTLE_MS); what was gathered so far dropped. The host
   * switches to the baud it asked for; `fallback` (the probe's answer, the rate it really makes) is set only when the
   * platform refuses `rate` (oep-if-link §3 obligation 2). Back at the boot speed, the in-flight cap a raised rate had is
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
    const confirm = this.confirmBody();
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      try {
        this.ownConfirmAnswer(await this.sendOnce(new Request(this.corrSource(), CORE_FN, OP.confirm, confirm).pack(), { timeoutMs: Math.max(1, deadline - performance.now()), resend: false }));
        this.failedTransport = '';           // a confirm answered: the transport is in step (§5.1)
        return true;
      } catch (e) {
        if (e instanceof cobs.CorruptFrame && performance.now() < deadline) continue;   // a leftover read past: ask again
        if (e instanceof Timeout || e instanceof cobs.CorruptFrame) return false;
        throw e;
      }
    }
  }

  /** Confirms, each waiting eachMs, until one is answered (true) or waitMs has passed (false).
   * @param {number} waitMs @param {number} eachMs */
  async confirmWithin(waitMs, eachMs) {
    const deadline = performance.now() + waitMs;
    for (;;) {
      if (await this.confirmRaw(eachMs)) return true;
      if (performance.now() >= deadline) return false;
    }
  }

  /** At the boot speed again, the probe confirmed there: a confirm every 250 ms up to waitMs (default
   * port_speed_idle_max_ms + 1 s, oep-if-link §3 obligation 5; a probe still trying waits out its verify_ms, one committed
   * reverts at the broken candidates these make - 3 in a row). @param {number} waitMs */
  async backToBase(waitMs = OPEN_RETRY_MS) {
    this.inflightCap = 0;
    if (this.baseBaud === null) return false;
    await this.setBaud(this.baseBaud);
    return this.confirmWithin(waitMs, 250);
  }

  /** A serial port just opened: a confirm at the boot speed, retried for OPEN_RETRY_MS (port_speed_idle_max_ms and a
   * second; at least the link's timeout) - a host that raised the speed and died leaves the probe at that rate until its
   * idle limit runs out (oep-if-link §3 item 6). Rejects with Timeout when none was answered. @param {number} [waitMs] */
  async waitBootSpeed(waitMs = Math.max(OPEN_RETRY_MS, this.timeoutMs)) {
    if (!(await this.confirmWithin(waitMs, Math.min(this.timeoutMs, OPEN_TRY_MS)))) {
      throw new Timeout(`no answer to confirm at ${this.baud ?? 'the port\'s rate'} for ${(waitMs / 1000).toFixed(1)} s`);
    }
  }

  /** The host side runs above the boot speed. */
  raised() { return this.baseBaud !== null && this.baud !== this.baseBaud; }

  /** While a raised rate is in force and a session holds the port: a keepalive when the link has been quiet for
   * `keepaliveMs` (1 s, and under half of the committed idle_ms: oep-if-link §3 obligation 4). The probe goes back to the
   * boot speed after idle_ms (at most 3 s) with no good frame; every request already does this before it goes out, so
   * only a caller that sits idle for long (waiting on a person, a sleep between requests) calls it - often is fine, it
   * sends nothing otherwise. true when one went out. */
  async keepAlive() {
    if (!this.raised() || !this.keepaliveFrame || !this.held()) return false;
    if (performance.now() - this.lastTx < this.keepaliveMs) return false;
    this.lastTx = performance.now();         // before sending: send() asks again and must not recurse
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

  /** The link's own wait for one answer: the link's timeout; raised and in use, at most a quarter of the session's
   * lease (at least RAISED_WAIT_MIN_MS) - a probe that went back by itself (broken candidates, oep-if-link §3 item 5) hears
   * nothing at the raised rate, and the fall back (both waits, the confirm at the boot speed, the request again there)
   * must end inside the lease. */
  baseWaitMs() {
    const lease = this.inUse() ? this.lease() : null;
    return lease ? Math.min(this.timeoutMs, Math.max(RAISED_WAIT_MIN_MS, lease / 4)) : this.timeoutMs;
  }

  /** core §4.4's transfer time of one answer on this port, in ms: (L + max_frame x (1 + notify_pending_max_frames)) x 10
   * / baud on a port with a line speed (a serial port; 0 elsewhere), L the request's frame on the wire. The rule asks
   * it of a UART bridge only; counting it on every serial port only waits longer, which it allows.
   * @param {Uint8Array | number} [request] the request (its frame is measured) or its frame's length */
  transferMs(request = 0) {
    const baud = this.baud ?? this.transport.baudRate;
    if (this.framing !== 'cobs' || !baud) return 0;
    const len = typeof request === 'number' ? request : cobs.frame(request).length;
    return (len + this.probeMaxFrame * (1 + NOTIFY_PENDING)) * 10 / baud * 1000;
  }

  /** The least a host request's answer is waited for (core §4.4, C-06): the time its arguments set (`expectMs`:
   * run's timeoutMs, dmi's waits, attach / scan budgets, a save) + host_wait_add_ms + the transfer time.
   * @param {number} [expectMs] @param {Uint8Array | number} [request] */
  waitFloorMs(expectMs = 0, request = 0) { return Math.max(0, expectMs) + this.waitAddMs + this.transferMs(request); }

  /** How long a host request's answer is waited for: the link's own wait (`baseWaitMs`), never under core §4.4's floor
   * (`waitFloorMs`). @param {number} [expectMs] @param {Uint8Array | number} [request] */
  waitMs(expectMs = 0, request = 0) { return Math.max(this.baseWaitMs(), this.waitFloorMs(expectMs, request)); }

  /**
   * One frame the host side saw while a session holds the port: `kind` good / broken / lost (host guide §17.3.2: good =
   * a result or notification that decoded, broken = a candidate that did not, lost = a request with no good answer
   * within its wait). At the boot speed it goes into this session's baseline (`baseCounts`); raised and in use into the
   * 3 s window, judged on every bad one: IN_USE_MIN_FRAMES or more in the window and a ratio over max(2 x baseline,
   * IN_USE_FLOOR) make the link step down at the next safe point. While the rate is in its probation, its frames are
   * also judged as the verify judges a flow: 3 or more broken or lost and a ratio over max(2 x baseline, 5 %) step down
   * at once (a verify failure, not an in-use one); a good frame once probationBytes have moved and probationMs have
   * passed ends the probation.
   * @param {'good' | 'broken' | 'lost'} kind
   */
  count(kind) {
    if (this.baseBaud === null || !this.held()) return;
    if (this.baud === this.baseBaud) { this.baseCounts[kind]++; return; }
    if (!this.inUse()) return;
    const now = performance.now();
    const p = this.probation;
    if (p && p.rate === this.baud) {
      p.frames++;
      if (kind !== 'good') {
        p.bad++;
        const ratio = p.bad / p.frames;
        if (!this.stepDue && p.bad >= PROBATION_FAIL_MIN && ratio > p.threshold) {
          this.stepRatio = ratio;
          this.stepDue = `in probation: ${p.bad} of ${p.frames} frames broken or lost at ${this.baud} after ${p.moved} bytes `
            + `(${(ratio * 100).toFixed(1)}%, over ${Math.round(p.threshold * 100)}%)`;
        }
      } else if (p.moved >= p.bytes && now - p.started >= p.ms) {
        this.probationPassed(p);
      }
    }
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

  /** Bytes on the line at a raised rate in use (both ways): the probation counts them. @param {number} n */
  moved(n) {
    const p = this.probation;
    if (p && p.rate === this.baud && this.inUse()) { p.moved += n; p.trial.probationBytes = p.moved; }
  }

  /** @param {Probation} p */
  probationPassed(p) {
    this.probation = null;
    p.trial.probation = 'passed';
    p.trial.probationBytes = p.moved;
    if (this.record && this.recordKey) this.record.note(this.recordKey[0], this.recordKey[1], p.rate, true, 'probation');
  }

  /**
   * `rate` broke (in its probation or later in use): not used again in this session, nor anything at or above it; the
   * report and the record say so. A probation's failure is a verify failure (phase 'probation'), a later one an in-use
   * failure ('in_use'); a probation measured within settleMs of a breakdown at another rate is written unknown.
   * @param {number} rate @param {string} why @param {boolean} lost  no answer came (the probe went back by itself)
   */
  stepped(rate, why, lost) {
    const p = this.probation;
    this.probation = null;
    const inProbation = !!p && p.rate === rate;
    if (inProbation && !why.startsWith('in probation')) why = `in probation: ${why}`;
    if (lost) this.speedLost++;
    this.unusable.set(rate, why);
    this.failed.set(rate, why);
    if (this.speed) {
      this.speed.rate = /** @type {number} */ (this.baseBaud);
      this.speed.chosen = null;
      if (lost) this.speed.lost = true;
      this.speed.steppedDown = true;
      this.speed.downWhy = why;
      this.speed.stepDowns.push({ at: Date.now(), rate, why, ratio: this.stepRatio, to: this.baseBaud, probation: inProbation });
    }
    if (p && inProbation) p.trial.probation = 'failed';
    this.stepRatio = null;
    if (this.record && this.recordKey) {
      this.record.note(this.recordKey[0], this.recordKey[1], rate, inProbation && p?.settling ? null : false, inProbation ? 'probation' : 'in_use');
    }
    this.brokeAt = performance.now();
    this.brokeRate = rate;
  }

  /**
   * After a breakdown in use, back at the boot speed: the next lower candidate of the last raiseSpeed's plan that has
   * not failed in this session (below every rate that has) gets a fresh try -> confirm -> verify -> commit, the next
   * after it if that fails; none left (or none passes): the boot speed for the rest of the session. The report's last
   * step down says where the link went (`to`).
   */
  async stepLower() {
    const plan = this.speedPlan;
    if (!plan || plan.session !== this.unusableSession || !this.unusable.size) return;
    const ceiling = Math.min(...this.unusable.keys(), ...this.failed.keys());
    const lower = [...new Set(plan.rates.filter((r) => r < ceiling))].sort((a, b) => b - a);
    if (lower.length) {
      const saved = this.fallback;
      this.fallback = false;                 // every failure there is handled there
      try { await plan.go(lower); } finally { this.fallback = saved; }
    }
    const last = this.speed?.stepDowns.at(-1);
    if (last) last.to = this.baud;
  }

  async stepDownIfDue() {
    if (this.stepDue && this.inUse()) await this.leave(this.stepDue, true);
  }

  /**
   * Leave the raised rate for the rest of the session (one at a time; a second caller waits for the first).
   * revert: port_speed step 2 at it first (STEP_DOWN_WAIT_MS, never sent again: a probe that already went back cannot
   * hear it, and a committed one reverts at the broken candidates the confirms make). Then the boot speed and a
   * confirm there; the rate (and anything above it) is unusable for the session and the report says why; then the next
   * lower candidate (`stepLower`). Rejects when no confirm is answered. Other requests wait for all of it (`falling`);
   * raiseSpeed's own requests in it go straight to the line.
   * @param {string} why @param {boolean} revert @returns {Promise<boolean>}
   */
  leave(why, revert) {
    if (this.falling) return this.falling;
    const from = /** @type {number} */ (this.baud);
    this.stepDue = '';
    this.window = [];
    this.falling = (async () => {
      try {
        if (revert && this.sessionFrame && this.speedPort !== null && this.speedFn !== null) {
          const payload = new Uint8Array(12);
          payload[0] = this.speedPort;
          payload[5] = reg.LINK.enum.port_speed_step.revert;
          const saved = this.fallback;
          this.fallback = false;
          try {
            await this.sendOnce(this.sessionFrame(reg.LINK.op.port_speed, payload, this.speedFn), { timeoutMs: STEP_DOWN_WAIT_MS, resend: false });
          } catch { /* lost: the probe goes back by itself */ } finally {
            this.fallback = saved;
          }
        }
        if (!(await this.backToBase())) throw new Error(`the probe answers neither at ${from} nor at the boot speed ${this.baseBaud}`);
        this.stepped(from, why, !revert);
        await this.stepLower();
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
   * back by itself (idle_ms, broken candidates, a lapse) - back to the boot speed, confirmed. Either way the rate (and
   * anything above it) is not used again in this session, and the next lower candidate is tried (`stepLower`). Already
   * left (another request did it): just send again. true = send again.
   * @param {unknown} [e] @param {number | null} [at]
   */
  async speedFallback(e, at = this.baud) {
    if (this.falling) return this.falling;
    if (this.baseBaud === null) return false;
    if (at !== null && at !== this.baseBaud && at !== this.baud && this.unusable.has(at)) return true;
    if (!this.inUse()) return false;
    const from = this.baud;
    if (this.stepDue || !(e instanceof Timeout) || (e instanceof TransportFailed && e.broken)) return this.leave(this.stepDue || `frames kept breaking at ${from}`, true);
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
   * outstanding; answers in order. expectMs: each one's argument time (core §4.4).
   * @param {Uint8Array[]} messages @param {{ maxInflight: number, window: number, maxFrame?: number, expectMs?: number }} limits
   */
  async exchange(messages, { maxInflight: probeMax, window, maxFrame = 0, expectMs = 0 }) {
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
      const answer = this.send(msg, expectMs ? { expectMs } : undefined);
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

/** Why a frame that decoded is too short to read (C-36): '' when it is not. @param {Uint8Array} frame */
function shortFrame(frame) {
  if (!frame.length) return 'an empty frame';
  const role = frame[0];
  if (role === ROLE_RESULT && frame.length < RESULT_HEADER) return 'a result shorter than its header';
  if (role === ROLE_EVENT && frame.length < EVENT_HEADER) return 'an event shorter than its header';
  if (role === ROLE_DATA && frame.length < DATA_HEADER) return 'a data frame shorter than its header';
  return '';
}

/** A request's session_id (core §4.1: bytes 6-9 of the header; 0 = no session). @param {Uint8Array} message */
function sessionOf(message) { return message.length >= REQUEST_HEADER ? getU32(message, 6) : 0; }

/** The op of a request to `fn` whose answer is completed (any outcome); null for anything else.
 * @param {Uint8Array} message @param {Uint8Array} reply @param {number | null} fn */
function completed(message, reply, fn = CORE_FN) {
  if (fn === null || message.length < REQUEST_HEADER || reply.length < 4 || reply[3] !== COMPLETED
      || (message[3] | (message[4] << 8)) !== fn) return null;
  return message[5];
}

/** The op of a core request whose answer is completed (any outcome); null for anything else.
 * @param {Uint8Array} message @param {Uint8Array} reply */
function coreCompleted(message, reply) { return completed(message, reply); }

/** A completed end, or port_speed's revert on oep.link (`speedFn`): the probe is back at its boot speed once this
 * answer is out (oep-if-link §3 host obligation 6).
 * @param {Uint8Array} message @param {Uint8Array} reply @param {number | null} speedFn */
function reverts(message, reply, speedFn) {
  if (coreCompleted(message, reply) === OP.end) return true;
  const at = REQUEST_HEADER + 5;   // port(u8) baud(u32) step(u8)
  return completed(message, reply, speedFn) === reg.LINK.op.port_speed && message.length > at
    && message[at] === reg.LINK.enum.port_speed_step.revert;
}
