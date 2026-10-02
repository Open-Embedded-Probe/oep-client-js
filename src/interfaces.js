// @ts-check
// What the host knows about interfaces, for display: role names, feature bits, specific tags.
//
// EXAMPLES ONLY. Which capabilities become the BASIC standard under `oep.` is not decided (oep-spec
// docs/capability-declaration-model.ja.md); these entries exist so that a dump can show what a declaration looks
// like. An interface missing from here is still listed and described - with raw role numbers, raw feature bits and raw
// tag bytes.

import { getU16, getU32 } from './bytes.js';
import { bitmapToChannels } from './catalog.js';
import { shown } from './message.js';

/** @typedef {(v: Uint8Array) => string} Decoder */

/** @param {Uint8Array} v */ const u16 = (v) => String(getU16(v));
/** @param {Uint8Array} v */ const u32 = (v) => String(getU32(v));
/** @param {Uint8Array} v */ const bits32 = (v) => { const b = getU32(v); return Array.from({ length: 32 }, (_, i) => i).filter((i) => (b >>> i) & 1).join(', '); };
/** control characters and bad UTF-8 replaced (core §2.1) @param {Uint8Array} v */ const asText = (v) => shown(v);
/** @param {Uint8Array} v */ const channels = (v) => ranges(bitmapToChannels(getU16(v), v.slice(2)));
/** @param {Uint8Array} v */ const label = (v) => `${getU16(v)} = ${shown(v.slice(2))}`;
/** @param {Uint8Array} v */ const first = (v) => String(v[0]);

/** @type {Record<number, string>} */
const TRANSPORTS = { 1: 'UART bridge', 2: 'USB CDC', 3: 'USB-Serial/JTAG', 4: 'vendor bulk', 5: 'HID', 6: 'TCP' };
/** @type {Record<number, string>} */
const MECHANISMS = { 0: 'SDI', 1: 'DMDATA', 2: 'dmseq', 0xff: 'none' };

/** capture §3.5 (P2-★6): what the probe does while it captures @type {Record<number, string>} */
const BACKGROUND = { 0: 'blocks while capturing', 1: 'answers while capturing' };
/** @type {Record<number, string>} */
const CAPTURE_MODES = { 1: 'one-shot', 2: 'repeat', 3: 'streaming' };

/** capture describe's mode: mode(u8) background(u8) max_samples(u32) max_segments(u32) (oep-if-capture §3.5).
 * @param {Uint8Array} v */
function captureMode(v) {
  const mode = v[0], background = v[1], most = getU32(v, 2), segments = getU32(v, 6);
  return `${CAPTURE_MODES[mode] ?? `mode ${mode}`}, ${BACKGROUND[background] ?? `background ${background}`}, max ${most} samples x ${segments} segments`;
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

/** Names from oep-spec docs/capability-name-hierarchy.ja.md (provisional, 2026-09-24).
 * @type {Record<string, Known>} */
export const KNOWN = {
  'oep.core': known(
    'confirm, list, describe, open / end / keepalive, lock state, status, cancel; describe = the probe itself',
    { tags: { 0x40: ['firmware', asText], 0x41: ['model', asText], 0x42: ['unit id', asText],
      0x43: ['channels', u16], 0x44: ['reserved', channels], 0x45: ['profile', asText],
      0x46: ['label', label], 0x47: ['resets on open', () => 'yes'],
      0x49: ['transport', transport], 0x4a: ['discoverable', (v) => (v[0] === 1 ? 'yes' : 'no')],
      0x4b: ['plan roles', u32], 0x4c: ['chip', asText], 0x4d: ['max op ms', u32],
      0x4e: ['port speed', (v) => (v[0] === 1 ? 'yes' : 'no')] } }),
  'oep.wire.rvswd': known('scan, attach, detach over RVSWD (attach returns a connection)',
    { roles: { 1: 'SWDIO', 2: 'SWCLK', 3: 'reset' }, features: { 0: 'attach writes unbounded' }, tags: { 0x40: ['max connections', first] } }),
  'oep.wire.swio': known('scan, attach, detach over SWIO, one wire (attach returns a connection)',
    { roles: { 1: 'SWIO', 3: 'reset' }, features: { 0: 'attach writes unbounded' }, tags: { 0x40: ['max connections', first] } }),
  'oep.wire.swd': known('scan, attach, detach over ARM SWD',
    { roles: { 1: 'SWDIO', 2: 'SWCLK' }, features: { 0: 'attach writes unbounded' }, tags: { 0x40: ['max connections', first] } }),
  'oep.target.riscv-dm': known(
    'RISC-V Debug Module over DMI: step lists, block read/write, run until halt, halt/resume',
    { features: { 0: 'block read/write', 1: 'run until halt', 2: 'reset', 3: 'step' } }),
  'oep.target.arm-adi': known('ARM Debug Interface: DP/AP transfer lists, block transfers'),
  'oep.target.console': known('console streams on a debug connection (position-addressed, marks)',
    { tags: { 0x40: ['mechanisms', (v) => Array.from(v, (b) => MECHANISMS[b] ?? String(b)).join(', ')] } }),
  'oep.probe.config': known('the probe\'s configuration (plan, labels, idle pins, slots, binds, uart) and its storage; the state is op state',
    { tags: { 0x40: ['storage', (v) => `${u32(v.slice(0, 4))} bytes`],
      0x41: ['items', (v) => Array.from(v, String).join(', ')], 0x42: ['slots', first],
      0x43: ['bind modes', (v) => ['last-reset', 'manual', 'mixed'].filter((_, b) => (getU32(v) >>> b) & 1).join(', ')] } }),
  'oep.fixture.gpio': known('drive and read probe pins', { roles: { 1: 'line' }, tags: { 0x40: ['modes', bits32] } }),
  'oep.fixture.uart': known('a UART (USART, asynchronous) on probe pins', { roles: { 1: 'RX', 2: 'TX' },
    tags: { 0x40: ['formats', (v) => Array.from(v.slice(1, 1 + v[0]), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')] } }),
  'oep.fixture.logic': known('sampled logic capture', { roles: LOGIC_LINES, tags: { 0x40: ['mode', captureMode] } }),
  'oep.fixture.analog': known('sampled analog capture',
    { roles: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [k, `ch${k}`])), tags: { 0x40: ['mode', captureMode] } }),
  'oep.fixture.i2c-target': known('an I2C target the DUT can address (open-drain only, fixture §3)',
    { roles: { 1: 'SDA', 2: 'SCL' }, features: { 0: 'preloaded tx', 1: 'clock stretching', 2: 'internal pull-ups' },
      tags: { 0x40: ['queue depth', first], 0x41: ['max stretch us', u32], 0x42: ['pull-ups ohms', u32] } }),
  'oep.fixture.spi-target': known('an SPI target the DUT can clock (ESP-IDF slave driver)',
    { roles: { 1: 'SCK', 2: 'MOSI', 3: 'MISO', 4: 'CS' }, features: { 0: 'LSB first' } }),
};

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
