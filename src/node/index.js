// @ts-check
// oep-client-js/node: the transports Node offers - TCP (node:net; also how the tests reach oep-client-python's fake
// probe), serial ports (serialport) and USB (usb, WebUSB-shaped: the vendor bulk interface, and the P4's DFU). The
// native modules are optional: install them only where Node talks to probes.
export { tcpTransport } from './tcp.js';
export { serialTransport, listSerialPorts } from './serial.js';
export { usbTransport, findUsbProbes, usbDevices, findDfuDevices, usbDfu, usbDfuUpdate } from './usb.js';
export { openTcp, openSerial, openUsb } from './open.js';
export { isOepDevice, usbUnitId, vendorTransport } from '../usbvendor.js';
export { DfuClient, DfuError, openDfu, dfuUpdate, DFU_STATUS, DFU_STATE, dfuStatusName, dfuStateName } from '../dfu.js';
export { sha256, parseFirmwareManifest, pickFirmware, fetchFirmwareManifest, fetchFirmware, verifyFirmware, firmwareFileUrl } from '../firmware.js';
