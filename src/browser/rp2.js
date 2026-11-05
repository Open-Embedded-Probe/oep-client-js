// @ts-check
// An RP2040 / RP2350 probe's firmware update from the browser: a 1200 baud touch of its CDC port (Web Serial) restarts
// it into the boot ROM, then the boot ROM is chosen over WebUSB and written over PICOBOOT (src/picoboot.js).
import { RP2_BOOT_PID, RP2_BOOT_VID, rp2Write } from '../picoboot.js';
import { PROJECT_SERIAL_FILTERS } from '../usbvendor.js';

/**
 * Restart an RP2 probe into its boot ROM: open its CDC port at 1200 baud and close it with DTR low (the Arduino RP2
 * core's touch). `port`: a Web Serial port; the chooser (this project's VID:PID) when not given.
 * @param {any} [port]
 */
export async function rp2Bootsel(port) {
  const serial = /** @type {any} */ (globalThis.navigator)?.serial;
  if (!serial && !port) throw new Error('Web Serial is not available (a Chromium-based browser, over HTTPS or localhost)');
  const p = port ?? await serial.requestPort({ filters: PROJECT_SERIAL_FILTERS });
  if (p.readable || p.writable) await p.close();
  await p.open({ baudRate: 1200 });
  try { await p.setSignals({ dataTerminalReady: false }); } catch { /* some ports take no signals */ }
  await new Promise((r) => setTimeout(r, 100));
  await p.close();
}

/** Ask the user for the boot ROM of a `model` ('rp2040' | 'rp2350') chip. @param {'rp2040' | 'rp2350'} model */
export function requestRp2Boot(model) {
  const usb = /** @type {any} */ (globalThis.navigator)?.usb;
  if (!usb) throw new Error('WebUSB is not available (a Chromium-based browser, over HTTPS or localhost)');
  return usb.requestDevice({ filters: [{ vendorId: RP2_BOOT_VID, productId: RP2_BOOT_PID[model] }] });
}

export { rp2Write };
