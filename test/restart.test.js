// @ts-check
// oep.probe.restart's restart (oep-spec interfaces/oep-if-restart, op 0x01; the interface is optional) against
// oep-client-python's fake: the op answers completed success with no payload and the probe restarts after it
// (no_session for the old session, a new boot_id in confirm); session_id 0 is refused session_required; a probe that
// lists no oep.probe.restart gets nothing sent; Host.restartProbe waits and confirms the new boot_id, on the link it has
// or on one opened again; restart_max_ms is the interface's describe 0x40.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as m from '../src/message.js';
import * as core from '../src/core.js';
import { NoSession, OepError, Rejected } from '../src/errors.js';
import { RESTART_AFTER_ANSWER_MS, RESTART_WAIT_MS } from '../src/host.js';
import { Link } from '../src/link.js';
import { openTcp, tcpTransport } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const skip = haveFake ? false : 'needs oep-client-python (the fake probe)';
const RESTART = reg.PROBE_RESTART.op.restart;
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {unknown} e */
const reason = (e) => (e instanceof Rejected ? e.result.detail : null);

test('the registry: restart is oep.probe.restart op 0x01, needs the lock, restart_after_answer_ms 100; fn 0 has none', () => {
  assert.equal(core.RESTART_NAME, 'oep.probe.restart');
  assert.equal(RESTART, 0x01);
  assert.equal(core.RESTART, 0x01);
  assert.ok(!/** @type {Set<number>} */ (reg.PROBE_RESTART.lock_free).has(RESTART));
  assert.equal(reg.PROBE_RESTART.tlv.describe.restart_max_ms, 0x40);
  assert.ok(!('restart' in m.OP) && !('restart_max_ms' in reg.CORE.tlv.describe));   // the core keeps only what is mandatory
  assert.equal(RESTART_AFTER_ANSWER_MS, 100);
});

test('restart: the answer, then no_session for the old session and a new boot_id', { skip }, async () => {
  const fake = await startFake(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: fake.port });
  try {
    const fn = await core.restartFn(hst);
    assert.notEqual(fn, m.CORE_FN);
    assert.ok(await core.offers(hst, fn, RESTART));
    const before = /** @type {number} */ (hst.bootId);
    await hst.open(3000);
    const sid = hst.session;
    const r = await hst.call(fn, RESTART);                             // completed success, no payload
    assert.equal(r.payload.length, 0);
    await sleep(RESTART_AFTER_ANSWER_MS);
    hst.session = sid;                                                 // the old session's id once more
    await assert.rejects(hst.keepalive(), (e) => e instanceof NoSession);
    const after = (await hst.confirm()).bootId;
    assert.notEqual(after, before);
    assert.equal((await hst.open(3000)).bootId, after);
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('restart without a session: session_required', { skip }, async () => {
  const fake = await startFake(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: fake.port });
  try {
    await assert.rejects(hst.requestRestart(), (e) => reason(e) === m.REJECT.session_required);
    await assert.rejects(hst.restartProbe({ waitMs: 1000 }), (e) => reason(e) === m.REJECT.session_required);
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('a probe without oep.probe.restart: nothing is sent', { skip }, async () => {
  const fake = await startFake(['--profile', 'p4-x035', '--no-restart']);
  const hst = await openTcp({ port: fake.port });
  try {
    assert.equal(await core.findOptional(hst, core.RESTART_NAME), null);
    await hst.open(3000);
    const send = hst.link.send.bind(hst.link);
    /** @type {Uint8Array[]} */ const sent = [];
    hst.link.send = (b, o) => { sent.push(b); return send(b, o); };
    await assert.rejects(hst.requestRestart(), (e) => e instanceof OepError && !(e instanceof Rejected) && /oep\.probe\.restart/.test(e.message));
    assert.ok(sent.every((b) => m.Request.unpack(b).fn === m.CORE_FN));   // only list asked
    await hst.keepalive();                                             // the session goes on
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('restartProbe on the link it has: the new boot_id, the session gone, one loss', { skip }, async () => {
  const fake = await startFake(['--profile', 'esp32-v003']);
  const hst = await openTcp({ port: fake.port });
  try {
    const before = /** @type {number} */ (hst.bootId);
    await hst.open(3000);
    const epoch = hst.epoch;
    const after = await hst.restartProbe({ waitMs: 3000 });
    assert.notEqual(after, before);
    assert.equal(hst.session, null);
    assert.equal(hst.epoch, epoch + 1);
    assert.equal((await hst.open(3000)).bootId, after);
    await hst.keepalive();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('restartProbe with reopen: the link closed, a new one opened and confirmed', { skip }, async () => {
  const fake = await startFake(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: fake.port });
  try {
    const before = /** @type {number} */ (hst.bootId);
    const first = hst.link;
    await hst.open(3000);
    const reopen = async () => {
      const link = new Link(await tcpTransport({ port: fake.port }), { timeoutMs: 3000 });
      await link.start();
      return link;
    };
    const after = await hst.restartProbe({ reopen, waitMs: 5000 });
    assert.notEqual(after, before);
    assert.notEqual(hst.link, first);
    assert.ok(first.closed);
    assert.equal((await hst.open(3000)).bootId, after);
    await hst.keepalive();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('restart_max_ms: oep.probe.restart\'s describe declares it (2000 on the fake); none without the interface', { skip }, async () => {
  let fake = await startFake(['--profile', 'p4-x035']);
  let hst = await openTcp({ port: fake.port });
  try {
    assert.equal(await core.restartMaxMs(hst), 2000);
    const tlvs = await core.describe(hst, await core.restartFn(hst));
    assert.ok(tlvs.some(([tag]) => (tag & 0x7f) === reg.PROBE_RESTART.tlv.describe.restart_max_ms));
    assert.ok(!(await core.describe(hst, 0)).some(([tag]) => (tag & 0x7f) === 0x4f));   // not fn 0's any more
    assert.ok(2000 >= reg.LIMITS.restart_after_answer_ms);
  } finally {
    await hst.link.close();
    fake.stop();
  }
  fake = await startFake(['--profile', 'p4-x035', '--no-restart']);
  hst = await openTcp({ port: fake.port });
  try {
    assert.equal(await core.restartMaxMs(hst), null);
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('restartProbe waits restart_max_ms by default, then the probe is gone', { skip }, async () => {
  const fake = await startFake(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(3000);
    const reopen = async () => { throw new Error('no device'); };   // the probe never comes back
    const start = performance.now();
    await assert.rejects(hst.restartProbe({ reopen }), /no device/);
    const took = performance.now() - start;
    assert.ok(took >= 2000 && took < 5000, `gave up after ${took} ms, not restart_max_ms 2000`);
  } finally {
    try { await hst.link.close(); } catch { /* closed by restartProbe */ }
    fake.stop();
  }
});

test('restartProbe without a declared restart_max_ms falls back to RESTART_WAIT_MS', { skip }, async () => {
  const fake = await startFake(['--profile', 'esp32-v003']);
  const hst = await openTcp({ port: fake.port });
  try {
    assert.equal(RESTART_WAIT_MS, 10000);
    const fn = await core.restartFn(hst);
    const tlvs = await core.describe(hst, fn);
    hst.describes.set(fn, tlvs.filter(([tag]) => (tag & 0x7f) !== reg.PROBE_RESTART.tlv.describe.restart_max_ms));   // as from a probe that lacks it
    assert.equal(await core.restartMaxMs(hst), null);
    const before = /** @type {number} */ (hst.bootId);
    await hst.open(3000);
    assert.notEqual(await hst.restartProbe(), before);                 // back well within the fallback
  } finally {
    await hst.link.close();
    fake.stop();
  }
});
