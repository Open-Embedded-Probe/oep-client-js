// @ts-check
// captureblocks against oep-spec's shared vectors (test/vectors/capture_formats.json, capture §1.3): every stream reads
// back to the levels it was made from - raw channels as bits, reduced channels as their interval values - as
// oep-client-python's tests/test_capture_blocks.py; segmentColumns gives the same without blocks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cb from '../src/captureblocks.js';
import * as cap from '../src/capture.js';
import * as m from '../src/message.js';
import { ProtocolError } from '../src/errors.js';
import { Writer, fromHex } from '../src/bytes.js';

const DATA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'capture_formats.json'), 'utf8'));

const KIND = { sample: cb.SAMPLE, any_high: cb.ANY_HIGH, any_low: cb.ANY_LOW, change_latch: cb.CHANGE_LATCH };

/** The values §1.3 gives a channel's levels (before: the level before them, or null).
 * @param {number} kind @param {number[]} levels @param {number} d @param {number | null} before */
function expectValues(kind, levels, d, before) {
  const out = [];
  let last = before;
  for (let lo = 0; lo < levels.length; lo += d) {
    const part = levels.slice(lo, lo + d);
    if (kind === cb.SAMPLE) out.push(part[0]);
    else if (kind === cb.ANY_HIGH) out.push(part.includes(1) ? 1 : 0);
    else if (kind === cb.ANY_LOW) out.push(part.includes(0) ? 0 : 1);
    else {
      let ch = 0;
      for (const v of part) { if (last !== null && v !== last) ch = 1; last = v; }
      out.push(part[part.length - 1] | (ch << 1));
    }
  }
  return out;
}

/** @param {any} c @returns {{ rawRoles: number[], reduced: cb.Reduced }} */
const rolesOf = (c) => ({ rawRoles: Array.from({ length: c.R }, (_, j) => j),
  reduced: new Map(c.kinds.map((/** @type {string} */ k, /** @type {number} */ e) => [c.R + e, [/** @type {any} */ (KIND)[k], c.d[e]]])) });
/** @param {string} s */
const levelsOf = (s) => [...s].map(Number);

/** One block as §1.3 lays it out (the test's own encoder): raw lines, reduced lines with their kinds and D, and each
 * change_latch line's start level. @param {number[][]} raw @param {number[][]} red @param {number[]} kinds
 * @param {number[]} ds @param {number[]} starts */
function encodeBlock(raw, red, kinds, ds, starts) {
  const r = (raw[0] ?? red[0]).length, R = raw.length;
  /** @type {number[]} */
  const bits = [];
  for (let i = 0; i < r; i++) for (let k = 0; k < R; k++) bits.push(raw[k][i]);
  while (bits.length % 8) bits.push(0);
  /** @type {number[]} */
  const part = [];
  kinds.forEach((k, e) => { if (k === cb.CHANGE_LATCH) part.push(starts[e]); });
  kinds.forEach((k, e) => {
    for (const v of expectValues(k, red[e], ds[e], k === cb.CHANGE_LATCH ? starts[e] : null)) {
      for (let j = 0; j < cb.valueBits(k); j++) part.push((v >> j) & 1);
    }
  });
  while (part.length % 8) part.push(0);
  const all = [...bits, ...part];
  return Uint8Array.from({ length: all.length / 8 }, (_, i) => all.slice(i * 8, i * 8 + 8).reduce((t, b, j) => t | (b << j), 0));
}

test('format 1 blocks read back to the levels they were made from (capture_formats.json)', () => {
  assert.ok(DATA.logic_blocks.length >= 1);
  for (const c of DATA.logic_blocks) {
    const { rawRoles, reduced } = rolesOf(c);
    /** @type {number[] | null} */
    let prevEnd = null;
    for (const seg of c.segments) {
      const n = [...seg.raw, ...seg.reduced][0].length;
      const data = fromHex(seg.stream_hex);
      const blocks = cb.readLogicBlocks(data, n, rawRoles, reduced, c.L);
      seg.raw.forEach((/** @type {string} */ levels, /** @type {number} */ j) => {
        assert.equal(blocks.map((b) => cb.bitsList(/** @type {Uint8Array} */ (b.raw.get(j)), b.samples).join('')).join(''), levels, c.name);
      });
      seg.reduced.forEach((/** @type {string} */ levels, /** @type {number} */ e) => {
        const role = c.R + e;
        assert.deepEqual(blocks.flatMap((b) => /** @type {number[]} */ (b.values.get(role))), seg.values[e], c.name);
        const [kind, d] = /** @type {[number, number]} */ (reduced.get(role));
        const before = seg.contiguous && prevEnd ? prevEnd[e] : null;
        assert.deepEqual(seg.values[e], expectValues(kind, levelsOf(levels), d, before), c.name);
        if (kind === cb.CHANGE_LATCH) {        // each block's start: the level before it (sample 0's after a gap)
          for (const b of blocks) {
            const want = b.first ? Number(levels[b.first - 1]) : (before ?? Number(levels[0]));
            assert.equal(b.starts.get(role), want, c.name);
          }
        }
      });
      const cols = cb.segmentColumns(data, n, rawRoles, reduced, c.L);
      seg.raw.forEach((/** @type {string} */ levels, /** @type {number} */ j) => {
        assert.equal(cb.bitsList(/** @type {Uint8Array} */ (cols.get(j)), n).join(''), levels, c.name);
      });
      seg.reduced.forEach((/** @type {string} */ _, /** @type {number} */ e) => {
        assert.deepEqual(/** @type {cb.ReducedColumn} */ (cols.get(c.R + e)).values, seg.values[e], c.name);
      });
      assert.equal(cb.segmentBytes(n, c.R, reduced, c.L), data.length, c.name);
      prevEnd = seg.reduced.map((/** @type {string} */ ch) => Number(ch[ch.length - 1]));
    }
  }
});

test('a cut segment, or a byte past it, is a ProtocolError', () => {
  const c = DATA.logic_blocks[0], seg = c.segments[0];
  const data = fromHex(seg.stream_hex);
  const n = [...seg.raw, ...seg.reduced][0].length;
  const { rawRoles, reduced } = rolesOf(c);
  for (const bad of [data.slice(0, -1), Uint8Array.of(...data, 0)]) {
    assert.throws(() => cb.readLogicBlocks(bad, n, rawRoles, reduced, c.L), ProtocolError);
    assert.throws(() => cb.segmentColumns(bad, n, rawRoles, reduced, c.L), ProtocolError);
  }
});

test('a block\'s size is fixed by the setting (§1.3)', () => {
  // 4 raw, 12 sample at D 32, L 4096: 2048 + 12 x 128 bits; change_latch adds its start bit and 2 bits an interval
  assert.equal(cb.blockBytes(4, new Map(Array.from({ length: 12 }, (_, k) => [4 + k, [cb.SAMPLE, 32]])), 4096), 2048 + 192);
  assert.equal(cb.blockBytes(0, new Map([[0, [cb.CHANGE_LATCH, 8]]]), 64), (1 + 16 + 7) >> 3);
  /** @type {cb.Reduced} */
  const one = new Map([[1, [cb.SAMPLE, 16]]]);
  assert.equal(cb.segmentBytes(72, 1, one, 32), 2 * cb.blockBytes(1, one, 32) + cb.blockBytes(1, one, 8));
});

test('a change_latch start that does not follow the interval before is a broken stream', () => {
  const L = 16, lv = [...Array(8).fill(0), ...Array(24).fill(1)];
  const blocks = [0, 16].map((f) => encodeBlock([], [lv.slice(f, f + L)], [cb.CHANGE_LATCH], [8], [f ? lv[f - 1] : lv[0]]));
  /** @type {cb.Reduced} */
  const red = new Map([[0, [cb.CHANGE_LATCH, 8]]]);
  cb.segmentColumns(Uint8Array.of(...blocks[0], ...blocks[1]), 32, [], red, L);
  const bad = Uint8Array.of(...blocks[0], blocks[1][0] ^ 1, ...blocks[1].slice(1));   // the second block's start flipped
  assert.throws(() => cb.segmentColumns(bad, 32, [], red, L), ProtocolError);
});

test('random segments read back to the values §1.3 says (R 0-3, every carriage, D 2-64, a short last block)', () => {
  let seed = 2;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  /** @template T @param {T[]} a @returns {T} */
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const kindsAll = Object.values(KIND);
  for (let t = 0; t < 60; t++) {
    const L = pick([64, 256, 1024]);
    const E = Math.floor(rnd() * 7);
    const R = Math.floor(rnd() * 4) || (E === 0 ? 1 : 0);
    const kinds = Array.from({ length: E }, () => pick(kindsAll));
    const ds = Array.from({ length: E }, () => pick([2, 4, 8, 16, 32, 64].filter((d) => L % d === 0)));
    const samples = 1 + Math.floor(rnd() * 5 * L);
    /** @param {number} p */
    const line = (p) => { let v = rnd() < 0.5 ? 1 : 0; return Array.from({ length: samples }, () => (v ^= rnd() < p ? 1 : 0)); };
    const raw = Array.from({ length: R }, () => line(0.5));
    const red = Array.from({ length: E }, () => line(pick([0.001, 0.05, 0.5])));
    /** @type {number[]} */
    const bytes = [];
    for (let f = 0; f < samples; f += L) {
      bytes.push(...encodeBlock(raw.map((x) => x.slice(f, f + L)), red.map((x) => x.slice(f, f + L)), kinds, ds,
        red.map((x) => (f ? x[f - 1] : x[0]))));
    }
    /** @type {cb.Reduced} */
    const reduced = new Map(kinds.map((k, e) => [R + e, [k, ds[e]]]));
    const data = Uint8Array.from(bytes);
    assert.equal(cb.segmentBytes(samples, R, reduced, L), data.length);
    const cols = cb.segmentColumns(data, samples, raw.map((_, k) => k), reduced, L);
    raw.forEach((x, k) => assert.deepEqual(cb.bitsList(/** @type {Uint8Array} */ (cols.get(k)), samples), x));
    red.forEach((x, e) => {
      const col = /** @type {cb.ReducedColumn} */ (cols.get(R + e));
      assert.deepEqual(col.values, expectValues(kinds[e], x, ds[e], null));
      assert.equal(col.startLevel, kinds[e] === cb.CHANGE_LATCH ? x[0] : 0);
    });
  }
});

test('configure\'s data_rate (streaming, §3.3): read into Config and used for the tolerable delay', () => {
  const rate = m.tlv(cap.ACTUAL_RATE, new Writer().u32(1_000_000).u32(1).done());
  const c = cap.parseConfig(Uint8Array.of(...rate, ...m.tlv(cap.DATA_RATE, new Writer().u32(250_000).done()),
    ...m.tlv(cap.STREAM_BUFFER, new Writer().u32(500_000).done())), false);
  assert.equal(c.dataRate, 250_000);
  assert.equal(c.tolerableDelayS(), 2);
  assert.equal(cap.parseConfig(rate, false).dataRate, null);
});

test('named extensions and the firmware\'s capture-drops data', () => {
  const name = new TextEncoder().encode(cap.CaptureDrops.NAME), other = new TextEncoder().encode('com.example.x');
  const drops = new Writer().u32(12288).u32(0).u32(1).u32(0).u8(1).u8(4).u32(49140).u32(49140).u32(0).done();
  const ext = (/** @type {Uint8Array} */ n, /** @type {Uint8Array} */ v, critical = false) =>
    m.tlv(m.TAG_NAMED_EXTENSION, Uint8Array.of(n.length, ...n, ...v), critical);
  const tail = m.Tail.parse(Uint8Array.of(...ext(name, drops), ...ext(other, Uint8Array.of(1), true),
    ...ext(name, new TextEncoder().encode('later')), ...m.tlv(m.TAG_NAMED_EXTENSION, Uint8Array.of(9, 0x61, 0x62))));
  const named = tail.named();
  assert.deepEqual([...named.keys()], [cap.CaptureDrops.NAME, 'com.example.x']);
  const d = /** @type {cap.CaptureDrops} */ (cap.CaptureDrops.unpack(/** @type {Uint8Array} */ (named.get(cap.CaptureDrops.NAME))));
  assert.deepEqual([d.noStageBytes, d.dmaOverruns, d.zeroCopy, d.stages, d.psramTotal, d.bufferPeak], [12288, 1, true, 4, 0, null]);
  const e = /** @type {cap.CaptureDrops} */ (cap.CaptureDrops.unpack(new Writer().u32(0).u32(0).u32(0).u32(0).u8(1).u8(8).u32(1).u32(2).u32(3).u32(3585344).done()));
  assert.deepEqual([e.stages, e.psramTotal, e.bufferPeak], [8, 3, 3585344]);
  assert.equal(cap.CaptureDrops.unpack(new TextEncoder().encode('short')), null);
});

test('configure\'s judge_latency_ns (optional): read into Config; absent null; another length not used', () => {
  const rate = m.tlv(cap.ACTUAL_RATE, new Writer().u32(5_000_000).u32(1).done());
  assert.equal(cap.parseConfig(Uint8Array.of(...rate, ...m.tlv(cap.JUDGE_LATENCY, new Writer().u32(100819200).done())), false).judgeLatencyNs, 100819200);
  assert.equal(cap.parseConfig(rate, false).judgeLatencyNs, null);
  assert.equal(cap.parseConfig(Uint8Array.of(...rate, ...m.tlv(cap.JUDGE_LATENCY, Uint8Array.of(1, 2))), true).judgeLatencyNs, null);
});
