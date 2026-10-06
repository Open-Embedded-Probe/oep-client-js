// @ts-check
// WebUSB: the probe's vendor bulk interface (class 0xFF, subclass 0x4F, protocol 0x45, one bulk IN / OUT pair;
// length(u16) frames, transports §1, §3). The same code runs in Node through the `usb` package (src/usbvendor.js).
import { PROJECT_USB_FILTERS, isProjectDevice, requireUnitName, usbCandidate, usbUnitId, vendorTransport } from '../usbvendor.js';

export { usbUnitId, isProjectDevice, usbCandidate };

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
 * Ask the user for a probe's USB device. The default chooser filter is the project's VID:PID (transports §3); a caller's
 * `filters` (another implementation's VID:PID) offer devices the user then chooses, which connect (openWebUsb) probes
 * with a confirm first and closes when no valid answer comes.
 * @param {{ filters?: object[] }} [opts]
 * @returns {Promise<UsbDevice>}
 */
export async function requestUsbProbe({ filters } = {}) {
  return /** @type {UsbDevice} */ (await usbApi().requestDevice({ filters: filters ?? [...PROJECT_USB_FILTERS] }));
}

/**
 * The devices this page was given before (no chooser). With `unitId`: the one whose USB serial is that unit id, by the
 * serial alone (transports §3; connect's `unitId` then checks describe). Without: the devices with the project's VID:PID,
 * each still probed by confirm when opened. An `x-` unit id
 * names no unit (core §7.5): RangeError.
 * @param {{ unitId?: string }} [opts]
 * @returns {Promise<UsbDevice[]>}
 */
export async function getUsbProbes({ unitId } = {}) {
  /** @type {UsbDevice[]} */
  const all = await usbApi().getDevices();
  if (unitId) requireUnitName(unitId);   // an x- unit_id names no device (core §7.5)
  if (unitId) return all.filter((d) => (usbUnitId(d) ?? '').toLowerCase() === unitId.toLowerCase());
  return all.filter((d) => usbCandidate(d));
}
