// @ts-check
// The host side of oep-spec's 2026-10-06 structure (2e5dc4c, 0bce222, c475dad and the clock op that follows them),
// without the fake: fn 0's clock read against this host's clock (Host.clock), fn 0 sends no notifications (an fn 0
// event is only kept), a completed restart on oep.probe.restart's fn takes a raised link back to the boot speed (and
// one on another fn does not), plan / restart found by name on a ScriptedHost, dump's core block and an invalid ops.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as cobs from '../src/cobs.js';
import * as m from '../src/message.js';
import * as core from '../src/core.js';
import * as dump from '../src/dump.js';
import { Writer } from '../src/bytes.js';
import { decodeDescription, packOps } from '../src/catalog.js';
import { OepError } from '../src/errors.js';
import { Host } from '../src/host.js';
import { Link } from '../src/link.js';
import { ScriptedHost, ok } from './scripted.js';

/** A Host on a link that answers each request with `answer(request)` (a payload: completed success).
 * @param {(q: m.Request) => Uint8Array} answer */
function answering(answer) {
  /** @type {m.Request[]} */ const sent = [];
  const link = /** @type {any} */ ({ framing: 'length', maxFrame: 1024, async send(/** @type {Uint8Array} */ b) {
    const q = m.Request.unpack(b);
    sent.push(q);
    return new m.Result(q.corr, m.COMPLETED, m.SUCCESS, answer(q)).pack();
  } });
  const hst = new Host(link);
  hst.revision = 1;
  return { hst, sent };
}

test('clock: fn 0 op clock, empty, session_id 0 even in a session; boot_id(u32) uptime_ns(u64) against this host\'s time', async () => {
  let boot = 0x11223344;
  const { hst, sent } = answering(() => new Writer().u32(boot).u64(1_500_000_000n).done());
  hst.session = 0xabcd;                                        // a session is open: clock still goes without it
  const t = await hst.clock();
  assert.deepEqual([sent[0].fn, sent[0].op, sent[0].session, sent[0].payload.length], [0, m.OP.clock, 0, 0]);
  assert.equal(m.OP.clock, 0x04);
  assert.ok(/** @type {Set<number>} */ (reg.CORE.lock_free).has(m.OP.clock));   // lock-free (core §12)
  assert.deepEqual([t.uptimeNs, t.bootId], [1_500_000_000n, 0x11223344]);
  assert.ok(t.hostBeforeMs <= t.hostAfterMs && t.roundTripMs === t.hostAfterMs - t.hostBeforeMs);
  assert.deepEqual([hst.bootId, hst.session, hst.epoch], [0x11223344, 0xabcd, 0]);   // touches no session
  hst.fns.set('oep.fixture.gpio', 4);
  boot = 0x55667788;                                          // the probe restarted: clock's boot_id says so (core §6.5)
  await hst.clock();
  assert.deepEqual([hst.bootId, hst.fns.size, hst.epoch], [0x55667788, 0, 1]);
});

test('fn 0 sends no notifications: an fn 0 event is kept like any event, nothing more', async () => {
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  const transport = /** @type {any} */ ({ framing: 'cobs', kind: 'serial', async write() {}, start(/** @type {any} */ f) { deliver = f; }, async close() {} });
  const link = new Link(transport, { timeoutMs: 80 });
  await link.start();
  deliver(cobs.frame(new Writer().u8(m.ROLE_EVENT).u16(0).u16(0).u8(0x01).u32(0x22).u64(5n).done()));   // what a heartbeat was
  assert.equal(link.events.length, 1);
  assert.ok(!('heartbeats' in link.stats) && !('onHeartbeat' in link));
  assert.deepEqual(reg.CORE.event, {});
  assert.ok(!('heartbeat_default_ms' in reg.TIMING));
  await link.close();
});

/** A serial link raised to 1500000 whose scripted probe answers completed success to everything. */
async function raisedLink() {
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    framing: 'cobs', kind: 'serial', baudRate: 115200,
    async setBaudRate(rate) { transport.baudRate = rate; },
    async write(data) {
      const req = m.Request.unpack(cobs.unframe(data.subarray(1, data.length - 1)));
      setTimeout(() => deliver(cobs.frame(new m.Result(req.corr, m.COMPLETED, m.SUCCESS, new Uint8Array()).pack())), 1);
    },
    start(onData) { deliver = onData; },
    async close() {},
  };
  const link = new Link(transport, { timeoutMs: 200 });
  await link.start();
  await link.setBaud(1500000);
  return link;
}

test('a completed restart on oep.probe.restart\'s fn takes a raised link back to the boot speed; op 0x01 elsewhere does not', async () => {
  let link = await raisedLink();
  link.restartFn = 11;
  await link.send(new m.Request(1, 12, reg.PROBE_RESTART.op.restart, new Uint8Array(), 7).pack());   // op 0x01 of another fn
  assert.equal(link.baud, 1500000);
  await link.send(new m.Request(2, 11, reg.PROBE_RESTART.op.restart, new Uint8Array(), 7).pack());
  assert.equal(link.baud, 115200);                             // oep-if-link §3 host obligation 6
  await link.close();
  link = await raisedLink();                                   // a link that was never told the restart fn: only end
  await link.send(new m.Request(1, 11, reg.PROBE_RESTART.op.restart, new Uint8Array(), 7).pack());
  assert.equal(link.baud, 1500000);
  await link.send(new m.Request(2, 0, m.OP.end, new Uint8Array(), 7).pack());
  assert.equal(link.baud, 115200);
  await link.close();
});

test('plan_apply / plan_release / restart go to the fn list gives their interface; none listed: OepError, nothing sent', async () => {
  const handlers = new Map([['10:1', () => ok()], ['10:2', () => ok()], ['11:1', () => ok()]]);
  const hst = new ScriptedHost(handlers);
  hst.fns.set(core.PLAN_NAME, 10);
  hst.fns.set(core.RESTART_NAME, 11);
  hst.session = 7;
  await core.planApply(hst, [[3, 1, 20]]);
  await core.planRelease(hst, [3]);
  await hst.requestRestart();
  assert.deepEqual(hst.log.map(([fn, op]) => [fn, op]), [[10, 1], [10, 2], [11, 1]]);
  const [, , apply] = hst.log[0];
  assert.deepEqual([...apply], [0x90, 5, 0, 3, 0, 1, 20, 0]);  // role_assignment, sent critical (oep-if-plan §2.1)
  assert.deepEqual([...hst.log[1][2]], [1, 3, 0]);
  const none = new ScriptedHost(new Map([['0:2', () => ok([0, 0, 0])]]));   // list: total 0, count 0
  none.session = 7;
  await assert.rejects(core.planApply(none, [[3, 1, 20]]), (e) => e instanceof OepError && /oep\.probe\.plan/.test(e.message));
  await assert.rejects(none.requestRestart(), (e) => e instanceof OepError && /oep\.probe\.restart/.test(e.message));
  assert.ok(none.log.every(([fn, op]) => fn === 0 && op === m.OP.list));
  assert.equal(await core.planRoles(none), null);
  assert.equal(await core.restartMaxMs(none), null);
});

test('dump: fn 0\'s row is the core with fn 0\'s op names; an ops outside core §7.4 shows as unusable', () => {
  const tlvs = /** @type {[number, Uint8Array][]} */ ([[m.TAG_OPS, packOps(Object.values(m.OP))], [reg.CORE.tlv.describe.max_op_ms, new Writer().u32(1000).done()]]);
  const coreOffer = { entry: { fn: 0, instance: 0, revision: 1, flags: 0, name: '' }, description: decodeDescription(tlvs), tlvs };
  const row = dump.describeOffer(coreOffer);
  assert.deepEqual(row.ops, Object.entries(m.OP).sort((a, b) => a[1] - b[1]).map(([k]) => k));
  assert.equal(row.declares?.['max op ms'], '1000');
  const bad = /** @type {[number, Uint8Array][]} */ ([[m.TAG_OPS, Uint8Array.of(0x01, 0x01, 0x00)]]);
  const r = dump.describeOffer({ entry: { fn: 3, instance: 0, revision: 1, flags: 0, name: 'oep.fixture.gpio' }, description: decodeDescription(bad), tlvs: bad });
  assert.match(/** @type {string} */ (r.unusable), /zero byte \(core §7\.4\)/);
  const text = dump.toText({ revision: 1, maxFrame: 1024, core: coreOffer, offers: [], requests: { confirm: 1, list: 1, describe: 1 }, missing: [] });
  assert.match(text, /\ncore {9}fn 0 {3}\(no name; the probe itself\)\n/);
});
