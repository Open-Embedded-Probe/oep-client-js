// @ts-check
// Names, the known-interface table and dump (src/names.js, src/interfaces.js, src/dump.js); mirrors
// oep-client-python's tests/test_capabilities.py as far as the TCP fake allows (its custom FakeProbe cases are built
// from TLVs here).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer } from '../src/bytes.js';
import { decodeDescription } from '../src/catalog.js';
import * as dump from '../src/dump.js';
import { ranges } from '../src/interfaces.js';
import * as names from '../src/names.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

/** @param {string} profile @param {(hst: import('../src/host.js').Host) => Promise<void>} body @param {'length' | 'cobs'} framing */
async function withFake(profile, body, framing = 'length') {
  const fake = await startFake(['--profile', profile], framing);
  const hst = await openTcp({ port: fake.port, framing });
  try {
    await body(hst);
  } finally {
    await hst.link.close();
    fake.stop();
  }
}

// ---- names ------------------------------------------------------------------------------------------------------

test('valid names', () => {
  for (const n of ['oep.core', 'oep.fixture.i2c-target', 'io.github.ch32-riscv-ug.p4.i2c-target', 'local.bench.thing',
    'uuid.0123456789abcdef0123456789abcdef.tool', 'jp.example.probe']) assert.equal(names.validate(n), n);
});

test('invalid names say why', () => {
  for (const [n, why] of [['oep', 'namespace'], ['OEP.core', 'label'], ['oep.fixture_uart', 'label'],
    ['1com.example.x', 'top-level'], ['io.github', 'reverse DNS'], ['uuid.1234.tool', '32 lowercase hex'],
    [`oep.${'a'.repeat(60)}`, 'bytes'], ['oep.café', 'ASCII']]) {
    assert.throws(() => names.validate(n), (e) => e instanceof names.InvalidName && e.message.includes(why), n);
  }
});

test('hosting names are linted, not rejected', () => {
  assert.ok(names.validate('github.ch32-riscv-ug.ch32rv'));
  assert.match(names.lint('github.ch32-riscv-ug.ch32rv')[0], /io\.github\.ch32-riscv-ug/);
  assert.match(names.lint('com.github.ch32-riscv-ug.ch32rv')[0], /io\.github/);
  assert.deepEqual(names.lint('io.github.ch32-riscv-ug.ch32rv'), []);
  assert.equal(names.kind('io.github.ch32-riscv-ug.ch32rv'), 'domain');
  assert.equal(names.kind('oep.target.flash'), 'standard');
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

test('oep.core is the first entry and describes the probe itself', { skip: !haveFake }, () => withFake('esp32-v003', async (hst) => {
  const caps = await dump.collect(hst);
  const first = caps.offers[0].entry;
  assert.deepEqual([first.fn, first.name, first.revision], [0, 'oep.core', 1]);
  assert.equal(caps.revision, 1);
  assert.equal(caps.maxFrame, 64);
  assert.ok(caps.requests.list > 1);                                // 64-byte frames: the list is paged
  const d = /** @type {Record<string, string>} */ (dump.describeOffer(caps.offers[0]).declares);
  assert.equal(d['unit id'], '0070070d9394');
  assert.equal(d.transport, '0 = UART bridge');
  assert.ok(d.label.includes('16 = SWIO') && d.label.includes('23 = NRST'));   // repeated tags all kept
  const cfg = dump.describeOffer(/** @type {dump.Offer} */ (caps.offers.find((o) => o.entry.name === 'oep.probe.config'))).declares;
  assert.deepEqual(cfg && [cfg.slots, cfg['bind modes']], ['1', 'last-reset, manual']);
}, 'cobs'));

test('filters', { skip: !haveFake }, () => withFake('esp32-v003', async (hst) => {
  const fixture = await dump.collect(hst, 'oep.fixture');
  assert.deepEqual(new Set(fixture.offers.map((o) => o.entry.name)), new Set(['oep.fixture.gpio', 'oep.fixture.uart',
    'oep.fixture.logic', 'oep.fixture.i2c-target', 'oep.fixture.spi-target']));
  const one = await dump.collect(hst, 'oep.fixture.spi-target', true);
  assert.deepEqual(one.offers.map((o) => o.entry.name), ['oep.fixture.spi-target']);
  assert.deepEqual(one.offers[0].description.groups.get(2)?.[0], [1, 14]);
  assert.deepEqual(dump.describeOffer(one.offers[0]).pinGroups?.['1'], { SCK: 18, MOSI: 19, MISO: 5, CS: 4 });
}));

test('p4 follows the agreed names; text and JSON', { skip: !haveFake }, () => withFake('p4-x035', async (hst) => {
  const caps = await dump.collect(hst);
  const byName = new Map(caps.offers.map((o) => [o.entry.name, o]));
  assert.equal(caps.offers.length, 13);
  assert.equal(caps.requests.list, 1);
  assert.equal(caps.requests.describe, 13);
  assert.deepEqual(new Set(['oep.wire.rvswd', 'oep.target.riscv-dm', 'oep.target.console'].map((n) => byName.get(n)?.entry.instance)), new Set([1]));
  assert.deepEqual(byName.get('oep.wire.rvswd')?.description.groups.get(1), [[1, 2], [2, 54]]);
  const i2c = /** @type {dump.Offer} */ (byName.get('oep.fixture.i2c-target'));
  assert.deepEqual(i2c.description.roles.get(1), i2c.description.roles.get(2));
  assert.ok(!i2c.description.roles.get(1)?.includes(2));           // reserved for RVSWD
  const text = dump.toText(caps);
  assert.match(text, /^OEP revision 1, max frame 1024 bytes; 13 interfaces in 1 list and 13 describe requests\n/);
  assert.ok(text.includes('instance 6') && text.includes('oep.fixture.i2c-target'));
  assert.ok(text.includes('features: preloaded tx, clock stretching'));
  assert.ok(text.includes('max 5 MHz'));
  assert.ok(text.includes('unit id: 30eda0e31108') && text.includes('chip: esp32p4 v1.0'));
  assert.ok(text.includes('oep.fixture.analog  rev 1   (not known to this host)'));
  const data = JSON.parse(dump.toJson(caps));
  assert.equal(data.maxFrame, 1024);
  assert.equal(data.interfaces.length, 13);
  assert.equal(data.interfaces[1].roles, undefined);                // rvswd declares a fixed pin set, not roles
  assert.deepEqual(data.interfaces[1].pinGroups['1'], { SWDIO: 2, SWCLK: 54 });
}));

test('a board whose wire takes any pins', { skip: !haveFake }, () => withFake('rp2350-pins', async (hst) => {
  const caps = await dump.collect(hst);
  const wire = dump.describeOffer(caps.offers[1]);
  assert.equal(wire.name, 'oep.wire.rvswd');
  assert.deepEqual(wire.roles, { SWDIO: '0-18,20-29', SWCLK: '0-18,20-29', reset: '0-18,20-29' });
  assert.ok(!caps.offers.some((o) => o.entry.name === 'oep.probe.config'));
}));
