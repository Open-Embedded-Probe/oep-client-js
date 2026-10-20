// @ts-check
// The resync of length-prefixed frames (transports §5) on a scripted transport: an impossible length, a frame that stops
// half way and a missing answer make the link discard until quiet, confirm, and send the waiting requests once more
// with the same corr; a result for a corr no request waits for is only read past; pushes that never stop make the link
// open the transport again (no unsubscribe or end sent blind); no resync while probing; the link's own confirms ask for
// the revisions the client handles (core §7.1). Mirrors oep-client-python's tests/test_link_host.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as m from '../src/message.js';
import { Writer } from '../src/bytes.js';
import { FramingLost, TransportFailed } from '../src/errors.js';
import { Link } from '../src/link.js';
import { Host, MAX_REVISION, MIN_REVISION } from '../src/host.js';

/** confirm's answer: magic revision max_frame window max_inflight boot_id (core §7.1) */
const CONFIRM_V1 = new Writer().raw(m.CONFIRM_RESULT).u8(1).u16(1024).u32(65536).u8(4).u32(0x11).done();
/** a length past max_frame: the boundaries are lost (transports §5) */
const BROKEN = new Writer().u16(5000).raw(new TextEncoder().encode('garbage')).done();

/** @param {Uint8Array} msg */
const frame = (msg) => Uint8Array.from([msg.length & 0xff, msg.length >> 8, ...msg]);
/** @param {number} corr @param {Uint8Array} [payload] */
const result = (corr, payload = new Uint8Array()) => new m.Result(corr, m.COMPLETED, m.SUCCESS, payload).pack();
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A length-prefixed transport: every frame written is recorded and answered by `respond` (null: no answer); `inject`
 * delivers bytes as if the probe sent them.
 * @param {(req: m.Request) => Uint8Array[] | null} [respond]
 */
function scripted(respond = (req) => [result(req.corr, req.fn === 0 && req.op === m.OP.confirm ? CONFIRM_V1 : new Uint8Array())]) {
  /** @type {m.Request[]} */ const sent = [];
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  const t = {
    respond,
    /** @type {'length'} */ framing: 'length', kind: 'vendor',
    /** @param {Uint8Array} data */
    async write(data) {
      for (let at = 0; at < data.length;) {
        const n = data[at] | (data[at + 1] << 8);
        const req = m.Request.unpack(data.slice(at + 2, at + 2 + n));
        sent.push(req);
        const replies = t.respond(req);
        if (replies) setTimeout(() => { for (const r of replies) deliver(frame(r)); }, 1);
        at += 2 + n;
      }
    },
    /** @param {(c: Uint8Array) => void} onData */
    start(onData) { deliver = onData; },
    async close() {},
    /** @param {Uint8Array} bytes */
    inject(bytes) { deliver(bytes); },
  };
  return { t, sent };
}

/** @param {m.Request[]} sent */
const ops = (sent) => sent.map((r) => r.op);

/** @param {ReturnType<typeof scripted>['t']} t @param {number} [timeoutMs] */
async function linkOn(t, timeoutMs = 300) {
  const link = new Link(t, { timeoutMs, maxFrame: 1024 });
  await link.start();
  return link;
}

test('a result for a corr no request waits for is read past: no resync (transports §5)', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  let first = true;
  const respond = t.respond;
  t.respond = (req) => {
    if (first) { first = false; return [result(6, Uint8Array.of(1)), result(req.corr)]; }   // 6 answered late, then ours
    return respond(req);
  };
  const reply = m.Result.unpack(await link.send(new m.Request(7, 0, m.OP.lock_state, new Uint8Array()).pack()));
  assert.equal(reply.corr, 7);
  assert.deepEqual(ops(sent), [m.OP.lock_state]);
  assert.ok(link.stats.stale >= 1);
  assert.equal(link.stats.resyncs, 0);
});

test('a state-changing request goes once more with the same corr after a lost boundary\'s resync (the probe answers from its table)', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  let first = true;
  const respond = t.respond;
  t.respond = (req) => {
    if (first) { first = false; t.inject(BROKEN); return null; }   // a lost boundary instead of the answer
    return respond(req);
  };
  const reply = m.Result.unpack(await link.send(new m.Request(7, 1, 0x01, Uint8Array.of(0x78), 0x1234).pack()));
  assert.equal(reply.corr, 7);
  assert.deepEqual(ops(sent), [0x01, m.OP.confirm, 0x01]);
  assert.deepEqual([sent[0].corr, sent[2].corr], [7, 7]);           // the same corr both times
  assert.equal(link.stats.resyncs, 1);
  assert.equal(link.stats.retries, 1);
});

test('an impossible length resyncs', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  const respond = t.respond;
  let first = true;
  t.respond = (req) => {
    if (!first) return respond(req);
    first = false;
    setTimeout(() => t.inject(Uint8Array.from([0x88, 0x13, 1, 2, 3])), 1);   // length 5000 > max_frame 1024
    return null;
  };
  const reply = m.Result.unpack(await link.send(new m.Request(3, 0, m.OP.lock_state, new Uint8Array()).pack()));
  assert.equal(reply.corr, 3);
  assert.equal(link.stats.resyncs, 1);
  assert.deepEqual(ops(sent), [m.OP.lock_state, m.OP.confirm, m.OP.lock_state]);
});

test('a frame that stops half way resyncs', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t, 1000);
  const respond = t.respond;
  let first = true;
  t.respond = (req) => {
    if (!first) return respond(req);
    first = false;
    setTimeout(() => t.inject(Uint8Array.from([10, 0, 0x02, 0x04])), 1);            // 2 of 10 bytes ...
    setTimeout(() => t.inject(frame(result(req.corr))), 260);                     // ... then nothing for over 200 ms
    return null;
  };
  const reply = m.Result.unpack(await link.send(new m.Request(4, 1, 0x01, new Uint8Array(), 1).pack()));
  assert.equal(reply.corr, 4);
  assert.equal(link.stats.resyncs, 1);
  assert.deepEqual(ops(sent), [0x01, m.OP.confirm, 0x01]);
  assert.equal(sent[2].corr, 4);
});

test('no answer in time: the resync first, then the request once more', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t, 150);
  const respond = t.respond;
  let first = true;
  t.respond = (req) => { if (first) { first = false; return null; } return respond(req); };
  const reply = m.Result.unpack(await link.send(new m.Request(9, 0, m.OP.lock_state, new Uint8Array()).pack()));
  assert.equal(reply.corr, 9);
  assert.deepEqual(ops(sent), [m.OP.lock_state, m.OP.confirm, m.OP.lock_state]);
  assert.equal(link.stats.resyncs, 1);
});

test('pipelined requests: all still waiting go once more, in order, after one resync', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  const respond = t.respond;
  let n = 0;
  t.respond = (req) => {
    n++;
    if (n === 1) return [result(50)];                             // a stray: the boundaries may be off
    if (n <= 3) return null;                                     // 11 and 12: their answers are lost in the resync
    return respond(req);
  };
  const reqs = [10, 11, 12].map((c) => new m.Request(c, 1, 0x02, Uint8Array.of(c)).pack());
  const replies = await link.exchange(reqs, { maxInflight: 3, window: 4096 });
  assert.deepEqual(replies.map((r) => m.Result.unpack(r).corr), [10, 11, 12]);
  assert.equal(link.stats.resyncs, 1);
  assert.deepEqual(sent.map((r) => [r.op, r.corr]), [[2, 10], [2, 11], [2, 12], [m.OP.confirm, sent[3].corr], [2, 10], [2, 11], [2, 12]]);
});

test('a request sent twice already fails when the boundaries go again: never a third time (core §5.2)', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  const respond = t.respond;
  t.respond = (req) => {
    if (req.op === m.OP.confirm) return respond(req);
    t.inject(BROKEN);                                              // never ours: the boundaries lost every time
    return null;
  };
  // FramingLost when the second loss is seen as such, TransportFailed when the resync's discard took it and the wait ran out
  await assert.rejects(link.send(new m.Request(5, 0, m.OP.lock_state, new Uint8Array()).pack()),
    (e) => e instanceof FramingLost || e instanceof TransportFailed);
  assert.equal(sent.filter((r) => r.op === m.OP.lock_state).length, 2);
});

test('no confirm back in 3 tries: the requests waiting fail with FramingLost', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t, 80);
  t.respond = () => null;                                        // silence: the timeout starts the resync
  await assert.rejects(link.send(new m.Request(1, 0, m.OP.lock_state, new Uint8Array()).pack()), /no confirm came back in 3 tries/);
  assert.deepEqual(ops(sent), [m.OP.lock_state, m.OP.confirm, m.OP.confirm, m.OP.confirm]);
});

test('pushes that never stop make the link open the transport again; no unsubscribe or end goes out blind (transports §5)', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  const hst = new Host(link);
  hst.session = 0xabcd;
  hst.revision = 1;
  hst.subscriptions.add(5);
  const push = frame(new Writer().u8(m.ROLE_DATA).u16(5).u16(0).u64(0).u16(32).raw(new Uint8Array(32).fill(0x78)).done());
  let noisy = true, reopenedAt = -1;
  /** @type {any} */ (t).reopen = async () => { noisy = false; reopenedAt = sent.length; };   // a fresh connection: quiet
  const noise = setInterval(() => { if (noisy) t.inject(push); }, 5);
  let first = true;
  const respond = t.respond;
  t.respond = (req) => {
    if (first) { first = false; t.inject(BROKEN); return null; }   // a lost boundary starts the resync
    return respond(req);
  };
  try {
    const reply = m.Result.unpack(await link.send(new m.Request(hst.nextCorr(), 5, 0x01, new Uint8Array(), 0xabcd).pack()));
    assert.equal(reply.corr, sent[0].corr);
  } finally {
    clearInterval(noise);
  }
  assert.ok(reopenedAt >= 1, 'opened again');
  assert.deepEqual(sent.slice(0, reopenedAt).map((r) => [r.fn, r.op]), [[5, 0x01]]);   // nothing more on the noisy one
  assert.deepEqual(ops(sent.slice(reopenedAt)), [m.OP.confirm, 0x01]);   // confirmed, then the request sent again
  assert.ok(!sent.some((r) => r.op === m.OP_UNSUBSCRIBE || (r.fn === 0 && r.op === m.OP.end)));
  assert.deepEqual([[...hst.subscriptions], hst.session], [[5], 0xabcd]);   // the session stays the host's
});

test('while probing (transports §3) a stray result does not resync: nothing but the confirm goes out', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  link.probing = true;
  const respond = t.respond;
  t.respond = (req) => [result(40), ...(respond(req) ?? [])];
  const reply = m.Result.unpack(await link.send(new m.Request(1, 0, m.OP.confirm, Uint8Array.from([0x4f, 0x45, 0x50, 0x3f, 1, 1])).pack()));
  assert.equal(reply.corr, 1);
  await sleep(100);
  assert.deepEqual(ops(sent), [m.OP.confirm]);
  assert.equal(link.stats.resyncs, 0);
  assert.equal(link.stats.stale, 1);
});

test("the link's own confirms ask for the revisions the client handles (core §7.1), not 0..0xFF", async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  t.inject(BROKEN);                                              // a lost boundary: the resync's confirm
  await sleep(5);
  await link.send(new m.Request(2, 0, m.OP.lock_state, new Uint8Array()).pack());
  assert.equal(await link.confirmRaw(200), true);                // confirmRaw
  const confirms = sent.filter((r) => r.fn === 0 && r.op === m.OP.confirm);
  assert.equal(confirms.length, 2);
  for (const c of confirms) assert.deepEqual([c.payload[4], c.payload[5]], [MIN_REVISION, MAX_REVISION]);
  assert.deepEqual([MIN_REVISION, MAX_REVISION], [1, 1]);
});
