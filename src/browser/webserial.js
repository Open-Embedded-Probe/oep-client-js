// @ts-check
// WebSerial: a serial port (USB CDC, USB-Serial/JTAG, a USB-UART bridge). COBS frames and the port's raw bytes on
// one line (oep-core §3.1, §3.4).
import { REFERENCE_PRODUCT_ID, REFERENCE_VENDOR_ID } from '../usbvendor.js';

/**
 * The part of WebSerial's SerialPort used here (lib.dom does not carry WebSerial).
 * @typedef {object} SerialPortLike
 * @property {(opts: { baudRate: number, bufferSize?: number }) => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {ReadableStream<Uint8Array> | null} readable
 * @property {WritableStream<Uint8Array> | null} writable
 * @property {() => { usbVendorId?: number, usbProductId?: number }} [getInfo]
 */
/** @typedef {{ usbVendorId?: number, usbProductId?: number }} SerialPortFilter */

/** The USB serial ports the reference firmware shows (its VID:PID, registry usb). A probe is told by its iProduct
 * (core §3.3), which WebSerial does not show: this is a hint for the chooser, not a test. */
export const OEP_SERIAL_FILTERS = [
  { usbVendorId: REFERENCE_VENDOR_ID, usbProductId: REFERENCE_PRODUCT_ID },
];

/** @returns {any} */
const serialApi = () => {
  const s = /** @type {any} */ (globalThis.navigator)?.serial;
  if (!s) throw new Error('WebSerial is not available (a Chromium-based browser, over HTTPS or localhost)');
  return s;
};

/**
 * Ask the user for a serial port. `oepOnly`: offer only the ports of OEP USB devices (a USB-UART bridge or a
 * USB-Serial/JTAG port is not one: leave it off for those).
 * @param {{ oepOnly?: boolean, filters?: SerialPortFilter[] }} [opts]
 * @returns {Promise<SerialPortLike>}
 */
export function requestSerialPort({ oepOnly = false, filters } = {}) {
  const f = filters ?? (oepOnly ? OEP_SERIAL_FILTERS : undefined);
  return serialApi().requestPort(f ? { filters: f } : {});
}

/** The ports this page was given before. @returns {Promise<SerialPortLike[]>} */
export function getSerialPorts() { return serialApi().getPorts(); }

/**
 * @param {SerialPortLike} port
 * @param {{ baudRate?: number, bufferSize?: number }} [opts]  baudRate matters only on a UART bridge
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function webSerialTransport(port, { baudRate = 115200, bufferSize = 65536 } = {}) {
  if (!port.readable) await port.open({ baudRate, bufferSize });
  const writable = port.writable;
  const readable = port.readable;
  if (!writable || !readable) throw new Error('the serial port did not open');
  const writer = writable.getWriter();
  /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
  let reader = null;
  let closing = false;
  return {
    framing: 'cobs',
    kind: 'serial',
    write: (data) => writer.write(data),
    start(onData, onClose) {
      reader = readable.getReader();
      const r = reader;
      (async () => {
        try {
          for (;;) {
            const { value, done } = await r.read();
            if (done) break;
            if (value && value.length) onData(value);
          }
          onClose();
        } catch (e) {
          onClose(closing ? undefined : e);
        }
      })();
    },
    async close() {
      closing = true;
      try { await reader?.cancel(); } catch { /* gone */ }
      try { reader?.releaseLock(); } catch { /* gone */ }
      try { writer.releaseLock(); } catch { /* gone */ }
      try { await port.close(); } catch { /* gone */ }
    },
  };
}
