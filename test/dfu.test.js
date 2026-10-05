// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DFU_STATE, DFU_STATUS, DfuClient, DfuError, dfuUpdate, openDfu, parseConfigDescriptor } from '../src/dfu.js';
import { fetchFirmware, parseFirmwareManifest, pickFirmware, sha256, verifyFirmware } from '../src/firmware.js';

const S = DFU_STATE;

/**
 * A DFU device in the shape of EspUsbDeviceDfu (TinyUSB): DNLOAD puts it in DNLOAD-SYNC; GETSTATUS there is busy for
 * `busy` polls, then runs `onBlock` (a status) and goes DNLOAD-IDLE or ERROR. The zero-length DNLOAD goes
 * MANIFEST-SYNC; GETSTATUS then says MANIFEST (poll 250), the next runs `onManifest` and says MANIFEST-WAIT-RESET or
 * ERROR.
 * @param {{ busy?: number, onBlock?: (block: number, data: Uint8Array) => number, onManifest?: () => number,
 *   initial?: number, transferSize?: number }} [script]
 */
function mockDfu({ busy = 0, onBlock = () => 0, onManifest = () => 0, initial = S.dfuIDLE, transferSize = 64 } = {}) {
  let state = initial;
  let status = initial === S.dfuERROR ? DFU_STATUS.errWRITE : 0;
  let busyLeft = 0;
  /** @type {{ block: number, data: Uint8Array } | null} */
  let pending = null;
  /** @type {string[]} */
  const log = [];
  /** @type {Uint8Array[]} */
  const written = [];
  const desc = Uint8Array.from([
    9, 2, 0, 0, 2, 1, 0, 0x80, 50,            // configuration (wTotalLength patched below)
    9, 4, 0, 0, 0, 3, 0, 0, 0,                // interface 0: HID
    9, 0x21, 0x11, 0x01, 0, 1, 0x22, 0x40, 0, // HID descriptor (type 0x21 too: not DFU's)
    9, 4, 1, 0, 0, 0xfe, 1, 2, 4,             // interface 1: DFU mode
    9, 0x21, 0x01, 0xe8, 0x03, transferSize & 0xff, transferSize >> 8, 0x10, 0x01,   // canDnload, 1000 ms, wTransferSize
  ]);
  desc[2] = desc.length;
  /** @param {number} s @param {number} poll */
  const statusBytes = (s, poll) => new DataView(Uint8Array.from([status, poll & 0xff, poll >> 8, 0, s, 0]).buffer);
  const device = {
    vendorId: 0x1209, productId: 0x4f45, productName: 'OEP probe (ESP32-P4)', serialNumber: 'aa', opened: false,
    /** @type {any} */ configuration: null,
    configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 3, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [] }] },
      { interfaceNumber: 1, alternates: [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: 'OEP probe firmware', endpoints: [] }] },
    ] }],
    log, written,
    get state() { return state; },
    async open() { this.opened = true; },
    async close() { this.opened = false; log.push('close'); },
    async selectConfiguration() { this.configuration = this.configurations[0]; },
    /** @param {number} n */ async claimInterface(n) { log.push(`claim ${n}`); },
    /** @param {number} n */ async releaseInterface(n) { log.push(`release ${n}`); },
    async selectAlternateInterface() {},
    async transferIn() { return { status: 'stall' }; },
    async transferOut() { return { status: 'stall' }; },
    async clearHalt() {},
    /** @param {import('../src/usbtypes.js').UsbControlSetup} setup @param {number} length */
    async controlTransferIn(setup, length) {
      if (setup.requestType === 'standard' && setup.request === 6) {
        assert.equal(setup.value, 0x0200);
        return { status: 'ok', data: new DataView(desc.buffer, 0, Math.min(length, desc.length)) };
      }
      assert.equal(setup.requestType, 'class');
      assert.equal(setup.index, 1);
      if (setup.request === 5) return { status: 'ok', data: new DataView(Uint8Array.of(state).buffer) };
      assert.equal(setup.request, 3);
      log.push(`GETSTATUS ${state}`);
      if (state === S.dfuDNLOAD_SYNC || state === S.dfuDNBUSY) {
        if (busyLeft > 0) { busyLeft--; state = S.dfuDNBUSY; return { status: 'ok', data: statusBytes(state, 5) }; }
        const p = /** @type {{ block: number, data: Uint8Array }} */ (pending);
        status = onBlock(p.block, p.data);
        if (status === 0) written.push(p.data.slice());
        state = status ? S.dfuERROR : S.dfuDNLOAD_IDLE;
        return { status: 'ok', data: statusBytes(state, 1) };
      }
      if (state === S.dfuMANIFEST_SYNC) { state = S.dfuMANIFEST; return { status: 'ok', data: statusBytes(state, 250) }; }
      if (state === S.dfuMANIFEST) {
        status = onManifest();
        state = status ? S.dfuERROR : S.dfuMANIFEST_WAIT_RESET;
        return { status: 'ok', data: statusBytes(state, 0) };
      }
      return { status: 'ok', data: statusBytes(state, 0) };
    },
    /** @param {import('../src/usbtypes.js').UsbControlSetup} setup @param {Uint8Array} [data] */
    async controlTransferOut(setup, data = new Uint8Array(0)) {
      assert.equal(setup.requestType, 'class');
      assert.equal(setup.recipient, 'interface');
      if (setup.request === 4) { log.push('CLRSTATUS'); if (state === S.dfuERROR) { state = S.dfuIDLE; status = 0; } return { status: 'ok' }; }
      if (setup.request === 6) { log.push('ABORT'); if (state !== S.dfuERROR) state = S.dfuIDLE; return { status: 'ok' }; }
      assert.equal(setup.request, 1);
      log.push(`DNLOAD ${setup.value} ${data.length}`);
      if (state !== S.dfuIDLE && state !== S.dfuDNLOAD_IDLE) return { status: 'stall' };
      if (data.length > transferSize) return { status: 'stall' };
      if (!data.length) { state = S.dfuMANIFEST_SYNC; return { status: 'ok' }; }
      pending = { block: setup.value, data };
      busyLeft = busy;
      state = S.dfuDNLOAD_SYNC;
      return { status: 'ok', bytesWritten: data.length };
    },
  };
  return device;
}

const image = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) & 0xff);

test('DFU: the functional descriptor from the configuration descriptor (not the HID one)', () => {
  const d = mockDfu({ transferSize: 1024 });
  return openDfu(d).then(async (dfu) => {
    assert.equal(dfu.interfaceNumber, 1);
    assert.equal(dfu.transferSize, 1024);
    assert.equal(dfu.attributes, 0x01);
    assert.equal(dfu.manifestationTolerant, false);
    assert.deepEqual(dfu.functional, { attributes: 1, detachTimeout: 1000, transferSize: 1024, bcdDFU: 0x0110 });
    assert.equal(dfu.name, 'OEP probe firmware');
    assert.ok(d.log.includes('claim 1'));
    await dfu.close();
    const parsed = parseConfigDescriptor(Uint8Array.from([9, 4, 0, 0, 0, 0xfe, 1, 2, 0, 7, 0x21, 0x05, 0, 0, 0, 2]));
    assert.deepEqual(parsed[0].dfu, { attributes: 5, detachTimeout: 0, transferSize: 512, bcdDFU: 0x0100 });
  });
});

test('DFU: a download with GETSTATUS polling honouring bwPollTimeout, the zero-length DNLOAD, the manifestation', async () => {
  const d = mockDfu({ busy: 2 });
  /** @type {number[]} */
  const sleeps = [];
  /** @type {any[]} */
  const progress = [];
  const dfu = await openDfu(d, { sleep: async (ms) => { sleeps.push(ms); } });
  const r = await dfu.download(image, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(r, { blocks: 4, bytes: 200, state: S.dfuMANIFEST_WAIT_RESET, confirmed: true });
  // 4 blocks of 64, 64, 64, 8; every block busy twice (bwPollTimeout 5), the manifestation once (250)
  assert.deepEqual(d.written.map((w) => w.length), [64, 64, 64, 8]);
  const joined = new Uint8Array(200);
  let at = 0;
  for (const w of d.written) { joined.set(w, at); at += w.length; }
  assert.deepEqual(joined, image);
  assert.deepEqual(sleeps, [5, 5, 5, 5, 5, 5, 5, 5, 250]);
  assert.deepEqual(d.log.filter((l) => l.startsWith('DNLOAD')), ['DNLOAD 0 64', 'DNLOAD 1 64', 'DNLOAD 2 64', 'DNLOAD 3 8', 'DNLOAD 4 0']);
  assert.deepEqual(progress.map((p) => [p.phase, p.written]), [['download', 64], ['download', 128], ['download', 192], ['download', 200], ['manifest', 200]]);
});

test('DFU: errVERIFY at the manifestation, and CLRSTATUS back to idle', async () => {
  const d = mockDfu({ onManifest: () => DFU_STATUS.errVERIFY });
  const dfu = new DfuClient(d, { interfaceNumber: 1, transferSize: 64, sleep: async () => {} });
  await assert.rejects(dfu.download(image), (e) => {
    assert.ok(e instanceof DfuError);
    assert.equal(e.status, DFU_STATUS.errVERIFY);
    assert.equal(e.statusName, 'errVERIFY');
    return true;
  });
  assert.equal(d.log.at(-1), 'CLRSTATUS');
  assert.equal(d.state, S.dfuIDLE);
});

test('DFU: errWRITE on the first block (not an app image)', async () => {
  const d = mockDfu({ onBlock: (block) => (block === 0 ? DFU_STATUS.errWRITE : 0) });
  const dfu = new DfuClient(d, { interfaceNumber: 1, transferSize: 64, sleep: async () => {} });
  await assert.rejects(dfu.download(image), (e) => e instanceof DfuError && e.status === DFU_STATUS.errWRITE && e.block === 0 && /errWRITE/.test(e.message));
  assert.deepEqual(d.log.filter((l) => l.startsWith('DNLOAD')), ['DNLOAD 0 64']);
  assert.ok(d.log.includes('CLRSTATUS'));
  assert.equal(d.state, S.dfuIDLE);
  assert.equal(d.written.length, 0);
});

test('DFU: a device left in dfuERROR / mid-download is brought to idle first; a stalled DNLOAD says why', async () => {
  const d = mockDfu({ initial: S.dfuERROR });
  const dfu = new DfuClient(d, { interfaceNumber: 1, transferSize: 64, sleep: async () => {} });
  await dfu.download(image);
  assert.equal(d.log.indexOf('CLRSTATUS'), 1);
  const d2 = mockDfu({ initial: S.dfuDNLOAD_IDLE });
  await new DfuClient(d2, { interfaceNumber: 1, transferSize: 64, sleep: async () => {} }).download(image);
  assert.equal(d2.log[1], 'ABORT');
  const d3 = mockDfu({ transferSize: 32 });   // a block larger than the device takes: stalled
  await assert.rejects(new DfuClient(d3, { interfaceNumber: 1, transferSize: 64, sleep: async () => {} }).download(image), /DNLOAD block 0: stall/);
  // dfuUpdate: open, download, close
  const d4 = mockDfu();
  const r = await dfuUpdate(d4, image);
  assert.equal(r.confirmed, true);
  assert.ok(d4.log.includes('release 1') && d4.log.includes('close'));
});

const manifest = {
  schema: 1, library: 'OepProbe', version: '1.2.0',
  firmware: [
    { example: '01.Basics/Hello', profile: 'esp32p4', file: 'Hello-esp32p4-1.2.0.bin', kind: 'app', model: 'esp32p4', chip: 'esp32p4', sha256: '0'.repeat(64) },
    { example: 'Firmware/OepProbe', profile: 'esp32p4', file: 'OepProbe-esp32p4-1.2.0.merged.bin', kind: 'merged', model: 'esp32p4', chip: 'esp32p4', flash_offset: 0, sha256: '1'.repeat(64) },
    { example: 'Firmware/OepProbe', profile: 'esp32p4', file: 'OepProbe-esp32p4-1.2.0.bin', kind: 'app', model: 'esp32p4', chip: 'esp32p4', flash_offset: null, sha256: '' },
    { example: 'Firmware/OepProbe', profile: 'rp2040', file: 'OepProbe-rp2040-1.2.0.uf2', kind: 'uf2', model: 'rp2040', chip: 'rp2040', sha256: '2'.repeat(64) },
  ],
};

test('firmware json: parse, pick by model and kind, sha256 check', async () => {
  assert.equal(await sha256(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const m = structuredClone(manifest);
  m.firmware[2].sha256 = await sha256(image);
  const parsed = parseFirmwareManifest(JSON.stringify(m));
  assert.equal(parsed.version, '1.2.0');
  assert.equal(pickFirmware(parsed, { model: 'esp32p4', kind: 'app' })?.file, 'OepProbe-esp32p4-1.2.0.bin');
  assert.equal(pickFirmware(parsed, { model: 'esp32p4', kind: 'app', example: '01.Basics/Hello' })?.file, 'Hello-esp32p4-1.2.0.bin');
  assert.equal(pickFirmware(parsed, { model: 'esp32p4', kind: 'merged' })?.flash_offset, 0);
  assert.equal(pickFirmware(parsed, { model: 'rp2040' })?.kind, 'uf2');
  assert.equal(pickFirmware(parsed, { model: 'rp2350', kind: 'uf2' }), null);
  await verifyFirmware(image, parsed.firmware[2]);
  await assert.rejects(verifyFirmware(image.slice(1), parsed.firmware[2]), /sha256/);
  assert.throws(() => parseFirmwareManifest({ ...m, schema: 2 }), /schema 2/);
  assert.throws(() => parseFirmwareManifest(manifest), /bad entry/);   // the empty sha256
  assert.throws(() => parseFirmwareManifest({ schema: 1, version: 'x', firmware: [{ ...m.firmware[0], file: '../x.bin' }] }), /bad file name/);
  /** @type {string[]} */
  const urls = [];
  const fetch = /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url) => {
    urls.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => image.slice().buffer };
  }));
  const got = await fetchFirmware('https://example.org/fw/firmware-1.2.0.json', parsed.firmware[2], { fetch });
  assert.deepEqual(got, image);
  assert.deepEqual(urls, ['https://example.org/fw/OepProbe-esp32p4-1.2.0.bin']);
});
