// @ts-check
// The debug wire's connection check (wire.js; oep-if-debug §1-§3, §5): the attach request as sent, the id that
// answered, the detach after it, swd's RP2040 core 0 tried when a plain attach gets no answer; on the virtual bench a
// target silent until a reset answers only through the reset TLV. The idle item (a setting, core §13.8) reads back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer } from '../src/bytes.js';
import * as settings from '../src/settings.js';
import { listEntries } from '../src/core.js';
import { Failed } from '../src/errors.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { RP2040_CORE0, WIRES, Wire } from '../src/wire.js';
import { openTcp } from '../src/node/index.js';
import { FNS, ScriptedHost, handlers, ok } from './scripted.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const skip = !haveVirtualBench;
const W = reg.WIRE_RVSWD;
/** conn id flags speed_hz (debug §3) @param {number} conn @param {number} id */
const attached = (conn, id) => ok(new Writer().u32(conn).u32(id).u8(0).u32(1_000_000).done());
const failed = () => /** @type {[number, number, Uint8Array]} */ ([m.COMPLETED, m.FAILED, Uint8Array.of(reg.STATUS.timeout)]);

test('check: attach (run, the pins, the declared or default speed, reset critical), the id, then detach', async () => {
  const RV = FNS['oep.wire.rvswd'];
  const hst = new ScriptedHost(handlers([[RV, W.op.attach, () => attached(7, 0x00030382)], [RV, W.op.detach, () => ok()]]));
  const wire = await Wire.open(hst, { name: WIRES.rvswd });
  assert.deepEqual(await wire.check({ pins: [4, 5], reset: [9, 20] }), { id: 0x00030382, rp2040Core0: false });
  const [att, det] = hst.log;
  assert.deepEqual([...att[2]], [...new Writer().u8(W.enum.attach_method.run).u16(4).u16(5).u32(1_000_000).done(),
    W.tlv.attach.reset | 0x80, 4, 0, 9, 0, 20, 0]);
  assert.deepEqual([det[1], [...det[2]]], [W.op.detach, [7, 0, 0, 0]]);
});

test('check on swd: no answer, then RP2040 core 0 by TARGETSEL; the first failure when neither answers', async () => {
  const SWD = FNS['oep.wire.swd'];
  let rp2040 = true;
  const hst = new ScriptedHost(handlers([
    [SWD, W.op.attach, (p) => (rp2040 && p.length > 9 ? attached(3, 0x0bc12477) : failed())],
    [SWD, W.op.detach, () => ok()],
  ]));
  const wire = await Wire.open(hst, { name: WIRES.swd });
  assert.deepEqual(await wire.check({ pins: [2, 3], maxSpeed: 4_000_000 }), { id: 0x0bc12477, rp2040Core0: true });
  const sel = hst.log[1][2];
  assert.deepEqual([...sel.subarray(9)], [reg.WIRE_SWD.tlv.attach.targetsel | 0x80, 4, 0, ...new Writer().u32(RP2040_CORE0).done()]);
  rp2040 = false;
  await assert.rejects(wire.check({ pins: [2, 3] }), Failed);
  await assert.rejects(new Wire(hst, FNS['oep.wire.rvswd'], WIRES.rvswd).attach({ pins: [1, 2], targetsel: 1 }), RangeError);
});

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

test('a target silent until a reset: the check fails without the reset TLV and answers with it', { skip },
  () => withBench(['--profile', 'esp32-v003', '--silent-until-reset', '0'], async (hst) => {
    const entry = (await listEntries(hst)).find((e) => e.name === WIRES.swio || e.name === WIRES.rvswd);
    assert.ok(entry);
    const wire = await Wire.open(hst, { fn: entry.fn, name: entry.name });
    const d = (await import('../src/catalog.js')).decodeDescription(await (await import('../src/core.js')).describe(hst, entry.fn));
    const group = new Map([...d.groups.values()][0]);              // swdio (role 1) in the wire's channel group (core §7.4)
    const dio = /** @type {number} */ (group.get(1)), clk = group.get(2) ?? 0xffff;
    const nrst = /** @type {number[]} */ (d.roles.get(W.enum.pin_role.reset))[0];
    await assert.rejects(wire.check({ pins: [dio, clk] }), Failed);
    const { id } = await wire.check({ pins: [dio, clk], reset: [nrst, 20] });
    assert.ok(id);
  }));

test('the idle item set on the bench reads back as it was sent', { skip }, () => withBench(['--profile', 'p4-bench'], async (hst) => {
  const st = new settings.Settings(hst);
  await st.setNamed(settings.CORE_CATEGORY, { 'channel.GPIO21.idle': 'low' });
  const row = (await st.show()).find((r) => r.name === 'channel.GPIO21.idle');
  assert.deepEqual([row?.value, row?.item.form], ['low', 'enum']);
}));
