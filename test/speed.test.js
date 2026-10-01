// @ts-check
// port_speed (oep-core §3.5, src/speed.js) against oep-client-python's fake probe (esp32-v003 has it; --broken-rate
// models the line, by the probe's rate alone over TCP), and the link's fall back to the boot speed on a scripted
// transport (where the probe's rate and the host's can differ). Mirrors oep-client-python's tests/test_port_speed.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as m from '../src/message.js';
import { Rejected } from '../src/errors.js';
import { Link } from '../src/link.js';
import { raiseSpeed, speedText } from '../src/speed.js';
import { take } from '../src/core.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const FAST = { verifyBytes: 2048, verifySeconds: 0.3, verifyMs: 600 };

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
  assert.match(speedText(report), /committed/);
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
    assert.ok(b.brokenIn > 0 && !b.committed);
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
