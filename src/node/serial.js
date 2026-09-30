// @ts-check
// Serial ports (USB CDC, USB-Serial/JTAG, a USB-UART bridge) through the optional `serialport` package: COBS frames
// and the port's raw bytes on one line (oep-core §3.1, §3.4).
/**
 * @param {{ path: string, baudRate?: number }} opts
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function serialTransport(opts) {
  void opts;
  throw new Error('serialTransport: not implemented yet');
}
