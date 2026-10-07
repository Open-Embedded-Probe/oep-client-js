// @ts-check
// Names, the known-interface table and dump (src/names.js, src/interfaces.js, src/dump.js); mirrors
// oep-client-python's tests/test_capabilities.py as far as the TCP virtual bench allows (its custom VirtualProbe cases are built
// from TLVs here).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer } from '../src/bytes.js';
import { decodeDescription } from '../src/catalog.js';
import * as dump from '../src/dump.js';
import { ranges } from '../src/interfaces.js';
import * as names from '../src/names.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

/** @param {string} profile @param {(hst: import('../src/host.js').Host) => Promise<void>} body @param {'length' | 'cobs'} framing */
async function withBench(profile, body, framing = 'length') {
  const bench = await startVirtualBench(['--profile', profile], framing);
  const hst = await openTcp({ port: bench.port, framing });
  try {
    await body(hst);
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

// ---- names ------------------------------------------------------------------------------------------------------

test('valid names', () => {
  for (const n of ['oep.probe.plan', 'oep.fixture.i2c-target', 'io.github.ch32-riscv-ug.p4.i2c-target', 'local.bench.thing',
    'uuid.0123456789abcdef0123456789abcdef.tool', 'jp.example.probe', `oep.${'a'.repeat(44)}`]) assert.equal(names.validate(n), n);
});

test('invalid names say why', () => {
  for (const [n, why] of [['oep', 'namespace'], ['OEP.core', 'label'], ['oep.fixture_uart', 'label'],
    ['1com.example.x', 'top-level'], ['io.github', 'reverse DNS'], ['uuid.1234.tool', '32 lowercase hex'],
    [`oep.${'a'.repeat(45)}`, 'bytes'], ['oep.café', 'ASCII'],                // 49 bytes: over the 48 of core §7.2
    ['oep.-fixture', 'label'], ['oep.fixture-', 'label'], ['oep..core', 'label']]) {   // no '-' at a label's end (C-23)
    assert.throws(() => names.validate(n), (e) => e instanceof names.InvalidName && e.message.includes(why), n);
  }
});

test('hosting names are linted, not rejected', () => {
  assert.ok(names.validate('github.ch32-riscv-ug.ch32rv'));
  assert.match(names.lint('github.ch32-riscv-ug.ch32rv')[0], /io\.github\.ch32-riscv-ug/);
  assert.match(names.lint('com.github.ch32-riscv-ug.ch32rv')[0], /io\.github/);
  assert.deepEqual(names.lint('io.github.ch32-riscv-ug.ch32rv'), []);
  assert.equal(names.kind('io.github.ch32-riscv-ug.ch32rv'), 'domain');
  assert.equal(names.kind('oep.target.flash'), 'oep');
  assert.equal(names.kind('local.x'), 'local');
});

test('a prefix matches on label boundaries', () => {
  assert.ok(names.matches('oep.fixture.uart', 'oep.fixture.uart', false));
  assert.ok(names.matches('oep.fixture.uart.stream', 'oep.fixture.uart', false));
  assert.ok(!names.matches('oep.fixture.uart2', 'oep.fixture.uart', false));
  assert.ok(!names.matches('oep.fixture.uart.stream', 'oep.fixture.uart', true));
  assert.ok(names.matches('anything.at.all', '', false));
  assert.ok(!names.matches('anything.at.all', '', true));
});

test('ranges and hz', () => {
  assert.equal(ranges([0, 1, 2, 5, 7, 8]), '0-2,5,7-8');
  assert.equal(ranges([]), '-');
  assert.equal(dump.hz(5_000_000), '5 MHz');
  assert.equal(dump.hz(83_333), '83.333 kHz');
  assert.equal(dump.hz(611), '611 Hz');
});

// ---- dump -------------------------------------------------------------------------------------------------------

test('unknown interfaces are shown raw', () => {
  const tlvs = /** @type {[number, Uint8Array][]} */ ([
    [0x01, new Writer().u8(3).u16(7).u8(1).done()],               // role 3: channel 7
    [0x06, new Writer().u32(0b10).done()],
    [0x41, Uint8Array.of(9)],
    [0x80 | 0x3d, new Uint8Array()],                               // unknown common, critical
  ]);
  const row = dump.describeOffer({ entry: { fn: 1, instance: 1, revision: 0, flags: 0, name: 'local.bench.widget' },
    description: decodeDescription(tlvs), tlvs });
  assert.equal(row.known, false);
  assert.equal(row.namespace, 'local');
  assert.deepEqual(row.roles, { role3: '7' });
  assert.deepEqual(row.features, ['bit1']);
  assert.deepEqual(row.declares, { 'tag 0x41': '09' });
  assert.match(/** @type {string} */ (row.unusable), /0xbd/);
});

test('the core (fn 0) is described first and never listed; its describe is the probe itself', { skip: !haveVirtualBench }, () => withBench('esp32-v003-64', async (hst) => {
  const caps = await dump.collect(hst);
  assert.ok(caps.offers.every((o) => o.entry.fn !== 0 && o.entry.name !== 'oep.core'));   // core §0, §7.2
  assert.deepEqual([caps.core.entry.fn, caps.core.entry.name], [0, '']);
  assert.equal(caps.revision, 1);
  assert.equal(caps.maxFrame, 64);
  assert.ok(caps.requests.list > 1);                                // 64-byte frames (esp32-v003-64): the list is paged
  const row = dump.describeOffer(caps.core);
  assert.deepEqual(row.ops, ['confirm', 'list', 'describe', 'clock', 'open', 'end', 'keepalive', 'lock_state']);   // fn 0's ops by name (core §12)
  const d = /** @type {Record<string, string>} */ (row.declares);
  assert.equal(d['unit id'], 'fafe00000003');
  assert.equal(d.transport, '0 = UART bridge');
  assert.ok(d.label.includes('16 = SWIO') && d.label.includes('23 = NRST'));   // repeated tags all kept
  const cfg = dump.describeOffer(/** @type {dump.Offer} */ (caps.offers.find((o) => o.entry.name === 'oep.probe.config'))).declares;
  assert.deepEqual(cfg && [cfg.slots, cfg['bind modes']], ['1', undefined]);   // no bind modes (probe.config §1.2)
  const text = dump.toText(caps);
  // the core block reads like every other: its heading, the summary, then what it declares
  assert.match(text, /\ncore {9}fn 0 {3}\(no name; the probe itself\)\n {14}confirm, list, describe, clock, open \/ end \/ keepalive, lock state; describe = the probe itself\n {16}ops: confirm, list, describe, clock, open, end, keepalive, lock_state\n/);
  assert.ok(!text.includes('oep.core'));
  assert.deepEqual(dump.toData(caps).core.declares?.['unit id'], 'fafe00000003');
}, 'cobs'));

test('filters', { skip: !haveVirtualBench }, () => withBench('esp32-v003', async (hst) => {
  const fixture = await dump.collect(hst, 'oep.fixture');
  assert.deepEqual(new Set(fixture.offers.map((o) => o.entry.name)), new Set(['oep.fixture.gpio', 'oep.fixture.uart',
    'oep.fixture.logic', 'oep.fixture.i2c-target', 'oep.fixture.spi-target']));
  const one = await dump.collect(hst, 'oep.fixture.spi-target', true);
  assert.deepEqual(one.offers.map((o) => o.entry.name), ['oep.fixture.spi-target']);
  assert.deepEqual(one.offers[0].description.groups.get(2)?.[0], [1, 14]);
  assert.deepEqual(dump.describeOffer(one.offers[0]).pinGroups?.['1'], { SCK: 18, MOSI: 19, MISO: 5, CS: 4 });
}));

test('p4 follows the agreed names; text and JSON', { skip: !haveVirtualBench }, () => withBench('p4-x035', async (hst) => {
  const caps = await dump.collect(hst);
  const byName = new Map(caps.offers.map((o) => [o.entry.name, o]));
  assert.equal(caps.offers.length, 15);                             // fn 0 not among them; oep.probe.plan / restart / link listed
  assert.equal(caps.requests.list, 1);
  assert.equal(caps.requests.describe, 16);                         // fn 0 and every listed fn
  assert.deepEqual(byName.get('oep.probe.link')?.description.ops, new Set([1, 2]));   // source, sink: no UART bridge here
  assert.deepEqual(byName.get('oep.probe.plan')?.description.ops, new Set([1, 2]));   // plan_apply, plan_release (oep-if-plan)
  assert.deepEqual(byName.get('oep.probe.restart')?.description.ops, new Set([1]));   // restart (oep-if-restart)
  assert.ok(caps.offers.every((o) => o.description.ops !== null));             // every fn carries ops (core §7.4)
  assert.deepEqual(new Set(['oep.wire.rvswd', 'oep.target.riscv-dm', 'oep.target.console'].map((n) => byName.get(n)?.entry.instance)), new Set([0]));
  assert.deepEqual(byName.get('oep.wire.rvswd')?.description.groups.get(1), [[1, 2], [2, 54]]);
  const i2c = /** @type {dump.Offer} */ (byName.get('oep.fixture.i2c-target'));
  assert.deepEqual(i2c.description.roles.get(1), i2c.description.roles.get(2));
  assert.ok(!i2c.description.roles.get(1)?.includes(2));           // reserved for RVSWD
  const text = dump.toText(caps);
  assert.match(text, /^OEP revision 1, max frame 1024 bytes; 15 interfaces in 1 list and 16 describe requests\n/);
  assert.ok(text.includes('instance 0') && text.includes('oep.fixture.i2c-target'));
  assert.ok(!text.includes('preloaded tx') && !text.includes('clock stretching'));   // one form; stretch: an op (ops)
  assert.ok(text.includes('ops: configure, read_rx, preload_tx, status, stretch'));
  assert.ok(text.includes('max 5 MHz'));
  assert.ok(text.includes('unit id: fafe00000035') && text.includes('chip: esp32p4 v1.0'));
  assert.ok(text.includes('oep.fixture.analog  rev 1\n'));          // known now: the capture mode is shown (P2-★6)
  assert.ok(text.includes('mode: one-shot, max 65536 samples x 1 segments'));   // no background (capture §3.5)
  assert.ok(text.includes('restart max ms: 2000') && text.includes('ops: plan_apply, plan_release'));
  assert.ok(!text.includes('MISSING'));                             // the virtual bench gives what core §1.2 requires
  assert.deepEqual(caps.missing, []);
  const data = JSON.parse(dump.toJson(caps));
  assert.equal(data.maxFrame, 1024);
  assert.equal(data.interfaces.length, 15);
  const rvswd = data.interfaces.find((/** @type {any} */ i) => i.name === 'oep.wire.rvswd');
  assert.equal(rvswd.roles, undefined);                             // rvswd declares a fixed pin set, not roles
  assert.deepEqual(rvswd.pinGroups['1'], { SWDIO: 2, SWCLK: 54 });
  assert.equal(data.core.fn, 0);
}));

test('a board whose wire takes any pins', { skip: !haveVirtualBench }, () => withBench('rp2350-pins', async (hst) => {
  const caps = await dump.collect(hst);
  const wire = dump.describeOffer(/** @type {dump.Offer} */ (caps.offers.find((o) => o.entry.name === 'oep.wire.rvswd')));
  assert.equal(wire.name, 'oep.wire.rvswd');
  assert.deepEqual(wire.roles, { SWDIO: '0-18,20-29', SWCLK: '0-18,20-29', reset: '0-18,20-29' });
  assert.ok(!caps.offers.some((o) => o.entry.name === 'oep.probe.config'));
}));
