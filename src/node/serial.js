// @ts-check
// Serial ports (USB CDC, USB-Serial/JTAG, a USB-UART bridge) through the optional `serialport` package: COBS frames
// and the port's raw bytes on one line (oep-core §3.1, §3.4). Opened exclusively (lock: true).

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
 * @param {{ path: string, baudRate?: number }} opts  baudRate matters only on a UART bridge
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function serialTransport({ path, baudRate = 115200 }) {
  const { SerialPort } = await loadSerialport();
  const port = new SerialPort({ path, baudRate, lock: true, autoOpen: false });
  await new Promise((resolve, reject) => port.open((/** @type {Error | null} */ e) => (e ? reject(e) : resolve(undefined))));
  let closing = false;
  /** @type {import('../link.js').Transport} */
  const transport = {
    framing: 'cobs',
    kind: 'serial',
    path,
    baudRate,
    // port_speed (oep-core §3.5): the rate changed in place (serialport's update)
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
