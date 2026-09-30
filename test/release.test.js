// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseChangelog, syncSourceVersion, unreleasedEntries } from '../scripts/sync-version.js';

const SOURCE = "export const VERSION = '0.0.1';\n";

test('the source version is set, also to the version it already has', () => {
  assert.equal(syncSourceVersion(SOURCE, '0.0.2'), "export const VERSION = '0.0.2';\n");
  assert.equal(syncSourceVersion(SOURCE, '0.0.1'), SOURCE);          // npm version 0.0.1 --allow-same-version
  assert.throws(() => syncSourceVersion('const x = 1;\n', '0.0.1'), /VERSION declaration was not found/);
});

test('the changelog gets the version heading under Unreleased', () => {
  const log = '# Changelog\n\n## Unreleased\n\n- (EN) a\n- (JA) b\n';
  assert.equal(unreleasedEntries(log), '- (EN) a\n- (JA) b');
  assert.equal(releaseChangelog(log, '0.0.1'), '# Changelog\n\n## Unreleased\n\n## 0.0.1\n\n- (EN) a\n- (JA) b\n');
  assert.throws(() => releaseChangelog('# Changelog\n\n## Unreleased\n', '0.0.1'), /nothing under/);
});
