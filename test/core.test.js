// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cobs from '../src/cobs.js';
import { Writer, utf8 } from '../src/bytes.js';
import { describe, find, listEntries, maxOpMs, probeInfo } from '../src/core.js';
import { Expired, Rejected, Unsupported } from '../src/errors.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

test('crc16 and COBS as core §3.1 says', () => {
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
      assert.equal(entries[0].name, 'oep.core');
      assert.ok(entries.some((e) => e.name === 'oep.fixture.logic'));
      assert.equal(await find(hst, 'oep.wire.rvswd'), 1);
      const info = await probeInfo(hst);
      assert.equal(info.model, 'esp32p4');
      assert.equal(info.unitId, '30eda0e31108');
      assert.equal(info.maxOpMs, 10000);                                  // core §7.5 max_op_ms (0x4D)
      assert.equal(info.discoverable, true);                              // 0x4A (was oep_pid)
      assert.equal(await maxOpMs(hst), 10000);
      assert.equal(hst.describes.size, 1);                                // describe is cached (declarations only)
      assert.equal(hst.bootId, hst.limits?.bootId);                       // confirm tells the boot_id (core §7.1)
      const opened = await hst.open(3000, { owner: 'js test' });
      assert.equal(opened.resumed, reg.CORE.enum.resumed.new);
      assert.equal(opened.swept, false);
      assert.equal(opened.bootId, hst.bootId);
      assert.deepEqual((await hst.lockState()).owner, 'js test');
      const r = await hst.pipelineCalls(Array.from({ length: 8 }, () => [0, 0x13, new Uint8Array()]), { locked: false });
      assert.equal(r.length, 8);
      await hst.end();
    } finally {
      await hst.link.close();
      fake.stop();
    }
  });
}

test('TLV long form: tag 0xFF len(u16) value from 255 bytes on, the one encoding (core §2.2)', () => {
  const big = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const t = m.tlv(0x41, big);
  assert.deepEqual([...t.slice(0, 4)], [0x41, 0xff, 0x00, 0x02]);
  assert.deepEqual(m.splitTlvs(Uint8Array.from([...t, ...m.tlv(0x42, utf8('x'))])), [[0x41, big], [0x42, utf8('x')]]);
  assert.equal(m.tlv(0x41, new Uint8Array(254))[1], 254);
  assert.equal(m.tlv(0x41, new Uint8Array(255)).length, 255 + 4);
  assert.throws(() => m.splitTlvs(Uint8Array.from([0x41, 0xff, 3, 0, 97, 98, 99])), m.BadTlv);        // a short value, long form
  assert.throws(() => m.splitTlvs(Uint8Array.from([0x41, 0xff, 0x00, 0x02, ...new Uint8Array(100)])), m.ShortPayload);
  assert.throws(() => m.tlv(0x00, []), RangeError);                                                    // tag 0x00 is reserved
  assert.throws(() => m.tlv(0x41, new Uint8Array(0x10000)), RangeError);
  const rd = new m.Reader(Uint8Array.from([3, 0, 7, 8, 9, 0x41, 1, 5]));
  assert.deepEqual([...rd.counted(2)], [7, 8, 9]);                                                     // len(u16) data [TLV]
  assert.deepEqual(rd.tail().get(0x41), Uint8Array.of(5));
});

test('the probe takes a long non-critical TLV and refuses the wrong encoding', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    const big = new Uint8Array(300).fill(1);
    const open = new Writer().u32(0x1234).u32(3000).u8(0).done();                              // an open ...
    const r = await hst.request(0, m.OP.open, Uint8Array.from([...open, ...m.tlv(0x21, big)]), { locked: false });
    const rd = new m.Reader(r.payload);
    rd.u32(); rd.u32(); rd.u8();
    assert.deepEqual(rd.tail().ignored, [0x21]);                                               // ... with a long TLV it ignores
    hst.session = 0x1234;
    await assert.rejects(hst.request(0, m.OP.open, Uint8Array.from([...open, 0x21, 0xff, 1, 0, 9]), { locked: false }),
      (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);                       // a short value in the long form
    await assert.rejects(hst.request(0, m.OP.open, Uint8Array.from([...open, 0x00, 0]), { locked: false }),
      (e) => e instanceof Rejected && e.reason === m.REJECT.malformed);                       // tag 0x00 is reserved
    const tlvs = await describe(hst, 0);
    assert.ok(tlvs.some(([tag]) => (tag & 0x7f) === reg.CORE.tlv.describe.max_op_ms));
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('a lapsed lease is expired, never re-opened silently; open then says swept (core §6.2, §9)', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    const opened = await hst.open(1000);
    assert.equal(opened.leaseMs, 1000);
    const epoch = hst.epoch;
    await new Promise((r) => setTimeout(r, 1300));
    const e = await hst.keepalive().catch((x) => x);
    assert.ok(e instanceof Expired);
    assert.equal(e.leaseMs, 1000);
    assert.match(e.message, /1000 ms/);
    assert.equal(hst.epoch, epoch + 1);
    await assert.rejects(hst.keepalive(), Expired);                                           // still: nothing re-opens by itself
    const again = await hst.open(1000, { session: /** @type {number} */ (hst.session) });
    assert.equal(again.resumed, reg.CORE.enum.resumed.swept);
    assert.ok(again.swept);
    await hst.keepalive();
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('subscribe: max_delay_ms is u32, fn 0 heartbeats boot_id uptime_ns, an fn that emits nothing is unsupported', { skip: !haveFake }, async () => {
  const fake = await startFake();
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(3000);
    const send = hst.link.send.bind(hst.link);
    /** @type {Uint8Array[]} */ const sent = [];
    hst.link.send = (b) => { sent.push(b); return send(b); };
    await hst.subscribe(0, 0, 100);
    assert.deepEqual([...m.Request.unpack(sent[0]).payload], [0, 0, 0, 0, 100, 0, 0, 0]);
    const hb = await hst.link.nextEvent((f) => f[1] === 0 && f[2] === 0 && f[5] === reg.CORE.event.heartbeat, 2000);
    assert.ok(hb);
    const rd = new m.Reader(hb.slice(6));
    assert.equal(rd.u32(), hst.bootId);
    assert.ok(rd.u64() > 0n);                                                                 // uptime_ns (u64)
    await assert.rejects(hst.subscribe(await find(hst, 'oep.fixture.gpio')), Unsupported);
    await hst.unsubscribe(5);                                                                 // nothing subscribed: ok
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});
