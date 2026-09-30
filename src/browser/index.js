// @ts-check
// oep-client-js/browser: the transports a browser offers - WebSerial (USB CDC, USB-Serial/JTAG, a USB-UART bridge),
// WebUSB (the vendor bulk interface, and the P4's DFU for firmware updates) and WebHID (the vendor HID interface).
// Chromium-based browsers only (Chrome, Edge); a page must be served over HTTPS (or localhost).
import { connect } from '../open.js';
import { requestSerialPort, webSerialTransport } from './webserial.js';
import { requestUsbProbe, webUsbTransport } from './webusb.js';
import { requestHidProbe, webHidTransport } from './webhid.js';

export { webSerialTransport, requestSerialPort, getSerialPorts, OEP_SERIAL_FILTERS } from './webserial.js';
export { webUsbTransport, requestUsbProbe, getUsbProbes, usbUnitId, isOepDevice } from './webusb.js';
export { webHidTransport, requestHidProbe, packHidReports, unpackHidReport, findVendorReports } from './webhid.js';
export { requestDfuDevice, getDfuDevices, updateFirmware } from './dfu.js';
export { DfuClient, DfuError, openDfu, dfuUpdate, DFU_STATUS, DFU_STATE, dfuStatusName, dfuStateName } from '../dfu.js';
export { sha256, parseFirmwareManifest, pickFirmware, fetchFirmwareManifest, fetchFirmware, verifyFirmware, firmwareFileUrl } from '../firmware.js';
export { connect } from '../open.js';

/**
 * A Host on a serial port (the chooser when `port` is not given), confirmed and ready.
 * @param {import('./webserial.js').SerialPortLike} [port]
 * @param {{ baudRate?: number, oepOnly?: boolean, timeoutMs?: number }} [opts]
 */
export async function openWebSerial(port, opts = {}) {
  const p = port ?? await requestSerialPort({ oepOnly: opts.oepOnly });
  return connect(await webSerialTransport(p, opts), { timeoutMs: opts.timeoutMs });
}

/**
 * A Host on a probe's vendor bulk interface (the chooser when `device` is not given).
 * @param {import('../usbtypes.js').UsbDevice} [device]
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function openWebUsb(device, opts = {}) {
  const d = device ?? await requestUsbProbe();
  return connect(await webUsbTransport(d), { timeoutMs: opts.timeoutMs });
}

/**
 * A Host on a probe's vendor HID interface (the chooser when `device` is not given).
 * @param {import('./webhid.js').HidDeviceLike} [device]
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function openWebHid(device, opts = {}) {
  const d = device ?? await requestHidProbe();
  return connect(await webHidTransport(d), { timeoutMs: opts.timeoutMs });
}
