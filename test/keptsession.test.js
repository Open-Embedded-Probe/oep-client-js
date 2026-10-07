// @ts-check
// oep-spec f8bb2de (host guide §5; transports §3: a closed transport does not end a session): a host that may run again
// keeps its session id per probe (src/keptsession.js, keyed by unit_id) and its next run first opens that id and ends it
// at once, then opens its own. Mirrors oep-client-python's tests/test_spec_283e5b5.py through the TCP virtual bench
// (one connection at a time; a closed connection keeps the session until its lease runs out).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { take } from '../src/core.js';
import { InUse, Locked } from '../src/errors.js';
import { KeptSession, fileKeptStore, localStorageKeptStore, memoryKeptStore } from '../src/keptsession.js';
import { MAX_NAME } from '../src/names.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = !haveVirtualBench;
const UNIT = 'fafe00000003';   // the virtual bench esp32-v003's unit_id

test('a host run again ends the session its previous run left (host guide §5)', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'esp32-v003']);
  const dir = /** @type {string} */ (process.env.OEP_SESSION_DIR);
  const file = join(dir, `${UNIT}.session`);
  try {
    const first = await openTcp({ port: bench.port });               // keepSession on (the default)
    assert.ok(first.kept instanceof KeptSession);
    await take(first, 30000, { owner: 'run 1', waitMs: 0 });
    const sid = /** @type {number} */ (first.session);
    assert.equal(readFileSync(file, 'utf8'), `${sid.toString(16).padStart(8, '0')}\n`);
    await first.link.close();                                        // killed: no end; the file keeps the id

    const without = await openTcp({ port: bench.port, keepSession: false });   // a host keeping nothing meets the old lock
    await assert.rejects(take(without, 3000, { owner: 'other', waitMs: 0 }), InUse);
    await without.link.close();

    const second = await openTcp({ port: bench.port });
    await take(second, 30000, { owner: 'run 2', waitMs: 0 });        // at once: the old session was ended first
    assert.equal(second.kept?.previous, sid);
    assert.equal(second.kept?.endedPrevious, true);
    assert.notEqual(second.session, sid);
    assert.equal(readFileSync(file, 'utf8'), `${/** @type {number} */ (second.session).toString(16).padStart(8, '0')}\n`);
    await second.end();
    assert.equal(readFileSync(file, 'utf8'), '');                    // ended: nothing to take back next time
    await second.link.close();
    assert.ok(!existsSync(`${file}.lock`));                          // the place goes back with the link

    const third = await openTcp({ port: bench.port });
    await take(third, 3000, { waitMs: 0 });
    assert.equal(third.kept?.previous, null);
    assert.equal(third.kept?.endedPrevious, false);
    await third.end();
    await third.link.close();
  } finally {
    bench.stop();
  }
});

test('a dropped connection keeps its session until its lease runs out (transports §3)', { skip }, async () => {
  const bench = await startVirtualBench(['--profile', 'esp32-v003']);
  try {
    const first = await openTcp({ port: bench.port, keepSession: false });
    await first.open(1000);
    await first.link.close();
    const other = await openTcp({ port: bench.port, keepSession: false });
    await assert.rejects(other.open(3000), Locked);
    await new Promise((r) => setTimeout(r, 1300));                    // the lease (1000 ms) ran out (core §9)
    await other.open(3000);
    await other.end();
    await other.link.close();
  } finally {
    bench.stop();
  }
});

test('a place another running host holds is left alone; an x- unit_id keeps nothing', async () => {
  for (const store of [memoryKeptStore(), fileKeptStore(/** @type {string} */ (process.env.OEP_SESSION_DIR))]) {
    const a = await store.claim('fafe00000099');
    assert.equal(typeof a, 'object');
    const b = await store.claim('fafe00000099');
    assert.equal(typeof b, 'string');
    assert.match(/** @type {string} */ (b), /another running host/);
    await /** @type {any} */ (a).write('0000abcd\n');
    await /** @type {any} */ (a).release();
    const c = /** @type {any} */ (await store.claim('fafe00000099'));
    assert.equal(await c.read(), '0000abcd\n');                      // the id stays for the next run
    await c.release();
  }
  const kept = new KeptSession(memoryKeptStore());
  const hst = /** @type {any} */ ({ session: null, describes: new Map([[0, [[reg.CORE.tlv.describe.unit_id, new TextEncoder().encode('x-test')]]]]),
    async endPrevious() { throw new Error('not called'); } });
  await kept.beforeOpen(hst);
  assert.match(kept.whyNot, /names no unit/);
  assert.equal(kept.claim, null);
});

test('localStorage keeps the id per unit_id, held with a Web Lock; storage that throws keeps nothing', async () => {
  /** @type {Map<string, string>} */ const items = new Map();
  const storage = { getItem: (/** @type {string} */ k) => items.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { items.set(k, v); } };
  /** @type {Set<string>} */ const held = new Set();
  const locks = {
    /** @param {string} name @param {any} _o @param {(l: unknown) => unknown} cb */
    async request(name, _o, cb) {
      if (held.has(name)) return cb(null);
      held.add(name);
      await cb({ name });
      held.delete(name);
      return undefined;
    },
  };
  const store = localStorageKeptStore(storage, locks);
  const a = /** @type {any} */ (await store.claim('fafe00000035'));
  await a.write('12345678\n');
  assert.equal(items.get('oep-client.session.fafe00000035'), '12345678\n');
  assert.match(/** @type {string} */ (await localStorageKeptStore(storage, { request: locks.request }).claim('fafe00000035')), /kept by another/);
  await a.release();
  await new Promise((r) => setTimeout(r, 0));
  const broken = localStorageKeptStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, undefined);
  const b = /** @type {any} */ (await broken.claim('fafe00000036'));
  assert.equal(await b.read(), '');
  await b.write('x');                                                 // no throw
  await b.release();
});

test('interface names are 1 to 48 bytes (core §7.2: one list entry fits the smallest max_frame)', () => {
  assert.equal(MAX_NAME, 48);
  assert.equal(reg.LIMITS.interface_name_max_bytes, 48);
  assert.ok(5 + 3 + 7 + MAX_NAME <= reg.MIN_MAX_FRAME);
});
