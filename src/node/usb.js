// @ts-check
// USB through the optional `usb` package's WebUSB class (the same shape as a browser's WebUSB): the vendor bulk
// interface (src/usbvendor.js, shared with the browser), and the P4's DFU for firmware updates (src/dfu.js).
import { PROJECT_PID, PROJECT_VID, findVendorInterface, requireUnitName, usbCandidate, usbUnitId, vendorTransport } from '../usbvendor.js';
import { findSerialProbes } from './serial.js';
import { dfuUpdate, findDfuInterface, openDfu } from '../dfu.js';

/** @typedef {import('../usbtypes.js').UsbDevice} UsbDevice */

/** @returns {Promise<any>} the `usb` module */
export async function loadUsb() {
  const name = 'usb';   // not a literal: the package is optional
  try {
    return await import(name);
  } catch (e) {
    const err = new Error('USB needs the optional package "usb" (npm install usb)');
    /** @type {any} */ (err).cause = e;
    throw err;
  }
}

/** Every USB device this process may open, as WebUSB devices. @returns {Promise<UsbDevice[]>} */
export async function usbDevices() {
  const { WebUSB } = await loadUsb();
  const webusb = new WebUSB({ allowAllDevices: true });
  return webusb.getDevices();
}

/**
 * @param {UsbDevice} d
 * @param {{ unitId?: string, vendorId?: number, productId?: number }} want
 */
function matches(d, { unitId, vendorId, productId }) {
  if (vendorId != null && d.vendorId !== vendorId) return false;
  if (productId != null && d.productId !== productId) return false;
  // a unit id names the device by its serial alone (transports §3: checked by describe after confirm, open.js connect)
  if (unitId) return (usbUnitId(d) ?? '').toLowerCase() === unitId.toLowerCase();
  // a VID:PID given names the device; otherwise the project's VID:PID (transports §3) - probed by confirm first either way
  if (vendorId == null && !usbCandidate(d)) return false;
  return true;
}

/**
 * The USB devices with the project's VID:PID (transports §3), with their unit id (the USB serial). Nothing is sent here;
 * opening one (openUsb) probes it with a confirm first. A probe with only a CDC port (RP2040 / RP2350) is opened as a
 * serial port: findSerialProbes; findProbes lists both, each device once.
 * @returns {Promise<{ unitId: string | null, vendorId: number, productId: number, product: string | null, device: UsbDevice }[]>}
 */
export async function findUsbProbes() {
  return (await usbDevices())
    .filter((d) => usbCandidate(d))
    .map((d) => ({ unitId: usbUnitId(d), vendorId: d.vendorId, productId: d.productId, product: d.productName ?? null, device: d }));
}

/** A device's ways in, in the order a bare openUsb tries them (transports §3; Node opens vendor bulk and CDC, a browser's
 * WebHID the HID one). */
export const WAYS_IN = Object.freeze(['vendor', 'hid', 'cdc']);

/** @param {UsbDevice} d @returns {Set<string>} the ways in its interfaces offer */
function waysOf(d) {
  const ways = new Set();
  for (const c of /** @type {any[]} */ (d.configurations ?? (d.configuration ? [d.configuration] : []))) {
    if (findVendorInterface(c)) ways.add('vendor');
    for (const intf of c?.interfaces ?? []) {
      for (const alt of intf.alternates ?? (intf.alternate ? [intf.alternate] : [])) {
        if (alt.interfaceClass === 0x03) ways.add('hid');
        else if (alt.interfaceClass === 0x02 || alt.interfaceClass === 0x0a) ways.add('cdc');
      }
    }
  }
  return ways;
}

/**
 * @typedef {object} UsbProbe
 * @property {string | null} unitId  its USB serial (null when it could not be read)
 * @property {string[]} ways  its ways in, WAYS_IN order
 * @property {string[]} ports  its CDC serial ports
 * @property {UsbDevice | null} device  the WebUSB device (null: seen only as a serial port)
 */

/** "unit id: ways in" of a probe, a CDC port with its path. @param {UsbProbe} p */
export function describeProbe(p) {
  const ways = p.ways.map((w) => (w === 'cdc' && p.ports.length ? `cdc ${p.ports.join(' ')}` : w));
  return `${p.unitId ?? 'no USB serial'}: ${ways.join(', ') || 'no way in'}`;
}

/**
 * Every device with the project's VID:PID (transports §3), each once whatever ways in it has: the USB devices (vendor bulk,
 * HID, CDC from their interfaces) and the serial ports on that VID:PID (findSerialProbes), the same device when their
 * USB serials match (case aside). A source whose optional package is missing adds nothing. Nothing is sent here.
 * `devices` / `ports`: the lists to use (default: usbDevices() / listSerialPorts() now).
 * @param {{ devices?: UsbDevice[], ports?: { path: string, vendorId?: string, productId?: string, serialNumber?: string }[] }} [from]
 * @returns {Promise<UsbProbe[]>}
 */
export async function findProbes({ devices, ports } = {}) {
  /** @type {UsbProbe[]} */
  const probes = [];
  /** @param {string | null} unitId */
  const find = (unitId) => (unitId ? probes.find((p) => p.unitId?.toLowerCase() === unitId.toLowerCase()) : undefined);
  for (const d of (devices ?? await usbDevices().catch(() => [])).filter((x) => usbCandidate(x))) {
    const unitId = usbUnitId(d);
    let p = find(unitId);
    if (!p) probes.push(p = { unitId, ways: [], ports: [], device: d });
    const ways = waysOf(d);
    p.ways = WAYS_IN.filter((w) => p?.ways.includes(w) || ways.has(w));
  }
  for (const { path, unitId } of await findSerialProbes(ports).catch(() => [])) {
    let p = find(unitId);
    if (!p) probes.push(p = { unitId, ways: [], ports: [], device: null });
    p.ways = WAYS_IN.filter((w) => p?.ways.includes(w) || w === 'cdc');
    if (!p.ports.includes(path)) p.ports.push(path);
  }
  return probes;
}

/** openUsb() with nothing given found more than one probe on the project's VID:PID and does not guess which: name one.
 * `probes` lists them. */
export class SeveralProbesError extends Error {
  /** @param {string} message @param {UsbProbe[]} probes */
  constructor(message, probes) {
    super(message);
    this.name = 'SeveralProbesError';
    this.probes = probes;
  }
}

/**
 * What openUsb() with nothing given opens among `probes` (findProbes): null when there is none; the one probe when
 * there is exactly one; SeveralProbesError (nothing opened) when there are more.
 * @param {UsbProbe[]} probes
 */
export function chooseProbe(probes) {
  if (probes.length > 1) {
    throw new SeveralProbesError(`${probes.length} probes on ${hex(PROJECT_VID)}:${hex(PROJECT_PID)} (${probes.map(describeProbe).join('; ')}); `
      + 'not choosing one: name one with openUsb({ unitId }) or openSerial({ path })', probes);
  }
  return probes[0] ?? null;
}

/**
 * The one device matching `want` (the only candidate when nothing is given; by its serial alone for a unitId).
 * @param {{ unitId?: string, vendorId?: number, productId?: number }} want
 */
async function pick(want) {
  if (want.unitId) requireUnitName(want.unitId);
  const found = (await usbDevices()).filter((d) => matches(d, want));
  const what = [want.unitId ? 'device' : want.vendorId != null ? `${hex(want.vendorId)}:${want.productId != null ? hex(want.productId) : '*'}` : 'OEP probe',
    want.unitId ? `unit id ${want.unitId}` : ''].filter(Boolean).join(' ');
  if (!found.length) throw new Error(`no USB ${what}`);
  if (found.length > 1 && !want.unitId) throw new Error(`${found.length} USB devices match (${what}): give the unitId`);
  return found[0];
}

/**
 * The vendor bulk transport of an OEP probe on USB.
 * @param {{ unitId?: string, vendorId?: number, productId?: number, readSize?: number, depth?: number }} [opts]
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function usbTransport(opts = {}) {
  return vendorTransport(await pick(opts), opts);
}

/** The USB devices with a DFU interface (class 0xFE subclass 0x01), with their serial. */
export async function findDfuDevices() {
  return (await usbDevices())
    .filter((d) => (d.configurations ?? (d.configuration ? [d.configuration] : [])).some((c) => findDfuInterface(c)))
    .map((d) => ({ unitId: usbUnitId(d), vendorId: d.vendorId, productId: d.productId, product: d.productName ?? null, device: d }));
}

/**
 * The DFU interface of a probe on USB, opened (see src/dfu.js openDfu).
 * @param {{ unitId?: string, vendorId?: number, productId?: number }} [opts]
 */
export async function usbDfu(opts = {}) {
  return openDfu(await pick(opts));
}

/**
 * Download `image` into a probe over DFU (the P4: its app image, OepProbe-esp32p4-<version>.bin).
 * @param {Uint8Array} image
 * @param {{ unitId?: string, vendorId?: number, productId?: number,
 *   onProgress?: (p: import('../dfu.js').DfuProgress) => void, signal?: AbortSignal }} [opts]
 */
export async function usbDfuUpdate(image, opts = {}) {
  return dfuUpdate(await pick(opts), image, opts);
}

/** @param {number} n */
const hex = (n) => n.toString(16).padStart(4, '0');
