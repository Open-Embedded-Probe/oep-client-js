// @ts-check
// WebHID: the probe's vendor HID interface (usage page 0xFF4F, usage 0x45 - transports §3, registry usb). Each report
// carries count(u16 LE) and then that many bytes of the length(u16) frame stream, the rest zero (transports §1). The
// report ID, when the descriptor declares one, is WebHID's business: sendReport takes it apart, an inputreport gives
// it apart.
import * as reg from '../registry.js';
import { PROJECT_USB_FILTERS } from '../usbvendor.js';

/** The OEP HID collection: usage page 0xFF4F ('O' in the vendor pages), usage 0x45 ('E'). */
export const OEP_USAGE_PAGE = reg.USB.hid_usage_page;
export const OEP_USAGE = reg.USB.hid_usage;

/**
 * The part of WebHID used here (lib.dom does not carry WebHID).
 * @typedef {{ reportSize?: number, reportCount?: number }} HidReportItem
 * @typedef {{ reportId?: number, items?: HidReportItem[] }} HidReportInfo
 * @typedef {{ usagePage?: number, usage?: number, inputReports?: HidReportInfo[], outputReports?: HidReportInfo[],
 *   children?: HidCollection[] }} HidCollection
 * @typedef {{ reportId: number, data: DataView, device?: unknown }} HidInputReportEvent
 * @typedef {object} HidDeviceLike
 * @property {number} vendorId
 * @property {number} productId
 * @property {string} [productName]
 * @property {boolean} [opened]
 * @property {HidCollection[]} collections
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {(reportId: number, data: Uint8Array) => Promise<void>} sendReport
 * @property {(type: 'inputreport', listener: (e: HidInputReportEvent) => void) => void} addEventListener
 * @property {(type: 'inputreport', listener: (e: HidInputReportEvent) => void) => void} removeEventListener
 */

/** A report's size in bytes (without its ID). @param {HidReportInfo} report */
export function reportBytes(report) {
  let bits = 0;
  for (const item of report.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  return Math.ceil(bits / 8);
}

/**
 * The OEP collection's (usage page 0xFF4F, usage 0x45) input and output reports (the largest of each, 3 bytes at least).
 * @param {HidCollection[]} collections
 * @returns {{ inputReportId: number, inputSize: number, outputReportId: number, outputSize: number } | null}
 */
export function findVendorReports(collections) {
  /** @param {HidCollection[]} list @returns {ReturnType<typeof findVendorReports>} */
  const walk = (list) => {
    for (const c of list) {
      if (c.usagePage === OEP_USAGE_PAGE && (c.usage === undefined || c.usage === OEP_USAGE)) {
        /** @param {HidReportInfo[] | undefined} reports */
        const best = (reports) => (reports ?? []).map((r) => ({ id: r.reportId ?? 0, size: reportBytes(r) }))
          .filter((r) => r.size >= 3).sort((a, b) => b.size - a.size)[0];
        const input = best(c.inputReports);
        const output = best(c.outputReports);
        if (input && output) return { inputReportId: input.id, inputSize: input.size, outputReportId: output.id, outputSize: output.size };
      }
      const inner = walk(c.children ?? []);
      if (inner) return inner;
    }
    return null;
  };
  return walk(collections);
}

/**
 * The output reports that carry `data`: count(u16) + up to reportSize - 2 bytes + zeros, each reportSize long.
 * @param {Uint8Array} data @param {number} reportSize
 */
export function packHidReports(data, reportSize) {
  const room = reportSize - 2;
  if (room < 1) throw new RangeError(`HID report of ${reportSize} bytes has no room`);
  /** @type {Uint8Array[]} */
  const out = [];
  for (let at = 0; at < data.length; at += room) {
    const part = data.subarray(at, Math.min(at + room, data.length));
    const report = new Uint8Array(reportSize);
    report[0] = part.length & 0xff;
    report[1] = part.length >> 8;
    report.set(part, 2);
    out.push(report);
  }
  return out;
}

/**
 * The frame bytes an input report carries (count clamped to the report).
 * @param {Uint8Array | DataView} report
 */
export function unpackHidReport(report) {
  const bytes = report instanceof Uint8Array ? report : new Uint8Array(report.buffer, report.byteOffset, report.byteLength);
  if (bytes.length < 2) return new Uint8Array(0);
  const n = Math.min(bytes[0] | (bytes[1] << 8), bytes.length - 2);
  return bytes.slice(2, 2 + n);
}

/** @returns {any} */
const hidApi = () => {
  const h = /** @type {any} */ (globalThis.navigator)?.hid;
  if (!h) throw new Error('WebHID is not available (a Chromium-based browser, over HTTPS or localhost)');
  return h;
};

/**
 * Ask the user for a probe's HID interface. The default chooser filter is the project's VID:PID with the OEP collection
 * (usage page 0xFF4F, usage 0x45; transports §3); a caller's `filters` offer devices the user then chooses, which connect
 * (openWebHid) probes with a confirm first and closes when no valid answer comes. WebHID may give several HIDDevice
 * objects for one USB device: the one with the OEP collection is taken.
 * @param {{ filters?: object[] }} [opts]
 * @returns {Promise<HidDeviceLike>}
 */
export async function requestHidProbe({ filters } = {}) {
  /** @type {HidDeviceLike[]} */
  const devices = await hidApi().requestDevice({
    filters: filters ?? PROJECT_USB_FILTERS.map((f) => ({ ...f, usagePage: OEP_USAGE_PAGE, usage: OEP_USAGE })),
  });
  const device = devices.find((d) => findVendorReports(d.collections));
  if (!device) throw new Error(devices.length ? 'the device has no OEP HID collection (usage page 0xFF4F, usage 0x45)' : 'no device chosen');
  return device;
}

/**
 * The HID transport on a WebHID HIDDevice (opened here).
 * @param {HidDeviceLike} device
 * @returns {Promise<import('../link.js').Transport>}
 */
export async function webHidTransport(device) {
  const r = findVendorReports(device.collections);
  if (!r) throw new Error('no OEP HID collection (usage page 0xFF4F, usage 0x45) with input and output reports');
  if (!device.opened) await device.open();
  /** @type {((e: HidInputReportEvent) => void) | null} */
  let listener = null;
  /** @type {((e: any) => void) | null} */
  let onDisconnect = null;
  /** @type {((error?: unknown) => void) | null} */
  let closed = null;
  const detach = () => {
    if (listener) device.removeEventListener('inputreport', listener);
    const hid = /** @type {any} */ (globalThis.navigator)?.hid;
    if (onDisconnect && hid) hid.removeEventListener('disconnect', onDisconnect);
    listener = onDisconnect = null;
  };
  return {
    framing: 'length',
    kind: 'hid',
    maxWrite: r.outputSize - 2,
    async write(data) {
      for (const report of packHidReports(data, r.outputSize)) await device.sendReport(r.outputReportId, report);
    },
    start(onData, onClose) {
      closed = onClose;
      listener = (e) => {
        if (e.reportId !== r.inputReportId) return;
        const bytes = unpackHidReport(e.data);
        if (bytes.length) onData(bytes);
      };
      device.addEventListener('inputreport', listener);
      const hid = /** @type {any} */ (globalThis.navigator)?.hid;
      if (hid) {
        onDisconnect = (e) => {
          if (e.device !== device) return;
          detach();
          closed?.(new Error('the HID device went away'));
          closed = null;
        };
        hid.addEventListener('disconnect', onDisconnect);
      }
    },
    async close() {
      detach();
      try { await device.close(); } catch { /* gone */ }
      closed?.();
      closed = null;
    },
  };
}
