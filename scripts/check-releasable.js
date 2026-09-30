// @ts-check
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unreleasedEntries } from './sync-version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  if (pkg[field]?.[pkg.name] !== undefined) throw new Error(`package.json: ${field} contains this package itself.`);
}
const entries = unreleasedEntries(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));
if (!entries) throw new Error('Nothing is written under "## Unreleased" in CHANGELOG.md.');
console.log(`Ready to release: ${entries.split('\n').filter((line) => line.startsWith('- ')).length} changelog line(s).`);
