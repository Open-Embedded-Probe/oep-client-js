// @ts-check
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The bundle loads and says the package's version (more checks come with the implementation).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const mod = await import(pathToFileURL(join(root, 'dist', 'oep-client.js')).href);
if (mod.VERSION !== pkg.version) throw new Error(`dist smoke: VERSION ${mod.VERSION}, package ${pkg.version}`);
console.log(`dist smoke ok (v${mod.VERSION})`);
