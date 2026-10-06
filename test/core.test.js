// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cobs from '../src/cobs.js';
import { Writer, utf8 } from '../src/bytes.js';
import { PLAN_APPLY, PLAN_NAME, PLAN_RELEASE, describe, find, listEntries, maxOpMs, notOffered, offers, ops, probeInfo } from '../src/core.js';
import { NoSession, Rejected } from '../src/errors.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

test('crc16 and COBS as transports §1 says', () => {
  assert.equal(cobs.crc16(utf8('123456789')), 0x29b1);
  const data = Uint8Array.from([1, 0, 2, 0, 0, 3]);
  assert.deepEqual(cobs.decode(cobs.encode(data)), data);
  const long = new Uint8Array(300).fill(7);
  assert.deepEqual(cobs.decode(cobs.encode(long)), long);
  const f = cobs.frame(data);
  assert.equal(f[0], 0);
  assert.equal(f[f.length - 1], 0);
  assert.deepEqual(cobs.unframe(f.subarray(1, f.length - 1)), data);
});

for (const framing of /** @type {const} */ (['length', 'cobs'])) {
  test(`confirm, list, describe and a session with the fake probe (${framing})`, { skip: !haveFake }, async () => {
    const fake = await startFake([], framing);
    const hst = await openTcp({ port: fake.port, framing });
    try {
      assert.equal(hst.revision, 1);
      const entries = await listEntries(hst);
      assert.ok(entries.every((e) => e.fn !== m.CORE_FN && e.name !== 'oep.core'));   // the core has no name: never listed (core §7.2)
      assert.ok(entries.some((e) => e.name === 'oep.fixture.logic'));
      assert.equal(await find(hst, 'oep.wire.rvswd'), 1);
      const info = await probeInfo(hst);
      assert.equal(info.model, 'esp32p4');
      assert.equal(info.unitId, 'fafe00000035');
      assert.equal(info.maxOpMs, 10000);                                  // core §7.5 max_op_ms (0x4D)
      assert.equal(info.discoverable, true);                              // 0x4A: the P4 fake is on the project's VID:PID (§7.5)
      assert.equal(await maxOpMs(hst), 10000);
      assert.equal(hst.describes.size, 1);                                // describe is cached (declarations only)
      assert.equal(hst.bootId, hst.limits?.bootId);                       // confirm tells the boot_id (core §7.1)
      const fn0 = /** @type {Set<number>} */ (await ops(hst, 0));         // the ops tag (core §1.2, §7.4)
      assert.deepEqual([...fn0].sort((a, b) => a - b), Object.values(m.OP).sort((a, b) => a - b));   // fn 0: the mandatory ops only (core §12)
      assert.deepEqual(info.ops, fn0);
      assert.equal(await offers(hst, 0, 0x50), false);
      const plan = await find(hst, PLAN_NAME);                           // plan_apply / plan_release on oep.probe.plan (oep-if-plan)
      assert.ok((await offers(hst, plan, PLAN_APPLY)) && (await offers(hst, plan, PLAN_RELEASE)));
      const t = await hst.clock();                                       // fn 0's clock against this host's (core §12)
      assert.ok(t.uptimeNs > 0n && t.hostAfterMs >= t.hostBeforeMs && t.roundTripMs === t.hostAfterMs - t.hostBeforeMs);
      assert.equal(t.bootId, hst.bootId);
      assert.ok((await hst.clock()).uptimeNs > t.uptimeNs);              // the clock goes on
      const opened = await hst.open(3000, { owner: 'js test' });
      assert.deepEqual(Object.keys(opened).sort(), ['bootId', 'leaseMs']);   // no resumed (core §6.4)
      assert.equal(opened.bootId, hst.bootId);
      assert.deepEqual((await hst.lockState()).owner, 'js test');
      assert.equal(typeof (await hst.clock()).uptimeNs, 'bigint');      // clock in the session: session_id 0, touches nothing
      await hst.keepalive();
      const r = await hst.pipelineCalls(Array.from({ length: 8 }, () => [0, 0x13, new Uint8Array()]), { locked: false });
      assert.equal(r.length, 8);
      await hst.end();
    } finally {
      await hst.link.close();
      fake.stop();
    }
  });
}

test('one TLV form: tag(u8) len(u16) value whatever the length (core §2.2); one request header (§4.1)', () => {
  const big = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const t = m.tlv(0x41, big);
  assert.deepEqual([...t.slice(0, 3)], [0x41, 0x00, 0x02]);
  assert.deepEqual(m.splitTlvs(Uint8Array.from([...t, ...m.tlv(0x42, utf8('x'))])), [[0x41, big], [0x42, utf8('x')]]);
  assert.deepEqual([...m.tlv(0x41, new Uint8Array(254)).slice(1, 3)], [254, 0]);
  assert.equal(m.tlv(0x41, new Uint8Array(255)).length, 255 + 3);
  assert.deepEqual([...m.tlv(0x41, [])], [0x41, 0, 0]);
  assert.throws(() => m.splitTlvs(Uint8Array.from([0x41, 0x00, 0x02, ...new Uint8Array(100)])), m.ShortPayload);   // len past the end
  assert.throws(() => m.splitTlvs(Uint8Array.from([0x41, 1])), m.ShortPayload);                       // a header cut short
  assert.throws(() => m.tlv(0x00, []), RangeError);                                                    // tag 0x00 is reserved
  assert.throws(() => m.tlv(0x41, new Uint8Array(0x10000)), RangeError);
  const plain = new m.Request(7, 3, 1, Uint8Array.of(0xaa)).pack(), held = new m.Request(7, 3, 1, Uint8Array.of(0xaa), 0xdeadbeef).pack();
  assert.equal(plain.length, 11);
  assert.equal(held.length, 11);
  assert.equal(plain[0], 0x01);
  assert.deepEqual([...plain.slice(6, 10)], [0, 0, 0, 0]);                                             // session_id 0 = none
  assert.equal(m.Request.unpack(held).session, 0xdeadbeef);
  assert.equal(new m.Request(7, 3, 1, Uint8Array.of(0xaa), null).session, 0);
  const no = notOffered();                                                                             // what a probe answers
  assert.ok(no instanceof Rejected && no.constructor === Rejected && no.result.detail === m.REJECT.unknown_operation);
  const rd = new m.Reader(Uint8Array.from([3, 0, 7, 8, 9, 0x41, 1, 0, 5]));
  assert.deepEqual([...rd.counted(2)], [7, 8, 9]);                                                     // len(u16) data [TLV]
  assert.deepEqual(rd.tail().get(0x41), Uint8Array.of(5));
});

test('the probe takes a long non-critical TLV and refuses a broken one', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    const big = new Uint8Array(300).fill(1);
    const open = new Writer().u32(3000).u8(0).done();                                          // an open (the id in the header) ...
    const r = await hst.request(0, m.OP.open, Uint8Array.from([...open, ...m.tlv(0x21, big)]), { session: 0x1234 });
    const rd = new m.Reader(r.payload);
    rd.u32(); rd.u32();
    assert.deepEqual(rd.tail().ignored, [0x21]);                                               // ... with a long TLV it ignores
    hst.session = 0x1234;
    await assert.rejects(hst.request(0, m.OP.open, Uint8Array.from([...open, 0x21, 5, 0, 9]), { session: 0x1234 }),
      (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);                       // a len past the end
    await assert.rejects(hst.request(0, m.OP.open, Uint8Array.from([...open, 0x00, 0, 0]), { session: 0x1234 }),
      (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);                       // tag 0x00 is reserved
    const tlvs = await describe(hst, 0);
    assert.ok(tlvs.some(([tag]) => (tag & 0x7f) === reg.CORE.tlv.describe.max_op_ms));
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('a lapsed lease is no_session, never resumed: the host opens anew (core §6.2, §9)', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    const opened = await hst.open(1000);
    assert.equal(opened.leaseMs, 1000);
    const epoch = hst.epoch, sid = hst.session;
    await new Promise((r) => setTimeout(r, 1300));
    await assert.rejects(hst.keepalive(), NoSession);
    assert.equal(hst.epoch, epoch + 1);
    assert.equal(hst.session, null);                                                          // out of a session
    await assert.rejects(hst.keepalive(), (e) => e instanceof Rejected && e.result.detail === m.REJECT.session_required);
    await hst.open(1000);                                                                     // a new session, a new id
    assert.notEqual(hst.session, sid);
    await hst.keepalive();
    const ended = hst.session;
    await hst.end();
    assert.equal(hst.session, null);
    hst.session = ended;                                                                      // a stale caller's id
    await assert.rejects(hst.keepalive(), NoSession);                                         // end released it: no resume
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('subscribe is the emitting fn\'s own op 0x30 (min_bytes u16, max_delay_ms u32, no target fn); unsubscribe 0x32; gpio has neither', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(3000);
    const logic = await find(hst, 'oep.fixture.logic');
    assert.ok((await offers(hst, logic, m.OP_SUBSCRIBE)) && (await offers(hst, logic, m.OP_UNSUBSCRIBE)));
    const send = hst.link.send.bind(hst.link);
    /** @type {Uint8Array[]} */ const sent = [];
    hst.link.send = (b, o) => { sent.push(b); return send(b, o); };
    await hst.subscribe(logic, 1024, 100);
    const sub = m.Request.unpack(sent[0]);
    assert.deepEqual([sub.fn, sub.op, [...sub.payload]], [logic, 0x30, [0x00, 0x04, 100, 0, 0, 0]]);
    assert.ok(hst.subscriptions.has(logic));
    await hst.unsubscribe(logic);
    const unsub = m.Request.unpack(sent[1]);
    assert.deepEqual([unsub.fn, unsub.op, unsub.payload.length], [logic, 0x32, 0]);
    await hst.unsubscribe(logic);                                                             // nothing subscribed: ok
    const gpio = await find(hst, 'oep.fixture.gpio');
    assert.equal(await offers(hst, gpio, m.OP_SUBSCRIBE), false);                             // sends no notifications
    await assert.rejects(hst.subscribe(gpio), (e) => e instanceof Rejected && e.result.detail === m.REJECT.unknown_operation);
    await assert.rejects(hst.subscribe(0), (e) => e instanceof Rejected && e.result.detail === m.REJECT.unknown_operation);   // fn 0 sends none
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});
