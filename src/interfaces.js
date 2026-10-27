// @ts-check
// What the host knows about interfaces, for display: role names, feature bits, specific tags (the ops every describe
// carries are named from the registry's op tables: `opNames`).
//
// These entries exist so that a dump can show what a declaration looks like. An interface missing from here is still
// listed and described - with raw role numbers, raw feature bits and raw tag bytes. The core (fn 0) has no name and is
// never listed: it is CORE_KNOWN. Every tag, role and feature bit is looked up in the registry by name.

import { getU16, getU32, hex } from './bytes.js';
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
const CAPTURE_MODES = { 1: 'one-shot', 2: 'repeat', 3: 'streaming' };

/** capture describe's mode: mode(u8) max_samples(u32) max_segments(u32) (oep-if-capture §3.5).
 * @param {Uint8Array} v */
function captureMode(v) {
  const mode = v[0], most = getU32(v, 1), segments = getU32(v, 5);
  return `${CAPTURE_MODES[mode] ?? `mode ${mode}`}, max ${most} samples${mode === 2 ? ` x ${segments} segments` : ' a segment'}`;
}

/** capture describe's rate_range: min_hz(u32) max_hz(u32). @param {Uint8Array} v */
function rateRange(v) {
  return `${getU32(v)}-${getU32(v, 4)} Hz`;
}

/** @type {Record<number, string>} */
const TRIGGERS = { 0: 'immediate', 1: 'level', 2: 'edge', 3: 'cross up', 4: 'cross down' };

/** capture describe's trigger: types(u32 bit set) max_pretrigger(u32). @param {Uint8Array} v */
function trigger(v) {
  const types = getU32(v);
  const names = Object.entries(TRIGGERS).filter(([b]) => (types >>> Number(b)) & 1).map(([, n]) => n);
  return `${names.join(', ')}; pretrigger up to ${getU32(v, 4)}`;
}

/** analog describe's frontend: frontend(u8) range_min_mv(i32) range_max_mv(i32), at the input pin. @param {Uint8Array} v */
function frontend(v) {
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  return `${v[0]}: ${dv.getInt32(1, true)}..${dv.getInt32(5, true)} mV`;
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
 * @property {Record<number, [string, Decoder]>} tags   interface tag -> label, decoder
 */

/** @param {string} summary @param {Partial<Omit<Known, 'summary'>>} [rest] @returns {Known} */
const known = (summary, { roles = {}, features = {}, tags = {} } = {}) => ({ summary, roles, features, tags });

/** The core (fn 0): no name (core §0). */
export const CORE_KEY = '';

/** describe tags by their registry names -> [label, decoder]. @param {string} name
 * @param {...[string, string, Decoder]} pairs @returns {Record<number, [string, Decoder]>} */
function tagsOf(name, ...pairs) {
  const table = /** @type {Record<string, number>} */ ((name === CORE_KEY ? reg.CORE : /** @type {any} */ (reg.INTERFACES)[name]).tlv.describe);
  return Object.fromEntries(pairs.map(([key, lbl, render]) => [table[key], [lbl, render]]));
}

/** @param {string} name @param {string} e @param {Record<string, string>} labels @returns {Record<number, string>} */
function rolesOf(name, e, labels) {
  const table = /** @type {any} */ (reg.INTERFACES)[name].enum[e];
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [table[k], v]));
}

/** features bits (masks in the registry) -> their positions. @param {string} name @param {Record<string, string>} labels
 * @returns {Record<number, string>} */
function bitsOf(name, labels) {
  const table = /** @type {any} */ (reg.INTERFACES)[name].enum.features;
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [Math.log2(table[k]), v]));
}

const WIRE_ROLES = { swdio: 'SWDIO', swclk: 'SWCLK', reset: 'reset' };
/** @type {[string, string, Decoder]} */
const MAXCONN = ['max_connections', 'max connections', first];
/** @type {[string, string, Decoder][]} */
const CAPTURE = [['mode', 'mode', captureMode], ['rate_range', 'rate range', rateRange], ['channels', 'channels', first],
  ['trigger', 'trigger', trigger]];

/** fn 0, the core (no name, never in list; core §0, §12): its describe is the probe itself (core §7.5). */
export const CORE_KNOWN = known(
  'the core: confirm, list, describe, clock, open / end / keepalive, lock state, the settings (core §13); describe = the probe itself',
  { tags: tagsOf(CORE_KEY, ['firmware', 'firmware', asText], ['model', 'model', asText], ['unit_id', 'unit id', asText],
    ['channels', 'channels', u16], ['channel_name', 'channel name', label], ['netif', 'netif', asText],
    ['transport', 'transport', transport],
    ['chip', 'chip', asText], ['max_op_ms', 'max op ms', u32]) });

/** The interfaces whose names begin with oep. (interfaces/README.ja.md).
 * @type {Record<string, Known>} */
export const KNOWN = {
  'oep.probe.link': known('the link test (source, sink) and, when its ops offer it, port_speed on a UART bridge'),
  'oep.probe.plan': known('the plan: which channel each role of an interface uses (plan_apply, plan_release)',
    { tags: tagsOf('oep.probe.plan', ['plan_roles', 'plan roles', u32]) }),
  'oep.probe.restart': known('the probe restarts itself, answering first',
    { tags: tagsOf('oep.probe.restart', ['restart_max_ms', 'restart max ms', u32]) }),
  'oep.wire.rvswd': known('scan, attach, detach over RVSWD (attach returns a connection)',
    { roles: rolesOf('oep.wire.rvswd', 'pin_role', WIRE_ROLES), tags: tagsOf('oep.wire.rvswd', MAXCONN) }),
  'oep.wire.swio': known('scan, attach, detach over SWIO, one wire (attach returns a connection)',
    { roles: rolesOf('oep.wire.swio', 'pin_role', { swdio: 'SWIO', reset: 'reset' }), tags: tagsOf('oep.wire.swio', MAXCONN) }),
  'oep.wire.swd': known('scan, attach, detach over ARM SWD',
    { roles: rolesOf('oep.wire.swd', 'pin_role', WIRE_ROLES), tags: tagsOf('oep.wire.swd', MAXCONN) }),
  'oep.target.riscv-dm': known(
    'RISC-V Debug Module over DMI: step lists, block read/write, run until halt, halt/resume (optional ops: ops)'),
  'oep.target.arm-adi': known('ARM Debug Interface: DP/AP transfer lists, block transfers'),
  'oep.target.console': known('console streams on a debug connection (position-addressed, marks)',
    { tags: tagsOf('oep.target.console', ['mechanism', 'mechanism', asText]) }),
  'oep.fixture.gpio': known('drive and read probe pins', { roles: rolesOf('oep.fixture.gpio', 'role', { line: 'line' }),
    tags: tagsOf('oep.fixture.gpio', ['modes', 'modes', bits32]) }),
  'oep.fixture.uart': known('a UART (USART, asynchronous) on probe pins', { roles: rolesOf('oep.fixture.uart', 'role', { rx: 'RX', tx: 'TX' }),
    tags: tagsOf('oep.fixture.uart', ['formats', 'formats', (v) => Array.from(v.slice(1, 1 + v[0]), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')]) }),
  'oep.fixture.logic': known('sampled logic capture', { roles: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, `line${k}`])),
    tags: tagsOf('oep.fixture.logic', ...CAPTURE) }),
  'oep.fixture.analog': known('sampled analog capture', { roles: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, `ch${k}`])),
    tags: tagsOf('oep.fixture.analog', ...CAPTURE, ['frontend', 'frontend', frontend]) }),
  'oep.fixture.capture-group': known('captures started at once and stopped together',
    { tags: tagsOf('oep.fixture.capture-group', ['tracks', 'tracks', tracks]) }),
  'oep.fixture.i2c-target': known('an I2C target the DUT can address (open-drain only, fixture §3)',
    { roles: rolesOf('oep.fixture.i2c-target', 'role', { sda: 'SDA', scl: 'SCL' }),
      features: bitsOf('oep.fixture.i2c-target', { internal_pullups: 'internal pull-ups' }),
      tags: tagsOf('oep.fixture.i2c-target', ['queue_depth', 'queue depth', first], ['max_stretch_us', 'max stretch us', u32]) }),
  'oep.fixture.spi-target': known('an SPI target the DUT can clock (ESP-IDF slave driver)',
    { roles: rolesOf('oep.fixture.spi-target', 'role', { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' }),
      features: bitsOf('oep.fixture.spi-target', { lsb_first: 'LSB first' }),
      tags: tagsOf('oep.fixture.spi-target', ['queue_depth', 'queue depth', first],
        ['modes', 'modes', (v) => [0, 1, 2, 3].filter((k) => (v[0] >> k) & 1).join(', ')],
        ['cs_setup_ns', 'CS setup ns', (v) => `${u32(v)} (SCK sooner after CS: the first bit is not sure)`]) }),
  'oep.fixture.i2c-controller': known('the probe as the I2C controller, for a DUT\'s target (open-drain only, fixture §5)',
    { roles: rolesOf('oep.fixture.i2c-controller', 'role', { sda: 'SDA', scl: 'SCL' }),
      features: bitsOf('oep.fixture.i2c-controller', { internal_pullups: 'internal pull-ups' }),
      tags: tagsOf('oep.fixture.i2c-controller', ['max_stretch_timeout_us', 'max stretch timeout us', u32]) }),
  'oep.fixture.spi-controller': known('the probe as the SPI controller, for a DUT\'s target (CS times as asked, fixture §6)',
    { roles: rolesOf('oep.fixture.spi-controller', 'role', { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' }),
      features: bitsOf('oep.fixture.spi-controller', { lsb_first: 'LSB first' }),
      tags: tagsOf('oep.fixture.spi-controller', ['time_step_ns', 'time step ns', u32],
        ['modes', 'modes', (v) => [0, 1, 2, 3].filter((k) => (v[0] >> k) & 1).join(', ')],
        ['max_delay_ns', 'max delay ns', u32]) }),
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
