// @ts-check
// TCP discovery (transports §3, host guide §4.1: src/node/discovery.js and openTcp without a port). Mirrors
// oep-client-python's tests/test_tcp_discovery.py where this client has the part (no CLI, no environment entries).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as discovery from '../src/node/discovery.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = !haveVirtualBench && 'no oep-client-python virtual bench';
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  assert.equal((await discovery.findUnit('FAFE00000003', { browse: look, verify: false })).port, 7451);
  await assert.rejects(discovery.findUnit('other', { browse: look }), /no probe with unit_id other/);
  for (const host of ['oep-fafe00000003.local', 'oep-fafe00000003', '127.0.0.1']) assert.equal(await discovery.portOf(host, { browse: look }), 7451);
  assert.equal(await discovery.portOf('10.0.0.9', { browse: look }), null);
});

test('discovery: the interfaces asked are every IPv4 address that is up and not internal', () => {
  const nets = /** @type {any} */ ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }, { family: 'IPv6', address: '::1', internal: true }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.19.48.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 4, address: '192.168.1.10', internal: false }],
    eth1: [{ family: 'IPv4', address: '192.168.1.10', internal: false }],
  });
  assert.deepEqual(discovery.interfaceAddresses(nets), ['172.19.48.1', '192.168.1.10']);
  assert.deepEqual(discovery.interfaceAddresses({}), []);
});

test('discovery: an interface that cannot send is left out, the others still ask', async () => {
  const found = await discovery.browse({ timeoutMs: 200, interfaces: ['203.0.113.7', ...discovery.interfaceAddresses()] });
  assert.ok(Array.isArray(found));
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
  /** @type {Set<string>} */
  const from_ = new Set();
  responder.on('message', (msg, from) => {
    if (msg[2] & 0x80) return;                                               // an answer, not a query
    asked++;
    from_.add(from.address);
    responder.send(announcement('fafe0000ab01', 'oep-fafe0000ab01.local.', 7454, [127, 0, 0, 1]), from.port, from.address);
  });
  const ready = await new Promise((resolve) => {
    responder.once('error', () => resolve(false));
    responder.bind(discovery.MDNS_PORT, () => {
      try { responder.addMembership(discovery.MDNS_GROUP); } catch { resolve(false); return; }
      for (const at of discovery.interfaceAddresses()) { try { responder.addMembership(discovery.MDNS_GROUP, at); } catch { /* joined */ } }
      resolve(true);
    });
  });
  try {
    if (!ready) { t.skip('5353 or the mDNS group is not open to this test here'); return; }
    const found = await discovery.browse({ timeoutMs: 800 });
    assert.ok(asked >= 1);
    const f = found.find((x) => x.unitId === 'fafe0000ab01');
    assert.ok(f, JSON.stringify(found));
    assert.deepEqual(discovery.targetOf(f), { host: '127.0.0.1', port: 7454 });
    // the query left by every IPv4 interface (each socket bound to its address), not by one adapter only
    for (const at of discovery.interfaceAddresses()) assert.ok(from_.has(at), `no query from ${at}: ${[...from_]}`);
  } finally {
    try { responder.close(); } catch { /* closed */ }
  }
});

// ---- verifying what is found (host guide §4.1: `oep` is not a registered service name) --------------------------------

/** A TCP service that is no OEP probe: it answers whatever comes with an HTTP error line and closes.
 * @returns {Promise<{ port: number, close: () => void }>} */
async function notOep() {
  const { createServer } = await import('node:net');
  const srv = createServer((c) => {
    c.on('error', () => { /* gone */ });
    c.once('data', () => c.end('HTTP/1.0 400 Bad Request\r\n\r\n'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(undefined)));
  return { port: /** @type {import('node:net').AddressInfo} */ (srv.address()).port, close: () => srv.close() };
}

/** A port nothing listens on. */
async function closedPort() {
  const { port, close } = await notOep();
  close();
  return port;
}

test('discovery: browse({ verify }) and findUnit drop what is not that OEP probe (virtual bench --announce)', { skip }, async (t) => {
  const { createSocket } = await import('node:dgram');
  const { randomBytes } = await import('node:crypto');
  const unit = randomBytes(6).toString('hex');
  const alien = randomBytes(6).toString('hex');
  const liar = randomBytes(6).toString('hex');
  let bench;
  try {
    bench = await startVirtualBench(['--announce', '--announce-engine', 'minimal', '--profile', 'esp32-v003', '--unit-id', unit]);
  } catch (e) {
    t.skip(`the virtual bench cannot announce here: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const other = await notOep();
  // three more instances: a non-OEP service under a unit_id of its own and under the bench's, and the bench's port
  // under a TXT unit_id that describe does not say
  const fakes = [announcement(alien, `notoep-${alien}.local.`, other.port, [127, 0, 0, 1]),
    announcement(unit, `notoep-${unit}.local.`, other.port, [127, 0, 0, 1]),
    announcement(liar, `liar-${liar}.local.`, bench.port, [127, 0, 0, 1])];
  const responder = createSocket({ type: 'udp4', reuseAddr: true });
  responder.on('message', (msg, from) => {
    if (msg[2] & 0x80) return;                                               // an answer, not a query
    for (const a of fakes) responder.send(a, from.port, from.address);
  });
  const ready = await new Promise((resolve) => {
    responder.once('error', () => resolve(false));
    responder.bind(discovery.MDNS_PORT, () => {
      try { responder.addMembership(discovery.MDNS_GROUP); } catch { resolve(false); return; }
      for (const at of discovery.interfaceAddresses()) { try { responder.addMembership(discovery.MDNS_GROUP, at); } catch { /* joined */ } }
      resolve(true);
    });
  });
  try {
    if (!ready) { t.skip('5353 or the mDNS group is not open to this test here'); return; }
    const key = (/** @type {discovery.Found} */ f) => `${f.unitId}@${f.port}`;
    const raw = (await discovery.browse({ timeoutMs: 1500 })).map(key);
    for (const k of [`${unit}@${bench.port}`, `${alien}@${other.port}`, `${unit}@${other.port}`, `${liar}@${bench.port}`]) {
      assert.ok(raw.includes(k), `${k} not in ${raw}`);
    }
    /** @type {string[]} */
    const said = [];
    const kept = (await discovery.browse({ timeoutMs: 1500, verify: true, onDropped: (f, why) => said.push(`${key(f)}: ${why}`) })).map(key);
    assert.ok(kept.includes(`${unit}@${bench.port}`), String(kept));
    for (const k of [`${alien}@${other.port}`, `${unit}@${other.port}`, `${liar}@${bench.port}`]) assert.ok(!kept.includes(k), String(kept));
    assert.ok(said.some((x) => x.startsWith(`${alien}@${other.port}: `) && /no valid confirm answer/.test(x)), said.join('\n'));
    assert.ok(said.some((x) => x.startsWith(`${liar}@${bench.port}: `) && x.includes(JSON.stringify(unit))), said.join('\n'));
    // findUnit (so openTcp({ unitId })) passes over the non-OEP instance with the bench's TXT unit_id
    for (let i = 0; i < 3; i++) assert.equal((await discovery.findUnit(unit, { timeoutMs: 1500 })).port, bench.port);
    const hst = await openTcp({ unitId: unit, findTimeoutMs: 1500, keepSession: false });
    await hst.link.close();
    await assert.rejects(discovery.findUnit(alien, { timeoutMs: 1500 }), /no announced instance with unit_id .* is verified/);
    // check on its own: why each one is not
    const at = (/** @type {string | null} */ u, /** @type {number} */ port) => ({ instance: 'x', unitId: u, host: 'h', port, addresses: ['127.0.0.1'], txt: {} });
    assert.equal(await discovery.check(at(unit, bench.port)), null);
    assert.match(String(await discovery.check(at(unit, await closedPort()))), /no TCP connection/);
    assert.match(String(await discovery.check(at(null, bench.port))), /no unit_id/);
  } finally {
    try { responder.close(); } catch { /* closed */ }
    other.close();
    bench.stop();
  }
});
