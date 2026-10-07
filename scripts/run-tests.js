// @ts-check
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(root, 'test', name));
const args = ['--test', ...(process.argv.includes('--watch') ? ['--watch'] : []), ...files];
// the kept session ids (src/keptsession.js) go to a temporary directory, never the user's cache directory
const env = { ...process.env, OEP_SESSION_DIR: mkdtempSync(join(tmpdir(), 'oep-sessions-')) };
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
