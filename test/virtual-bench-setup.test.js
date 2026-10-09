import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('./virtual-bench.js', import.meta.url).href;

/** @param {Record<string, string | null>} extra */
function loadBackend(extra = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath,
    ['--input-type=module', '-e', `import { PYTHON } from ${JSON.stringify(helper)}; console.log(PYTHON)`],
    { env, encoding: 'utf8' });
}

test('an explicitly missing virtual probe is an error, never a skip', () => {
  const result = loadBackend({ OEP_PYTHON: '/not-present/oep-test-python' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required virtual bench is unavailable/);
});

test('the optional default does not inspect a sibling checkout', () => {
  const result = loadBackend({ OEP_PYTHON: null, OEP_REQUIRE_VIRTUAL_BENCH: null });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'python3');
});

test('a required default backend fails when Python is not available', () => {
  const result = loadBackend({ OEP_PYTHON: null, OEP_REQUIRE_VIRTUAL_BENCH: '1', PATH: '/not-present/oep-tools' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required virtual bench is unavailable/);
});
