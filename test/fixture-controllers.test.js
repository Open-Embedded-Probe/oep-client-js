// @ts-check
// oep.fixture.i2c-controller / spi-controller (fixture §5, §6): the request bodies and the answers of the spec's vectors
// (ops.json), against a scripted host (as oep-client-python's tests/test_fixture_controllers.py).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import { fromHex } from '../src/bytes.js';
import { I2cController, SpiController } from '../src/fixture.js';
import { ScriptedHost, handlers, ok } from './scripted.js';

const I2CC = 15, SPIC = 16;
const REQUEST_HEADER = reg.LIMITS.request_header_bytes, RESULT_HEADER = reg.LIMITS.result_header_bytes;
/** @type {{ name: string, request_hex: string, answer_hex: string }[]} */
const CASES = JSON.parse(readFileSync(new URL('./vectors/ops.json', import.meta.url), 'utf8')).cases;

/** -> [the request's payload, the answer's payload] of an ops.json case. @param {string} name */
function vector(name) {
  const c = CASES.find((x) => x.name === name);
  assert.ok(c, name);
  return [fromHex(c.request_hex).subarray(REQUEST_HEADER), fromHex(c.answer_hex).subarray(RESULT_HEADER)];
}

/** @param {[number, number, (p: Uint8Array) => [number, number, Uint8Array]][]} entries */
function host(entries) {
  const hst = new ScriptedHost(handlers(entries));
  for (const [name, fn] of /** @type {[string, number][]} */ ([[I2cController.NAME, I2CC], [SpiController.NAME, SPIC]])) {
    hst.fns.set(name, fn);
    hst.revisions.set(fn, 1);
    hst.describes.set(fn, []);
  }
  return hst;
}

test('i2c-controller: the vectors', async () => {
  const [configure, configured] = vector('i2c-controller configure: the SCL used at or below the one asked');
  const [register, read] = vector('i2c-controller transfer: a register read (write, repeated START, read, STOP)');
  const [nobody, nack] = vector('i2c-controller transfer: nobody at the address');
  const [second, dataNack] = vector('i2c-controller transfer: the target NACKs the second data byte');
  const [, held] = vector('i2c-controller status: holding the bus after a transfer without STOP');
  const answers = [read, nack, dataNack];
  const hst = host([[I2CC, I2cController.CONFIGURE, () => ok(configured)],
    [I2CC, I2cController.TRANSFER, () => ok(/** @type {Uint8Array} */ (answers.shift()))],
    [I2CC, I2cController.STATUS, () => ok(held)]]);
  const c = await I2cController.open(hst);
  assert.equal(await c.configure(400000, 10000), 380000);
  assert.deepEqual(hst.log.at(-1)?.[2], configure);
  let t = await c.writeRead(0x50, Uint8Array.of(0x10), 2);
  assert.deepEqual(hst.log.at(-1)?.[2], register);
  assert.ok(t.ok);
  assert.deepEqual(t.data, Uint8Array.of(0xab, 0xcd));
  t = await c.write(0x51, new Uint8Array());
  assert.deepEqual(hst.log.at(-1)?.[2], nobody);
  assert.equal(t.result, I2cController.ADDRESS_NACK);
  t = await c.write(0x50, Uint8Array.of(1, 2, 3));
  assert.deepEqual(hst.log.at(-1)?.[2], second);
  assert.deepEqual([t.result, t.at, t.index], [I2cController.DATA_NACK, 0, 1]);
  assert.deepEqual(await c.status(), { state: 1, held: true, transfers: 1, errors: 0 });
});

test('i2c-controller: no STOP keeps the bus, stop() is n 0 with the flag', async () => {
  const hst = host([[I2CC, I2cController.TRANSFER, () => ok([0, 0, 0, 0, 0, 0])]]);
  const c = await I2cController.open(hst);
  await c.write(0x50, Uint8Array.of(0), false);
  assert.equal(hst.log.at(-1)?.[2][0], 0);
  await c.stop();
  assert.deepEqual(hst.log.at(-1)?.[2], Uint8Array.of(I2cController.FLAG_STOP, 0));
});

test('spi-controller: the vectors', async () => {
  const [configure, configured] = vector('spi-controller configure: the SCK used at or below the one asked');
  const [request, answer] = vector('spi-controller transfer: two transfers, the times used at or above the ones asked');
  const hst = host([[SPIC, SpiController.CONFIGURE, () => ok(configured)], [SPIC, SpiController.TRANSFER, () => ok(answer)],
    [SPIC, SpiController.STATUS, () => ok([1, 3, 1, 7, 0, 0, 0])]]);
  const c = await SpiController.open(hst);
  assert.equal(await c.configure(0, 0, 1200000), 1000000);
  assert.deepEqual(hst.log.at(-1)?.[2], configure);
  const done = await c.transfer([{ tx: Uint8Array.of(0x9f), gapNs: 0, setupNs: 1000, holdNs: 500 },
    { tx: Uint8Array.of(1, 2), gapNs: 2010, setupNs: 1000, holdNs: 500 }]);
  assert.deepEqual(hst.log.at(-1)?.[2], request);
  assert.deepEqual(done, [{ gapNs: 0, setupNs: 1000, holdNs: 500, rx: Uint8Array.of(0x5a) },
    { gapNs: 2025, setupNs: 1000, holdNs: 500, rx: Uint8Array.of(0x00, 0xff) }]);
  assert.deepEqual(await c.status(), { state: 1, mode: 3, bitOrder: 1, transfers: 7 });
});
