// @ts-check
// oep.target.console and ConsoleIO: request shapes against a scripted link, and the flows against the fake probe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writer, concat, text, utf8 } from '../src/bytes.js';
import { Console, ConsoleIO, MARK_BYTES, MARK_DETAIL, MARK_NAMES, PositionStream } from '../src/console.js';
import { Failed, Rejected, Unavailable, Unsupported } from '../src/errors.js';
import { Wire } from '../src/riscv.js';
import { Host } from '../src/host.js';
import * as m from '../src/message.js';
import * as reg from '../src/registry.js';
import { openTcp } from '../src/node/index.js';
import { haveFake, startFake } from './fake.js';

const CONSOLE = 6;

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
  hst.limits = { revision: 1, flags: 0, maxFrame, window: 4096, maxInflight: 4, bootId: 1, tail: new m.Tail() };
  hst.revision = 1;
  hst.fns.set(Console.NAME, CONSOLE);
  hst.revisions.set(CONSOLE, 1);
  return { hst, log };
}

test('ConsoleIO counts what the ring dropped', async () => {
  /** @type {[number, string, number][]} */
  const reads = [[100, 'abc', 0], [103, 'de', 0], [200, 'xyz', 2]];   // [start, data, flags]; 2 = gap
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.READ}`]: () => {
      const [start, data, flags] = /** @type {[number, string, number]} */ (reads.shift());
      return ok(concat(new Writer().u64(start).u8(flags).u16(data.length).done(), utf8(data), Uint8Array.of(0x41, 1, 9)));   // len, then a TLV
    },
  });
  const io = await ConsoleIO.create(await Console.open(hst), 100);
  assert.equal(text(concat(await io.read(), await io.read())), 'abcde');
  assert.equal(io.lost, 0n);
  assert.equal(text(await io.read()), 'xyz');
  assert.equal(io.lost, 200n - 105n);
  assert.equal(io.position, 203n);
  // the third read: stream(u16) 1, from position 105, max 512
  assert.deepEqual(log[2][2], new Writer().u16(1).u8(PositionStream.FROM_POSITION).u64(105).u16(512).done());
});

test('a failed console open throws', async () => {
  const { hst } = scripted({ [`${CONSOLE}:${Console.OPEN}`]: () => [m.COMPLETED, m.FAILED, new Uint8Array()] });
  const con = await Console.open(hst);
  await assert.rejects(con.open(1), Failed);
});

test('marks are len-prefixed elements, paged with more', async () => {
  /** @param {number} serial */
  const mark = (serial) => m.element(new Writer().u32(serial).u64(5).u8(7).u64(10).u8(serial).u8(0xee).done());   // one byte more: skipped
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.MARKS}`]: (p) => {
      const from = new m.Reader(p.slice(2)).u32();
      const page = from < 4 ? [from, from + 1] : [from];
      return ok(concat(Uint8Array.of(from < 4 ? 1 : 0, page.length), ...page.map(mark)));
    },
  });
  const con = await Console.open(hst);
  const marks = await con.marks(0);
  assert.deepEqual(marks.map((k) => k.serial), [0, 1, 2, 3, 4]);
  assert.deepEqual(marks[4], { serial: 4, position: 5n, kind: 7, timeNs: 10n, detail: 4 });
  assert.equal(log.length, 3);
  assert.equal(MARK_BYTES, 22);
  assert.equal(MARK_NAMES[8], 'link-lost');
  assert.equal(MARK_NAMES[9], 'closed');
  assert.equal(MARK_DETAIL.closed.connection_closed, 4);
});

test('console write: completed partial is no error, accepted 0 is failed, write() waits for the rest', async () => {
  const taken = [3, 0, 2];
  const { hst, log } = scripted({
    [`${CONSOLE}:${Console.WRITE}`]: (p) => {
      const count = new m.Reader(p.slice(2)).u16();
      const took = Math.min(/** @type {number} */ (taken.shift()), count);
      return [m.COMPLETED, took === count ? m.SUCCESS : took ? m.PARTIAL : m.FAILED, new Writer().u16(took).done()];
    },
  }, 64);
  const con = await Console.open(hst);
  const io = new ConsoleIO(con, 0n);
  await io.write('PING\n');
  assert.deepEqual(log.map(([, , p]) => text(p.slice(4))), ['PING\n', 'G\n', 'G\n']);
});

test('console streams against the fake probe', { skip: !haveFake }, async () => {
  const fake = await startFake(['--console', 'hello %d\\n', '--every', '20']);
  const hst = await openTcp({ port: fake.port });
  try {
    await hst.open(5000, { owner: 'js console test' });
    const wire = await Wire.open(hst);
    const { conn } = await wire.attach({ halt: false });
    const con = await Console.open(hst);
    const sid = await con.open(conn, Console.DMSEQ);
    assert.equal(con.existing, false);
    assert.deepEqual(await con.streams(), [{ stream: sid, connection: conn, mechanism: Console.DMSEQ, users: 1, state: 0, open: true }]);
    await assert.rejects(con.open(conn, Console.SDI), (e) => e instanceof Unavailable && e.cause === 'wrong_state');   // one live stream a connection
    await assert.rejects(con.open(conn, Console.NONE), Unsupported);
    const io = await ConsoleIO.create(con);
    await io.readUntil('\n');                                   // from now: maybe the tail of a line
    const line = text(await io.readUntil('\n'));
    assert.match(line, /^hello \d+\n$/);

    const again = await Console.open(hst);
    assert.equal(await again.open(conn, Console.DMSEQ), sid);   // a one-shot process carries on
    assert.equal(again.existing, true);

    const first = await con.read(Console.FROM_OLDEST, 0, 5);
    assert.equal(first.start, 0n);
    assert.equal(first.more, true);
    assert.equal(first.gap, false);
    assert.equal(first.data.length, 5);

    for (let v = 0; v < 6; v++) await con.mark(v);             // several marks at the same position
    const marks = await con.marks();
    assert.deepEqual(marks.map((k) => k.serial), [0, 1, 2, 3, 4, 5, 6]);   // attach + 6 host marks
    assert.deepEqual(marks.map((k) => k.kind), [3, 7, 7, 7, 7, 7, 7]);
    assert.deepEqual(marks.slice(1).map((k) => k.detail), [0, 1, 2, 3, 4, 5]);
    const page = await con.marksPage(5);
    assert.deepEqual(page.marks.map((k) => k.serial), [5, 6]);
    assert.equal(page.more, false);

    assert.ok(marks[0].timeNs > 0n);                                     // the probe's one clock, ns
    const fromMark = await con.read(Console.FROM_MARK, reg.COMMON.enum.mark_kind.host, 16);
    assert.equal(fromMark.start, marks[6].position);

    const accepted = await con.write(utf8('PING\n'));
    assert.ok(accepted > 0 && accepted <= 5);

    await io.readAll();
    assert.equal(io.more, false);                                // readAll followed more to its end

    await assert.rejects(con.open(conn, 9), (e) => e instanceof Unsupported && e.tag === null && e.result.payload[0] === 0);   // a fixed-part value: 0x00

    await con.clear();
    assert.equal((await con.marks()).at(-1)?.kind, reg.COMMON.enum.mark_kind.clear);

    await wire.detach(conn);
    const last = (await con.marks()).slice(-2);
    assert.deepEqual(last.map((k) => k.kind), [reg.COMMON.enum.mark_kind.detach, reg.COMMON.enum.mark_kind.closed]);   // closed, still readable
    assert.equal(last[1].detail, MARK_DETAIL.closed.connection_closed);
    assert.ok((await con.read()).start >= 0n);
    assert.equal((await con.streams())[0].open, false);
    await assert.rejects(con.write(utf8('x')), Rejected);
    await con.close();                                                   // closed already: ok
    await hst.end();
  } finally {
    await hst.link.close();
    fake.stop();
  }
});
