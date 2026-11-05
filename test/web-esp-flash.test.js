import test from 'node:test';
import assert from 'node:assert/strict';
import { flashEsp } from '../web/esp-flash.js';

function fixture(chip = 'ESP32', major = 1, fail = '') {
  const events = /** @type {any[]} */ ([]);
  const image = new Uint8Array(0x20000);
  const chipId = /** @type {Record<string,number>} */ ({'ESP32':0,'ESP32-P4':18,'ESP32-S3':9,'ESP32-C3':5,'ESP32-C6':13})[chip];
  const header = chip === 'ESP32' ? 0x1000 : chip === 'ESP32-P4' ? 0x2000 : 0;
  image[header + 12] = chipId;
  image[chip === 'ESP32' ? 0x1000 : chip === 'ESP32-P4' ? 0x2000 : 0] = 0xe9;
  image[0x8000] = 0xaa; image[0x8001] = 0x50;
  const load = async () => ({
    Transport: class { constructor(/** @type {any} */ port) { events.push(['port', port]); } async disconnect() { events.push(['close']); if (fail === 'connect-close') throw Error('close failed'); } },
    ESPLoader: class {
      chip = { CHIP_NAME: chip, getMajorChipVersion: async () => major };
      async main() { if (fail.startsWith('connect')) throw Error('connect failed'); return chip; }
      async writeFlash(/** @type {any} */ options) { events.push(['write', options]); if (fail === 'write') throw Error('write failed'); options.reportProgress(0, image.length, image.length); }
      async after(/** @type {string} */ mode) { events.push(['reset', mode]); }
    },
  });
  return { image, load, events };
}

test('ESP initial installation writes the merged image at zero and releases its serial port', async () => {
  const f = fixture(); const progress = /** @type {any[]} */ ([]);
  await flashEsp({ ...f, model: 'esp32', port: 'blank board', onProgress: (...args) => progress.push(args) });
  const options = f.events.find((e) => e[0] === 'write')[1];
  assert.equal(options.fileArray[0].address, 0);
  assert.equal(options.fileArray[0].data, f.image);
  assert.equal(options.eraseAll, false);
  assert.deepEqual(f.events.slice(-2), [['reset', 'hard_reset'], ['close']]);
  assert.equal(progress.at(-1)[0], f.image.length);
});

test('wrong ESP chip and P4 revision are rejected before any flash write', async () => {
  for (const [chip, major, model] of /** @type {[string,number,string][]} */ ([['ESP32-S3', 0, 'esp32c3'], ['ESP32-P4', 3, 'esp32p4'], ['ESP32-P4', 1, 'esp32p4x']])) {
    const f = fixture(chip, major);
    if (model === 'esp32c3') f.image[12] = 5;
    await assert.rejects(flashEsp({ ...f, model, port: {} }), /Nothing was written/);
    assert.equal(f.events.some((e) => e[0] === 'write'), false);
    assert.deepEqual(f.events.at(-1), ['close']);
  }
});

test('P4 v1, P4 v3 and S3/C3/C6 use the detected ROM chip', async () => {
  for (const [chip, major, model] of /** @type {[string,number,string][]} */ ([['ESP32-P4', 1, 'esp32p4'], ['ESP32-P4', 3, 'esp32p4x'], ['ESP32-S3', 0, 'esp32s3'], ['ESP32-C3', 0, 'esp32c3'], ['ESP32-C6', 0, 'esp32c6']])) {
    const f = fixture(chip, major);
    assert.equal(await flashEsp({ ...f, model, port: {} }), chip);
    assert.equal(f.events.filter((e) => e[0] === 'write').length, 1);
  }
});

test('serial port is released on ROM connection and programming failures', async () => {
  for (const fail of ['connect', 'write', 'connect-close']) {
    const f = fixture('ESP32', 1, fail);
    await assert.rejects(flashEsp({ ...f, model: 'esp32', port: {} }), /connect failed|write failed/);
    assert.deepEqual(f.events.at(-1), ['close']);
    assert.equal(f.events.some((e) => e[0] === 'reset'), false);
  }
});

test('app-only or incomplete images cannot program a blank board', async () => {
  const f = fixture(); f.image[0x8000] = 0;
  await assert.rejects(flashEsp({ ...f, model: 'esp32', port: {} }), /complete ESP merged/);
  assert.equal(f.events.length, 0);
});

test('image chip mismatch is rejected before opening the serial port', async () => {
  const f = fixture('ESP32-S3');
  await assert.rejects(flashEsp({ ...f, model: 'esp32c3', port: {} }), /image is not for ESP32-C3/);
  assert.equal(f.events.length, 0);
});
