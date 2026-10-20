// @ts-check
// captureblocks against oep-spec's shared vectors (test/vectors/capture_formats.json, capture §1.3): every stream reads
// back to the levels it was made from - raw and fallback channels as bits, events channels as their ticks - as
// oep-client-python's tests/test_capture_blocks.py; segmentColumns gives the same lines without blocks.
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

/** The ticks the probe sends for `levels[first .. first + r)` at D `d`, the level before them `before`.
 * @param {string} levels @param {number} first @param {number} r @param {number} d @param {number} before */
function expectTicks(levels, first, r, d, before) {
  /** @type {[number, number, number][]} */
  const out = [];
  let last = before;
  for (let t = 0; t * d < r; t++) {
    let c = 0;
    for (let i = t * d; i < Math.min((t + 1) * d, r); i++) {
      const v = Number(levels[first + i]);
      if (v !== last) c++;
      last = v;
    }
    if (c) out.push([t, last, Math.min(c, cb.COUNT_SATURATED)]);
  }
  return out;
}

/** @param {any} c */
const rolesOf = (c) => ({ rawRoles: Array.from({ length: c.R }, (_, j) => j),
  eventD: new Map(c.events_d.map((/** @type {number} */ d, /** @type {number} */ e) => [c.R + e, d])) });

test('format 1 blocks read back to the levels they were made from (capture_formats.json)', () => {
  assert.ok(DATA.logic_blocks.length >= 1);
  for (const c of DATA.logic_blocks) {
    const { rawRoles, eventD } = rolesOf(c);
    /** @type {number[] | null} */
    let prevEnd = null;
    for (const seg of c.segments) {
      const n = [...seg.raw, ...seg.events][0].length;
      const blocks = cb.readLogicBlocks(fromHex(seg.stream_hex), n, rawRoles, eventD, c.L);
      seg.raw.forEach((/** @type {string} */ levels, /** @type {number} */ j) => {
        assert.equal(blocks.map((b) => cb.bitsList(/** @type {Uint8Array} */ (b.raw.get(j)), b.samples).join('')).join(''), levels, c.name);
      });
      seg.events.forEach((/** @type {string} */ levels, /** @type {number} */ e) => {
        const role = c.R + e;
        let before = seg.contiguous && prevEnd ? prevEnd[e] : Number(levels[0]);
        for (const b of blocks) {
          const part = levels.slice(b.first, b.first + b.samples);
          assert.equal(b.startLevels.get(role), before, c.name);       // fallback or not (§1.3 start_level)
          if (b.fallback.has(role)) {
            assert.equal(cb.bitsList(/** @type {Uint8Array} */ (b.raw.get(role)), b.samples).join(''), part, c.name);
          } else {
            const ch = /** @type {cb.EventChannel} */ (b.events.get(role));
            assert.equal(ch.startLevel, before, c.name);
            assert.deepEqual(ch.ticks.map((t, i) => [t, ch.levels[i], ch.counts[i]]), expectTicks(levels, b.first, b.samples, c.events_d[e], before), c.name);
          }
          before = Number(part[part.length - 1]);
        }
      });
      prevEnd = seg.events.map((/** @type {string} */ ch) => Number(ch[ch.length - 1]));
    }
  }
});

test('segmentColumns gives the same lines as the blocks: raw bits whole, events ticks from the segment\'s first sample', () => {
  for (const c of DATA.logic_blocks) {
    const { rawRoles, eventD } = rolesOf(c);
    for (const seg of c.segments) {
      const n = [...seg.raw, ...seg.events][0].length;
      const cols = cb.segmentColumns(fromHex(seg.stream_hex), n, rawRoles, eventD, c.L);
      seg.raw.forEach((/** @type {string} */ levels, /** @type {number} */ j) => {
        assert.equal(cb.bitsList(/** @type {Uint8Array} */ (cols.get(j)), n).join(''), levels, c.name);
      });
      seg.events.forEach((/** @type {string} */ levels, /** @type {number} */ e) => {
        const col = /** @type {cb.EventColumn} */ (cols.get(c.R + e));
        // replayed from its start level, the ticks give the line's level at every tick end
        const d = c.events_d[e];
        let level = col.startLevel, k = 0;
        for (let t = 0; t * d < n; t++) {
          if (k < col.quanta.length && col.quanta[k] === t) level = col.levels[k++];
          assert.equal(level, Number(levels[Math.min((t + 1) * d, n) - 1]), `${c.name}: tick ${t}`);
        }
        assert.equal(k, col.quanta.length, c.name);
      });
    }
  }
});

test('a cut segment, or a byte past it, is a ProtocolError', () => {
  const c = DATA.logic_blocks[0], seg = c.segments[0];
  const data = fromHex(seg.stream_hex);
  const n = [...seg.raw, ...seg.events][0].length;
  const { rawRoles, eventD } = rolesOf(c);
  assert.throws(() => cb.readLogicBlocks(data.slice(0, -1), n, rawRoles, eventD, c.L), ProtocolError);
  assert.throws(() => cb.readLogicBlocks(Uint8Array.of(...data, 0), n, rawRoles, eventD, c.L), ProtocolError);
});

test('worstBytes matches the spec\'s example (§1.3: 4 raw, 12 events at D 64, L 4096)', () => {
  assert.equal(cb.worstBytes(4, Array(12).fill(64), 4096), 5128);
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
