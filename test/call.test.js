// @ts-check
// src/call.js and the describe's op_name / op_field (oep-core §7.4): decoding the tags, packing a request and reading an
// answer by the fields, call() by name and by number (lock_free, a refusal, a failed answer with code and message, the
// NotOffered errors), callWait on a job and its status op - as oep-client-python's tests/test_call.py. The probe is a
// stand-in host whose describe, list and revisions are in its caches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as c from '../src/call.js';
import * as catalog from '../src/catalog.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { Rejected } from '../src/errors.js';
import { Writer } from '../src/bytes.js';

const T = reg.CORE.enum.op_field_type, P = reg.CORE.enum.op_field_part, F = reg.CORE.enum.op_name_flag;
const NAME = reg.DESCRIBE_COMMON.op_name, FIELD = reg.DESCRIBE_COMMON.op_field;
const te = new TextEncoder();

/** @param {number} op @param {number} flags @param {string} name @returns {[number, Uint8Array]} */
const opName = (op, flags, name) => [NAME, Uint8Array.of(op, flags, ...te.encode(name))];
/** @param {number} op @param {number} part @param {number} type @param {string} name @returns {[number, Uint8Array]} */
const opField = (op, part, type, name) => [FIELD, Uint8Array.of(op, part, type, ...te.encode(name))];

/** @type {[number, Uint8Array][]} */
const DESCRIBE = [
  [m.TAG_OPS, catalog.packOps([0x10, 0x20, 0x30])],
  opName(0x10, F.form, 'add'),
  opField(0x10, P.request, T.i32, 'a'), opField(0x10, P.request, T.i32, 'b'),
  opField(0x10, P.success, T.i32, 'sum'),
  opField(0x10, P.failed, T.i32, 'code'), opField(0x10, P.failed, T.text, 'message'),
  opName(0x20, F.form | F.lock_free, 'read'),
  opField(0x20, P.success, T.i32 | T.list, 'temps'),
  opName(0x30, 0, 'raw'),                                  // a name, no form
  opField(0x30, P.request, T.u8, 'ignored'),               // fields of an op without form: not taken
];

test('the describe gives names and fields', () => {
  const d = catalog.decodeDescription(DESCRIBE);
  assert.deepEqual([...d.opForms.keys()].sort(), [0x10, 0x20, 0x30]);
  const add = /** @type {catalog.OpForm} */ (d.opForms.get(0x10)), read = /** @type {catalog.OpForm} */ (d.opForms.get(0x20));
  const raw = /** @type {catalog.OpForm} */ (d.opForms.get(0x30));
  assert.ok(add.form && !add.lockFree);
  assert.deepEqual(add.request.map((f) => f.name), ['a', 'b']);
  assert.equal(add.signature(), 'add(a: i32, b: i32) -> sum: i32');
  assert.deepEqual(add.failed.map((f) => f.name), ['code', 'message']);
  assert.ok(read.lockFree);
  assert.equal(read.signature(), 'read() -> temps: i32[]');
  assert.ok(!raw.form);
  assert.deepEqual(raw.request, []);
  assert.equal(raw.signature(), 'raw');
});

test('fields round trip (every type, a list), and the wrong names are a TypeError', () => {
  const fields = /** @type {[string, keyof typeof T][]} */ ([['a', 'u8'], ['b', 'u16'], ['c', 'u32'], ['d', 'u64'], ['e', 'i8'], ['f', 'i16'],
    ['g', 'i32'], ['h', 'i64'], ['i', 'bool'], ['j', 'bytes'], ['k', 'text']]).map(([n, t]) => new catalog.OpField(n, T[t]));
  fields.push(new catalog.OpField('l', T.u32 | T.list));
  const values = { a: 0xab, b: 0x1234, c: 0x89abcdef, d: 2n ** 63n, e: -1, f: -2, g: -3, h: -(2n ** 63n), i: true,
    j: Uint8Array.of(1, 2), k: 'hi', l: [10, 20] };
  const packed = c.encode(fields, values);
  assert.deepEqual([...packed.slice(0, 3)], [0xab, 0x34, 0x12]);
  const [got, rest] = c.decode(fields, Uint8Array.of(...packed, 0x40, 0, 0));
  assert.deepEqual(got, values);
  assert.deepEqual([...rest], [0x40, 0, 0]);
  assert.throws(() => c.encode(fields, { a: 1 }), TypeError);
  assert.throws(() => c.encode(fields, { ...values, z: 1 }), TypeError);
});

/** A host whose list, describe and revisions are cached, answering requests from a table; records what it was sent.
 * @param {[number, Uint8Array][]} describe @param {number} fn @param {string} name
 * @param {Record<number, (p: Uint8Array) => m.Result>} answers */
function fakeHost(describe, fn, name, answers) {
  const hst = {
    fns: new Map([[name, fn]]), revisions: new Map([[fn, 1]]), describes: new Map([[fn, describe]]),
    /** @type {[number, number, Uint8Array, boolean][]} */ sent: [],
    boot: 0x1234n,
    /** @param {number} f @param {number} op @param {Uint8Array} payload @param {{ locked?: boolean }} [opts] */
    async request(f, op, payload = new Uint8Array(), { locked = true } = {}) {
      if (f === m.CORE_FN && op === m.OP.list) return new m.Result(1, m.COMPLETED, m.SUCCESS, Uint8Array.of(0, 0, 0));   // lists nothing more
      hst.sent.push([f, op, payload, locked]);
      const r = answers[op](payload);
      if (r.resolution === m.REJECTED) throw new Rejected(r);
      return r;
    },
    async clock() { return { bootId: hst.boot }; },
  };
  return hst;
}

function probe() {
  return fakeHost(DESCRIBE, 5, 'io.github.you.mine', {
    0x10: (p) => {
      const dv = new DataView(p.buffer, p.byteOffset);
      const a = dv.getInt32(0, true), b = dv.getInt32(4, true);
      if (a < 0) return new m.Result(1, m.COMPLETED, m.FAILED, new Writer().i32(7).u16(5).raw(te.encode('no 44')).done());
      return new m.Result(1, m.COMPLETED, m.SUCCESS, new Writer().i32(a + b).done());
    },
    0x20: () => new m.Result(1, m.COMPLETED, m.SUCCESS, new Writer().u16(2).i32(21).i32(22).done()),
    0x30: () => new m.Result(1, m.REJECTED, reg.REJECT_REASONS.unsupported, Uint8Array.of(0)),
  });
}

test('call by name and by number; lock_free goes outside the session', async () => {
  const p = probe(), hst = /** @type {any} */ (p);
  let r = await c.call(hst, 'io.github.you.mine', 'add', { fields: { a: 2, b: 3 } });
  assert.equal(r.fields.sum, 5);
  assert.equal(r.revision, 1);
  assert.deepEqual(p.sent[p.sent.length - 1], [5, 0x10, new Writer().i32(2).i32(3).done(), true]);
  r = await c.call(hst, 'io.github.you.mine', 0x10, { payload: new Writer().i32(4).i32(5).done() });
  assert.equal(r.fields.sum, 9);
  r = await c.call(hst, 'io.github.you.mine', 'read');
  assert.deepEqual(r.fields.temps, [21, 22]);
  assert.equal(p.sent[p.sent.length - 1][3], false);
});

test('a failed answer with code and message; a refusal; fields to an op without form', async () => {
  const hst = /** @type {any} */ (probe());
  await assert.rejects(c.call(hst, 'io.github.you.mine', 'add', { fields: { a: -1, b: 0 } }),
    (e) => e instanceof c.CommandFailed && e.code === 7 && e.detailMessage === 'no 44' && e.op === 'add');
  await assert.rejects(c.call(hst, 'io.github.you.mine', 'raw', { payload: Uint8Array.of(1) }),
    (e) => e instanceof c.CommandRejected && e.reason === reg.REJECT_REASONS.unsupported);
  await assert.rejects(c.call(hst, 'io.github.you.mine', 'raw', { fields: { x: 1 } }), TypeError);
});

test('not offered: another interface, another revision, no such op', async () => {
  const hst = /** @type {any} */ (probe());
  await assert.rejects(c.call(hst, 'io.github.you.other', 'add', { fields: { a: 1, b: 2 } }), c.InterfaceMissing);
  await assert.rejects(c.call(hst, 'io.github.you.mine', 'add', { fields: { a: 1, b: 2 }, revision: 2 }), c.RevisionMismatch);
  await assert.rejects(c.call(hst, 'io.github.you.mine', 'nope'), c.OpMissing);
  await assert.rejects(c.call(hst, 'io.github.you.mine', 0x40), c.OpMissing);
  assert.ok(new c.InterfaceMissing('x') instanceof c.NotOffered && new c.OpMissing('x') instanceof c.NotOffered);
});

// ---- callWait: a job and its status op ---------------------------------------------------------------------------------

const S = c.JOB_STATES;
const JOB = 0x10, STATUS = 0x40, CANCEL = 0x41;
/** @type {[number, Uint8Array][]} */
const JOB_DESCRIBE = [
  [m.TAG_OPS, catalog.packOps([JOB, STATUS, CANCEL])],
  opName(JOB, F.form, 'collect'), opField(JOB, P.request, T.u8, 'count'),
  opName(STATUS, F.form | F.lock_free, 'status'),
  .../** @type {[string, keyof typeof T][]} */ ([['state', 'u8'], ['op', 'u8'], ['code', 'i32'], ['message', 'text'], ['start_ns', 'u64'], ['end_ns', 'u64']])
    .map(([n, t]) => opField(STATUS, P.success, T[t], n)),
  opName(CANCEL, F.form, 'cancel'),
];

/** A worker: the job runs for `polls` status reads, then ends as `ends` says. @param {{ polls?: number, ends?: string, restartAfter?: number | null }} o */
function jobProbe({ polls = 2, ends = 'done', restartAfter = null } = {}) {
  const w = { state: /** @type {number} */ (S.idle), op: 0, reads: 0 };
  const ok = (/** @type {Uint8Array} */ p = new Uint8Array()) => new m.Result(1, m.COMPLETED, m.SUCCESS, p);
  const cancel = () => { if (w.state === S.running && ends !== 'never') w.state = S.cancelled; return ok(); };
  const p = fakeHost(JOB_DESCRIBE, 6, 'io.github.you.jobs', {
    [JOB]: () => { w.state = S.running; w.op = JOB; w.reads = 0; return ok(); },
    [CANCEL]: cancel,
    [STATUS]: () => {
      w.reads++;
      if (restartAfter !== null && w.reads > restartAfter) { p.boot = 0x9999n; w.state = S.idle; w.op = 0; }
      else if (w.state === S.running && ends !== 'never' && w.reads > polls) w.state = /** @type {any} */ (S)[ends];
      const [code, msg] = w.state === S.failed ? [5, 'bus stuck'] : [0, ''];
      return ok(new Writer().u8(w.state).u8(w.op).i32(code).u16(msg.length).raw(te.encode(msg)).u64(100n).u64(200n).done());
    },
  });
  return { p, cancel };
}

test('callWait: done after the status reads; the status lock-free', async () => {
  const { p } = jobProbe({ polls: 2 });
  /** @type {number[]} */
  const waited = [];
  const st = await c.callWait(/** @type {any} */ (p), 'io.github.you.jobs', 'collect', { fields: { count: 3 }, timeoutMs: 5000, wait: async (ms) => { waited.push(ms); } });
  assert.equal(st.state, S.done);
  assert.deepEqual([st.start_ns, st.end_ns], [100n, 200n]);
  assert.deepEqual(p.sent[0], [6, JOB, Uint8Array.of(3), true]);
  assert.ok(p.sent.slice(1).every((s) => s[1] === STATUS && s[3] === false));
  assert.equal(waited.length, 2);
});

test('callWait: failed, timeout (cancel sent), cancelled, restarted', async () => {
  const none = async () => {};
  await assert.rejects(c.callWait(/** @type {any} */ (jobProbe({ ends: 'failed' }).p), 'io.github.you.jobs', 'collect', { fields: { count: 1 }, timeoutMs: 5000, wait: none }),
    (e) => e instanceof c.JobFailed && e.code === 5 && e.detailMessage === 'bus stuck' && e.op === 'collect');
  const never = jobProbe({ ends: 'never' }).p;
  await assert.rejects(c.callWait(/** @type {any} */ (never), 'io.github.you.jobs', 'collect', { fields: { count: 1 }, timeoutMs: 0, wait: none }), c.JobTimeout);
  assert.equal(never.sent[never.sent.length - 1][1], CANCEL);
  const j = jobProbe({ polls: 99 });
  await assert.rejects(c.callWait(/** @type {any} */ (j.p), 'io.github.you.jobs', 'collect', { fields: { count: 1 }, timeoutMs: 5000, wait: async () => { j.cancel(); } }), c.JobCancelled);
  await assert.rejects(c.callWait(/** @type {any} */ (jobProbe({ polls: 99, restartAfter: 1 }).p), 'io.github.you.jobs', 'collect', { fields: { count: 1 }, timeoutMs: 5000, wait: none }), c.ProbeRestarted);
});

test('dump names the ops by op_name and shows the signatures', async () => {
  const { describeOffer } = await import('../src/dump.js');
  const row = describeOffer(/** @type {any} */ ({ entry: { fn: 5, instance: 0, name: 'io.github.you.mine', revision: 1 }, description: catalog.decodeDescription(DESCRIBE) }));
  assert.deepEqual(row.ops, ['add', 'read', 'raw']);
  assert.deepEqual(row.opForms, ['add(a: i32, b: i32) -> sum: i32', 'read() -> temps: i32[]']);
});
