// @ts-check
// RP2040 / RP2350 over PICOBOOT (src/picoboot.js) against a fake boot ROM with its flash in memory, and the .uf2 checks
// (src/firmware.js checkUf2). On the bench this wrote an RP2040 and an RP2350 probe (58 / 56 sectors, about 3 s each).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkUf2, UF2_FAMILIES } from '../src/firmware.js';
import { PicobootError, RP2_BOOT_PID, RP2_BOOT_VID, rp2Write, uf2Sectors } from '../src/picoboot.js';

const FLASH = 0x10000000;

/** A .uf2: `size` bytes of data at FLASH in 256-byte blocks of `family`, optionally an absolute block first.
 * @param {number} size @param {number} family @param {{ absolute?: boolean }} [opts] */
function uf2(size, family, { absolute = false } = {}) {
  const blocks = [];
  const n = Math.ceil(size / 256);
  const block = (/** @type {number} */ addr, /** @type {number} */ no, /** @type {number} */ total, /** @type {number} */ fam, /** @type {number} */ fill) => {
    const b = new Uint8Array(512);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x0a324655, true); v.setUint32(4, 0x9e5d5157, true); v.setUint32(8, 0x2000, true);
    v.setUint32(12, addr, true); v.setUint32(16, 256, true); v.setUint32(20, no, true); v.setUint32(24, total, true);
    v.setUint32(28, fam, true); v.setUint32(508, 0x0ab16f30, true);
    for (let k = 0; k < 256; k++) b[32 + k] = (fill + k) & 0xff;
    return b;
  };
  if (absolute) blocks.push(block(0x10ffff00, 0, 2, 0xe48bff57, 0xee));
  for (let i = 0; i < n; i++) blocks.push(block(FLASH + i * 256, i, n, family, i));
  const out = new Uint8Array(blocks.length * 512);
  blocks.forEach((b, i) => out.set(b, i * 512));
  return out;
}

/** A boot ROM with PICOBOOT on interface 1: bulk OUT 3, bulk IN 4; flash from FLASH, 1 MB, starting as `old`.
 * @param {'rp2040' | 'rp2350'} model @param {{ old?: number, corruptAt?: number }} [opts] @returns {any} */
function bootRom(model, { old = 0x5a, corruptAt = -1 } = {}) {
  const flash = new Uint8Array(1 << 20).fill(old);
  /** @type {string[]} */
  const log = [];
  /** @type {any} */ let pending = null;
  let left = 0;
  return {
    log, flash,
    vendorId: RP2_BOOT_VID, productId: RP2_BOOT_PID[model], opened: false, configuration: /** @type {any} */ (null),
    async open() { this.opened = true; },
    async selectConfiguration() {
      this.configuration = { interfaces: [
        { interfaceNumber: 0, alternates: [{ interfaceClass: 0x08, endpoints: [] }] },
        { interfaceNumber: 1, alternates: [{ interfaceClass: 0xff, endpoints: [
          { endpointNumber: 3, direction: 'out', type: 'bulk' }, { endpointNumber: 4, direction: 'in', type: 'bulk' }] }] }] };
    },
    async claimInterface(/** @type {number} */ n) { log.push(`claim ${n}`); },
    async controlTransferOut(/** @type {any} */ setup) { log.push(`ctl 0x${setup.request.toString(16)}`); return { status: 'ok' }; },
    async close() { this.opened = false; },
    async transferOut(/** @type {number} */ ep, /** @type {ArrayBuffer | Uint8Array} */ data) {
      assert.equal(ep, 3);
      const b = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (pending && left) {                                      // a WRITE's data
        flash.set(b, pending.addr - FLASH);
        if (pending.addr === corruptAt) flash[pending.addr - FLASH] ^= 0xff;
        left = 0;
        return { status: 'ok', bytesWritten: b.length };
      }
      if (!b.length) return { status: 'ok', bytesWritten: 0 };   // an IN command's handshake
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      assert.equal(v.getUint32(0, true), 0x431fd10b);
      const id = b[8], len = v.getUint32(12, true), a0 = v.getUint32(16, true), a1 = v.getUint32(20, true);
      log.push(`cmd 0x${id.toString(16)} ${a0.toString(16)} ${a1}`);
      pending = { id, addr: a0, size: a1, len };
      if (id === 0x03) {                                          // FLASH_ERASE
        assert.equal(a0 % 4096, 0); assert.equal(a1 % 4096, 0);
        flash.fill(0xff, a0 - FLASH, a0 - FLASH + a1);
      }
      if (id === 0x05) { assert.equal(a0 % 256, 0); left = len; }
      return { status: 'ok', bytesWritten: 32 };
    },
    async transferIn(/** @type {number} */ ep, /** @type {number} */ n) {
      assert.equal(ep, 4);
      if (pending?.id === 0x84) {
        const d = flash.slice(pending.addr - FLASH, pending.addr - FLASH + pending.size);
        pending = null;
        return { status: 'ok', data: new DataView(d.buffer) };
      }
      pending = null;
      return { status: 'ok', data: new DataView(new ArrayBuffer(0)) };
    },
  };
}

test('checkUf2: a whole image of the model\'s family; the RP2350 absolute block first is allowed', () => {
  assert.deepEqual(checkUf2(uf2(1000, UF2_FAMILIES.rp2040[0]), { model: 'rp2040' }), { blocks: 4, family: 0xe48bff56, start: FLASH });
  assert.equal(checkUf2(uf2(1000, UF2_FAMILIES.rp2350[0], { absolute: true }), { model: 'rp2350' }).blocks, 4);
  assert.throws(() => checkUf2(uf2(1000, UF2_FAMILIES.rp2040[0]), { model: 'rp2350' }), /not rp2350/);
  assert.throws(() => checkUf2(new Uint8Array(512), {}), /no UF2 magic/);
  const cut = uf2(1000, UF2_FAMILIES.rp2040[0]).slice(0, 1024);
  assert.throws(() => checkUf2(cut, {}), /2 of its 4 blocks/);
});

test('uf2Sectors: the image as 4 KB sectors, 0xFF past its end, the absolute block left out', () => {
  const s = uf2Sectors(uf2(5000, UF2_FAMILIES.rp2350[0], { absolute: true }));
  assert.deepEqual([...s.keys()], [FLASH, FLASH + 4096]);
  const second = /** @type {Uint8Array} */ (s.get(FLASH + 4096));
  assert.equal(second[0], 16);                                     // block 16's first byte
  assert.equal(second[5120 - 4096], 0xff);                         // past the 20 blocks (5120 bytes)
});

for (const model of /** @type {const} */ (['rp2040', 'rp2350'])) {
  test(`rp2Write (${model}): exclusive, exit XIP, per sector erase / write / read back, then the restart; the flash past the image kept`, async () => {
    const dev = bootRom(model);
    const image = uf2(9000, UF2_FAMILIES[model][0], { absolute: model === 'rp2350' });
    /** @type {string[]} */
    const progress = [];
    const r = await rp2Write(dev, image, { model, onProgress: (p) => progress.push(p.phase) });
    assert.equal(r.sectors, 3);
    const ids = dev.log.filter((/** @type {string} */ l) => l.startsWith('cmd')).map((/** @type {string} */ l) => l.split(' ')[1]);
    assert.deepEqual(ids.slice(0, 2), ['0x1', '0x6']);
    assert.equal(ids.at(-1), model === 'rp2350' ? '0xa' : '0x2');
    assert.equal(ids.filter((/** @type {string} */ i) => i === '0x3').length, 3);
    assert.equal(dev.flash[0], 0); assert.equal(dev.flash[9216], 0xff);   // the image (36 blocks), then 0xFF to its sector's end
    assert.equal(dev.flash[3 * 4096], 0x5a);                         // the next sector (settings, FS): untouched
    assert.deepEqual(progress.slice(-1), ['reboot']);
  });
}

test('rp2Write refuses another chip\'s boot ROM, and a sector read back different', async () => {
  await assert.rejects(rp2Write(bootRom('rp2350'), uf2(100, UF2_FAMILIES.rp2040[0]), { model: 'rp2040' }), PicobootError);
  await assert.rejects(rp2Write(bootRom('rp2040', { corruptAt: FLASH + 1024 }), uf2(4096, UF2_FAMILIES.rp2040[0]), { model: 'rp2040' }),
    /read back differs/);
});
