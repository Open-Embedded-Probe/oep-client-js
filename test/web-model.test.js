// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integer, hexBytes, printable, parseRoute, connectionName, firmwareState, validateBindings } from '../web/model.js';

test('device numeric fields reject blank, partial, fractional and out-of-range input before sending', () => {
  assert.equal(integer('0x20000000'), 0x20000000);
  assert.equal(integer('115200', 1), 115200);
  for (const value of ['', ' ', '-1', '1.5', '3MHz', 'Infinity', '1e4', '0x100000000']) assert.throws(() => integer(value), RangeError);
  assert.throws(() => integer('0', 1), RangeError);
  assert.throws(() => integer('65536', 0, 65535), RangeError);
});

test('hex transfer fields accept explicit bytes and reject incomplete or invalid bytes', () => {
  assert.deepEqual(hexBytes('0x9f 00, 0xAB'), Uint8Array.of(0x9f, 0, 0xab));
  assert.deepEqual(hexBytes(''), new Uint8Array());
  for (const raw of ['f', 'fff', '00 x1', '0g']) assert.throws(() => hexBytes(raw), RangeError);
});

test('routes keep deep links and old entry points without interpreting hashes as selectors', () => {
  assert.deepEqual(parseRoute('#signals/spi-controller'), { view: 'signals', arg: 'spi-controller' });
  assert.deepEqual(parseRoute('#target/edit/board-1'), {view:'target',arg:'edit/board-1'});
  assert.deepEqual(parseRoute('#setup'), {view:'setup',arg:''});
  assert.deepEqual(parseRoute('#connect'), { view: 'connect', arg: '' });
  assert.deepEqual(parseRoute('#target'), { view: 'target', arg: 'new' });
  assert.deepEqual(parseRoute('#details'), { view: 'diagnostics', arg: '' });
  assert.deepEqual(parseRoute('#try'), { view: 'signals', arg: 'gpio' });
  assert.deepEqual(parseRoute('#boards/pico'), { view: 'help', arg: 'pico' });
  assert.deepEqual(parseRoute('#"]><script>'), { view: 'home', arg: '' });
});

test('connection names reject case-insensitive replacement and invalid labels', () => {
  assert.equal(connectionName('board-2', ['board-1']), 'board-2');
  for (const name of ['2board', 'has.dot', 'has space', 'a'.repeat(17), '']) assert.throws(() => connectionName(name));
  assert.throws(() => connectionName('BOARD-1', ['board-1']), /already exists/);
});

test('firmware versions distinguish upgrade, reinstall, downgrade and unknown versions', () => {
  assert.equal(firmwareState('0.0.9', '0.0.10'), 'update');
  assert.equal(firmwareState('0.0.10+board', '0.0.10'), 'current');
  assert.equal(firmwareState('1.0.0', '0.99.0'), 'newer');
  assert.equal(firmwareState('1.0.0-rc.1', '1.0.0'), 'unknown');
  assert.equal(firmwareState(null, '1.0.0'), 'unknown');
});

test('results preserve large times and binary bytes without losing their values', () => {
  const result = JSON.parse(printable({ time: 9007199254740993n, values: new Map([[0, 42]]), bytes: Uint8Array.of(0, 255) }));
  assert.equal(result.time, '9007199254740993');
  assert.equal(result.values[0], 42);
  assert.equal(result.bytes.hex, '00 ff');
});


test('fixed wiring validates groups and role intersections without scanning or claiming pins', () => {
  const roles = new Map([[1, [1, 3]], [2, [2, 4]]]);
  const groups = new Map([[0, /** @type {[number,number][]} */ ([[1, 1], [2, 2]])], [1, /** @type {[number,number][]} */ ([[1, 3], [2, 4]])]]);
  assert.deepEqual(validateBindings(roles, groups, [[1, 1], [2, 2]]), [[1, 1], [2, 2]]);
  assert.throws(() => validateBindings(roles, groups, [[1, 1], [2, 4]]), /channel group/);
  assert.throws(() => validateBindings(new Map([[1, [3]]]), groups, [[1, 1]]), /channel group/);
  assert.deepEqual(validateBindings(new Map(), groups, [[1, 3], [2, 4]]), [[1, 3], [2, 4]]);
  assert.throws(() => validateBindings(roles, new Map(), [[1, 1], [2, 1]]), /different pin/);
  assert.throws(() => validateBindings(roles, new Map(), []), /at least one/);
});
