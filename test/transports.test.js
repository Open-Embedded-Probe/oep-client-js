// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findVendorReports, packHidReports, unpackHidReport, webHidTransport } from '../src/browser/webhid.js';
import { findVendorInterface, isOepDevice, usbUnitId, vendorTransport } from '../src/usbvendor.js';

test('HID reports: count(u16) + data + zero padding, split at the report room', () => {
  const data = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
  const reports = packHidReports(data, 8);   // room 6
  assert.equal(reports.length, 2);
  assert.deepEqual([...reports[0]], [6, 0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...reports[1]], [4, 0, 7, 8, 9, 10, 0, 0]);
  assert.deepEqual([...unpackHidReport(reports[0])], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...unpackHidReport(new DataView(reports[1].buffer))], [7, 8, 9, 10]);
  // a count beyond the report is clamped; a report too short carries nothing
  assert.deepEqual([...unpackHidReport(Uint8Array.from([0xff, 0, 1, 2]))], [1, 2]);
  assert.equal(unpackHidReport(Uint8Array.from([1])).length, 0);
  const big = packHidReports(new Uint8Array(300).fill(9), 511);
  assert.equal(big.length, 1);
  assert.equal(big[0][0] | (big[0][1] << 8), 300);
  assert.equal(big[0].length, 511);
  assert.throws(() => packHidReports(data, 2), RangeError);
});

/** @param {number} id @param {number} bytes */
const report = (id, bytes) => ({ reportId: id, items: [{ reportSize: 8, reportCount: bytes }] });

test('HID: the vendor usage page collection (nested), its report sizes and ID', () => {
  const collections = [
    { usagePage: 0x01, usage: 6, inputReports: [report(1, 8)], outputReports: [report(1, 1)] },
    { usagePage: 0xff00, usage: 1, inputReports: [report(2, 64)], outputReports: [report(2, 64)] },   // another vendor page
    { usagePage: 0x0c, children: [{ usagePage: 0xff4f, usage: 0x45, inputReports: [report(3, 511)], outputReports: [report(3, 511)] }] },
  ];
  assert.deepEqual(findVendorReports(collections), { inputReportId: 3, inputSize: 511, outputReportId: 3, outputSize: 511 });
  assert.equal(findVendorReports([{ usagePage: 0xff4f, usage: 0x45, inputReports: [report(0, 64)] }]), null);
  assert.equal(findVendorReports(collections.slice(0, 2)), null);
});

test('HID transport: writes as reports with their ID, input reports unpacked', async () => {
  /** @type {[number, Uint8Array][]} */
  const sent = [];
  /** @type {{ fn: ((e: any) => void) | null }} */
  const listener = { fn: null };
  const device = {
    vendorId: 0x303a, productId: 2, productName: 'OEP probe (ESP32-P4)', opened: false,
    collections: [{ usagePage: 0xff4f, usage: 0x45, inputReports: [report(7, 16)], outputReports: [report(7, 16)] }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    /** @param {number} id @param {Uint8Array} data */
    async sendReport(id, data) { sent.push([id, data]); },
    /** @param {string} _t @param {(e: any) => void} l */
    addEventListener(_t, l) { listener.fn = l; },
    /** @param {string} _t @param {(e: any) => void} l */
    removeEventListener(_t, l) { if (listener.fn === l) listener.fn = null; },
  };
  const t = await webHidTransport(device);
  assert.equal(device.opened, true);
  assert.equal(t.framing, 'length');
  assert.equal(t.maxWrite, 14);
  /** @type {Uint8Array[]} */
  const got = [];
  await t.start((c) => got.push(c), () => {});
  await t.write(Uint8Array.from({ length: 20 }, (_, i) => i));
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], 7);
  assert.equal(sent[0][1].length, 16);
  assert.deepEqual([...sent[1][1]], [6, 0, 14, 15, 16, 17, 18, 19, 0, 0, 0, 0, 0, 0, 0, 0]);
  const fire = /** @type {(e: any) => void} */ (listener.fn);
  fire({ reportId: 7, data: new DataView(Uint8Array.from([3, 0, 0xaa, 0xbb, 0xcc, 0, 0]).buffer) });
  fire({ reportId: 9, data: new DataView(Uint8Array.from([1, 0, 0x11]).buffer) });   // another report: not ours
  fire({ reportId: 7, data: new DataView(Uint8Array.from([0, 0, 0, 0]).buffer) });   // empty
  assert.deepEqual(got.map((g) => [...g]), [[0xaa, 0xbb, 0xcc]]);
  await t.close();
  assert.equal(listener.fn, null);
  assert.equal(device.opened, false);
});

/** @param {number} n @param {'in' | 'out'} dir @param {'bulk' | 'interrupt'} [type] */
const ep = (n, dir, type = 'bulk') => ({ endpointNumber: n, direction: dir, type, packetSize: 512 });

function mockUsbDevice() {
  const configuration = {
    configurationValue: 1,
    interfaces: [
      { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0x02, interfaceSubclass: 2, interfaceProtocol: 0, endpoints: [ep(3, 'in', 'interrupt')] }] },
      { interfaceNumber: 1, alternates: [{ alternateSetting: 0, interfaceClass: 0x0a, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [ep(4, 'in'), ep(4, 'out')] }] },
      { interfaceNumber: 2, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [ep(2, 'out'), ep(2, 'in')] }] },   // another vendor interface
      { interfaceNumber: 4, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x4f, interfaceProtocol: 0x45, endpoints: [ep(1, 'out'), ep(1, 'in')] }] },
      { interfaceNumber: 3, alternates: [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceProtocol: 2, endpoints: [] }] },
    ],
  };
  /** @type {string[]} */
  const log = [];
  /** @type {Uint8Array[]} */
  const incoming = [];
  /** @type {((v: any) => void)[]} */
  const waiting = [];
  let closed = false;
  const device = {
    vendorId: 0x303a, productId: 0x0002, productName: 'OEP probe (ESP32-P4)', serialNumber: '30eda0e31108',
    opened: false,
    /** @type {typeof configuration | null} */ configuration: null,
    configurations: [configuration],
    log,
    /** @param {Uint8Array} bytes */
    feed(bytes) {
      const w = waiting.shift();
      if (w) w({ status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
      else incoming.push(bytes);
    },
    async open() { this.opened = true; log.push('open'); },
    async close() {
      this.opened = false; closed = true; log.push('close');
      for (const w of waiting.splice(0)) w(Promise.reject(new Error('closed')));
    },
    /** @param {number} v */
    async selectConfiguration(v) { log.push(`config ${v}`); this.configuration = configuration; },
    /** @param {number} n */
    async claimInterface(n) { log.push(`claim ${n}`); },
    /** @param {number} n */
    async releaseInterface(n) { log.push(`release ${n}`); },
    async selectAlternateInterface() {},
    async clearHalt() {},
    async controlTransferIn() { return { status: 'stall' }; },
    async controlTransferOut() { return { status: 'stall' }; },
    /** @param {number} e @param {number} len */
    transferIn(e, len) {
      assert.equal(e, 1);
      assert.ok(len > 0);
      if (closed) return Promise.reject(new Error('closed'));
      const b = incoming.shift();
      if (b) return Promise.resolve({ status: 'ok', data: new DataView(b.buffer, b.byteOffset, b.byteLength) });
      return new Promise((resolve) => waiting.push(resolve));
    },
    /** @param {number} e @param {Uint8Array} data */
    async transferOut(e, data) { log.push(`out ${e} ${data.length}`); return { status: 'ok', bytesWritten: data.length }; },
  };
  return device;
}

test('USB vendor interface: chosen by class 0xFF, subclass 0x4F, protocol 0x45 - not the first bulk or vendor pair', () => {
  const d = mockUsbDevice();
  assert.deepEqual(findVendorInterface(d.configurations[0]), { interfaceNumber: 4, alternateSetting: 0, endpointIn: 1, endpointOut: 1, packetSizeOut: 512 });
  assert.equal(findVendorInterface({ configurationValue: 1, interfaces: d.configurations[0].interfaces.slice(0, 3) }), null);
  assert.equal(findVendorInterface(null), null);
  assert.equal(isOepDevice(0x303a, 2, 'OEP probe (ESP32-P4)'), true);
  assert.equal(isOepDevice(0x303a, 0x0002, null), false);                 // the VID:PID tells nothing (core §3.3)
  assert.equal(isOepDevice(0x303a, 0x1001, 'USB JTAG/serial debug unit'), false);
  assert.equal(usbUnitId(d), '30eda0e31108');
});

test('USB vendor transport: claim, reads in order, a ZLP after a whole number of packets, close', async () => {
  const d = mockUsbDevice();
  const t = await vendorTransport(d, { depth: 3, readSize: 1024 });
  assert.deepEqual(d.log, ['open', 'config 1', 'claim 4']);
  assert.equal(t.framing, 'length');
  assert.equal(t.kind, 'vendor');
  /** @type {number[]} */
  const got = [];
  /** @type {unknown[]} */
  const closes = [];
  await t.start((c) => got.push(...c), (e) => closes.push(e));
  d.feed(Uint8Array.from([1, 2]));
  d.feed(Uint8Array.from([3]));
  d.feed(Uint8Array.from([4, 5]));
  d.feed(Uint8Array.from([6]));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6]);
  await t.write(new Uint8Array(100));
  await t.write(new Uint8Array(1024));
  assert.deepEqual(d.log.slice(3), ['out 1 100', 'out 1 1024', 'out 1 0']);
  await t.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(closes, [undefined]);
  assert.ok(d.log.includes('release 4') && d.log.includes('close'));
});

test('USB vendor transport: a device without the vendor interface is refused', async () => {
  const d = mockUsbDevice();
  d.configurations[0].interfaces.splice(3, 1);
  await assert.rejects(vendorTransport(d), /OEP vendor interface/);
});
