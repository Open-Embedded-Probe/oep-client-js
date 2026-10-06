// @ts-check
// WebSerial: a serial port (USB CDC, USB-Serial/JTAG, a USB-UART bridge). COBS frames and the port's raw bytes on
// one line (transports §1, §4). Opened 8N1 without flow control, DTR and RTS asserted (transports §4, C-09): WebSerial
// cannot name DTR / RTS before the open (the browser asserts both when it opens the port), so `setSignals` asserts
// them right after every open; a browser without setSignals keeps what the open gave.

/**
 * The part of WebSerial's SerialPort used here (lib.dom does not carry WebSerial).
 * @typedef {object} SerialPortLike
 * @property {(opts: { baudRate: number, bufferSize?: number, dataBits?: number, stopBits?: number, parity?: string, flowControl?: string }) => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {ReadableStream<Uint8Array> | null} readable
 * @property {WritableStream<Uint8Array> | null} writable
 * @property {() => { usbVendorId?: number, usbProductId?: number }} [getInfo]
 * @property {(signals: { dataTerminalReady?: boolean, requestToSend?: boolean, break?: boolean }) => Promise<void>} [setSignals]
 */
/** @typedef {{ usbVendorId?: number, usbProductId?: number }} SerialPortFilter */

/** @returns {any} */
const serialApi = () => {
  const s = /** @type {any} */ (globalThis.navigator)?.serial;
  if (!s) throw new Error('WebSerial is not available (a Chromium-based browser, over HTTPS or localhost)');
  return s;
};

/**
 * Ask the user for a serial port. `filters`: the caller's WebSerial filters (by VID:PID) to narrow the chooser; none
 * offers every port - a UART bridge or a built-in USB serial is never on the project's VID:PID, so the default does not
 * narrow. PROJECT_SERIAL_FILTERS (usbvendor.js) offers only probes on the project's VID:PID (transports §3).
 * @param {{ filters?: SerialPortFilter[] }} [opts]
 * @returns {Promise<SerialPortLike>}
 */
export function requestSerialPort({ filters } = {}) {
  return serialApi().requestPort(filters ? { filters } : {});
}

/** WebSerial's open options as transports §4 asks (C-09): 8N1, no flow control. */
export const SERIAL_LINE = Object.freeze({ dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });

/** DTR and RTS asserted together (transports §4, C-09); a browser without setSignals keeps what the open gave.
 * @param {SerialPortLike} port */
async function assertSignals(port) {
  try { await port.setSignals?.({ dataTerminalReady: true, requestToSend: true }); } catch { /* no signals */ }
}

/** The ports this page was given before. @returns {Promise<SerialPortLike[]>} */
export function getSerialPorts() { return serialApi().getPorts(); }

/**
 * A serial port as a transport, opened 8N1 without flow control with DTR and RTS asserted (transports §4, C-09).
 * `setBaudRate` changes the rate the way esptool-js does over WebSerial: the same SerialPort closed and opened again at
 * the new baudRate (the page keeps its permission), DTR and RTS then asserted together at once (a UART bridge's
 * auto-reset circuit resets the board when they differ), and the reader started again - what arrived meanwhile is
 * gone, which port_speed expects (oep-if-link §3).
 * @param {SerialPortLike} port
 * @param {{ baudRate?: number, bufferSize?: number }} [opts]  baudRate matters only on a UART bridge
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function webSerialTransport(port, { baudRate = 115200, bufferSize = 65536 } = {}) {
  if (!port.readable) await port.open({ baudRate, bufferSize, ...SERIAL_LINE });
  await assertSignals(port);
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
        await port.open({ baudRate: rate, bufferSize, ...SERIAL_LINE });
        await assertSignals(port);
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
