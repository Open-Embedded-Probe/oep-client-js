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
  { id: 'p4', name: 'ESP32-P4 / P4X', chip: 'ESP32-P4', tag: '推奨ボード', recommended: true, title: '通信と観測を、ひとつの治具に。',
    description: '高速USBや多チャネルの観測に対応する構成。シリアルから導入し、同じ経路で設定を続けます。',
    features: ['SWD / RVSWD / SWIO', 'UART 2系統・バス通信', '高速USB・ロジック取得'],
    note: 'P4とP4Xはファームウェアイメージが異なります。チップのrevisionを確認して選びます。UART bridgeはfirmwareで既定有効です。配布版と実機経路の確認は別途必要です。', install: '書き込みに使えるUSB端子へ接続', port: '書き込みに使ったシリアルポート', handoff: 'direct', installable: true, model: 'ESP32-P4', code: 'P4' },
  { id: 's3', name: 'ESP32-S3 / C3 / C6', chip: '独自のOEP構成', tag: '互換ファームウェアイメージを持っている方', title: '自分の構成を、OEPにつなぐ。',
    description: '互換firmwareの持ち込み用。共通の配布OepProbeファームウェアイメージはなく、ファームウェアイメージによって使える機能も異なります。',
    features: ['ファームウェアイメージで機能が変わる', '互換mergedファームウェアイメージを使用', '起動後のUSB構成に注意'],
    note: 'このプレビューでは、S3が起動後にOEPのUSB機器へ切り替わる例を表示します。', install: '対応ファームウェアイメージと、書き込み用USB端子を確認', port: 'ボードの書き込み用USB端子', handoff: 'replug', installable: true, model: 'ESP32-S3（構成例）', code: 'S3' },
  { id: 'ch32', name: 'WCH CH32', chip: 'X035 / V307 / H417', tag: '導入済みの機器向け', title: '小さなプローブの実装にも。',
    description: '機種により機能や保存の制約が異なります。配布firmwareはありますが、このページでの初回書き込みは対象外です。',
    features: ['機種別の機能構成', '設定保存に制約あり', '導入済みなら接続可能'],
    note: '実機で確認した範囲はボード資料を参照してください。', install: '', port: '', handoff: 'direct', installable: false, model: 'CH32V307（構成例）', code: 'CH32' },
];
BOARDS.sort((a, b) => Number(b.id === 'p4') - Number(a.id === 'p4'));
export const TASKS = [
  { id: 'uart', num: '01', title: 'ログを読む・コマンドを送る', short: 'UART', description: 'プローブとターゲットの間でUARTを転送し、PCでログを読んだりコマンドを送ったりします。', result: '時刻付きの受信ログ', category: '通信', roles: ['RX', 'TX'], options: [['通信速度（baud）', '115200'], ['データ形式', '8 bit / parityなし / 1 stop']], action: '受信を開始', stop: '受信を停止', output: '[00:00.021] boot: ready\n[00:00.048] sensor initialized\n[00:01.050] temperature: 24.6 °C' },
  { id: 'i2c', num: '02', title: 'センサなどのI2C機器と通信', short: 'I2C', description: 'プローブが通信を開始して、相手のレジスタなどを読み書きします。', result: '送受信したバイトと応答', category: '通信', roles: ['SDA', 'SCL'], options: [['7 bitアドレス', '0x48'], ['クロック（Hz）', '100000'], ['送信データ（hex）', '00'], ['読み取りバイト数', '2']], action: '書いてから読む', stop: 'バスの使用を終了', output: 'TX  00\nRX  18 A0\nACK  受信を確認しました' },
  { id: 'spi', num: '03', title: 'SPI機器とデータを交換', short: 'SPI', description: 'プローブがCSとクロックを出し、MOSI / MISOでデータを交換します。', result: '送信と対応する受信データ', category: '通信', roles: ['MOSI', 'MISO', 'SCK', 'CS'], options: [['SPI mode', '0'], ['クロック（Hz）', '250000'], ['送信データ（hex）', '9F 00 00 00']], action: '送受信する', stop: 'バスの使用を終了', output: 'TX  9F 00 00 00\nRX  00 EF 40 16\nCS  転送終了' },
  { id: 'gpio', num: '04', title: 'ピンの状態を読む・切り替える', short: 'GPIO', description: '入力を確認したり、相手の制御ピンにLow / Highを出したりします。', result: 'ピンごとの状態', category: '信号', roles: ['GPIO'], options: [['モード', '入力（pull-up）']], action: 'モードを適用して読む', stop: 'ピンを解放', output: 'GPIO 4  →  HIGH\nmode: 入力（pull-up）' },
  { id: 'pwm', num: '05', title: 'PWM信号を出す', short: 'PWM', description: '周波数とdutyを指定して、繰り返す信号を出力します。', result: '出力中の設定値', category: '信号', roles: ['OUT'], options: [['周波数（Hz）', '1000'], ['duty（%）', '50']], action: '出力を開始', stop: '出力を停止', output: '出力中（サンプル）\n周波数: 1,000 Hz / duty: 50 %' },
  { id: 'counter', num: '06', title: 'パルスを数える', short: 'カウンタ', description: '一定時間のエッジ数を計測し、信号の頻度を確かめます。', result: 'カウントと実計測時間', category: '信号', roles: ['IN'], options: [['計測窓（ms）', '100'], ['エッジ', '立上り']], action: '計測する', stop: 'ピンを解放', output: '100 edges / 100.00 ms\n算出周波数: 1.00 kHz（サンプル）' },
  { id: 'dac', num: '07', title: 'アナログ値を出す', short: 'DAC', description: '対応プローブのDACで出力値を設定します。実測値とは区別します。', result: '設定値と出力状態', category: '信号', roles: ['OUT'], options: [['設定値（8 bitの例）', '128']], action: '出力を適用', stop: '出力を終了', output: '設定値: 128 / 255\nサンプル設定値です。電圧を実測した結果ではありません。' },
  { id: 'debug', num: '08', title: 'ターゲットをデバッグ', short: 'デバッグ', description: '固定配線で接続し、停止・再開やメモリの確認を行います。', result: 'ターゲットの応答と実行状態', category: 'デバッグ', roles: [], options: [['速度上限（kHz、空欄は自動）', '']], action: 'ターゲットに接続', stop: 'ターゲットを切り離す', output: '対象: ARM Cortex-M（サンプル）\n状態: 接続済み / 実行中' },
  { id: 'peer', num: '09', title: 'I2C / SPIの相手機器になる', short: '相手機器として応答', description: '開発中の基板が通信を開始し、プローブがセンサなどの代役として応答します。', result: '相手から来た要求と返したデータ', category: '通信', roles: ['SDA', 'SCL'], options: [['方式', 'I2C target'], ['応答アドレス', '0x48'], ['応答データ（hex）', '18 A0']], action: '待ち受けを開始', stop: '待ち受けを停止', output: '待ち受け中（サンプル）\n要求: READ 0x48 / 2 bytes\n応答: 18 A0' },
];
export const DEBUG_WIRES = [
  { id: 'swd', short: 'SWD', title: 'SWD（2線）', description: 'SWDに対応するARMターゲット向け。例: STM32。', roles: ['SWDIO', 'SWCLK'], target: 'ARM Cortex-M', part: 'STM32F103C8T6', note: 'データ線とクロック線を指定します。必要な場合だけ、別途NRSTを追加します。ARM用のflash loader・GDB serverは現行ツールにありません。' },
  { id: 'rvswd', short: 'RVSWD', title: 'RVSWD（2線）', description: '2線デバッグに対応するWCH RISC-V向け。例: CH32V203。', roles: ['SWDIO', 'SWCLK'], target: 'WCH RISC-V', part: 'CH32V203C8T6', note: 'SWDとは異なる方式です。同じ信号名でも互換ではありません。待機状態と速度は通常プローブ・道具に任せます。CH32X035はPC18/PC19、CH32V203はPA13/PA14の例です。' },
  { id: 'swio', short: '1線DIO（SWIO）', title: '1線DIO（SWIO）', description: '1線デバッグに対応するWCHターゲット向け。例: CH32V003。', roles: ['DIO'], target: 'WCH 1線デバッグ', part: 'CH32V003F4P6', note: 'データ線1本を指定します。独立したクロック線は使いません。OEPの仕様・APIではSWIOと呼びます。CH32V003はPD1。NRSTはoption bytesで無効の場合があります。' },
];
export const LOGIC_TASK = { id: 'logic', short: 'ロジックアナライザ', description: '繰り返し使う観測配線に名前を付けます。今回だけの取得には登録不要です。', roles: ['CH0', 'CH1', 'CH2', 'CH3'], options: [] };
export const SETUP_PATTERNS = [
  { id: 'debug', title: 'ターゲットをデバッグする', label: 'SWD / RVSWD / 1線DIO', description: '開発中のICの実行を止め、内部の状態を調べる。', next: '自動検索 / ピンを明示 → 任意の接続確認 → 保存・デバッグ' },
  { id: 'logs', title: 'ログを読む・コマンドを送る', label: 'UART / デバッグ線 / 素通し', description: '相手がログを出す方法と、使う道具に合わせて選ぶ。', next: 'ログの経路 → 配線 → 操作条件、または素通しの本体設定' },
  { id: 'logic', title: '波形・タイミングを観測する', label: 'ロジックアナライザ', description: '動作中の信号を入力として取り込み、通信やタイミングを調べる。', next: '今回だけ取る / 名前付き配線を使う → 取得条件 → WireSkein' },
  { id: 'bus', title: 'センサ・周辺ICと通信する', label: 'I2C / SPI コントローラ', description: 'プローブから通信を開始して、レジスタやデータを読み書きする。', next: '相手のバス方式 → 配線・通信条件 → 読み書き', tasks: ['i2c', 'spi'] },
  { id: 'signal', title: '信号を出す・状態を測る', label: 'GPIO / PWM / カウンタ / DAC', description: 'ピンの状態を確認・制御したり、パルスやアナログ値を扱ったりする。', next: '出したい・測りたい信号 → ピン・条件 → 操作', tasks: ['gpio', 'pwm', 'counter', 'dac', 'analog'] },
  { id: 'peer', title: '通信相手の代役になる', label: 'I2C / SPI レスポンダ', description: '開発中の基板からの要求に応答し、センサなどの代わりとして試す。', next: '応答側の方式 → 配線・応答データ → 待ち受け（今回はI2Cの例）' },
];
export const GUIDE_BASE = 'https://github.com/Open-Embedded-Probe/oep-probe-arduino/blob/main/docs/guide/';
// Public explanations use the same purpose categories as setup, before any device permission.
export const USE_CASE_DETAILS = {
  debug: { example: '開発中のICが途中で止まる理由を調べたい。', needs: '相手の型番とデバッグ方式、対応する信号線、共通GND。相手の電圧も確認します。', result: '接続状態、停止・再開、メモリなどの内部状態。', scope: 'このページでは配線と接続条件を準備し、基本操作へ進みます。CH32の書き込み・GDBはch32rv等へ。現行ツールにARM用flash loader・GDB serverはありません。', steps: ['スキャンして自動検索するか、分かっているピンを明示する', '相手の方式（SWD / 2線RVSWD / 1線DIO）と配線を決める', '必要なら接続確認する。確認せず保存しても、保存せず操作へ進んでもよい'], guide: 'debug-targets.ja.md' },
  logs: { example: '起動ログを読みたい。対話コマンドを送りたい。', needs: '相手のログ出力方法。UARTなら速度とTX/RX、デバッグ線ならRVSWD / SWIOと対応する出力実装。', result: '受信したログと、対応する経路でのコマンド送信。', scope: 'このページでUART・デバッグ線のログを扱います。普通のシリアルモニタを使う場合は本体の素通し設定へ。素通しは相手からPCへの一方向です。', steps: ['UART・デバッグ線・シリアルモニタ向け素通しを選ぶ', '経路に合う配線を用意する。UARTのTXは送信する場合だけ', '操作の通信条件、または素通しの本体設定を確認する'], guide: 'use-cases.ja.md' },
  logic: { example: '通信のタイミングや、リセット前後の波形を確かめたい。', needs: '観測する信号と共通GND、対応プローブ、取得用のWireSkein環境。', result: '信号名・実際のサンプルレート・トリガ位置を含む波形ファイル。', scope: 'このページでは信号と取得条件を整理します。取得は外部のWireSkein環境、ファイルの表示・解析はWireSkeinのビューアへ進みます。操作との同時取得や自動テストはPythonで組み立てます。', steps: ['今回だけのピン指定・登録済み配線・操作と同時・自動テストから選ぶ', '信号と取得条件を準備する。本体設定や配線登録は必須ではない', '外部環境で取得し、波形を表示・解析する'], guide: 'capture.ja.md' },
  bus: { example: 'センサの値や、周辺ICの識別情報を読みたい。', needs: '相手のデータシート、I2C / SPIの配線、アドレスや通信形式。', result: '送受信したデータと、応答の有無。', scope: 'このページからプローブが通信を開始します。開発中の基板が通信を開始する場合は「通信相手の代役になる」を選びます。', steps: ['I2CかSPIを選ぶ', '配線を指定する。繰り返し使うなら名前を付ける', 'アドレス・クロック・送受信データを指定して通信する'], guide: 'use-cases.ja.md' },
  signal: { example: 'ピンの状態を確かめたい。信号を出したり、変化を測ったりしたい。', needs: '入力か出力か、信号の電圧、対応するGPIO・PWM・カウンタ・DAC・ADC。', result: '入力状態、出力設定、パルス数、またはアナログ波形。', scope: 'GPIO・PWM・カウンタ・DACはこのページで操作します。アナログ波形の取得は条件を整理してWireSkeinへ。使えるピンと範囲はプローブにより異なります。', steps: ['状態確認・信号出力・パルス計測・アナログ取得から選ぶ', '役割に合うピンと条件を指定する', '内容を確認して開始する。継続出力は使用後に停止する'], guide: 'use-cases.ja.md' },
  peer: { example: '開発中の基板を、まだ用意できないセンサの代役につなぎたい。', needs: '基板側が使うI2C / SPIの仕様、応答するデータ、対応プローブ。', result: '基板から受けた要求と、プローブが返した応答。', scope: '基板が通信を開始し、プローブが応答します。現在の画面プレビューはI2Cの例です。SPI応答側の画面は今後追加します。', steps: ['相手から要求される通信方式と応答を確認する', '配線を指定する。繰り返し使うなら名前を付ける', '応答アドレスとデータを指定して待ち受ける'], guide: 'use-cases.ja.md' },
};
export const CONSOLE_TASK = { id: 'console', short: 'デバッグ線ログ', title: 'デバッグ線でログを読む', description: 'UARTを使わず、WCHのdebug module経由で相手が出すログを読みます。相手側にも対応する出力実装が必要です。', roles: [], options: [], action: 'ログの受信を開始', stop: 'ログの受信を停止', output: '[サンプル] debug console: ready', result: 'debug module経由のログ', category: '通信' };
export const ANALOG_TASK = { id: 'analog', short: 'アナログ取得', title: 'アナログ電圧を取り込む', description: '対応するADCピンで電圧の変化を取り込みます。取り込み中は他の機能と同じピンを共有できません。', roles: ['AIN'], options: [], result: '電圧の波形', category: '信号' };
export const LOG_PATHS = [
  ['uart', 'UARTで読む・送る', '相手TX → プローブRX。送る場合だけ相手RXへのTXも接続。速度・形式は操作時に指定。'],
  ['console', 'デバッグ線で読む・送る', 'RVSWD / 1線DIOの配線を使い、相手の出力方式を選択。sdiは受信のみ、dmdata / dmseqは双方向。'],
  ['passthrough', '普通のシリアルモニタで見る', 'UARTまたはデバッグ線のログを、OEPセッションがない間だけシリアルポートへ流す本体設定。相手 → PCの一方向。'],
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
  ['独自のコマンドを追加する', 'SimpleInterfaceで操作・入力項目・結果を定義する。', GUIDE_BASE + 'simple-interface.ja.md'],
];
