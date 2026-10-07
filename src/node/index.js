// @ts-check
// oep-client-js/node: the transports Node offers - TCP (node:net; also how the tests reach oep-client-python's virtual bench
// over TCP; probes found with DNS-SD _oep._tcp over mDNS, discovery.js), serial ports (serialport) and USB (usb, WebUSB-shaped: the vendor bulk interface, and the P4's DFU). The
// native modules are optional: install them only where Node talks to probes.
export { tcpTransport } from './tcp.js';
export { browse, findUnit, portOf, targetOf, Browser as DnsSdBrowser, SERVICE as DNS_SD_SERVICE } from './discovery.js';
export { serialTransport, listSerialPorts, findSerialProbes } from './serial.js';
export { usbTransport, findUsbProbes, findProbes, chooseProbe, describeProbe, SeveralProbesError, WAYS_IN, usbDevices, findDfuDevices, usbDfu, usbDfuUpdate } from './usb.js';
export { openTcp, openSerial, openUsb } from './open.js';
export { isProjectDevice, usbCandidate, PROJECT_VID, PROJECT_PID, PROJECT_VID_PIDS, usbUnitId, vendorTransport } from '../usbvendor.js';
export { DfuClient, DfuError, openDfu, dfuUpdate, DFU_STATUS, DFU_STATE, dfuStatusName, dfuStateName } from '../dfu.js';
export { sha256, parseFirmwareManifest, pickFirmware, fetchFirmwareManifest, fetchFirmware, verifyFirmware, firmwareFileUrl } from '../firmware.js';
