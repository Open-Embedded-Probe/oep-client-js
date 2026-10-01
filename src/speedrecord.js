// @ts-check
// The port_speed record (oep-spec host-development-guide.ja.md §7.4): which rates passed or failed on a serial port
// with a probe, so the next session puts a passed rate first and leaves failed ones out until they expire.
//
// Keyed by the port (the OS device path) and the probe's unit_id: the bridge chip belongs to the port, the probe to
// the unit_id, so either one changing starts the record afresh. In a browser the port has no name (WebSerial shows
// none), so the key is the unit_id alone. Entries older than EXPIRY_DAYS (30) are dropped. The record is a cache: a
// store that cannot be read or written is not an error (`SpeedRecord.error` says what went wrong).
//
// Where it lives is the store's business: `fileStore(path)` (Node; the default is
// `$XDG_CACHE_HOME/oep-client/link-speed.json`, `~/.cache/...` - the same file and shape as oep-client-python's
// speed_record, so the two clients share what they learned about a port), `localStorageStore()` (a browser),
// `memoryStore()` (tests, or a session that should remember nothing past itself).
//
//   const rec = new SpeedRecord(await defaultStore());
//   const { passed, failed } = rec.lookup('/dev/ttyUSB0', '0070070d9394');
//   rec.note('/dev/ttyUSB0', '0070070d9394', 921600, true);
//
// `raiseSpeed(host, candidates, { record: true })` reads and writes it; the library default is off.

export const EXPIRY_DAYS = 30;
/** The file under the user's cache directory (Node). */
export const FILE_NAME = 'link-speed.json';
export const DIR_NAME = 'oep-client';
/** The localStorage key (a browser). */
export const STORAGE_KEY = 'oep-client.link-speed';

/**
 * Where a record is kept: `load` gives what was saved (anything; not an object = nothing), `save` keeps it. Both are
 * synchronous and may throw: the record catches and reports.
 * @typedef {{ name: string, load: () => unknown, save: (data: Record<string, unknown>) => void }} RecordStore
 */

/** A store that forgets when the process ends. @returns {RecordStore} */
export function memoryStore() {
  /** @type {unknown} */ let kept = null;
  return { name: '<memory>', load: () => kept, save: (data) => { kept = JSON.parse(JSON.stringify(data)); } };
}

/**
 * A browser's localStorage (or anything with getItem / setItem) under `key`.
 * @param {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void }} [storage]
 * @param {string} [key] @returns {RecordStore}
 */
export function localStorageStore(storage = /** @type {any} */ (globalThis).localStorage, key = STORAGE_KEY) {
  if (!storage) throw new Error('no localStorage here');
  return {
    name: `localStorage[${key}]`,
    load: () => { const s = storage.getItem(key); return s === null ? null : JSON.parse(s); },
    save: (data) => storage.setItem(key, JSON.stringify(data)),
  };
}

const isNode = () => typeof process !== 'undefined' && !!(/** @type {any} */ (process).versions?.node);

/** `node:fs` and friends, imported by name so a browser bundle never sees them. @param {string} name */
async function nodeModule(name) {
  const spec = `node:${name}`;
  return import(spec);
}

/** Node: `$XDG_CACHE_HOME/oep-client/link-speed.json`, else `~/.cache/oep-client/link-speed.json` (as
 * oep-client-python's speed_record.default_path). */
export async function defaultFilePath() {
  const [os, path] = await Promise.all([nodeModule('os'), nodeModule('path')]);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, DIR_NAME, FILE_NAME);
}

/**
 * Node: one JSON file, written whole through a temporary file next to it (the directory made as needed).
 * @param {string} [path] default: `defaultFilePath()` @returns {Promise<RecordStore>}
 */
export async function fileStore(path) {
  const [fs, p] = await Promise.all([nodeModule('fs'), nodeModule('path')]);
  const file = path ?? await defaultFilePath();
  return {
    name: file,
    load: () => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (/** @type {any} */ (e)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    save: (data) => {
      fs.mkdirSync(p.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(sortedKeys(data), null, 1) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    },
  };
}

/** The same value with every object's keys in order (the file reads the same whoever wrote it). @param {unknown} v @returns {unknown} */
function sortedKeys(v) {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(/** @type {Record<string, unknown>} */ (v)[k])]));
  }
  return v;
}

/** The store this environment keeps a record in: Node's cache file, a browser's localStorage, else memory. */
export async function defaultStore() {
  if (isNode()) return fileStore();
  if (/** @type {any} */ (globalThis).localStorage) return localStorageStore();
  return memoryStore();
}

/** @typedef {{ port: string | null, unit_id: string, rates: Record<string, { passed: boolean, at: string }> }} Entry */

/**
 * The record: `{ "<port>|<unit_id>" (or "<unit_id>" without a port): { port, unit_id, rates: { "<rate>": { passed, at } } } }`.
 */
export class SpeedRecord {
  /**
   * @param {RecordStore} store
   * @param {{ expiryDays?: number, now?: () => number }} [opts]  now: ms since the epoch (tests move it)
   */
  constructor(store, { expiryDays = EXPIRY_DAYS, now = () => Date.now() } = {}) {
    this.store = store;
    this.expiryMs = expiryDays * 86400_000;
    this.now = now;
    /** @type {string | null} why the store could not be read or written (the record is a cache: not an error) */
    this.error = null;
    /** @type {Record<string, Entry>} */
    this.data = {};
    try {
      const loaded = store.load();
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) this.data = /** @type {Record<string, Entry>} */ (loaded);
    } catch (e) {
      this.error = `${store.name}: ${e instanceof Error ? e.message : e}`;
    }
  }

  /** @param {string | null} port @param {string} unitId */
  static key(port, unitId) { return port === null ? unitId : `${port}|${unitId}`; }

  /** The entry's rates that have not expired: rate -> passed. @param {Entry | undefined} entry */
  fresh(entry) {
    /** @type {Map<number, boolean>} */
    const out = new Map();
    const cutoff = this.now() - this.expiryMs;
    for (const [rate, v] of Object.entries(entry?.rates ?? {})) {
      const at = Date.parse(v?.at);
      if (Number.isFinite(at) && at >= cutoff && Number.isFinite(Number(rate))) out.set(Number(rate), !!v.passed);
    }
    return out;
  }

  /**
   * The rates that passed and the rates that failed on this port with this probe, within the expiry; each rate is in one
   * list only (its latest note), fastest first.
   * @param {string | null} port @param {string} unitId @returns {{ passed: number[], failed: number[] }}
   */
  lookup(port, unitId) {
    const rates = this.fresh(this.data[SpeedRecord.key(port, unitId)]);
    const by = (/** @type {boolean} */ ok) => [...rates].filter(([, p]) => p === ok).map(([r]) => r).sort((a, b) => b - a);
    return { passed: by(true), failed: by(false) };
  }

  /** Remember that `rate` passed (or failed) now, and save.
   * @param {string | null} port @param {string} unitId @param {number} rate @param {boolean} passed */
  note(port, unitId, rate, passed) {
    const key = SpeedRecord.key(port, unitId);
    const entry = this.data[key] ?? (this.data[key] = { port, unit_id: unitId, rates: {} });
    entry.port = port;
    entry.unit_id = unitId;
    (entry.rates ?? (entry.rates = {}))[String(Math.trunc(rate))] = { passed: !!passed, at: new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, '+00:00') };
    return this.save();
  }

  /** Write the store (expired rates dropped). false (and `error` set) when it cannot be written. */
  save() {
    for (const key of Object.keys(this.data)) {
      const entry = this.data[key];
      const fresh = entry && typeof entry === 'object' ? this.fresh(entry) : new Map();
      if (!fresh.size) { delete this.data[key]; continue; }
      entry.rates = Object.fromEntries(Object.entries(entry.rates).filter(([r]) => fresh.has(Number(r))));
    }
    try {
      this.store.save(this.data);
      return true;
    } catch (e) {
      this.error = `${this.store.name}: ${e instanceof Error ? e.message : e}`;
      return false;
    }
  }
}
