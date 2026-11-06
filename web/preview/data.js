// Presentation data only. This preview never imports device transports or firmware programmers.
export const BOARDS = [
  { id: 'pico', name: 'Raspberry Pi Pico', chip: 'RP2040 / RP2350', tag: 'USBで始める', title: '小さなボードで、ひと通り試す。',
    description: 'デバッグ、UART、GPIOやバス通信をひとつのボードで。Pico 2も同じ流れで始められます。',
    features: ['SWD / RVSWD / SWIO', 'GPIO・UART・I2C・SPI', 'ロジック・アナログ取得'],
    note: 'UARTは使えるピンの組が決まっています。DAC出力はありません。', install: 'BOOTSELボタンを押しながらUSBを接続', port: 'Pico本体のUSB端子', handoff: 'permission', installable: true, model: 'Raspberry Pi Pico 2', code: 'RP2350' },
  { id: 'esp32', name: 'ESP32', chip: 'classic ESP32', tag: '手元のボードを使う', title: 'USBシリアルから、そのまま設定へ。',
    description: 'ESP32-DevKitCなどをプローブに。通信や信号の確認に加えて、Wi-FiやDACの用途も。',
    features: ['SWD / RVSWD / SWIO', 'GPIO・UART・I2C・SPI', 'Wi-Fi設定・DAC出力'],
    note: '入力専用ピンがあります。高速なデータ取得には転送速度の制約があります。', install: 'データ通信できるUSBケーブルで接続', port: 'ボードの書き込み用USB端子', handoff: 'direct', installable: true, model: 'ESP32-DevKitC', code: 'ESP32' },
  { id: 'p4', name: 'ESP32-P4 / P4X', chip: 'ESP32-P4', tag: '観測・治具の用途に', title: '通信と観測を、ひとつの治具に。',
    description: '高速USBや多チャネルの観測に対応する構成。シリアルから導入し、同じ経路で設定を続けます。',
    features: ['SWD / RVSWD / SWIO', 'UART 2系統・バス通信', '高速USB・ロジック取得'],
    note: 'P4とP4Xは画像が異なります。チップのrevisionを確認して選びます。UART有効化はfirmware側で対応中です。', install: '書き込みに使えるUSB端子へ接続', port: '書き込みに使ったシリアルポート', handoff: 'direct', installable: true, model: 'ESP32-P4X', code: 'P4X' },
  { id: 's3', name: 'ESP32-S3 / C3 / C6', chip: '独自のOEP構成', tag: '互換画像を持っている方', title: '自分の構成を、OEPにつなぐ。',
    description: '互換firmwareの持ち込み用。共通の配布OepProbe画像はなく、画像によって使える機能も異なります。',
    features: ['画像で機能が変わる', '互換merged画像を使用', '起動後のUSB構成に注意'],
    note: 'このプレビューでは、S3が起動後にOEPのUSB機器へ切り替わる例を表示します。', install: '対応画像と、書き込み用USB端子を確認', port: 'ボードの書き込み用USB端子', handoff: 'replug', installable: true, model: 'ESP32-S3（構成例）', code: 'S3' },
  { id: 'ch32', name: 'WCH CH32', chip: 'X035 / V307 / H417', tag: '導入済みの機器向け', title: '小さなプローブの実装にも。',
    description: '機種により機能や保存の制約が異なります。配布firmwareはありますが、このページでの初回書き込みは対象外です。',
    features: ['機種別の機能構成', '設定保存に制約あり', '導入済みなら接続可能'],
    note: '実機で確認した範囲はボード資料を参照してください。', install: '', port: '', handoff: 'direct', installable: false, model: 'CH32V307（構成例）', code: 'CH32' },
];
export const TASKS = [
  { id: 'uart', num: '01', title: 'ログを読む・コマンドを送る', short: 'UART', description: '相手の起動ログを読み、文字やバイト列を送ります。', result: '時刻付きの受信ログ', category: '通信', roles: ['RX', 'TX'], options: [['通信速度（baud）', '115200'], ['データ形式', '8 bit / parityなし / 1 stop']], action: '受信を開始', stop: '受信を停止', output: '[00:00.021] boot: ready\n[00:00.048] sensor initialized\n[00:01.050] temperature: 24.6 °C' },
  { id: 'i2c', num: '02', title: 'センサなどのI2C機器と通信', short: 'I2C', description: 'プローブが通信を開始して、相手のレジスタなどを読み書きします。', result: '送受信したバイトと応答', category: '通信', roles: ['SDA', 'SCL'], options: [['7 bitアドレス', '0x48'], ['クロック（Hz）', '100000'], ['送信データ（hex）', '00'], ['読み取りバイト数', '2']], action: '書いてから読む', stop: 'バスの使用を終了', output: 'TX  00\nRX  18 A0\nACK  受信を確認しました' },
  { id: 'spi', num: '03', title: 'SPI機器とデータを交換', short: 'SPI', description: 'プローブがCSとクロックを出し、MOSI / MISOでデータを交換します。', result: '送信と対応する受信データ', category: '通信', roles: ['MOSI', 'MISO', 'SCK', 'CS'], options: [['SPI mode', '0'], ['クロック（Hz）', '250000'], ['送信データ（hex）', '9F 00 00 00']], action: '送受信する', stop: 'バスの使用を終了', output: 'TX  9F 00 00 00\nRX  00 EF 40 16\nCS  転送終了' },
  { id: 'gpio', num: '04', title: 'ピンの状態を読む・切り替える', short: 'GPIO', description: '入力を確認したり、相手の制御ピンにLow / Highを出したりします。', result: 'ピンごとの状態', category: '信号', roles: ['GPIO'], options: [['モード', '入力（pull-up）']], action: 'モードを適用して読む', stop: 'ピンを解放', output: 'GPIO 4  →  HIGH\nmode: 入力（pull-up）' },
  { id: 'pwm', num: '05', title: 'PWM信号を出す', short: 'PWM', description: '周波数とdutyを指定して、繰り返す信号を出力します。', result: '出力中の設定値', category: '信号', roles: ['OUT'], options: [['周波数（Hz）', '1000'], ['duty（%）', '50']], action: '出力を開始', stop: '出力を停止', output: '出力中（サンプル）\n周波数: 1,000 Hz / duty: 50 %' },
  { id: 'counter', num: '06', title: 'パルスを数える', short: 'カウンタ', description: '一定時間のエッジ数を計測し、信号の頻度を確かめます。', result: 'カウントと実計測時間', category: '信号', roles: ['IN'], options: [['計測窓（ms）', '100'], ['エッジ', '立上り']], action: '計測する', stop: 'ピンを解放', output: '100 edges / 100.00 ms\n算出周波数: 1.00 kHz（サンプル）' },
  { id: 'dac', num: '07', title: 'アナログ値を出す', short: 'DAC', description: '対応プローブのDACで出力値を設定します。実測値とは区別します。', result: '設定値と出力状態', category: '信号', roles: ['OUT'], options: [['設定値（8 bitの例）', '128']], action: '出力を適用', stop: '出力を終了', output: '設定値: 128 / 255\nサンプル設定値です。電圧を実測した結果ではありません。' },
  { id: 'debug', num: '08', title: 'ターゲットをデバッグ', short: 'デバッグ', description: '固定配線で接続し、停止・再開やメモリの確認を行います。', result: 'ターゲットの応答と実行状態', category: 'デバッグ', roles: ['SWDIO', 'SWCLK', 'NRST'], options: [['デバッグ方式', 'SWD（対応ARMの例）'], ['速度（kHz）', '1000']], action: 'ターゲットに接続', stop: 'ターゲットを切り離す', output: '対象: ARM Cortex-M（サンプル）\n状態: 接続済み / 実行中' },
  { id: 'peer', num: '09', title: 'I2C / SPIの相手機器になる', short: '相手機器として応答', description: '開発中の基板が通信を開始し、プローブがセンサなどの代役として応答します。', result: '相手から来た要求と返したデータ', category: '通信', roles: ['SDA', 'SCL'], options: [['方式', 'I2C target'], ['応答アドレス', '0x48'], ['応答データ（hex）', '18 A0']], action: '待ち受けを開始', stop: '待ち受けを停止', output: '待ち受け中（サンプル）\n要求: READ 0x48 / 2 bytes\n応答: 18 A0' },
];
export const SCENARIOS = [
  ['auto', 'ボードに応じた流れ'], ['direct', '同じポートで自動続行'], ['permission', '起動後のOEPを再許可'],
  ['replug', 'USB構成変更 → 抜き差し → 許可'], ['timeout', '書込成功 → 接続待ちから再試行'],
];
export const DOCS = [
  ['OEPの目的と考え方', '何を共通化し、どんな相互運用を目指すか。', 'https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/project-concept.ja.md'],
  ['対応ボードとピン', '配布firmware、ボードごとの制約、利用できるピン。', 'https://github.com/Open-Embedded-Probe/oep-probe-arduino/blob/main/docs/guide/boards.ja.md'],
  ['プロトコル・標準interface', '機能宣言、通信、セッションと標準の機能。', 'https://github.com/Open-Embedded-Probe/oep-spec'],
  ['プローブを作る・拡張する', 'Arduino実装と、独自の機能を追加する方法。', 'https://github.com/Open-Embedded-Probe/oep-probe-arduino'],
  ['JavaScriptから使う', 'ブラウザやNodeからOEPを利用するライブラリ。', 'https://github.com/Open-Embedded-Probe/oep-client-js'],
  ['Python・CLI・自動テスト', 'スクリプトやテストから同じプローブを使う。', 'https://github.com/Open-Embedded-Probe/oep-client-python'],
];
