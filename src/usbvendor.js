// @ts-check
// The vendor bulk transport on a WebUSB-shaped device (oep-core §3.1, §3.3): the OEP vendor interface's bulk IN / OUT
// pair (class 0xFF, subclass 0x4F 'O', protocol 0x45 'E' - chosen by those, not the first bulk pair: a CDC has one
// too, and another vendor interface may), length(u16) frames. Shared by the browser (WebUSB) and Node (the `usb`
// package's WebUSB class); nothing here touches either environment.

import * as reg from './registry.js';

/** @typedef {import('./usbtypes.js').UsbDevice} UsbDevice */

/** The OEP vendor interface: bInterfaceClass 0xFF, bInterfaceSubClass 0x4F, bInterfaceProtocol 0x45 (core §3.3). */
export const VENDOR_CLASS = reg.USB.vendor_bulk_class;
export const VENDOR_SUBCLASS = reg.USB.vendor_bulk_subclass;
export const VENDOR_PROTOCOL = reg.USB.vendor_bulk_protocol;
/** The OEP HID collection: usage page 0xFF4F, usage 0x45 (core §3.3). */
export const HID_USAGE_PAGE = reg.USB.hid_usage_page;

/** The project's own USB VID:PID, 1209:4F45 (registry usb, core §3.3). */
export const PROJECT_VID = reg.USB.project_vid;
export const PROJECT_PID = reg.USB.project_pid;

/**
 * The project's own USB VID:PID pairs (core §3.3): the only automatic identification of an OEP probe.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const PROJECT_VID_PIDS = Object.freeze([/** @type {readonly [number, number]} */ (Object.freeze([PROJECT_VID, PROJECT_PID]))]);

/** core §3.3: the device has the project's VID:PID (PROJECT_VID_PIDS). Nothing else (iProduct, interface class values)
 * identifies an OEP probe. @param {number} vendorId @param {number} productId */
export function isProjectDevice(vendorId, productId) {
  return PROJECT_VID_PIDS.some(([v, p]) => v === vendorId && p === productId);
}

/** A device found without being named: one with the project's VID:PID (core §3.3).
 * @param {UsbDevice} device */
export function usbCandidate(device) {
  return isProjectDevice(device.vendorId, device.productId);
}

/** WebUSB / WebHID chooser filters for the project's VID:PID. */
export const PROJECT_USB_FILTERS = Object.freeze(PROJECT_VID_PIDS.map(([vendorId, productId]) => Object.freeze({ vendorId, productId })));
/** WebSerial chooser filters for the project's VID:PID (a probe's USB CDC ports). */
export const PROJECT_SERIAL_FILTERS = Object.freeze(PROJECT_VID_PIDS.map(([usbVendorId, usbProductId]) => Object.freeze({ usbVendorId, usbProductId })));

/** The probe's unit id: its USB serial number (core §3.3, §7.5): how a probe named by its unit id is found (the serial
 * alone decides; after confirm, describe's unit_id must match, open.js connect `unitId`).
 * @param {{ serialNumber?: string | null }} device */
export function usbUnitId(device) {
  return device.serialNumber || null;
}

/** A unit id that names a device: an `x-` unit_id (a probe with neither a unique number nor storage, core §7.5, C-24)
 * names no unit, so no device is looked up by it - RangeError. @param {string} unitId */
export function requireUnitName(unitId) {
  if (unitId.toLowerCase().startsWith('x-')) throw new RangeError(`unit id ${unitId}: an x- unit_id names no unit (core §7.5), so no probe is found by it`);
  return unitId;
}

/**
 * @typedef {object} VendorInterface
 * @property {number} interfaceNumber
 * @property {number} alternateSetting
 * @property {number} endpointIn       endpoint number (no direction bit, as WebUSB takes it)
 * @property {number} endpointOut
 * @property {number} packetSizeOut   wMaxPacketSize of OUT (a write of a multiple of it is followed by a ZLP)
 */

/**
 * The OEP vendor interface of a configuration: class 0xFF, subclass 0x4F, protocol 0x45 with one bulk IN and one bulk
 * OUT endpoint.
 * @param {import('./usbtypes.js').UsbConfiguration | null | undefined} configuration
 * @returns {VendorInterface | null}
 */
export function findVendorInterface(configuration) {
  for (const intf of configuration?.interfaces ?? []) {
    for (const alt of intf.alternates ?? (intf.alternate ? [intf.alternate] : [])) {
      if (alt.interfaceClass !== VENDOR_CLASS || alt.interfaceSubclass !== VENDOR_SUBCLASS || alt.interfaceProtocol !== VENDOR_PROTOCOL) continue;
      const bulk = alt.endpoints.filter((e) => e.type === 'bulk');
      const input = bulk.find((e) => e.direction === 'in');
      const output = bulk.find((e) => e.direction === 'out');
      if (input && output) {
        return {
          interfaceNumber: intf.interfaceNumber,
          alternateSetting: alt.alternateSetting,
          endpointIn: input.endpointNumber,
          endpointOut: output.endpointNumber,
          packetSizeOut: output.packetSize || 64,
        };
      }
    }
  }
  return null;
}

/** Open the device and select its first configuration when none is. @param {UsbDevice} device */
export async function openDevice(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) {
    const first = device.configurations?.[0];
    await device.selectConfiguration(first ? first.configurationValue : 1);
  }
}

/**
 * The vendor bulk transport on `device` (opened and claimed here).
 * @param {UsbDevice} device
 * @param {{ readSize?: number, depth?: number }} [opts]  readSize: bytes per IN transfer; depth: IN transfers kept queued
 * @returns {Promise<import('./link.js').Transport>}
 */
export async function vendorTransport(device, { readSize = 16384, depth = 4 } = {}) {
  await openDevice(device);
  const vi = findVendorInterface(device.configuration);
  if (!vi) throw new Error('no OEP vendor interface (class 0xFF, subclass 0x4F, protocol 0x45) with a bulk IN/OUT pair on the device');
  await device.claimInterface(vi.interfaceNumber);
  if (vi.alternateSetting !== 0) await device.selectAlternateInterface(vi.interfaceNumber, vi.alternateSetting);

  let closing = false;
  let ended = false;
  /** @type {((error?: unknown) => void) | null} */
  let closed = null;
  /** @param {unknown} [error] */
  const end = (error) => {
    if (ended) return;
    ended = true;
    closed?.(closing ? undefined : error);
  };

  return {
    framing: 'length',
    kind: 'vendor',
    async write(data) {
      const r = await device.transferOut(vi.endpointOut, data);
      if (r.status !== 'ok') throw new Error(`USB bulk OUT: ${r.status}`);
      // a write whose length is a whole number of packets is ended with a zero-length packet (core §3.1)
      if (data.length && data.length % vi.packetSizeOut === 0) await device.transferOut(vi.endpointOut, new Uint8Array(0));
    },
    start(onData, onClose) {
      closed = onClose;
      // `depth` IN transfers stay queued; their results are taken in the order they were asked for
      /** @type {Promise<import('./usbtypes.js').UsbInResult>[]} */
      const queue = [];
      const submit = () => queue.push(device.transferIn(vi.endpointIn, readSize));
      (async () => {
        try {
          for (let i = 0; i < depth; i++) submit();
          while (!closing) {
            const r = /** @type {Promise<import('./usbtypes.js').UsbInResult>} */ (queue.shift());
            const result = await r;
            if (closing) break;
            if (result.status === 'stall') await device.clearHalt('in', vi.endpointIn);
            else if (result.status === 'ok' && result.data && result.data.byteLength) {
              onData(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice());
            }
            submit();
          }
          for (const p of queue) p.catch(() => {});
          end();
        } catch (e) {
          for (const p of queue) p.catch(() => {});
          end(e);
        }
      })();
    },
    async close() {
      closing = true;
      try { await device.releaseInterface(vi.interfaceNumber); } catch { /* already gone */ }
      try { await device.close(); } catch { /* already gone */ }
      end();
    },
  };
}
