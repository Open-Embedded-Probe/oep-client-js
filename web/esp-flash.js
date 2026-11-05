// ESP ROM programming is separate from the OEP protocol and works on blank boards.
/**
 * @param {{port: any, model: string, image: Uint8Array,
 * onProgress?: (done:number,total:number,text:string)=>void, log?: (text:string)=>void,
 * load?: ()=>Promise<any>}} options
 */
export async function flashEsp({ port, model, image, onProgress = () => {}, log = () => {}, load = () => import('./esp-loader.js') }) {
  const chips = /** @type {Record<string, [string,number,number]>} */ ({ esp32: ['ESP32', 0, 0x1000], esp32p4: ['ESP32-P4', 18, 0x2000], esp32p4x: ['ESP32-P4', 18, 0x2000], esp32s3: ['ESP32-S3', 9, 0], esp32c3: ['ESP32-C3', 5, 0], esp32c6: ['ESP32-C6', 13, 0] });
  const selected = chips[model];
  if (!selected) throw new Error(`Unsupported ESP model: ${model}`);
  const [expected, chipId, header] = selected;
  if (!(image instanceof Uint8Array) || image.length < 0x10000 || image.length > 32 * 1024 * 1024 || image[header] !== 0xe9 || image[0x8000] !== 0xaa || image[0x8001] !== 0x50) {
    throw new Error('Select a complete ESP merged .bin image (bootloader and partition table at 0x8000) at offset 0.');
  }
  if ((image[header + 12] | (image[header + 13] << 8)) !== chipId) throw new Error(`The image is not for ${expected}. Nothing was written.`);
  const { ESPLoader, Transport } = await load();
  const transport = new Transport(port);
  let failed = false;
  try {
    const loader = new ESPLoader({ transport, baudrate: 460800, romBaudrate: 115200,
      terminal: { clean() {}, write: log, writeLine: log } });
    onProgress(0, 1, 'Connecting to ESP ROM…');
    const description = await loader.main();
    log(description);
    if (loader.chip.CHIP_NAME !== expected) throw new Error(`Selected ${expected}, detected ${loader.chip.CHIP_NAME}. Nothing was written.`);
    if (model === 'esp32p4' || model === 'esp32p4x') {
      const major = await loader.chip.getMajorChipVersion(loader);
      const required = model === 'esp32p4' ? 1 : 3;
      if (major !== required) throw new Error(`Selected ${model} (v${required}.x), detected P4 v${major}.x. Nothing was written.`);
    }
    await loader.writeFlash({ fileArray: [{ data: image, address: 0 }], flashSize: 'detect', flashMode: 'keep', flashFreq: 'keep',
      eraseAll: false, compress: true, reportProgress: (/** @type {number} */ _index, /** @type {number} */ done, /** @type {number} */ total) => onProgress(done, total, `${done} / ${total} bytes`) });
    await loader.after('hard_reset');
    return description;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await transport.disconnect(); }
    catch (error) {
      if (!failed) throw error;
      log(`Serial cleanup: ${error instanceof Error ? error.message : error}`);
    }
  }
}
