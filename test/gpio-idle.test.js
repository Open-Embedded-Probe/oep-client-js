// @ts-check
// gpio set and the idle item without a strength selection (fixture §1: revision 1 defines none; core §13.8: channel.{}.idle
// is an enum keyed by the channel), an unknown TLV on set (core §2.3), and a target silent until a reset. Mirrors
// oep-client-python's tests/test_gpio_drive_and_serve_options.py through the TCP virtual bench (virtual_bench_serve's
// --silent-until-reset gives a target that answers only after a reset): over TCP only what the wire says is checked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat } from '../src/bytes.js';
import * as settings from '../src/settings.js';
import { describe, planApply } from '../src/core.js';
import { Unsupported } from '../src/errors.js';
import { Gpio } from '../src/fixture.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = !haveVirtualBench;
/** A TLV number gpio set does not define (its set has no TLVs of its own): an unknown tag to the probe (core §2.3). */
const UNKNOWN = Array.from({ length: 0x3f }, (_, i) => i + 1).find((t) => !Object.values(/** @type {Record<string, Record<string, number>>} */ (reg.FIXTURE_GPIO.tlv).set ?? {}).includes(t));

/** @param {string[]} args @param {(hst: import('../src/host.js').Host) => Promise<void>} body */
async function withBench(args, body) {
  const bench = await startVirtualBench(args);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(3000);
    await body(hst);
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
}

/** @param {import('../src/host.js').Host} hst @param {number[]} channels */
async function gpioOf(hst, channels = [20, 21, 22]) {
  const g = await Gpio.open(hst);
  await planApply(hst, channels.map((ch) => /** @type {[number, number, number]} */ ([g.fn, 1, ch])));
  return g;
}

/** A set request as raw bytes: n x (channel mode), then `tail`.
 * @param {import('../src/host.js').Host} hst @param {Gpio} g @param {[number, number][]} pairs @param {Uint8Array} tail */
const rawSet = (hst, g, pairs, tail = new Uint8Array()) => hst.call(g.fn, Gpio.SET, concat(Gpio.setBody(pairs), tail));

test('gpio set: an unknown TLV is ignored plain and refused critical, with the tag as received; no drive_levels declared', { skip },
  () => withBench(['--profile', 'p4-bench'], async (hst) => {
    const g = await gpioOf(hst);
    const value = Uint8Array.of(0, 1);
    const r = await rawSet(hst, g, [[20, Gpio.OUTPUT_HIGH]], m.tlv(/** @type {number} */ (UNKNOWN), value));
    assert.ok(r.ran);
    assert.deepEqual([...r.payload], []);
    assert.deepEqual(await g.read([20]), [1]);
    await assert.rejects(rawSet(hst, g, [[20, Gpio.OUTPUT_LOW]], m.tlv(/** @type {number} */ (UNKNOWN), value, true)),
      (e) => e instanceof Unsupported && e.tag === (/** @type {number} */ (UNKNOWN) | m.TAG_CRITICAL));
    assert.deepEqual(await g.read([20]), [1]);                       // refused: nothing applied
    assert.equal(await g.modes() > 0, true);
    assert.equal((await describe(hst, g.fn)).filter(([t]) => t > Gpio.TAG_MODES && t < 0x80).length, 0);   // modes is its only own tag
  }));

test('the idle item set on the bench reads back as it was sent', { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const st = new settings.Settings(hst);
  await st.setNamed(settings.CORE_CATEGORY, { 'channel.GPIO21.idle': 'low' });
  const row = (await st.show()).find((r) => r.name === 'channel.GPIO21.idle');
  assert.deepEqual([row?.value, row?.origin, row?.item.form], ['low', 'user', 'enum']);
}));

test('a host attach with the reset TLV wakes a target silent until a reset; scan does not see it', { skip },
  () => withBench(['--profile', 'esp32-v003', '--silent-until-reset', '0'], async (hst) => {
    const W = reg.WIRE_RVSWD;                                        // the wires share their op and tag numbers (debug §0)
    const { listEntries } = await import('../src/core.js');
    const rv = await import('../src/riscv.js');
    const entry = (await listEntries(hst)).find((e) => e.name === 'oep.wire.swio' || e.name === 'oep.wire.rvswd');
    assert.ok(entry);
    const wireFn = entry.fn;
    const wire = await rv.Wire.open(hst, { fn: wireFn, name: entry.name });
    const [pair] = await wire.candidatePairs();
    const nrst = (await wire.resetChannels())[0];
    assert.deepEqual(await wire.scan([pair]), []);                   // scan: nothing found
    const attach = new Writer().u8(W.enum.attach_method.run).u16(pair[0]).u16(pair[1]).u32(1_000_000).done();
    assert.ok(!(await hst.request(wireFn, W.op.attach, attach)).succeeded);
    const reset = m.tlv(W.tlv.attach.reset, new Writer().u16(nrst).u16(20).done(), true);
    assert.ok((await hst.call(wireFn, W.op.attach, concat(attach, reset))).succeeded);
  }));
