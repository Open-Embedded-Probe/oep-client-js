// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionName, firmwareState } from '../web/model.js';

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

