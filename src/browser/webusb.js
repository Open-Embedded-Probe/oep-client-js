// @ts-check
// WebUSB: the probe's vendor bulk interface (class 0xFF, subclass 0x4F, protocol 0x45, one bulk IN / OUT pair;
// length(u16) frames, oep-core §3.1, §3.3). The same code runs in Node through the `usb` package (src/usbvendor.js).
import { VENDOR_CLASS, VENDOR_PROTOCOL, VENDOR_SUBCLASS, isProjectDevice, requireUnitName, temporaryClue, usbCandidate, usbUnitId, vendorTransport } from '../usbvendor.js';

export { usbUnitId, isProjectDevice, temporaryClue, usbCandidate };

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
 * Ask the user for a probe's USB device. The default chooser filter - devices with a vendor interface class 0xFF,
 * subclass 0x4F, protocol 0x45 - is a temporary clue (host guide §1.7, not normative) until the project's VID:PID
 * exists; the device the user picks is a device the user chose (core §3.3), not an identified one: connect (openWebUsb)
 * probes it with a confirm first and closes it when no valid answer comes. No iProduct check.
 * @param {{ filters?: object[] }} [opts]
 * @returns {Promise<UsbDevice>}
 */
export async function requestUsbProbe({ filters } = {}) {
  return /** @type {UsbDevice} */ (await usbApi().requestDevice({
    filters: filters ?? [{ classCode: VENDOR_CLASS, subclassCode: VENDOR_SUBCLASS, protocolCode: VENDOR_PROTOCOL }],
  }));
}

/**
 * The devices this page was given before (no chooser). With `unitId`: the one whose USB serial is that unit id, by the
 * serial alone (core §3.3; connect's `unitId` then checks describe). Without: the candidates - the project's VID:PID
 * (none listed yet) or a temporary clue (host guide §1.7) - each still probed by confirm when opened. An `x-` unit id
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
