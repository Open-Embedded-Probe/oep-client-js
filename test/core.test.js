// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cobs from '../src/cobs.js';
import { utf8 } from '../src/bytes.js';
import { find, listEntries, probeInfo } from '../src/core.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

test('crc16 and COBS as core §3.1 says', () => {
  assert.equal(cobs.crc16(utf8('123456789')), 0x29b1);
  const data = Uint8Array.from([1, 0, 2, 0, 0, 3]);
  assert.deepEqual(cobs.decode(cobs.encode(data)), data);
  const long = new Uint8Array(300).fill(7);
  assert.deepEqual(cobs.decode(cobs.encode(long)), long);
  const f = cobs.frame(data);
  assert.equal(f[0], 0);
  assert.equal(f[f.length - 1], 0);
  assert.deepEqual(cobs.unframe(f.subarray(1, f.length - 1)), data);
});

for (const framing of /** @type {const} */ (['length', 'cobs'])) {
  test(`confirm, list, describe and a session with the fake probe (${framing})`, { skip: !haveFake }, async () => {
    const fake = await startFake([], framing);
    const hst = await openTcp({ port: fake.port, framing });
    try {
      assert.equal(hst.revision, 1);
      const entries = await listEntries(hst);
      assert.equal(entries[0].name, 'oep.core');
      assert.ok(entries.some((e) => e.name === 'oep.fixture.logic'));
      assert.equal(await find(hst, 'oep.wire.rvswd'), 1);
      const info = await probeInfo(hst);
      assert.equal(info.model, 'esp32p4');
      assert.equal(info.unitId, '30eda0e31108');
      const opened = await hst.open(3000, { owner: 'js test' });
      assert.equal(opened.resumed, false);
      assert.deepEqual((await hst.lockState()).owner, 'js test');
      const r = await hst.pipelineCalls(Array.from({ length: 8 }, () => [0, 0x13, new Uint8Array()]), { locked: false });
      assert.equal(r.length, 8);
      await hst.end();
    } finally {
      await hst.link.close();
      fake.stop();
    }
  });
}
