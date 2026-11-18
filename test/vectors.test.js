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
import * as settings from '../src/settings.js';
import * as m from '../src/message.js';
import { fromHex, hex } from '../src/bytes.js';
import { FnNotUsable, Locked, NotUsable, Rejected, Unavailable, Unsupported, rejection } from '../src/errors.js';
import * as reg from '../src/registry.js';
import { Writer, concat, getU16, getU32 } from '../src/bytes.js';
import { Host } from '../src/host.js';
import { WIRES, Wire } from '../src/wire.js';
import { HidReportReader, HidReportWriter } from '../src/browser/webhid.js';

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

// ---- HID reports (transports §1) -----------------------------------------------------------------------------------------

const HID = load('hid_reports.json');

/** @param {Uint8Array} message */
const lengthFrame = (message) => Uint8Array.from([message.length & 0xff, message.length >> 8, ...message]);

test('HID reports: the frames packed as count, first and the stream\'s bytes', () => {
  assert.equal(HID.hid_no_frame_start, reg.USB.hid_no_frame_start);
  for (const c of HID.pack) {
    const stream = concat(...c.messages_hex.map((/** @type {string} */ h) => lengthFrame(hx(h))));
    assert.deepEqual(new HidReportWriter(HID.room).pack(stream).map(hex), c.reports_hex, c.name);
  }
});

test('HID reports: the messages a reader just opened reads (reports missing, broken, read from the middle)', () => {
  for (const c of HID.read) {
    const reader = new HidReportReader();
    /** @type {Uint8Array[]} */
    const frames = c.reports_hex.flatMap((/** @type {string} */ h) => reader.read(hx(h)));
    // a length 0 frame is no message (transports §1: read past)
    assert.deepEqual(frames.filter((f) => f.length > 2).map((f) => hex(f.subarray(2))), c.messages_hex, c.name);
  }
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
      assert.deepEqual({ revision: limits.revision, maxFrame: limits.maxFrame, window: limits.window,
        maxInflight: limits.maxInflight, bootId: limits.bootId, transport: limits.transport },
      { revision: a.revision, maxFrame: a.max_frame, window: a.window, maxInflight: a.max_inflight,
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
  hst.describes.set(m.CORE_FN, []);   // fn 0's describe read already (open reads it first, core §4.4): nothing declared
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
        if (req.payload.length || (req.op !== m.OP.keepalive && req.op !== m.OP.end)) continue;   // an altered copy: never sent by this host
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
/** DMSTATUS the debug vectors answer */
const DMSTATUS = 0x00400382;

/** A host whose next request is the case's: its corr, its session, the case's fn numbers known (revision 1, no
 * describe TLVs), and the case's answer to whatever it sends. @param {any} c @param {number | null} [session] */
function client(c, session = null) {
  const r = m.Request.unpack(hx(c.request_hex));
  const { hst, sent } = scripted(hx(c.answer_hex), r.corr, session);
  hst.limits = { revision: 1, maxFrame: c.name.includes('frame64') ? reg.MIN_MAX_FRAME : 1024, window: 4096, maxInflight: 4, bootId: 0,
    transport: 0, tail: new m.Tail() };   // what confirm said (a set's size check)
  for (const [k, name] of Object.entries(c.fns)) {
    const fn = Number(k), table = /** @type {any} */ (reg.INTERFACES)[/** @type {string} */ (name)];
    hst.fns.set(/** @type {string} */ (name), fn); hst.revisions.set(fn, 1);
    // every op of the interface, max_length 256 (as oep-client-python's scripted); the console's standard mechanisms
    /** @type {[number, Uint8Array][]} */
    const d = table ? [[m.TAG_OPS, catalog.packOps(Object.values(table.op))], [catalog.COMMON.max_length, new Writer().u16(256).done()]] : [];
    if (name === 'oep.target.console') {
      for (const n of ['sdi', 'dmdata', 'dmseq']) d.push([reg.TARGET_CONSOLE.tlv.describe.mechanism, new TextEncoder().encode(n)]);
    }
    hst.describes.set(fn, d);
  }
  hst.describes.set(0, [[reg.CORE.tlv.describe.max_op_ms, new Writer().u32(1000).done()],
    ...(r.fn === m.CORE_FN ? /** @type {[number, Uint8Array][]} */ ([[m.TAG_OPS, catalog.packOps(Object.values(reg.CORE.op))]]) : [])]);
  return { hst, sent };
}

/** The settings cases this client sends and reads (oep-client-python's SETTINGS_CLIENT). */
const SETTINGS_CLIENT = ['settings state: no saved', 'settings state: independent', 'settings get:', 'settings unset:',
  'settings set: longest label', 'settings set: changed contents', 'settings set: disable conflicts',
  'settings set: idle conflicts', 'settings set: ipv4 static'];

/** core §13.5, §13.7: the client's get / set / unset / state are the case's bytes, and it reads the answers - get's
 * count apart from the answer's own TLVs. @param {any} c @returns {Promise<Uint8Array[] | null>} */
async function settingsOnClient(c) {
  const name = /** @type {string} */ (c.name);
  if (!SETTINGS_CLIENT.some((p) => name.startsWith(p))) return null;
  const r = m.Request.unpack(hx(c.request_hex)), res = m.Result.unpack(hx(c.answer_hex));
  const { hst, sent } = client(c, S);
  const st = new settings.Settings(hst);
  if (name.startsWith('settings state')) {
    const state = await st.state();
    assert.deepEqual([state.storage, state.savedGeneration, state.reason], name.includes('no saved') ? ['none', 0, null] : ['partial', 0, 'item'], name);
  } else if (name.startsWith('settings get')) {
    const first = r.payload[0] | (r.payload[1] << 8);
    if (first) {
      const rd = new m.Reader((await st.call('get', r.payload, { locked: false })).payload);
      assert.deepEqual([rd.u8(), rd.u32(), rd.u8()], [0, 2, 0], name);
    } else {
      const { generation, values } = await st.get();
      assert.equal(generation, 2, name);
      assert.deepEqual(values.map((v) => [v.fn, v.key]), (name.includes('secret') ? [0, 0] : [4]).map((k) => [0, k]), name);
    }
  } else if (name.startsWith('settings unset')) {
    /** @type {settings.KeyRow[]} */
    const keys = [];
    for (let i = 0, at = 1; i < r.payload[0]; i++, at += 5) keys.push([getU16(r.payload, at), r.payload[at + 2], getU16(r.payload, at + 3)]);
    assert.equal(await st.unset(keys), 3, name);
  } else {
    /** @type {settings.SetRow[]} */
    const values = [];
    for (let i = 0, at = 1; i < r.payload[0]; i++) {
      const n = getU16(r.payload, at + 5);
      values.push([getU16(r.payload, at), r.payload[at + 2], getU16(r.payload, at + 3), r.payload.slice(at + 7, at + 7 + n)]);
      at += 7 + n;
    }
    if (res.resolution === m.REJECTED) await assert.rejects(st.set(values), Unavailable, name);
    else assert.equal(await st.set(values), getU32(res.payload), name);
  }
  return sent.slice(-1);
}

/** The client's own request for the case and its reading of the answer, as oep-client-python's
 * test_spec_vectors.py; null where this client has no API for that request (or the case is the probe's side).
 * @param {any} c @returns {Promise<Uint8Array[] | null>} */
async function onClient(c) {
  const name = /** @type {string} */ (c.name);
  const a = m.Result.unpack(hx(c.answer_hex));
  const r = m.Request.unpack(hx(c.request_hex));
  const known = Object.values(c.fns).every((n) => n in reg.INTERFACES);
  if (name.startsWith('plan_') && known && !name.includes('session_required') && !name.includes('n = 2')) {
    const { hst, sent } = client(c, r.session || null);
    const call = r.op === core.PLAN_APPLY
      ? core.planApply(hst, m.splitTlvs(r.payload).map(([, v]) => /** @type {[number, number, number]} */ ([v[0] | (v[1] << 8), v[2], v[3] | (v[4] << 8)])))
      : core.planRelease(hst, Array.from({ length: r.payload[0] }, (_, i) => r.payload[1 + 2 * i] | (r.payload[2 + 2 * i] << 8)));
    if (a.resolution === m.REJECTED) await assert.rejects(call, (e) => e instanceof Rejected && e.result.detail === a.detail, name);
    else await call;
    return sent.slice(0, 1);
  }
  if (name.startsWith('restart') && c.state !== '—') {
    const { hst, sent } = client(c, r.session || null);
    try {
      await hst.requestRestart();
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      assert.equal(e.result.detail, a.detail, name);
    }
    return sent.slice(0, 1);
  }
  if (['rvswd attach: a second', 'rvswd attach: a resource', 'rvswd attach: busy', 'swd attach'].some((p) => name.startsWith(p))) {
    const { hst, sent } = client(c, S);
    const wire = new Wire(hst, r.fn, name.startsWith('swd') ? WIRES.swd : WIRES.rvswd);
    const pins = /** @type {[number, number]} */ ([r.payload[1] | (r.payload[2] << 8), r.payload[3] | (r.payload[4] << 8)]);
    const targetsel = name.startsWith('swd') ? getU32(r.payload, 12) : null;   // fixed part 9, TLV header 3
    if (a.resolution === m.REJECTED) {
      await assert.rejects(wire.attach({ pins, maxSpeed: 1_000_000, targetsel }), (e) => e instanceof Unavailable && JSON.stringify(e.channels) === '[1]', name);
    } else {
      const got = await wire.attach({ pins, maxSpeed: 1_000_000, targetsel });
      assert.deepEqual([got.conn, got.id, got.flags, got.speedHz], [getU32(a.payload), DMSTATUS, 0, 1_000_000], name);
    }
    return sent.slice(-1);
  }
  if (name.startsWith('settings')) return settingsOnClient(c);
  return null;
}

// ---- the settings file (settings_file.json): export and import by names ------------------------------------------------

const FILE = load('settings_file.json');

/** A case's probe: fn 0's describe TLVs and each listed fn's. @param {any} probe */
const vectorCatalog = (probe) => new settings.Catalog(m.splitTlvs(hx(probe.fn0_describe_tlvs_hex)),
  probe.list.map((/** @type {any} */ e) => ({ fn: e.fn, name: e.name, instance: e.instance, tlvs: m.splitTlvs(hx(e.describe_tlvs_hex)) })));

/** get's values back to back (fn number key len data). @param {string} h */
function valuesOf(h) {
  const data = hx(h);
  let count = 0;
  for (let at = 0; at + 7 <= data.length; at += 7 + getU16(data, at + 5)) count++;
  return settings.splitValues(data, count)[0];
}

test('settings file: export writes every value with the probe\'s names (settings file §2, §3)', () => {
  for (const c of FILE.export) assert.deepEqual(settings.exportFile(vectorCatalog(c.probe), valuesOf(c.get_values_hex)), c.file, c.name);
});

test('settings file: import into a probe with other numbers (settings file §4)', () => {
  for (const c of FILE.import) {
    const plan = settings.planImport(vectorCatalog(c.probe), valuesOf(c.current_values_hex), c.file);
    assert.deepEqual(plan.sets.map(([fn, n, k, d]) => [fn, n, k, hex(d)]),
      c.expected_set.map((/** @type {any} */ r) => [r.fn, r.number, r.key, r.data_hex]), c.name);
    assert.deepEqual(plan.unsets, c.expected_unset.map((/** @type {any} */ r) => [r.fn, r.number, r.key]), c.name);
    assert.deepEqual(plan.secretWithoutValue, c.secret_without_value, c.name);
    assert.deepEqual(plan.unresolved, c.unresolved, c.name);
  }
});

test('ops: where this client has the op, its request is the case\'s and its reading gives the case\'s values', async () => {
  let checked = 0;
  for (const prefix of ['restart', 'plan_apply', 'plan_release', 'settings', 'rvswd attach']) {
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
