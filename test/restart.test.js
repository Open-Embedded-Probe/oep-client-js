// @ts-check
// oep.probe.restart's restart (oep-spec interfaces/oep-if-restart; the interface is optional) against
// oep-client-python's virtual bench: the op answers completed success with no payload and the probe restarts after it
// (no_session for the old session, a new boot_id in confirm); session_id 0 is refused session_required; a probe that
// lists no oep.probe.restart gets nothing sent; Host.restartProbe waits and confirms the new boot_id, on the link it has
// or on one opened again; restart_max_ms is the interface's describe restart_max_ms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as m from '../src/message.js';
import * as core from '../src/core.js';
import { NoSession, OepError, Rejected } from '../src/errors.js';
import { RESTART_AFTER_ANSWER_MS, RESTART_EXTERNAL_MS, RESTART_WAIT_MS } from '../src/host.js';
import { Link } from '../src/link.js';
import { openTcp, tcpTransport } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = haveVirtualBench ? false : 'needs oep-client-python (the virtual bench)';
const RESTART = reg.PROBE_RESTART.op.restart;
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {unknown} e */
const reason = (e) => (e instanceof Rejected ? e.result.detail : null);

test('the registry: restart is oep.probe.restart\'s, needs the lock; fn 0 has none', () => {
  assert.equal(core.RESTART_NAME, reg.PROBE_RESTART.name);
  assert.equal(core.RESTART, RESTART);
  assert.ok(!/** @type {Set<number>} */ (reg.PROBE_RESTART.lock_free).has(RESTART));
  assert.ok(!('restart' in m.OP) && !('restart_max_ms' in reg.CORE.tlv.describe));   // the core keeps only what is mandatory
  assert.ok(RESTART_AFTER_ANSWER_MS > 0);
});

test('restart: the answer, then no_session for the old session and a new boot_id', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: bench.port });
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
    bench.stop();
  }
});

test('restart without a session: session_required', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: bench.port });
  try {
    await assert.rejects(hst.requestRestart(), (e) => reason(e) === m.REJECT.session_required);
    await assert.rejects(hst.restartProbe({ waitMs: 1000 }), (e) => reason(e) === m.REJECT.session_required);
  } finally {
    await hst.link.close();
    bench.stop();
  }
});

test('a probe without oep.probe.restart: nothing is sent', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-x035', '--no-restart']);
  const hst = await openTcp({ port: bench.port });
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
    bench.stop();
  }
});

test('restartProbe on the link it has: the new boot_id, the session gone, one loss', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'esp32-v003']);
  const hst = await openTcp({ port: bench.port });
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
    bench.stop();
  }
});

test('restartProbe with reopen: the link closed, a new one opened and confirmed', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: bench.port });
  try {
    const before = /** @type {number} */ (hst.bootId);
    const first = hst.link;
    await hst.open(3000);
    const reopen = async () => {
      const link = new Link(await tcpTransport({ port: bench.port }), { timeoutMs: 3000 });
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
    bench.stop();
  }
});

test('restart_max_ms: oep.probe.restart\'s describe declares it (2000 on the virtual bench); none without the interface', { skip }, async () => {
  let bench = await startVirtualBench(['--profile', 'p4-x035']);
  let hst = await openTcp({ port: bench.port });
  try {
    assert.equal(await core.restartMaxMs(hst), 2000);
    const tlvs = await core.describe(hst, await core.restartFn(hst));
    assert.ok(tlvs.some(([tag]) => (tag & 0x7f) === reg.PROBE_RESTART.tlv.describe.restart_max_ms));
    assert.ok(!(await core.describe(hst, 0)).some(([tag]) => (tag & 0x7f) === 0x4f));   // not fn 0's any more
    assert.ok(2000 >= RESTART_AFTER_ANSWER_MS);                           // the host's short wait (host guide §5.2)
  } finally {
    await hst.link.close();
    bench.stop();
  }
  bench = await startVirtualBench(['--profile', 'p4-x035', '--no-restart']);
  hst = await openTcp({ port: bench.port });
  try {
    assert.equal(await core.restartMaxMs(hst), null);
  } finally {
    await hst.link.close();
    bench.stop();
  }
});

test('restartProbe waits restart_max_ms and the outside\'s time by default, then the probe is gone', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    const reopen = async () => { throw new Error('no device'); };   // the probe never comes back
    const window = /** @type {number} */ (await core.restartMaxMs(hst)) + RESTART_EXTERNAL_MS;
    const start = performance.now();
    await assert.rejects(hst.restartProbe({ reopen }), /no device/);
    const took = performance.now() - start;
    assert.ok(took >= window && took < window + 3000, `gave up after ${took} ms, not restart_max_ms + ${RESTART_EXTERNAL_MS}`);
  } finally {
    try { await hst.link.close(); } catch { /* closed by restartProbe */ }
    bench.stop();
  }
});

test('restartProbe takes a waitMs given as it is (host guide §5.2: the reopen\'s deadline is the host\'s)', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-x035']);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    const reopen = async () => { throw new Error('no device'); };
    const start = performance.now();
    await assert.rejects(hst.restartProbe({ reopen, waitMs: 3000 }), /no device/);
    const took = performance.now() - start;
    assert.ok(took >= 3000 && took < 6000, `gave up after ${took} ms, not the 3000 ms given`);
  } finally {
    try { await hst.link.close(); } catch { /* closed by restartProbe */ }
    bench.stop();
  }
});

test('restartProbe without a declared restart_max_ms falls back to RESTART_WAIT_MS', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'esp32-v003']);
  const hst = await openTcp({ port: bench.port });
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
    bench.stop();
  }
});
