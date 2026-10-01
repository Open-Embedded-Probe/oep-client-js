// @ts-check
// A Host whose requests go to handlers - (fn, op) -> [resolution, detail, payload] - for the host-side parts the fake
// probe does not model (as oep-client-python's tests/test_target_parts.py ScriptedHost). Every request is logged.
import { Host } from '../src/host.js';
import * as m from '../src/message.js';
import { rejection } from '../src/errors.js';

/** @typedef {(payload: Uint8Array) => [number, number, Uint8Array]} Handler */

export const FNS = { 'oep.wire.rvswd': 1, 'oep.target.riscv-dm': 2, 'oep.fixture.gpio': 3, 'oep.wire.swd': 4, 'oep.target.arm-adi': 5 };

/** @param {Uint8Array | number[]} body @returns {[number, number, Uint8Array]} */
export const ok = (body = []) => [m.COMPLETED, m.SUCCESS, Uint8Array.from(body)];

export class ScriptedHost extends Host {
  /** @param {Map<string, Handler>} handlers keyed `${fn}:${op}` @param {number} maxFrame */
  constructor(handlers, maxFrame = 1024) {
    super(/** @type {any} */ (null));
    this.handlers = handlers;
    /** @type {[number, number, Uint8Array][]} */ this.log = [];
    for (const [name, fn] of Object.entries(FNS)) { this.fns.set(name, fn); this.revisions.set(fn, 1); }
    this.revision = 1;
    this.limits = { revision: 1, flags: 0, maxFrame, window: 4096, maxInflight: 8, bootId: 1, tail: new m.Tail() };
    for (const fn of Object.values(FNS)) this.describes.set(fn, []);   // declares nothing: attach's default max_speed
  }

  /** @param {number} fn @param {number} op @param {Uint8Array} payload */
  answer(fn, op, payload) {
    this.log.push([fn, op, payload]);
    const h = this.handlers.get(`${fn}:${op}`);
    if (!h) throw new Error(`no handler for fn ${fn} op ${op}`);
    const [res, detail, body] = h(payload);
    return new m.Result(this.log.length, res, detail, body);
  }

  /** @param {number} fn @param {number} op @param {Uint8Array} payload */
  async request(fn, op, payload = new Uint8Array()) {
    const r = this.answer(fn, op, payload);
    if (r.resolution === m.REJECTED) throw rejection(r);
    return r;
  }

  /** @param {[number, number, Uint8Array][]} requests */
  async pipeline(requests) { return requests.map(([fn, op, p]) => this.answer(fn, op, p)); }
}

/** @param {[number, number, Handler][]} entries */
export function handlers(entries) { return new Map(entries.map(([fn, op, h]) => [`${fn}:${op}`, h])); }
