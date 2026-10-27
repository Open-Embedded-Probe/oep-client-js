// @ts-check
// oep.fixture.pwm / counter / dac (fixture §7-§9): the request bodies and the answers of the spec's vectors (ops.json),
// against a scripted host (as oep-client-python's tests/test_fixture_out.py).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import { fromHex } from '../src/bytes.js';
import { Counter, Dac, Pwm } from '../src/fixture.js';
import { ScriptedHost, handlers, ok } from './scripted.js';

const PWM = 17, CNT = 18, DAC = 19;
const REQUEST_HEADER = reg.LIMITS.request_header_bytes, RESULT_HEADER = reg.LIMITS.result_header_bytes;
/** @type {{ name: string, request_hex: string, answer_hex: string }[]} */
const CASES = JSON.parse(readFileSync(new URL('./vectors/ops.json', import.meta.url), 'utf8')).cases;
/** @param {string} name */
function vector(name) {
  const c = CASES.find((x) => x.name === name);
  assert.ok(c, name);
  return [fromHex(c.request_hex).subarray(REQUEST_HEADER), fromHex(c.answer_hex).subarray(RESULT_HEADER)];
}
/** @param {[number, number, (p: Uint8Array) => [number, number, Uint8Array]][]} entries */
function host(entries) {
  const hst = new ScriptedHost(handlers(entries));
  for (const [name, fn] of /** @type {[string, number][]} */ ([[Pwm.NAME, PWM], [Counter.NAME, CNT], [Dac.NAME, DAC]])) {
    hst.fns.set(name, fn);
    hst.revisions.set(fn, 1);
    hst.describes.set(fn, []);
  }
  return hst;
}

test('pwm set: the vector', async () => {
  const [request, answer] = vector('pwm set: the nearest frequency and duty, and an output stopped');
  const hst = host([[PWM, Pwm.SET, () => ok(answer)]]);
  const made = await (await Pwm.open(hst)).set([[0, 1000, 32767], [1, 0, 0]]);
  assert.deepEqual(hst.log.at(-1)?.[2], request);
  assert.deepEqual(made, [{ role: 0, num: 1000, den: 1, duty: 32768, hz: 1000 }, { role: 1, num: 0, den: 1, duty: 0, hz: 0 }]);
});

test('counter measure: the vector', async () => {
  const [request, answer] = vector('counter measure: the edges in the window, every planned role');
  const hst = host([[CNT, Counter.MEASURE, () => ok(answer)]]);
  const got = await (await Counter.open(hst)).measure(100000, Counter.RISING);
  assert.deepEqual(hst.log.at(-1)?.[2], request);
  assert.equal(got.windowNs, 100002000n);
  assert.deepEqual([...got.counts], [[0, 100], [1, 0]]);
});

test('dac status: the vector', async () => {
  const [, answer] = vector('dac status: the value set, on');
  const hst = host([[DAC, Dac.STATUS, () => ok(answer)]]);
  assert.deepEqual(await (await Dac.open(hst)).status(), [[0, 128, true], [1, 0, false]]);
});
