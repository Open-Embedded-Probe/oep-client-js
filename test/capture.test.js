// @ts-check
// oep.fixture.logic / analog / capture-group (src/capture.js): the configure answer and the §3.0 layout offline, then
// the virtual bench over TCP (oep-client-python's test_capture.py and test_virtual_bench_capture.py, with the virtual bench's real clock).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import * as c from '../src/capture.js';
import { Writer, concat } from '../src/bytes.js';
import { describe, find, planApply, planRelease, take } from '../src/core.js';
import { Rejected, Unavailable, Unsupported } from '../src/errors.js';
import * as m from '../src/message.js';
import { openTcp } from '../src/node/index.js';
import { PYTHON, haveVirtualBench, join, startVirtualBench } from './virtual-bench.js';

/** @param {...[number, Uint8Array | number[]]} items */
const answer = (...items) => Uint8Array.from(items.flatMap(([t, v]) => [t, v.length & 0xff, v.length >> 8, ...v]));   // tag len(u16) value
const u32 = (/** @type {number} */ v) => new Writer().u32(v).done();
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A LogicCapture on a stand-in host, for the parts that need no probe.
 * @param {any} hst @param {number} fn */
function offline(hst = {}, fn = 1) { return new c.LogicCapture(hst, fn, c.LogicCapture.NAME); }

/** @param {number} width @param {number[]} positions */
function logic(width, positions) {
  const lc = offline();
  lc.config = new c.Config();
  lc.config.rateNum = 1;
  lc.config.width = width;
  lc.config.positions = positions;
  return lc;
}

/** Channel k of sample i is bit k of the counter i.
 * @param {c.LogicCapture} lc @param {Uint8Array} data @param {number} samples */
function counterOk(lc, data, samples, first = 0) {
  for (let k = 0; k < lc.cfg.positions.length; k++) {
    assert.deepEqual(lc.channel(data, k, samples), Array.from({ length: samples }, (_, i) => ((first + i) >> k) & 1));
  }
}

// ---- offline (test_capture.py) -------------------------------------------------------------------------------

test('the configure answer is read into actual values', () => {
  const cfg = c.parseConfig(answer([c.ACTUAL_RATE, [...u32(7000000), ...u32(1)]], [c.LAYOUT, [4, 3, 0, 1, 2]],
    [c.ACTUAL_SAMPLES, u32(1000)], [0x6e, [1, 2]]), false);
  assert.equal(cfg.rate, 7000000);
  assert.deepEqual([cfg.width, cfg.positions, cfg.samples, cfg.bytes], [4, [0, 1, 2], 1000, 500]);
  assert.ok(!('ignored' in cfg) && !('jitterNs' in cfg) && !('ratePpm' in cfg));   // no ignored, timing or rate_accuracy
});

test('analog answers: signed zero and scale, skew, frontend, reference', () => {
  const scale = new Writer().u8(1).i32(-5).i32(-800).done();
  const cfg = c.parseConfig(answer([c.LAYOUT, [16, 0, 12, 2, 0, 1]], [c.SCALE, scale], [c.SKEW, [1, ...u32(54000)]],
    [c.FRONTEND_USED, [1, 2]], [c.REFERENCE, [1, ...u32(1100), 1]], [c.BLOCKING, u32(7)]), true);
  assert.deepEqual([cfg.slot, cfg.offset, cfg.bits, cfg.order], [16, 0, 12, [0, 1]]);
  assert.equal(cfg.zero.get(1), -5);
  assert.equal(cfg.scaleNv.get(1), -800);
  assert.equal(cfg.skewNs.get(1), 54000);
  assert.equal(cfg.frontend.get(1), 2);
  assert.deepEqual(cfg.reference, { source: 'internal', mv: 1100, measured: true });
  assert.equal(cfg.blockingMs, 7);
});

test('three channels in four-bit samples with undefined bits', () => {
  const byte = 0b1_101 | (0b1_110 << 4);
  const lc = logic(4, [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map((k) => lc.channel(Uint8Array.of(byte), k, 2)), [[1, 0], [0, 1], [1, 1]]);
});

test('a byte-per-sample probe with the channel on bit 5', () => {
  assert.deepEqual(logic(8, [5]).channel(Uint8Array.of(0xdf, 0x20, 0xff, 0x00), 0), [0, 1, 1, 0]);
});

test('one channel packs eight samples per byte, lsb first', () => {
  assert.deepEqual(logic(1, [0]).channel(Uint8Array.of(0b101), 0), [1, 0, 1, 0, 0, 0, 0, 0]);
});

test('a segment without a trigger, and bytes after the known ones skipped', () => {
  const b = new Writer().u32(0).u64(0).u32(200192).u64(123000).u32(50).u32(0xffffffff).u8(0).u32(3).raw([9, 9, 9]).done();
  const s = c.Segment.unpack(b);
  assert.equal(s.triggerIndex, null);
  assert.equal(s.samples, 200192);
  assert.equal(s.startNs, 123000n);
  assert.equal(s.generation, 3);
  assert.equal(c.SEGMENT_BYTES, 37);
  const ev = c.parseCaptureEvent(Uint8Array.of(0x05, 3, 0, 7, 0, c.EVENT_SEGMENT, ...b));
  assert.deepEqual([ev.fn, ev.seq, ev.segment?.samples], [3, 7, 200192]);
  const trig = c.parseCaptureEvent(Uint8Array.of(0x05, 3, 0, 8, 0, c.EVENT_TRIGGERED,
    ...new Writer().u32(0).u32(5).u64(12345n).u32(3).u8(1).done()));   // ... generation(u32), then a later revision's byte
  assert.deepEqual([trig.serial, trig.triggerIndex, trig.triggerNs, trig.generation, ev.generation], [0, 5, 12345n, 3, 3]);
});

/** A data frame (core §11.2): role fn seq position(u64) len(u16) data [TLV generation].
 * @param {number} fn @param {number} seq @param {bigint} position @param {string} data @param {number | null} [generation] */
const push = (fn, seq, position, data, generation = null) => {
  const w = new Writer().u8(0x06).u16(fn).u16(seq).u64(position).u16(data.length).raw(new TextEncoder().encode(data));
  if (generation !== null) w.u8(c.DATA_GENERATION).u16(4).u32(generation);
  return w.done();
};

/** pushes arrive in batches, one batch per nextPush() @param {Uint8Array[][]} batches */
function fakeLink(batches) {
  /** @type {Uint8Array[]} */ const pushes = [];
  /** @type {Uint8Array[]} */ const events = [];
  const link = {
    pushes, events,
    /** @param {(f: Uint8Array) => boolean} match */
    async nextPush(match) {
      const b = batches.shift();
      if (b) link.pushes.push(...b);
      const at = link.pushes.findIndex(match);
      return at >= 0 ? link.pushes.splice(at, 1)[0] : null;
    },
  };
  return link;
}
const text = (/** @type {Uint8Array} */ b) => new TextDecoder().decode(b);

test('stream follows positions and counts gaps and lost frames', async () => {
  const other = push(4, 0, 0n, 'zz');
  const link = fakeLink([[push(3, 0, 100n, 'ab'), other], [push(3, 1, 102n, 'cd')], [push(3, 3, 110n, 'ef')]]);
  const cap = offline({ link, session: null }, 3);
  const got = await cap.stream({ nbytes: 6 });
  assert.equal(text(got.data), 'abcdef');
  assert.deepEqual([got.start, got.frames, got.gaps, got.seqLost], [100n, 3, [[4, 6]], 1]);
  assert.deepEqual(link.pushes, [other]);
});

test('stream positions past 4 GiB follow on without a gap', async () => {
  const link = fakeLink([[push(1, 0, 0xfffffffen, 'ab'), push(1, 1, 0x100000000n, 'cd')]]);
  const got = await offline({ link, session: null }, 1).stream({ nbytes: 4 });
  assert.deepEqual([text(got.data), got.gaps, got.seqLost], ['abcd', [], 0]);
});

test("stream does not count the fn's events as lost", async () => {
  const link = fakeLink([[push(2, 0, 0n, 'ab')], [push(2, 2, 2n, 'cd')]]);
  link.events.push(Uint8Array.of(0x05, 2, 0, 1, 0, 1));
  const got = await offline({ link, session: null }, 2).stream({ nbytes: 4 });
  assert.equal(got.seqLost, 0);
  assert.equal(link.events.length, 1);
});

test('stream drops pushes of another generation (oep-if-capture §3.4)', async () => {
  const link = fakeLink([[push(2, 0, 90n, 'old', 4), push(2, 1, 0n, 'ab', 5)],
    [Uint8Array.from([...push(2, 2, 2n, 'cd', 5), 0x55, 1, 0, 0])]]);   // an unknown TLV after it: skipped
  const cap = offline({ link, session: null }, 2);
  cap.generation = 5;
  const got = await cap.stream({ nbytes: 4 });
  assert.deepEqual([text(got.data), got.start, got.stale, got.seqLost, got.gaps], ['abcd', 0n, 1, 0, []]);
  const p = c.unpackPush(push(7, 3, 9n, 'xyz', 12));
  assert.deepEqual([p.fn, p.seq, p.position, text(p.data), p.generation], [7, 3, 9n, 'xyz', 12]);
  assert.equal(c.unpackPush(push(7, 3, 9n, 'xyz')).generation, null);
});

test('read spans frames without the header leaking into the data; the generation goes in every request', async () => {
  const stream = new Uint8Array(3072).map((_, i) => i & 0xff);
  /** @param {Uint8Array} p */
  const ok = (p) => {
    const rd = new m.Reader(p);
    const g = rd.u32(), pos = Number(rd.u64()), n = rd.u32();
    assert.equal(g, 9);
    const data = stream.subarray(pos, pos + n);
    return new m.Result(0, m.COMPLETED, m.SUCCESS, new Writer().u64(pos).u8(0).u32(data.length).raw(data).raw([0x41, 1, 0, 0]).done());   // a TLV after
  };
  const hst = {
    session: null,
    async confirmed() { return { maxFrame: 1024 }; },
    /** @param {[number, number, Uint8Array][]} reqs */
    async pipelineCalls(reqs) { return reqs.map(([, , p]) => ok(p)); },
    /** @param {number} fn @param {number} op @param {Uint8Array} p */
    async call(fn, op, p) { return ok(p); },
  };
  assert.deepEqual(await offline(hst, 21).read(100n, 2500, 9), stream.slice(100, 2600));
});

test('a sigrok file takes sixteen channels in two bytes', { skip: !haveVirtualBench }, () => {
  const lc = logic(16, Array.from({ length: 16 }, (_, k) => k));
  lc.cfg.rateNum = 20_000_000;
  const sr = lc.toSr(Uint8Array.of(0x01, 0x80, 0x02, 0x01), 2);
  const path = join(mkdtempSync(join(tmpdir(), 'oep-sr-')), 'x.sr');
  writeFileSync(path, sr);
  const py = 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; '
    + 'print(z.read("version").decode()); print(z.read("metadata").decode()); print(z.read("logic-1-1").hex())';
  const out = spawnSync(PYTHON, ['-c', py, path], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^2\n/);
  for (const s of ['unitsize=2', 'total probes=16', 'samplerate=20000000 Hz', 'probe16=D15']) assert.ok(out.stdout.includes(s), s);
  assert.ok(out.stdout.trim().endsWith('01800201'));
});

// ---- the virtual bench (test_virtual_bench_capture.py) ---------------------------------------------------------------------

/** @param {(ctx: { hst: import('../src/host.js').Host, lc: c.LogicCapture }) => Promise<void>} body @param {string[]} args */
async function withBench(body, args = []) {
  const bench = await startVirtualBench(args);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    const lc = await c.LogicCapture.open(hst);
    await body({ hst, lc });
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

const opts = { skip: !haveVirtualBench };

test('one-shot: three channels in four-bit samples, and the recorder hook', opts, () => withBench(async ({ hst, lc }) => {
  assert.equal(lc.fn, 7);
  await planApply(hst, [[lc.fn, 0, 20], [lc.fn, 1, 21], [lc.fn, 2, 22]]);
  const cfg = await lc.configure({ rate: 1_000_000, samples: 1000 });
  assert.deepEqual([cfg.width, cfg.positions, cfg.samples, cfg.rate], [4, [0, 1, 2], 1000, 1_000_000]);
  /** @type {c.CaptureRecord[]} */
  const records = [];
  c.onCapture(hst).push((r) => records.push(r));
  await lc.start();
  assert.equal(lc.generation, 1);                                          // every start is a generation (§3.2)
  const [seg, ...more] = await lc.wait();
  assert.equal(more.length, 0);
  assert.deepEqual([seg.serial, seg.samples, seg.triggerIndex, seg.slipped, seg.generation], [0, 1000, null, false, 1]);
  const st = await lc.status();
  assert.deepEqual([st.state, st.generation, st.error, st.dropped], [c.STATE.done, 1, null, false]);
  const data = await lc.readSegment(seg);
  assert.equal(data.length, 500);
  counterOk(lc, data, 1000);
  assert.equal(records.length, 1);
  assert.equal(records[0].fn, lc.fn);
  assert.ok(records[0].armedMs !== null && records[0].readMs >= records[0].armedMs);
  await lc.start();
  assert.equal(lc.generation, 2);
  await lc.wait();
  await assert.rejects(lc.read(0, 16, 1), (e) => e instanceof Unavailable && e.cause === 'wrong_state');   // the last capture's
  await assert.rejects(lc.readSegment(seg), Unavailable);                  // its segment names its own generation
  await assert.rejects(lc.release(0, 1), Unavailable);
  await lc.release(0);                                                      // one-shot: nothing to do, ok
  assert.equal((await lc.read(0, 16)).length, 16);
  const fresh = await c.LogicCapture.open(hst);                             // a host that did not start it asks status
  fresh.config = lc.config;
  assert.equal((await fresh.read(0, 16)).length, 16);
  assert.equal(fresh.generation, 2);
}));

test('the classic ESP32 sampler takes a byte a sample', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 4], [lc.fn, 1, 5]]);
  const cfg = await lc.configure({ rate: 1_000_000, samples: 300 });
  assert.deepEqual([cfg.width, cfg.positions], [8, [0, 1]]);
  await lc.start();
  const [seg] = await lc.wait();
  counterOk(lc, await lc.readSegment(seg), 300);
}, ['--profile', 'esp32-v003']));

test('a rate is the source divided by a whole number; query changes nothing', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  const q = await lc.query({ rate: 3_000_000, samples: 100 });
  assert.equal(q.rateNum * 7, q.rateDen * 20_000_000);   // at or under the one asked
  assert.equal(lc.config, null);
}));

for (const [kind, role, value, index] of [[c.EDGE, 1, 0, 10], [c.EDGE, 2, 1, 16], [c.LEVEL, 3, 1, 10]]) {
  test(`a trigger is where the channel does it (type ${kind}, role ${role}, value ${value})`, opts, () => withBench(async ({ hst, lc }) => {
    await planApply(hst, [0, 1, 2, 3].map((r) => /** @type {[number, number, number]} */ ([lc.fn, r, 20 + r])));
    await lc.configure({ rate: 1_000_000, samples: 64, trigger: [kind, role, value], pretrigger: 10 });
    await lc.start();
    const [seg] = await lc.wait();
    assert.equal(seg.triggerIndex, index);
  }));
}

test('force is accepted and wait keeps the lock', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20], [lc.fn, 1, 21]]);
  await lc.configure({ rate: 1_000_000, samples: 64, trigger: [c.EDGE, 1, 1] });
  await lc.start();
  await lc.force();
  let sent = 0;
  const keepalive = hst.keepalive.bind(hst);
  hst.keepalive = async () => { sent++; await keepalive(); };
  await sleep(2);
  const [seg] = await lc.wait({ keepaliveMs: 1e-9 });
  assert.ok(sent > 0);
  assert.notEqual(seg.triggerIndex, null);
}));

test('slipped segments say so', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  await lc.configure({ rate: 1_000_000, samples: 64 });
  await lc.start();
  const [seg] = await lc.wait();
  assert.ok(seg.slipped);
}, ['--capture-slipped']));

test('repeat fills its ring with the clock and goes on after release', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20], [lc.fn, 1, 21]]);
  const cfg = await lc.configure({ rate: 1_000_000, mode: c.REPEAT, samples: 1000, segments: 3 });
  assert.equal(cfg.segments, 3);
  await lc.start();
  let st = await lc.status();
  for (let i = 0; i < 200 && st.state !== c.STATE.paused; i++) { await sleep(5); st = await lc.status(); }
  assert.deepEqual([st.state, st.segmentsDone], [c.STATE.paused, 3]);   // the ring (3) filled and the capture stopped
  const segs = await lc.segments();
  assert.deepEqual(segs.map((s) => s.serial), [0, 1, 2]);
  const page = await lc.segmentsPage(1);
  assert.deepEqual([page.segments.map((s) => s.serial), page.more], [[1, 2], false]);
  const parts = [];
  for (const s of segs) parts.push(...await lc.readSegment(s));
  counterOk(lc, Uint8Array.from(parts), 3000);                          // segments follow on without a gap
  await lc.release(2);
  let next = await lc.segments(3);
  for (let i = 0; i < 200 && !next.length; i++) { await sleep(5); next = await lc.segments(3); }
  assert.equal(next.length >= 1, true);
  assert.ok(next[0].gap);                                              // it stopped: the next segment says so
  const r = await lc.request(c.LogicCapture.READ, new Writer().u32(/** @type {number} */ (lc.generation)).u64(0).u32(64).done(), { locked: false });
  assert.ok(r.payload[8] & 0x02);                                      // released bytes are gone (read: gap)
}));

test('streaming pushes the bytes while subscribed', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20], [lc.fn, 1, 21], [lc.fn, 2, 22]]);
  await lc.configure({ rate: 1_000_000, mode: c.STREAMING });
  await lc.subscribe();
  await lc.start();
  const got = await lc.stream({ nbytes: 1500, ms: 3000 });
  await lc.stop();
  await lc.finish(got);
  assert.deepEqual([got.start, got.gaps, got.seqLost, got.stale], [0n, [], 0, 0]);
  assert.ok(got.length >= 1500 && got.frames > 1);
  counterOk(lc, got.data, got.length * 2);
  assert.equal((await lc.status()).writePos, got.reached);
  const raw = hst.link.pushes.length ? hst.link.pushes[0] : null;
  await lc.subscribe();
  await lc.start();
  const f = await hst.link.nextPush((p) => p[1] === lc.fn, 2000);
  await lc.stop();
  assert.ok(f && c.unpackPush(f).generation === lc.generation);         // streaming data names its generation (TLV 0x01)
  assert.ok(raw === null || c.unpackPush(raw).generation !== null);
}));

test('events go out only while subscribed', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  await lc.configure({ rate: 1_000_000, samples: 64 });
  await lc.start();
  await sleep(50);
  assert.deepEqual(hst.link.events, []);
  await lc.subscribe();
  await lc.start();
  const seg = await lc.nextEvent(null, 2000);
  const stopped = await lc.nextEvent(null, 2000);
  assert.equal(seg?.kind, c.EVENT_SEGMENT);
  assert.equal(seg?.segment?.samples, 64);
  assert.deepEqual([stopped?.kind, stopped?.reason], [c.EVENT_STOPPED, c.STOPPED_REASON.complete]);
}));

test('a capture listens on pins other interfaces hold', opts, () => withBench(async ({ hst, lc }) => {
  const uart = await find(hst, 'oep.fixture.uart');
  await planApply(hst, [[uart, 1, 12], [uart, 2, 6]]);
  await planApply(hst, [[lc.fn, 0, 12]]);                              // the UART's RX, captured too
  const gpio = await find(hst, 'oep.fixture.gpio');
  await assert.rejects(planApply(hst, [[gpio, 1, 12]]), Rejected);     // the UART still holds it against drivers
}));

test('an analog pin is shared with nothing', opts, () => withBench(async ({ hst, lc }) => {
  const an = await c.AnalogCapture.open(hst);
  const gpio = await find(hst, 'oep.fixture.gpio');
  await planApply(hst, [[an.fn, 0, 16]]);
  for (const other of /** @type {[number, number, number][][]} */ ([[[lc.fn, 0, 16]], [[gpio, 1, 16]]])) {
    await assert.rejects(planApply(hst, other), (e) => {
      assert.ok(e instanceof Unavailable);
      assert.deepEqual([e.cause, e.channels, e.fn], ['pin_in_use', [16], null]);   // cause, channel (no holder: core §4.3)
      return true;
    });
  }
  await planApply(hst, [[lc.fn, 0, 17]]);
  await planRelease(hst, [an.fn]);
  await planApply(hst, [[lc.fn, 0, 16]]);
  await assert.rejects(planApply(hst, [[an.fn, 0, 16]]), Rejected);
  await assert.rejects(planApply(hst, [[an.fn, 0, 18], [gpio, 1, 18]]), Rejected);
}));

test('the whole path: take, one-shot slipped, then streaming at 100 kHz and finish', opts, async () => {
  const bench = await startVirtualBench(['--capture-slipped']);
  const hst = await openTcp({ port: bench.port, timeoutMs: 2000 });
  try {
    await take(hst, 5000, { owner: 'test' });
    const lc = await c.LogicCapture.open(hst);
    await planApply(hst, [[lc.fn, 0, 20], [lc.fn, 1, 21]]);
    await lc.configure({ rate: 100_000, samples: 500 });
    await lc.start();
    const [seg] = await lc.wait();
    assert.ok(seg.slipped);
    counterOk(lc, await lc.readSegment(seg), 500);
    await lc.configure({ rate: 100_000, mode: c.STREAMING });   // 25 kB/s at w 2
    await lc.subscribe();
    await lc.start();
    const got = await lc.stream({ nbytes: 2000, ms: 3000 });
    await lc.stop();
    await lc.finish(got);
    assert.deepEqual([got.start, got.gaps, got.seqLost], [0n, [], 0]);
    assert.ok(got.length >= 2000);
    counterOk(lc, got.data, got.length * 4);
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
});

// ---- analog and groups ------------------------------------------------------------------------------------------

test('segments carry ns times with an uncertainty', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  await lc.configure({ rate: 1_000_000, samples: 64 });
  await lc.start();
  const [seg] = await lc.wait();
  assert.equal(seg.startUncertaintyNs, 50);
  assert.equal(seg.startNs % 1_000_000n, 0n);                         // the virtual bench's clock counts ms
}));

/** The virtual bench's analog waveform (virtual_bench_capture.analog_value). @param {number} k @param {number} i */
function analogValue(k, i) {
  const period = 64 * (Math.floor(k / 2) + 1);
  if (k % 2 === 0) return i % period < period / 2 ? 4095 : 0;
  const v = 2047.5 + 2047 * Math.sin((2 * Math.PI * i) / period);
  return Math.floor(v + 0.5) - (v % 1 === 0.5 && Math.floor(v + 0.5) % 2 ? 1 : 0);   // Python's round: half to even
}

test('analog values, scale and calibration', opts, () => withBench(async ({ hst }) => {
  const an = await c.AnalogCapture.open(hst);
  assert.equal(an.fn, 11);
  await planApply(hst, [[an.fn, 0, 16], [an.fn, 1, 17]]);
  const cfg = await an.configure({ rate: 10_000, samples: 256, frontends: { 1: 0 } });
  assert.deepEqual([cfg.slot, cfg.offset, cfg.bits, cfg.order], [16, 0, 12, [0, 1]]);
  assert.equal(cfg.rateNum * 9, cfg.rateDen * 83_333);               // the ADC's 83.3 kHz divided
  assert.deepEqual(cfg.frontend, new Map([[0, 3], [1, 0]]));
  const skew = Number((1_000_000_000n * BigInt(cfg.rateDen)) / (BigInt(cfg.rateNum) * 2n));
  assert.deepEqual(cfg.skewNs, new Map([[0, 0], [1, skew]]));          // one ADC, in turn
  assert.equal(cfg.scaleNv.get(0), Math.floor((3100 * 1_000_000) / 4095));
  assert.deepEqual(cfg.reference, { source: 'internal', mv: 1100, measured: false });
  await an.start();
  const [seg] = await an.wait();
  const data = await an.readSegment(seg);
  assert.deepEqual(an.values(data, 0, 256), Array.from({ length: 256 }, (_, i) => analogValue(0, i)));   // a square
  assert.deepEqual(an.values(data, 1, 256), Array.from({ length: 256 }, (_, i) => analogValue(1, i)));   // a sine
  assert.ok(Math.abs((an.millivolts(0, 2048) ?? NaN) - (3100 * 2048) / 4095) <= 1);
  assert.equal(an.millivolts(0, 4095), null);                          // clipped (§1.2 rule 6)
  assert.equal(an.millivolts(0, 0), null);
  const [lo, hi] = an.endsMillivolts(0);
  assert.ok(lo === 0 && Math.abs(hi - 3100) <= 1);
  const { CLIP_LOW, CLIP_HIGH } = c.AnalogCapture;
  assert.deepEqual([0, 1, 4094, 4095].map((v) => an.clipped(0, v)), [CLIP_LOW, 0, 0, CLIP_HIGH]);
  const square = an.values(data, 0, 256), sine = an.values(data, 1, 256);
  assert.deepEqual(an.clipCounts(0, square), { low: 128, high: 128 });   // the values stay raw
  assert.deepEqual(an.clipCounts(1, sine), { low: 4, high: 0 });         // the sine's troughs round to 0
  assert.deepEqual(an.clipMask(0, square.slice(30, 34)), [CLIP_HIGH, CLIP_HIGH, CLIP_LOW, CLIP_LOW]);
  cfg.scaleNv.set(0, -(cfg.scaleNv.get(0) ?? 0));                           // an inverting frontend: code 0 is the high end
  assert.deepEqual([an.clipped(0, 0), an.clipped(0, 4095)], [CLIP_HIGH, CLIP_LOW]);
  const [ilo, ihi] = an.endsMillivolts(0);
  assert.ok(Math.abs(ilo + 3100) <= 1 && ihi === 0);
  const cal = await an.calibration();
  assert.deepEqual(cal.factory.map((f) => f.frontend), [0, 1, 2, 3]);
  assert.equal(cal.factory[0].scheme, 'org.example.virtual_bench.two-point');
  assert.deepEqual(cal.vrefint, { raw: 1365, ns: seg.startNs, nominalMv: 1100 });
}));

test('a group starts logic and analog together and marks the trigger on both', opts, () => withBench(async ({ hst, lc }) => {
  const an = await c.AnalogCapture.open(hst);
  const grp = await c.CaptureGroup.open(hst);
  assert.equal(grp.fn, 12);
  await planApply(hst, [[lc.fn, 0, 20], [lc.fn, 1, 21], [an.fn, 0, 16]]);
  await lc.configure({ rate: 1_000_000, samples: 10_000, trigger: [c.EDGE, 1, 0], pretrigger: 4000 });
  await an.configure({ rate: 10_000, samples: 100 });
  await grp.subscribe();
  await grp.bind([lc, an], lc);
  await assert.rejects(an.start(), Rejected);                          // bound: the group starts it
  const { startNs } = await grp.start([lc, an]);
  assert.ok(lc.armedMs !== null && an.armedMs === lc.armedMs);
  assert.deepEqual([...grp.generations], [[lc.fn, 1], [an.fn, 1]]);       // the group's start names each track's generation
  assert.deepEqual([lc.generation, an.generation, grp.generation], [1, 1, 1]);   // the group's own generation (§4.1)
  const st = await grp.wait();
  assert.equal(st.generation, 1);
  assert.deepEqual([st.startNs, st.triggerFn], [startNs, lc.fn]);
  const [ls] = await lc.segments();
  const [as] = await an.segments();
  assert.deepEqual([ls.generation, as.generation], [1, 1]);
  assert.equal((await lc.readSegment(ls)).length, lc.cfg.bytes);
  assert.equal(ls.startNs - startNs, 0n);
  assert.equal(as.startNs - startNs, 5000n);                           // the analog starts 5 us later
  assert.equal(ls.triggerIndex, 4002);
  assert.equal(st.triggerNs, startNs + 4_002_000n);
  const expect = Math.round((Number(/** @type {bigint} */ (st.triggerNs) - as.startNs) * an.cfg.rate) / 1e9);
  assert.equal(as.triggerIndex, expect);
  assert.equal(expect, 37);
  const trig = await grp.nextEvent([c.GROUP_EVENT_TRIGGERED], 2000);
  assert.deepEqual([trig?.triggerFn, trig?.triggerNs, trig?.generation], [lc.fn, st.triggerNs, 1]);
  const stopped = await grp.nextEvent([c.GROUP_EVENT_STOPPED], 2000);
  assert.deepEqual([stopped?.reason, stopped?.generation], [c.STOPPED_REASON.complete, 1]);
  await grp.bind([]);
  await an.start();                                                    // unbound: its own again
}));

test('a group refuses what it cannot bind', opts, () => withBench(async ({ hst, lc }) => {
  const an = await c.AnalogCapture.open(hst);
  const grp = await c.CaptureGroup.open(hst);
  await planApply(hst, [[lc.fn, 0, 20], [an.fn, 0, 16], [an.fn, 1, 17]]);
  await lc.configure({ rate: 1_000_000, samples: 100 });
  await an.configure({ rate: 10_000, samples: 100, mode: c.REPEAT });
  await assert.rejects(grp.bind([lc, an]), Rejected);                  // the modes differ
  const stranger = /** @type {c.LogicCapture} */ (offline(hst, 3));
  await assert.rejects(grp.bind([lc, stranger]), (e) => e instanceof Unsupported && e.tag === null && e.fn === 3);   // not in tracks: 0x00 + TLV fn
  await an.configure({ rate: 41_666, samples: 100 });                  // 2 channels x 41.6 kHz = the ADC's budget
  await grp.bind([lc, an]);
  assert.ok(an.cfg.rate * 2 <= 83_333);
  await assert.rejects(lc.configure({ rate: 1_000_000, samples: 100 }), Rejected);   // bound
  await grp.bind([]);
  await lc.configure({ rate: 1_000_000, samples: 100, trigger: [c.EDGE, 0, 0] });
  await assert.rejects(grp.bind([lc, an], an), Rejected);              // only the trigger track may have a trigger
}));

test('what the probe cannot do is refused unsupported, naming the tag', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  for (const o of [{ frontends: { 0: 1 }, critical: [c.FRONTEND] }, { trigger: /** @type {[number, number, number]} */ ([c.CROSS_UP, 0, 100]) }]) {
    await assert.rejects(lc.configure({ rate: 1_000_000, samples: 64, ...o }), (e) => {
      assert.ok(e instanceof Unsupported);
      assert.equal(e.tag, (o.frontends ? c.FRONTEND : c.TRIGGER) | c.CRITICAL);
      return true;
    });
  }
  assert.equal(lc.config, null);
}));

test('configure: a value the probe does not handle is unsupported with the tag as received, bit 7 set or not (core §2.3, capture §3.3)', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  for (const critical of [false, true]) {
    const body = concat(m.tlv(c.MODE, [c.ONE_SHOT], true), m.tlv(c.RATE, u32(1), critical), m.tlv(c.SAMPLES, u32(100)));   // a rate under rate_range
    for (const op of [c.LogicCapture.CONFIGURE, c.LogicCapture.QUERY_OP]) {
      await assert.rejects(hst.request(lc.fn, op, body, { locked: op === c.LogicCapture.CONFIGURE }),
        (e) => e instanceof Unsupported && e.result.payload[0] === (c.RATE | (critical ? c.CRITICAL : 0)));
    }
  }
  const r = await hst.request(lc.fn, c.LogicCapture.CONFIGURE, concat(m.tlv(c.MODE, [c.ONE_SHOT]), m.tlv(c.RATE, u32(1_000_000)),
    m.tlv(c.SAMPLES, u32(100)), m.tlv(0x7e, [1])));                                                // an unknown non-critical TLV: skipped silently
  const tags = new Set(m.splitTlvs(r.payload).map(([t]) => t));
  assert.ok(tags.has(c.ACTUAL_RATE) && ![0x54, 0x5a, 0x7f].some((t) => tags.has(t)));   // no timing, rate_accuracy, ignored
}));

test('describe: mode is mode max_samples max_segments; no background, budgets or ring (capture §2, §4)', opts, () => withBench(async ({ hst, lc }) => {
  const an = await c.AnalogCapture.open(hst);
  const grp = await c.CaptureGroup.open(hst);
  for (const fn of [lc.fn, an.fn]) {
    const d = await describe(hst, fn);
    const modes = d.filter(([t]) => (t & 0x7f) === 0x40).map(([, v]) => v);
    assert.ok(modes.length && modes.every((v) => v.length === 9));
    assert.ok(!d.some(([t]) => [0x42, 0x43, 0x47, 0x48, 0x49].includes(t & 0x7f)));
  }
  assert.deepEqual((await describe(hst, grp.fn)).map(([t]) => t & 0x7f).filter((t) => t >= 0x40), [0x40]);   // tracks only
}));

test('events of an earlier start are passed over (capture §3.4)', opts, () => withBench(async ({ hst, lc }) => {
  await planApply(hst, [[lc.fn, 0, 20]]);
  await lc.configure({ rate: 1_000_000, samples: 64 });
  await lc.subscribe();
  await lc.start();                                                    // generation 1: segment, stopped
  await lc.start();                                                    // generation 2: its events after 1's
  const seg = await lc.nextEvent(null, 2000);
  assert.deepEqual([seg?.kind, seg?.generation, lc.staleEvents], [c.EVENT_SEGMENT, 2, 2]);
  const stopped = await lc.nextEvent(null, 2000);
  assert.deepEqual([stopped?.kind, stopped?.reason, stopped?.generation], [c.EVENT_STOPPED, c.STOPPED_REASON.complete, 2]);
}));

test('the configure contract is kept before sending (capture §3.3)', async () => {
  const sent = [];
  const lc = new c.LogicCapture(/** @type {any} */ ({ call: () => { sent.push(1); throw new Error('sent'); } }), 7, c.LogicCapture.NAME);
  for (const [o, words] of /** @type {[any, RegExp][]} */ ([
    [{}, /samples is required/], [{ mode: c.REPEAT }, /samples is required/], [{ mode: c.STREAMING, samples: 10 }, /no samples/],
    [{ samples: 10, segments: 2 }, /repeat only/], [{ samples: 10, pretrigger: 5 }, /needs a trigger/],
    [{ samples: 10, trigger: [c.IMMEDIATE, 0, 0], pretrigger: 5 }, /needs a trigger/]])) {
    await assert.rejects(lc.configure({ rate: 1_000_000, ...o }), (e) => e instanceof RangeError && words.test(e.message));
  }
  assert.equal(sent.length, 0);
  assert.deepEqual([c.nextGeneration(0), c.nextGeneration(0xffffffff), c.nextGeneration(41)], [1, 1, 42]);
});

test('the group start answer\'s fixed part, the group\'s generation in status (capture §4.1)', opts, () => withBench(async ({ hst, lc }) => {
  const an = await c.AnalogCapture.open(hst);
  const grp = await c.CaptureGroup.open(hst);
  await planApply(hst, [[lc.fn, 0, 20], [an.fn, 0, 16]]);
  await lc.configure({ rate: 1_000_000, samples: 100 });
  await an.configure({ rate: 10_000, samples: 100 });
  await grp.bind([an, lc]);                                            // bind order: analog first
  await grp.start([lc, an]);
  await grp.start([lc, an]);
  assert.deepEqual([grp.generation, [...grp.generations]], [2, [[an.fn, 2], [lc.fn, 2]]]);
  assert.equal((await grp.status()).generation, 2);
}));
