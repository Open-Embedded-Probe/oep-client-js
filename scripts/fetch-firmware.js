// @ts-check
// The page's firmware: the latest oep-probe-arduino Release's OepProbe images, put under site/firmware/ beside the page.
// A browser cannot fetch a Release's files itself (release-assets.githubusercontent.com sends no CORS header), so the
// Pages deploy copies them: site/firmware/firmware.json (the Release's firmware-<version>.json, the OepProbe entries)
// and each file it lists, its sha256 checked. GITHUB_TOKEN, when set, lifts the API's rate limit.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFirmwareManifest, sha256 } from '../src/firmware.js';

const REPO = process.env.OEP_FIRMWARE_REPO ?? 'Open-Embedded-Probe/oep-probe-arduino';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site', 'firmware');
const headers = { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

/** @param {string} url */
async function get(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

const release = await (await get(`https://api.github.com/repos/${REPO}/releases/latest`)).json();
const assets = new Map(release.assets.map((/** @type {any} */ a) => [a.name, a]));
const listing = [...assets.keys()].find((n) => /^firmware-.+\.json$/.test(n));
if (!listing) throw new Error(`${REPO} ${release.tag_name}: no firmware-<version>.json`);
// the files by their download URL (github.com, not the API: one API request in all, whatever the rate limit)
const download = async (/** @type {string} */ name) => {
  const r = await fetch(assets.get(name).browser_download_url);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};
const manifest = parseFirmwareManifest(new TextDecoder().decode(await download(listing)));
manifest.firmware = manifest.firmware.filter((f) => f.example === 'Firmware/OepProbe');
mkdirSync(out, { recursive: true });
for (const f of manifest.firmware) {
  if (!assets.has(f.file)) throw new Error(`${listing} lists ${f.file}, not in the Release`);
  const bytes = await download(f.file);
  if (await sha256(bytes) !== f.sha256.toLowerCase()) throw new Error(`${f.file}: sha256 differs from ${listing}`);
  writeFileSync(join(out, f.file), bytes);
}
writeFileSync(join(out, 'firmware.json'), JSON.stringify({ ...manifest, release: release.tag_name }, null, 2) + '\n');
console.log(`site/firmware: ${release.tag_name}, ${manifest.firmware.length} files`);
