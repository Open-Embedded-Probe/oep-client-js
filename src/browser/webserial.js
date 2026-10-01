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
 * @property {(signals: { dataTerminalReady?: boolean, requestToSend?: boolean, break?: boolean }) => Promise<void>} [setSignals]
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
 * A serial port as a transport. `setBaudRate` changes the rate the way esptool-js does over WebSerial: the same
 * SerialPort closed and opened again at the new baudRate (the page keeps its permission), DTR and RTS then released
 * together at once (a UART bridge's auto-reset circuit resets the board when they differ), and the reader started
 * again - what arrived meanwhile is gone, which port_speed expects (oep-core §3.5).
 * @param {SerialPortLike} port
 * @param {{ baudRate?: number, bufferSize?: number }} [opts]  baudRate matters only on a UART bridge
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function webSerialTransport(port, { baudRate = 115200, bufferSize = 65536 } = {}) {
  if (!port.readable) await port.open({ baudRate, bufferSize });
  if (!port.writable || !port.readable) throw new Error('the serial port did not open');
  /** @type {WritableStreamDefaultWriter<Uint8Array>} */
  let writer = port.writable.getWriter();
  /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
  let reader = null;
  let closing = false, reopening = false;
  /** @type {((chunk: Uint8Array) => void) | null} */ let deliver = null;
  /** @type {((error?: unknown) => void) | null} */ let closed = null;
  const read = () => {
    const readable = port.readable;
    if (!readable || !deliver || !closed) return;
    const r = reader = readable.getReader();
    const onData = deliver, onClose = closed;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          if (value && value.length) onData(value);
        }
        if (!reopening) onClose();
      } catch (e) {
        if (!reopening) onClose(closing ? undefined : e);
      }
    })();
  };
  /** @type {import('../link.js').Transport} */
  const transport = {
    framing: 'cobs',
    kind: 'serial',
    baudRate,
    write: (data) => writer.write(data),
    start(onData, onClose) {
      deliver = onData;
      closed = onClose;
      read();
    },
    async setBaudRate(rate) {
      reopening = true;
      try {
        try { await reader?.cancel(); } catch { /* gone */ }
        try { reader?.releaseLock(); } catch { /* gone */ }
        try { writer.releaseLock(); } catch { /* gone */ }
        await port.close();
        await port.open({ baudRate: rate, bufferSize });
        try { await port.setSignals?.({ dataTerminalReady: false, requestToSend: false }); } catch { /* no signals */ }
        if (!port.writable || !port.readable) throw new Error('the serial port did not open again');
        writer = port.writable.getWriter();
        transport.baudRate = rate;
      } finally {
        reopening = false;
      }
      read();
    },
    async close() {
      closing = true;
      try { await reader?.cancel(); } catch { /* gone */ }
      try { reader?.releaseLock(); } catch { /* gone */ }
      try { writer.releaseLock(); } catch { /* gone */ }
      try { await port.close(); } catch { /* gone */ }
    },
  };
  return transport;
}
