// @ts-check
// USB (the vendor bulk interface) through the optional `usb` package (WebUSB-shaped).
/**
 * @param {{ unitId?: string, vendorId?: number, productId?: number }} opts
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function usbTransport(opts = {}) {
  void opts;
  throw new Error('usbTransport: not implemented yet');
}
export async function findUsbProbes() { return []; }
