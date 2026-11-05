// @ts-check
// oep.probe.memo (oep-if-memo): the client against an in-memory probe with a small max_frame, so that reads, writes and
// lists go in parts (as oep-client-python's tests/test_memo.py); the port record (§4.3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reg from '../src/registry.js';
import * as m from '../src/message.js';
import { Writer, getU16, getU32, text, utf8 } from '../src/bytes.js';
import { Memo, MemoTorn, crc32, portRecordName } from '../src/memo.js';
import { ScriptedHost, handlers, ok } from './scripted.js';

const FN = 9;
const OP = reg.PROBE_MEMO.op;
const NO_RESOURCE = reg.REJECT_REASONS.no_resource;

/** A memo area on a Map: name (as text) -> [data, crc]; a write is kept staged until its last part. */
function probe(maxFrame = 80) {
  /** @type {Map<string, [Uint8Array, number]>} */
  const objects = new Map();
  /** @type {any} */ let stage = null;
  /** @param {Uint8Array} p @param {number} at @returns {[string, number]} */
  const name = (p, at) => [text(p.subarray(at + 1, at + 1 + p[at])), at + 1 + p[at]];
  /** @param {string} n */
  const get = (n) => /** @type {[Uint8Array, number]} */ (objects.get(n));
  const fit = (/** @type {Uint8Array} */ b) => { assert.ok(b.length + reg.LIMITS.result_header_bytes <= maxFrame); return ok(b); };
  const hst = new ScriptedHost(handlers([
    [FN, OP.list, (p) => {
      const first = getU16(p, 0);
      const [prefix] = name(p, 2);
      const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort().slice(first);
      const w = new Writer();
      let count = 0;
      for (const n of names) {
        const one = new Writer().u8(utf8(n).length).raw(utf8(n)).u32(get(n)[0].length).u32(get(n)[1]).done();
        if (2 + w.bytes.length + one.length + reg.LIMITS.result_header_bytes > maxFrame) return fit(Uint8Array.of(1, count, ...w.done()));
        w.raw(one); count++;
      }
      return fit(Uint8Array.of(0, count, ...w.done()));
    }],
    [FN, OP.read, (p) => {
      const [n, at] = name(p, 0);
      const o = objects.get(n);
      if (!o) return [m.REJECTED, NO_RESOURCE, new Uint8Array()];
      const offset = getU32(p, at), most = getU16(p, at + 4);
      const part = o[0].slice(offset, offset + Math.min(most, maxFrame - reg.LIMITS.result_header_bytes - 10));
      return fit(new Writer().u32(o[0].length).u32(o[1]).u16(part.length).raw(part).done());
    }],
    [FN, OP.write, (p) => {
      assert.ok(p.length + reg.LIMITS.request_header_bytes <= maxFrame);
      const [n, at] = name(p, 0);
      const size = getU32(p, at), offset = getU32(p, at + 4), crc = getU32(p, at + 8), len = getU16(p, at + 12);
      const data = p.subarray(at + 14, at + 14 + len);
      if (offset === 0) stage = { n, size, crc, data: [] };
      assert.deepEqual([stage.n, stage.size, stage.crc, stage.data.length], [n, size, crc, offset]);
      stage.data.push(...data);
      if (stage.data.length === size) {
        assert.equal(crc32(Uint8Array.from(stage.data)), crc);
        objects.set(n, [Uint8Array.from(stage.data), crc]);
        stage = null;
      }
      return ok();
    }],
    [FN, OP.delete, (p) => {
      const [n] = name(p, 0);
      if (!objects.delete(n)) return [m.REJECTED, NO_RESOURCE, new Uint8Array()];
      return ok();
    }],
  ]), maxFrame);
  hst.fns.set(Memo.NAME, FN);
  hst.revisions.set(FN, 1);
  hst.describes.set(FN, [[reg.PROBE_MEMO.tlv.describe.max_object, new Writer().u32(2048).done()],
    [reg.PROBE_MEMO.tlv.describe.max_objects, new Writer().u16(64).done()]]);
  return { hst, objects };
}

test('the CRC-32 is CRC-32/ISO-HDLC (oep-if-memo §1)', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('a write and a read go in parts at max_frame; the limits are read from describe', async () => {
  const { hst } = probe();
  const mm = await Memo.open(hst);
  assert.deepEqual(await mm.limits(), { maxObject: 2048, maxObjects: 64 });
  const data = Uint8Array.from({ length: 500 }, (_, i) => i & 0xff);
  await mm.write('tool/a', data);
  assert.ok(hst.log.filter(([, op]) => op === OP.write).length > 1);
  assert.deepEqual(await mm.read('tool/a'), data);
  const empty = new Uint8Array();
  await mm.write('e', empty);
  assert.deepEqual(await mm.read('e'), empty);
});

test('the list pages and filters by prefix', async () => {
  const { hst } = probe();
  const mm = await Memo.open(hst);
  for (let i = 0; i < 12; i++) await mm.write(`t/${String(i).padStart(2, '0')}`, Uint8Array.of(i));
  await mm.write('other', Uint8Array.of(1));
  const got = await mm.list('t/');
  assert.deepEqual(got.map((e) => text(e.name)), Array.from({ length: 12 }, (_, i) => `t/${String(i).padStart(2, '0')}`));
  assert.equal(got[3].crc, crc32(Uint8Array.of(3)));
});

test('a torn object throws MemoTorn (§3: shown, not hidden)', async () => {
  const { hst, objects } = probe();
  const mm = await Memo.open(hst);
  await mm.write('t', utf8('abc'));
  objects.set('t', [utf8('abd'), /** @type {[Uint8Array, number]} */ (objects.get('t'))[1]]);
  await assert.rejects(mm.read('t'), MemoTorn);
  assert.equal(text(await mm.read('t', { check: false })), 'abd');
});

test('the port record: its name lower-cased, merged keeping unknown members, empty deleted (§4.2, §4.3)', async () => {
  const { hst, objects } = probe(256);
  const mm = await Memo.open(hst);
  assert.equal(portRecordName('X035'), 'oep.probe.memo/port/x035');
  assert.equal(await mm.readPortRecord('x035'), null);
  objects.set(portRecordName('x035'), [utf8('{"other":1}'), crc32(utf8('{"other":1}'))]);
  assert.deepEqual(await mm.updatePortRecord('X035', { target: 'ch32x035-00', note: '' }), { other: 1, target: 'ch32x035-00' });
  assert.deepEqual(await mm.readPortRecord('x035'), { other: 1, target: 'ch32x035-00' });
  await mm.updatePortRecord('x035', { other: null, target: null });
  assert.ok(!objects.has(portRecordName('x035')));
});

test('a name past 64 bytes is refused before sending', async () => {
  const { hst } = probe();
  const mm = await Memo.open(hst);
  await assert.rejects(mm.write('n'.repeat(65), new Uint8Array()), RangeError);
  assert.equal(hst.log.length, 0);
});
