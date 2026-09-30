// @ts-check
// The probe firmware a release lists: firmware-<version>.json ("schema": 1, oep-probe-arduino's Firmware workflow)
// names each file with its kind (merged: ESP32 at 0x0 with esptool; app: the app image alone, the P4's DFU update;
// uf2: RP2040 / RP2350), the describe model it is for, and its sha256. Environment-free (fetch and crypto.subtle from
// globalThis).

/**
 * @typedef {object} FirmwareEntry
 * @property {string} file        the file name, next to the json
 * @property {'merged' | 'app' | 'uf2' | string} kind
 * @property {string} model       the describe model (esp32p4, esp32, rp2040, rp2350): the chip built for
 * @property {string} [example]   the sketch (Firmware/OepProbe)
 * @property {string} [profile]
 * @property {string} [fqbn]
 * @property {number | null} [flash_offset]
 * @property {string} sha256      lowercase hex
 */

/** @typedef {{ schema: 1, library?: string, version: string, firmware: FirmwareEntry[] }} FirmwareManifest */

/** SHA-256 of `bytes`, lowercase hex. @param {Uint8Array} bytes */
export async function sha256(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', /** @type {Uint8Array<ArrayBuffer>} */ (bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check and return a firmware-<version>.json (the parsed object or its text).
 * @param {unknown} json
 * @returns {FirmwareManifest}
 */
export function parseFirmwareManifest(json) {
  const m = /** @type {any} */ (typeof json === 'string' ? JSON.parse(json) : json);
  if (!m || typeof m !== 'object') throw new Error('firmware manifest: not an object');
  if (m.schema !== 1) throw new Error(`firmware manifest: schema ${m.schema} (this client reads schema 1)`);
  if (!Array.isArray(m.firmware)) throw new Error('firmware manifest: no "firmware" list');
  for (const f of m.firmware) {
    if (!f || typeof f.file !== 'string' || typeof f.kind !== 'string' || typeof f.model !== 'string' || !/^[0-9a-fA-F]{64}$/.test(f.sha256 ?? '')) {
      throw new Error(`firmware manifest: a bad entry ${JSON.stringify(f)}`);
    }
    if (f.file.includes('/') || f.file.includes('\\') || f.file.startsWith('.')) throw new Error(`firmware manifest: a bad file name ${f.file}`);
  }
  return m;
}

/**
 * The file for a probe model and kind (the P4's DFU update: model esp32p4, kind app). When several sketches match,
 * the Firmware/OepProbe build is taken.
 * @param {FirmwareManifest} manifest
 * @param {{ model: string, kind?: string, example?: string, profile?: string }} want
 * @returns {FirmwareEntry | null}
 */
export function pickFirmware(manifest, { model, kind, example, profile }) {
  const matches = manifest.firmware.filter((f) => f.model === model && (!kind || f.kind === kind)
    && (!example || f.example === example) && (!profile || f.profile === profile));
  return matches.find((f) => f.example === 'Firmware/OepProbe') ?? matches[0] ?? null;
}

/** The URL of an entry's file, next to the manifest. @param {string | URL} manifestUrl @param {FirmwareEntry} entry */
export function firmwareFileUrl(manifestUrl, entry) {
  return new URL(entry.file, manifestUrl).href;
}

/**
 * @param {string | URL} url
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 */
export async function fetchFirmwareManifest(url, { fetch = globalThis.fetch } = {}) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`firmware manifest ${url}: HTTP ${r.status}`);
  return parseFirmwareManifest(await r.json());
}

/**
 * Throw unless `bytes` is the entry's file (its sha256).
 * @param {Uint8Array} bytes @param {FirmwareEntry} entry
 */
export async function verifyFirmware(bytes, entry) {
  const got = await sha256(bytes);
  if (got !== entry.sha256.toLowerCase()) throw new Error(`${entry.file}: sha256 ${got}, the manifest says ${entry.sha256}`);
  return bytes;
}

/**
 * The entry's file, fetched from beside the manifest and checked against its sha256.
 * @param {string | URL} manifestUrl @param {FirmwareEntry} entry
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 */
export async function fetchFirmware(manifestUrl, entry, { fetch = globalThis.fetch } = {}) {
  const url = firmwareFileUrl(manifestUrl, entry);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return verifyFirmware(new Uint8Array(await r.arrayBuffer()), entry);
}
