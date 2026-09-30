// @ts-check
// oep-client-js/node: the transports Node offers - TCP (node:net; also how the tests reach oep-client-python's fake
// probe), serial ports (serialport) and USB (usb, WebUSB-shaped). The native modules are optional: install them only
// where Node talks to probes.
export { tcpTransport } from './tcp.js';
export { serialTransport } from './serial.js';
export { usbTransport, findUsbProbes } from './usb.js';
export { openTcp, openSerial, openUsb } from './open.js';
