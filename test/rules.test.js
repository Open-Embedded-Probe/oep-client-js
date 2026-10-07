// @ts-check
// The host side of oep-spec docs/v1-rule-change-proposal-2026-10-02.md (applied 09622ef..e9cd891): the wait's floor
// (C-06, P2-★4), the serial line (C-09), the revision in use (C-15), confirm's transport (C-05), x- unit_ids (C-24),
// TCP and the resync wait (C-07, transports §5), the line search (PC-1, PC-2, PC-5), text shown and sent (C-22, C-18),
// ignored's marker (C-04), what a probe must give (C-10), capture (P2-○8, P2-○9) and the new answer TLVs in the API.
// Mirrors oep-client-python's tests/test_host_rules_2026_10_02.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as cobs from '../src/cobs.js';
import * as m from '../src/message.js';
import * as config from '../src/config.js';
import * as dump from '../src/dump.js';
import * as capture from '../src/capture.js';
import { Writer, utf8 } from '../src/bytes.js';
import { Locked, Unsupported } from '../src/errors.js';
import { Host, ownerText } from '../src/host.js';
import { Link, RESYNC_WAIT_MS } from '../src/link.js';
import { connect } from '../src/open.js';
import { planApply, take } from '../src/core.js';
import { decodeDescription, packOps } from '../src/catalog.js';
import { Wire, RiscvDm, StepError, TargetError } from '../src/riscv.js';
import { I2cTarget } from '../src/fixture.js';
import { SpeedRecord, memoryStore } from '../src/speedrecord.js';
import { raiseSpeed, speedPort } from '../src/speed.js';
import { requireUnitName } from '../src/usbvendor.js';
import { SERIAL_LINE, assertLines } from '../src/node/serial.js';
import { openTcp } from '../src/node/index.js';
import { tcpTransport } from '../src/node/tcp.js';
import { usbTransport } from '../src/node/usb.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';
import { ScriptedHost, handlers, ok } from './scripted.js';
import { KNOWN } from '../src/interfaces.js';

const CONFIRM_V1 = Uint8Array.from([0x4f, 0x45, 0x50, 0x21, 1, 0, 0x00, 0x04, 0, 0, 1, 0, 4, 0x11, 0, 0, 0]);   // OEP! rev 1 ... boot_id
/** @param {Uint8Array} msg */
const frame = (msg) => Uint8Array.from([msg.length & 0xff, msg.length >> 8, ...msg]);
/** @param {number} corr @param {Uint8Array} [payload] */
const result = (corr, payload = new Uint8Array()) => new m.Result(corr, m.COMPLETED, m.SUCCESS, payload).pack();
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A length-prefixed transport whose writes are recorded and answered by `respond` (null: no answer); `inject`
 * delivers bytes as if the probe sent them.
 * @param {(req: m.Request) => Uint8Array[] | null} [respond] @param {Partial<import('../src/link.js').Transport>} [extra]
 */
function scripted(respond = (req) => [result(req.corr, req.op === m.OP.confirm ? CONFIRM_V1 : new Uint8Array())], extra = {}) {
  /** @type {m.Request[]} */ const sent = [];
  /** @type {number[]} */ const at = [];
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  const t = {
    respond,
    /** @type {'length'} */ framing: 'length', kind: 'vendor',
    /** @param {Uint8Array} data */
    async write(data) {
      for (let i = 0; i < data.length;) {
        const n = data[i] | (data[i + 1] << 8);
        const req = m.Request.unpack(data.slice(i + 2, i + 2 + n));
        sent.push(req);
        at.push(performance.now());
        const replies = t.respond(req);
        if (replies) setTimeout(() => { for (const r of replies) deliver(frame(r)); }, 1);
        i += 2 + n;
      }
    },
    /** @param {(c: Uint8Array) => void} onData */
    start(onData) { deliver = onData; },
    async close() {},
    /** @param {Uint8Array} bytes */
    inject(bytes) { deliver(bytes); },
    ...extra,
  };
  return { t, sent, at };
}

/** @param {string[]} args @param {(hst: Host) => Promise<void>} body @param {'length' | 'cobs'} [framing] */
async function withBench(args, body, framing = 'length') {
  const bench = await startVirtualBench(args, framing);
  const hst = await openTcp({ port: bench.port, framing });
  try { await body(hst); } finally {
    await hst.link.close();
    bench.stop();
  }
}

/** Every request's (role, fn, op, payload, expectMs) the host sends (wraps link.send). @param {Host} hst */
function recording(hst) {
  /** @type {{ role: number, session: number, fn: number, op: number, payload: Uint8Array, expectMs: number }[]} */ const log = [];
  const send = hst.link.send.bind(hst.link);
  hst.link.send = (msg, opts) => {
    const r = m.Request.unpack(msg);
    log.push({ role: msg[0], session: r.session, fn: r.fn, op: r.op, payload: r.payload, expectMs: opts?.expectMs ?? 0 });
    return send(msg, opts);
  };
  return log;
}

// ---- C-06: the wait's floor -------------------------------------------------------------------------------------

test('C-06: the floor is argument time + 1000 ms + the transfer time; the link\'s own waits keep theirs', () => {
  const t = { framing: /** @type {'cobs'} */ ('cobs'), kind: 'serial', baudRate: 115200, async setBaudRate() {}, async write() {}, start() {}, async close() {} };
  const link = new Link(t, { timeoutMs: 200 });
  link.probeMaxFrame = 1024;
  const req = new m.Request(1, 0, m.OP.keepalive).pack();
  const L = cobs.frame(req).length;                                // the request's frame on the wire
  const transfer = (L + 1024 * 3) * 10 / 115200 * 1000;            // (L + max_frame x (1 + 2)) x 10 / baud
  assert.ok(Math.abs(link.transferMs(req) - transfer) < 1e-9 && transfer > 260);
  assert.ok(Math.abs(link.waitMs(0, req) - (1000 + transfer)) < 1e-9);   // over the link's own 200 ms
  assert.ok(Math.abs(link.waitMs(2500, req) - (2500 + 1000 + transfer)) < 1e-9);   // run's timeout_ms, dmi's waits ...
  assert.equal(link.baseWaitMs(), 200);                             // the link's own short requests keep theirs
  const length = new Link(scripted().t, { timeoutMs: 300 });
  assert.equal(length.transferMs(req), 0);                          // no line speed on length frames
  assert.equal(length.waitMs(), 1000);
});

test('C-06: each outstanding request\'s wait starts again from the answer before it', async () => {
  const { t } = scripted(() => null);                               // answers injected below
  const link = new Link(t, { timeoutMs: 300 });
  await link.start();
  const first = link.sendOnce(new m.Request(1, 0, m.OP.lock_state).pack(), { timeoutMs: 400, resend: false });
  const second = link.sendOnce(new m.Request(2, 0, m.OP.lock_state).pack(), { timeoutMs: 400, resend: false });
  await sleep(250);
  t.inject(frame(result(2)));                                       // the answer before it: the first's wait starts again
  assert.equal(m.Result.unpack(await second).corr, 2);
  await sleep(300);                                                 // 550 ms after its write, 300 ms after that answer
  t.inject(frame(result(1)));
  assert.equal(m.Result.unpack(await first).corr, 1);
  assert.equal(link.stats.resyncs, 0);
  await link.close();
});

test('C-06: attach, scan and reset wait max_op_ms (debug §1, §4.3)', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const log = recording(hst);
  const w = await Wire.open(hst);
  const found = await w.scan();
  await w.attach({ pins: found[0].pins });
  const budgets = Object.fromEntries(log.filter((r) => r.fn === w.fn).map((r) => [r.op, r.expectMs]));
  assert.deepEqual(budgets, { [Wire.SCAN]: 10000, [Wire.ATTACH]: 10000 });   // the probe's max_op_ms (core §4.4)
  assert.equal(await w.attachMs([7, 20]), 10000);                  // the reset TLV's hold within it too
  assert.equal(await (await RiscvDm.on(hst, 1)).resetMs(), 10000);
  assert.equal(w.searchRetries, 0);
  await hst.end();
}));

// ---- C-09: the serial line ----------------------------------------------------------------------------------------

test('C-09: a node serial port opens 8N1 without flow control, DTR and RTS asserted after the open', async () => {
  assert.deepEqual({ ...SERIAL_LINE }, { dataBits: 8, parity: 'none', stopBits: 1, rtscts: false, xon: false, xoff: false, xany: false });
  /** @type {any[]} */ const set = [];
  await assertLines({ set: (/** @type {any} */ o, /** @type {() => void} */ cb) => { set.push(o); cb(); } });
  assert.deepEqual(set, [{ dtr: true, rts: true }]);
  await assertLines({ set() { throw new Error('a pty has no modem lines'); } });   // kept what the open gave
});

// ---- C-15 / C-05: confirm -----------------------------------------------------------------------------------------

test('C-15: every later confirm asks for the revision in use; the refusal says the range', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  assert.deepEqual(hst.confirmRange(), [1, 1]);
  assert.equal((await hst.confirm()).revision, 1);
  const log = recording(hst);
  hst.revision = 3;                                                 // as if a later probe had chosen revision 3
  assert.deepEqual([...hst.confirmBody()], [...m.CONFIRM_REQUEST, 3, 3]);
  await assert.rejects(hst.confirm(), (e) => e instanceof Unsupported && JSON.stringify(e.supported) === '[1,1]');
  assert.deepEqual([...log[0].payload.slice(4)], [3, 3]);
  hst.revision = 1;
}));

test('C-15: the link\'s own confirms use the revision in use', async () => {
  const { t, sent } = scripted();
  const link = new Link(t, { timeoutMs: 300, maxFrame: 1024 });
  await link.start();
  const hst = new Host(link);
  await hst.confirm();
  hst.revision = 2;
  await link.startResync();
  const last = sent[sent.length - 1];
  assert.equal(last.op, m.OP.confirm);
  assert.deepEqual([...last.payload], [...m.CONFIRM_REQUEST, 2, 2]);
  assert.equal(await link.confirmRaw(300), true);
  assert.deepEqual([...sent[sent.length - 1].payload], [...m.CONFIRM_REQUEST, 2, 2]);
});

test('C-05: the confirm names the transport this host came on', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const where = /** @type {number} */ ((await hst.confirmed()).transport);
  assert.equal(typeof where, 'number');
  const { transports } = await (await import('../src/core.js')).probeInfo(hst);
  assert.equal(transports.find((x) => x.index === where)?.kind, reg.CORE.enum.transport_kind.tcp);   // virtual_bench_serve's TCP listener
}));

/** A Host that knows a describe, oep.probe.link as fn 10 with `link` ops (null: no oep.probe.link) and a confirm answer, and sends
 * nothing. @param {[number, Uint8Array][]} core @param {number | null} transport @param {number[] | null} link */
function knowing(core, transport, link = [1, 2, 3]) {
  const hst = new Host(/** @type {any} */ ({ framing: 'cobs', async send() { throw new Error('nothing is sent'); } }));
  hst.describes.set(0, core);
  if (link) {
    hst.fns.set('oep.probe.link', 10);
    hst.describes.set(10, [[reg.DESCRIBE_COMMON.ops, packOps(link)]]);
  }
  hst.limits = { revision: 1, flags: 0, maxFrame: 1024, window: 4096, maxInflight: 4, bootId: 1, transport, tail: new m.Tail() };
  hst.revision = 1;
  return hst;
}

test('C-05: port_speed raises the transport this host came on; a relaying broker\'s 0xFF and a confirm without the TLV', async () => {
  const D = reg.CORE.tlv.describe, K = reg.CORE.enum.transport_kind;
  const bridges = /** @type {[number, Uint8Array][]} */ ([[D.transport, Uint8Array.of(0, K.uart_bridge, 0xff)], [D.transport, Uint8Array.of(1, K.uart_bridge, 0xff)],
    [D.transport, Uint8Array.of(2, K.vendor_bulk, 0)]]);
  assert.deepEqual(await speedPort(knowing(bridges, 1)), [10, 1, '']);   // oep.probe.link's fn, the second bridge, not the first
  assert.match((await speedPort(knowing(bridges, 2)))[2], /index 2\) is not a UART bridge/);
  assert.match((await speedPort(knowing(bridges, 0xff)))[2], /broker/);
  assert.match((await speedPort(knowing(bridges, null)))[2], /names no transport/);
  assert.match((await speedPort(knowing(bridges, 0, [1, 2])))[2], /does not offer port_speed/);   // its ops (oep-if-link §1)
});

// ---- C-24: an x- unit_id names no unit ------------------------------------------------------------------------------

test('C-24: the speed record keeps nothing under an x- unit_id', () => {
  const rec = new SpeedRecord(memoryStore());
  rec.note('/dev/ttyUSB0', 'x-esp32', 921600, true, 'verify');
  assert.deepEqual(rec.lookup('/dev/ttyUSB0', 'x-esp32'), { passed: [], failed: [] });
  assert.deepEqual(rec.data, {});
  assert.equal(rec.results('/dev/ttyUSB0', 'x-esp32').size, 0);
  rec.note('/dev/ttyUSB0', 'fafe00000003', 921600, true, 'verify');
  assert.deepEqual(rec.lookup('/dev/ttyUSB0', 'fafe00000003'), { passed: [921600], failed: [] });
});

test('C-24: raiseSpeed records nothing for an x- unit_id', { skip: !haveVirtualBench }, async () => {
  const bench = await startVirtualBench(['--profile', 'esp32-v003'], 'cobs');
  const hst = await openTcp({ port: bench.port, framing: 'cobs', baudRate: 115200, timeoutMs: 1000 });
  try {
    const D = reg.CORE.tlv.describe;
    const core = await (await import('../src/core.js')).describe(hst, 0);   // cached: the unit_id swapped for an x- one
    hst.describes.set(0, core.map(([tag, v]) => ((tag & 0x7f) === D.unit_id ? [tag, utf8('x-esp32')] : [tag, v])));
    await take(hst, 10000);
    const rec = new SpeedRecord(memoryStore());
    const report = await raiseSpeed(hst, [500000], { record: rec, verifyMs: 900 });
    assert.equal(report.chosen, 500000);
    assert.match(report.why, /names no unit/);
    assert.deepEqual(rec.data, {});
    assert.equal(hst.link.record, null);
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
});

test('C-24: no USB device is looked up by an x- unit_id', async () => {
  assert.throws(() => requireUnitName('x-esp32'), RangeError);
  assert.equal(requireUnitName('fafe00000035'), 'fafe00000035');
  await assert.rejects(usbTransport({ unitId: 'X-esp32' }), RangeError);   // before the usb package is even loaded
});

// ---- C-07 / transports §5: TCP and the resync wait ------------------------------------------------------------------------

/** A frame arriving in two parts `gapMs` apart on a scripted transport. @param {boolean} keepsBoundaries @param {number} gapMs */
async function paused(keepsBoundaries, gapMs) {
  const { t, sent } = scripted((req) => (req.op === m.OP.confirm ? [result(req.corr, CONFIRM_V1)] : null), keepsBoundaries ? { keepsBoundaries: true, kind: 'tcp' } : {});
  const link = new Link(t, { timeoutMs: 1500, maxFrame: 1024 });
  link.waitAddMs = 0;
  await link.start();
  const answer = link.sendOnce(new m.Request(7, 0, m.OP.lock_state).pack(), { timeoutMs: 1500 });
  const f = frame(result(7, Uint8Array.of(0, 0, 0, 0, 0)));
  await sleep(5);
  t.inject(f.slice(0, 3));
  await sleep(gapMs);
  t.inject(f.slice(3));
  return { link, answer, sent };
}

test('C-07: on TCP a pause inside a frame is read on; on vendor bulk it is a lost boundary', async () => {
  const tcp = await paused(true, 300);
  assert.equal(m.Result.unpack(await tcp.answer).corr, 7);
  assert.equal(tcp.link.stats.resyncs, 0);
  const bulk = await paused(false, 300);
  await bulk.answer.catch(() => {});
  await sleep(50);
  assert.ok(bulk.link.stats.resyncs >= 1);                         // the stall (probe_frame_gap_ms) lost the boundaries
  assert.ok(bulk.sent.some((r) => r.op === m.OP.confirm));
});

test('C-07: the TCP transport says it keeps its boundaries', { skip: !haveVirtualBench }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-bench']);
  const t = await tcpTransport({ port: bench.port });
  try { assert.equal(t.keepsBoundaries, true); } finally { await t.close(); bench.stop(); }
});

test('C-07: a resync waits 250 ms after the host\'s last write before its confirm', async () => {
  const { t, sent, at } = scripted();
  const link = new Link(t, { timeoutMs: 300, maxFrame: 1024 });
  await link.start();
  await link.write(link.framed(new m.Request(1, 0, m.OP.keepalive).pack()));
  const t0 = performance.now();
  await link.startResync();
  const i = sent.findIndex((r) => r.op === m.OP.confirm);
  assert.ok(at[i] - t0 >= RESYNC_WAIT_MS - 5, `${at[i] - t0} ms`);
  assert.equal(RESYNC_WAIT_MS, 250);
});

test('C-07: the first confirm on a length-prefixed port waits for 50 ms of quiet input', async () => {
  const { t, sent, at } = scripted();
  /** @type {number[]} */ const noise = [];
  const noisy = setInterval(() => { t.inject(Uint8Array.of(0x33)); noise.push(performance.now()); }, 10);   // left over bytes for 120 ms
  setTimeout(() => clearInterval(noisy), 120);
  const hst = await connect(t, { timeoutMs: 500 });
  assert.equal(hst.revision, 1);
  assert.equal(sent[0].op, m.OP.confirm);
  const last = Math.max(...noise.filter((n) => n <= at[0]));       // the input was quiet 50 ms before the confirm
  assert.ok(noise.length && at[0] - last >= 50 - 5, `${at[0] - last} ms after the last byte`);
});

// ---- PC-1 / PC-2 / PC-5: the line search and labels ---------------------------------------------------------------

test('PC-1: findLine takes the firmware labels as step (c); LINE_NAMES from the registry (PC-2)', async () => {
  const items = [new config.Slot({ slot: 0, wireFn: 1, pins: [16, 0xffff], name: 'v003' })];
  assert.equal(await config.findLine(items, 'v003', 'nrst', [[23, 'NRST']]), 23);
  assert.equal(await config.findLine([...items, new config.Label({ channel: 22, text: 'nrst' })], 'v003', 'nrst', [[23, 'NRST']]), 22);
  assert.equal(await config.findLine(items, 'v003', 'nrst', [[23, 'NRST'], [24, 'nrst']]), null);   // two at one step
  const two = [...items, new config.Slot({ slot: 1, wireFn: 1, pins: [4, 0xffff], name: 'b' })];
  assert.equal(await config.findLine(two, 'v003', 'nrst', [[23, 'NRST']]), null);   // two slots: (b) and (c) not searched
  assert.equal(await config.findLine(items, 'v003', 'nrst'), null);   // items without firmware labels: none
  assert.deepEqual([...config.LINE_NAMES], ['nrst', 'power_hi', 'power_lo']);
});

test('PC-1: findLine on a Host reads describe\'s labels', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  assert.equal(await config.findLine(hst, null, 'nrst'), 23);
}));

test('PC-5: a label the probe would refuse is not sent', () => {
  for (const text of ['', 'x'.repeat(33), 'a\tb', 'a\x7fb']) assert.throws(() => new config.Label({ channel: 1, text }).value(), RangeError, JSON.stringify(text));
  assert.equal(new config.Label({ channel: 1, text: 'x'.repeat(32) }).value().length, 34);
  assert.equal(new config.Label({ channel: 1, text: '日本語' }).value().length, 2 + 9);
});

// ---- C-22 / C-18: text, the owner and the session id ---------------------------------------------------------------

test('C-22: text from an answer is shown without control characters', () => {
  assert.equal(m.shown(Uint8Array.from([...utf8('ok\x1b[31mred\x7f'), 0xff])), 'ok�[31mred��');
  const payload = Uint8Array.from([...new Writer().u32(5).done(), ...m.tlv(0x01, utf8('evil\x1b]0;x\x07'))]);
  const e = new Locked(new m.Result(1, m.REJECTED, m.REJECT.locked, payload));
  assert.ok(!/[\x1b\x07]/.test(/** @type {string} */ (e.owner)));
  assert.equal(m.validText(utf8('ok')), true);
  assert.equal(m.validText(utf8('a\nb')), false);
  assert.equal(m.validText(Uint8Array.of(0xff)), false);
});

test('C-22: the owner goes as valid text of at most 32 bytes, cut on a character', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  assert.deepEqual([...ownerText('a\nb')], [...utf8('a?b')]);
  const raw = ownerText('日'.repeat(20));                           // 3 bytes each: cut on a character
  assert.equal(raw.length, 30);
  assert.equal(new TextDecoder().decode(raw), '日'.repeat(10));
  assert.throws(() => ownerText(''), RangeError);
  await hst.open(3000, { owner: '日'.repeat(20) });
  assert.equal((await hst.lockState()).owner, '日'.repeat(10));
  await hst.end();
}));

test('C-18: the session id is random and never 0', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const log = recording(hst);
  const ids = new Set();
  for (let i = 0; i < 10; i++) { await hst.open(3000, { force: true }); ids.add(hst.session); }
  assert.ok(!ids.has(0) && ids.size > 1);
  const opens = log.filter((r) => r.fn === m.CORE_FN && r.op === m.OP.open);
  assert.equal(opens.length, 10);
  assert.ok(opens.every((r) => r.role === m.ROLE_REQUEST));         // one request role (core §4.1)
  assert.deepEqual(new Set(opens.map((r) => r.session)), ids);      // the id in the header (§6.4)
  await hst.end();
}));

// ---- C-04 / C-10 ------------------------------------------------------------------------------------------------------

test('C-04 gone: an unknown non-critical TLV is ignored without a trace, an unknown critical one refused (core §2.3)', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const tail = (/** @type {number} */ n) => Uint8Array.from(Array.from({ length: n }, (_, k) => [...m.tlv(0x30 + k, [])]).flat());
  const r = await hst.call(m.CORE_FN, m.OP.keepalive, tail(20));
  assert.equal(r.payload.length, 0);                                // no ignored list (0x7F) any more
  await assert.rejects(hst.call(m.CORE_FN, m.OP.keepalive, m.tlv(0x30, [], true)), (e) => e instanceof Unsupported && e.tag === 0xb0);
  assert.equal(/** @type {any} */ (m).TAG_IGNORED, undefined);
  assert.equal(/** @type {any} */ (new m.Tail()).ignored, undefined);
  await hst.end();
}));

test('C-10: dump says what a probe must give and did not', async () => {
  const D = reg.CORE.tlv.describe;
  assert.deepEqual(dump.requiredMissing({ revision: 1, transport: 0 }, [[D.unit_id, utf8('u')], [D.transport, Uint8Array.of(0, 1)], [D.max_op_ms | 0x80, new Uint8Array(4)],
    [reg.DESCRIBE_COMMON.ops, packOps([1, 2, 3])]]), []);
  assert.deepEqual(dump.requiredMissing({ revision: 1, transport: null }, []),
    ['confirm\'s transport TLV', 'describe of fn 0: unit_id', 'describe of fn 0: transport', 'describe of fn 0: max_op_ms',
      'describe of fn 0: ops']);                                    // no discoverable (core §7.5)
  const restart = { fn: 11, instance: 0, revision: 1, flags: 0, name: 'oep.probe.restart' };
  const ops = /** @type {[number, Uint8Array]} */ ([reg.DESCRIBE_COMMON.ops, packOps([1])]);
  assert.deepEqual(dump.interfaceMissing(restart, [ops]), ['describe of fn 11 (oep.probe.restart): restart_max_ms']);   // oep-if-restart §1
  assert.deepEqual(dump.interfaceMissing(restart, [ops, [0x40, new Uint8Array(4)]]), []);
  assert.deepEqual(dump.interfaceMissing({ ...restart, name: 'oep.fixture.gpio' }, [ops]), []);
  const core = { entry: { fn: 0, instance: 0, revision: 1, flags: 0, name: '' }, description: decodeDescription([]), tlvs: [] };
  const text = dump.toText({ revision: 1, maxFrame: 256, core, offers: [], requests: { confirm: 1, list: 1, describe: 1 }, missing: ['describe of fn 0: unit_id'] });
  assert.match(text, /\nMISSING what every probe must give \(core §1\.2, §7\.4\): describe of fn 0: unit_id\n/);
  assert.deepEqual(JSON.parse(dump.toJson({ revision: 1, maxFrame: 256, core, offers: [], requests: { confirm: 1, list: 1, describe: 1 }, missing: ['x'] })).missingRequired, ['x']);
});

// ---- the new answer TLVs in the API -------------------------------------------------------------------------------

test('API: searchRetries, StepError.stepLeft, internalPullups', async () => {
  const A = reg.WIRE_RVSWD.tlv.attach_answer;
  let stepTail = Uint8Array.of(0x01, 0, 0);
  let stepStatus = 0x04;
  const hst = new ScriptedHost(handlers([
    [1, Wire.ATTACH, () => ok([...new Writer().u16(1).u32(0x382).u8(0x08).u32(1_000_000).done(), ...m.tlv(A.dpc, new Writer().u32(0x100).done()),
      ...m.tlv(A.search_retries, new Writer().u16(3).done())])],
    [2, RiscvDm.STEP, () => [m.COMPLETED, m.FAILED, Uint8Array.from([...new Writer().u8(stepStatus).u8(0).u32(0x100).u32(0x104).done(), ...stepTail])]],
  ]));
  const w = await Wire.open(hst);
  await w.attach();
  assert.equal(w.searchRetries, 3);
  assert.equal(w.dpc, 0x100);
  const dm = await RiscvDm.on(hst, 1);
  await assert.rejects(dm.step(), (e) => e instanceof StepError && e instanceof TargetError && e.stepLeft && e.before === null);   // not read unless ok (§4.2)
  stepTail = new Uint8Array();
  await assert.rejects(dm.step(), (e) => e instanceof StepError && !e.stepLeft && e.after === null);
  stepStatus = 0;
  await assert.rejects(dm.step(), StepError);                      // outcome failed: not a step that worked

  const I2C = 9;
  const i2c = new ScriptedHost(handlers([]));
  i2c.fns.set('oep.fixture.i2c-target', I2C); i2c.revisions.set(I2C, 1);
  i2c.describes.set(I2C, [[0x06, new Writer().u32(0b100).done()]]);
  const t = await I2cTarget.open(i2c);
  assert.equal(await t.internalPullups(), true);
  i2c.describes.set(I2C, [[0x06, new Writer().u32(0).done()]]);
  assert.equal(await t.internalPullups(), false);                  // features bit2 clear: it enables none
});

test('API: describe shows the capture mode, channels and trigger, oep.probe.link\'s port_speed; no attach_writes_unbounded', { skip: !haveVirtualBench }, async () => {
  await withBench(['--profile', 'p4-x035'], async (hst) => {
    const text = dump.toText(await dump.collect(hst, 'oep.fixture.logic', true));
    assert.match(text, /mode: one-shot, max \d+ samples x 1 segments/);
    assert.match(text, /channels: 16\n/);
    assert.match(text, /trigger: immediate, level, edge; pretrigger up to \d+/);
  });
  await withBench(['--profile', 'esp32-v003'], async (hst) => {
    assert.match(dump.toText(await dump.collect(hst, 'oep.probe.link', true)), /ops: source, sink, port_speed/);
  });
  for (const w of ['oep.wire.rvswd', 'oep.wire.swio', 'oep.wire.swd']) assert.equal(KNOWN[w].features[0], undefined);
});

// ---- P2-○8 / P2-○9: capture ------------------------------------------------------------------------------------------

test('P2-○8: capture configure sends the table\'s TLVs without the critical bit (oep-spec c6ab5d9); the answer\'s samples hold', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const cap = await capture.LogicCapture.open(hst);
  await planApply(hst, [[cap.fn, 0, 4]]);
  const log = recording(hst);
  const c = await cap.configure({ rate: 1_000_000, samples: 1 << 20, trigger: [capture.LEVEL, 0, 1], pretrigger: 4 });
  const tags = new Set(m.splitTlvs(log[log.length - 1].payload).map(([t]) => t));
  assert.deepEqual([...tags].sort(), [capture.MODE, capture.RATE, capture.SAMPLES, capture.TRIGGER, capture.PRETRIGGER].sort());
  assert.equal(c.samples, 65536);                                   // rounded down: the answer holds
  await hst.end();
}));

test('P2-○9: blocking_ms sends nothing, then resyncs a length link', async () => {
  /** @type {(number | string)[]} */ const calls = [];
  const hst = new Host(/** @type {any} */ ({ framing: 'length', async startResync() { calls.push('resync'); } }));
  const wait = async (/** @type {number} */ ms) => { calls.push(ms); };
  await capture.blocked(hst, 250, wait);
  assert.deepEqual(calls, [250, 'resync']);
  hst.link.framing = 'cobs';
  calls.length = 0;
  await capture.blocked(hst, 10, wait);
  assert.deepEqual(calls, [10]);
  let waited = false;
  await capture.blocked(hst, 0, async () => { waited = true; });
  assert.equal(waited, false);
});
