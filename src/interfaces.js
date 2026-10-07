// @ts-check
// What the host knows about interfaces, for display: role names, feature bits, specific tags.
//
// EXAMPLES ONLY. Which capabilities become the BASIC standard under `oep.` is not decided (oep-spec
// docs/capability-declaration-model.ja.md); these entries exist so that a dump can show what a declaration looks
// like. An interface missing from here is still listed and described - with raw role numbers, raw feature bits and raw
// tag bytes.

import { getU16, getU32 } from './bytes.js';
import { shown } from './message.js';
import * as reg from './registry.js';

/** @typedef {(v: Uint8Array) => string} Decoder */

/** @param {Uint8Array} v */ const u16 = (v) => String(getU16(v));
/** @param {Uint8Array} v */ const u32 = (v) => String(getU32(v));
/** @param {Uint8Array} v */ const bits32 = (v) => { const b = getU32(v); return Array.from({ length: 32 }, (_, i) => i).filter((i) => (b >>> i) & 1).join(', '); };
/** control characters and bad UTF-8 replaced (core §2.1) @param {Uint8Array} v */ const asText = (v) => shown(v);
/** @param {Uint8Array} v */ const label = (v) => `${getU16(v)} = ${shown(v.slice(2))}`;
/** @param {Uint8Array} v */ const first = (v) => String(v[0]);

/** @type {Record<number, string>} */
const TRANSPORTS = { 1: 'UART bridge', 2: 'USB CDC', 3: 'USB-Serial/JTAG', 4: 'vendor bulk', 5: 'HID', 6: 'TCP' };
/** @type {Record<number, string>} */
const MECHANISMS = { 0: 'SDI', 1: 'DMDATA', 2: 'dmseq', 0xff: 'none' };

/** @type {Record<number, string>} */
const CAPTURE_MODES = { 1: 'one-shot', 2: 'repeat', 3: 'streaming' };

/** capture describe's mode: mode(u8) max_samples(u32) max_segments(u32) (oep-if-capture §3.5).
 * @param {Uint8Array} v */
function captureMode(v) {
  const mode = v[0], most = getU32(v, 1), segments = getU32(v, 5);
  return `${CAPTURE_MODES[mode] ?? `mode ${mode}`}, max ${most} samples x ${segments} segments`;
}

/** capture describe's rate_range: min_hz(u32) max_hz(u32) exact(u8). @param {Uint8Array} v */
function rateRange(v) {
  return `${getU32(v)}-${getU32(v, 4)} Hz${v[8] ? ' (any value)' : ''}`;
}

/** @type {Record<number, string>} */
const TRIGGERS = { 0: 'immediate', 1: 'level', 2: 'edge', 3: 'cross up', 4: 'cross down' };

/** capture describe's trigger: types(u32 bit set) max_pretrigger(u32). @param {Uint8Array} v */
function trigger(v) {
  const types = getU32(v);
  const names = Object.entries(TRIGGERS).filter(([b]) => (types >>> Number(b)) & 1).map(([, n]) => n);
  return `${names.join(', ')}; pretrigger up to ${getU32(v, 4)}`;
}

/** analog describe's frontend: frontend(u8) range_min_mv(i32) range_max_mv(i32) attenuation_mdb(u32). @param {Uint8Array} v */
function frontend(v) {
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const lo = dv.getInt32(1, true), hi = dv.getInt32(5, true), mdb = getU32(v, 9);
  return `${v[0]}: ${lo}..${hi} mV${mdb !== 0 && mdb !== 0xffffffff ? `, ${mdb / 1000} dB` : ''}`;
}

/** gpio describe's drive_levels: default(u8) n(u8) n x ma(u16). @param {Uint8Array} v */
function driveLevels(v) {
  const levels = Array.from({ length: v[1] }, (_, i) => `${i}: ~${getU16(v, 2 + 2 * i)} mA`);
  return `${levels.join(', ')} (default ${v[0]})`;
}

/** capture-group describe's tracks: n(u8) n x fn(u16). @param {Uint8Array} v */
function tracks(v) {
  return Array.from({ length: v[0] }, (_, i) => String(getU16(v, 1 + 2 * i))).join(', ');
}

/** @param {Uint8Array} v */
function transport(v) {
  const itf = v.length < 3 || v[2] === 0xff ? '' : ` (interface ${v[2]})`;
  return `${v[0]} = ${TRANSPORTS[v[1]] ?? `kind ${v[1]}`}${itf}`;
}

/**
 * @typedef {object} Known
 * @property {string} summary
 * @property {Record<number, string>} roles
 * @property {Record<number, string>} features
 * @property {Record<number, [string, Decoder]>} tags   interface tag (critical bit dropped) -> label, decoder
 */

/** @param {string} summary @param {Partial<Omit<Known, 'summary'>>} [rest] @returns {Known} */
const known = (summary, { roles = {}, features = {}, tags = {} } = {}) => ({ summary, roles, features, tags });

/** @type {Record<number, string>} */
const LOGIC_LINES = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, `line${k}`]));

/** fn 0, the core (no name, never in list; core §0, §12): its describe is the probe itself (core §7.5). */
export const CORE_KNOWN = known(
  'confirm, list, describe, clock, open / end / keepalive, lock state; describe = the probe itself',
  { tags: { 0x40: ['firmware', asText], 0x41: ['model', asText], 0x42: ['unit id', asText],
    0x43: ['channels', u16], 0x46: ['label', label], 0x49: ['transport', transport],
    0x4c: ['chip', asText], 0x4d: ['max op ms', u32] } });

/** The interfaces whose names begin with oep. (interfaces/README.ja.md).
 * @type {Record<string, Known>} */
export const KNOWN = {
  'oep.probe.plan': known('which channel each plan role of an interface uses (plan_apply, plan_release)',
    { tags: { 0x40: ['plan roles', u32] } }),
  'oep.probe.restart': known('the probe restarts itself (restart)', { tags: { 0x40: ['restart max ms', u32] } }),
  'oep.probe.link': known('the link test (source, sink) and, when its ops offer it, port_speed on a UART bridge'),
  'oep.wire.rvswd': known('scan, attach, detach over RVSWD (attach returns a connection)',
    { roles: { 1: 'SWDIO', 2: 'SWCLK', 3: 'reset' }, tags: { 0x40: ['max connections', first] } }),
  'oep.wire.swio': known('scan, attach, detach over SWIO, one wire (attach returns a connection)',
    { roles: { 1: 'SWIO', 3: 'reset' }, tags: { 0x40: ['max connections', first] } }),
  'oep.wire.swd': known('scan, attach, detach over ARM SWD',
    { roles: { 1: 'SWDIO', 2: 'SWCLK', 3: 'reset' }, tags: { 0x40: ['max connections', first] } }),
  'oep.target.riscv-dm': known(
    'RISC-V Debug Module over DMI: step lists, block read/write, run until halt, halt/resume (optional ops: ops)'),
  'oep.target.arm-adi': known('ARM Debug Interface: DP/AP transfer lists, block transfers'),
  'oep.target.console': known('console streams on a debug connection (position-addressed, marks)',
    { tags: { 0x40: ['mechanisms', (v) => Array.from(v, (b) => MECHANISMS[b] ?? String(b)).join(', ')] } }),
  'oep.probe.config': known('the probe\'s configuration (plan, labels, idle pins, slots, binds, uart) and its storage; the state is op state',
    { tags: { 0x40: ['storage', (v) => `${u32(v.slice(0, 4))} bytes`],
      0x41: ['items', (v) => Array.from(v, String).join(', ')], 0x42: ['slots', first] } }),
  'oep.fixture.gpio': known('drive and read probe pins', { roles: { 1: 'line' },
    tags: { 0x40: ['modes', bits32], 0x41: ['drive levels', driveLevels] } }),
  'oep.fixture.uart': known('a UART (USART, asynchronous) on probe pins', { roles: { 1: 'RX', 2: 'TX' },
    tags: { 0x40: ['formats', (v) => Array.from(v.slice(1, 1 + v[0]), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')] } }),
  'oep.fixture.logic': known('sampled logic capture', { roles: LOGIC_LINES,
    tags: { 0x40: ['mode', captureMode], 0x41: ['rate range', rateRange], 0x44: ['channels', first], 0x45: ['trigger', trigger] } }),
  'oep.fixture.analog': known('sampled analog capture',
    { roles: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, `ch${k}`])),
      tags: { 0x40: ['mode', captureMode], 0x41: ['rate range', rateRange], 0x44: ['channels', first], 0x45: ['trigger', trigger],
        0x46: ['frontend', frontend] } }),
  'oep.fixture.capture-group': known('captures started and stopped together', { tags: { 0x40: ['tracks', tracks] } }),
  'oep.fixture.i2c-target': known('an I2C target the DUT can address (open-drain only, fixture §3)',
    { roles: { 1: 'SDA', 2: 'SCL' }, features: { 2: 'internal pull-ups' },
      tags: { 0x40: ['queue depth', first], 0x41: ['max stretch us', u32] } }),
  'oep.fixture.spi-target': known('an SPI target the DUT can clock (ESP-IDF slave driver)',
    { roles: { 1: 'SCK', 2: 'MOSI', 3: 'MISO', 4: 'CS' }, features: { 0: 'LSB first' },
      tags: { 0x40: ['queue depth', first], 0x43: ['CS setup ns', (v) => `${u32(v)} (SCK sooner after CS: the first bit is not sure)`] } }),
};

/** The ops of an ops tag by the registry's names for interface `name` ('': fn 0, the core) - an op it does not name:
 * 0x.. hex. @param {string} name @param {Iterable<number>} ops */
export function opNames(name, ops) {
  const table = /** @type {Record<string, number>} */ (name === '' ? reg.CORE.op : /** @type {any} */ (reg.INTERFACES)[name]?.op ?? {});
  const known = Object.fromEntries(Object.entries(table).map(([k, v]) => [v, k]));
  return [...ops].sort((a, b) => a - b).map((op) => known[op] ?? `0x${op.toString(16).padStart(2, '0')}`);
}

/** [0,1,2,5,7,8] -> '0-2,5,7-8' ('-' for none).
 * @param {number[]} chans */
export function ranges(chans) {
  /** @type {string[]} */
  const out = [];
  let start = -1, prev = -1;
  for (const c of chans) {
    if (start < 0) start = prev = c;
    else if (c === prev + 1) prev = c;
    else { out.push(start === prev ? `${start}` : `${start}-${prev}`); start = prev = c; }
  }
  if (start >= 0) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(',') || '-';
}
