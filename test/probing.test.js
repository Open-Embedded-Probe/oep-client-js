// @ts-check
// The probing rule and a named unit id (oep-core §3.3): the first thing sent to a transport is a confirm (and its one
// resend), nothing else until a valid answer; none closes it. A unit id names a device by its serial alone, and
// describe must then say the same unit_id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, PROBE_WAIT_MS } from '../src/open.js';
import { NotOepProbe, UnitIdMismatch } from '../src/errors.js';
import { Request, Result, COMPLETED, SUCCESS, OP } from '../src/message.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

/**
 * A length-framed transport that answers each request with `answer(message)` (null: silence); what was written is kept.
 * @param {(msg: Uint8Array) => Uint8Array | null} answer @param {string} kind
 */
function scriptedTransport(answer, kind = 'vendor') {
  /** @type {Uint8Array[]} */ const sent = [];
  /** @type {((d: Uint8Array) => void) | null} */ let deliver = null;
  const t = {
    framing: /** @type {'length'} */ ('length'), kind, sent, closed: false,
    /** @param {Uint8Array} data */
    async write(data) {
      let at = 0;
      while (at + 2 <= data.length) {
        const n = data[at] | (data[at + 1] << 8);
        const msg = data.slice(at + 2, at + 2 + n);
        at += 2 + n;
        if (!n) continue;
        sent.push(msg);
        const out = answer(msg);
        if (out) {
          const framed = new Uint8Array(2 + out.length);
          framed[0] = out.length & 0xff; framed[1] = out.length >> 8; framed.set(out, 2);
          setTimeout(() => deliver?.(framed), 1);
        }
      }
    },
    /** @param {(d: Uint8Array) => void} onData */
    start(onData) { deliver = onData; },
    async close() { t.closed = true; },
  };
  return t;
}

test('probing: a silent device gets one confirm and its resend, then is closed', async () => {
  assert.equal(PROBE_WAIT_MS, 1000);
  const t = scriptedTransport(() => null);
  const started = Date.now();
  await assert.rejects(connect(/** @type {any} */ (t), { timeoutMs: 10000 }), NotOepProbe);
  const took = Date.now() - started;
  assert.ok(took >= 1900 && took < 4000, `waited ${took} ms (2 x 1000 ms, not the 10 s timeout)`);
  assert.equal(t.sent.length, 2);
  assert.deepEqual(t.sent.map((msg) => msg[5]), [OP.confirm, OP.confirm]);
  assert.deepEqual([...t.sent[0]], [...t.sent[1]]);             // the resend: the same corr
  assert.equal(t.closed, true);
});

test('probing: an answer that is not a valid confirm closes the device, nothing else sent', async () => {
  const t = scriptedTransport((msg) => new Result(Request.unpack(msg).corr, COMPLETED, SUCCESS, new TextEncoder().encode('HELLO-not-oep....')).pack());
  await assert.rejects(connect(/** @type {any} */ (t)), NotOepProbe);
  assert.deepEqual(t.sent.map((msg) => msg[5]), [OP.confirm]);
  assert.equal(t.closed, true);
});

test('named unit id: describe must say it, else closed', { skip: !haveFake }, async () => {
  const fake = await startFake(['--profile', 'p4-x035']);
  try {
    const hst = await openTcp({ port: fake.port, unitId: '30eda0e31108' });
    assert.ok(hst.limits);
    await hst.link.close();
    await assert.rejects(openTcp({ port: fake.port, unitId: 'ffffffffffff' }), UnitIdMismatch);
  } finally {
    fake.stop();
  }
});
