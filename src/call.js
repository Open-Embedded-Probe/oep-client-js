// @ts-check
// Call any interface's op by its number, or by the name and fields its describe gives (oep-core §7.4 op_name /
// op_field) - an interface this host has no module for, such as a sketch's oep::SimpleInterface. As
// oep-client-python's call.py.
//
//   await take(hst, 10000, { owner: 'my-test' });
//   const r = await call(hst, 'io.github.yourname.mine', 'add', { fields: { a: 2, b: 3 } });
//   r.fields.sum, r.revision                       // the success fields by name; the interface's revision
//   (await call(hst, 'io.github.yourname.mine', 0x10, { payload: bytes })).payload   // by number, the bytes as they are
//
// Fields: u8-u32 / i8-i32 as numbers, u64 / i64 as BigInt (a number is taken too), bool, bytes (Uint8Array), text
// (string), lists of the number types and bool (arrays).
//
// Errors: InterfaceMissing / RevisionMismatch / OpMissing (all NotOffered), CommandRejected (the probe refused it: the
// reason), CommandFailed (completed failed: code and message when the op gives them). A job (oep::SimpleInterface::job)
// and its status op: callWait - JobFailed, JobCancelled, JobTimeout (cancel sent first), ProbeRestarted (boot_id changed).

import * as catalog from './catalog.js';
import * as core from './core.js';
import { OepError, Rejected, Failed } from './errors.js';
import { ProtocolError } from './errors.js';

const T = catalog.OP_FIELD_TYPES, LIST = catalog.OP_FIELD_LIST;
/** type -> [bytes, signed, 64-bit] */
const INT = new Map([[T.u8, [1, false]], [T.u16, [2, false]], [T.u32, [4, false]], [T.u64, [8, false]],
  [T.i8, [1, true]], [T.i16, [2, true]], [T.i32, [4, true]], [T.i64, [8, true]], [T.bool, [1, false]]]);

/** The probe does not offer what was asked: no such interface, another revision, no such op. */
export class NotOffered extends OepError {}
export class InterfaceMissing extends NotOffered {}
export class RevisionMismatch extends NotOffered {
  /** @param {string} iface @param {number} revision @param {number} wanted */
  constructor(iface, revision, wanted) {
    super(`${iface} is revision ${revision} on this probe, ${wanted} asked`);
    this.revision = revision; this.wanted = wanted;
  }
}
export class OpMissing extends NotOffered {}

/** The probe refused the op (resolution rejected): `reason` (core §4.3). */
export class CommandRejected extends Rejected {
  /** @param {string} op @param {import('./message.js').Result} result */
  constructor(op, result) { super(result); this.op = op; this.message = `${op}: ${result.describe()}`; }
}

/** The op ran and did not work (completed failed / partial): `fields` the failed part decoded (code, message for an
 * oep::SimpleInterface op), `payload` the bytes. */
export class CommandFailed extends Failed {
  /** @param {string} op @param {import('./message.js').Result} result @param {Record<string, any> | null} fields */
  constructor(op, result, fields) {
    let why = `${op}: ${result.describe()}`;
    if (fields && 'code' in fields) why += ` (code ${fields.code}${fields.message ? `: ${fields.message}` : ''})`;
    super(result, why);
    this.op = op; this.fields = fields ?? {}; this.payload = result.payload;
    this.code = this.fields.code ?? null; this.detailMessage = this.fields.message ?? null;
  }
}

/** The job ended failed: `code` and `detailMessage` from its Worker::fail(), `status` the status op's fields. */
export class JobFailed extends OepError {
  /** @param {string} op @param {Record<string, any>} status */
  constructor(op, status) {
    super(`${op}: failed (code ${status.code}${status.message ? `: ${status.message}` : ''})`);
    this.op = op; this.status = status; this.code = status.code; this.detailMessage = status.message;
  }
}
export class JobCancelled extends OepError {
  /** @param {string} op @param {Record<string, any>} status */
  constructor(op, status) { super(`${op}: cancelled`); this.op = op; this.status = status; }
}
export class JobTimeout extends OepError {
  /** @param {string} op @param {number} timeoutMs @param {Record<string, any>} status */
  constructor(op, timeoutMs, status) { super(`${op}: still running after ${timeoutMs} ms (cancel sent)`); this.op = op; this.status = status; }
}
/** The probe's boot_id changed while the job ran (core §6.5): it restarted, the job with it. */
export class ProbeRestarted extends OepError {}

/** The status op's state (oep::Worker::State): the firmware's convention, not the registry's. */
export const JOB_STATES = Object.freeze({ idle: 0, running: 1, done: 2, failed: 3, cancelled: 4 });

/** @param {number} type @param {any} v @returns {number[]} */
function packInt(type, v) {
  const [n, signed] = /** @type {[number, boolean]} */ (INT.get(type));
  let x = BigInt(typeof v === 'boolean' ? Number(v) : v);
  if (signed && x < 0n) x += 1n << BigInt(8 * n);
  if (x < 0n || x >= 1n << BigInt(8 * n)) throw new RangeError(`${v} does not fit ${n * 8} bits`);
  return Array.from({ length: n }, (_, i) => Number((x >> BigInt(8 * i)) & 0xffn));
}

/** @param {number} type @param {Uint8Array} p @param {number} at */
function unpackInt(type, p, at) {
  const [n, signed] = /** @type {[number, boolean]} */ (INT.get(type));
  if (at + n > p.length) throw new ProtocolError(`the answer ends inside a ${n * 8}-bit field`);
  let x = 0n;
  for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(p[at + i]);
  if (signed && x >= 1n << BigInt(8 * n - 1)) x -= 1n << BigInt(8 * n);
  const v = n === 8 ? x : Number(x);
  return type === T.bool ? v !== 0 : v;
}

/** @param {number} n */
const u16 = (n) => [n & 0xff, n >> 8];

/** A request's fixed part from values by field name. @param {catalog.OpField[]} fields @param {Record<string, any>} values */
export function encode(fields, values) {
  const missing = fields.filter((f) => !(f.name in values)).map((f) => f.name);
  const extra = Object.keys(values).filter((k) => !fields.some((f) => f.name === k)).sort();
  if (missing.length || extra.length) {
    throw new TypeError(`fields ${fields.map(String).join(', ') || 'none'}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; not fields ${extra.join(', ')}` : ''}`);
  }
  /** @type {number[]} */
  const out = [];
  for (const f of fields) {
    const v = values[f.name];
    if (f.type & LIST) {
      const items = [...v];
      out.push(...u16(items.length));
      for (const x of items) out.push(...packInt(f.type & ~LIST, x));
    } else if (f.type === T.bytes || f.type === T.text) {
      const b = f.type === T.text ? new TextEncoder().encode(String(v)) : Uint8Array.from(v);
      out.push(...u16(b.length), ...b);
    } else if (INT.has(f.type)) out.push(...packInt(f.type, v));
    else throw new TypeError(`${f.name}: type ${f.type} unknown to this host`);
  }
  return Uint8Array.from(out);
}

/** A fixed part's fields by name, and what follows them (the TLVs).
 * @param {catalog.OpField[]} fields @param {Uint8Array} payload @returns {[Record<string, any>, Uint8Array]} */
export function decode(fields, payload) {
  /** @type {Record<string, any>} */
  const out = {};
  let at = 0;
  const len = () => {
    if (at + 2 > payload.length) throw new ProtocolError('the answer ends inside a length');
    const n = payload[at] | (payload[at + 1] << 8);
    at += 2;
    return n;
  };
  for (const f of fields) {
    if (f.type & LIST) {
      const n = len(), base = f.type & ~LIST, w = /** @type {[number, boolean]} */ (INT.get(base))[0];
      out[f.name] = Array.from({ length: n }, (_, i) => unpackInt(base, payload, at + i * w));
      at += n * w;
    } else if (f.type === T.bytes || f.type === T.text) {
      const n = len();
      if (at + n > payload.length) throw new ProtocolError(`${f.name}: ${n} bytes, the answer ends before`);
      const raw = payload.slice(at, at + n);
      out[f.name] = f.type === T.text ? new TextDecoder().decode(raw) : raw;
      at += n;
    } else {
      out[f.name] = unpackInt(f.type, payload, at);
      at += /** @type {[number, boolean]} */ (INT.get(f.type))[0];
    }
  }
  return [out, payload.slice(at)];
}

/** The op_name / op_field an interface's describe gives (by op number; empty when it gives none).
 * @param {import('./host.js').Host} hst @param {string | number} iface */
export async function ops(hst, iface) {
  const fn = typeof iface === 'number' ? iface : await fnOf(hst, iface);
  return catalog.decodeDescription(await core.describe(hst, fn)).opForms;
}

/** @param {import('./host.js').Host} hst @param {string} iface */
async function fnOf(hst, iface) {
  try { return await core.find(hst, iface); } catch (e) {
    if (e instanceof OepError && !(e instanceof Rejected)) throw new InterfaceMissing(e.message);
    throw e;
  }
}

/** The success fields by name, the raw payload, the interface's revision and the op.
 * @typedef {{ fields: Record<string, any>, payload: Uint8Array, revision: number, op: catalog.OpForm | number }} CallResult */

/**
 * Run `op` (a number, or a name from the describe's op_name) of `iface` on the session `hst` holds. payload: the
 * request as bytes (then no fields); otherwise `fields` by name, packed as op_field says. locked: send it in the session
 * (default: unless op_name says lock_free). revision: the one expected.
 * @param {import('./host.js').Host} hst @param {string} iface @param {number | string} op
 * @param {{ payload?: Uint8Array, fields?: Record<string, any>, locked?: boolean, revision?: number, expectMs?: number }} [opts]
 * @returns {Promise<CallResult>}
 */
export async function call(hst, iface, op, { payload, fields = {}, locked, revision, expectMs = 0 } = {}) {
  const fn = await fnOf(hst, iface);
  const rev = await core.revision(hst, iface, fn);
  if (revision !== undefined && rev !== revision) throw new RevisionMismatch(iface, rev, revision);
  const forms = await ops(hst, fn);
  /** @type {catalog.OpForm | undefined} */
  let form;
  let code;
  if (typeof op === 'string') {
    form = [...forms.values()].find((f) => f.name === op);
    if (!form) {
      throw new OpMissing(`${iface} has no op named '${op}'${forms.size ? ` (it names ${[...forms.values()].map((f) => f.name).join(', ')})` : ' (its describe names none)'}`);
    }
    code = form.op;
  } else { code = op; form = forms.get(op); }
  const label = form ? form.name : `0x${code.toString(16).padStart(2, '0')}`;
  if (!(await core.offers(hst, fn, code))) throw new OpMissing(`${iface} does not offer op ${label}`);
  const named = Object.keys(fields).length > 0;
  if (payload === undefined) {
    if (named && !(form && form.form)) throw new TypeError(`${iface} ${label}: its describe gives no fields; pass payload as bytes`);
    payload = form && form.form && (named || form.request.length) ? encode(form.request, fields) : new Uint8Array();
  } else if (named) throw new TypeError('payload or fields, not both');
  const inSession = locked ?? !(form && form.lockFree);
  let r;
  try {
    r = await hst.request(fn, code, payload, { locked: inSession, expectMs });
  } catch (e) {
    if (e instanceof Rejected) throw new CommandRejected(label, e.result);
    throw e;
  }
  if (r.succeeded) return { fields: form && form.form ? decode(form.success, r.payload)[0] : {}, payload: r.payload, revision: rev, op: form ?? code };
  let failed = null;
  if (r.ran && form && form.form && form.failed.length) {
    try { failed = decode(form.failed, r.payload)[0]; } catch { failed = null; }   // a failed answer without its fields
  }
  throw new CommandFailed(label, r, failed);
}

/**
 * Start the job `op` (as call()) and wait for it by its `status` op: the status's fields when it ended done.
 * wait(ms) between the status reads (a timer by default).
 * @param {import('./host.js').Host} hst @param {string} iface @param {number | string} op
 * @param {{ timeoutMs: number, payload?: Uint8Array, fields?: Record<string, any>, intervalMs?: number, status?: string,
 *   cancel?: string, revision?: number, wait?: (ms: number) => Promise<void> }} opts
 */
export async function callWait(hst, iface, op, { timeoutMs, payload, fields, intervalMs = 50, status = 'status', cancel = 'cancel', revision, wait } = /** @type {any} */ ({})) {
  const boot = (await hst.clock()).bootId;
  const started = await call(hst, iface, op, { payload, fields, revision });
  const code = typeof started.op === 'number' ? started.op : started.op.op;
  const label = typeof started.op === 'number' ? `0x${code.toString(16).padStart(2, '0')}` : started.op.name;
  const pause = wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = performance.now() + timeoutMs;
  let st;
  for (;;) {
    try {
      st = (await call(hst, iface, status)).fields;
    } catch (e) {
      await restarted(hst, boot, label);
      throw e;
    }
    if (st.op !== code || st.state === JOB_STATES.idle) {
      await restarted(hst, boot, label);
      throw new ProbeRestarted(`${label}: the status names op ${st.op} in state ${st.state}, not this job`);
    }
    if (st.state !== JOB_STATES.running) break;
    if (performance.now() >= deadline) {
      try { await call(hst, iface, cancel); } catch { /* the timeout is the error to report */ }
      throw new JobTimeout(label, timeoutMs, st);
    }
    await pause(intervalMs);
  }
  if (st.state === JOB_STATES.failed) throw new JobFailed(label, st);
  if (st.state === JOB_STATES.cancelled) throw new JobCancelled(label, st);
  return st;
}

/** @param {import('./host.js').Host} hst @param {bigint | number} boot @param {string} label */
async function restarted(hst, boot, label) {
  let now;
  try { now = (await hst.clock()).bootId; } catch { return; }
  if (now !== boot) throw new ProbeRestarted(`${label}: the probe restarted while the job ran (boot_id ${boot} -> ${now})`);
}
