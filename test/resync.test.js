// @ts-check
// The resync of length-prefixed frames (oep-core §5.1) on a scripted transport: a stray result, an impossible length,
// a frame that stops half way and a missing answer make the link discard until quiet, confirm, and send the waiting
// requests once more with the same corr; pushes that never stop get the blind unsubscribe and end; no resync while
// probing; the link's own confirms ask for 1..1 (core §7.1). Mirrors oep-client-python's tests/test_link_host.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as m from '../src/message.js';
import { FramingLost } from '../src/errors.js';
import { Link } from '../src/link.js';
import { Host, MAX_REVISION, MIN_REVISION } from '../src/host.js';

const CONFIRM_V1 = Uint8Array.from([0x4f, 0x45, 0x50, 0x21, 1, 0, 0x00, 0x04, 0, 0, 1, 0, 4, 0x11, 0, 0, 0]);   // OEP! rev 1 ... boot_id

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

test('a result for no request waiting resyncs; the read goes once more with the same corr', async () => {
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
  assert.deepEqual(ops(sent), [m.OP.lock_state, m.OP.confirm, m.OP.lock_state]);
  assert.equal(sent[0].corr, 7);
  assert.equal(sent[2].corr, 7);
  assert.ok(link.stats.stale >= 1);
  assert.equal(link.stats.resyncs, 1);
  assert.equal(link.stats.retries, 1);
});

test('a state-changing request goes once more with the same corr after the resync (the probe answers from its table)', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  t.inject(frame(result(99)));                                    // a stray result before the request
  await sleep(5);
  const reply = m.Result.unpack(await link.send(new m.Request(7, 1, 0x01, Uint8Array.of(0x78), 0x1234).pack()));
  assert.equal(reply.corr, 7);
  assert.equal(link.stats.resyncs, 1);
  // the stray came before the request: the resync ran first and the request waited for it
  assert.deepEqual(ops(sent), [m.OP.confirm, 0x01]);
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

test('a request sent twice already fails with FramingLost when the boundaries go again', async () => {
  const { t } = scripted();
  const link = await linkOn(t);
  const respond = t.respond;
  t.respond = (req) => (req.op === m.OP.confirm ? respond(req) : [result(0x4242)]);   // always a stray, never ours
  await assert.rejects(link.send(new m.Request(5, 0, m.OP.lock_state, new Uint8Array()).pack()), FramingLost);
  assert.equal(link.stats.resyncs, 2);
});

test('no confirm back in 3 tries: the requests waiting fail with FramingLost', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t, 80);
  t.respond = (req) => (req.corr === 1 ? [result(77)] : null);   // a stray, then silence
  await assert.rejects(link.send(new m.Request(1, 0, m.OP.lock_state, new Uint8Array()).pack()), /no confirm came back in 3 tries/);
  assert.deepEqual(ops(sent), [m.OP.lock_state, m.OP.confirm, m.OP.confirm, m.OP.confirm]);
});

test('pushes that never stop are stopped blind with unsubscribe and end; the session request is not sent again', async () => {
  const { t, sent } = scripted();
  const link = await linkOn(t);
  const hst = new Host(link);
  hst.session = 0xabcd;
  hst.revision = 1;
  hst.subscriptions.add(5);
  const push = frame(Uint8Array.from([0x06, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...new Uint8Array(32).fill(0x78)]));
  let noisy = true;
  const noise = setInterval(() => { if (noisy) t.inject(push); }, 5);
  const respond = t.respond;
  t.respond = (req) => {
    if (req.op === m.OP.end) noisy = false;                    // the lock ends, the subscription with it
    if (req.fn === 5) return [result(50)];                     // a stray result starts the resync
    return respond(req);
  };
  try {
    await assert.rejects(link.send(new m.Request(hst.nextCorr(), 5, 0x01, new Uint8Array(), 0xabcd).pack()), FramingLost);
  } finally {
    clearInterval(noise);
  }
  // a loaded machine may stall the noise timer past the 50 ms quiet: a confirm may then go before the blind stops
  assert.deepEqual(ops(sent).slice(1).filter((op) => op !== m.OP.confirm), [m.OP.unsubscribe, m.OP.end]);
  assert.equal(ops(sent).at(-1), m.OP.confirm);                  // the resync's confirm after the stops
  assert.equal(sent.filter((r) => r.fn === 5).length, 1);        // the session request is not sent again
  assert.ok(sent.filter((r) => r.op === m.OP.unsubscribe || r.op === m.OP.end).every((r) => r.session === 0xabcd));
  assert.equal(hst.subscriptions.size, 0);
  assert.equal(link.endedBlind, true);
});

test('while probing (core §3.3) a stray result does not resync: nothing but the confirm goes out', async () => {
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
  t.inject(frame(result(99)));                                   // a resync: its confirm
  await sleep(5);
  await link.send(new m.Request(2, 0, m.OP.lock_state, new Uint8Array()).pack());
  assert.equal(await link.confirmRaw(200), true);                // confirmRaw
  const confirms = sent.filter((r) => r.fn === 0 && r.op === m.OP.confirm);
  assert.equal(confirms.length, 2);
  for (const c of confirms) assert.deepEqual([c.payload[4], c.payload[5]], [MIN_REVISION, MAX_REVISION]);
  assert.deepEqual([MIN_REVISION, MAX_REVISION], [1, 1]);
});
