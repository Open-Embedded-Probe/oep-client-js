// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findVendorReports, packHidReports, unpackHidReport, webHidTransport } from '../src/browser/webhid.js';
import { PROJECT_SERIAL_FILTERS, PROJECT_USB_FILTERS, PROJECT_VID_PIDS, findVendorInterface, isProjectDevice, usbCandidate, usbUnitId, vendorTransport } from '../src/usbvendor.js';
import * as usbvendor from '../src/usbvendor.js';
import { findSerialProbes } from '../src/node/serial.js';
import { SeveralProbesError, chooseProbe, describeProbe, findProbes } from '../src/node/usb.js';
import { openUsb } from '../src/node/open.js';
import { NotOepProbe } from '../src/errors.js';
import { requestUsbProbe } from '../src/browser/webusb.js';
import { requestHidProbe } from '../src/browser/webhid.js';
import { requestSerialPort } from '../src/browser/webserial.js';

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
    vendorId: 0x1209, productId: 0x4f45, productName: 'OEP probe (ESP32-P4)', opened: false,
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
    vendorId: 0x1209, productId: 0x4f45, productName: 'OEP probe (ESP32-P4)', serialNumber: '30eda0e31108',
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
  // transports §3: only the project's VID:PID identifies a probe - not iProduct, not the interface's class values
  assert.deepEqual(PROJECT_VID_PIDS, [[0x1209, 0x4f45]]);
  assert.deepEqual(PROJECT_USB_FILTERS, [{ vendorId: 0x1209, productId: 0x4f45 }]);
  assert.deepEqual(PROJECT_SERIAL_FILTERS, [{ usbVendorId: 0x1209, usbProductId: 0x4f45 }]);
  assert.equal(isProjectDevice(0x1209, 0x4f45), true);
  assert.equal(isProjectDevice(0x303a, 0x0002), false);
  assert.equal(usbCandidate(d), true);
  assert.equal(usbCandidate({ ...d, vendorId: 0x303a, productId: 0x0002 }), false);   // same name and interfaces, another VID:PID
  assert.equal('temporaryClue' in usbvendor, false);
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

test('findSerialProbes: the serial ports on the project\'s VID:PID, with their unit id (a probe with CDC only)', async () => {
  const ports = [
    { path: '/dev/ttyACM0', vendorId: '1209', productId: '4f45', serialNumber: 'e66164084b2a1234' },
    { path: '/dev/ttyACM1', vendorId: '1209', productId: '4F45' },                       // no serial: no unit id
    { path: '/dev/ttyUSB0', vendorId: '0403', productId: '6001', serialNumber: 'A10K' },   // a UART bridge: chosen by the user
    { path: '/dev/ttyACM2', vendorId: '303a', productId: '1001', serialNumber: 'aa' },     // a built-in USB serial: the same
    { path: '/dev/ttyS0' },
  ];
  assert.deepEqual(await findSerialProbes(ports), [{ path: '/dev/ttyACM0', unitId: 'e66164084b2a1234' }, { path: '/dev/ttyACM1', unitId: null }]);
});

test('the choosers: WebUSB by the project\'s VID:PID, WebHID by it with the OEP collection, WebSerial unfiltered', async () => {
  /** @type {any[]} */ const asked = [];
  const nav = /** @type {any} */ (globalThis.navigator);
  const saved = { usb: nav.usb, hid: nav.hid, serial: nav.serial };
  const collections = [{ usagePage: 0xff4f, usage: 0x45, inputReports: [{ reportId: 1, items: [{ reportSize: 8, reportCount: 64 }] }], outputReports: [{ reportId: 1, items: [{ reportSize: 8, reportCount: 64 }] }] }];
  Object.defineProperty(nav, 'usb', { configurable: true, value: { async requestDevice(/** @type {any} */ o) { asked.push(['usb', o]); return {}; } } });
  Object.defineProperty(nav, 'hid', { configurable: true, value: { async requestDevice(/** @type {any} */ o) { asked.push(['hid', o]); return [{ collections }]; } } });
  Object.defineProperty(nav, 'serial', { configurable: true, value: { async requestPort(/** @type {any} */ o) { asked.push(['serial', o]); return {}; } } });
  try {
    await requestUsbProbe();
    await requestHidProbe();
    await requestSerialPort();
    await requestSerialPort({ filters: [...PROJECT_SERIAL_FILTERS] });
  } finally {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(nav, k, { configurable: true, value: v });
  }
  assert.deepEqual(asked, [
    ['usb', { filters: [{ vendorId: 0x1209, productId: 0x4f45 }] }],
    ['hid', { filters: [{ vendorId: 0x1209, productId: 0x4f45, usagePage: 0xff4f, usage: 0x45 }] }],
    ['serial', {}],                                               // bridges and built-in USB serials stay selectable
    ['serial', { filters: [{ usbVendorId: 0x1209, usbProductId: 0x4f45 }] }],
  ]);
});

/** A probe as findProbes lists it. @param {string | null} unitId @param {string[]} ways @param {string[]} [ports] @param {any} [device] */
const probe = (unitId, ways, ports = [], device = null) => ({ unitId, ways, ports, device });

test('findProbes: every device on the project\'s VID:PID once, whatever its ways in (vendor, HID, CDC)', async () => {
  const all = mockUsbDevice();                                              // CDC + vendor (+ DFU)
  const hidOnly = { ...mockUsbDevice(), serialNumber: 'aa01', configurations: [{ configurationValue: 1, interfaces: [
    { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 3, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [] }] }] }] };
  const other = { ...mockUsbDevice(), vendorId: 0x303a, productId: 0x1001, serialNumber: 'zz' };   // not ours
  const ports = [
    { path: '/dev/ttyACM0', vendorId: '1209', productId: '4f45', serialNumber: '30EDA0E31108' },    // the same device as `all`
    { path: '/dev/ttyACM1', vendorId: '1209', productId: '4f45', serialNumber: '9489dd2ae0953650' }, // CDC only
    { path: '/dev/ttyUSB0', vendorId: '0403', productId: '6001', serialNumber: 'A10K' },
  ];
  const got = await findProbes({ devices: /** @type {any[]} */ ([all, hidOnly, other]), ports });
  assert.deepEqual(got.map((p) => [p.unitId, p.ways, p.ports]), [
    ['30eda0e31108', ['vendor', 'cdc'], ['/dev/ttyACM0']],
    ['aa01', ['hid'], []],
    ['9489dd2ae0953650', ['cdc'], ['/dev/ttyACM1']],
  ]);
  assert.equal(got[0].device, all);
  assert.equal(got[2].device, null);
  assert.equal(describeProbe(got[0]), '30eda0e31108: vendor, cdc /dev/ttyACM0');
  assert.equal(describeProbe(probe(null, ['vendor'])), 'no USB serial: vendor');
  assert.deepEqual(await findProbes({ devices: [], ports: [] }), []);
});

test('chooseProbe: none -> null, one (vendor only, CDC only, all three) -> it, several -> SeveralProbesError', () => {
  assert.equal(chooseProbe([]), null);
  for (const one of [probe('a1', ['vendor']), probe('a2', ['cdc'], ['/dev/ttyACM2']), probe('a3', ['vendor', 'hid', 'cdc'], ['/dev/ttyACM3'])]) {
    assert.equal(chooseProbe([one]), one);
  }
  const several = [probe('30eda0e343c6', ['vendor', 'hid', 'cdc'], ['/dev/ttyACM0']), probe('9489dd2ae0953650', ['cdc'], ['/dev/ttyACM1']),
    probe('a1', ['vendor']), probe('a2', ['hid'])];
  assert.throws(() => chooseProbe(several), (/** @type {any} */ e) => {
    assert.ok(e instanceof SeveralProbesError);
    assert.equal(e.probes, several);
    assert.equal(e.message, '4 probes on 1209:4f45 (30eda0e343c6: vendor, hid, cdc /dev/ttyACM0; 9489dd2ae0953650: cdc /dev/ttyACM1; '
      + 'a1: vendor; a2: hid); not choosing one: name one with openUsb({ unitId }) or openSerial({ path })');
    return true;
  });
});

test('openUsb() with nothing given: several probes -> nothing opened, one -> its vendor bulk, else its CDC port', async () => {
  const a = mockUsbDevice();
  const b = mockUsbDevice();
  await assert.rejects(openUsb({ probes: [probe('30eda0e31108', ['vendor', 'cdc'], ['/dev/ttyACM0'], a), probe('9489dd2ae0953650', ['cdc'], ['/dev/ttyACM1'])] }),
    /^SeveralProbesError: 2 probes on 1209:4f45 \(30eda0e31108: vendor, cdc \/dev\/ttyACM0; 9489dd2ae0953650: cdc \/dev\/ttyACM1\)/);
  assert.deepEqual(a.log, []);                                              // not even opened
  // one probe, vendor + CDC: its vendor bulk (a silent device: confirm only, then NotOepProbe)
  await assert.rejects(openUsb({ timeoutMs: 100, probes: [probe('30eda0e31108', ['vendor', 'cdc'], ['/dev/ttyACM0'], b)] }), NotOepProbe);
  assert.ok(b.log.includes('open') && b.log.includes('claim 4'));
  // one probe, CDC only: its serial port (openSerial; here without the serialport package, its error)
  await assert.rejects(openUsb({ probes: [probe('9489dd2ae0953650', ['cdc'], ['/dev/ttyACM1'])] }), /serialport|ttyACM1/);
  await assert.rejects(openUsb({ probes: [probe('9489dd2ae0953650', ['cdc'], ['/dev/ttyACM1', '/dev/ttyACM2'])] }),
    /the probe on 1209:4f45 \(9489dd2ae0953650: cdc \/dev\/ttyACM1 \/dev\/ttyACM2\) has 2 serial ports: name one/);
  await assert.rejects(openUsb({ probes: [probe('aa01', ['hid'])] }), /has no way in this host opens/);
  // none: the USB error (no device; here without the usb package, its error)
  await assert.rejects(openUsb({ probes: [] }), /optional package "usb"|no USB OEP probe/);
});
