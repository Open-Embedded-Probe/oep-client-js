// @ts-check
// The host side of the rules added since the 2026-10-02 rule changes (oep-spec b4b08f1, 40291a4, 2e70f40, 73a0c37):
// confirm's bounds (C-20), max_op_ms's ceiling (C-47), the transfer time before the first confirm answer (N-1),
// the boot_id under no resume (C-19), short answers and wrong-direction roles (C-36),
// an unanswered resend fails the transport (C-38), the last page's storage (PC-9), the optional ops (C-21),
// cs_setup_ns and i2c-target's reserved addresses. Mirrors oep-client-python's tests/test_host_rules_2026_10_06.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as cobs from '../src/cobs.js';
import * as m from '../src/message.js';
import * as config from '../src/config.js';
import * as dump from '../src/dump.js';
import { Writer } from '../src/bytes.js';
import { NotOepProbe, NotUsable, Rejected, TransportFailed } from '../src/errors.js';
import { Host, MAX_OP_MS_MAX, checkConfirm, checkMaxOpMs } from '../src/host.js';
import { Link } from '../src/link.js';
import { connect } from '../src/open.js';
import * as core from '../src/core.js';
import { RiscvDm, Wire } from '../src/riscv.js';
import { I2cTarget, SpiTarget } from '../src/fixture.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

/** @param {{ maxFrame?: number, window?: number, inflight?: number, bootId?: number }} [o] */
function confirmPayload({ maxFrame = 1024, window = 65536, inflight = 4, bootId = 0x11 } = {}) {
  return new Writer().raw(m.CONFIRM_RESULT).u8(1).u8(0).u16(maxFrame).u32(window).u8(inflight).u32(bootId).done();
}
/** @param {number} corr @param {Uint8Array} [payload] */
const result = (corr, payload = new Uint8Array()) => new m.Result(corr, m.COMPLETED, m.SUCCESS, payload).pack();
/** @param {Uint8Array} msg */
const lengthFrame = (msg) => Uint8Array.from([msg.length & 0xff, msg.length >> 8, ...msg]);
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A transport whose writes are answered by `respond` (null: no answer); `inject` delivers bytes as if the probe sent
 * them. framing 'length' (vendor bulk) or 'cobs' (a serial port).
 * @param {(req: m.Request) => Uint8Array[] | null} respond @param {'length' | 'cobs'} [framing]
 */
function scripted(respond, framing = 'length') {
  /** @type {m.Request[]} */ const sent = [];
  /** @type {(c: Uint8Array) => void} */ let deliver = () => {};
  const t = {
    respond,
    framing, kind: framing === 'length' ? 'vendor' : 'serial',
    /** @param {Uint8Array} data */
    async write(data) {
      /** @type {Uint8Array[]} */ const msgs = [];
      if (framing === 'length') {
        for (let i = 0; i < data.length;) { const n = data[i] | (data[i + 1] << 8); msgs.push(data.slice(i + 2, i + 2 + n)); i += 2 + n; }
      } else {
        let start = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 0) continue;
          if (i > start) msgs.push(cobs.unframe(data.subarray(start, i)));
          start = i + 1;
        }
      }
      for (const msg of msgs) {
        const req = m.Request.unpack(msg);
        sent.push(req);
        const replies = t.respond(req);
        if (replies) setTimeout(() => { for (const r of replies) deliver(framing === 'length' ? lengthFrame(r) : cobs.frame(r)); }, 1);
      }
    },
    /** @param {(c: Uint8Array) => void} onData */
    start(onData) { deliver = onData; },
    async close() {},
    /** @param {Uint8Array} bytes */
    inject(bytes) { deliver(bytes); },
  };
  return { t: /** @type {typeof t & import('../src/link.js').Transport} */ (t), sent };
}

/**
 * A Host whose link answers each request with `answer(req)` (payload bytes or a whole Result), logging what it sent.
 * @param {(req: m.Request) => Uint8Array | m.Result} answer
 */
function answering(answer) {
  /** @type {m.Request[]} */ const sent = [];
  const link = /** @type {any} */ ({
    framing: 'length', maxFrame: 0xffff,
    async send(/** @type {Uint8Array} */ b) {
      const req = m.Request.unpack(b);
      sent.push(req);
      const a = answer(req);
      return a instanceof m.Result ? new m.Result(req.corr, a.resolution, a.detail, a.payload).pack() : result(req.corr, a);
    },
  });
  return { hst: new Host(link), sent };
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

// ---- C-20: confirm's bounds -----------------------------------------------------------------------------------------

test('C-20: a confirm outside the bounds makes the probe not usable; nothing more is sent', async () => {
  for (const [maxFrame, window, inflight] of [[63, 4096, 4], [1024, 1000, 4], [1024, 4096, 0]]) {
    const { hst, sent } = answering(() => confirmPayload({ maxFrame, window, inflight }));
    await assert.rejects(hst.confirm(), (e) => e instanceof NotUsable
      && e.message.includes(`max_frame ${maxFrame}, window ${window}, max_inflight ${inflight}`));   // the values reported
    await assert.rejects(hst.request(0, m.OP.list, new Uint8Array(), { locked: false }), NotUsable);
    await assert.rejects(hst.open(3000), NotUsable);
    assert.equal(sent.length, 1);                                 // nothing more went out
  }
  assert.equal(checkConfirm(64, 64, 1), '');
});

test('C-20: through connect the transport is closed after the confirm, nothing else sent', async () => {
  const { t, sent } = scripted((req) => [result(req.corr, confirmPayload({ maxFrame: 1024, window: 512 }))]);
  await assert.rejects(connect(t), (e) => e instanceof NotOepProbe && /** @type {any} */ (e).cause instanceof NotUsable);
  assert.equal(sent.length, 1);
});

// ---- C-47: max_op_ms 1..600000 ----------------------------------------------------------------------------------------

test('C-47: a max_op_ms outside 1..600000 is a probe not used', async () => {
  assert.equal(MAX_OP_MS_MAX, 600000);
  for (const [value, usable] of /** @type {[number, boolean][]} */ ([[0, false], [1, true], [600000, true], [600001, false], [0xffffffff, false]])) {
    const { hst, sent } = answering((req) => {
      if (req.op === m.OP.confirm) return confirmPayload();
      if (req.op === m.OP.describe) return new Writer().u8(0).u8(reg.CORE.tlv.describe.max_op_ms).u16(4).u32(value).done();
      return new Uint8Array();
    });
    await hst.confirm();
    if (usable) {
      assert.equal(await core.maxOpMs(hst), value);
      assert.equal(checkMaxOpMs(value), '');
      continue;
    }
    await assert.rejects(core.maxOpMs(hst), (e) => e instanceof NotUsable && e.message.includes(String(value)));
    const n = sent.length;
    await assert.rejects(hst.open(3000), NotUsable);
    await assert.rejects(core.probeInfo(hst), NotUsable);
    assert.equal(sent.length, n);
  }
});

// ---- N-1: min_max_frame until the first confirm answer, then the latest ------------------------------------------------

test('N-1: the transfer time counts 64 until a confirm answer, then the latest (the link\'s own confirms too)', async () => {
  let answer = confirmPayload({ maxFrame: 1024 });
  const { t } = scripted((req) => [result(req.corr, req.op === m.OP.confirm ? answer : new Uint8Array())]);
  const link = new Link(t, { timeoutMs: 300 });
  assert.equal(link.probeMaxFrame, reg.MIN_MAX_FRAME);
  assert.equal(reg.MIN_MAX_FRAME, 64);
  await link.start();
  const hst = new Host(link);
  await hst.confirm();
  assert.equal(link.probeMaxFrame, 1024);
  answer = confirmPayload({ maxFrame: 512, window: 4096 });
  await hst.confirm();
  assert.deepEqual([link.probeMaxFrame, link.maxFrame], [512, 512]);
  answer = confirmPayload({ maxFrame: 256, window: 4096 });
  assert.equal(await link.confirmRaw(300), true);                 // the link's own confirm
  assert.equal(link.probeMaxFrame, 256);
});

// ---- C-19 under no resume (core §6.5, §9): the boot_id tells a reboot, no_session a session that ended -------------

/** A probe stand-in that answers open with its boot_id, and every other request as `other` says (null: success).
 * @param {{ bootId: number, other: number | null }} state */
function opening(state) {
  return answering((req) => {
    if (req.op === m.OP.confirm) return confirmPayload({ bootId: state.bootId });
    if (req.op === m.OP.open) return new Writer().u32(3000).u32(state.bootId).done();
    return new Uint8Array();
  });
}

test('C-19: open answers lease_ms boot_id; a changed boot_id drops the names once, end and a new open count one loss', async () => {
  const state = { bootId: 0x11, other: null };
  const { hst } = opening(state);
  const opened = await hst.open(3000);
  assert.deepEqual(opened, { leaseMs: 3000, bootId: 0x11 });      // no resumed (core §6.4)
  hst.fns.set('oep.fixture.gpio', 4);
  hst.describes.set(4, []);
  let epoch = hst.epoch;
  await hst.open(3000);                                           // a new session over the last: its loss, once
  assert.deepEqual([hst.epoch, hst.fns.size], [epoch + 1, 1]);
  epoch = hst.epoch;
  state.bootId = 0x22;                                            // a reboot: counted once, the names listed again
  await hst.open(3000);
  assert.deepEqual([hst.epoch, hst.fns.size, hst.describes.size], [epoch + 1, 0, 0]);
  epoch = hst.epoch;
  await hst.end();
  assert.deepEqual([hst.epoch, hst.session], [epoch + 1, null]);  // end releases everything (core §9)
  await hst.open(3000);
  assert.equal(hst.epoch, epoch + 1);                             // nothing more lost after an end
});

// ---- C-36: short answers, events and data; request roles --------------------------------------------------------------

test('C-36: a short answer on a length link is a broken frame: resynced and resent', async () => {
  let keepalives = 0;
  const { t } = scripted((req) => {
    if (req.op === m.OP.confirm) return [result(req.corr, confirmPayload())];
    return ++keepalives === 1 ? [result(req.corr).slice(0, 4)] : [result(req.corr)];   // 4 bytes, its corr readable
  });
  const hst = await connect(t);
  assert.ok((await hst.request(0, m.OP.keepalive, new Uint8Array(), { locked: false })).succeeded);
  assert.deepEqual([hst.link.stats.resyncs, hst.link.stats.retries], [1, 1]);
});

test('C-36: short events and request roles from the probe are dropped on a serial port', async () => {
  const { t } = scripted(() => null, 'cobs');
  const link = new Link(t, { timeoutMs: 300 });
  await link.start();
  const reply = link.sendOnce(new m.Request(7, 0, m.OP.lock_state).pack());
  t.inject(Uint8Array.from([...cobs.frame(Uint8Array.of(m.ROLE_EVENT, 0, 0, 0)), ...cobs.frame(new m.Request(7, 0, m.OP.keepalive).pack()),
    ...cobs.frame(result(7))]));
  assert.equal(m.Result.unpack(await reply).corr, 7);
  assert.deepEqual([link.stats.noise, link.stats.dropped, link.events.length], [4, 1, 0]);
});

test('C-36: a short answer on a held serial port is resent at once', async () => {
  let n = 0;
  const { t } = scripted((req) => [++n === 1 ? result(req.corr).slice(0, 4) : result(req.corr)], 'cobs');
  const link = new Link(t, { timeoutMs: 3000 });
  link.held = () => true;
  await link.start();
  const t0 = performance.now();
  assert.ok(m.Result.unpack(await link.sendOnce(new m.Request(9, 0, m.OP.keepalive, new Uint8Array(), 1).pack())).succeeded);
  assert.equal(link.stats.retries, 1);
  assert.ok(performance.now() - t0 < 1500);                      // not waited out
});

// ---- C-38: an unanswered resend fails the transport; recover with a confirm, COBS included ---------------------------

/** A COBS probe stand-in: answers confirms (with its boot_id) and other requests, or nothing while `silent`. */
async function cobsHost() {
  /** @type {number[]} */ const seen = [];
  const probe = { silent: false, bootId: 0x11, seen };
  const { t } = scripted((req) => {
    probe.seen.push(req.op);
    if (probe.silent) return null;
    return [result(req.corr, req.op === m.OP.confirm ? confirmPayload({ bootId: probe.bootId }) : new Uint8Array())];
  }, 'cobs');
  const link = new Link(t, { timeoutMs: 100 });
  link.waitAddMs = 0;
  await link.start();
  const hst = new Host(link);
  await hst.confirm();
  return { link, hst, probe };
}

test('C-38: an unanswered resend fails the transport, and the next request confirms first', async () => {
  const { link, hst, probe } = await cobsHost();
  probe.silent = true;
  await assert.rejects(hst.request(0, m.OP.keepalive, new Uint8Array(), { locked: false }), TransportFailed);
  assert.ok(link.failedTransport);
  assert.deepEqual(probe.seen.slice(-2), [m.OP.keepalive, m.OP.keepalive]);   // the request and its one resend
  probe.silent = false;
  probe.bootId = 0x99;                                            // back, and it had rebooted
  probe.seen.length = 0;
  assert.ok((await hst.request(0, m.OP.lock_state, new Uint8Array(), { locked: false })).succeeded);
  assert.deepEqual(probe.seen, [m.OP.confirm, m.OP.lock_state]);   // the confirm went first
  assert.deepEqual([link.failedTransport, link.stats.recoveries, hst.epoch], ['', 1, 1]);   // the changed boot_id: a reboot
});

test('C-38: no confirm in the recovery fails the request too, and the transport stays failed', async () => {
  const { link, hst, probe } = await cobsHost();
  probe.silent = true;
  await assert.rejects(hst.request(0, m.OP.keepalive, new Uint8Array(), { locked: false }), TransportFailed);
  probe.seen.length = 0;
  await assert.rejects(hst.request(0, m.OP.keepalive, new Uint8Array(), { locked: false }), (e) => e instanceof TransportFailed && e.recovery);
  assert.ok(link.failedTransport);
  assert.ok(probe.seen.length && probe.seen.every((op) => op === m.OP.confirm));   // only confirms went out
});

test('C-38: requests outstanding together fail together', async () => {
  const { link, hst, probe } = await cobsHost();
  probe.silent = true;
  await assert.rejects(hst.pipeline([[0, m.OP.keepalive, new Uint8Array()], [0, m.OP.lock_state, new Uint8Array()]], { locked: false }), TransportFailed);
  assert.ok(link.failedTransport);
  assert.equal(link.pending.size, 0);
});

test('C-38: on a length link the resend\'s silence fails it too, after the resync', async () => {
  const { t } = scripted((req) => (req.op === m.OP.confirm ? [result(req.corr, confirmPayload())] : null));
  const hst = await connect(t, { timeoutMs: 100 });
  hst.link.waitAddMs = 0;
  await assert.rejects(hst.request(0, m.OP.keepalive, new Uint8Array(), { locked: false }), TransportFailed);
  assert.equal(hst.link.failedTransport, '');                    // resynced already: nothing to recover
});

// ---- PC-9: the last page's storage -----------------------------------------------------------------------------------

test('PC-9: state keeps the last page\'s storage', async () => {
  const cfg = new config.ProbeConfig(/** @type {any} */ (null), 9, config.ProbeConfig.NAME);
  const slot = new Writer().u8(0).u8(1).u16(0xffff).u64(0xffffffffffffffffn).done();   // slot state connection last_try_at_ns (12 bytes, §3.3)
  const pages = [
    new Writer().u8(1).u8(0).u32(0).u8(0).u8(1).raw(slot).u8(0).done(),          // more: storage none
    new Writer().u8(0).u8(1).u32(0x1234).u8(0).u8(1).raw(slot).u8(0).done(),     // saved in between
  ];
  let i = 0;
  cfg.call = /** @type {any} */ (async () => ({ payload: pages[i++] }));
  const st = await cfg.state();
  assert.deepEqual([i, st.storage, st.savedHash, st.slots.length], [2, 'applied', 0x1234, 2]);
});

// ---- C-21: the optional ops are used when declared -------------------------------------------------------------------

test('C-21: riscv-dm says which optional ops the probe offers (its ops tag)', { skip: !haveVirtualBench }, () => withBench(['--profile', 'esp32-v003'], async (hst) => {
  await hst.open(10000);
  const wire = await Wire.open(hst, { name: 'oep.wire.swio' });
  const { conn } = await wire.attach({ halt: true });
  const dm = await RiscvDm.on(hst, conn);
  assert.deepEqual([...(await dm.declared())].sort(), ['block', 'reset', 'run']);
  await assert.rejects(dm.step(), (e) => e instanceof Rejected && e.reason === m.REJECT.unknown_operation);
  assert.equal(await dm.offers(RiscvDm.STEP), false);
  await assert.rejects(core.require(hst, dm.fn, RiscvDm.STEP),   // the same Rejected, nothing sent
    (e) => e instanceof Rejected && e.constructor === Rejected && e.reason === m.REJECT.unknown_operation);
  await hst.end();
}));

// ---- fixture: cs_setup_ns shown; i2c-target's reserved addresses ------------------------------------------------------

test('cs_setup_ns is read and shown', { skip: !haveVirtualBench }, async () => {
  await withBench(['--profile', 'esp32-v003'], async (hst) => {
    const spi = await SpiTarget.open(hst);
    assert.equal(await spi.csSetupNs(), 4000);
    assert.equal((await spi.declarations()).csSetupNs, 4000);
    assert.ok(dump.toText(await dump.collect(hst)).includes('CS setup ns: 4000'));
  });
  await withBench(['--profile', 'p4-x035'], async (hst) => {
    assert.equal(await (await SpiTarget.open(hst)).csSetupNs(), 0);
  });
});

test('i2c-target refuses a reserved address before sending', { skip: !haveVirtualBench }, () => withBench(['--profile', 'p4-x035'], async (hst) => {
  const i2c = await I2cTarget.open(hst);
  let sent = 0;
  const send = hst.link.send.bind(hst.link);
  hst.link.send = (b, o) => { sent++; return send(b, o); };
  for (const address of [0x00, 0x07, 0x78, 0x7f]) await assert.rejects(i2c.configure(address), RangeError);
  assert.equal(sent, 0);
}));
