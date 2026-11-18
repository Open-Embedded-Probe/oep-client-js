// @ts-check
// WebHID: the probe's vendor HID interface (usage page 0xFF4F, usage 0x45 - transports §3, registry usb). Each report
// carries count(u16 LE), first(u16 LE: where the first frame starting in the report begins, hid_no_frame_start when
// none) and then count bytes of the length(u16) frame stream, the rest zero (transports §1). An OS HID driver drops
// reports read too late: a reader whose own reading puts the next frame's start elsewhere than first has lost one,
// drops the frame begun and reads on from first. The report ID, when the descriptor declares one, is WebHID's
// business: sendReport takes it apart, an inputreport gives it apart.
import * as reg from '../registry.js';
import { PROJECT_USB_FILTERS } from '../usbvendor.js';

/** The OEP HID collection: usage page 0xFF4F ('O' in the vendor pages), usage 0x45 ('E'). */
export const OEP_USAGE_PAGE = reg.USB.hid_usage_page;
export const OEP_USAGE = reg.USB.hid_usage;

/** count(u16) and first(u16) before a report's stream bytes (after the report ID, if any; transports §1). */
export const HID_HEADER = reg.USB.hid_report_header_bytes;
/** first when no frame starts in the report (transports §1). */
export const HID_NO_FRAME_START = reg.USB.hid_no_frame_start;

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
 * The OEP collection's (usage page 0xFF4F, usage 0x45) input and output reports (the largest of each, with room for a
 * stream byte after count and first).
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
          .filter((r) => r.size > HID_HEADER).sort((a, b) => b.size - a.size)[0];
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

/** Where the frames of a length(u16) stream start: the frame begun so far (`partial`, empty at a frame's start). */
export class FrameTrack {
  constructor() {
    /** @type {number[]} */
    this.partial = [];
  }

  /** The position in `data` where the next frame starts, or HID_NO_FRAME_START when the frame begun runs past it.
   * @param {Uint8Array} data */
  nextStart(data) {
    const p = this.partial;
    if (!p.length) return data.length ? 0 : HID_NO_FRAME_START;
    let need;
    if (p.length === 1) {
      if (!data.length) return HID_NO_FRAME_START;
      need = 2 + (p[0] | (data[0] << 8)) - 1;
    } else {
      need = 2 + (p[0] | (p[1] << 8)) - p.length;
    }
    return need < data.length ? need : HID_NO_FRAME_START;
  }

  /** `data` read on: the frames it completes, each with its length. @param {Uint8Array} data @returns {Uint8Array[]} */
  feed(data) {
    /** @type {Uint8Array[]} */
    const done = [];
    for (const b of data) this.partial.push(b);
    while (this.partial.length >= 2) {
      const end = 2 + (this.partial[0] | (this.partial[1] << 8));
      if (this.partial.length < end) break;
      done.push(Uint8Array.from(this.partial.slice(0, end)));
      this.partial.splice(0, end);
    }
    return done;
  }
}

/**
 * Writes the length(u16) frame stream as output reports (transports §1): count(u16), first(u16), up to reportSize - 4
 * stream bytes, zeros - each reportSize long. first follows the frames written so far, across calls.
 */
export class HidReportWriter {
  /** @param {number} reportSize the report's length without its ID */
  constructor(reportSize) {
    if (reportSize - HID_HEADER < 1) throw new RangeError(`HID report of ${reportSize} bytes has no room`);
    this.reportSize = reportSize;
    this.track = new FrameTrack();
  }

  /** The reports that carry `data` (the stream's next bytes). @param {Uint8Array} data */
  pack(data) {
    const room = this.reportSize - HID_HEADER;
    /** @type {Uint8Array[]} */
    const out = [];
    for (let at = 0; at < data.length; at += room) {
      const part = data.subarray(at, Math.min(at + room, data.length));
      const first = this.track.nextStart(part);
      this.track.feed(part);
      const report = new Uint8Array(this.reportSize);
      report[0] = part.length & 0xff;
      report[1] = part.length >> 8;
      report[2] = first & 0xff;
      report[3] = first >> 8;
      report.set(part, HID_HEADER);
      out.push(report);
    }
    return out;
  }
}

/**
 * Reads input reports into whole frames (transports §1): a report whose first disagrees with this reading had one
 * missing before it - the frame begun is dropped and the reading goes on from first; a report with a count over its
 * room or a first not below count is dropped and the stream is broken; just made or broken, the reading starts at the
 * next report with a first. What `read` gives is whole frames only (each with its length), so the link never loses a
 * boundary on HID: the frames lost show as an answer that does not come or a push's seq (core §10.2). `losses`:
 * reports found missing or broken.
 */
export class HidReportReader {
  constructor() {
    this.track = new FrameTrack();
    this.synced = false;
    this.losses = 0;
  }

  /** One input report (without its ID). @param {Uint8Array | DataView} report @returns {Uint8Array[]} */
  read(report) {
    const bytes = report instanceof Uint8Array ? report : new Uint8Array(report.buffer, report.byteOffset, report.byteLength);
    if (bytes.length < HID_HEADER) return [];
    const count = bytes[0] | (bytes[1] << 8);
    const first = bytes[2] | (bytes[3] << 8);
    if (count > bytes.length - HID_HEADER || (first !== HID_NO_FRAME_START && first >= count)) {
      this.broken();                         // rule 7: dropped, the stream broken till the next first
      return [];
    }
    if (!count) return [];
    let data = bytes.subarray(HID_HEADER, HID_HEADER + count);
    if (this.synced && this.track.nextStart(data) !== first) this.broken();   // rule 6: a report missing before this one
    if (!this.synced) {
      if (first === HID_NO_FRAME_START) return [];
      data = data.subarray(first);
      this.synced = true;
    }
    return this.track.feed(data);
  }

  broken() {
    this.track = new FrameTrack();
    this.losses++;
    this.synced = false;
  }
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
 * The HID transport on a WebHID HIDDevice (opened here). It hands the link whole frames only (`wholeFrames`): a
 * report found missing drops the frame begun here, so a resync has nothing to read past (transports §5).
 * @param {HidDeviceLike} device
 * @returns {Promise<import('../link.js').Transport & { reader: HidReportReader }>}
 */
export async function webHidTransport(device) {
  const r = findVendorReports(device.collections);
  if (!r) throw new Error('no OEP HID collection (usage page 0xFF4F, usage 0x45) with input and output reports');
  if (!device.opened) await device.open();
  const writer = new HidReportWriter(r.outputSize);
  const reader = new HidReportReader();     // just opened: reads from the first report with a first
  /** @type {Promise<void>} the writes in order: each report's first follows the ones before */
  let writing = Promise.resolve();
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
    wholeFrames: true,
    reader,
    maxWrite: r.outputSize - HID_HEADER,
    write(data) {
      const reports = writer.pack(data);
      const run = writing.then(async () => {
        for (const report of reports) await device.sendReport(r.outputReportId, report);
      });
      writing = run.catch(() => {});
      return run;
    },
    start(onData, onClose) {
      closed = onClose;
      listener = (e) => {
        if (e.reportId !== r.inputReportId) return;
        for (const frame of reader.read(e.data)) onData(frame);
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
