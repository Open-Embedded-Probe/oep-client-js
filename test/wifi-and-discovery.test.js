// @ts-check
// The wifi item (oep-spec probe.config §1.4, §3.3; host guide §15.1) against oep-client-python's virtual bench
// (esp32-v003 declares wifi, wifi_max 4), and TCP discovery (transports §3, host guide §4.1: src/node/discovery.js and
// openTcp without a port). Mirrors oep-client-python's tests/test_wifi_and_tcp_discovery.py where this client has the
// part (no CLI, no environment entries).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import * as config from '../src/config.js';
import { Label, ProbeConfig, Wifi, WifiState, KEEP } from '../src/config.js';
import { Rejected } from '../src/errors.js';
import * as m from '../src/message.js';
import * as discovery from '../src/node/discovery.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const PASS = 'correct horse 1';
const skip = !haveVirtualBench && 'no oep-client-python virtual bench';

/** @param {string[]} args @param {(hst: import('../src/host.js').Host, bench: { send: (line: string) => void }) => Promise<void>} body */
async function withV003(args, body) {
  const bench = await startVirtualBench(['--profile', 'esp32-v003', ...args]);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    await body(hst, bench);
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

/** @param {number} detail */
const refused = (detail) => (/** @type {unknown} */ e) => e instanceof Rejected && e.result.detail === detail;
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the item ------------------------------------------------------------------------------------------------------

test('wifi: the value, get\'s form, decode, and the passphrase never shown', () => {
  const w = new Wifi({ index: 0, ssid: 'lab', passphrase: 'password1' });
  assert.deepEqual([...w.value()], [0, 3, ...Buffer.from('lab'), 9, ...Buffer.from('password1')]);   // the vector's
  assert.deepEqual([...new Wifi({ index: 0, ssid: 'lab', passphrase: KEEP }).value()], [0, 3, ...Buffer.from('lab'), 0xff]);
  assert.deepEqual([...new Wifi({ index: 2, ssid: 'open' }).value()], [2, 4, ...Buffer.from('open'), 0]);
  assert.deepEqual([...config.wifiGetForm(w.value())], [0, 3, ...Buffer.from('lab'), 0xff]);
  for (const shown of [String(w), inspect(w), inspect([w], { depth: 5 }), JSON.stringify(w), JSON.stringify({ w })]) {
    assert.ok(!shown.includes('password1') && shown.includes('set'), shown);
  }
  assert.equal(String(new Wifi({ index: 1, ssid: 'x' })), 'Wifi(index=1, ssid="x", passphrase=none)');
  const back = /** @type {Wifi} */ (config.decode(config.ITEM.wifi, config.wifiGetForm(w.value())));
  assert.deepEqual([back.index, back.ssid, back.passphrase, back.hasPassphrase], [0, 'lab', KEEP, true]);
  // a passphrase a probe sent anyway is kept for sending back, never shown
  const leaked = /** @type {Wifi} */ (config.decode(config.ITEM.wifi, w.value()));
  assert.ok(!inspect(leaked).includes('password1') && leaked.hasPassphrase);
  // 64 hex digits are a key; other forms are refused before sending, without the passphrase in the message
  new Wifi({ index: 0, ssid: 'psk', passphrase: '0123456789abcdef'.repeat(4) }).value();
  for (const bad of ['secret7', 'x'.repeat(64), 'é'.repeat(10), 'tab\there!', 'g'.repeat(64)]) {
    assert.throws(() => new Wifi({ index: 0, ssid: 'x', passphrase: bad }).value(), (e) => e instanceof RangeError && !e.message.includes(bad));
  }
  assert.throws(() => new Wifi({ index: 0, ssid: 'x'.repeat(33) }).value(), RangeError);
  assert.throws(() => new Wifi({ index: 0, ssid: '' }).value(), RangeError);
  assert.throws(() => new Wifi({ index: 255, ssid: 'x' }).value(), RangeError);
  // unset's key: index(u8), len the key's bytes (probe.config §2)
  assert.deepEqual([...config.remove('wifi', 3).encoded()], [1, config.ITEM.wifi, 3]);
  // sameItems compares as get shows it: whether a passphrase is set counts, not which
  assert.ok(config.sameItems([w], [new Wifi({ index: 0, ssid: 'lab', passphrase: 'another one' })]));
  assert.ok(config.sameItems([w], [new Wifi({ index: 0, ssid: 'lab', passphrase: KEEP })]));
  assert.ok(!config.sameItems([w], [new Wifi({ index: 0, ssid: 'lab' })]));
  assert.ok(!config.sameItems([w], [new Wifi({ index: 0, ssid: 'lab2', passphrase: 'password1' })]));
});

test('wifi state: the 8-byte TLV', () => {
  assert.deepEqual(WifiState.unpack(Uint8Array.of(2, 0, 0, 0xcc, 192, 168, 1, 23)), new WifiState('connected', 0, 'none', -52, '192.168.1.23'));
  assert.deepEqual(WifiState.unpack(Uint8Array.of(0, 0xff, 0, 0, 0, 0, 0, 0)), new WifiState('off', null, 'none', null, null));
  const waiting = WifiState.unpack(Uint8Array.of(3, 0xff, 2, 0, 0, 0, 0, 0));
  assert.deepEqual(waiting, new WifiState('waiting', null, 'auth', null, null));
  assert.equal(waiting.text(), 'waiting, reason auth');
  assert.equal(WifiState.unpack(Uint8Array.of(1, 1, 3, 0, 0, 0, 0, 0)).reason, 'no-address');
});

test('wifi on the virtual bench: write-only passphrase, get sent back keeps it, refusals', { skip }, () => withV003([], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  const decl = await cfg.describe();
  assert.ok(decl.items.includes(config.ITEM.wifi));
  assert.equal(decl.wifiMax, 4);
  const h0 = (await cfg.get()).hash;
  const h1 = await cfg.set([new Wifi({ index: 0, ssid: 'lab', passphrase: PASS }), new Wifi({ index: 1, ssid: 'cafe' })]);
  assert.notEqual(h1, h0);
  const raw = (await cfg.get()).items.map(([, v]) => Buffer.from(v).toString('latin1')).join('');
  assert.ok(!raw.includes(PASS));
  const items = await cfg.items();
  assert.deepEqual(items.map((i) => String(i)), ['Wifi(index=0, ssid="lab", passphrase=set)', 'Wifi(index=1, ssid="cafe", passphrase=none)']);
  assert.equal(await cfg.set(/** @type {config.Item[]} */ (items)), h1);          // get's items sent back: nothing changes
  const h2 = await cfg.set([new Wifi({ index: 0, ssid: 'lab2', passphrase: KEEP })]);   // ssid only: passphrase kept
  assert.notEqual(h2, h1);
  assert.notEqual(await cfg.set([new Wifi({ index: 0, ssid: 'lab2', passphrase: 'another one' })]), h2);
  assert.ok(config.sameItems(/** @type {config.Item[]} */ (await cfg.items()),
    [new Wifi({ index: 0, ssid: 'lab2', passphrase: 'whatever!' }), new Wifi({ index: 1, ssid: 'cafe' })]));
  // refusals: 0xFF without the entry malformed, an index at wifi_max unsupported with the item's tag
  await assert.rejects(cfg.set([new Wifi({ index: 2, ssid: 'x', passphrase: KEEP })]), refused(m.REJECT.malformed));
  await assert.rejects(cfg.set([new Wifi({ index: 4, ssid: 'x' })]),
    (e) => refused(m.REJECT.unsupported)(e) && /** @type {Rejected} */ (e).result.payload[0] === config.ITEM.wifi);
  await assert.rejects(cfg.set([m.tlv(config.ITEM.wifi, Uint8Array.of(0, 1, 0x61, 7, ...Buffer.from('1234567')))]), refused(m.REJECT.malformed));
  assert.ok(await cfg.unset([['wifi', 0], ['wifi', 1]]));
  assert.deepEqual(await cfg.items(), []);
  await hst.end();
}));

test('wifi on the virtual bench: apply sends a passphrase only for an entry that changes (host guide §15.1)', { skip }, () => withV003([], async (hst) => {
  const cfg = await ProbeConfig.open(hst);
  /** @type {Uint8Array[]} */
  const sets = [];
  const request = hst.request.bind(hst);
  hst.request = /** @type {any} */ (async (/** @type {number} */ fn, /** @type {number} */ op, /** @type {Uint8Array} */ payload, /** @type {any} */ o) => {
    if (fn === cfg.fn && op === ProbeConfig.SET) sets.push(payload);
    return request(fn, op, payload, o);
  });
  const lab = new Wifi({ index: 0, ssid: 'lab', passphrase: PASS });
  assert.ok(await cfg.apply([lab]));
  assert.ok(!(await cfg.apply([lab])));                                     // the same ssid and presence: nothing sent
  assert.equal(sets.length, 1);
  assert.ok(Buffer.from(sets[0]).includes(PASS));
  assert.ok(await cfg.apply([lab, new Label({ channel: 4, text: 'x' })]));   // something else differs: lab goes as 0xFF
  const sent = Buffer.from(sets[1]);
  assert.ok(!sent.includes(PASS) && sent.includes(Buffer.from(m.tlv(config.ITEM.wifi, Uint8Array.of(0, 3, ...Buffer.from('lab'), 0xff)))));
  assert.ok(await cfg.apply([new Wifi({ index: 0, ssid: 'lab' })]));        // now open: no passphrase, and the label unset
  assert.deepEqual((await cfg.items()).map(String), ['Wifi(index=0, ssid="lab", passphrase=none)']);
  await hst.end();
}));

test('wifi on the virtual bench: the state follows the simulated link', { skip }, () => withV003(
  ['--wifi-air', `lab=${PASS}`, '--wifi-join-ms', '100', '--wifi-ip', '192.168.1.23'], async (hst) => {
    const cfg = await ProbeConfig.open(hst);
    assert.deepEqual((await cfg.state()).wifi, new WifiState('off', null, 'none', null, null));
    await cfg.set([new Wifi({ index: 0, ssid: 'far away', passphrase: PASS }), new Wifi({ index: 1, ssid: 'lab', passphrase: PASS })]);
    const first = /** @type {WifiState} */ ((await cfg.state()).wifi);
    assert.equal(first.state, 'connecting');
    let st = first;
    for (let i = 0; i < 50 && st.state !== 'connected'; i++) { await sleep(50); st = /** @type {WifiState} */ ((await cfg.state()).wifi); }
    assert.deepEqual([st.state, st.entry, st.ipv4], ['connected', 1, '192.168.1.23']);
    assert.ok(st.rssi !== null && st.rssi < 0 && st.text().includes('ip 192.168.1.23'));
    await cfg.unset([['wifi', 0], ['wifi', 1]]);
    assert.equal((await cfg.state()).wifi?.state, 'off');
    await hst.end();
  }));

test('a probe without the wifi item: no wifiMax, no wifi state, the item unsupported', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'p4-bench']);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    const cfg = await ProbeConfig.open(hst);
    assert.equal((await cfg.describe()).wifiMax, 0);
    assert.equal((await cfg.state()).wifi, null);
    await assert.rejects(cfg.set([new Wifi({ index: 0, ssid: 'x' })]), refused(m.REJECT.unsupported));
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
});

// ---- TCP discovery (transports §3) ---------------------------------------------------------------------------------

/** @param {string} name @param {number} type @param {number[]} rdata */
function rr(name, type, rdata) {
  return [...discovery.encodeName(name), type >> 8, type & 0xff, 0x80, 0x01, 0, 0, 0x11, 0x94, rdata.length >> 8, rdata.length & 0xff, ...rdata];
}

/** A responder's answer: PTR, SRV, TXT (unit_id and another key) and A. */
function announcement(unitId = 'fafe00000003', host = 'oep-fafe00000003.local.', port = 7450, ip = [192, 168, 1, 23]) {
  const inst = `OEP ${unitId}._oep._tcp.local.`;
  const txt = [...Buffer.from(`unit_id=${unitId}`)];
  return Uint8Array.from([0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0,
    ...rr(discovery.SERVICE, discovery.T_PTR, discovery.encodeName(inst)),
    ...rr(inst, discovery.T_SRV, [0, 0, 0, 0, port >> 8, port & 0xff, ...discovery.encodeName(host)]),
    ...rr(inst, discovery.T_TXT, [txt.length, ...txt, 9, ...Buffer.from('extra=yes')]),
    ...rr(host, discovery.T_A, ip)]);
}

test('discovery: a response is read into unit_id, host, port, address; a query is no answer', () => {
  const b = new discovery.Browser();
  assert.deepEqual(b.questions(), [[discovery.SERVICE, discovery.T_PTR]]);
  b.feed(announcement());
  const [f] = b.found();
  assert.deepEqual([f.instance, f.unitId, f.host, f.port, f.addresses, f.txt.extra],
    ['OEP fafe00000003', 'fafe00000003', 'oep-fafe00000003.local.', 7450, ['192.168.1.23'], 'yes']);
  assert.deepEqual(discovery.targetOf(f), { host: '192.168.1.23', port: 7450 });
  assert.deepEqual(b.questions(), [[discovery.SERVICE, discovery.T_PTR]]);   // nothing missing
  const q = discovery.query([[discovery.SERVICE, discovery.T_PTR]], 7);
  assert.deepEqual([...q.slice(0, 12)], [0, 7, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...q.slice(-4)], [0, 12, 0x80, 0x01]);                  // PTR, IN with the QU bit
  assert.deepEqual(discovery.records(q), []);
  assert.deepEqual(discovery.records(announcement().slice(0, 40)), []);      // cut short: nothing half-read
});

test('discovery: missing records are asked for', () => {
  const b = new discovery.Browser();
  b.instances.add('OEP x._oep._tcp.local.');
  const qs = b.questions().map(([n, t]) => `${n}/${t}`);
  assert.ok(qs.includes(`OEP x._oep._tcp.local./${discovery.T_SRV}`) && qs.includes(`OEP x._oep._tcp.local./${discovery.T_TXT}`));
  b.srv.set('oep x._oep._tcp.local.', ['oep-x.local.', 7450]);
  assert.ok(b.questions().some(([n, t]) => n === 'oep-x.local.' && t === discovery.T_A));
  const [f] = b.found();
  assert.equal(f.unitId, null);
  assert.deepEqual(discovery.targetOf(f), { host: 'oep-x.local', port: 7450 });
});

test('discovery: findUnit and portOf on what a browse gives', async () => {
  const b = new discovery.Browser();
  b.feed(announcement('fafe00000003', 'oep-fafe00000003.local.', 7451, [127, 0, 0, 1]));
  const look = async () => b.found();
  assert.equal((await discovery.findUnit('FAFE00000003', { browse: look })).port, 7451);
  await assert.rejects(discovery.findUnit('other', { browse: look }), /no probe with unit_id other/);
  for (const host of ['oep-fafe00000003.local', 'oep-fafe00000003', '127.0.0.1']) assert.equal(await discovery.portOf(host, { browse: look }), 7451);
  assert.equal(await discovery.portOf('10.0.0.9', { browse: look }), null);
});

test('discovery: a real browse ends by its time and finds no probe that is not there', async () => {
  const t0 = Date.now();
  const found = await discovery.browse({ timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(Array.isArray(found) && !found.some((f) => f.unitId === 'no-such-unit-id'));
});

test('openTcp: no port is fixed - none given and none found throws, naming host and port', async () => {
  await assert.rejects(openTcp(/** @type {any} */ ({})), /give \{ host, port \}/);
  await assert.rejects(openTcp({ host: '10.255.255.1', findTimeoutMs: 200 }), /no port given and none announced/);
  await assert.rejects(openTcp({ unitId: 'no-such-unit-id', findTimeoutMs: 200 }), /no probe with unit_id no-such-unit-id/);
});

test('discovery: browse asks and reads a responder on this host (mDNS loopback)', async (t) => {
  const { createSocket } = await import('node:dgram');
  const responder = createSocket({ type: 'udp4', reuseAddr: true });
  let asked = 0;
  responder.on('message', (msg, from) => {
    if (msg[2] & 0x80) return;                                               // an answer, not a query
    asked++;
    responder.send(announcement('fafe0000ab01', 'oep-fafe0000ab01.local.', 7454, [127, 0, 0, 1]), from.port, from.address);
  });
  const ready = await new Promise((resolve) => {
    responder.once('error', () => resolve(false));
    responder.bind(discovery.MDNS_PORT, () => {
      try { responder.addMembership(discovery.MDNS_GROUP); resolve(true); } catch { resolve(false); }
    });
  });
  try {
    if (!ready) { t.skip('5353 or the mDNS group is not open to this test here'); return; }
    const found = await discovery.browse({ timeoutMs: 800 });
    assert.ok(asked >= 1);
    const f = found.find((x) => x.unitId === 'fafe0000ab01');
    assert.ok(f, JSON.stringify(found));
    assert.deepEqual(discovery.targetOf(f), { host: '127.0.0.1', port: 7454 });
  } finally {
    try { responder.close(); } catch { /* closed */ }
  }
});
