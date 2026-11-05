// @ts-check
// An RP2040 / RP2350 probe's firmware update from the browser: the running probe goes into its boot ROM through its
// reset interface (rp2ResetToBoot), then the boot ROM is chosen over WebUSB and written over PICOBOOT (src/picoboot.js).
import { RP2_BOOT_PID, RP2_BOOT_VID, rp2Write } from '../picoboot.js';

/** Ask the user for the boot ROM of a `model` ('rp2040' | 'rp2350') chip. @param {'rp2040' | 'rp2350'} model */
export function requestRp2Boot(model) {
  const usb = /** @type {any} */ (globalThis.navigator)?.usb;
  if (!usb) throw new Error('WebUSB is not available (a Chromium-based browser, over HTTPS or localhost)');
  return usb.requestDevice({ filters: [{ vendorId: RP2_BOOT_VID, productId: RP2_BOOT_PID[model] }] });
}

export { rp2Write };
