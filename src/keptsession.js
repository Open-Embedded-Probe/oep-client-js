// @ts-check
// The session id a host that may stop and run again keeps per probe (oep-spec host guide §5, transports §3), as
// oep-client-python's kept_session.
//
// A probe keeps a session when its transport closes (transports §3): a page reloaded, a script killed, a lost line
// leaves its lock and what it held until the lease runs out. So a host keeps the id of the session it has open, per
// probe, keyed by the probe's unit_id (fn 0's describe, core §7.5), and the next run, before its first open, opens that
// id and ends it at once - releasing what the previous run held - then opens as usual. An open with the id of the
// session holding the lock is taken as a resend of its open (core §6.2: nothing released), so the end that follows is
// a new request of that session.
//
// Where the id is kept is the store's business:
//   - `fileKeptStore(dir)` (Node): `<dir>/<unit_id>.session`, the id as 8 hex digits, empty when no session is open -
//     the same file and shape as oep-client-python's. The directory is $OEP_SESSION_DIR, else $XDG_RUNTIME_DIR/oep-client,
//     else the user's cache directory (%LOCALAPPDATA%\oep-client\sessions on Windows, $XDG_CACHE_HOME or ~/.cache
//     /oep-client/sessions elsewhere). While a host keeps the file it holds `<unit_id>.session.lock` (its process id,
//     taken over when that process is gone; dropped when the link closes).
//   - `localStorageKeptStore()` (a browser): localStorage `oep-client.session.<unit_id>`, held with a Web Lock of the
//     same name while the page keeps it (dropped when the link closes or the page goes).
//   - `memoryKeptStore()` (tests, or a host that should keep nothing past itself).
// A place another running host holds is left alone: that host's session is its own - this host keeps nothing then (it
// opens as usual and meets that host's lock). A unit_id that begins `x-` names no unit (core §7.5): nothing is kept.
// A store that cannot be read or written is not an error: nothing is kept (`whyNot` says why).

import * as reg from './registry.js';
import * as m from './message.js';
import { text } from './bytes.js';

export const ENV = 'OEP_SESSION_DIR';
export const DIR_NAME = 'oep-client';
/** The localStorage key's prefix and the Web Lock's (a browser). */
export const STORAGE_PREFIX = 'oep-client.session.';
const UNIT_ID_TAG = reg.CORE.tlv.describe.unit_id;
/** core §7.5's unit_id grammar: safe as a file name and a key. */
const SAFE = /^[a-z0-9-]{1,32}$/;

/**
 * One probe's kept id, claimed: `read` gives what the last run left ('' when nothing), `write` keeps text, `release`
 * lets the place go (the text stays for the next run). `where` names it, for messages.
 * @typedef {{ where: string, read: () => Promise<string>, write: (t: string) => Promise<void>, release: () => Promise<void> }} KeptClaim
 */
/**
 * Where kept ids live: `claim(unitId)` -> the claim, or why this host may not keep it (another running host holds it).
 * @typedef {{ name: string, claim: (unitId: string) => Promise<KeptClaim | string> }} KeptStore
 */

const isNode = () => typeof process !== 'undefined' && !!(/** @type {any} */ (process).versions?.node);

/** `node:fs` and friends, imported by name so a browser bundle never sees them. @param {string} name */
async function nodeModule(name) {
  const spec = `node:${name}`;
  return import(spec);
}

/** Node: $OEP_SESSION_DIR, else $XDG_RUNTIME_DIR/oep-client, else the user's cache directory (as oep-client-python's
 * kept_session.default_dir). */
export async function defaultKeptDir() {
  const [os, path] = await Promise.all([nodeModule('os'), nodeModule('path')]);
  const env = process.env;
  if (env[ENV]) return env[ENV];
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, DIR_NAME);
  if (process.platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, DIR_NAME, 'sessions');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), DIR_NAME, 'sessions');
}

/** The places this process holds now (two hosts of one process on one probe: the second is left out). */
const heldHere = new Set();

/** Whether process `pid` is alive. @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

/**
 * Node: `<dir>/<unit_id>.session` (dir: `defaultKeptDir()` when not given, read at each claim).
 * @param {string} [dir] @returns {KeptStore}
 */
export function fileKeptStore(dir) {
  return {
    name: dir ?? `$${ENV}`,
    async claim(unitId) {
      const [fs, path] = await Promise.all([nodeModule('fs/promises'), nodeModule('path')]);
      const where = dir ?? await defaultKeptDir();
      await fs.mkdir(where, { recursive: true, mode: 0o700 });
      const file = path.join(where, `${unitId}.session`);
      const lock = `${file}.lock`;
      if (heldHere.has(lock)) return `${file} is kept by another running host`;
      const take = async () => {
        await fs.writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      };
      try {
        await take();
      } catch (e) {
        if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
        const pid = Number.parseInt(String(await fs.readFile(lock, 'utf8').catch(() => '')).trim(), 10);
        if (pid && pid !== process.pid && alive(pid)) return `${file} is kept by another running host (process ${pid})`;
        await fs.rm(lock, { force: true });                  // left by a process that is gone: taken over
        try { await take(); } catch (e2) {
          if (/** @type {any} */ (e2).code === 'EEXIST') return `${file} is kept by another running host`;
          throw e2;
        }
      }
      heldHere.add(lock);
      return {
        where: file,
        read: async () => String(await fs.readFile(file, 'utf8').catch(() => '')),
        write: async (t) => { await fs.writeFile(file, t, { mode: 0o600 }); },
        release: async () => {
          heldHere.delete(lock);
          await fs.rm(lock, { force: true });
        },
      };
    },
  };
}

/**
 * A browser's localStorage under `oep-client.session.<unit_id>`, held with a Web Lock of that name while kept (a page
 * without Web Locks: by this page alone).
 * @param {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void }} [storage]
 * @param {any} [locks] navigator.locks
 * @returns {KeptStore}
 */
export function localStorageKeptStore(storage = /** @type {any} */ (globalThis).localStorage,
  locks = /** @type {any} */ (globalThis).navigator?.locks) {
  if (!storage) throw new Error('no localStorage here');
  return {
    name: 'localStorage',
    async claim(unitId) {
      const key = `${STORAGE_PREFIX}${unitId}`;
      if (heldHere.has(key)) return `${key} is kept by another host in this page`;
      /** @type {(() => void) | null} */ let letGo = null;
      if (locks && typeof locks.request === 'function') {
        letGo = await new Promise((resolve, reject) => {
          locks.request(key, { ifAvailable: true }, (/** @type {unknown} */ lock) => {
            if (!lock) { resolve(null); return undefined; }
            return new Promise((done) => resolve(() => done(undefined)));   // held until released
          }).catch(reject);
        });
        if (!letGo) return `${key} is kept by another running page`;
      }
      heldHere.add(key);
      return {
        where: `localStorage[${key}]`,
        read: async () => { try { return storage.getItem(key) ?? ''; } catch { return ''; } },
        write: async (t) => { try { storage.setItem(key, t); } catch { /* storage full or blocked: nothing kept */ } },
        release: async () => {
          heldHere.delete(key);
          letGo?.();
        },
      };
    },
  };
}

/** A store that forgets when the process ends (each claim stands alone; a held id is refused like a file's).
 * @returns {KeptStore} */
export function memoryKeptStore() {
  /** @type {Map<string, string>} */ const kept = new Map();
  /** @type {Set<string>} */ const held = new Set();
  return {
    name: '<memory>',
    async claim(unitId) {
      if (held.has(unitId)) return `${unitId} is kept by another running host`;
      held.add(unitId);
      return {
        where: `<memory>[${unitId}]`,
        read: async () => kept.get(unitId) ?? '',
        write: async (t) => { kept.set(unitId, t); },
        release: async () => { held.delete(unitId); },
      };
    },
  };
}

/** This environment's store: Node -> fileKeptStore() (the default directory), a browser with localStorage ->
 * localStorageKeptStore(), else null (nothing kept). @returns {Promise<KeptStore | null>} */
export async function defaultKeptStore() {
  if (isNode()) return fileKeptStore();
  try {
    if (/** @type {any} */ (globalThis).localStorage) return localStorageKeptStore();
  } catch { /* blocked storage */ }
  return null;
}

/**
 * One host's kept session id (`Host.kept`). Host.open calls `beforeOpen` (once: claim the place by unit_id, end the
 * session it names) and `opened`; Host.end calls `ended`; the link's close calls `release`. `previous`: the id found
 * from the run before (null: none); `endedPrevious`: whether it was opened and ended; `whyNot`: why nothing is kept.
 */
export class KeptSession {
  /** @param {KeptStore | null} [store] null: this environment's (`defaultKeptStore`) */
  constructor(store = null) {
    this.store = store;
    /** @type {KeptClaim | null} */ this.claim = null;
    this.done = false;
    /** @type {number | null} */ this.previous = null;
    this.endedPrevious = false;
    this.whyNot = '';
  }

  /** The probe's unit_id from fn 0's describe (null: none). @param {import('./host.js').Host} hst */
  static async unitId(hst) {
    const core = await import('./core.js');
    const v = (await core.describe(hst, m.CORE_FN)).find(([tag]) => (tag & 0x7f) === UNIT_ID_TAG)?.[1];
    return v && v.length ? text(v) : null;
  }

  /** Before this host's first open: claim the probe's place and end the session a previous run left there.
   * @param {import('./host.js').Host} hst @param {string} [owner] */
  async beforeOpen(hst, owner) {
    if (this.done) return;
    this.done = true;
    const unit = await KeptSession.unitId(hst);
    if (!unit || unit.startsWith('x-') || !SAFE.test(unit)) {
      this.whyNot = `unit_id ${JSON.stringify(unit)} names no unit`;
      return;
    }
    try {
      const store = this.store ?? await defaultKeptStore();
      if (!store) { this.whyNot = 'no place to keep it here'; return; }
      const claim = await store.claim(unit);
      if (typeof claim === 'string') { this.whyNot = claim; return; }
      this.claim = claim;
    } catch (e) {
      this.whyNot = `cannot keep it: ${e instanceof Error ? e.message : e}`;
      return;
    }
    const t = (await this.claim.read()).trim();
    const id = /^[0-9a-f]{1,8}$/i.test(t) ? Number.parseInt(t, 16) : 0;
    this.previous = id || null;
    if (this.previous !== null && this.previous !== hst.session) this.endedPrevious = await hst.endPrevious(this.previous, owner);
  }

  /** @param {string} t */
  async write(t) {
    if (!this.claim) return;
    try { await this.claim.write(t); } catch { /* a cache: nothing kept */ }
  }

  /** The session `sid` is open: kept for the next run. @param {number} sid */
  opened(sid) { return this.write(`${(sid >>> 0).toString(16).padStart(8, '0')}\n`); }

  /** The session ended: nothing to take back next time. */
  ended() { return this.write(''); }

  /** Let the place go (the id stays in it for the next run when a session is still open); the next open claims again. */
  async release() {
    const claim = this.claim;
    this.claim = null;
    this.done = false;
    if (claim) { try { await claim.release(); } catch { /* already gone */ } }
  }
}
