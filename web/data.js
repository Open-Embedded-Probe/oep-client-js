// What the public pages and the screens say. The probe's own declarations decide what can run (page.ja.md §3.2).
// The texts are built in the page language and rebuilt when it changes (the exports are live bindings).
import { t, onLanguage } from './i18n.js';

export const GUIDE_BASE = 'https://github.com/Open-Embedded-Probe/oep-probe-arduino/blob/main/docs/guide/';
/** A guide page of oep-probe-arduino in the page language. */
export const guide = (name) => GUIDE_BASE + t(`${name}.md`, `${name}.ja.md`);

export let BOARDS, DEBUG_WIRES, USES, DOCS;

function build() {
  BOARDS = [
    { id: 'pico', name: 'Raspberry Pi Pico', chip: 'RP2040 / RP2350', tag: t('Start over USB', 'USBで始める'), title: t('Try everything on a small board.', '小さなボードで、ひと通り試す。'),
      description: t('Debug, UART, GPIO and buses on one board. The Pico 2 starts the same way.', 'デバッグ、UART、GPIOやバス通信をひとつのボードで。Pico 2も同じ流れで始められます。'),
      features: ['SWD / RVSWD / SWIO', t('GPIO, UART, I2C, SPI', 'GPIO・UART・I2C・SPI'), t('Logic and analog capture', 'ロジック・アナログ取得')],
      note: t('UART works on fixed pin pairs. There is no DAC output.', 'UARTは使えるピンの組が決まっています。DAC出力はありません。'), install: t('Plug in USB while holding BOOTSEL', 'BOOTSELボタンを押しながらUSBを接続'), port: t('The Pico\'s own USB port', 'Pico本体のUSB端子'), method: 'bootsel', ids: ['pico', 'pico2'], installable: true, code: 'RP2' },
    { id: 'esp32', name: 'ESP32', chip: 'classic ESP32', tag: t('Use a board you have', '手元のボードを使う'), title: t('From USB serial straight to the settings.', 'USBシリアルから、そのまま設定へ。'),
      description: t('Turn an ESP32-DevKitC or similar into a probe. Besides buses and signals, it also offers Wi-Fi and a DAC.', 'ESP32-DevKitCなどをプローブに。通信や信号の確認に加えて、Wi-FiやDACの用途も。'),
      features: ['SWD / RVSWD / SWIO', t('GPIO, UART, I2C, SPI', 'GPIO・UART・I2C・SPI'), t('Wi-Fi settings, DAC output', 'Wi-Fi設定・DAC出力')],
      note: t('Some pins are input only. Fast capture is limited by the transfer speed.', '入力専用ピンがあります。高速なデータ取得には転送速度の制約があります。'), install: t('Connect a USB cable that carries data', 'データ通信できるUSBケーブルで接続'), port: t('The board\'s programming USB port', 'ボードの書き込み用USB端子'), method: 'serial', ids: ['esp32'], installable: true, code: 'ESP32' },
    { id: 'p4', name: 'ESP32-P4 / P4X', chip: 'ESP32-P4', tag: t('Recommended', '推奨ボード'), recommended: true, title: t('Buses and observation in one fixture.', '通信と観測を、ひとつの治具に。'),
      description: t('High-speed USB and many capture channels. Install over serial and keep setting it up the same way.', '高速USBや多チャネルの観測に対応する構成。シリアルから導入し、同じ経路で設定を続けます。'),
      features: ['SWD / RVSWD / SWIO', t('2 UARTs, buses', 'UART 2系統・バス通信'), t('High-speed USB, logic capture', '高速USB・ロジック取得')],
      note: t('The P4 and P4X take different firmware images; the chip revision decides which. The UART bridge is on by default in the firmware. The release and its hardware path still need checking separately.', 'P4とP4Xはファームウェアイメージが異なります。チップのrevisionを確認して選びます。UART bridgeはfirmwareで既定有効です。配布版と実機経路の確認は別途必要です。'), install: t('Connect the USB port used for programming', '書き込みに使えるUSB端子へ接続'), port: t('The serial port used for programming', '書き込みに使ったシリアルポート'), method: 'serial', ids: ['p4', 'p4x'], installable: true, code: 'P4' },
    { id: 's3', name: 'ESP32-S3 / C3 / C6', chip: t('Your own OEP build', '独自のOEP構成'), tag: t('If you have a compatible firmware image', '互換ファームウェアイメージを持っている方'), title: t('Connect your own build to OEP.', '自分の構成を、OEPにつなぐ。'),
      description: t('For bringing a compatible firmware. There is no common released OepProbe image; what works depends on the image.', '互換firmwareの持ち込み用。共通の配布OepProbeファームウェアイメージはなく、ファームウェアイメージによって使える機能も異なります。'),
      features: [t('Features depend on the image', 'ファームウェアイメージで機能が変わる'), t('Uses a compatible merged image', '互換mergedファームウェアイメージを使用'), t('Mind the USB setup after boot', '起動後のUSB構成に注意')],
      note: t('If the USB setup changes after boot, this screen guides the permission and replugging.', '起動後にUSBの構成が変わる場合は、同じ画面で使用許可や抜き差しを案内します。'), install: t('Check the firmware image and the programming USB port', '対応ファームウェアイメージと、書き込み用USB端子を確認'), port: t('The board\'s programming USB port', 'ボードの書き込み用USB端子'), method: 'serial', custom: true, ids: ['esp32s3'], installable: true, code: 'S3' },
    { id: 'ch32', name: 'WCH CH32', chip: 'X035 / V307 / H417', tag: t('For installed probes', '導入済みの機器向け'), title: t('Small probe implementations too.', '小さなプローブの実装にも。'),
      description: t('Features and storage limits differ by model. Firmware is released, but this page does not do the first install.', '機種により機能や保存の制約が異なります。配布firmwareはありますが、このページでの初回書き込みは対象外です。'),
      features: [t('Features by model', '機種別の機能構成'), t('Limited settings storage', '設定保存に制約あり'), t('Connects once installed', '導入済みなら接続可能')],
      note: t('See the board guide for what was checked on hardware.', '実機で確認した範囲はボード資料を参照してください。'), install: '', port: '', method: false, ids: ['ch32'], installable: false, code: 'CH32' },
  ];
  BOARDS.sort((a, b) => Number(b.id === 'p4') - Number(a.id === 'p4'));
  DEBUG_WIRES = [
    { id: 'swd', short: 'SWD', title: t('SWD (2 wires)', 'SWD（2線）'), description: t('For ARM targets with SWD, such as STM32.', 'SWDに対応するARMターゲット向け。例: STM32。'), roles: ['SWDIO', 'SWCLK'], target: 'ARM Cortex-M', part: 'STM32F103C8T6', note: t('Choose the data and clock lines. Add NRST separately only when needed. An RP2040 can be written and debugged from the Arduino IDE through the OEP broker.', 'データ線とクロック線を指定します。必要な場合だけ、別途NRSTを追加します。RP2040はArduino IDEからOEPのブローカー経由で書き込み・デバッグできます。') },
    { id: 'rvswd', short: 'RVSWD', title: t('RVSWD (2 wires)', 'RVSWD（2線）'), description: t('For WCH RISC-V with 2-wire debug, such as CH32V203.', '2線デバッグに対応するWCH RISC-V向け。例: CH32V203。'), roles: ['SWDIO', 'SWCLK'], target: 'WCH RISC-V', part: 'CH32V203C8T6', note: t('A different method from SWD: the same signal names are not compatible. Leave the idle state and speed to the probe and the tools. Examples: PC18/PC19 on the CH32X035, PA13/PA14 on the CH32V203.', 'SWDとは異なる方式です。同じ信号名でも互換ではありません。待機状態と速度は通常プローブ・道具に任せます。CH32X035はPC18/PC19、CH32V203はPA13/PA14の例です。') },
    { id: 'swio', short: t('1-wire DIO (SWIO)', '1線DIO（SWIO）'), title: t('1-wire DIO (SWIO)', '1線DIO（SWIO）'), description: t('For WCH targets with 1-wire debug, such as CH32V003.', '1線デバッグに対応するWCHターゲット向け。例: CH32V003。'), roles: ['DIO'], target: t('WCH 1-wire debug', 'WCH 1線デバッグ'), part: 'CH32V003F4P6', note: t('Choose one data line; there is no separate clock. The OEP spec and API call it SWIO. PD1 on the CH32V003. NRST may be turned off in the option bytes.', 'データ線1本を指定します。独立したクロック線は使いません。OEPの仕様・APIではSWIOと呼びます。CH32V003はPD1。NRSTはoption bytesで無効の場合があります。') },
  ];
  // The uses of a probe: what this page prepares for each, and the tool that does the work (page.ja.md §3, §6.6).
  USES = [
    { id: 'debug', title: t('Debug and write a target', 'ターゲットをデバッグ・書き込み'), prepare: t('Debug wiring, with a connection check', 'デバッグの配線と接続確認'), tool: t('IDE, Python', 'IDE・Python') },
    { id: 'logs', title: t('Read logs', 'ログを読む'), prepare: t('The log pass-through to the probe\'s serial port', 'プローブのシリアルポートへの素通し'), tool: t('Serial monitor, Python', 'シリアルモニタ・Python') },
    { id: 'capture', title: t('Capture waveforms', '波形を取る'), prepare: t('Signal names on the pins (optional)', 'ピンの信号名（任意）'), tool: 'WireSkein' },
    { id: 'bus', title: t('Talk to sensors and peripherals (I2C / SPI)', 'センサ・周辺ICと通信（I2C / SPI）'), prepare: t('I2C / SPI wiring', 'I2C / SPIの配線'), tool: 'Python' },
    { id: 'signal', title: t('Drive and measure signals', '信号を出す・測る'), prepare: t('Pin names, idle states, pins kept off', 'ピンの名前・待機状態・使わせないピン'), tool: 'Python' },
    { id: 'peer', title: t('Stand in for a peer device', '通信相手の代役になる'), prepare: t('I2C / SPI wiring', 'I2C / SPIの配線'), tool: 'Python' },
  ];
  DOCS = [
    [t('What OEP is for', 'OEPの目的と考え方'), t('What it makes common, and the interoperability it aims for.', '何を共通化し、どんな相互運用を目指すか。'), t('https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/project-concept.md', 'https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/project-concept.ja.md')],
    [t('Boards and pins', '対応ボードとピン'), t('Released firmware, each board\'s limits, usable pins.', '配布firmware、ボードごとの制約、利用できるピン。'), guide('boards')],
    [t('Protocol and standard interfaces', 'プロトコル・標準interface'), t('Declarations, transport, sessions and the standard functions.', '機能宣言、通信、セッションと標準の機能。'), 'https://github.com/Open-Embedded-Probe/oep-spec'],
    [t('Make or extend a probe', 'プローブを作る・拡張する'), t('The Arduino implementation, and how to add your own functions.', 'Arduino実装と、独自の機能を追加する方法。'), 'https://github.com/Open-Embedded-Probe/oep-probe-arduino'],
    [t('Use from JavaScript', 'JavaScriptから使う'), t('The library for using OEP from the browser or Node.', 'ブラウザやNodeからOEPを利用するライブラリ。'), 'https://github.com/Open-Embedded-Probe/oep-client-js'],
    [t('Python, CLI, automated tests', 'Python・CLI・自動テスト'), t('Use the same probe from scripts and tests.', 'スクリプトやテストから同じプローブを使う。'), 'https://github.com/Open-Embedded-Probe/oep-client-python'],
    [t('Capture and view waveforms', '波形の取得と表示'), t('WireSkein: capture in Python, view captured files in the browser.', 'WireSkein: Pythonで取得し、取得したファイルをブラウザで表示する。'), 'https://github.com/Open-Embedded-Probe/wireskein'],
    [t('Add your own commands', '独自のコマンドを追加する'), t('Define operations, inputs and results with SimpleInterface.', 'SimpleInterfaceで操作・入力項目・結果を定義する。'), guide('simple-interface')],
  ];
}
build();
onLanguage(build);
