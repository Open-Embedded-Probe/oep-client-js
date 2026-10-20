// @ts-check
// oep.target.console and ConsoleIO: request shapes against a scripted link, and the flows against the virtual bench.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat, text, utf8 } from '../src/bytes.js';
import { Console, ConsoleIO, MARK_BYTES, MARK_DETAIL, MARK_NAMES, PositionStream } from '../src/console.js';
import { Failed, NoResource, Unavailable, Unsupported } from '../src/errors.js';
import { Wire } from '../src/riscv.js';
import { Host } from '../src/host.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveVirtualBench, startVirtualBench } from './virtual-bench.js';

const CONSOLE = 6;
const MECHANISMS = [Console.SDI, Console.DMDATA, Console.DMSEQ];

/** @typedef {(p: Uint8Array) => [number, number, Uint8Array]} Handler */
/** @param {Uint8Array} [p] @returns {[number, number, Uint8Array]} */
const ok = (p = new Uint8Array()) => [m.COMPLETED, m.SUCCESS, p];

/** A host over a link that answers each (fn, op) from `handlers` and logs [fn, op, payload].
 * @param {Record<string, Handler>} handlers @param {number} maxFrame */
function scripted(handlers, maxFrame = 1024) {
  /** @type {[number, number, Uint8Array][]} */
  const log = [];
  const link = {
    framing: 'length',
    /** @param {Uint8Array} bytes */
    async send(bytes) {
      const req = m.Request.unpack(bytes);
      log.push([req.fn, req.op, req.payload]);
      const h = handlers[`${req.fn}:${req.op}`];
      const [res, detail, payload] = h ? h(req.payload) : [m.REJECTED, m.REJECT.unknown_operation, new Uint8Array()];
      return new m.Result(req.corr, res, detail, payload).pack();
    },
  };
  const hst = new Host(/** @type {any} */ (link));
  hst.limits = { revision: 1, maxFrame, window: 4096, maxInflight: 4, bootId: 1, transport: 0, tail: new m.Tail() };
  hst.revision = 1;
  hst.fns.set(Console.NAME, CONSOLE);
  hst.revisions.set(CONSOLE, 1);
  hst.describes.set(m.CORE_FN, []);                                    // fn 0's describe read already (core §4.4)
  // the standard mechanisms, a named list (console §1, core §7.7)
  hst.describes.set(CONSOLE, MECHANISMS.map((n) => /** @type {[number, Uint8Array]} */ ([Console.TAG_MECHANISM, utf8(n)])));
  return { hst, log };
}

test('ConsoleIO counts what the ring dropped', async () => {
  /** @type {[number, string, number][]} */
  const reads = [[100, 'abc', 0], [103, 'de', 0], [200, 'xyz', 2]];   // [start, data, flags]; 2 = gap
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.READ}`]: () => {
      const [start, data, flags] = /** @type {[number, string, number]} */ (reads.shift());
      return ok(concat(new Writer().u64(start).u8(flags).u16(data.length).done(), utf8(data), m.tlv(0x41, [9])));   // len, then a TLV
    },
  });
  const io = await ConsoleIO.create(await Console.open(hst), 100);
  assert.equal(text(concat(await io.read(), await io.read())), 'abcde');
  assert.equal(io.lost, 0n);
  assert.equal(text(await io.read()), 'xyz');
  assert.equal(io.lost, 200n - 105n);
  assert.equal(io.position, 203n);
  // the third read: stream(u32) 1, from position 105, max 512
  assert.deepEqual(log[2][2], new Writer().u32(1).u8(PositionStream.FROM_POSITION).u64(105).u16(512).done());
});

test('a failed console open throws', async () => {
  const { hst } = scripted({ [`${CONSOLE}:${Console.OPEN}`]: () => [m.COMPLETED, m.FAILED, new Uint8Array()] });
  const con = await Console.open(hst);
  await assert.rejects(con.open(1), Failed);
});

test('marks are count x mark (22 bytes, no element length, core §2.3), paged with more', async () => {
  /** @param {number} serial */
  const mark = (serial) => new Writer().u32(serial).u64(5).u8(7).u64(10).u8(serial).done();
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.MARKS}`]: (p) => {
      const from = new m.Reader(p.slice(4)).u32();                     // after stream(u32)
      const page = from < 4 ? [from, from + 1] : [from];
      return ok(concat(Uint8Array.of(from < 4 ? 1 : 0, page.length), ...page.map(mark), m.tlv(0x50, [1])));   // a TLV after: skipped
    },
  });
  const con = await Console.open(hst);
  const marks = await con.marks(0);
  assert.deepEqual(marks.map((k) => k.serial), [0, 1, 2, 3, 4]);
  assert.deepEqual(marks[4], { serial: 4, position: 5n, kind: 7, timeNs: 10n, detail: 4 });
  assert.equal(log.length, 3);
  assert.equal(MARK_BYTES, 22);
  const CK = reg.TARGET_CONSOLE.enum.mark_kind, K = reg.COMMON.enum.mark_kind;
  assert.deepEqual(MARK_NAMES, { [K.lost]: 'lost', [K.clear]: 'clear', [K.host]: 'host', [CK.reset]: 'reset', [CK.restart]: 'restart' });
  assert.equal(MARK_DETAIL.lost.target_timeout, reg.TARGET_CONSOLE.enum.mark_detail_lost.target_timeout);
  assert.equal(MARK_DETAIL.restart.resync, reg.TARGET_CONSOLE.enum.mark_detail_restart.resync);
});

test('marks page by common §1.3: the last serial + 1 (wrapping) until more 0; streams take first(u16) past 255', async () => {
  const kept = [0xfffffffe, 0xffffffff, 0, 1, 2];                      // the next mark gets 3
  /** @param {number} serial */
  const mark = (serial) => new Writer().u32(serial).u64(1).u8(7).u64(1).u8(0).done();
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.MARKS}`]: (p) => {
      const from = new m.Reader(p.slice(4)).u32();
      const at = from === 3 ? kept.length : Math.max(0, kept.indexOf(from));
      const page = kept.slice(at, at + 2);
      return ok(concat(Uint8Array.of(at + page.length < kept.length ? 1 : 0, page.length), ...page.map(mark)));
    },
    [`${CONSOLE}:${Console.STREAMS}`]: (p) => {
      const first = new m.Reader(p).u16();
      const n = Math.min(100, 300 - first);
      // stream(u32) connection(u32) mechanism(u8): its place in the named list (from 1)
      const rows = Array.from({ length: n }, (_, i) => new Writer().u32(1000 + first + i).u32(1).u8(MECHANISMS.indexOf(Console.DMSEQ) + 1).done());
      return ok(concat(Uint8Array.of(first + n < 300 ? 1 : 0, n), ...rows));
    },
  });
  const con = await Console.open(hst);
  assert.deepEqual((await con.marks(0xfffffffe)).map((k) => k.serial), kept);
  assert.deepEqual(log.map(([, , p]) => new m.Reader(p.slice(4)).u32()), [0xfffffffe, 0, 2]);   // last + 1 mod 2^32
  assert.deepEqual(await con.marksPage(3), { marks: [], more: false });
  log.length = 0;
  const streams = await con.streams();
  assert.equal(streams.length, 300);
  assert.deepEqual(streams[0], { stream: 1000, connection: 1, mechanism: Console.DMSEQ });   // by name (core §7.7)
  assert.deepEqual(log.map(([, , p]) => [p.length, new m.Reader(p).u16()]), [[2, 0], [2, 100], [2, 200]]);
});

test('console write: completed partial is no error, accepted 0 is failed, write() waits for the rest', async () => {
  const taken = [3, 0, 2];
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.WRITE}`]: (p) => {
      const count = new m.Reader(p.slice(4)).u16();
      const took = Math.min(/** @type {number} */ (taken.shift()), count);
      return [m.COMPLETED, took === count ? m.SUCCESS : took ? m.PARTIAL : m.FAILED, new Writer().u16(took).done()];
    },
  }, 64);
  const con = await Console.open(hst);
  const io = new ConsoleIO(con, 0n);
  await io.write('PING\n');
  assert.deepEqual(log.map(([, , p]) => text(p.slice(6))), ['PING\n', 'G\n', 'G\n']);   // after stream(u32) count(u16)
});

test('ConsoleIO writes at most a frame at a time; the send queue is the probe\'s own size (console §1, §2)', async () => {
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.WRITE}`]: (p) => [m.COMPLETED, m.SUCCESS, new Writer().u16(new m.Reader(p.slice(4)).u16()).done()],
  }, 256);
  const io = new ConsoleIO(await Console.open(hst), 0n);
  await io.write(new Uint8Array(600));
  const most = 256 - 12 - 4;                                           // the header 10, count 2, the stream number 4
  assert.deepEqual(log.map(([, , p]) => p.length - 6), [most, most, 600 - 2 * most]);
  assert.equal(/** @type {any} */ (io).sendQueue, undefined);         // no send_queue declaration any more
  assert.equal(/** @type {any} */ (reg.TARGET_CONSOLE.tlv.describe).send_queue, undefined);
});

test('console against the virtual bench: open makes a stream, one live a connection; marks; write; a closed one is gone (console §1, §2)', { skip: !haveVirtualBench }, async () => {
  const bench = await startVirtualBench(['--console', 'hello %d\\n', '--every', '20']);
  const hst = await openTcp({ port: bench.port });
  try {
    await hst.open(5000, { owner: 'js console test' });
    const wire = await Wire.open(hst);
    const { conn } = await wire.attach({ halt: false });
    const con = await Console.open(hst);
    const sid = await con.open(conn, Console.DMSEQ);
    assert.deepEqual(await con.streams(), [{ stream: sid, connection: conn, mechanism: Console.DMSEQ }]);
    for (const mech of [Console.DMSEQ, Console.SDI]) {                  // the same or another mechanism: cause 6
      await assert.rejects((await Console.open(hst)).open(conn, mech), (e) => e instanceof Unavailable && e.cause === 'wrong_state');
    }
    await assert.rejects(con.open(conn, 9), (e) => e instanceof Unsupported && e.tag === null && e.result.payload[0] === 0);   // a fixed-part value: 0x00
    const io = await ConsoleIO.create(con);
    await io.readUntil('\n');                                   // from now: maybe the tail of a line
    assert.match(text(await io.readUntil('\n')), /^hello \d+\n$/);
    const first = await con.read(Console.FROM_OLDEST, 0, 5);
    assert.deepEqual([first.start, first.more, first.gap, first.data.length], [0n, true, false, 5]);

    const host = reg.COMMON.enum.mark_kind.host;
    for (let v = 0; v < 7; v++) await con.mark(v);             // several marks at the same position
    const marks = await con.marks();
    assert.deepEqual(marks.map((k) => k.serial), [0, 1, 2, 3, 4, 5, 6]);   // no mark at open; 7 host marks
    assert.deepEqual(marks.map((k) => k.kind), Array(7).fill(host));
    assert.deepEqual(marks.map((k) => k.detail), [0, 1, 2, 3, 4, 5, 6]);
    const page = await con.marksPage(5);
    assert.deepEqual([page.marks.map((k) => k.serial), page.more], [[5, 6], false]);
    assert.ok(marks[0].timeNs > 0n);                                     // the probe's one clock, ns
    assert.equal((await con.read(Console.FROM_MARK, host, 16)).start, marks[6].position);

    assert.equal(await con.write(utf8('PING\n')), 5);                  // into the send queue (console §2)
    await con.clear();
    assert.equal((await con.marks()).at(-1)?.kind, reg.COMMON.enum.mark_kind.clear);

    await wire.detach(conn);                                             // the stream goes with its connection
    await assert.rejects(con.read(), NoResource);
    await assert.rejects(con.write(utf8('x')), NoResource);
    assert.deepEqual(await con.streams(), []);
    const sdi = await Console.open(hst);
    await sdi.open((await wire.attach({ halt: false })).conn, Console.SDI);
    await assert.rejects(sdi.write(utf8('x')), (e) => e instanceof Unsupported && e.result.payload[0] === 0);   // SDI: no host -> target way
    await hst.end();
  } finally {
    await hst.link.close();
    bench.stop();
  }
});
