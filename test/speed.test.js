// @ts-check
// port_speed (oep-if-link §3 the handshake, host guide §17 the procedure; src/speed.js) against oep-client-python's fake
// probe (esp32-v003 has it; --broken-rate models the line, by the probe's rate alone over TCP), behind a line model
// of the host's side (withLine: frames garbled or dropped as the host would see them), and the link's fall back to
// the boot speed on a scripted transport. Mirrors oep-client-python's tests/test_port_speed.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { NotOepProbe, Rejected, Timeout, Unavailable, Unsupported } from '../src/errors.js';
import { Link, SWITCH_SETTLE_MS, IDLE_MAX_MS, KEEPALIVE_MS, OPEN_RETRY_MS, IN_USE_WINDOW_MS } from '../src/link.js';
import { getU16, getU32, u32 } from '../src/bytes.js';
import { Host } from '../src/host.js';
import { connect } from '../src/open.js';
import * as cobs from '../src/cobs.js';
import { DEFAULT_CANDIDATES, VERIFY_MS, raiseSpeed, resolveFlows, speedText } from '../src/speed.js';
import { SpeedRecord, fileStore, localStorageStore, memoryStore } from '../src/speedrecord.js';
import { RiscvDm, Wire } from '../src/riscv.js';
import { take } from '../src/core.js';
import { openTcp, tcpTransport } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const FAST = { verifyMs: 900 };   // the probe's try state ends soon: a failed candidate costs under a second
const UNIT = 'fafe00000003';      // the fake esp32-v003's unit_id
const NO_PROBATION = { probationBytes: 0, probationMs: 0 };   // the window alone (the probation has its own tests)
const LINK_FN = 10;               // the fake esp32-v003's oep.link (oep-if-link): port_speed and the link test are its ops
const PS = reg.LINK.op.port_speed, SOURCE = reg.LINK.op.source, SINK = reg.LINK.op.sink;

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body @param {object} [opts] */
async function withSpeedFake(args, body, opts = {}) {
  const fake = await startFake(['--profile', 'esp32-v003', ...args], 'cobs');
  const hst = await openTcp({ port: fake.port, framing: 'cobs', baudRate: 115200, timeoutMs: 1000, ...opts });
  hst.link.waitAddMs = 0;    // as withLine
  try {
    if (hst.session === null) await take(hst, 10000);
    await body(hst);
  } finally {
    await hst.link.close();
    fake.stop();
  }
}

test('the minimal form tries, confirms and commits without a measurement; the end takes the link back', { skip: !haveFake }, async () => {
  // host guide §17.2: one candidate, switch, 20 ms, a confirm, commit - no flows, no baseline
  /** @type {[number, number | null][]} */ const ops = [];
  await withLine([], {
    onWrite(msg) {
      const req = m.Request.unpack(msg);
      if (req.fn === m.CORE_FN) ops.push([req.op, null]);
      if (req.fn === LINK_FN && req.op === PS) ops.push([-PS, req.payload[5]]);
      return true;
    },
  }, async (hst) => {
    ops.length = 0;
    const report = await raiseSpeed(hst, [1500000], FAST);
    assert.equal(report.supported, true);
    assert.equal(report.base, 115200);
    assert.equal(report.chosen, 1500000);
    assert.equal(report.rate, 1500000);
    assert.equal(report.verified, false);
    assert.deepEqual(report.baseline, {});
    assert.deepEqual(report.baselineFlows, []);
    const [t] = report.trials;
    assert.equal(t.committed, true);
    assert.equal(t.actual, 1500000);
    assert.equal(t.switched, 1500000);
    assert.deepEqual(t.flows, []);
    assert.equal(t.nCap, 0);
    assert.equal(report.inKBs, null);
    assert.equal(t.inKBs, null);
    assert.deepEqual(ops.filter(([op]) => op !== m.OP.describe && op !== m.OP.list), [[-PS, 0], [m.OP.confirm, null], [-PS, 1]]);
    assert.equal(hst.link.speed, report);
    assert.equal(hst.link.baud, 1500000);
    assert.equal(hst.link.keepaliveMs, KEEPALIVE_MS);
    assert.equal(hst.link.inflightCap, 0);
    await hst.keepalive();
    const text = speedText(report);
    assert.match(text, /committed/);
    assert.match(text, /in force: 1500000 \(raised\)/);
    await hst.end();
    assert.equal(hst.link.baud, 115200);
    assert.equal(report.rate, 115200);
    assert.equal(report.chosen, null);
  });
});

test('the default candidate is 500000', { skip: !haveFake }, () => withSpeedFake([], async (hst) => {
  const report = await raiseSpeed(hst, undefined, FAST);
  assert.deepEqual([...DEFAULT_CANDIDATES], [500000]);
  assert.equal(report.chosen, 500000);
  assert.equal(hst.link.baud, 500000);
  await hst.keepalive();
}));

test('the minimal form falls back when the confirm does not come, skips an unmakeable rate, and goes on', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '1000000:in'], async (hst) => {   // probe -> host only: the probe sees nothing wrong
    const t0 = performance.now();
    const report = await raiseSpeed(hst, [1000000, 9000000, 500000], FAST);
    const [a, b, c] = report.trials;
    assert.equal(a.committed, false);
    assert.equal(a.why, 'no confirm at the new rate');   // its answers to the confirm never arrive
    assert.equal(a.actual, 1000000);
    assert.match(b.why, /^unsupported/);
    assert.equal(b.actual, null);
    assert.equal(c.committed, true);
    assert.equal(report.chosen, 500000);
    assert.equal(hst.link.baud, 500000);
    assert.ok(performance.now() - t0 < 3000);
    assert.match(speedText(report), /no confirm/);
    await hst.keepalive();
  }));

test('an off probe is not supported and stays at the boot speed', { skip: !haveFake }, () => withSpeedFake(['--no-port-speed'], async (hst) => {
  let report = await raiseSpeed(hst, [1500000], FAST);
  assert.equal(report.supported, false);
  assert.match(report.why, /does not offer port_speed/);
  assert.equal(hst.link.baud, 115200);
  // offered (the describe cache says so) but the op unknown: unknown_operation
  hst.describes.set(LINK_FN, [[reg.DESCRIBE_COMMON.ops, Uint8Array.of(1, 0b111)]]);
  report = await raiseSpeed(hst, [1500000], FAST);
  assert.equal(report.supported, false);
  assert.match(report.why, /unknown_operation/);
  assert.equal(report.trials.length, 0);
  assert.match(speedText(report), /not supported/);
  await assert.rejects(hst.call(LINK_FN, PS, new Uint8Array(12)),
    (e) => e instanceof Rejected && e.constructor === Rejected && e.result.detail === m.REJECT.unknown_operation);
  await hst.keepalive();
}));

test('a link that cannot change its rate is not supported', { skip: !haveFake }, async () => {
  const fake = await startFake(['--profile', 'esp32-v003'], 'cobs');
  const hst = await openTcp({ port: fake.port, framing: 'cobs' });
  try {
    await take(hst, 3000);
    const report = await raiseSpeed(hst, [1500000]);
    assert.equal(report.supported, false);
    assert.match(report.why, /serial port/);
  } finally {
    await hst.link.close();
    fake.stop();
  }
});

test('connect with portSpeed takes the lock and raises the speed', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '230400'], async (hst) => {
    const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
    assert.deepEqual(report.trials.map((t) => t.committed), [false, true]);
    assert.equal(report.trials[0].why, 'no confirm at the new rate');
    assert.equal(report.verified, false);
    assert.equal(report.chosen, 500000);
    assert.notEqual(hst.session, null);
    await hst.keepalive();
  }, { portSpeed: [230400, 500000], leaseMs: 10000 }));

test('connect with portSpeed true takes the default candidate', { skip: !haveFake }, () => withSpeedFake([], async (hst) => {
  const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
  assert.equal(report.chosen, 500000);
  await hst.keepalive();
}, { portSpeed: true, leaseMs: 10000 }));

test('a request unanswered at a raised rate goes back to the boot speed and once more', async () => {
  // a scripted probe that answers only while the host's rate is the probe's (115200 after its own revert)
  let probeRate = 115200;
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    framing: 'cobs', kind: 'serial', baudRate: 115200,
    async setBaudRate(rate) { transport.baudRate = rate; },
    async write(data) {
      if (transport.baudRate !== probeRate) return;   // garbage at the probe: no answer
      const { cobs } = await import('../src/index.js');
      const req = m.Request.unpack(cobs.unframe(data.subarray(1, data.length - 1)));
      const result = new m.Result(req.corr, m.COMPLETED, m.SUCCESS, new Uint8Array()).pack();
      setTimeout(() => deliver(cobs.frame(result)), 1);
    },
    start(onData) { deliver = onData; },
    async close() {},
  };
  const link = new Link(transport, { timeoutMs: 80 });
  await link.start();
  await link.setBaud(1500000);    // raised (probe and host both)
  probeRate = 1500000;
  const ok = await link.send(new m.Request(1, 0, m.OP.keepalive, new Uint8Array(), 7).pack());
  assert.equal(m.Result.unpack(ok).corr, 1);
  probeRate = 115200;             // the probe went back by itself (idle_ms)
  const reply = await link.send(new m.Request(2, 0, m.OP.keepalive, new Uint8Array(), 7).pack());
  assert.equal(m.Result.unpack(reply).corr, 2);
  assert.equal(link.baud, 115200);
  assert.equal(link.speedLost, 1);
});

test('WebSerial: opens 8N1 without flow control; a new rate closes and opens the same port, asserts DTR / RTS, and reads again', async () => {
  const { webSerialTransport } = await import('../src/browser/webserial.js');
  /** @type {any[]} */
  const calls = [];
  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */ let feed = null;
  /** @type {any[]} */ const opened = [];
  const port = {
    /** @type {ReadableStream<Uint8Array> | null} */ readable: null,
    /** @type {WritableStream<Uint8Array> | null} */ writable: null,
    /** @param {{ baudRate: number }} o */
    async open(o) {
      calls.push(['open', o.baudRate]);
      opened.push(o);
      this.readable = new ReadableStream({ start(c) { feed = c; } });
      this.writable = new WritableStream({ write(chunk) { calls.push(['write', chunk.length]); } });
    },
    async close() { calls.push(['close']); this.readable = null; this.writable = null; },
    /** @param {any} s */
    async setSignals(s) { calls.push(['signals', s]); },
  };
  const t = await webSerialTransport(port, { baudRate: 115200 });
  /** @type {number[]} */ const got = [];
  let closedWith = 'open';
  t.start((c) => got.push(...c), (e) => { closedWith = e ? 'error' : 'closed'; });
  /** @type {any} */ (feed).enqueue(Uint8Array.of(1));
  await new Promise((r) => setTimeout(r, 5));
  await /** @type {(r: number) => Promise<void>} */ (t.setBaudRate)(1500000);
  assert.equal(t.baudRate, 1500000);
  /** @type {any} */ (feed).enqueue(Uint8Array.of(2));
  await t.write(Uint8Array.of(9, 9));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, [1, 2]);
  assert.equal(closedWith, 'open');               // the reopen is not the transport closing
  const asserted = ['signals', { dataTerminalReady: true, requestToSend: true }];   // transports §4, C-09
  assert.deepEqual(calls, [['open', 115200], asserted, ['close'], ['open', 1500000], asserted, ['write', 2]]);
  for (const o of opened) assert.deepEqual({ ...o, baudRate: 0, bufferSize: 0 }, { baudRate: 0, bufferSize: 0, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  await t.close();
});

/**
 * The fake probe over TCP behind a line model of the host's side: `onWrite(message, line)` may drop a request (return
 * false); `garble(line)` breaks the next frame from the probe. line: the host's rate, the requests outstanding (written
 * less frames received), when the rate last changed, and the most outstanding at once since `line.peak` was reset.
 * @param {string[]} args
 * `line.ops`: the ops of the requests outstanding, oldest first (garble sees the one its frame answers at ops[0]).
 * @param {{ onWrite?: (msg: Uint8Array, line: any) => boolean, garble?: (line: any) => boolean }} model
 * @param {(hst: import('../src/host.js').Host, line: any) => Promise<void>} body
 * @param {number} [leaseMs]
 */
async function withLine(args, model, body, leaseMs = 10000) {
  const fake = await startFake(['--profile', 'esp32-v003', ...args], 'cobs');
  const inner = await tcpTransport({ port: fake.port, framing: 'cobs', baudRate: 115200 });
  const line = { outstanding: 0, peak: 0, switchedAt: 0, garbled: 0, dropped: /** @type {Uint8Array[]} */ ([]), gaps: /** @type {number[]} */ ([]),
    ops: /** @type {number[]} */ ([]) };
  let rx = new Uint8Array(0);
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    framing: 'cobs', kind: 'tcp',
    get baudRate() { return inner.baudRate; },
    async setBaudRate(rate) {
      await /** @type {(r: number) => Promise<void>} */ (inner.setBaudRate)(rate);
      line.switchedAt = performance.now();
      line.outstanding = 0;   // what was on the line is gone
      line.ops = [];
    },
    async write(data) {
      const msg = cobs.unframe(data.subarray(1, data.length - 1));
      if (line.switchedAt) { line.gaps.push(performance.now() - line.switchedAt); line.switchedAt = 0; }
      if (model.onWrite && !model.onWrite(msg, line)) { line.dropped.push(msg); return; }
      line.outstanding++;
      line.ops.push(m.Request.unpack(msg).op);
      line.peak = Math.max(line.peak, line.outstanding);
      await inner.write(data);
    },
    start(onData, onClose) {
      return inner.start((chunk) => {
        const joined = new Uint8Array(rx.length + chunk.length);
        joined.set(rx);
        joined.set(chunk, rx.length);
        rx = joined;
        for (let end = rx.indexOf(0); end >= 0; end = rx.indexOf(0)) {
          const cand = rx.slice(0, end);
          rx = rx.slice(end + 1);
          if (!cand.length) continue;
          if (model.garble?.(line)) { cand[1] = cand[1] === 1 ? 2 : 1; line.garbled++; }   // a byte changed: the CRC fails
          line.outstanding = Math.max(0, line.outstanding - 1);
          line.ops.shift();
          onData(Uint8Array.of(0, ...cand, 0));
        }
      }, onClose);
    },
    close: () => inner.close(),
  };
  const hst = await connect(transport, { timeoutMs: 1000 });
  hst.link.waitAddMs = 0;    // the fake answers at once: the floor's 1000 ms (core §4.4) would only slow the losses
  try {
    await take(hst, leaseMs);
    await body(hst, line);
  } finally {
    await hst.link.close();
    fake.stop();
  }
}

test('after the switch: settled before the first byte, a lost first frame found again with a confirm', { skip: !haveFake }, async () => {
  let dropNext = false;
  await withLine([], {
    onWrite() {
      if (dropNext) { dropNext = false; return false; }   // the switch-over costs the first frame
      return true;
    },
  }, async (hst, line) => {
    const raised = /** @type {(r: number) => Promise<void>} */ (hst.link.transport.setBaudRate);
    hst.link.transport.setBaudRate = async (rate) => { await raised(rate); dropNext = rate !== 115200; };
    const report = await raiseSpeed(hst, [1500000], FAST);
    const [t] = report.trials;
    assert.equal(t.committed, true);
    assert.equal(report.chosen, 1500000);
    assert.equal(line.dropped.length, 1);
    const lost = m.Request.unpack(line.dropped[0]);
    assert.equal(lost.op, m.OP.confirm);                // the first byte at the new rate was a confirm, sent again
    assert.ok(line.gaps.every((/** @type {number} */ g) => g >= SWITCH_SETTLE_MS - 2), `gaps ${line.gaps}`);
    await hst.keepalive();
  });
});

test('full form: pipelined frames break, one at a time passes: committed in flight 1, the cap honoured until the boot speed', { skip: !haveFake }, async () => {
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine([], {
    garble: (line) => rateNow() !== 115200 && line.outstanding > 1,   // both ways busy at a raised rate: the reply breaks
  }, async (hst, line) => {
    rateNow = () => hst.link.baud;
    const report = await raiseSpeed(hst, [1500000], { flows: [['in', 0]], verifyMs: 5000 });
    assert.equal(report.verified, true);
    const [t] = report.trials;
    assert.equal(t.committed, true);
    assert.deepEqual(t.flows.map((f) => f.name), ['in@4', 'in@1']);
    assert.deepEqual(t.flows.map((f) => f.passed), [false, true]);
    assert.ok(t.flows[0].broken + t.flows[0].lost >= 3);
    assert.equal(t.flows[1].broken + t.flows[1].lost, 0);   // the one-at-a-time run's count
    assert.ok(line.garbled > 0);                            // the pipelined one broke
    assert.equal(t.nCap, 1);
    assert.equal(hst.link.inflightCap, 1);
    assert.match(speedText(report), /committed \(in flight 1\)/);
    assert.deepEqual(report.baselineFlows.map((f) => f.name), ['in@4']);
    line.peak = 0;
    const results = await hst.pipeline(Array.from({ length: 8 }, () => [LINK_FN, SOURCE, Uint8Array.of(32, 0, 0, 0)]), { locked: false });
    assert.equal(results.length, 8);
    assert.ok(results.every((r) => r.succeeded && r.payload.length === 2 + 32));   // len(u16) data (oep-if-link §2)
    assert.equal(line.peak, 1);                             // one request at a time
    await hst.end();
    assert.equal(hst.link.baud, 115200);
    assert.equal(hst.link.inflightCap, 0);
  });
});

test('full form: every flow measured at the boot speed and at each candidate; a rate whose frames break fails', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '230400:40:in'], async (hst) => {   // the confirm passes, full answers break
    // host guide §17.3.2: a baseline per flow at the boot speed, then 16 frames per flow at each candidate; a flow fails
    // on broken + lost >= 3 over max(2 x baseline, 5 %), and one failed flow fails the candidate
    const report = await raiseSpeed(hst, [230400, 500000], { verify: true, verifyMs: 5000 });   // the try state outlasts the measurement
    assert.equal(report.verified, true);
    assert.deepEqual(Object.keys(report.baseline).sort(), ['duplex', 'in', 'out']);
    assert.ok(Object.values(report.baseline).every((v) => v === 0));
    assert.deepEqual(report.baselineFlows.map((f) => f.name), ['in@4', 'out@4', 'duplex@4']);   // measured: 60 frames each
    assert.ok(report.baselineFlows.every((f) => f.frames === 60));
    assert.equal(report.baselineFrames, 0);
    const [a, b] = report.trials;
    assert.equal(a.committed, false);
    assert.match(a.why, /^in@.* over 5%/);
    assert.deepEqual(a.flows.map((f) => f.name), ['in@4', 'in@1']);
    assert.ok(a.flows.every((f) => !f.passed));
    assert.ok(a.flows[0].broken + a.flows[0].lost >= 3 && a.flows[0].frames >= 16);
    assert.equal(b.committed, true);
    assert.deepEqual(b.flows.map((f) => f.name), ['in@4', 'out@4', 'duplex@4']);
    assert.ok(b.flows.every((f) => f.passed && f.frames >= 16 && f.broken === 0 && f.lost === 0 && f.kbS > 0));
    assert.equal(report.inKBs, b.inKBs);
    assert.ok((report.inKBs ?? 0) > 0 && (report.outKBs ?? 0) > 0 && (report.duplexKBs ?? 0) > 0);
    assert.equal(b.nCap, 0);
    assert.equal(report.chosen, 500000);
    assert.equal(hst.link.baud, 500000);
    assert.equal(hst.link.inflightCap, 0);
    const text = speedText(report);
    assert.match(text, /baseline at 115200 \(measured, 60 frames per flow\)/);
    assert.match(text, /failed/);
    assert.match(text, /committed/);
    await hst.keepalive();
  }));

test('full form: only the flows asked are verified; a flow that needs n = 1 caps the link there', { skip: !haveFake }, async () => {
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine([], {
    // a link_source answer (probe -> host) arriving while a link_sink (host -> probe) is still out: both ways busy
    garble: (line) => rateNow() === 921600 && line.ops[0] === SOURCE && line.ops.slice(1).includes(SINK),
  }, async (hst) => {
    rateNow = () => hst.link.baud;
    const report = await raiseSpeed(hst, [921600], { flows: [['in', 2], ['duplex', 0]], verifyMs: 5000 });
    assert.equal(report.verified, true);
    const [t] = report.trials;
    assert.equal(t.committed, true);
    assert.deepEqual(t.flows.map((f) => f.name), ['in@2', 'duplex@4', 'duplex@1']);
    assert.deepEqual(t.flows.map((f) => f.passed), [true, false, true]);
    assert.ok(t.flows[1].broken + t.flows[1].lost >= 3);
    assert.equal(t.nCap, 1);
    assert.equal(hst.link.inflightCap, 1);
    assert.equal(hst.link.inflightFor(/** @type {any} */ (hst.limits)), 1);
    assert.match(speedText(report), /committed \(in flight 1\)/);
    assert.deepEqual(report.baselineFlows.map((f) => f.name), ['in@2', 'duplex@4']);
    assert.deepEqual(resolveFlows(['out', ['in', 9]], 4), [['out', 4], ['in', 4]]);
    assert.throws(() => resolveFlows([/** @type {any} */ (['sideways', 1])], 4), RangeError);
    await hst.keepalive();
  });
});

test('the baseline comes from the session\'s frames when there are enough, or is given', { skip: !haveFake }, () => withSpeedFake([], async (hst) => {
  for (let i = 0; i < 70; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
  assert.ok(hst.link.baseCounts.good >= 70);
  assert.equal(hst.link.baseCounts.broken + hst.link.baseCounts.lost, 0);
  let report = await raiseSpeed(hst, [500000], { flows: [['duplex', 1]], ...FAST });
  assert.ok(report.baselineFrames >= 70);
  assert.deepEqual(report.baseline, { duplex: 0 });
  assert.deepEqual(report.baselineFlows, []);
  assert.equal(report.chosen, 500000);
  assert.match(speedText(report), /frames of this session/);
  await hst.end();
  await take(hst, 10000);                                       // a new session: its own count
  assert.ok(hst.link.baseCounts.good <= 2);
  report = await raiseSpeed(hst, [500000], { flows: [['in', 1]], baseline: 0.02, ...FAST });   // given: nothing measured
  assert.deepEqual(report.baseline, { in: 0.02 });
  assert.deepEqual(report.baselineFlows, []);
  assert.equal(report.baselineFrames, 0);
  assert.equal(hst.link.baselineRatio, 0.02);
  await hst.keepalive();
}));

test('a boot speed that loses too much is not raised', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '115200:40:in:every4'], async (hst) => {   // 25 % of full answers
    const report = await raiseSpeed(hst, [500000], { flows: [['in', 2]], ...FAST });
    assert.equal(report.supported, true);
    assert.deepEqual(report.trials, []);
    assert.match(report.why, /not raised/);
    assert.match(report.why, /in@1/);
    assert.deepEqual(report.baselineFlows.map((f) => f.name), ['in@2', 'in@1']);   // over 10 %: once more at n = 1
    assert.ok(report.baselineFlows.every((f) => f.ratio > 0.1));
    assert.equal(hst.link.baud, 115200);
  }));

test('a broken frame towards the probe reverts it and the flow is lost', { skip: !haveFake }, async () => {
  // the fake breaks requests of 40 bytes and more at 230400 (the probe then goes back: condition 2); the line model adds
  // what TCP cannot show - a host whose rate is not the probe's is not heard
  /** @type {() => number | null} */ let rateNow = () => 115200;
  let probeRate = 115200;
  await withLine(['--broken-rate', '230400:40:out'], {
    onWrite(msg) {
      if (rateNow() !== probeRate) return false;                        // garbage at the probe: no answer
      const req = m.Request.unpack(msg);
      if (req.fn === LINK_FN && req.op === PS) {
        if (req.payload[5] === 0) probeRate = getU32(req.payload, 1);   // try: the probe switches once its answer is out
        else if (req.payload[5] === 2) probeRate = 115200;              // revert
      } else if (rateNow() === 230400 && msg.length >= 32) probeRate = 115200;   // broken at the probe: it goes back
      return true;
    },
  }, async (hst) => {
    rateNow = () => hst.link.baud;
    const t0 = performance.now();
    const report = await raiseSpeed(hst, [230400, 500000], { flows: ['out'], ...FAST });
    const [a, b] = report.trials;
    assert.equal(a.committed, false);
    assert.ok(a.flows[0].lost > 0);
    assert.equal(a.flows[0].gone, true);
    assert.equal(a.why, 'out@4: no answer at 230400 any more (the probe went back)');
    assert.equal(b.committed, true);
    assert.equal(hst.link.baud, 500000);
    assert.ok(performance.now() - t0 < 6000);
    await hst.keepalive();
  });
});

/**
 * A scripted serial probe: the first answer to corr `brokenCorr` comes out broken (its CRC wrong), every other is
 * answered at once. Each write is logged with its time.
 * @param {number} brokenCorr
 */
function brokenOnce(brokenCorr) {
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  /** @type {{ corr: number, at: number }[]} */ const writes = [];
  let broke = false;
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    framing: 'cobs', kind: 'serial',
    async write(data) {
      const req = m.Request.unpack(cobs.unframe(data.subarray(1, data.length - 1)));
      writes.push({ corr: req.corr, at: performance.now() });
      const out = cobs.frame(new m.Result(req.corr, m.COMPLETED, m.SUCCESS, Uint8Array.of(1, 2, 3)).pack());
      if (req.corr === brokenCorr && !broke) { broke = true; out[2] = out[2] === 1 ? 2 : 1; }
      setTimeout(() => deliver(out), 1);
    },
    start(onData) { deliver = onData; },
    async close() {},
  };
  return { transport, writes };
}

test('a broken frame on a port a session holds: the request goes again at once, the same corr', async () => {
  const { transport, writes } = brokenOnce(5);
  const link = new Link(transport, { timeoutMs: 2000 });
  await link.start();
  const hst = new Host(link);
  assert.equal(link.held(), false);
  hst.session = 7;                                       // a session holds the port (its raw transfer stopped)
  assert.equal(link.held(), true);
  const t0 = performance.now();
  const reply = await link.send(new m.Request(5, 0, m.OP.keepalive, new Uint8Array(), 7).pack());
  assert.equal(m.Result.unpack(reply).corr, 5);
  assert.ok(performance.now() - t0 < 500, 'resent before the timeout');
  assert.deepEqual(writes.map((w) => w.corr), [5, 5]);
  assert.equal(link.stats.retries, 1);
  assert.equal(link.stats.corrupt, 1);
  assert.ok(link.stats.noise > 0);
});

test('a broken frame with no session is noise: skipped, the request resent only after its timeout', async () => {
  const { transport, writes } = brokenOnce(5);
  const link = new Link(transport, { timeoutMs: 300 });
  await link.start();
  new Host(link);                                        // no session open
  const t0 = performance.now();
  const reply = await link.send(new m.Request(5, 0, m.OP.keepalive, new Uint8Array()).pack());
  assert.equal(m.Result.unpack(reply).corr, 5);
  assert.ok(performance.now() - t0 >= 290, 'waited out the timeout');
  assert.deepEqual(writes.map((w) => w.corr), [5, 5]);
  assert.equal(link.stats.corrupt, 0);
  assert.ok(link.stats.noise > 0);
});

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('raiseSpeed commits the idle maximum by default, and for 0', { skip: !haveFake }, async () => {
  /** @type {number[]} */ const idles = [];
  await withLine([], {
    onWrite(msg) {
      const req = m.Request.unpack(msg);
      if (req.fn === LINK_FN && req.op === PS && req.payload[5] === 1) idles.push(getU32(req.payload, 8));   // step commit
      return true;
    },
  }, async (hst) => {
    // a try while committed is rejected (oep-if-link §3: a step that does not fit the port's state): one raise per session
    for (const opts of [FAST, { ...FAST, idleMs: 0 }, { ...FAST, idleMs: 600000 }, { ...FAST, idleMs: 1500 }]) {
      const report = await raiseSpeed(hst, [750000], opts);
      assert.equal(report.chosen, 750000);
      await hst.end();
      await take(hst, 10000);
    }
  });
  assert.equal(IDLE_MAX_MS, 3000);
  assert.deepEqual(idles, [3000, 3000, 3000, 1500]);
});

test('the keepalive interval stays under half of idle_ms; verify_ms stays a second under the lease', { skip: !haveFake }, async () => {
  /** @type {number[]} */ const verifies = [];
  const model = {
    /** @param {Uint8Array} msg */
    onWrite(msg) {
      const req = m.Request.unpack(msg);
      if (req.fn === LINK_FN && req.op === PS && req.payload[5] === 0) verifies.push(getU16(req.payload, 6));   // step try
      return true;
    },
  };
  await withLine([], model, async (hst) => {
    await raiseSpeed(hst, [750000], { idleMs: 200 });
    assert.equal(hst.link.keepaliveMs, 80);                       // under half of idle_ms (oep-if-link §3 obligation 4)
    await hst.end();
    await take(hst, 10000);
    await raiseSpeed(hst, [750000]);
    assert.equal(hst.link.keepaliveMs, KEEPALIVE_MS);
  });
  assert.deepEqual(verifies, [VERIFY_MS, VERIFY_MS]);           // a 10 s lease: the default 2000
  verifies.length = 0;
  await withLine([], model, async (hst) => { await raiseSpeed(hst, [750000]); }, 2400);
  assert.deepEqual(verifies, [1400]);
});

// ---- the fake probe's port_speed handshake (oep-if-link §3), driven straight from the link -----------------------------

/** The port_speed request body: port(u8) baud(u32) step(u8) verify_ms(u16) idle_ms(u32).
 * @param {number} port @param {number} baud @param {number} step @param {number} [verifyMs] @param {number} [idleMs] */
function ps(port, baud, step, verifyMs = 5000, idleMs = 0) {
  const out = new Uint8Array(12);
  const v = new DataView(out.buffer);
  v.setUint8(0, port); v.setUint32(1, baud, true); v.setUint8(5, step); v.setUint16(6, verifyMs, true); v.setUint32(8, idleMs, true);
  return out;
}
const TRY = 0, COMMIT = 1, REVERT = 2;
/** @param {import('../src/host.js').Host} hst @param {Uint8Array} body */
const portSpeed = (hst, body) => {
  hst.link.speedFn = LINK_FN;   // what raiseSpeed records once it finds oep.link: a completed revert there moves the link back
  return hst.call(LINK_FN, PS, body);
};
/** @param {unknown} e */
const wrongState = (e) => e instanceof Unavailable && e.cause === 'wrong_state';
/** @param {unknown} e */
const malformed = (e) => e instanceof Rejected && e.result.detail === m.REJECT.malformed;
/** A broken candidate at the probe: bytes between 0x00s that do not decode (oep-if-link §3 "broken"). The link's own
 * write is bypassed so nothing is resent. @param {import('../src/host.js').Host} hst */
const noise = (hst) => hst.link.transport.write(Uint8Array.of(0, 0x11, 0x22, 0x33, 0));

test('fake: a step that does not fit the port state is unavailable cause 6; a step above 2 is unsupported, verify_ms 0 in a try malformed', { skip: !haveFake },
  () => withSpeedFake([], async (hst) => {
    await assert.rejects(portSpeed(hst, ps(0, 500000, COMMIT)), wrongState);             // commit at the boot speed
    await assert.rejects(portSpeed(hst, ps(0, 500000, REVERT)), wrongState);             // revert at the boot speed
    await assert.rejects(portSpeed(hst, ps(0, 500000, 3)), (e) => e instanceof Unsupported && e.tag === null);   // a later revision's step (core §2.5)
    await assert.rejects(portSpeed(hst, ps(0, 500000, 0xff)), Unsupported);
    await assert.rejects(portSpeed(hst, ps(0, 500000, TRY, 0)), malformed);             // verify_ms 0 in a try (C-32)
    const tried = await portSpeed(hst, ps(0, 1500000, TRY));
    assert.equal(getU32(tried.payload), 1500000);
    await hst.link.setBaud(1500000);
    await assert.rejects(portSpeed(hst, ps(0, 1500000, TRY)), wrongState);               // a try while trying
    await assert.rejects(portSpeed(hst, ps(0, 1000000, COMMIT)), wrongState);            // another baud
    const committed = await portSpeed(hst, ps(0, 1500000, COMMIT));
    assert.equal(getU32(committed.payload), 1500000);
    await assert.rejects(portSpeed(hst, ps(0, 1500000, COMMIT)), wrongState);            // committed already
    await assert.rejects(portSpeed(hst, ps(0, 921600, TRY)), wrongState);                // a try while committed
    const reverted = await portSpeed(hst, ps(0, 1500000, REVERT));
    assert.equal(getU32(reverted.payload), 115200);
    assert.equal(hst.link.baud, 115200);                                                 // obligation 6: the link followed
    await assert.rejects(portSpeed(hst, ps(0, 1500000, REVERT)), wrongState);            // back already: nothing to revert
    await hst.keepalive();
  }));

test('fake: self-revert 2 counts a broken candidate only after the first good frame; 4 is 3 in a row, no time window', { skip: !haveFake },
  () => withSpeedFake([], async (hst) => {
    // trying: the switch-over's leftovers (before any good frame at the new speed) do not count
    await portSpeed(hst, ps(0, 230400, TRY));
    await hst.link.setBaud(230400);
    await noise(hst);
    await noise(hst);
    await portSpeed(hst, ps(0, 230400, COMMIT));                                         // still trying: the commit fits
    // committed: broken candidates in a row revert at 3; a good frame between restarts the run
    await noise(hst);
    await noise(hst);
    await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array(), { locked: false });   // a good frame
    await noise(hst);
    await noise(hst);
    const reverted = await portSpeed(hst, ps(0, 230400, REVERT));                        // still committed
    assert.equal(getU32(reverted.payload), 115200);
    assert.equal(hst.link.baud, 115200);
    // trying: one broken candidate after the first good frame at the new speed reverts
    await portSpeed(hst, ps(0, 230400, TRY));
    await hst.link.setBaud(230400);
    await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array(), { locked: false });   // the first good frame
    await noise(hst);
    await assert.rejects(portSpeed(hst, ps(0, 230400, COMMIT)), wrongState);             // reverted: at the boot speed
    await hst.link.setBaud(115200);
    // committed: 3 in a row revert however far apart they are (no window)
    await portSpeed(hst, ps(0, 230400, TRY));
    await hst.link.setBaud(230400);
    await portSpeed(hst, ps(0, 230400, COMMIT, 5000, 3000));
    await noise(hst);
    await sleep(1100);
    await noise(hst);
    await noise(hst);
    await assert.rejects(portSpeed(hst, ps(0, 230400, REVERT)), wrongState);             // back already
    await hst.link.setBaud(115200);
    await hst.keepalive();
  }));

test('a raised link keeps the line alive when quiet', { skip: !haveFake }, async () => {
  let keepalives = 0;
  await withLine([], {
    onWrite(msg) { if (m.Request.unpack(msg).op === m.OP.keepalive) keepalives++; return true; },
  }, async (hst) => {
    await raiseSpeed(hst, [750000], FAST);
    assert.equal(await hst.link.keepAlive(), false);              // just spoke: nothing to do
    for (let i = 0; i < 3; i++) {                                  // 3.6 s in all, past the probe's idle limit
      await sleep(KEEPALIVE_MS + 200);
      assert.equal(await hst.link.keepAlive(), true);
    }
    assert.equal(keepalives, 3);
    await sleep(KEEPALIVE_MS + 200);
    await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array(), { locked: false });   // a keepalive first
    assert.equal(keepalives, 4);
    assert.equal(hst.link.baud, 750000);
    assert.equal(hst.link.speedLost, 0);
    await hst.end();
    await sleep(KEEPALIVE_MS + 200);
    assert.equal(await hst.link.keepAlive(), false);              // back at the boot speed: none
  });
});

/**
 * The fake probe over TCP seen as a serial port this host opened, deaf (writes dropped) until `deafMs` has passed:
 * the rate a host that died left, going back by itself.
 * @param {number} deafMs
 */
async function deafSerial(deafMs) {
  const fake = await startFake(['--profile', 'esp32-v003'], 'cobs');
  const inner = await tcpTransport({ port: fake.port, framing: 'cobs', baudRate: 115200 });
  // deaf from the host's first write on: on a loaded machine the time to it varies, and the confirms counted are the
  // ones the host made while the probe was deaf
  /** @type {number | null} */ let t0 = null;
  let dropped = 0;
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    ...inner,
    kind: 'serial',
    async write(data) {
      t0 ??= performance.now();
      if (performance.now() - t0 < deafMs) { dropped++; return; }
      await inner.write(data);
    },
  };
  return { fake, transport, t0: () => /** @type {number} */ (t0), dropped: () => dropped };
}

test('connect on a serial port waits out a raised rate left over', { skip: !haveFake }, async () => {
  const { fake, transport, t0, dropped } = await deafSerial(2500);
  try {
    const hst = await connect(transport, { timeoutMs: 1000 });
    const took = performance.now() - t0();
    assert.ok(took >= 2400 && took < OPEN_RETRY_MS + 2000, `took ${took}`);
    assert.ok(dropped() >= 4);                                     // confirms every 0.5 s
    assert.ok(hst.limits);
    await hst.link.close();
  } finally {
    fake.stop();
  }
});

test('connect on a serial port gives up after about 4 s; other transports keep their timeout', { skip: !haveFake }, async () => {
  // either way the probing rule (transports §3) closes the transport: NotOepProbe, its cause the Timeout
  const { fake, transport, t0 } = await deafSerial(60000);
  try {
    await assert.rejects(connect(transport, { timeoutMs: 1000 }), (e) => e instanceof NotOepProbe && /** @type {any} */ (e).cause instanceof Timeout);
    const took = performance.now() - t0();
    assert.ok(took >= OPEN_RETRY_MS - 100 && took < OPEN_RETRY_MS + 3000, `took ${took}`);
  } finally {
    fake.stop();
  }
  const other = await deafSerial(60000);
  try {
    const t1 = performance.now();
    await assert.rejects(connect({ ...other.transport, kind: 'tcp' }, { timeoutMs: 300 }), (e) => e instanceof NotOepProbe && /** @type {any} */ (e).cause instanceof Timeout);
    assert.ok(performance.now() - t1 < 3000);                      // the confirm, its resend: no 4 s retry
  } finally {
    other.fake.stop();
  }
});

/** A link raised to 921600, then every `every`th frame from the probe broken while `line.breaking` (`line.every`
 * changes it). @param {number} every @param {(hst: import('../src/host.js').Host, line: any) => Promise<void>} body
 * @param {object} [opts] raiseSpeed options */
async function raisedInUse(every, body, opts = {}) {
  /** @type {() => number | null} */ let rateNow = () => 115200;
  let n = 0;
  await withLine([], {
    garble: (line) => rateNow() === 921600 && line.breaking && ++n % line.every === 0,
  }, async (hst, line) => {
    rateNow = () => hst.link.baud;
    line.every = every;
    const report = await raiseSpeed(hst, [921600], { ...FAST, ...NO_PROBATION, ...opts });
    assert.equal(report.chosen, 921600);
    line.breaking = true;
    await body(hst, line);
  });
}

test('in use: the 3 s window over 10 % steps down for the session, which goes on at base', { skip: !haveFake }, () => raisedInUse(4, async (hst) => {
  // host guide §17.3.2 item 4: the last 3 s judged once 50 frames are in them; over max(2 x baseline, 10 %) broken or
  // lost -> revert, the boot speed, never raised again in this session
  const session = hst.session;
  for (let i = 0; i < 60; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());   // every one answered (a resend at once)
  const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
  assert.equal(hst.link.baud, 115200);
  assert.equal(report.steppedDown, true);
  assert.match(report.downWhy, /frames broken or lost within 3 s/);
  assert.equal(report.chosen, null);
  const [s] = report.stepDowns;
  assert.equal(report.stepDowns.length, 1);
  assert.equal(s.rate, 921600);
  assert.ok(s.ratio !== null && s.ratio > 0.10);
  assert.equal(s.why, report.downWhy);
  assert.equal(report.rate, 115200);
  assert.match(speedText(report), /stepped down from 921600/);
  assert.equal(hst.session, session);
  await hst.keepalive();                                  // the lease held: the session goes on
  const again = await raiseSpeed(hst, [921600], FAST);
  assert.match(again.trials[0].why, /^broke in use earlier/);
  assert.equal(again.chosen, null);
  assert.equal(hst.link.baud, 115200);
}));

test('in use: no judgement under 50 frames or under the floor', { skip: !haveFake }, () => raisedInUse(2, async (hst, line) => {
  for (let i = 0; i < 12; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());   // 12 and their resends: under 50 frames
  const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
  assert.equal(hst.link.baud, 921600);
  assert.equal(report.steppedDown, false);
  assert.ok(hst.link.stats.retries >= 6);
  assert.ok(hst.link.window.length < 50);
  assert.ok(hst.link.window.filter(([, bad]) => bad).length / hst.link.window.length > 0.10);   // over the floor, yet not judged
  hst.link.window = [];
  line.every = 20;
  for (let i = 0; i < 100; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());   // about 5 %: under the floor
  assert.equal(hst.link.baud, 921600);
  assert.equal(report.steppedDown, false);
  assert.ok(hst.link.window.length >= 100);
  assert.ok(hst.link.window.every(([t]) => t - hst.link.window[0][0] <= IN_USE_WINDOW_MS));
}));

test('in use: the threshold doubles a measured baseline', { skip: !haveFake }, () => raisedInUse(8, async (hst, line) => {
  assert.equal(hst.link.baselineRatio, 0.08);                                                       // threshold 16 %
  for (let i = 0; i < 80; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());   // 1 in 9 frames: 11 %
  const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
  assert.equal(hst.link.baud, 921600);
  assert.equal(report.steppedDown, false);
  line.every = 3;                                                                                   // 25 %
  for (let i = 0; i < 80; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
  assert.equal(hst.link.baud, 115200);
  assert.equal(report.steppedDown, true);
  assert.match(report.downWhy, /over 16%/);
}, { flows: [['in', 1]], baseline: 0.08 }));

test('in use: no answer at a raised rate falls back well inside the lease and the request goes on', { skip: !haveFake }, async () => {
  let deaf = false;
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine([], {
    onWrite: () => !(deaf && rateNow() === 921600),      // the probe went back by itself: nothing it hears at 921600
  }, async (hst) => {
    rateNow = () => hst.link.baud;
    const report = await raiseSpeed(hst, [921600], FAST);
    assert.equal(report.chosen, 921600);
    hst.link.timeoutMs = 3000;                            // the default: two waits of it would pass a 3 s lease
    deaf = true;
    const t0 = performance.now();
    const r = await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
    const took = performance.now() - t0;
    assert.ok(r.succeeded);
    assert.ok(took < 2200, `took ${took}`);
    assert.equal(hst.link.baud, 115200);
    assert.equal(report.lost, true);
    assert.equal(report.steppedDown, true);
    assert.match(report.downWhy, /no answer/);
    assert.equal(report.stepDowns[0].ratio, null);
    await hst.keepalive();
    const again = await raiseSpeed(hst, [921600], FAST);
    assert.match(again.trials[0].why, /^broke in use earlier/);
  }, 3000);
});

test('in use: no answer at the raised rate and no confirm at the boot speed is a link error, never the raised rate again', { skip: !haveFake }, async () => {
  let deaf = false;
  await withLine([], {
    onWrite: () => !deaf,                                 // the probe hears nothing more at any rate
  }, async (hst) => {
    const report = await raiseSpeed(hst, [921600], FAST);
    assert.equal(report.chosen, 921600);
    hst.link.timeoutMs = 300;
    deaf = true;
    const t0 = performance.now();
    await assert.rejects(hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array()),
      (e) => e instanceof Error && /neither at 921600 nor at the boot speed 115200/.test(e.message));
    const took = performance.now() - t0;
    assert.ok(took > OPEN_RETRY_MS - 500 && took < OPEN_RETRY_MS + 2500, `took ${took}`);   // idle max + 1 s of confirms
    assert.equal(hst.link.baud, 115200);                 // never back to the raised rate
    deaf = false;
  });
});

test('a long run at a raised rate waits its timeoutMs, no step down; the keepalive goes before its corr', { skip: !haveFake }, async () => {
  /** @type {number[]} */ const sent = [];
  await withLine([], {
    onWrite(msg) { sent.push(m.Request.unpack(msg).corr); return true; },
  }, async (hst) => {
    const report = await raiseSpeed(hst, [921600], FAST);
    assert.equal(report.chosen, 921600);
    hst.link.timeoutMs = 3000;                            // an ordinary request waits 750 ms (lease / 4)
    const wire = await Wire.open(hst, { name: 'oep.wire.swio' });
    const { conn } = await wire.attach({ halt: true });
    const dm = await RiscvDm.on(hst, conn);
    const write = hst.link.transport.write.bind(hst.link.transport);
    hst.link.transport.write = async (data) => {          // the run takes 1.9 s on the probe: its answer comes then
      const req = m.Request.unpack(cobs.unframe(data.subarray(1, data.length - 1)));
      if (req.op === RiscvDm.RUN && req.fn === dm.fn) setTimeout(() => write(data), 1900);
      else await write(data);
    };
    const t0 = performance.now();
    const r = await dm.run(0x20000000, [], { timeoutMs: 2000 });
    const took = performance.now() - t0;
    assert.ok(r.status === 0 && took > 1800 && took < 3000, `took ${took}`);
    assert.equal(hst.link.baud, 921600);
    assert.equal(report.steppedDown, false);
    assert.equal(hst.link.stats.retries, 0);
    assert.ok(hst.link.window.every(([, bad]) => !bad));
    sent.length = 0;
    await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());   // after 1.9 s of quiet: a keepalive first
    assert.equal(sent.length, 2);
    assert.ok(sent[0] < sent[1], `corrs ${sent}`);
  }, 3000);
});

test('the keepalive measures quiet on a monotonic clock: the wall clock stepping back does not hold it', async () => {
  // a time sync can step the wall clock back by seconds: a link timing quiet with Date.now() then sees no quiet for
  // that long, and the probe's idle_ms passes with no keepalive
  /** @type {import('../src/link.js').Transport} */
  const transport = { framing: 'cobs', kind: 'serial', baudRate: 115200, async setBaudRate(rate) { transport.baudRate = rate; },
    async write() {}, start() {}, async close() {} };
  const link = new Link(transport);
  await link.setBaud(921600);
  link.held = () => true;
  link.keepaliveFrame = () => Uint8Array.of(1);
  let sent = 0;
  link.send = async () => { sent++; return /** @type {any} */ (null); };
  await link.write(Uint8Array.of(0));
  const realNow = Date.now;
  Date.now = () => realNow() - 5000;
  try {
    await sleep(KEEPALIVE_MS + 50);
    assert.equal(await link.keepAlive(), true);
    assert.equal(sent, 1);
  } finally {
    Date.now = realNow;
  }
});

test('setBaud switches to the requested rate, and to the answer only when the platform refuses', async () => {
  /** @type {number[]} */ const set = [];
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    framing: 'cobs', kind: 'serial', baudRate: 115200,
    async setBaudRate(rate) { if (rate === 1500000) throw new Error('Not a valid baudrate: 1500000'); set.push(rate); transport.baudRate = rate; },
    async write() {}, start() {}, async close() {},
  };
  const link = new Link(transport);
  assert.equal(await link.setBaud(921600, 922190), 921600);
  assert.equal(link.baud, 921600);
  assert.equal(await link.setBaud(1500000, 1499250), 1499250);   // the platform refused: the answer
  assert.equal(link.baud, 1499250);
  await assert.rejects(link.setBaud(1500000), /Not a valid baudrate/);   // no fallback given
  await assert.rejects(link.setBaud(1500000, 1500000), /Not a valid baudrate/);
  assert.deepEqual(set, [921600, 1499250]);
});

// ---- the record (host guide §17.4) ---------------------------------------------------------------------------------

test('the record puts passed rates first, skips failed ones, notes a step down, and expires', { skip: !haveFake }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oep-speed-')), 'link-speed.json');
  const rec = new SpeedRecord(await fileStore(path));
  /** @type {() => number | null} */ let rateNow = () => 115200;
  let n = 0, breaking = false;
  await withLine(['--broken-rate', '230400:in'], {                       // no confirm there
    garble: (line) => rateNow() === 500000 && breaking && ++n % 3 === 0,
  }, async (hst) => {
    rateNow = () => hst.link.baud;
    let report = await raiseSpeed(hst, [230400, 500000], { record: rec, ...FAST });
    assert.equal(report.chosen, 500000);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(rec.lookup('<stream>', UNIT), { passed: [500000], failed: [230400] });
    assert.deepEqual(hst.link.recordKey, ['<stream>', UNIT]);
    let saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved[`<stream>|${UNIT}`].rates['500000'].passed, true);
    assert.equal(saved[`<stream>|${UNIT}`].rates['230400'].passed, false);
    assert.equal(saved[`<stream>|${UNIT}`].port, '<stream>');
    await hst.end();
    await take(hst, 10000);
    report = await raiseSpeed(hst, [921600, 230400, 500000], { record: path, ...FAST });   // a path: the same file
    assert.deepEqual(report.skipped, [230400]);
    assert.deepEqual(report.trials.map((t) => t.rate), [500000]);     // passed first, failed out
    assert.equal(report.chosen, 500000);
    assert.match(speedText(report), /skipped \(the record says failed\): 230400/);
    breaking = true;                                                   // in use it breaks: the step down is noted
    for (let i = 0; i < 60; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
    assert.equal(report.steppedDown, true);
    assert.deepEqual(new SpeedRecord(await fileStore(path)).lookup('<stream>', UNIT), { passed: [], failed: [500000, 230400] });
    saved = JSON.parse(readFileSync(path, 'utf8'));
    saved[`<stream>|${UNIT}`].rates['230400'].at = '2026-08-01T00:00:00+00:00';   // older than 30 days
    writeFileSync(path, JSON.stringify(saved));
    const rec2 = new SpeedRecord(await fileStore(path));
    assert.deepEqual(rec2.lookup('<stream>', UNIT), { passed: [], failed: [500000] });
    assert.equal(rec2.save(), true);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /230400/);
    assert.deepEqual(new SpeedRecord(await fileStore(path)).lookup('/dev/other', UNIT), { passed: [], failed: [] });   // another port: nothing known
  });
});

test('the record is a cache: an unreadable or unwritable store is not an error; localStorage keys by unit_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oep-speed-'));
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  let rec = new SpeedRecord(await fileStore(broken));
  assert.ok(rec.error);
  assert.deepEqual(rec.lookup('p', 'u'), { passed: [], failed: [] });
  rec.note('p', 'u', 500000, true);
  assert.deepEqual(new SpeedRecord(await fileStore(broken)).lookup('p', 'u'), { passed: [500000], failed: [] });
  const unwritable = new SpeedRecord({ name: 'nope', load: () => null, save: () => { throw new Error('read-only'); } });
  assert.equal(unwritable.note('p', 'u', 1, true), false);
  assert.match(/** @type {string} */ (unwritable.error), /nope: read-only/);
  // a browser: localStorage, the key the unit_id alone (WebSerial names no port)
  /** @type {Map<string, string>} */ const items = new Map();
  const storage = { getItem: (/** @type {string} */ k) => items.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { items.set(k, v); } };
  rec = new SpeedRecord(localStorageStore(storage));
  rec.note(null, UNIT, 921600, true);
  rec.note(null, UNIT, 1500000, false);
  assert.deepEqual(new SpeedRecord(localStorageStore(storage)).lookup(null, UNIT), { passed: [921600], failed: [1500000] });
  assert.deepEqual(Object.keys(JSON.parse(/** @type {string} */ (items.get('oep-client.link-speed')))), [UNIT]);
  // time moves: the expiry
  let now = Date.parse('2026-10-02T00:00:00Z');
  rec = new SpeedRecord(memoryStore(), { now: () => now });
  rec.note('p', 'u', 500000, true);
  now += 31 * 86400_000;
  assert.deepEqual(rec.lookup('p', 'u'), { passed: [], failed: [] });
  rec.note('p', 'u', 921600, false);
  assert.deepEqual(Object.keys(rec.data['p|u'].rates), ['921600']);
});

// ---- step downs, the probation, maxTries (host guide §17.3.2 item 4) ----------------------------------------------------

/** In-use traffic: oep.link source answers of `size` bytes until `until()` (at most `limitMs`).
 * @param {import('../src/host.js').Host} hst @param {() => boolean} until */
async function move(hst, until, size = 40, limitMs = 3000) {
  const deadline = performance.now() + limitMs;
  while (!until() && performance.now() < deadline) await hst.request(LINK_FN, SOURCE, u32(size));
}

/** @param {import('../src/host.js').Host} hst */
const report = (hst) => /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);

test('in use: a breakdown steps down to the next lower candidate, never at or above a failed one', { skip: !haveFake }, async () => {
  /** @type {Set<number>} */ const breaking = new Set();
  let n = 0;
  await withLine(['--broken-rate', '1500000:in'], {                     // no confirm at 1500000
    garble: () => breaking.has(/** @type {number} */ (link?.baud)) && ++n % 3 === 0,
  }, async (hst) => {
    link = hst.link;
    const r = await raiseSpeed(hst, [1500000, 921600, 500000, 230400], { ...FAST, ...NO_PROBATION });
    assert.equal(r.chosen, 921600);
    assert.deepEqual([...hst.link.failed.keys()], [1500000]);
    breaking.add(921600);
    for (let i = 0; i < 60; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
    assert.equal(r.stepDowns.length, 1);
    const [s] = r.stepDowns;
    assert.equal(s.rate, 921600);
    assert.equal(s.to, 500000);
    assert.equal(s.probation, false);
    assert.match(s.why, /within 3 s/);
    assert.equal(hst.link.baud, 500000);
    assert.equal(r.chosen, 500000);
    assert.deepEqual(r.trials.filter((t) => t.committed).map((t) => t.rate), [921600, 500000]);
    assert.match(speedText(r), /-> 500000/);
    assert.match(speedText(r), /in force: 500000 \(raised\)/);
    breaking.add(500000);
    for (let i = 0; i < 60; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
    assert.deepEqual(r.stepDowns.map((x) => [x.rate, x.to]), [[921600, 500000], [500000, 230400]]);
    assert.equal(hst.link.baud, 230400);
    const again = await raiseSpeed(hst, [921600, 750000, 230400], { ...FAST, ...NO_PROBATION });   // later in the session: no up
    assert.match(again.trials[0].why, /^broke in use earlier/);
    assert.match(again.trials[1].why, /^above 500000/);
    await hst.keepalive();
  });
});
/** @type {import('../src/link.js').Link | null} */ let link = null;

test('in use: no step down to a rate above one that failed its verify', { skip: !haveFake }, async () => {
  let breaking = false, n = 0;
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine(['--broken-rate', '230400:in'], { garble: () => breaking && rateNow() === 921600 && ++n % 3 === 0 }, async (hst) => {
    rateNow = () => hst.link.baud;
    hst.link.timeoutMs = 3000;   // a loaded machine must not turn 230400's failed confirm into an unanswered try
    const r = await raiseSpeed(hst, [230400, 921600, 500000], { ...FAST, ...NO_PROBATION });
    assert.ok(hst.link.failed.has(230400), JSON.stringify(r.trials.map((t) => t.why)));   // the line failed it
    assert.equal(r.chosen, 921600);
    breaking = true;
    for (let i = 0; i < 60; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
    assert.equal(r.stepDowns[0].to, 115200);            // 500000 is above 230400, which failed
    assert.equal(hst.link.baud, 115200);
    assert.deepEqual(r.trials.map((t) => t.rate), [230400, 921600]);
    assert.match(speedText(r), /the boot speed for the rest of the session/);
  });
});

test('the probation fails a rate that passes the quick verify and breaks later; the next lower one passes it', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '921600:40:in:after3000'], async (hst) => {
    const rec = new SpeedRecord(memoryStore());
    const r = await raiseSpeed(hst, [921600, 500000], { flows: [['in', 1]], record: rec, probationBytes: 4096, probationMs: 300, ...FAST });
    const [t] = r.trials;
    assert.equal(t.committed, true);
    assert.ok(t.flows.every((f) => f.passed));
    assert.equal(t.probation, 'running');
    await move(hst, () => hst.link.baud !== 921600);
    assert.equal(r.stepDowns.length, 1);
    const [s] = r.stepDowns;
    assert.equal(s.rate, 921600);
    assert.equal(s.probation, true);
    assert.equal(s.to, 500000);
    assert.match(s.why, /^in probation/);
    assert.equal(t.probation, 'failed');
    assert.ok(t.probationBytes > 0 && t.probationBytes < 4096);
    const t2 = r.trials[r.trials.length - 1];
    assert.equal(t2.rate, 500000);
    assert.equal(t2.committed, true);
    assert.equal(t2.settling, true);
    await move(hst, () => t2.probation !== 'running');
    assert.equal(t2.probation, 'passed');
    assert.ok(t2.probationBytes >= 4096);
    assert.equal(hst.link.probation, null);
    assert.deepEqual(Object.fromEntries(rec.results('<stream>', UNIT)), { 921600: 'failed', 500000: 'passed' });
    const rates = rec.data[`<stream>|${UNIT}`].rates;
    assert.equal(rates['921600'].phase, 'probation');
    assert.equal(rates['500000'].phase, 'probation');
    assert.match(speedText(r), /probation passed/);
    assert.match(speedText(r), /\(in probation\)/);
  }));

test('a failure soon after a breakdown at another rate is noted unknown', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '921600:40:in', '--broken-rate', '500000:40:in'], async (hst) => {
    const rec = new SpeedRecord(memoryStore());
    let r = await raiseSpeed(hst, [921600, 500000], { flows: [['in', 1]], record: rec, ...FAST });
    const [a, b] = r.trials;
    assert.equal(a.settling, false);
    assert.equal(b.settling, true);
    assert.equal(r.chosen, null);
    assert.deepEqual(Object.fromEntries(rec.results('<stream>', UNIT)), { 921600: 'failed', 500000: 'unknown' });
    assert.deepEqual(rec.lookup('<stream>', UNIT), { passed: [], failed: [921600] });   // an unknown is in neither list
    assert.deepEqual(rec.data[`<stream>|${UNIT}`].rates['500000'], { ...rec.data[`<stream>|${UNIT}`].rates['500000'], result: 'unknown', passed: null, phase: 'verify' });
    assert.match(speedText(r), /unknown/);
    await hst.end();
    await take(hst, 10000);
    r = await raiseSpeed(hst, [921600, 500000], { flows: [['in', 1]], record: rec, settleMs: 0, ...FAST });
    assert.deepEqual(r.trials.map((t) => t.rate), [500000]);
    assert.deepEqual(r.skipped, [921600]);
    assert.equal(rec.results('<stream>', UNIT).get(500000), 'failed');
  }));

test('when the record marks every candidate failed the slowest is tried once; maxTries bounds the tries and the step downs', { skip: !haveFake }, async () => {
  const rec = new SpeedRecord(memoryStore());
  for (const rate of [1500000, 921600, 500000]) rec.note('<stream>', UNIT, rate, false, 'verify');
  await withSpeedFake([], async (hst) => {
    const r = await raiseSpeed(hst, [1500000, 921600, 500000], { record: rec, maxTries: 1, ...FAST });
    assert.equal(r.retried, 500000);
    assert.deepEqual(r.skipped, [1500000, 921600]);
    assert.equal(r.chosen, 500000);
    assert.deepEqual(r.trials.map((t) => t.rate), [500000]);
    assert.match(speedText(r), /500000 \(the slowest\) tried once/);
    assert.deepEqual(rec.lookup('<stream>', UNIT), { passed: [500000], failed: [1500000, 921600] });
  });
  let breaking = false, n = 0;
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine(['--broken-rate', '1500000:in'], { garble: () => breaking && rateNow() === 921600 && ++n % 3 === 0 }, async (hst) => {
    rateNow = () => hst.link.baud;
    const r = await raiseSpeed(hst, [1500000, 921600, 500000], { maxTries: 2, ...FAST, ...NO_PROBATION });
    assert.deepEqual(r.trials.map((t) => t.rate), [1500000, 921600]);
    assert.deepEqual(r.capped, [500000]);
    assert.equal(r.chosen, 921600);
    assert.deepEqual(hst.link.speedPlan?.rates, [1500000, 921600]);
    assert.match(speedText(r), /left out \(maxTries\): 500000/);
    breaking = true;
    for (let i = 0; i < 60; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
    assert.equal(r.stepDowns[0].to, 115200);            // 500000 is not in this call's tries
    assert.equal(hst.link.baud, 115200);
  });
});

test('the record keeps a failure a day and a pass 30 days; an unknown is neither; the older shape still reads', () => {
  let now = Date.parse('2026-10-02T00:00:00Z');
  const rec = new SpeedRecord(memoryStore(), { now: () => now });
  rec.note('p', 'u', 1500000, false, 'verify');
  rec.note('p', 'u', 921600, null, 'verify');
  rec.note('p', 'u', 500000, true, 'probation');
  rec.data['p|u'].rates['115201'] = { passed: false, at: '2026-10-02T20:00:00+00:00' };   // no result, no phase
  assert.deepEqual(rec.lookup('p', 'u'), { passed: [500000], failed: [1500000, 115201] });
  now += 25 * 3600_000;                                                                     // past a day
  assert.deepEqual(Object.fromEntries(rec.results('p', 'u')), { 500000: 'passed', 115201: 'failed' });
  now += 28 * 86400_000;                                                                    // 29 days and an hour
  assert.deepEqual(Object.fromEntries(rec.results('p', 'u')), { 500000: 'passed' });
  now += 2 * 86400_000;
  assert.deepEqual(rec.lookup('p', 'u'), { passed: [], failed: [] });
  const longer = new SpeedRecord(memoryStore(), { now: () => now, failTtlMs: 3 * 86400_000 });
  longer.note('p', 'u', 921600, false);
  now += 2 * 86400_000;
  assert.deepEqual(longer.lookup('p', 'u'), { passed: [], failed: [921600] });
});
