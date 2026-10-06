// @ts-check
// Serial ports (USB CDC, USB-Serial/JTAG, a USB-UART bridge) through the optional `serialport` package: COBS frames
// and the port's raw bytes on one line (transports §1, §4). Opened exclusively (lock: true), 8 data bits, no parity,
// 1 stop bit, no flow control, DTR and RTS asserted from the open on and while it stays open (transports §4, C-09: a UART
// bridge may wire them to the probe's reset; what a probe does with DTR deasserted is not defined). serialport has no
// option to give DTR / RTS at open: the OS asserts both when the port opens (POSIX termios, Windows DTR_CONTROL_ENABLE /
// RTS_CONTROL_ENABLE), and `set({ dtr: true, rts: true })` right after the open makes it explicit.

import { isProjectDevice } from '../usbvendor.js';

/** @returns {Promise<any>} the `serialport` module */
export async function loadSerialport() {
  const name = 'serialport';   // not a literal: the package is optional, and neither tsc nor a bundler should need it
  try {
    return await import(name);
  } catch (e) {
    const err = new Error('serial ports need the optional package "serialport" (npm install serialport)');
    /** @type {any} */ (err).cause = e;
    throw err;
  }
}

/**
 * The serial ports the OS lists (path, and for USB ones vendorId / productId / serialNumber in hex / text).
 * @returns {Promise<{ path: string, vendorId?: string, productId?: string, serialNumber?: string, manufacturer?: string }[]>}
 */
export async function listSerialPorts() {
  const { SerialPort } = await loadSerialport();
  return SerialPort.list();
}

/**
 * The serial ports of devices with the project's VID:PID (transports §3: every CDC of an OEP probe is a serial port), with
 * their unit id (the USB serial). How a probe with only a CDC port (RP2040 / RP2350) is found without naming the port;
 * still probed by confirm when opened. A UART bridge or a built-in USB serial is never on that VID:PID: its port is
 * chosen by the user. `ports`: a list as listSerialPorts gives it (default: the OS's now).
 * @param {{ path: string, vendorId?: string, productId?: string, serialNumber?: string }[]} [ports]
 * @returns {Promise<{ path: string, unitId: string | null }[]>}
 */
export async function findSerialProbes(ports) {
  return (ports ?? await listSerialPorts())
    .filter((p) => p.vendorId != null && p.productId != null && isProjectDevice(parseInt(p.vendorId, 16), parseInt(p.productId, 16)))
    .map((p) => ({ path: p.path, unitId: p.serialNumber || null }));
}

/** The port's options as transports §4 asks (C-09), for a check: 8N1, no flow control. */
export const SERIAL_LINE = Object.freeze({ dataBits: 8, parity: 'none', stopBits: 1, rtscts: false, xon: false, xoff: false, xany: false });

/** DTR and RTS asserted (transports §4, C-09); a port that cannot set them (a pty, a driver without modem lines) keeps what
 * the open gave. @param {any} port */
export function assertLines(port) {
  return new Promise((resolve) => {
    try { port.set({ dtr: true, rts: true }, () => resolve(undefined)); } catch { resolve(undefined); }
  });
}

/**
 * @param {{ path: string, baudRate?: number }} opts  baudRate matters only on a UART bridge
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function serialTransport({ path, baudRate = 115200 }) {
  const { SerialPort } = await loadSerialport();
  const port = new SerialPort({ path, baudRate, ...SERIAL_LINE, lock: true, autoOpen: false });
  await new Promise((resolve, reject) => port.open((/** @type {Error | null} */ e) => (e ? reject(e) : resolve(undefined))));
  await assertLines(port);
  let closing = false;
  /** @type {import('../link.js').Transport} */
  const transport = {
    framing: 'cobs',
    kind: 'serial',
    path,
    baudRate,
    // port_speed (oep-if-link §3): the rate changed in place (serialport's update)
    setBaudRate: (rate) => new Promise((resolve, reject) => port.update({ baudRate: rate }, (/** @type {Error | null} */ e) => {
      if (e) return reject(e);
      transport.baudRate = rate;
      resolve();
    })),
    write: (data) => new Promise((resolve, reject) => {
      port.write(Buffer.from(data.buffer, data.byteOffset, data.length), (/** @type {Error | null | undefined} */ e) => {
        if (e) return reject(e);
        port.drain((/** @type {Error | null} */ e2) => (e2 ? reject(e2) : resolve()));
      });
    }),
    start(onData, onClose) {
      let ended = false;
      /** @param {unknown} [e] */
      const end = (e) => { if (!ended) { ended = true; onClose(closing ? undefined : e); } };
      port.on('data', (/** @type {Buffer} */ chunk) => onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
      port.on('close', (/** @type {Error | null} */ e) => end(e ?? undefined));
      port.on('error', (/** @type {Error} */ e) => end(e));
    },
    close: () => new Promise((resolve) => {
      closing = true;
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    }),
  };
  return transport;
}
