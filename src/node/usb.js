// @ts-check
// USB through the optional `usb` package's WebUSB class (the same shape as a browser's WebUSB): the vendor bulk
// interface (src/usbvendor.js, shared with the browser), and the P4's DFU for firmware updates (src/dfu.js).
import { isOepDevice, usbUnitId, vendorTransport } from '../usbvendor.js';
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
  // a VID:PID given names the device; otherwise it must show itself as OEP (core §3.3)
  if (vendorId == null && !isOepDevice(d.vendorId, d.productId, d.productName)) return false;
  if (unitId && (usbUnitId(d) ?? '').toLowerCase() !== unitId.toLowerCase()) return false;
  return true;
}

/**
 * The OEP probes on USB (the OEP VID:PID, or an iProduct starting "OEP"), with their unit id (the USB serial).
 * @returns {Promise<{ unitId: string | null, vendorId: number, productId: number, product: string | null, device: UsbDevice }[]>}
 */
export async function findUsbProbes() {
  return (await usbDevices())
    .filter((d) => isOepDevice(d.vendorId, d.productId, d.productName))
    .map((d) => ({ unitId: usbUnitId(d), vendorId: d.vendorId, productId: d.productId, product: d.productName ?? null, device: d }));
}

/**
 * The one device matching `want` (the only OEP probe when nothing is given).
 * @param {{ unitId?: string, vendorId?: number, productId?: number }} want
 */
async function pick(want) {
  const found = (await usbDevices()).filter((d) => matches(d, want));
  const what = [want.vendorId != null ? `${hex(want.vendorId)}:${want.productId != null ? hex(want.productId) : '*'}` : 'OEP probe',
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
