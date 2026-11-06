// @ts-check
// The boards that can be OEP probes with the released firmware, and what each can do (docs/page.ja.md §4.2). From
// oep-probe-arduino's docs/guide/boards.ja.md (what each chip does, the pins the released firmware gives): change it
// with that table.

/** @typedef {{ en: string, ja: string }} Text */
/** @typedef {true | false | Text} Has  true: yes, false: no, a text: yes with that limit */
/**
 * @typedef {{ id: string, tier: 'release' | 'build', name: Text, chip: string, models: string[], verified: boolean | Text,
 *   write: { page: 'any' | 'serial' | false, how: Text }, usb: Text, pins: Text, reserved: Text,
 *   features: Record<string, Has> }} Board
 * tier: release - a released firmware runs on it; build - build an example for it yourself
 */

/** The features in the order the page shows them, grouped (docs/page.ja.md §4.1). */
export const FEATURES = [
  { group: { en: 'Debug and write', ja: 'デバッグと書き込み' }, items: [
    ['rvswd', { en: 'RVSWD (WCH RISC-V, 2 wires)', ja: 'RVSWD（WCH の RISC-V、2 線）' }],
    ['swio', { en: 'SWIO (CH32V00x, 1 wire)', ja: 'SWIO（CH32V00x、1 線）' }],
    ['swd', { en: 'SWD (ARM)', ja: 'SWD（ARM）' }],
    ['console', { en: 'Target console', ja: 'ターゲットのコンソール' }],
  ] },
  { group: { en: 'Test fixture', ja: '治具' }, items: [
    ['gpio', { en: 'GPIO, UART', ja: 'GPIO、UART' }],
    ['busTarget', { en: 'I2C / SPI as the target\'s peer', ja: 'I2C / SPI（ターゲットの相手として）' }],
    ['busController', { en: 'I2C / SPI as the controller', ja: 'I2C / SPI（主として）' }],
    ['pwm', { en: 'PWM output', ja: 'PWM の出力' }],
    ['counter', { en: 'Edge counter', ja: 'エッジを数える' }],
    ['dac', { en: 'Analog output (DAC)', ja: 'アナログの出力（DAC）' }],
  ] },
  { group: { en: 'Capture', ja: 'キャプチャ' }, items: [
    ['logic', { en: 'Logic capture', ja: 'ロジックのキャプチャ' }],
    ['analog', { en: 'Analog capture', ja: 'アナログのキャプチャ' }],
  ] },
  { group: { en: 'Kept in the probe', ja: 'プローブに保存' }, items: [
    ['settings', { en: 'Settings (pin names, ...)', ja: '設定（ピンの名前など）' }],
    ['memo', { en: 'Records for tools (memo area)', ja: '道具の記録（メモ欄）' }],
  ] },
];

/** @type {Board[]} */
export const BOARDS = [
  {
    id: 'pico', tier: 'release', name: { en: 'Raspberry Pi Pico', ja: 'Raspberry Pi Pico' }, chip: 'RP2040', models: ['rp2040'], verified: true,
    write: { page: 'any', how: { en: 'Hold BOOTSEL while plugging it in; this page writes it over USB.', ja: 'BOOTSEL を押しながら挿します。このページが USB から書きます。' } },
    usb: { en: 'USB (CDC, vendor bulk, HID)', ja: 'USB（CDC、vendor bulk、HID）' },
    pins: { en: 'GP0-GP22, GP26-GP28', ja: 'GP0〜GP22、GP26〜GP28' },
    reserved: { en: 'GP23-GP25, GP29 (power, VBUS sense, LED)', ja: 'GP23〜GP25、GP29（電源、VBUS の検出、LED）' },
    features: {
      rvswd: true, swio: true, swd: true, console: true, gpio: true, busTarget: { en: 'not checked', ja: '未検証' },
      busController: { en: 'up to 250 kHz', ja: '250 kHz まで' }, pwm: true, counter: { en: 'up to 100 kHz', ja: '100 kHz まで' }, dac: false,
      logic: { en: '8 ch', ja: '8 ch' }, analog: { en: '4 ch, 500 kS/s in all', ja: '4 ch、合計 500 kS/s' },
      settings: true, memo: true,
    },
  },
  {
    id: 'pico2', tier: 'release', name: { en: 'Raspberry Pi Pico 2', ja: 'Raspberry Pi Pico 2' }, chip: 'RP2350', models: ['rp2350'], verified: true,
    write: { page: 'any', how: { en: 'Hold BOOTSEL while plugging it in; this page writes it over USB.', ja: 'BOOTSEL を押しながら挿します。このページが USB から書きます。' } },
    usb: { en: 'USB (CDC, vendor bulk, HID)', ja: 'USB（CDC、vendor bulk、HID）' },
    pins: { en: 'GP0-GP22, GP26-GP28', ja: 'GP0〜GP22、GP26〜GP28' },
    reserved: { en: 'GP23-GP25, GP29 (power, VBUS sense, LED)', ja: 'GP23〜GP25、GP29（電源、VBUS の検出、LED）' },
    features: {
      rvswd: true, swio: true, swd: true, console: true, gpio: true, busTarget: { en: 'not checked', ja: '未検証' },
      busController: { en: 'up to 250 kHz', ja: '250 kHz まで' }, pwm: true, counter: { en: 'up to 100 kHz', ja: '100 kHz まで' }, dac: false,
      logic: { en: '8 ch', ja: '8 ch' }, analog: { en: '4 ch, 500 kS/s in all', ja: '4 ch、合計 500 kS/s' },
      settings: true, memo: true,
    },
  },
  {
    id: 'p4', tier: 'release', name: { en: 'ESP32-P4 board (chip v1.x)', ja: 'ESP32-P4 のボード（チップ v1.x）' }, chip: 'ESP32-P4 (v1.x)', models: ['esp32p4'], verified: true,
    write: { page: 'serial', how: { en: 'Install here over serial USB; later update here over native USB (DFU).', ja: 'このページでUSBシリアルから初回書き込みできます。導入後はnative USB（DFU）でも更新できます。' } },
    usb: { en: 'USB HS (vendor bulk, HID, CDC)', ja: 'USB HS（vendor bulk、HID、CDC）' },
    pins: { en: 'GPIO0-GPIO54 but 24, 25', ja: 'GPIO0〜GPIO54（24、25 以外）' },
    reserved: { en: 'GPIO24 / 25 (USB-Serial/JTAG)', ja: 'GPIO24 / 25（USB-Serial/JTAG）' },
    features: {
      rvswd: true, swio: true, swd: true, console: true, gpio: { en: '2 UARTs', ja: 'UART 2 つ' }, busTarget: true,
      busController: { en: 'I2C 400 kHz / SPI 750 kHz', ja: 'I2C 400 kHz / SPI 750 kHz' }, pwm: true, counter: { en: 'up to 40 MHz', ja: '40 MHz まで' }, dac: false,
      logic: { en: 'up to 16 ch, 160 Msps at 2 ch', ja: '16 ch まで、2 ch で 160 Msps' }, analog: { en: '4 ch, 46 kHz in all', ja: '4 ch、合計 46 kHz' },
      settings: true, memo: true,
    },
  },
  {
    id: 'p4x', tier: 'release', name: { en: 'ESP32-P4X board (chip v3.x)', ja: 'ESP32-P4X のボード（チップ v3.x）' }, chip: 'ESP32-P4X (v3.x)', models: ['esp32p4x'], verified: true,
    write: { page: 'serial', how: { en: 'Install here over serial USB; later update here over native USB (DFU). The P4 and P4X images are not interchangeable.', ja: 'このページでUSBシリアルから初回書き込みできます。導入後はnative USB（DFU）でも更新できます。P4 と P4X のファームウェアイメージは互換がありません。' } },
    usb: { en: 'USB HS (vendor bulk, HID, CDC)', ja: 'USB HS（vendor bulk、HID、CDC）' },
    pins: { en: 'GPIO0-GPIO54 but 24, 25', ja: 'GPIO0〜GPIO54（24、25 以外）' },
    reserved: { en: 'GPIO24 / 25 (USB-Serial/JTAG)', ja: 'GPIO24 / 25（USB-Serial/JTAG）' },
    features: {
      rvswd: true, swio: true, swd: true, console: true, gpio: { en: '2 UARTs', ja: 'UART 2 つ' }, busTarget: true,
      busController: { en: 'I2C 400 kHz / SPI 750 kHz', ja: 'I2C 400 kHz / SPI 750 kHz' }, pwm: true, counter: { en: 'up to 40 MHz', ja: '40 MHz まで' }, dac: false,
      logic: { en: 'up to 16 ch, 160 Msps at 2 ch', ja: '16 ch まで、2 ch で 160 Msps' }, analog: { en: '4 ch, 46 kHz in all', ja: '4 ch、合計 46 kHz' },
      settings: true, memo: true,
    },
  },
  {
    id: 'esp32', tier: 'release', name: { en: 'Classic ESP32 board (ESP32-DevKitC, ...)', ja: 'classic ESP32 のボード（ESP32-DevKitC など）' }, chip: 'ESP32', models: ['esp32'], verified: true,
    write: { page: 'serial', how: { en: 'Install here through the USB–serial port. No OEP firmware is needed beforehand.', ja: 'USBシリアルのポートを選んで、このページから初回書き込みできます。OEPの事前導入は不要です。' } },
    usb: { en: 'its USB-UART bridge (115200); Wi-Fi TCP once set up', ja: 'USB-UART の変換チップ（115200）。設定すれば Wi-Fi の TCP も' },
    pins: { en: 'GPIO4, 5, 13, 14, 16-19, 21-23, 25-27, 32-36, 39 (34-39 input only)', ja: 'GPIO4、5、13、14、16〜19、21〜23、25〜27、32〜36、39（34〜39 は入力だけ）' },
    reserved: { en: '1, 3 (its UART), 6-11 (flash), 0, 2, 12, 15 (boot straps)', ja: '1、3（UART）、6〜11（flash）、0、2、12、15（起動のストラップ）' },
    features: {
      rvswd: true, swio: true, swd: true, console: true, gpio: true, busTarget: { en: 'SPI modes 0 / 2', ja: 'SPI は mode 0 / 2' },
      busController: { en: 'I2C 400 kHz / SPI 750 kHz', ja: 'I2C 400 kHz / SPI 750 kHz' }, pwm: true, counter: { en: 'up to 10 MHz', ja: '10 MHz まで' },
      dac: { en: 'GPIO25 / 26, 8 bits', ja: 'GPIO25 / 26、8 bit' },
      logic: { en: '8 ch, 1-300 kHz', ja: '8 ch、1〜300 kHz' }, analog: { en: '4 ch, 20-100 kHz in all', ja: '4 ch、合計 20〜100 kHz' },
      settings: true, memo: true,
    },
  },
  {
    id: 'ch32', tier: 'release', name: { en: 'WCH CH32 board', ja: 'WCH CH32 のボード' }, chip: 'CH32X035 / V307 / H417', models: ['ch32x035', 'ch32v307', 'ch32h417'], verified: false,
    write: { page: false, how: { en: 'With WCH-LinkUtility or wlink, the .bin at the flash start (this page cannot).', ja: 'WCH-LinkUtility か wlink で、.bin を flash の先頭に書きます（このページでは書けません）。' } },
    usb: { en: 'USB (vendor bulk, HID)', ja: 'USB（vendor bulk、HID）' },
    pins: { en: 'see the board', ja: 'ボードによる' }, reserved: { en: 'see the board', ja: 'ボードによる' },
    features: {
      rvswd: true, swio: { en: 'not the X035', ja: 'X035 以外' }, swd: { en: 'not the X035', ja: 'X035 以外' }, console: true,
      gpio: { en: 'UART not on the X035', ja: 'UART は X035 以外' }, busTarget: { en: 'not the X035', ja: 'X035 以外' },
      busController: { en: 'not the X035, 250 kHz', ja: 'X035 以外、250 kHz' }, pwm: false, counter: { en: 'not the X035', ja: 'X035 以外' },
      dac: { en: 'V307, H417: 12 bits', ja: 'V307、H417: 12 bit' },
      logic: { en: '8 ch, 250 kS/s (not the X035)', ja: '8 ch、250 kS/s（X035 以外）' }, analog: { en: '4 ch (not the X035)', ja: '4 ch（X035 以外）' },
      settings: false, memo: false,
    },
  },
  {
    id: 'esp32s3', tier: 'build', name: { en: 'ESP32-S3 / C3 / C6 board', ja: 'ESP32-S3 / C3 / C6 のボード' }, chip: 'ESP32-S3, C3, C6', models: [],
    verified: { en: 'RVSWD builds; not checked on hardware', ja: 'RVSWD のビルドのみ。実機では未確認' },
    write: { page: 'serial', how: { en: 'Select your chip family and a compatible merged .bin file, then program it here. No prebuilt OepProbe release is available for these chips.', ja: 'チップの種類と対応するmerged .binファイルを選んで、このページから書き込みます。この系列のOepProbe配布ファームウェアイメージはまだありません。' } },
    usb: { en: 'USB-Serial/JTAG or USB CDC', ja: 'USB-Serial/JTAG か USB CDC' },
    pins: { en: 'chosen in the build (leave out flash, PSRAM, USB and strap pins)', ja: 'ビルドで選ぶ（flash、PSRAM、USB、起動のストラップのピンを外す）' },
    reserved: { en: 'flash, PSRAM, USB, boot straps', ja: 'flash、PSRAM、USB、起動のストラップ' },
    features: {
      rvswd: { en: 'builds, not checked', ja: 'ビルドのみ、未確認' }, swio: false, swd: false, console: true, gpio: true,
      busTarget: { en: 'not checked', ja: '未確認' }, busController: false, pwm: false, counter: false, dac: false,
      logic: false, analog: false, settings: true, memo: { en: 'not checked', ja: '未確認' },
    },
  },
];

/** The board a probe's describe model names. @param {string | null | undefined} model */
export function boardOf(model) {
  return BOARDS.find((b) => b.models.includes(String(model ?? ''))) ?? null;
}
