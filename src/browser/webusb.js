// @ts-check
// WebUSB: the probe's vendor bulk interface (class 0xFF, subclass 0x4F, protocol 0x45, one bulk IN / OUT pair;
// length(u16) frames, oep-core §3.1, §3.3). The same code runs in Node through the `usb` package (src/usbvendor.js).
import { VENDOR_CLASS, VENDOR_PROTOCOL, VENDOR_SUBCLASS, isOepDevice, usbUnitId, vendorTransport } from '../usbvendor.js';

export { usbUnitId, isOepDevice };

/** @typedef {import('../usbtypes.js').UsbDevice} UsbDevice */

/** @returns {any} */
const usbApi = () => {
  const u = /** @type {any} */ (globalThis.navigator)?.usb;
  if (!u) throw new Error('WebUSB is not available (a Chromium-based browser, over HTTPS or localhost)');
  return u;
};

/**
 * The vendor bulk transport on a WebUSB USBDevice (opened and its interface claimed here).
 * @param {UsbDevice} device
 * @param {{ readSize?: number, depth?: number }} [opts]
 */
export function webUsbTransport(device, opts) {
  return vendorTransport(device, opts);
}

/**
 * Ask the user for an OEP probe's USB device: the chooser offers devices with the OEP vendor interface (class 0xFF,
 * subclass 0x4F, protocol 0x45), and the one picked must have an iProduct starting "OEP" (core §3.3).
 * @param {{ filters?: object[] }} [opts]
 * @returns {Promise<UsbDevice>}
 */
export async function requestUsbProbe({ filters } = {}) {
  const device = /** @type {UsbDevice} */ (await usbApi().requestDevice({
    filters: filters ?? [{ classCode: VENDOR_CLASS, subclassCode: VENDOR_SUBCLASS, protocolCode: VENDOR_PROTOCOL }],
  }));
  if (!isOepDevice(device.vendorId, device.productId, device.productName)) {
    throw new Error(`not an OEP probe: ${device.productName ?? 'no product name'} (${hex(device.vendorId)}:${hex(device.productId)})`);
  }
  return device;
}

/**
 * The OEP probes this page was given before (no chooser), optionally the one whose unit id (USB serial) is `unitId`.
 * @param {{ unitId?: string }} [opts]
 * @returns {Promise<UsbDevice[]>}
 */
export async function getUsbProbes({ unitId } = {}) {
  /** @type {UsbDevice[]} */
  const all = await usbApi().getDevices();
  return all.filter((d) => isOepDevice(d.vendorId, d.productId, d.productName)
    && (!unitId || (usbUnitId(d) ?? '').toLowerCase() === unitId.toLowerCase()));
}

/** @param {number} n */
const hex = (n) => n.toString(16).padStart(4, '0');
