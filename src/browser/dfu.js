// @ts-check
// The ESP32-P4 probe's firmware update over WebUSB DFU (outside OEP; src/dfu.js does the protocol).
import { DFU_CLASS, DFU_SUBCLASS, dfuUpdate, findDfuInterface } from '../dfu.js';
import { fetchFirmware, fetchFirmwareManifest, pickFirmware, verifyFirmware } from '../firmware.js';

/** @typedef {import('../usbtypes.js').UsbDevice} UsbDevice */

/** @returns {any} */
const usbApi = () => {
  const u = /** @type {any} */ (globalThis.navigator)?.usb;
  if (!u) throw new Error('WebUSB is not available (a Chromium-based browser, over HTTPS or localhost)');
  return u;
};

/**
 * Ask the user for a device with a DFU interface (class 0xFE subclass 0x01).
 * @param {{ filters?: object[] }} [opts]
 * @returns {Promise<UsbDevice>}
 */
export function requestDfuDevice({ filters } = {}) {
  return usbApi().requestDevice({ filters: filters ?? [{ classCode: DFU_CLASS, subclassCode: DFU_SUBCLASS }] });
}

/** The devices this page was given before that have a DFU interface. @returns {Promise<UsbDevice[]>} */
export async function getDfuDevices() {
  /** @type {UsbDevice[]} */
  const all = await usbApi().getDevices();
  return all.filter((d) => (d.configurations ?? (d.configuration ? [d.configuration] : [])).some((c) => findDfuInterface(c)));
}

/**
 * Update a probe's firmware from a release: firmware-<version>.json at `manifestUrl`, the `model`'s app image (sha256
 * checked), downloaded over DFU. `image` instead of `manifestUrl` + `model` sends a file the user picked (checked
 * against `entry` when given).
 * @param {UsbDevice} device
 * @param {{ manifestUrl?: string, model?: string, image?: Uint8Array, entry?: import('../firmware.js').FirmwareEntry,
 *   onProgress?: (p: import('../dfu.js').DfuProgress) => void, signal?: AbortSignal }} opts
 */
export async function updateFirmware(device, { manifestUrl, model = 'esp32p4', image, entry, onProgress, signal }) {
  let bytes = image;
  if (bytes) {
    if (entry) await verifyFirmware(bytes, entry);
  } else {
    if (!manifestUrl) throw new Error('updateFirmware: give an image or a manifestUrl');
    const manifest = await fetchFirmwareManifest(manifestUrl);
    const picked = pickFirmware(manifest, { model, kind: 'app' });
    if (!picked) throw new Error(`firmware ${manifest.version}: no app image for ${model}`);
    bytes = await fetchFirmware(manifestUrl, picked);
  }
  return dfuUpdate(device, bytes, { onProgress, signal });
}
