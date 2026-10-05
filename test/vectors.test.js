// @ts-check
// oep-spec's test vectors (test/vectors/*.json, copied from oep-spec tests/vectors, never edited) against this client's
// own code: COBS and serial frames (cobs.js), headers and TLVs (message.js), the CRCs, confirm (the request this host
// sends, the answer as Host reads it), discovery (list, describe and the header refusals of the smallest probe: the
// requests as this host builds them, the answers as it reads them), probe.config's canonical form and hash (config.js), and the refusals as the host
// reads them. Where a vector and this code disagree, the spec's text decides (core §0 rule 4) and the vector is the
// one the spec corrects. Mirrors oep-client-python's tests/test_vectors.py (whose fake-side checks are the fake's).
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
import { Rejected, Unsupported, rejection } from '../src/errors.js';
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

// ---- COBS and serial frames (core §3.1) --------------------------------------------------------------------------

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

test('TLVs in the one encoding (short and long form)', () => {
  for (const c of HEADERS.tlvs) {
    const value = 'value_hex' in c ? hx(c.value_hex) : new Uint8Array(c.value_len).fill(c.value_byte);
    assert.equal(hex(m.tlv(c.tag, value)), c.tlv_hex, c.name);
    assert.deepEqual(m.splitTlvs(hx(c.tlv_hex)), [[c.tag, value]], c.name);
  }
});

// ---- CRCs ---------------------------------------------------------------------------------------------------------

const CHECKS = load('checks.json');

test('CRC check values (CRC-16 of core §3.1, CRC-32 of core §5.2 / probe.config §2)', () => {
  for (const c of CHECKS.cases.filter((/** @type {any} */ c) => c.algorithm !== 'crc8-dmseq')) {
    const data = hx(c.input_hex);
    const got = c.algorithm === 'crc16-ccitt-false' ? cobs.crc16(data) : config.crc32(data);
    assert.equal(got, c.crc, c.name);
  }
});

test('the dmseq CRC-8 and DATA0 words have no counterpart here', () => {
  // the probe's and the target's (target-console-dmseq): this client reads a console's bytes, it never decodes dmseq
  // words. Listed so a new algorithm in checks.json is not missed.
  assert.deepEqual(new Set(CHECKS.cases.map((/** @type {any} */ c) => c.algorithm)), new Set(['crc16-ccitt-false', 'crc32-ieee', 'crc8-dmseq']));
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
    if ('prefix' in q) {
      assert.equal(q.flags & ~catalog.LIST_EXACT, 0, c.name);
      req = new m.Request(q.corr, 0, m.OP.list, catalog.packListRequest(q.prefix, !!(q.flags & catalog.LIST_EXACT), q.first));
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

// ---- probe.config's canonical form and hash (probe-config §2) -------------------------------------------------------

test('probe.config: the canonical form and its hash', () => {
  for (const c of load('probe_config_hash.json').cases) {
    const items = c.items_sent.map((/** @type {any} */ it) => m.tlv(it.tag & 0x7f, hx(it.value_hex), (it.tag & 0x80) !== 0));
    const canon = config.canonical(items);
    assert.equal(hex(Uint8Array.from(canon.flatMap(([t, v]) => [...m.tlv(t, v)]))), c.canonical_hex, c.name);
    assert.deepEqual(canon.map(([t, v]) => [t, hex(v)]), c.canonical_order.map((/** @type {any} */ it) => [it.tag, it.value_hex]), c.name);
    assert.equal(config.canonicalHash(items), c.hash, c.name);
  }
});

// ---- refusals and the ignored list (core §4.3, §2.3) ----------------------------------------------------------------

const REFUSALS = load('refusals.json');

test('refusals: the requests parse, and the answers read as the host reads them', () => {
  for (const c of REFUSALS.cases) {
    const req = m.Request.unpack(hx(c.request_hex));
    assert.equal(hex(req.pack()), c.request_hex, c.name);
    assert.ok(req.fn === 0 || Object.hasOwn(c.fns, String(req.fn)), c.name);
    if (req.session !== null) assert.equal(req.session, 0x11223344, c.name);   // the vectors' lock holder
    const res = m.Result.unpack(hx(c.answer_hex));
    if (c.answer === 'completed success') {
      assert.ok(res.succeeded, c.name);
      const tail = m.Tail.parse(res.payload);                    // gpio set answers no fixed part (fixture §1)
      assert.ok(tail.ignored.length && !tail.moreIgnored, c.name);
      continue;
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
