// @ts-check
// The host side of oep-spec docs/v1-rule-change-proposal-2026-10-02.md (applied 09622ef..e9cd891): the wait's floor
// (C-06, P2-★4), the revision in use (C-15), confirm's transport (C-05), x- unit_ids (C-24), TCP and the resync wait
// (C-07, transports §5), the line search (PC-1, PC-2, PC-5), text shown and sent (C-22, C-18), ignored's marker (C-04),
// what a probe must give (C-10) and describe as dump shows it.
// Mirrors oep-client-python's tests/test_host_rules_2026_10_02.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as cobs from '../src/cobs.js';
import * as m from '../src/message.js';
import * as settings from '../src/settings.js';
import * as dump from '../src/dump.js';
import { Writer, utf8 } from '../src/bytes.js';
import { Locked, Rejected, Unsupported } from '../src/errors.js';
import { Host, ownerText } from '../src/host.js';
import { Link, RESYNC_WAIT_MS } from '../src/link.js';
import { connect } from '../src/open.js';
import { planApply, take } from '../src/core.js';
import { decodeDescription, packOps } from '../src/catalog.js';
import { requireUnitName } from '../src/usbvendor.js';
import { Wire, WIRES } from '../src/wire.js';
import { listEntries } from '../src/core.js';
import { openTcp } from '../src/node/index.js';
import { tcpTransport } from '../src/node/tcp.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';
import { KNOWN } from '../src/interfaces.js';

/** confirm's answer: magic revision max_frame window max_inflight boot_id (core §7.1) */
const CONFIRM_V1 = new Writer().raw(m.CONFIRM_RESULT).u8(1).u16(1024).u32(65536).u8(4).u32(0x11).done();
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

test('C-06: the floor is argument time + 1000 ms + the transfer time', () => {
  const t = { framing: /** @type {'cobs'} */ ('cobs'), kind: 'serial', baudRate: 115200, async write() {}, start() {}, async close() {} };
  const link = new Link(t, { timeoutMs: 200 });
  link.probeMaxFrame = 1024;
  const req = new m.Request(1, 0, m.OP.keepalive).pack();
  const L = cobs.frame(req).length;                                // the request's frame on the wire
  const transfer = (L + 1024 * 3) * 10 / 115200 * 1000;            // (L + max_frame x (1 + 2)) x 10 / baud
  assert.ok(Math.abs(link.transferMs(req) - transfer) < 1e-9 && transfer > 260);
  assert.ok(Math.abs(link.waitMs(0, req) - (1000 + transfer)) < 1e-9);   // over the link's own 200 ms
  assert.ok(Math.abs(link.waitMs(2500, req) - (2500 + 1000 + transfer)) < 1e-9);   // run's timeout_ms, dmi's waits ...
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

test('C-06: attach waits max_op_ms (debug §1)', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(3000);
  const entry = /** @type {import('../src/catalog.js').ListEntry} */ ((await listEntries(hst)).find((e) => e.name === WIRES.rvswd || e.name === WIRES.swio));
  const log = recording(hst);
  const w = await Wire.open(hst, { fn: entry.fn, name: entry.name });
  await w.check({ pins: [0, 1] }).catch(() => {});
  const att = log.find((r) => r.fn === w.fn && r.op === Wire.ATTACH);
  assert.equal(att?.expectMs, 10000);                              // the probe's max_op_ms (core §4.4)
  await hst.end();
}));

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

// ---- C-24: an x- unit_id names no unit ------------------------------------------------------------------------------

test('C-24: no USB device is looked up by an x- unit_id', async () => {
  assert.throws(() => requireUnitName('x-esp32'), RangeError);
  assert.equal(requireUnitName('fafe00000035'), 'fafe00000035');
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

test('C-07: a pause inside a frame is read on, on TCP and on vendor bulk (transports §2\'s gap is the probe reader\'s)', async () => {
  for (const keeps of [true, false]) {
    const one = await paused(keeps, 300);
    assert.equal(m.Result.unpack(await one.answer).corr, 7);
    assert.equal(one.link.stats.resyncs, 0);
    assert.ok(!one.sent.some((r) => r.op === m.OP.confirm));
  }
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

test('PC-1: findLine: port S\'s line N is the label S.N; a bare name names no port\'s line (host guide §5.3)', async () => {
  assert.equal(await settings.findLine([[23, 'dut.NRST']], 'nrst', { port: 'DUT' }), 23);
  assert.equal(await settings.findLine([[23, 'NRST']], 'nrst'), null);
  assert.equal(await settings.findLine([[23, 'a.nrst'], [24, 'b.nrst']], 'nrst'), null);   // two ports: say which
  assert.equal(await settings.findLine([[5, 'B.NRST']], 'nrst', { port: 'b' }), 5);
  assert.deepEqual([...settings.LINE_NAMES], Object.keys(reg.CORE.line_names));   // from the registry (PC-2)
});

test('PC-1: findLine on a Host reads every label, the firmware\'s initial ones too', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  assert.equal(await settings.findLine(hst, 'nrst', { port: 'v003' }), 23);
}));

test('PC-5: a label the probe would refuse is refused there (core §13.3: a text value is checked for its length)', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  await hst.open(3000);
  const st = new settings.Settings(hst);
  for (const text of ['', 'x'.repeat(33)]) await assert.rejects(st.setNamed('core', { 'channel.GPIO20.label': text }), Rejected, JSON.stringify(text));
  assert.equal(await st.setNamed('core', { 'channel.GPIO20.label': 'x'.repeat(32) }), 2);
  assert.equal(await st.setNamed('core', { 'channel.GPIO21.label': '日本語' }), 3);   // 9 bytes
}));

// ---- C-22 / C-18: text, the owner and the session id ---------------------------------------------------------------

test('C-22: text from an answer is shown without control characters', () => {
  assert.equal(m.shown(Uint8Array.from([...utf8('ok\x1b[31mred\x7f'), 0xff])), 'ok�[31mred��');
  const payload = Uint8Array.from([...new Writer().u32(5).done(), ...m.tlv(reg.CORE.tlv.locked_payload.owner, utf8('evil\x1b]0;x\x07'))]);
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
  const restart = { fn: 11, instance: 0, revision: 1, name: 'oep.probe.restart' };
  const ops = /** @type {[number, Uint8Array]} */ ([reg.DESCRIBE_COMMON.ops, packOps([1])]);
  assert.deepEqual(dump.interfaceMissing(restart, [ops]), ['describe of fn 11 (oep.probe.restart): restart_max_ms']);   // oep-if-restart §1
  assert.deepEqual(dump.interfaceMissing(restart, [ops, [reg.PROBE_RESTART.tlv.describe.restart_max_ms, new Uint8Array(4)]]), []);
  assert.deepEqual(dump.interfaceMissing({ ...restart, name: 'oep.fixture.gpio' }, [ops]), []);
  const core = { entry: { fn: 0, instance: 0, revision: 1, name: '' }, description: decodeDescription([]), tlvs: [] };
  const text = dump.toText({ revision: 1, maxFrame: 256, core, offers: [], requests: { confirm: 1, list: 1, describe: 1 }, missing: ['describe of fn 0: unit_id'] });
  assert.match(text, /\nMISSING what every probe must give \(core §1\.2, §7\.4\): describe of fn 0: unit_id\n/);
  assert.deepEqual(JSON.parse(dump.toJson({ revision: 1, maxFrame: 256, core, offers: [], requests: { confirm: 1, list: 1, describe: 1 }, missing: ['x'] })).missingRequired, ['x']);
});

// ---- the API -------------------------------------------------------------------------------------------------------

test('API: describe shows the capture mode, channels and trigger, oep.probe.link\'s port_speed; no attach_writes_unbounded', { skip: !haveVirtualBench }, async () => {
  await withBench(['--profile', 'p4-x035'], async (hst) => {
    const text = dump.toText(await dump.collect(hst, 'oep.fixture.logic', true));
    assert.match(text, /mode: one-shot, max \d+ samples a segment/);
    assert.match(text, /repeat, max \d+ samples x \d+ segments/);
    assert.match(text, /channels: 16\n/);
    assert.match(text, /trigger: immediate, level, edge; pretrigger up to \d+/);
  });
  await withBench(['--profile', 'esp32-v003'], async (hst) => {
    assert.match(dump.toText(await dump.collect(hst, 'oep.probe.link', true)), /ops: source, sink, port_speed/);
  });
  for (const w of ['oep.wire.rvswd', 'oep.wire.swio', 'oep.wire.swd']) assert.equal(KNOWN[w].features[0], undefined);
});
