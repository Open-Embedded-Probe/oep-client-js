// @ts-check
// WebUSB: the probe's vendor bulk interface (bInterfaceClass 0xFF, one bulk IN / OUT pair; length(u16) frames,
// oep-core §3.1, §3.3). The same code runs in Node through the `usb` package (src/usbvendor.js).
import { OEP_PRODUCT_ID, OEP_VENDOR_ID, VENDOR_CLASS, isOepDevice, usbUnitId, vendorTransport } from '../usbvendor.js';

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
 * Ask the user for an OEP probe's USB device. The OEP VID:PID is not granted yet, so the chooser offers devices with a
 * vendor-class interface, and the one picked must have an iProduct starting "OEP" (core §3.3).
 * @param {{ filters?: object[] }} [opts]
 * @returns {Promise<UsbDevice>}
 */
export async function requestUsbProbe({ filters } = {}) {
  const device = /** @type {UsbDevice} */ (await usbApi().requestDevice({
    filters: filters ?? [{ vendorId: OEP_VENDOR_ID, productId: OEP_PRODUCT_ID }, { classCode: VENDOR_CLASS }],
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
