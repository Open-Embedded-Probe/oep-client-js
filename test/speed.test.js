// @ts-check
// port_speed (oep-core §3.5, src/speed.js) against oep-client-python's fake probe (esp32-v003 has it; --broken-rate
// models the line, by the probe's rate alone over TCP), and the link's fall back to the boot speed on a scripted
// transport (where the probe's rate and the host's can differ). Mirrors oep-client-python's tests/test_port_speed.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as m from '../src/message.js';
import { Rejected, Timeout } from '../src/errors.js';
import { Link, SWITCH_SETTLE_MS, IDLE_MAX_MS, KEEPALIVE_MS, OPEN_RETRY_MS } from '../src/link.js';
import { getU32 } from '../src/bytes.js';
import { Host } from '../src/host.js';
import { connect } from '../src/open.js';
import * as cobs from '../src/cobs.js';
import { raiseSpeed, speedText } from '../src/speed.js';
import { RiscvDm, Wire } from '../src/riscv.js';
import { take } from '../src/core.js';
import { openTcp, tcpTransport } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const FAST = { verifyBytes: 2048, verifySeconds: 0.3, verifyMs: 900, duplexSeconds: 0.2, duplexFrames: 16 };

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body @param {object} [opts] */
async function withSpeedFake(args, body, opts = {}) {
  const fake = await startFake(['--profile', 'esp32-v003', ...args], 'cobs');
  const hst = await openTcp({ port: fake.port, framing: 'cobs', baudRate: 115200, timeoutMs: 1000, ...opts });
  try {
    if (hst.session === null) await take(hst, 10000);
    await body(hst);
  } finally {
    await hst.link.close();
    fake.stop();
  }
}

test('commit at a good rate, with the report; the end takes the link back', { skip: !haveFake }, () => withSpeedFake([], async (hst) => {
  const report = await raiseSpeed(hst, [1500000], FAST);
  assert.equal(report.supported, true);
  assert.equal(report.base, 115200);
  assert.equal(report.chosen, 1500000);
  assert.equal(report.rate, 1500000);
  const [t] = report.trials;
  assert.equal(t.committed, true);
  assert.equal(t.actual, 1500000);
  assert.equal(t.brokenIn + t.brokenOut, 0);
  assert.ok(t.inBytes > 0 && t.outBytes > 0 && (t.inKBs ?? 0) > 0 && (t.outKBs ?? 0) > 0);
  assert.equal(report.inKBs, t.inKBs);
  assert.equal(hst.link.speed, report);
  assert.equal(hst.link.baud, 1500000);
  await hst.keepalive();
  assert.equal(t.inflight, 4);                       // the fake's max_inflight: pipelined passed, no cap
  assert.equal(hst.link.inflightCap, 0);
  assert.match(speedText(report), /committed \(in flight 4\)/);
  await hst.end();
  assert.equal(hst.link.baud, 115200);
  assert.equal(report.rate, 115200);
  assert.equal(report.chosen, null);
}));

test('a broken rate reverts, an unmakeable one is skipped, the next is committed', { skip: !haveFake },
  () => withSpeedFake(['--broken-rate', '230400:40', '--broken-rate', '1000000:in'], async (hst) => {
    const report = await raiseSpeed(hst, [230400, 1000000, 9000000, 500000], FAST);
    const [a, b, c, d] = report.trials;
    assert.equal(a.committed, false);
    assert.equal(a.why, 'frames broke');
    assert.ok(a.brokenIn > 0);
    assert.equal(b.committed, false);
    assert.equal(b.why, 'no confirm at the new rate');   // its answers to the confirm never arrive
    assert.match(c.why, /^unsupported/);
    assert.equal(d.committed, true);
    assert.equal(report.chosen, 500000);
    assert.equal(hst.link.baud, 500000);
    await hst.keepalive();
  }));

test('an off probe is not supported and stays at the boot speed', { skip: !haveFake }, () => withSpeedFake(['--no-port-speed'], async (hst) => {
  let report = await raiseSpeed(hst, [1500000], FAST);
  assert.equal(report.supported, false);
  assert.match(report.why, /does not declare/);
  assert.equal(hst.link.baud, 115200);
  // declared (the describe cache says so) but the op unknown: unknown_operation
  hst.describes.set(0, [...(hst.describes.get(0) ?? []), [0x4e, Uint8Array.of(1)]]);
  report = await raiseSpeed(hst, [1500000], FAST);
  assert.equal(report.supported, false);
  assert.match(report.why, /unknown_operation/);
  assert.equal(report.trials.length, 0);
  assert.match(speedText(report), /not supported/);
  await assert.rejects(hst.call(m.CORE_FN, m.OP.port_speed, new Uint8Array(12)),
    (e) => e instanceof Rejected && e.result.detail === m.REJECT.unknown_operation);
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
    assert.equal(report.chosen, 500000);
    assert.notEqual(hst.session, null);
    await hst.keepalive();
  }, { portSpeed: [230400, 500000], leaseMs: 10000 }));

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

test('WebSerial: a new rate closes and opens the same port, releases DTR / RTS, and reads again', async () => {
  const { webSerialTransport } = await import('../src/browser/webserial.js');
  /** @type {any[]} */
  const calls = [];
  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */ let feed = null;
  const port = {
    /** @type {ReadableStream<Uint8Array> | null} */ readable: null,
    /** @type {WritableStream<Uint8Array> | null} */ writable: null,
    /** @param {{ baudRate: number }} o */
    async open(o) {
      calls.push(['open', o.baudRate]);
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
  assert.deepEqual(calls, [['open', 115200], ['close'], ['open', 1500000],
    ['signals', { dataTerminalReady: false, requestToSend: false }], ['write', 2]]);
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

test('pipelined frames break, one at a time passes: committed in flight 1, the cap honoured until the boot speed', { skip: !haveFake }, async () => {
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine([], {
    garble: (line) => rateNow() !== 115200 && line.outstanding > 1,   // both ways busy at a raised rate: the reply breaks
  }, async (hst, line) => {
    rateNow = () => hst.link.baud;
    const report = await raiseSpeed(hst, [1500000], FAST);
    const [t] = report.trials;
    assert.equal(t.committed, true);
    assert.equal(t.inflight, 1);
    assert.equal(t.brokenIn + t.brokenOut, 0);          // the one-at-a-time verify's count
    assert.ok(line.garbled > 0);                        // the pipelined one broke
    assert.equal(hst.link.inflightCap, 1);
    assert.match(speedText(report), /committed \(in flight 1\)/);
    line.peak = 0;
    const results = await hst.pipeline(Array.from({ length: 8 }, () => [m.CORE_FN, m.OP.link_source, Uint8Array.of(32, 0, 0, 0)]), { locked: false });
    assert.equal(results.length, 8);
    assert.ok(results.every((r) => r.succeeded && r.payload.length === 32));
    assert.equal(line.peak, 1);                         // one request at a time
    await hst.end();
    assert.equal(hst.link.baud, 115200);
    assert.equal(hst.link.inflightCap, 0);
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
      if (req.op === m.OP.port_speed && req.payload[5] === 1) idles.push(getU32(req.payload, 8));   // step commit
      return true;
    },
  }, async (hst) => {
    await raiseSpeed(hst, [750000], FAST);
    await raiseSpeed(hst, [500000], { ...FAST, idleMs: 0 });
    await raiseSpeed(hst, [500000], { ...FAST, idleMs: 600000 });
    await raiseSpeed(hst, [500000], { ...FAST, idleMs: 1500 });
  });
  assert.equal(IDLE_MAX_MS, 3000);
  assert.deepEqual(idles, [3000, 3000, 3000, 1500]);
});

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
  const t0 = performance.now();
  let dropped = 0;
  /** @type {import('../src/link.js').Transport} */
  const transport = {
    ...inner,
    kind: 'serial',
    async write(data) {
      if (performance.now() - t0 < deafMs) { dropped++; return; }
      await inner.write(data);
    },
  };
  return { fake, transport, t0, dropped: () => dropped };
}

test('connect on a serial port waits out a raised rate left over', { skip: !haveFake }, async () => {
  const { fake, transport, t0, dropped } = await deafSerial(2500);
  try {
    const hst = await connect(transport, { timeoutMs: 1000 });
    const took = performance.now() - t0;
    assert.ok(took >= 2400 && took < OPEN_RETRY_MS + 2000, `took ${took}`);
    assert.ok(dropped() >= 4);                                     // confirms every 0.5 s
    assert.ok(hst.limits);
    await hst.link.close();
  } finally {
    fake.stop();
  }
});

test('connect on a serial port gives up after about 4 s; other transports keep their timeout', { skip: !haveFake }, async () => {
  const { fake, transport, t0 } = await deafSerial(60000);
  try {
    await assert.rejects(connect(transport, { timeoutMs: 1000 }), (e) => e instanceof Timeout);
    const took = performance.now() - t0;
    assert.ok(took >= OPEN_RETRY_MS - 100 && took < OPEN_RETRY_MS + 3000, `took ${took}`);
  } finally {
    fake.stop();
  }
  const other = await deafSerial(60000);
  try {
    const t1 = performance.now();
    await assert.rejects(connect({ ...other.transport, kind: 'tcp' }, { timeoutMs: 300 }), (e) => e instanceof Timeout);
    assert.ok(performance.now() - t1 < 3000);                      // the confirm, its resend: no 4 s retry
  } finally {
    other.fake.stop();
  }
});

test('a rate that breaks only both ways at once fails the duplex phase', { skip: !haveFake }, async () => {
  /** @type {() => number | null} */ let rateNow = () => 115200;
  await withLine([], {
    // a link_source answer (probe -> host) arriving while a link_sink (host -> probe) is still out: both ways busy
    garble: (line) => rateNow() === 921600 && line.ops[0] === m.OP.link_source && line.ops.slice(1).includes(m.OP.link_sink),
  }, async (hst) => {
    rateNow = () => hst.link.baud;
    const report = await raiseSpeed(hst, [921600, 500000], FAST);
    const [a, b] = report.trials;
    assert.equal(a.committed, false);
    assert.equal(a.why, 'broke both ways at once');
    assert.ok(a.brokenDuplex > 0);
    assert.equal(a.brokenIn + a.brokenOut, 0);           // each way alone passed
    assert.ok((a.inKBs ?? 0) > 0 && (a.outKBs ?? 0) > 0);
    assert.equal(b.committed, true);
    assert.ok((b.duplexKBs ?? 0) > 0 && b.duplexBytes > 0);
    assert.equal(report.duplexKBs, b.duplexKBs);
    assert.equal(report.chosen, 500000);
    assert.match(speedText(report), /duplex KB\/s/);
    assert.match(speedText(report), /broke both ways at once/);
    await hst.keepalive();
  });
});

/** A link raised to 921600, then every `every`th frame from the probe broken while `line.breaking`.
 * @param {number} every @param {(hst: import('../src/host.js').Host, line: any) => Promise<void>} body */
async function raisedInUse(every, body) {
  /** @type {() => number | null} */ let rateNow = () => 115200;
  let n = 0;
  await withLine([], {
    garble: (line) => rateNow() === 921600 && line.breaking && ++n % every === 0,
  }, async (hst, line) => {
    rateNow = () => hst.link.baud;
    const report = await raiseSpeed(hst, [921600], FAST);
    assert.equal(report.chosen, 921600);
    line.breaking = true;
    await body(hst, line);
  });
}

test('in use: 3 broken frames within 5 s step down for the session, which goes on at base', { skip: !haveFake }, () => raisedInUse(4, async (hst) => {
  const session = hst.session;
  for (let i = 0; i < 16; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
  const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
  assert.equal(hst.link.baud, 115200);
  assert.equal(report.steppedDown, true);
  assert.match(report.downWhy, /3 broken frames/);
  assert.equal(report.chosen, null);
  assert.equal(report.rate, 115200);
  assert.match(speedText(report), /stepped down/);
  assert.equal(hst.session, session);
  await hst.keepalive();                                  // the lease held: the session goes on
  const again = await raiseSpeed(hst, [921600], FAST);
  assert.match(again.trials[0].why, /^stepped down/);
  assert.equal(again.chosen, null);
  assert.equal(hst.link.baud, 115200);
}));

test('in use: a single broken frame does not step down', { skip: !haveFake }, () => raisedInUse(4, async (hst, line) => {
  for (let i = 0; i < 4; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
  line.breaking = false;
  for (let i = 0; i < 10; i++) await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());
  const report = /** @type {import('../src/speed.js').SpeedReport} */ (hst.link.speed);
  assert.equal(hst.link.baud, 921600);
  assert.equal(report.steppedDown, false);
  assert.equal(line.garbled, 1);
  assert.equal(hst.link.strikes.length, 1);
}));

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
    await hst.keepalive();
    const again = await raiseSpeed(hst, [921600], FAST);
    assert.match(again.trials[0].why, /^stepped down/);
  }, 3000);
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
    assert.equal(hst.link.strikes.length, 0);
    sent.length = 0;
    await hst.request(m.CORE_FN, m.OP.lock_state, new Uint8Array());   // after 1.9 s of quiet: a keepalive first
    assert.equal(sent.length, 2);
    assert.ok(sent[0] < sent[1], `corrs ${sent}`);
  }, 3000);
});
