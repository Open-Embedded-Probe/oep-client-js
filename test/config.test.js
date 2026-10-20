// @ts-check
// oep.probe.config (src/config.js): named items numbered by the probe's describe (probe.config §1, §4, core §7.7), the
// generation (§2), state and save (§3), the network items and network op (§1.3-§1.5, §2), a probe's own items (§1.6,
// §1.7) and the label convention (host guide §5.3), against oep-client-python's virtual bench over TCP; mirrors its
// tests/test_config.py and test_config_network.py as far as the wire shows (no reboot, no inner state, no CLI).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { Writer, concat, utf8 } from '../src/bytes.js';
import * as config from '../src/config.js';
import { Disable, Idle, Ipv4, KEEP, Label, ProbeConfig, Wifi } from '../src/config.js';
import { planApply } from '../src/core.js';
import { Rejected, Unavailable, Unsupported } from '../src/errors.js';
import * as m from '../src/message.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = !haveVirtualBench;

/** @param {string[]} args @param {(cfg: ProbeConfig, hst: import('../src/host.js').Host) => Promise<void>} body */
async function withConfig(args, body) {
  const bench = await startVirtualBench(args);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    await body(await ProbeConfig.open(hst), hst);
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

/** @param {number} detail */
const refused = (detail) => (/** @type {unknown} */ e) => e instanceof Rejected && e.result.detail === detail;

// ---- the items, offline --------------------------------------------------------------------------------------------

test('items: their data as the table says, and back by name (probe.config §1)', () => {
  const S = config.IDLE;
  assert.deepEqual([...new Idle({ channel: 21, mode: 'output_high' }).data()], [S['output-high']]);   // both spellings
  assert.deepEqual([...new Disable({ channel: 30 }).data()], []);
  const pass = new config.Passthrough({ port: 1, fn: 5, rx: 12, baud: 115200, format: 0 });
  assert.equal(pass.data().length, 9);                                 // fn rx baud format
  const cp = new config.ConsolePassthrough({ port: 0, wireFn: 1, swdio: 16, consoleFn: 3, mechanism: 3 });
  assert.equal(cp.data().length, 13);                                  // wire_fn swdio swclk max_speed console_fn mechanism
  for (const it of [new Label({ channel: 20, text: 'DUT TX' }), new Idle({ channel: 21 }), pass, cp,
    new config.RvswdRest({ channel: 54, mode: 'low' }), new config.WireHold({ channel: 2, mode: 'off' })]) {
    const name = /** @type {any} */ (it.constructor).NAME;
    assert.deepEqual(config.decode(name, it.key(), it.data()), it, name);
  }
  assert.deepEqual(config.decode('com.example.x', 0, Uint8Array.of(1)), ['com.example.x', 0, Uint8Array.of(1)]);   // not known: as it came
  assert.throws(() => new Idle({ channel: 1, mode: 'strong' }).data(), RangeError);
  assert.throws(() => new config.WireHold({ channel: 1, mode: 'maybe' }).data(), RangeError);
  assert.deepEqual(config.remove('console_passthrough', 1), new config.Removal('console-passthrough', 1));
});

test('wifi: the data, get\'s form, decode, and the passphrase never shown (probe.config §1.4)', () => {
  const w = new Wifi({ entry: 0, ssid: 'lab', passphrase: 'correct horse 1' });
  assert.deepEqual([...w.data()], [3, ...utf8('lab'), 15, ...utf8('correct horse 1')]);
  const asGet = config.wifiGetForm(w.data());
  assert.deepEqual([...asGet], [3, ...utf8('lab'), config.PASS_KEPT]);
  const back = /** @type {Wifi} */ (config.decode('wifi', 0, asGet));
  assert.deepEqual([back.entry, back.ssid, back.passphrase, back.hasPassphrase], [0, 'lab', KEEP, true]);
  assert.deepEqual([...new Wifi({ entry: 1, ssid: 'open' }).data()], [4, ...utf8('open'), 0]);   // an open network
  for (const shown of [String(w), JSON.stringify(w), inspect(w)]) assert.ok(!shown.includes('horse'), shown);
  assert.throws(() => new Wifi({ entry: 0, ssid: 'lab', passphrase: 'short7!' }).data(), (e) => e instanceof RangeError && !e.message.includes('short7'));
  assert.throws(() => new Wifi({ entry: 0, ssid: 'x'.repeat(config.SSID_MAX + 1) }).data(), RangeError);
});

test('ipv4: DHCP is 14 zero bytes, static a.b.c.d/prefix with gateway and dns (probe.config §1.5)', () => {
  const dhcp = new Ipv4({ netif: 'wifi' });
  assert.deepEqual([...dhcp.data()], Array(14).fill(0));
  const st = new Ipv4({ netif: 'wifi', address: '192.168.7.9/24', gateway: '192.168.7.1' });
  assert.deepEqual([...st.data()], [config.IPV4_MODE.static, 192, 168, 7, 9, 24, 192, 168, 7, 1, 0, 0, 0, 0]);
  const back = /** @type {Ipv4} */ (config.decode('ipv4', 1, st.data(), null, ['wifi']));
  assert.deepEqual([back.netif, back.address, back.gateway, back.dns], ['wifi', '192.168.7.9/24', '192.168.7.1', null]);
  assert.throws(() => new Ipv4({ address: '192.168.7/24' }).data(), RangeError);
});

test('the label convention: <port>.<name>, the bare name while one port is named, the firmware\'s label (host guide §5.3)', async () => {
  const labels = [new Label({ channel: 3, text: 'A.NRST' }), new Label({ channel: 4, text: 'nrst' }),
    new Label({ channel: 5, text: 'power_hi' }), new Label({ channel: 6, text: 'b.power_hi' })];
  assert.equal(await config.findLine(labels, 'nrst', { profile: 'a', single: false }), 3);
  assert.equal(await config.findLine(labels, 'nrst'), null);              // ports a and b named: "N" names nothing
  assert.equal(await config.findLine(labels, 'nrst', { single: true }), 4);   // the host says there is one target
  assert.equal(await config.findLine(labels, 'nrst', { profile: 'b', single: false }), null);
  const two = [new Label({ channel: 7, text: 'a.swdio' }), new Label({ channel: 8, text: 'b.swdio' }), new Label({ channel: 9, text: 'nrst' })];
  assert.deepEqual(config.portsNamed(two.map((l) => /** @type {[number, string]} */ ([l.channel, l.text]))), ['a', 'b']);
  assert.equal(await config.findLine(two, 'nrst', { profile: 'a' }), null);
  assert.equal(await config.findLine([two[0], two[2]], 'nrst', { profile: 'a' }), 9);
  assert.equal(await config.findLine(labels, 'power_hi', { profile: 'b', single: false }), 6);
  assert.equal(await config.findLine(labels, 'power_lo', { firmware: [[9, 'POWER_LO']], single: true }), 9);
  assert.equal(await config.findLine([...labels, new Label({ channel: 7, text: 'NRST' })], 'nrst', { single: true }), null);   // ambiguous
});

// ---- on the virtual bench ------------------------------------------------------------------------------------------

test('items round trip with the generation; the numbers are describe\'s (probe.config §1, §2)', { skip }, () => withConfig(['--profile', 'p4-bench'], async (cfg, hst) => {
  const decl = await cfg.describe();
  assert.deepEqual(decl.items.slice(0, 3), ['label', 'idle', 'disable']);
  assert.ok(decl.storageBytes > 0);
  assert.deepEqual(await cfg.get(), { generation: 1, items: [] });
  const wanted = [new Label({ channel: 20, text: 'DUT TX' }), new Idle({ channel: 21, mode: 'pull-up' }), new Disable({ channel: 30 })];
  const sent = /** @type {Uint8Array[]} */ ([]);
  const call = cfg.call.bind(cfg);
  cfg.call = (op, body, opts) => { if (op === ProbeConfig.SET) sent.push(/** @type {Uint8Array} */ (body)); return call(op, body, opts); };
  assert.equal(await cfg.set(wanted), 2);
  const wire = [];
  for (const it of wanted) wire.push(await cfg.wire(it));
  assert.deepEqual(sent[0], concat(Uint8Array.of(3), ...wire));        // count(u8) items, each number(u8) len(u16) key(u16) data
  assert.equal(sent[0][1], decl.byName('label').number);
  const items = await cfg.items();
  assert.deepEqual(items.map((it) => it.constructor), [Label, Idle, Disable]);
  assert.ok(config.sameItems(items, wanted) && !config.sameItems(items, wanted.slice(0, 2)));
  assert.equal(await cfg.set([new Label({ channel: 20, text: 'DUT TX' })]), 2);   // the same contents: no change
  assert.equal(await cfg.unset([['idle', 21], ['idle', 22]]), 3);      // a key not there: nothing
  assert.equal(await cfg.set([config.remove('disable', 30)]), 4);
  assert.deepEqual(await cfg.items(), [new Label({ channel: 20, text: 'DUT TX' })]);
  assert.equal(await cfg.apply([new Label({ channel: 20, text: 'DUT TX' })]), false);   // as wanted: nothing sent
  assert.equal(await cfg.apply([new Idle({ channel: 21, mode: 'hi-z' })]), true);
  assert.deepEqual(await cfg.items(), [new Idle({ channel: 21, mode: 'hi-z' })]);
  assert.ok(hst.session !== null);
}));

test('a refused set changes nothing (probe.config §1, §2)', { skip }, () => withConfig(['--profile', 'p4-bench'], async (cfg, hst) => {
  await cfg.set([new Idle({ channel: 21, mode: 'pull-up' })]);
  const before = await cfg.get();
  const label = (await cfg.describe()).byName('label').number;
  await assert.rejects(cfg.set([new Label({ channel: 0xfff0, text: 'x' })]), (e) => e instanceof Unsupported && e.tag === label);   // past channels
  await assert.rejects(cfg.set([new Disable({ channel: 21 })]),       // idle and disable on one channel: held by settings
    (e) => e instanceof Unavailable && e.cause === 'held_by_settings' && JSON.stringify(e.channels) === '[21]');
  await planApply(hst, [[await (await import('../src/core.js')).find(hst, 'oep.fixture.gpio'), 1, 30]]);
  await assert.rejects(cfg.set([new Disable({ channel: 30 })]), (e) => e instanceof Unavailable && e.cause === 'pin_in_use');   // in use: cause 1
  assert.deepEqual(await cfg.get(), before);
}));

test('an item of another length or number 0 is malformed, a number past the list unsupported (probe.config §1)', { skip }, () => withConfig(['--profile', 'p4-bench'], async (cfg, hst) => {
  const decl = await cfg.describe();
  const n = (/** @type {string} */ name) => decl.byName(name).number;
  /** @param {number} number @param {number} key @param {Uint8Array} data */
  const one = (number, key, data) => concat(Uint8Array.of(1), new Writer().u8(number).u16(2 + data.length).u16(key).done(), data);
  for (const body of [one(n('idle'), 21, Uint8Array.of(1, 0)), one(n('disable'), 21, Uint8Array.of(0)), one(0, 21, new Uint8Array()),
    concat(Uint8Array.of(2), one(n('disable'), 21, new Uint8Array()).slice(1), one(n('disable'), 21, new Uint8Array()).slice(1))]) {
    await assert.rejects(hst.call(cfg.fn, ProbeConfig.SET, body), refused(m.REJECT.malformed));
  }
  const past = decl.settings.length + 1;
  await assert.rejects(hst.call(cfg.fn, ProbeConfig.SET, one(past, 21, new Uint8Array())), (e) => e instanceof Unsupported && e.tag === past);
  assert.deepEqual(await cfg.get(), { generation: 1, items: [] });
}));

test('save and state: saved_generation is the generation saved; needsSave; erase (probe.config §3)', { skip }, () => withConfig(['--profile', 'p4-bench'], async (cfg) => {
  assert.deepEqual(await cfg.state(), { storage: 'none', savedGeneration: 0, reason: null });
  await cfg.set([new Idle({ channel: 21, mode: 'output-high' }), new Label({ channel: 21, text: 'power_hi' })]);
  assert.equal(await cfg.needsSave(), true);
  assert.equal(await cfg.save(), 2);
  assert.deepEqual(await cfg.state(), { storage: 'applied', savedGeneration: 2, reason: null });
  assert.equal(await cfg.needsSave(), false);
  await cfg.set([new Label({ channel: 21, text: 'power' })]);
  assert.equal(await cfg.needsSave(), true);
  assert.equal((await cfg.state()).savedGeneration, 2);
  assert.equal(await cfg.apply([new Label({ channel: 21, text: 'power' }), new Idle({ channel: 21, mode: 'output-high' })], { save: true }), true);
  assert.equal(await cfg.needsSave(), false);
  await cfg.erase();
  assert.deepEqual(await cfg.state(), { storage: 'none', savedGeneration: 0, reason: null });
}));

test('get is paged at a small frame; a set past max_frame is refused before sending (probe.config §2, §4)', { skip }, () => withConfig(['--profile', 'esp32-v003-64'], async (cfg) => {
  const labels = Array.from({ length: 8 }, (_, k) => new Label({ channel: 30 + k, text: `line ${30 + k}` }));   // channels the firmware does not use
  for (const it of labels) await cfg.set([it]);
  let gets = 0;
  const call = cfg.call.bind(cfg);
  cfg.call = (op, body, opts) => { if (op === ProbeConfig.GET) gets++; return call(op, body, opts); };
  assert.ok(config.sameItems(await cfg.items(), labels));
  assert.ok(gets > 1);                                                  // more than one page
  await assert.rejects(cfg.set(labels), /exceeds this transport's max_frame/);   // one set: past 64 bytes
  assert.ok(await cfg.set([new Label({ channel: 34, text: 'L'.repeat(config.LABEL_MAX) })]) > 0);   // the longest label fits 64 (§4)
}));

test('wifi on the bench: write-only, sent back as read changes nothing; pass_len 0xFF without the entry malformed (probe.config §1.4)', { skip }, () => withConfig(['--profile', 'esp32-v003'], async (cfg, hst) => {
  const [row0] = (await cfg.network()).netifs;
  assert.deepEqual([row0.netif, row0.state, row0.entry, row0.address], ['wifi', 'off', null, null]);   // no wifi item: off (§1.3)
  await cfg.set([new Wifi({ entry: 0, ssid: 'lab', passphrase: 'password1' })]);
  const it = /** @type {Wifi} */ ((await cfg.items()).find((x) => x instanceof Wifi));
  assert.deepEqual([it.entry, it.ssid, it.passphrase], [0, 'lab', KEEP]);
  const raw = (await hst.call(cfg.fn, ProbeConfig.GET, new Writer().u16(0).done(), { locked: false })).payload;
  assert.ok(!Buffer.from(raw).includes(Buffer.from('password1')));
  const { generation } = await cfg.get();
  assert.equal(await cfg.set([it]), generation);                       // sent back as read: nothing changes
  const [row] = (await cfg.network()).netifs;
  assert.deepEqual([row.state, row.entry, row.reason, row.address], ['up', 0, 'none', '192.168.1.23/24']);   // no ipv4 item: DHCP
  assert.ok(row.rssi < 0);
  assert.equal(await cfg.apply([new Wifi({ entry: 0, ssid: 'lab', passphrase: 'password1' })]), false);   // as get shows it: the same
  await assert.rejects(cfg.set([new Wifi({ entry: 2, ssid: 'lab', passphrase: KEEP })]), refused(m.REJECT.malformed));
}));

test('ipv4 on the bench: a static address in use; an address a host cannot have is malformed (probe.config §1.5)', { skip }, () => withConfig(['--profile', 'esp32-v003'], async (cfg) => {
  await cfg.set([new Wifi({ entry: 0, ssid: 'lab', passphrase: 'password1' }), new Ipv4({ netif: 'wifi', address: '192.168.7.9/24' })]);
  assert.equal((await cfg.network()).netifs[0].address, '192.168.7.9/24');
  const it = /** @type {Ipv4} */ ((await cfg.items()).find((x) => x instanceof Ipv4));
  assert.deepEqual([it.netif, it.address], ['wifi', '192.168.7.9/24']);
  for (const [address, gateway] of [['0.0.0.0/24', null], ['127.0.0.1/8', null], ['224.0.0.1/4', null], ['192.168.1.9/24', '10.0.0.1']]) {
    await assert.rejects(cfg.set([new Ipv4({ netif: 'wifi', address, gateway })]), refused(m.REJECT.malformed), String(address));
  }
  await assert.rejects(cfg.set([new Ipv4({ netif: 'ethernet' })]), /no netif "ethernet"/);   // not in describe: refused here
}));

test('the wired probe: ethernet up with no item (probe.config §1.3)', { skip }, () => withConfig(['--profile', 'p4-x035'], async (cfg) => {
  const net = await cfg.network();
  assert.ok(net.tcpPort >= 0);
  const [row] = net.netifs;
  assert.deepEqual([row.netif, row.state, row.entry, row.address], ['ethernet', 'up', null, '10.0.0.23/16']);
  assert.equal((await cfg.describe()).items.includes('wifi'), false);
}));
