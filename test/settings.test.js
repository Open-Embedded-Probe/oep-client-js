// @ts-check
// The settings (src/settings.js; oep-spec core §13): fn 0's get / set / unset / save / state / network, the items by
// name (core §13.3), the origins (§13.4), the generation, the network, the settings file and the label convention
// (host guide §5.3), against oep-client-python's virtual bench over TCP; mirrors its tests/test_settings.py as far as the
// wire shows (no reboot, no inner state, no CLI).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat } from '../src/bytes.js';
import * as core from '../src/core.js';
import * as settings from '../src/settings.js';
import { CORE_CATEGORY as CORE, Settings } from '../src/settings.js';
import { Rejected, Unavailable, Unsupported } from '../src/errors.js';
import * as m from '../src/message.js';
import { CORE as C, DESCRIBE_COMMON } from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = !haveVirtualBench;
const D = C.tlv.describe, CHOICE = DESCRIBE_COMMON.setting_choice;

/** @param {string[]} args @param {(st: Settings, hst: import('../src/host.js').Host) => Promise<void>} body */
async function withSettings(args, body) {
  const bench = await startVirtualBench(args);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    await body(new Settings(hst), hst);
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

/** @param {number} detail */
const refused = (detail) => (/** @type {unknown} */ e) => e instanceof Rejected && e.result.detail === detail;

/** The virtual bench's channels are named as an RP2's / ESP32's (core §7.5). @param {number} n */
const ch = (n) => `GPIO${n}`;
/** @param {number} n */ const label = (n) => `channel.${ch(n)}.label`;
/** @param {number} n */ const idle = (n) => `channel.${ch(n)}.idle`;
/** @param {number} n */ const disable = (n) => `channel.${ch(n)}.disable`;

/** The user values as { "category name": value }. @param {Settings} st */
async function user(st) {
  return Object.fromEntries((await st.show()).filter((r) => r.origin === 'user').map((r) => [`${r.category} ${r.name}`, r.value]));
}

/** An item's number on the wire, by name. @param {Settings} st @param {string} name @param {number} [fn] */
async function number(st, name, fn = m.CORE_FN) {
  const it = (await st.catalog()).items.get(fn)?.find((i) => i.name === name);
  assert.ok(it, name);
  return it.number;
}

// ---- offline -------------------------------------------------------------------------------------------------------

test('the catalog: categories, the items and their choices, flat names both ways (core §13.2, §13.3)', () => {
  const W = (/** @type {(w: Writer) => Writer} */ f) => f(new Writer()).done();
  const fn0 = /** @type {[number, Uint8Array][]} */ ([
    [D.channel_name, concat(W((w) => w.u16(14)), new TextEncoder().encode('GPIO14'))],
    [D.transport, Uint8Array.of(0, 2, 0xff)], [D.transport, Uint8Array.of(1, 6, 0xff)],
    [D.netif, new TextEncoder().encode('wifi')],
    setting('channel.{}.label', 'text', 'channel', 0, 32), setting('channel.{}.idle', 'enum', 'channel'),
    [CHOICE, Uint8Array.of(2, 1, ...new TextEncoder().encode('pull-up'))],
    setting('wifi.{}.ssid', 'text', 'index', 4, 32), setting('ipv4.{}.address', 'ipv4', 'netif'),
  ]);
  const uart = /** @type {[number, Uint8Array][]} */ ([setting('passthrough.{}.rx', 'channel', 'transport'), setting('passthrough.{}.baud', 'u32', 'transport')]);
  const cat = new settings.Catalog(fn0, [{ fn: 3, name: 'oep.fixture.uart', instance: 0, tlvs: uart }]);
  assert.deepEqual([...cat.route.values()], ['cdc0', 'tcp0']);
  const [it, key] = /** @type {[settings.Item, number]} */ (cat.resolve(CORE, 'channel.GPIO14.idle'));
  assert.deepEqual([it.number, key, cat.toJson(it, Uint8Array.of(1)), [...cat.fromJson(it, 'pull-up')]], [2, 14, 'pull-up', [1]]);
  assert.deepEqual(cat.resolve(CORE, 'wifi.3.ssid')?.[1], 3);
  assert.equal(cat.resolve(CORE, 'wifi.4.ssid'), null);                 // past keys
  assert.equal(cat.resolve(CORE, 'channel.GPIO15.label'), null);        // no such channel
  const [rx, k] = /** @type {[settings.Item, number]} */ (cat.resolve('oep.fixture.uart/0', 'passthrough.cdc0.rx'));
  assert.deepEqual([rx.fn, k, [...cat.fromJson(rx, 'GPIO14')]], [3, 0, [14, 0]]);
  const [ip] = /** @type {[settings.Item, number]} */ (cat.resolve(CORE, 'ipv4.wifi.address'));
  assert.deepEqual([...cat.fromJson(ip, '192.168.1.9')], [192, 168, 1, 9]);
  for (const bad of ['192.168.1', '1.2.3.256', 7]) assert.throws(() => cat.fromJson(ip, bad), RangeError);
  assert.throws(() => cat.fromJson(it, 'strong'), RangeError);           // a choice it does not declare
  assert.throws(() => settings.checkFile({ oep_settings: 2, settings: {} }), RangeError);
});

/** One describe setting: form key_kind keys(u16) max_len flags name. @param {string} name @param {string} form
 * @param {string} kind @param {number} [keys] @param {number} [maxLen] @returns {[number, Uint8Array]} */
function setting(name, form, kind, keys = 0, maxLen = 0) {
  return [DESCRIBE_COMMON.setting, concat(new Writer().u8(/** @type {Record<string, number>} */ (C.enum.setting_form)[form]).u8(/** @type {Record<string, number>} */ (C.enum.setting_key_kind)[kind]).u16(keys)
    .u8(maxLen).u8(0).done(), new TextEncoder().encode(name))];
}

test('the label convention: <port>.<name>, and the bare name while one port is named (host guide §5.3)', async () => {
  /** @type {[number, string][]} */
  const labels = [[3, 'A.NRST'], [4, 'nrst'], [5, 'power_hi'], [6, 'b.power_hi']];
  assert.equal(await settings.findLine(labels, 'nrst', { profile: 'a', single: false }), 3);
  assert.equal(await settings.findLine(labels, 'nrst'), null);          // ports a and b named: "N" names nothing
  assert.equal(await settings.findLine(labels, 'nrst', { single: true }), 4);   // the host says there is one target
  assert.equal(await settings.findLine(labels, 'nrst', { profile: 'b', single: false }), null);
  /** @type {[number, string][]} */
  const two = [[7, 'a.swdio'], [8, 'b.swdio'], [9, 'nrst']];
  assert.deepEqual(settings.portsNamed(two), ['a', 'b']);
  assert.equal(await settings.findLine(two, 'nrst', { profile: 'a' }), null);
  assert.equal(await settings.findLine([two[0], two[2]], 'nrst', { profile: 'a' }), 9);
  assert.equal(await settings.findLine(labels, 'power_hi', { profile: 'b', single: false }), 6);
  assert.equal(await settings.findLine([...labels, [7, 'NRST']], 'nrst', { single: true }), null);   // ambiguous
  assert.deepEqual([...settings.LINE_NAMES], Object.keys(C.line_names));   // from the registry
});

// ---- on the virtual bench ------------------------------------------------------------------------------------------

test('values round trip with the generation; the same contents change nothing (core §13.5)', { skip }, () => withSettings(['--profile', 'p4-bench'], async (st) => {
  assert.deepEqual(await user(st), {});
  assert.equal((await st.get()).generation, 1);
  assert.equal(await st.setNamed(CORE, { [label(20)]: 'DUT TX', [idle(21)]: 'pull-up', [disable(30)]: true }), 2);
  assert.deepEqual(await user(st), { [`core ${label(20)}`]: 'DUT TX', [`core ${idle(21)}`]: 'pull-up', [`core ${disable(30)}`]: true });
  const order = (await st.get()).values.map((v) => [v.fn, v.number, v.key]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
  assert.equal(await st.setNamed(CORE, { [label(20)]: 'DUT TX' }), 2);  // the same contents: no change
  assert.equal(await st.unsetNamed(CORE, [idle(21), idle(22)]), 3);      // a value not there: nothing
  assert.equal(await st.unsetNamed(CORE, [disable(30)]), 4);
  assert.deepEqual(await user(st), { [`core ${label(20)}`]: 'DUT TX' });
  assert.equal(await st.set([]), 4);                                     // count 0: no change
  await assert.rejects(st.setNamed(CORE, { 'channel.GPIO999.label': 'x' }), /no item/);   // not on this probe: refused here
}));

test('a refused set changes nothing; unsupported says which value (core §13.5)', { skip }, () => withSettings(['--profile', 'p4-bench'], async (st, hst) => {
  await st.setNamed(CORE, { [idle(21)]: 'pull-up' });
  const before = await st.get();
  const nIdle = await number(st, 'channel.{}.idle'), nLabel = await number(st, 'channel.{}.label');
  await assert.rejects(st.set([[0, nIdle, 21, Uint8Array.of(2)], [0, nLabel, 0xfff0, Uint8Array.of(0x78)]]),
    (e) => e instanceof Unsupported && e.item === 1);                    // past the channels: the second value
  await assert.rejects(st.set([[0, nIdle, 21, Uint8Array.of(9)]]), (e) => e instanceof Unsupported && e.item === 0);   // a choice not declared
  await assert.rejects(st.setNamed(CORE, { [idle(40)]: 'pull-up', [disable(40)]: true }),
    (e) => e instanceof Unavailable && e.cause === 'held_by_settings' && JSON.stringify(e.channels) === '[40]');
  await core.planApply(hst, [[await core.find(hst, 'oep.fixture.gpio'), 1, 30]]);
  await assert.rejects(st.setNamed(CORE, { [disable(30)]: true }), (e) => e instanceof Unavailable && e.cause === 'pin_in_use');
  assert.deepEqual(await st.get(), before);
}));

test('forms and numbers: malformed, unsupported, unknown function (core §13.3, §13.5)', { skip }, () => withSettings(['--profile', 'p4-bench'], async (st) => {
  const nIdle = await number(st, 'channel.{}.idle'), nDisable = await number(st, 'channel.{}.disable'), nLabel = await number(st, 'channel.{}.label');
  for (const values of /** @type {settings.SetRow[][]} */ ([[[0, nIdle, 20, Uint8Array.of(1, 0)]], [[0, 0, 20, Uint8Array.of(1)]],
    [[0, nIdle, 20, Uint8Array.of(1)], [0, nIdle, 20, Uint8Array.of(2)]], [[0, nDisable, 20, Uint8Array.of(2)]],
    [[0, nLabel, 20, new Uint8Array()]]])) {
    await assert.rejects(st.set(values), refused(m.REJECT.malformed), JSON.stringify(values));
  }
  await assert.rejects(st.set([[0, 99, 20, Uint8Array.of(1)]]), (e) => e instanceof Unsupported && e.item === 0);
  await assert.rejects(st.set([[77, 1, 0, Uint8Array.of(1)]]), refused(m.REJECT.unknown_function));
  assert.equal((await st.get()).generation, 1);
}));

test('fixed labels: shown, refused to set or unset, not exported; firmwareLabels (core §13.4)', { skip }, () => withSettings(['--profile', 'p4-x035'], async (st, hst) => {
  const shown = (await st.show()).find((r) => r.name === label(2));
  assert.deepEqual([shown?.value, shown?.origin], ['SWDIO', 'fixed']);
  await assert.rejects(st.setNamed(CORE, { [label(2)]: 'other' }), Unsupported);
  await assert.rejects(st.unsetNamed(CORE, [label(2)]), Unsupported);
  assert.deepEqual((await st.export()).settings, {});
  assert.deepEqual((await core.firmwareLabels(hst)).slice(0, 2), [[2, 'SWDIO'], [51, 'LED']]);
  assert.equal(await settings.findLine(hst, 'swdio'), 2);               // the fixed labels count (host guide §5.3)
}));

test('save and state; needsSave; unset all then save empties the storage (core §13.7)', { skip }, () => withSettings(['--profile', 'p4-bench'], async (st) => {
  assert.deepEqual(await st.state(), { storage: 'none', savedGeneration: 0, reason: null });
  await st.setNamed(CORE, { [disable(20)]: true, [idle(21)]: 'pull-down', [label(22)]: 'X' });
  assert.equal(await st.needsSave(), true);
  assert.equal(await st.save(), 2);
  assert.deepEqual(await st.state(), { storage: 'applied', savedGeneration: 2, reason: null });
  assert.equal(await st.needsSave(), false);
  assert.equal(await st.unsetAll(), 3);
  await st.save();
  assert.deepEqual(await user(st), {});
  assert.equal(await st.unsetAll(), null);                               // nothing of the user's left
}));

test('get is paged at a small frame (core §13.5)', { skip }, () => withSettings(['--profile', 'esp32-v003-64'], async (st) => {
  const values = Object.fromEntries([4, 5, 13, 14, 17, 18, 19].map((n) => [label(n), `LINE${n}`]));
  let gets = 0, sets = 0;
  const call = st.call.bind(st);
  st.call = (op, body, opts) => { if (op === 'get') gets++; if (op === 'set') sets++; return call(op, body, opts); };
  await st.setNamed(CORE, values);
  assert.ok(sets > 1);                                                   // past one 64-byte frame: several sets
  gets = 0;
  assert.deepEqual(await user(st), Object.fromEntries(Object.entries(values).map(([k, v]) => [`core ${k}`, v])));
  assert.ok(gets > 1);                                                   // more than one page
}));

test('the passphrase is a secret: never read, 0 bytes keep it (core §13.5)', { skip }, () => withSettings(['--profile', 'esp32-v003'], async (st) => {
  const [off] = (await st.network()).netifs;
  assert.deepEqual([off.netif, off.state, off.entry, off.address], ['wifi', 'off', null, null]);   // no entries: off
  await st.setNamed(CORE, { 'wifi.0.ssid': 'lab', 'wifi.0.passphrase': 'password1' });
  assert.deepEqual((await st.show()).find((r) => r.name === 'wifi.0.passphrase')?.value, { secret: true });
  const n = await number(st, 'wifi.{}.passphrase');
  const v = (await st.get()).values.find((x) => x.number === n);
  assert.deepEqual(v?.data, new Uint8Array());
  await st.set([[0, n, 0, new Uint8Array()]]);                           // 0 bytes: kept
  const [row] = (await st.network()).netifs;
  assert.deepEqual([row.state, row.entry, row.reason, row.address], ['up', 0, 'none', '192.168.1.23/24']);   // DHCP
  assert.ok(row.rssi < 0);
  await assert.rejects(st.set([[0, n, 1, new Uint8Array()]]), refused(m.REJECT.malformed));   // nothing there to keep
  for (const bad of ['short', 'x'.repeat(64)]) await assert.rejects(st.setNamed(CORE, { 'wifi.1.passphrase': bad }), refused(m.REJECT.malformed));
  assert.ok(!(JSON.stringify(await st.export()).includes('password1')));
}));

test('ipv4: a static address in use; an address a host cannot have is malformed (core §13.6)', { skip }, () => withSettings(['--profile', 'esp32-v003'], async (st) => {
  await st.setNamed(CORE, { 'wifi.0.ssid': 'lab', 'wifi.0.passphrase': 'password1' });
  await st.setNamed(CORE, { 'ipv4.wifi.mode': 'static', 'ipv4.wifi.address': '192.168.1.50', 'ipv4.wifi.prefix': '24' });
  assert.equal((await st.network()).netifs[0].address, '192.168.1.50/24');
  for (const values of [{ 'ipv4.wifi.address': '127.0.0.1' }, { 'ipv4.wifi.address': '0.0.0.0' }, { 'ipv4.wifi.prefix': 33 }, { 'ipv4.wifi.prefix': 0 }]) {
    await assert.rejects(st.setNamed(CORE, values), refused(m.REJECT.malformed), JSON.stringify(values));
  }
  await st.unsetNamed(CORE, ['ipv4.wifi.address']);                      // static without an address: none
  const [row] = (await st.network()).netifs;
  assert.deepEqual([row.state, row.reason], ['waiting', 'no_address']);
  await assert.rejects(st.setNamed(CORE, { 'ipv4.ethernet.mode': 'dhcp' }), /no item/);   // not a netif of this probe
}));

test('the network op only with netifs (transports §7.3)', { skip }, () => withSettings(['--profile', 'p4-bench'], async (st, hst) => {
  assert.equal(await st.offers('network'), false);
  await assert.rejects(hst.request(m.CORE_FN, settings.OP.network, new Uint8Array(), { locked: false }), refused(m.REJECT.unknown_operation));
}));

test('export and import through another probe (settings file §3, §4)', { skip }, async () => {
  /** @type {any} */
  let doc;
  /** @type {Record<string, unknown>} */
  let first = {};
  await withSettings(['--profile', 'p4-x035'], async (st) => {
    await st.setNamed(CORE, { [label(14)]: 'NRST', [idle(14)]: 'pull-up', [disable(30)]: true });
    await st.setNamed('oep.wire.rvswd/0', { 'hold.GPIO2': false });
    doc = await st.export();
    assert.deepEqual(doc.settings, { [CORE]: { [label(14)]: 'NRST', [idle(14)]: 'pull-up', [disable(30)]: true },
      'oep.wire.rvswd/0': { 'hold.GPIO2': false } });
    assert.equal(doc.probe.unit_id, 'fafe00000035');
    first = await user(st);
  });
  await withSettings(['--profile', 'p4-x035'], async (st) => {
    await st.setNamed(CORE, { [label(15)]: 'OLD' });
    const doc2 = JSON.parse(JSON.stringify(doc));
    doc2.settings['io.example.gone/0'] = { x: 1 };
    const plan = await st.planImport(doc2);
    assert.deepEqual([plan.unresolved, plan.sets.length, plan.unsets.length], [[['io.example.gone/0', 'x']], 4, 1]);
    await st.applyImport(plan);
    assert.deepEqual(await user(st), first);
  });
});
