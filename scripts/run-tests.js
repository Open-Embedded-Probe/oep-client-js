// @ts-check
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(root, 'test', name));
const args = ['--test', ...(process.argv.includes('--watch') ? ['--watch'] : []), ...files];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
