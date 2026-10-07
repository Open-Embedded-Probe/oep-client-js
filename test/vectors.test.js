// @ts-check
// oep-spec's test vectors (test/vectors/*.json, copied from oep-spec tests/vectors, never edited) against this client's
// own code: COBS and serial frames (cobs.js), headers and TLVs (message.js), the CRCs, confirm (the request this host
// sends, the answer as Host reads it), discovery (list, describe and the header refusals of the smallest probe: the
// requests as this host builds them, the answers as it reads them), the refusals as the host reads them, the session scenarios (sessions.json: the requests open / keepalive / end / lock_state send and the
// answers as the host reads them) and the per-op vectors (ops.json: where this client has the op, its request byte for
// byte and its reading of the answer), and the ops encoding (ops_encoding.json: catalog.checkOps / unpackOps / packOps, and
// what the host does with an ops outside it). Where a vector and this code disagree, the spec's text decides (core §0 rule 4) and the vector is the
// one the spec corrects. Mirrors oep-client-python's tests/test_vectors.py (whose virtual-bench-side checks are the virtual bench's).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as catalog from '../src/catalog.js';
import * as cobs from '../src/cobs.js';
import * as core from '../src/core.js';
import * as config from '../src/config.js';
import * as m from '../src/message.js';
import { fromHex, hex } from '../src/bytes.js';
import { FnNotUsable, Locked, NotUsable, Rejected, Unavailable, Unsupported, rejection } from '../src/errors.js';
import * as reg from '../src/registry.js';
import { Writer, concat, getU32 } from '../src/bytes.js';
import { Host } from '../src/host.js';

const here = dirname(fileURLToPath(import.meta.url));
const HERE = join(here, 'vectors');
const SPEC = resolve(here, '..', '..', 'oep-spec', 'tests', 'vectors');

/** @param {string} name @returns {any} */
const load = (name) => JSON.parse(readFileSync(join(HERE, name), 'utf8'));
/** @param {string} s */
const hx = (s) => fromHex(s);

test('the copy is the spec\'s (when a sibling oep-spec checkout is there)', { skip: !existsSync(SPEC) && 'no sibling oep-spec checkout' }, () => {
  const names = (/** @type {string} */ dir) => readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  assert.deepEqual(names(HERE), names(SPEC), 'copy oep-spec tests/vectors/*.json to test/vectors');
  for (const n of names(SPEC)) assert.equal(readFileSync(join(HERE, n), 'utf8'), readFileSync(join(SPEC, n), 'utf8'), n);
});

// ---- COBS and serial frames (transports §1) --------------------------------------------------------------------------

const COBS = load('cobs.json');

test('COBS encode and decode', () => {
  for (const c of COBS.encode) {
    assert.equal(hex(cobs.encode(hx(c.data_hex))), c.encoded_hex, c.name);
    assert.equal(hex(cobs.decode(hx(c.encoded_hex))), c.data_hex, c.name);
  }
});

test('COBS: what the decoder also accepts', () => {
  for (const c of COBS.decode_also_accepts) assert.equal(hex(cobs.decode(hx(c.encoded_hex))), c.data_hex, c.name);
});

test('serial frames: CRC-16, the frame, and back', () => {
  for (const c of COBS.frames) {
    const msg = hx(c.message_hex);
    assert.equal(cobs.crc16(msg), c.crc16, c.name);
    assert.equal(hex(cobs.frame(msg)), c.frame_hex, c.name);
    const f = hx(c.frame_hex);
    assert.deepEqual(cobs.unframe(f.subarray(1, f.length - 1)), msg, c.name);
  }
});

// ---- headers and TLVs (core §2.2, §4.1, §4.2) ---------------------------------------------------------------------

const HEADERS = load('headers.json');

test('request headers', () => {
  for (const c of HEADERS.requests) {
    const req = new m.Request(c.corr, c.fn, c.op, hx(c.payload_hex), c.session_id);
    assert.equal(hex(req.pack()), c.message_hex, c.name);
    const back = m.Request.unpack(hx(c.message_hex));
    assert.deepEqual([back.corr, back.fn, back.op, hex(back.payload), back.session], [c.corr, c.fn, c.op, c.payload_hex, c.session_id], c.name);
    assert.equal(hx(c.message_hex)[0], c.role, c.name);
  }
});

test('answer headers', () => {
  for (const c of HEADERS.answers) {
    const res = new m.Result(c.corr, c.resolution, c.detail, hx(c.payload_hex));
    assert.equal(hex(res.pack()), c.message_hex, c.name);
    const back = m.Result.unpack(hx(c.message_hex));
    assert.deepEqual([back.corr, back.resolution, back.detail, hex(back.payload)], [c.corr, c.resolution, c.detail, c.payload_hex], c.name);
    assert.equal(hx(c.message_hex)[0], c.role, c.name);
  }
});

test('TLVs in the one encoding (tag, len u16, value)', () => {
  for (const c of HEADERS.tlvs) {
    const value = 'value_hex' in c ? hx(c.value_hex) : new Uint8Array(c.value_len).fill(c.value_byte);
    assert.equal(hex(m.tlv(c.tag & 0x7f, value, (c.tag & 0x80) !== 0)), c.tlv_hex, c.name);
    assert.deepEqual(m.splitTlvs(hx(c.tlv_hex)), [[c.tag, value]], c.name);
  }
});

// ---- CRCs ---------------------------------------------------------------------------------------------------------

const CHECKS = load('checks.json');

test('CRC check values (CRC-16 of transports §1)', () => {
  for (const c of CHECKS.cases.filter((/** @type {any} */ c) => c.algorithm !== 'crc8-dmseq')) {
    assert.equal(c.algorithm, 'crc16-ccitt-false', c.name);
    assert.equal(cobs.crc16(hx(c.input_hex)), c.crc, c.name);
  }
});

test('the dmseq CRC-8 and DATA0 words have no counterpart here', () => {
  // the probe's and the target's (target-console-dmseq): this client reads a console's bytes, it never decodes dmseq
  // words. Listed so a new algorithm in checks.json is not missed.
  // no CRC-32 any more (core §5.2: the resend table is corr and answer alone)
  assert.deepEqual(new Set(CHECKS.cases.map((/** @type {any} */ c) => c.algorithm)), new Set(['crc16-ccitt-false', 'crc8-dmseq']));
});

// ---- confirm (core §7.1) ------------------------------------------------------------------------------------------

const CONFIRM = load('confirm.json').exchanges;

/** A Host whose link answers every request with `answer` (bytes). @param {Uint8Array} answer @param {number} corr */
function answering(answer, corr) {
  /** @type {Uint8Array[]} */ const sent = [];
  const link = /** @type {any} */ ({ framing: 'length', maxFrame: 0xffff, async send(/** @type {Uint8Array} */ b) { sent.push(b); return answer; } });
  const hst = new Host(link);
  hst.corr = corr - 1;                                            // the host's next corr is the vector's
  return { hst, sent };
}

test('confirm: the request bytes, as a serial frame and as a length frame', () => {
  for (const c of CONFIRM) {
    const q = c.request;
    const req = new m.Request(q.corr, 0, m.OP.confirm, Uint8Array.from([...m.CONFIRM_REQUEST, q.min_rev, q.max_rev]));
    assert.equal(hex(req.pack()), c.request_hex, c.name);
    if (c.request_serial_frame_hex) assert.equal(hex(cobs.frame(req.pack())), c.request_serial_frame_hex, c.name);
    if (c.request_length_frame_hex) {
      const p = req.pack();
      assert.equal(hex(Uint8Array.from([p.length & 0xff, p.length >> 8, ...p])), c.request_length_frame_hex, c.name);
    }
  }
});

test('confirm: what Host sends and how it reads the answer (limits, transport; unsupported with the range)', async () => {
  for (const c of CONFIRM) {
    const a = c.answer, q = c.request;
    if (c.answer_serial_frame_hex) assert.equal(hex(cobs.frame(hx(c.answer_hex))), c.answer_serial_frame_hex, c.name);
    const { hst, sent } = answering(hx(c.answer_hex), q.corr);
    if (a.reason) {
      await assert.rejects(hst.confirm(q.min_rev, q.max_rev), (e) => e instanceof Unsupported && e.tag === null
        && JSON.stringify(e.supported) === JSON.stringify(a.supported), c.name);
    } else {
      const limits = await hst.confirm(q.min_rev, q.max_rev);
      assert.deepEqual({ revision: limits.revision, flags: limits.flags, maxFrame: limits.maxFrame, window: limits.window,
        maxInflight: limits.maxInflight, bootId: limits.bootId, transport: limits.transport },
      { revision: a.revision, flags: a.flags, maxFrame: a.max_frame, window: a.window, maxInflight: a.max_inflight,
        bootId: a.boot_id, transport: a.transport }, c.name);
    }
    assert.equal(hex(sent[0]), c.request_hex, c.name);
  }
});

test('confirm: the vector\'s first exchange is what a new Host asks (1..1)', async () => {
  const c = CONFIRM.find((/** @type {any} */ e) => !e.answer.reason);
  const { hst, sent } = answering(hx(c.answer_hex), c.request.corr);
  await hst.confirm();
  assert.equal(hex(sent[0]), c.request_hex);
  assert.deepEqual(hst.confirmRange(), [1, 1]);                   // and every later confirm asks for the revision in use
});

// ---- discovery: list, describe and the header refusals of the smallest probe (core §7.2, §7.3, §4.3 order 1) ---------

const DISCOVERY = load('discovery.json');

test('discovery: the requests as the host builds them, as serial frames too', () => {
  for (const c of DISCOVERY.exchanges) {
    const q = c.request;
    let req;
    if (!('fn' in q)) {                                          // list: first(u16) alone (core §7.2)
      req = new m.Request(q.corr, 0, m.OP.list, catalog.packListRequest(q.first));
    } else {
      req = new m.Request(q.corr, 0, m.OP.describe, catalog.packDescribeRequest(q.fn, q.first));
    }
    assert.equal(hex(req.pack()), c.request_hex, c.name);
    if (c.request_serial_frame_hex) assert.equal(hex(cobs.frame(req.pack())), c.request_serial_frame_hex, c.name);
    if (c.answer_serial_frame_hex) assert.equal(hex(cobs.frame(hx(c.answer_hex))), c.answer_serial_frame_hex, c.name);
  }
});

test('discovery: the answers as the host reads them (list, describe, past the end)', async () => {
  for (const c of DISCOVERY.exchanges) {
    const a = c.answer;
    const res = m.Result.unpack(hx(c.answer_hex));
    assert.deepEqual([res.corr, res.succeeded], [a.corr, true], c.name);
    if (a.entries) {
      const { total, entries } = catalog.unpackListResult(res.payload);
      assert.equal(total, a.total, c.name);
      assert.deepEqual(entries, a.entries.map((/** @type {any} */ e) => ({ fn: e.fn, instance: e.instance, revision: e.revision, flags: e.flags, name: e.name })), c.name);
      const { hst, sent } = answering(hx(c.answer_hex), a.corr);   // core.listEntries sends the vector's request
      assert.deepEqual((await core.listEntries(hst)).map((e) => e.name), a.entries.map((/** @type {any} */ e) => e.name), c.name);
      assert.equal(hex(sent[0]), c.request_hex, c.name);
      continue;
    }
    assert.equal(res.payload[0], a.more, c.name);
    const tlvs = m.splitTlvs(res.payload.slice(1));
    if (!('unit_id' in a)) {
      assert.deepEqual(tlvs, [], c.name);                        // past the end: more 0 and no TLVs (core §7.3)
      continue;
    }
    const { hst, sent } = answering(hx(c.answer_hex), a.corr);   // core.describe sends the vector's request
    const info = await core.probeInfo(hst);
    assert.equal(hex(sent[0]), c.request_hex, c.name);
    assert.equal(info.unitId, a.unit_id, c.name);
    assert.deepEqual(info.transports, a.transports.map((/** @type {any} */ t) => ({ index: t.index, kind: t.kind, usbInterface: t.interface })), c.name);
    assert.equal(info.maxOpMs, a.max_op_ms, c.name);
    assert.equal(await core.maxOpMs(hst), a.max_op_ms, c.name);
  }
});

test('discovery: the header refusals as the host reads them (core §4.3 order 1)', async () => {
  for (const c of DISCOVERY.refusals) {
    const q = c.request;
    const reason = /** @type {Record<string, number>} */ (m.REJECT)[c.answer];
    assert.equal(hex(new m.Request(q.corr, q.fn, q.op).pack()), c.request_hex, c.name);
    const res = m.Result.unpack(hx(c.answer_hex));
    assert.deepEqual([res.resolution, res.detail, res.payload.length], [m.REJECTED, reason, 0], c.name);
    const { hst } = answering(hx(c.answer_hex), q.corr);
    await assert.rejects(hst.request(q.fn, q.op, new Uint8Array(), { locked: false }), (e) => e instanceof Rejected && e.reason === reason, c.name);
  }
});

// ---- refusals and an ignored unknown TLV (core §4.3, §2.3) ---------------------------------------------------------

const REFUSALS = load('refusals.json');

test('refusals: the requests parse, and the answers read as the host reads them', () => {
  for (const c of REFUSALS.cases) {
    const req = m.Request.unpack(hx(c.request_hex));
    assert.equal(hex(req.pack()), c.request_hex, c.name);
    assert.ok(req.fn === 0 || Object.hasOwn(c.fns, String(req.fn)), c.name);
    if (req.session !== m.NO_SESSION_ID) assert.equal(req.session, 0x11223344, c.name);   // the vectors' lock holder
    const res = m.Result.unpack(hx(c.answer_hex));
    if (c.answer === 'completed success') {
      assert.ok(res.succeeded && res.payload.length === 0, c.name);   // gpio set answers no fixed part (fixture §1); the
      continue;                                                   // unknown TLV is ignored without a trace
    }
    assert.ok(c.answer === 'malformed' || c.answer === 'unsupported', `a new kind of answer in refusals.json: ${c.answer}`);
    assert.equal(res.resolution, m.REJECTED, c.name);
    assert.equal(m.REJECT_NAMES[res.detail], c.answer, c.name);
    const err = rejection(res);
    if (c.answer === 'unsupported') {
      assert.ok(err instanceof Unsupported, c.name);
      assert.equal(err.tag === null, res.payload[0] === 0x00, c.name);
    }
  }
});

test('refusals: the gpio set this client builds is the vector\'s request', async () => {
  // "gpio mode 8": set n=1, channel 3, mode 8 - the bytes fixture.js's Gpio.setBody gives
  const { Gpio } = await import('../src/fixture.js');
  const c = REFUSALS.cases.find((/** @type {any} */ e) => e.name.startsWith('gpio mode 8'));
  const req = m.Request.unpack(hx(c.request_hex));
  assert.equal(hex(Gpio.setBody([[3, 8]])), hex(req.payload));
});

// ---- session scenarios (sessions.json: core §5.2, §6, §9) -------------------------------------------------------------

const SESSIONS = load('sessions.json');

/** A host whose next request has `corr` and whose open draws `sid`; every request is answered with `answer`.
 * @param {Uint8Array} answer @param {number} corr @param {number | null} session @param {number} [sid] */
function scripted(answer, corr, session, sid = 0) {
  /** @type {Uint8Array[]} */
  const sent = [];
  const link = /** @type {any} */ ({ framing: 'length', maxFrame: 1024, async send(/** @type {Uint8Array} */ b) { sent.push(b); return answer; } });
  const hst = new Host(link);
  hst.corr = corr - 1;
  hst.revision = 1;
  hst.session = session;
  hst.newSession = () => sid;
  return { hst, sent };
}

test('sessions: each answer as the host reads it, and the requests it sends for open, keepalive, end, lock_state and clock', async () => {
  let clocks = 0;
  for (const sc of SESSIONS.scenarios) {
    for (const step of sc.steps) {
      const what = `${sc.name}: ${step.note}`;
      const req = m.Request.unpack(hx(step.request_hex));
      const res = m.Result.unpack(hx(step.answer_hex));
      assert.equal(res.corr, req.corr, what);
      const holder = req.op === m.OP.open ? null : req.op === m.OP.clock ? S : (req.session || null);   // clock: from a host in a session too
      const { hst, sent } = scripted(hx(step.answer_hex), req.corr, holder, req.session);
      /** @type {() => Promise<any>} */
      let call;
      if (req.op === m.OP.open) {
        const rd = new m.Reader(req.payload);
        const lease = rd.u32(), force = rd.u8();
        const owner = rd.tail().get(reg.CORE.tlv.open.owner);
        call = () => hst.open(lease, { force: !!force, owner: owner ? new TextDecoder().decode(owner) : undefined });
      } else if (req.op === m.OP.lock_state) {
        call = () => hst.lockState();
      } else if (req.op === m.OP.clock) {
        if (req.session !== m.NO_SESSION_ID) continue;                // Host.clock always goes with session_id 0
        call = () => hst.clock();
      } else {
        call = /** @type {Record<number, () => Promise<any>>} */ ({ [m.OP.keepalive]: () => hst.keepalive(), [m.OP.end]: () => hst.end() })[req.op];
      }
      if (res.resolution === m.REJECTED) {
        await assert.rejects(call(), (e) => e instanceof Rejected && e.result.detail === res.detail
          && e.constructor === rejection(res).constructor, what);
        if (res.detail === m.REJECT.locked) {
          const err = /** @type {Locked} */ (rejection(res));
          assert.equal(err.remainingMs, getU32(res.payload), what);
        }
        if (req.session === m.NO_SESSION_ID && req.op === m.OP.open) continue;   // a request the host never makes
      } else {
        const got = await call();
        if (req.op === m.OP.open) assert.deepEqual([got.leaseMs, got.bootId], [getU32(res.payload), getU32(res.payload, 4)], what);
        if (req.op === m.OP.lock_state) assert.deepEqual([got.locked, got.remainingMs], [res.payload[0] !== 0, getU32(res.payload, 1)], what);
        if (req.op === m.OP.clock) {
          assert.deepEqual([got.bootId, got.uptimeNs], [getU32(res.payload), new DataView(res.payload.buffer, res.payload.byteOffset + 4, 8).getBigUint64(0, true)], what);
          assert.equal(hst.session, S, what);                        // sent with session_id 0, the session untouched (core §4.1)
          clocks++;
        }
        if (req.op === m.OP.open) assert.equal(hst.session, req.session, what);
        if (req.op === m.OP.end) assert.equal(hst.session, null, what);
      }
      assert.equal(hex(sent[0]), step.request_hex, what);
    }
  }
  assert.ok(clocks >= 3, `${clocks} clock steps read`);
});

// ---- per-op vectors (ops.json): the client's request and its reading of the answer ------------------------------------

const OPS = load('ops.json').cases;
const S = 0x11223344;   // ops.json about: the lock holder's id

/** A host whose next request is the case's: its corr, its session, the case's fn numbers known (revision 1, no
 * describe TLVs), and the case's answer to whatever it sends. @param {any} c @param {number | null} [session] */
function client(c, session = null) {
  const r = m.Request.unpack(hx(c.request_hex));
  const { hst, sent } = scripted(hx(c.answer_hex), r.corr, session);
  hst.limits = { revision: 1, flags: 0, maxFrame: 1024, window: 4096, maxInflight: 4, bootId: 0, transport: 0, tail: new m.Tail() };
  for (const [k, name] of Object.entries(c.fns)) {
    hst.fns.set(/** @type {string} */ (name), Number(k)); hst.revisions.set(Number(k), 1); hst.describes.set(Number(k), []);
  }
  hst.describes.set(0, []);
  return { hst, sent };
}

/** @param {unknown} e */
const unknownOperation = (e) => e instanceof Rejected && e.constructor === Rejected && e.result.detail === m.REJECT.unknown_operation;

/** The client's own request for the case and its reading of the answer; null where this client has no API for that
 * request as it stands. @param {any} c @returns {Promise<Uint8Array[] | null>} */
async function onClient(c) {
  const { Gpio, GpioUnavailable } = await import('../src/fixture.js');
  const rv = await import('../src/riscv.js');
  const { Console } = await import('../src/console.js');
  const { ProbeConfig } = await import('../src/config.js');
  const { LogicCapture } = await import('../src/capture.js');
  const { NoConnection } = await import('../src/errors.js');
  const name = /** @type {string} */ (c.name);
  const a = m.Result.unpack(hx(c.answer_hex));
  const r = m.Request.unpack(hx(c.request_hex));
  if (isMultirate(c)) return multirateOnClient(c);
  if (name.startsWith('restart')) {                                 // oep.probe.restart (oep-if-restart), found by name
    const { hst, sent } = client(c, name.includes('without a session') ? null : S);
    if (a.resolution === m.COMPLETED) {
      await hst.requestRestart();
      assert.equal(hst.session, null);
      assert.equal(hst.fns.size, 0);                                    // nothing of the old boot lasts (core §6.6)
    } else {
      await assert.rejects(hst.requestRestart(), (e) => e instanceof Rejected && e.result.detail === a.detail);
    }
    return sent;
  }
  if (name.startsWith('plan_')) {                                    // oep.probe.plan (oep-if-plan), found by name
    if (name.includes('n = 2 with one fn')) return null;            // the client never sends a short list
    const { hst, sent } = client(c, name.includes('without a session') ? null : S);
    const call = r.op === core.PLAN_APPLY
      ? core.planApply(hst, m.splitTlvs(r.payload).map(([, v]) => /** @type {[number, number, number]} */ ([v[0] | (v[1] << 8), v[2], v[3] | (v[4] << 8)])))
      : core.planRelease(hst, Array.from({ length: r.payload[0] }, (_, i) => r.payload[1 + 2 * i] | (r.payload[2 + 2 * i] << 8)));
    if (a.resolution === m.COMPLETED) await call;
    else await assert.rejects(call, (e) => e instanceof Rejected && e.result.detail === a.detail);
    return sent;
  }
  if (name.includes('subscribe')) {                                 // the emitting fn's own ops 0x30 / 0x32 (core §11.3)
    const { hst, sent } = client(c, name.includes('without a session') ? null : S);
    if (name.startsWith('gpio')) {
      await assert.rejects(hst.subscribe(r.fn), unknownOperation);  // gpio sends no notifications
      return sent;
    }
    const lc = new LogicCapture(hst, r.fn, LogicCapture.NAME);
    if (name.includes('without a session')) {
      await assert.rejects(lc.subscribe(), (e) => e instanceof Rejected && e.result.detail === m.REJECT.session_required);
    } else if (r.op === m.OP_SUBSCRIBE) {
      await lc.subscribe(1024, 20);
      assert.ok(hst.subscriptions.has(r.fn));
    } else await lc.unsubscribe();
    return sent;
  }
  if (name.startsWith('link source')) {
    const { hst, sent } = client(c);
    const n = getU32(r.payload);
    const data = core.linkSourceData((await hst.call(1, core.LINK_SOURCE, core.linkSourceRequest(n), { locked: false })).payload);
    assert.deepEqual([...data], Array.from({ length: Math.min(n, core.linkSize(1024)) }, (_, k) => k & 0xff));   // max_frame - 7 (§2)
    return sent;
  }
  if (name.startsWith('link sink') || name.startsWith('link port_speed')) {
    if (name.includes('port_speed')) {
      const { hst, sent } = client(c, S);
      const { speedRequest } = await import('../src/speed.js');   // baud step verify_ms (oep-if-link §3)
      await assert.rejects(hst.call(1, core.LINK_PORT_SPEED, speedRequest(921600, 0, 2000)), unknownOperation);   // WireSkein's check
      return sent;
    }
    const { hst, sent } = client(c);
    const count = r.payload[0] | (r.payload[1] << 8);
    if (count > r.payload.length - 2) return null;                  // a count the client never sends
    await hst.call(1, core.LINK_SINK, core.linkSinkRequest(r.payload.slice(2, 2 + count)), { locked: false });
    return sent;
  }
  if (name.startsWith('gpio')) {
    if (name.includes('n = 2 with one element')) return null;       // the client never sends a short list
    const { hst, sent } = client(c, name.includes('without a session') ? null : S);
    const g = new Gpio(hst, 2, Gpio.NAME);
    if (name.startsWith('gpio read')) assert.deepEqual(await g.read([3]), [1]);
    else if (name.includes('channel 9')) {
      await assert.rejects(g.set([[3, Gpio.OUTPUT_HIGH], [9, Gpio.INPUT]]), (e) => e instanceof GpioUnavailable && JSON.stringify(e.channels) === '[9]');
    } else if (name.includes('without a session')) {
      await assert.rejects(g.set([[3, Gpio.OUTPUT_HIGH]]), (e) => e instanceof Rejected && e.result.detail === m.REJECT.session_required);
    } else await g.set([[3, Gpio.OUTPUT_HIGH]]);
    return sent;
  }
  if (name.startsWith('rvswd connections')) {
    if (name.includes('first beyond')) return null;                 // the client pages from 0 on
    const { hst, sent } = client(c);
    const info = await new rv.Wire(hst, Number(Object.keys(c.fns).find((k) => c.fns[k] === 'oep.wire.rvswd')), 'oep.wire.rvswd').connections();
    if (a.payload[1]) {
      assert.equal(info.length, 1);
      const [x] = info;
      assert.deepEqual([x.conn, x.pins, x.speedHz, x.users, x.slot, x.targetId?.[0], hex(x.targetId?.[1] ?? new Uint8Array())],
        [1, [1, 2], 1_000_000, 1, 0xff, 1, '00352000']);
    } else assert.deepEqual(info, []);
    return sent;
  }
  if (name.startsWith('rvswd scan')) {
    if (name.includes('count 0') || name.includes('skip')) return null;   // skip: the client's own loop sends it
    const { hst, sent } = client(c, S);
    const found = await new rv.Wire(hst, Number(Object.keys(c.fns).find((k) => c.fns[k] === 'oep.wire.rvswd')), 'oep.wire.rvswd').scan([[1, 2]]);
    assert.deepEqual(found, [{ kind: 1, pins: [1, 2], dmstatus: 0x00400382 }]);
    return sent;
  }
  if (name.startsWith('riscv-dm')) {
    if (name.includes('unknown step kind')) return null;
    const { hst, sent } = client(c, S);
    const dm = new rv.RiscvDm(hst, r.fn, rv.RiscvDm.NAME, r.payload.slice(0, 2));
    if (name.includes('halt') && name.includes('unknown connection')) await assert.rejects(dm.halt(), NoConnection);
    else if (name.includes('halt')) await dm.halt();
    else if (name.includes('run not offered')) await assert.rejects(dm.run(0x20000000, [], { timeoutMs: 100, outs: [] }), unknownOperation);
    else if (name.includes('preparation fails')) {                  // stopped 3: not run, still halted (debug §4.4)
      await assert.rejects(dm.run(0x20000000, [[0x100A, 7]], { timeoutMs: 100, outs: [] }), (e) => {
        const run = rv.RiscvDm.runResult(/** @type {any} */ (e).result);
        return e instanceof rv.TargetError && run.notRun && !run.notHalted && e.status === reg.STATUS.line;
      });
    }
    else if (name.includes('n = 0')) assert.deepEqual(await dm.dmi([]), { done: 0, values: [] });
    else if (name.includes('step on a running hart')) {            // debug §4.2: moved and the dpcs are not read
      await assert.rejects(dm.step(), (e) => e instanceof rv.StepError && e.status === reg.STATUS.state && e.before === null
        && e.after === null && !e.stepLeft);
      return sent.slice(-1);
    }
    else assert.deepEqual(await dm.dmi([rv.RiscvDm.stepRead(0x11)]), { done: 1, values: [0x00400382] });
    return sent;
  }
  if (name.startsWith('arm-adi transfer')) {
    const { ArmAdi } = await import('../src/arm.js');
    const { hst, sent } = client(c, S);
    const adi = new ArmAdi(hst, r.fn, ArmAdi.NAME, r.payload.slice(0, 2));
    assert.deepEqual(await adi.transfer(new Uint8Array()), []);         // n = 0: success, done 0 (debug §6)
    assert.equal(adi.lastAck, 0);
    return sent;
  }
  if (name.startsWith('spi-target read_rx')) {
    const { SpiTarget, wireBits } = await import('../src/fixture.js');
    const { hst, sent } = client(c, S);
    const got = await new SpiTarget(hst, r.fn, SpiTarget.NAME).readRx();
    assert.deepEqual([got.pending, got.bits, got.ns], [0, 12, null]);
    assert.deepEqual(wireBits(got.data, got.bits, name.includes('LSB first') ? 1 : 0), [1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1]);
    return sent;
  }
  if (name.startsWith('console')) {
    if (name.includes('from 4')) return null;                       // the client never sends from 4
    const { hst, sent } = client(c);
    const con = new Console(hst, r.fn, Console.NAME);
    con.stream = 2;
    if (name.startsWith('console marks') && c.state.includes('marks 5 to 8 kept')) {   // common §1.3
      const from = getU32(r.payload, 2);
      const { marks, more } = await con.marksPage(from);
      const want = /** @type {Record<number, [number[], boolean]>} */ ({ 3: [[5, 6], true], 5: [[5, 6], true], 7: [[7, 8], false], 9: [[], false] })[from];
      assert.deepEqual([marks.map((k) => k.serial), more], want);
      for (const k of marks) assert.deepEqual([Number(k.position), Number(k.timeNs), k.detail], [10 * k.serial, 1_000_000 * k.serial, k.serial]);
    } else if (name.startsWith('console streams') && name.includes('beyond the count')) {
      const rd = new m.Reader((await hst.call(r.fn, Console.STREAMS, Uint8Array.of(1, 0), { locked: false })).payload);
      assert.deepEqual([rd.u8(), rd.u8()], [0, 0]);                     // first(u16) past the count: the last page
    } else if (name.startsWith('console marks')) {
      const { marks, more } = await con.marksPage(0);
      assert.equal(more, false);
      assert.deepEqual(marks.map((k) => [k.serial, Number(k.position), k.kind, Number(k.timeNs), k.detail]), [[0, 0, 3, 1_000_000, 0]]);
    } else if (name.startsWith('console streams')) {
      assert.deepEqual(await con.streams(), [{ stream: 2, connection: 1, mechanism: 2, users: 1, state: 0, open: true }]);
    } else {
      const got = await con.read(Console.FROM_POSITION, 5, 64);
      assert.deepEqual([Number(got.start), got.more, got.gap, got.data.length], [5, false, false, 0]);
    }
    return sent;
  }
  if (name.startsWith('probe.config') && c.state.startsWith('items has wifi')) return wifiOnClient(c, a);
  if (name.startsWith('probe.config')) {
    if (name.includes('set')) return null;                          // the client's Idle never sends these forms
    const { hst, sent } = client(c, name.includes('save') ? S : null);
    const p = new ProbeConfig(hst, 8, ProbeConfig.NAME);
    if (name.includes('save')) {
      await assert.rejects(p.save(), unknownOperation);
      return sent;
    }
    const st = await p.state();
    assert.deepEqual([st.storage, st.savedHash, st.unreadable], ['none', 0, null]);
    assert.equal(st.slots.length, 1);
    const [slot] = st.slots;
    assert.deepEqual([slot.slot, slot.state, slot.connection, Number(slot.lastTryAtNs)], [0, 'connected', 1, 1_000_000]);
    assert.deepEqual(st.binds, [{ port: 0, flow: 'streaming' }]);
    return sent;
  }
  if (name.startsWith('logic segments')) {
    const { hst, sent } = client(c);
    const { segments, more } = await new LogicCapture(hst, 9, LogicCapture.NAME).segmentsPage(getU32(r.payload));
    assert.equal(more, false);
    if (name.includes('from_serial = serial_done')) assert.deepEqual(segments, []);   // common §1.3 paging 2
    else if (name.includes('dropped segment')) {                      // capture §2.2: serial 2 is not handed out
      assert.deepEqual(segments.map((s) => [s.serial, Number(s.position), s.samples, Number(s.startNs)]), [[0, 0, 8000, 5_000_000], [1, 1000, 8000, 13_000_000]]);
    }
    else assert.deepEqual(segments.map((s) => [s.serial, Number(s.position), Number(s.samples), Number(s.startNs), s.generation]), [[0, 0, 1000, 5_000_000, 1]]);
    return sent;
  }
  if (name.startsWith('logic status') && name.includes('streaming')) {
    const { hst, sent } = client(c);
    const st = await new LogicCapture(hst, 9, LogicCapture.NAME).status();
    assert.deepEqual([st.state, st.segmentsDone, Number(st.writePos), st.dropped, st.errorName], [6, 2, 32, true, 'storage']);
    return sent;
  }
  if (name.startsWith('logic status')) {                             // capture §2.2: state 6, error 2, flags bit0
    const { hst, sent } = client(c);
    const st = await new LogicCapture(hst, 9, LogicCapture.NAME).status();
    assert.deepEqual([st.state, st.segmentsDone, Number(st.writePos), st.dropped, st.generation, st.errorName], [6, 2, 2000, true, 1, 'storage']);
    return sent;
  }
  if (name.startsWith('logic configure without rate')) return null;
  if (name.startsWith('logic query: an immediate trigger')) {        // type 0 goes as role 0 value 0 (§3.3)
    const { hst, sent } = client(c);
    await new LogicCapture(hst, 9, LogicCapture.NAME).configure({ rate: 20_000_000, samples: 200_000, trigger: [0, 5, 9], query: true });
    const trig = m.splitTlvs(m.Request.unpack(sent[0]).payload).find(([t]) => t === 0x45);
    assert.deepEqual([...(trig?.[1] ?? [])], [0, 0, 0, 0, 0, 0]);
    return null;                                                      // the vector's role 5 is the probe's side
  }
  if (name.startsWith('logic query: samples 0')) {
    const { hst, sent } = client(c);
    await assert.rejects(new LogicCapture(hst, 9, LogicCapture.NAME).configure({ rate: 20_000_000, samples: 0, query: true }), /1 or more/);
    assert.equal(sent.length, 0);
    return null;                                                      // refused before sending
  }
  if (name.startsWith('capture-group bind: a track cannot keep')) {
    const { AnalogCapture, CaptureGroup } = await import('../src/capture.js');
    const { hst, sent } = client(c, S);
    const logic = new LogicCapture(hst, 9, LogicCapture.NAME);
    await assert.rejects(new CaptureGroup(hst, 12, CaptureGroup.NAME).bind([logic, new AnalogCapture(hst, 13, AnalogCapture.NAME)], logic),
      (e) => e instanceof Unavailable && e.cause === 'limit' && e.fn === 13);   // cause 2, TLV fn (§4.1)
    return sent;
  }   // the client always sends mode and rate
  if (name.startsWith('logic configure') || name.startsWith('logic query')) {
    const cap = await import('../src/capture.js');
    const { hst, sent } = client(c, c.state.includes('session S') ? S : null);
    const lc = new LogicCapture(hst, 9, LogicCapture.NAME);
    if (name.includes('streaming with samples')) {
      await assert.rejects(lc.configure({ rate: 1_000_000, mode: cap.STREAMING, samples: 1000, query: true }), /streaming takes no samples/);
      assert.equal(sent.length, 0);
      return null;                                                    // refused before sending
    }
    const got = await lc.configure({ rate: 20_000_000, samples: 200_000 });
    assert.deepEqual([got.rate, got.width, got.positions, got.samples, got.segments, got.blockingMs], [20_000_000, 2, [0, 1], 200_000, 1, 0]);
    return [uncritical(sent[0])];
  }
  if (name.startsWith('capture-group start')) {
    const { AnalogCapture, CaptureGroup } = await import('../src/capture.js');
    const { hst, sent } = client(c, S);
    const logic = new LogicCapture(hst, 9, LogicCapture.NAME), analog = new AnalogCapture(hst, 13, AnalogCapture.NAME);
    const grp = new CaptureGroup(hst, 12, CaptureGroup.NAME);
    const { blockingMs, startNs } = await grp.start([logic, analog]);
    assert.deepEqual([blockingMs, Number(startNs), grp.generation, [...grp.generations], logic.generation, analog.generation],
      [0, 7_000_000, 5, [[9, 4], [13, 2]], 4, 2]);
    return sent;
  }
  return null;
}

/** A request with bit 7 of its TLV tags cleared: this client sends mode and rate critical (its own choice, capture §3.3),
 * the vectors send them plain - the same request otherwise; multirate (0xE0) stays critical (§5.2).
 * @param {Uint8Array} frame @param {number} [fixed]  the bytes of the fixed part before the TLVs */
function uncritical(frame, fixed = 0) {
  const q = m.Request.unpack(frame);
  const body = concat(q.payload.slice(0, fixed), ...m.splitTlvs(q.payload.slice(fixed)).map(([t, v]) => m.tlv(t & 0x7f, v, t === 0xe0)));
  return new m.Request(q.corr, q.fn, q.op, body, q.session).pack();
}

/** The multirate vectors' logic fn (capture §5, the describe vector): one-shot and repeat, rate_range 1 kHz-100 MHz exact,
 * 4 channels, triggers with max_pretrigger 1000000, multirate policies 7, d 2-128 powers of 2 only. */
const MULTIRATE_LOGIC = /** @type {[number, Uint8Array][]} */ ([
  [0x40, new Writer().u8(1).u32(1_000_000).u32(1).done()], [0x40, new Writer().u8(2).u32(1_000_000).u32(8).done()],
  [0x41, new Writer().u32(1000).u32(100_000_000).u8(1).done()], [0x44, Uint8Array.of(4)],
  [0x45, new Writer().u32(7).u32(1_000_000).done()], [0x60, new Writer().u32(7).u32(2).u32(128).u8(1).done()]]);

/** @param {any} c */
const isMultirate = (c) => c.state.includes('multirate policies 7') || c.state.includes('configured multirate')
  || c.name.startsWith('logic configure multirate on a fn');

/** The multirate vectors (capture §5) as this client sends and reads them, as oep-client-python's: what describe
 * declares, configure / query with Multirate roles (checked against describe first: the malformed and undeclared forms
 * are refused before sending), the block layout, a multirate segment record, a bind of a multirate track.
 * @param {any} c @returns {Promise<Uint8Array[] | null>} */
async function multirateOnClient(c) {
  const cap = await import('../src/capture.js');
  const mr = await import('../src/multirate.js');
  const name = /** @type {string} */ (c.name);
  const { hst, sent } = client(c, c.state.includes('session S') ? S : null);
  const fn = m.Request.unpack(hx(c.request_hex)).fn;
  if (name.startsWith('logic describe')) {
    hst.describes.delete(9);
    assert.deepEqual(await new cap.LogicCapture(hst, 9, cap.LogicCapture.NAME).multirateDeclared(), new mr.Declared(7, 2, 128, true));
    return sent;
  }
  if (!name.includes('does not declare')) hst.describes.set(fn, MULTIRATE_LOGIC);
  const lc = new cap.LogicCapture(hst, fn, cap.LogicCapture.NAME);
  const { ANY_ACTIVE: A, SAMPLE: S_, EDGE_LATCH: E, Multirate: M } = mr;
  const example = [new M(0, A, 32, 0), new M(3, S_, 4, 1)];
  /** @type {[string, import('../src/multirate.js').Multirate[]][]} */
  const forms = [['d 0', [new M(0, A, 0, 0)]], ['phase = d', [new M(3, S_, 4, 4)]], ['param 2', [new M(0, A, 32, 2)]],
    ['d 1, malformed', [new M(0, E, 1, 1)]], ['same role twice', [new M(3, S_, 4, 1), new M(3, S_, 8, 0)]],
    ['reserved policy', [new M(0, 3, 4, 0)]], ['d 3 where', [new M(3, S_, 3, 0)]], ['d 256', [new M(3, S_, 256, 0)]],
    ['does not declare', example]];
  for (const [key, specs] of forms) {
    if (!name.includes(key)) continue;
    await assert.rejects(lc.configure({ rate: 100_000_000, samples: 96, multirate: specs }), (e) => e instanceof RangeError && /multirate/.test(e.message));
    assert.equal(sent.length, 0);
    return null;                                                      // refused before sending
  }
  if (name.includes('not in the plan')) {
    await assert.rejects(lc.configure({ rate: 100_000_000, samples: 96, multirate: [new M(4, S_, 4, 0)] }), Unavailable);
    return [uncritical(sent[0])];
  }
  if (name.startsWith('logic segments multirate')) {
    const { segments, more } = await lc.segmentsPage(0);
    assert.deepEqual([more, segments.map((x) => [x.samples, x.triggerIndex, x.flags, x.generation])], [false, [[72, 13, 2, 1]]]);
    return sent;
  }
  if (name.startsWith('capture-group bind')) {
    const logic = new cap.LogicCapture(hst, 9, cap.LogicCapture.NAME);
    await new cap.CaptureGroup(hst, 12, cap.CaptureGroup.NAME).bind([logic, new cap.AnalogCapture(hst, 13, cap.AnalogCapture.NAME)], logic);
    return [uncritical(sent[0], 5)];                                  // trigger_track: critical here, plain there
  }
  if (name.includes('heavy')) {
    const got = await lc.configure({ rate: 100_000_000, samples: 96, query: true, multirate: [0, 1, 2, 3].map((k) => new M(k, E, 2, 1)) });
    assert.deepEqual([got.rate, got.width, got.positions, got.block, got.samples], [40_000_000, 1, [], 32, 96]);
    return [uncritical(sent[0])];
  }
  const got = await lc.configure({ rate: 100_000_000, samples: name.includes('72') ? 72 : 96, query: name.includes('query'), multirate: example });
  assert.deepEqual([got.rate, got.width, got.positions, got.block, got.samples, got.blockingMs], [100_000_000, 2, [0, 1], 32, 96, 0]);
  assert.deepEqual([got.multirateLayout()?.blockBytes(), got.bytes], [10, 30]);   // B 10 (§5.7), 96 base samples
  return [uncritical(sent[0])];
}

/** The wifi vectors (probe.config §1.4, §3.3: every case whose state starts "items has wifi") as this client sends and
 * reads them; null for the form it never builds (a 7-byte passphrase: RangeError before sending, the passphrase not in
 * the message). 0xFF for a missing entry and an index past wifi_max are the probe's to refuse: sent as asked.
 * @param {any} c @param {m.Result} a @returns {Promise<Uint8Array[] | null>} */
async function wifiOnClient(c, a) {
  const name = /** @type {string} */ (c.name);
  const { hst, sent } = client(c, c.state.includes('session S') ? S : null);
  const p = new config.ProbeConfig(hst, 8, config.ProbeConfig.NAME);
  const refused = (/** @type {number} */ detail) => (/** @type {unknown} */ e) => e instanceof Rejected && e.result.detail === detail;
  if (name.startsWith('probe.config set: wifi entry 0')) {
    assert.equal(await p.set([new config.Wifi({ index: 0, ssid: 'lab', passphrase: 'password1' })]), 0x5A5A0001);
  } else if (name.includes('the longest wifi item')) {
    // 32-byte ssid and 64 hex digits: a 112-byte request (wifi_min_max_frame), sent at a max_frame of 112
    /** @type {any} */ (hst.limits).maxFrame = reg.LIMITS.wifi_min_max_frame;
    const w = new config.Wifi({ index: 0, ssid: 's'.repeat(config.SSID_MAX), passphrase: '0123456789abcdef'.repeat(4) });
    assert.equal(await p.set([w]), 0x5A5A0003);
    assert.equal(sent[0].length, config.WIFI_MIN_MAX_FRAME);
  } else if (name.startsWith('probe.config get')) {
    const { hash, items } = await p.get();
    const [w] = items.map(([t, v]) => config.decode(t, v));
    assert.ok(w instanceof config.Wifi);
    assert.deepEqual([hash, items.length, w.index, w.ssid, w.passphrase], [0x5A5A0001, 1, 0, 'lab', config.KEEP]);
    assert.deepEqual(w.shown(), { index: 0, ssid: 'lab', passphrase: 'set' });
  } else if (name.includes('sent back')) {
    assert.equal(await p.set([new config.Wifi({ index: 0, ssid: 'lab', passphrase: config.KEEP })]), 0x5A5A0001);
  } else if (name.includes('no entry')) {
    assert.equal(a.detail, m.REJECT.malformed);
    await assert.rejects(p.set([new config.Wifi({ index: 1, ssid: 'field', passphrase: config.KEEP })]), refused(m.REJECT.malformed));
  } else if (name.includes('7-byte')) {
    assert.throws(() => new config.Wifi({ index: 1, ssid: 'field', passphrase: 'secret7' }).value(),
      (e) => e instanceof RangeError && !e.message.includes('secret7'));
    assert.equal(a.detail, m.REJECT.malformed);                            // what the probe answers the bytes (its side)
    return null;
  } else if (name.includes('at wifi_max')) {
    await assert.rejects(p.set([new config.Wifi({ index: 4, ssid: 'field' })]), refused(m.REJECT.unsupported));
  } else if (name.startsWith('probe.config state')) {
    const st = await p.state();
    assert.deepEqual([st.slots, st.binds], [[], []]);
    assert.deepEqual(st.wifi, new config.WifiState('connected', 0, 'none', -52, '192.168.1.23'));
  } else if (name.startsWith('probe.config unset')) {
    assert.equal(await p.unset([['wifi', 0]]), 0x5A5A0002);
  } else {
    assert.fail(`a wifi vector this test does not know: ${name}`);
  }
  return sent;
}

test('ops: the wifi vectors (probe.config §1.4, §3.3) are all known here', () => {
  const wifi = OPS.filter((/** @type {any} */ c) => c.name.startsWith('probe.config') && c.state.startsWith('items has wifi'));
  assert.equal(wifi.length, 9);
});

test('ops: a wifi set past the probe\'s max_frame is refused before sending (probe.config §1.4)', async () => {
  const c = OPS.find((/** @type {any} */ x) => x.name.includes('the longest wifi item'));
  const { hst, sent } = client(c, S);
  /** @type {any} */ (hst.limits).maxFrame = reg.MIN_MAX_FRAME;
  const w = new config.Wifi({ index: 0, ssid: 's'.repeat(config.SSID_MAX), passphrase: '0123456789abcdef'.repeat(4) });
  await assert.rejects(new config.ProbeConfig(hst, 8, config.ProbeConfig.NAME).set([w]),
    (e) => e instanceof RangeError && e.message.includes('max_frame 64') && e.message.includes('112') && !e.message.includes('0123'));
  assert.equal(sent.length, 0);
});

test('ops: where this client has the op, its request is the case\'s and its reading gives the case\'s values', async () => {
  let checked = 0;
  for (const prefix of ['restart', 'plan_apply', 'plan_release', 'logic subscribe', 'logic unsubscribe', 'gpio subscribe']) {
    assert.ok(OPS.some((/** @type {any} */ c) => c.name.startsWith(prefix)), `ops.json has ${prefix} cases`);
  }
  for (const c of OPS) {
    const sent = await onClient(c);
    if (sent === null) continue;
    assert.equal(hex(sent[0]), c.request_hex, c.name);
    checked++;
  }
  assert.ok(checked >= 20, `${checked} cases checked`);
});

// ---- the ops encoding (ops_encoding.json, core §7.4) ------------------------------------------------------------------

const OPS_ENCODING = load('ops_encoding.json').cases;

test('ops encoding: checkOps takes the valid values and refuses the others; a valid value decodes to its set', () => {
  assert.deepEqual(new Set(OPS_ENCODING.map((/** @type {any} */ c) => c.valid)), new Set([true, false]));
  for (const c of OPS_ENCODING) {
    const v = hx(c.value_hex);
    assert.equal(catalog.checkOps(v) === '', c.valid, `${c.name}: ${catalog.checkOps(v)}`);
    if (!c.valid) continue;
    assert.deepEqual([...catalog.unpackOps(v)].sort((x, y) => x - y), c.ops, c.name);
    // one set may have several values; packOps gives one that decodes to the same set
    assert.deepEqual([...catalog.unpackOps(catalog.packOps(c.ops))].sort((x, y) => x - y), c.ops, c.name);
  }
  assert.throws(() => catalog.packOps([]), RangeError);                                // an empty set has none
});

test('ops encoding: every ops in the discovery vectors keeps core §7.4\'s form', () => {
  let seen = 0;
  for (const c of DISCOVERY.exchanges) {
    const p = m.Result.unpack(hx(c.answer_hex)).payload;
    if (!('unit_id' in c.answer)) continue;
    for (const [tag, v] of m.splitTlvs(p.slice(1))) if ((tag & 0x7f) === m.TAG_OPS) { assert.equal(catalog.checkOps(v), '', c.name); seen++; }
  }
  assert.ok(seen >= 1);
});

/** A Host whose describe of fn 0 and fn 5 is `fn0` / `fn5` (paged as one answer), nothing else answered.
 * @param {Uint8Array} fn0Ops @param {Uint8Array} fn5Ops */
function describing(fn0Ops, fn5Ops) {
  /** @type {m.Request[]} */ const sent = [];
  const link = /** @type {any} */ ({ framing: 'length', maxFrame: 1024, async send(/** @type {Uint8Array} */ b) {
    const q = m.Request.unpack(b);
    sent.push(q);
    const fn = q.payload[0] | (q.payload[1] << 8);
    const body = q.op === m.OP.describe ? Uint8Array.from([0, ...m.tlv(m.TAG_OPS, fn === 0 ? fn0Ops : fn5Ops)]) : new Uint8Array();
    return new m.Result(q.corr, m.COMPLETED, m.SUCCESS, body).pack();
  } });
  const hst = new Host(link);
  hst.revision = 1;
  return { hst, sent };
}

test('ops encoding: an fn whose ops is invalid is not used (FnNotUsable), the rest is; fn 0\'s: the probe is not (NotUsable)', async () => {
  const good = catalog.packOps(Object.values(m.OP));
  for (const c of OPS_ENCODING.filter((/** @type {any} */ e) => !e.valid)) {
    let { hst, sent } = describing(good, hx(c.value_hex));
    await assert.rejects(core.ops(hst, 5), (e) => e instanceof FnNotUsable && e.fn === 5 && /core §7\.4/.test(e.message), c.name);
    const n = sent.length;
    await assert.rejects(hst.request(5, 0x01), FnNotUsable, c.name);                  // nothing more goes to fn 5
    await assert.rejects(hst.pipeline([[5, 0x01, new Uint8Array()]]), FnNotUsable, c.name);
    assert.equal(sent.length, n, c.name);
    await hst.request(0, m.OP.lock_state, new Uint8Array(), { locked: false });     // the probe is still used
    hst.lost();                                                                     // a restart: the fn is asked again
    await assert.rejects(core.ops(hst, 5), FnNotUsable, c.name);
    ({ hst, sent } = describing(hx(c.value_hex), good));
    await assert.rejects(core.describe(hst, 0), (e) => e instanceof NotUsable && /fn 0/.test(e.message), c.name);
    await assert.rejects(hst.request(0, m.OP.lock_state, new Uint8Array(), { locked: false }), NotUsable, c.name);
    assert.ok(!sent.some((q) => q.op === m.OP.lock_state), c.name);
  }
  const { hst } = describing(good, catalog.packOps([1, 2, 0x30, 0x32]));
  assert.deepEqual(await core.ops(hst, 5), new Set([1, 2, 0x30, 0x32]));
});

// ---- notification frames (ops.json events): capture events carry their generation (capture §3.4, §4.2) ---------------

const EVENTS = load('ops.json').events;

test('events: each read with its generation; one of an earlier generation is passed over', async () => {
  const cap = await import('../src/capture.js');
  assert.equal(EVENTS.length, 5);
  for (const c of EVENTS) {
    const frame = hx(c.event_hex);
    const fn = frame[1] | (frame[2] << 8);
    const group = c.fns[String(fn)] === 'oep.fixture.capture-group';
    const e = (group ? cap.parseGroupEvent : cap.parseCaptureEvent)(frame);
    assert.equal(e.generation, c.generation, c.name);
    // the current generation: the logic's start answered 4, the group is at 5
    const events = [frame];
    const link = { events, nextEvent: (/** @type {(f: Uint8Array) => boolean} */ match) => {
      const at = events.findIndex(match);
      return Promise.resolve(at >= 0 ? events.splice(at, 1)[0] : null);
    } };
    const hst = /** @type {any} */ ({ link });
    const track = group ? new cap.CaptureGroup(hst, fn, cap.CaptureGroup.NAME) : new cap.LogicCapture(hst, fn, cap.LogicCapture.NAME);
    track.generation = group ? 5 : c.name.includes('dropped') ? 1 : 4;
    const current = await track.nextEvent(null, 0);
    if (c.name.includes('dropped inside a segment')) {                // capture §2.2: reason 3, error 2
      assert.deepEqual([e.kind, e.reason, e.error, current?.generation], [cap.EVENT_STOPPED, cap.STOPPED_REASON.error, 2, 1], c.name);
    } else if (c.name.includes('previous generation')) {
      assert.deepEqual([e.kind, e.reason, current, track.staleEvents], [cap.EVENT_STOPPED, cap.STOPPED_REASON.host, null, 1], c.name);
    } else if (group && e.kind === cap.GROUP_EVENT_TRIGGERED) {
      assert.deepEqual([e.triggerFn, Number(e.triggerNs), current?.generation], [9, 7_050_000, 5], c.name);
    } else if (e.kind === cap.EVENT_TRIGGERED) {
      assert.deepEqual([e.serial, e.triggerIndex, Number(e.triggerNs), current?.generation], [0, 1000, 7_050_000, 4], c.name);
    } else {
      assert.deepEqual([e.kind, e.reason, e.error, current?.generation], [cap.GROUP_EVENT_STOPPED, cap.STOPPED_REASON.complete, 0, 5], c.name);
    }
  }
});

// ---- multirate streams (multirate.json, capture §5.5) ------------------------------------------------------------------

test('multirate.json: each segment decodes to its levels and values, and encodes back byte for byte', async () => {
  const mr = await import('../src/multirate.js');
  const cases = load('multirate.json').cases;
  assert.equal(cases.length, 14);
  for (const v of cases) {
    const specs = v.roles.flatMap((/** @type {any} */ r, /** @type {number} */ k) => (r ? [new mr.Multirate(k, mr.POLICY[r.policy], r.d, r.param)] : []));
    const d1Roles = v.roles.flatMap((/** @type {any} */ r, /** @type {number} */ k) => (!r || (r.policy === 'sample' && r.d === 1) ? [k] : []));
    const lay = new mr.Layout(v.layout.w, v.layout.pos, v.L, specs);
    for (const seg of v.segments) {
      const stream = hx(seg.stream_hex), n = seg.samples, ch = seg.channels;
      assert.equal(lay.segmentBytes(n), stream.length, v.name);
      const got = lay.decode(stream, n);
      assert.deepEqual(got.d1.map((x) => x.join('')), d1Roles.map((/** @type {number} */ r) => ch[r]), v.name);
      for (const s of specs.filter((/** @type {any} */ x) => x.reduced)) assert.deepEqual(got.reduced.get(s.role), s.values(ch[s.role]), v.name);
      assert.equal(hex(lay.encode((role, i) => Number(ch[role][i]), n, d1Roles)), seg.stream_hex, v.name);
    }
  }
});

test('data frames: what the host keeps after an error stop (capture §2.2)', async () => {
  const cap = await import('../src/capture.js');
  const data = load('ops.json').data;
  assert.ok(data.length);
  for (const v of data) {
    const p = cap.unpackPush(hx(v.frame_hex));
    assert.equal(p.generation, v.generation, v.name);
    const got = new cap.Received();
    got.start = p.position;
    got.append(p.data);
    got.dropFrom(32n);                                                // the status vector's write_pos
    assert.deepEqual([got.length, got.droppedAfterError], [v.keep, p.data.length - v.keep], v.name);
  }
});
