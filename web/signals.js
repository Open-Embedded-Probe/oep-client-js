// Operation forms use the public host interfaces, never raw protocol requests.
import { fixture } from './oep-client.js';
import { hexBytes, integer } from './model.js';
const text = (en, ja) => ({ en, ja });
const number = (key, en, ja, value, min = 0, max = 0xffffffff) => ({ key, label: text(en, ja), value: String(value), min, max, kind: 'number' });
const hex = (key = 'data', value = '01 02') => ({ key, label: text('Bytes (hex)', 'データ（hex）'), value, kind: 'hex' });
const choice = (key, en, ja, options, value = '0') => ({ key, label: text(en, ja), options, value, kind: 'choice' });
const option = (v, en, ja = en) => [String(v), text(en, ja)];
const op = (id, en, ja, method, fields, run, write = true) => ({ id, label: text(en, ja), method, fields, run, write });
const status = op('status', 'Read status', '状態を読む', 'STATUS', [], (c) => c.status(), false);
const mode = () => choice('mode', 'SPI mode', 'SPI mode', [0, 1, 2, 3].map((n) => option(n, String(n))));
const order = () => choice('order', 'Bit order', 'ビット順', [option(0, 'MSB first', 'MSBから'), option(1, 'LSB first', 'LSBから')]);
const hz = (value) => number('hz', 'Clock (Hz)', 'クロック（Hz）', value, 1);
const address = () => number('address', '7-bit address', '7 bit アドレス', '0x50', 8, 119);
const length = () => number('length', 'Read bytes', '読むbyte数', 1, 1, 65535);
const outputRole = () => number('role', 'Output / input number', '出力・入力番号', 0, 0, 255);
export const SIGNALS = [
  { id: 'gpio', name: 'oep.fixture.gpio', title: text('GPIO', 'GPIO'), Class: fixture.Gpio,
    description: text('Read a pin or set its input / output mode.', 'ピンのレベルを読み、入力・出力のモードを設定します。'),
    operations: [
      op('set', 'Set mode', 'モードを設定', 'SET', [number('channel', 'Pin', 'ピン', 0, 0, 65534), choice('mode', 'Mode', 'モード', [
        option(0, 'Input', '入力'), option(1, 'Input pull-up', '入力・pull-up'), option(2, 'Input pull-down', '入力・pull-down'),
        option(3, 'Output low', '出力 Low'), option(4, 'Output high', '出力 High'), option(5, 'Open-drain low', 'open-drain Low'), option(6, 'Open-drain release', 'open-drain 解放')])],
        (c, v) => c.configure(v.channel, +v.mode)),
      op('read', 'Read level', 'レベルを読む', 'READ', [number('channel', 'Pin', 'ピン', 0, 0, 65534)], (c, v) => c.read([v.channel]), false),
    ] },
  { id: 'uart', name: 'oep.fixture.uart', title: text('UART', 'UART'), Class: fixture.FixtureUartIO,
    description: text('Assign RX / TX, then configure and exchange serial text or bytes.', 'RX・TXを割り当てて設定し、シリアルの文字やbyte列を送受信します。'),
    operations: [
      op('configure', 'Configure UART', 'UARTを設定', 'CONFIGURE', [number('baud', 'Baud rate', 'baud', 115200, 1),
        choice('bits', 'Data bits', 'データbit', [option(8, '8'), option(7, '7')], '8'), choice('parity', 'Parity', 'パリティ', [option('N', 'None', 'なし'), option('E', 'Even', '偶数'), option('O', 'Odd', '奇数')], 'N'),
        choice('stop', 'Stop bits', 'ストップbit', [option(1, '1'), option(2, '2')], '1')],
        (c, v) => c.configure(v.baud, fixture.FixtureUart.formatByte(/** @type {7 | 8} */ (+v.bits), v.parity, /** @type {1 | 2} */ (+v.stop)))),
      op('read', 'Receive', '受信する', 'READ', [], (c) => c.readAll(65536), false),
      op('send', 'Send', '送信する', 'WRITE', [{ key: 'text', kind: 'text', label: text('Text', '文字列'), value: '' },
        choice('ending', 'Line ending', '改行', [option('', 'None', 'なし'), option('lf', 'LF'), option('crlf', 'CR LF')], 'lf')],
        (c, v) => c.write(new TextEncoder().encode(v.text + (v.ending === 'crlf' ? '\r\n' : v.ending === 'lf' ? '\n' : '')))),
      op('hex', 'Send bytes', 'byte列を送信', 'WRITE', [hex()], (c, v) => c.write(v.data)),
      { ...status, run: (c) => c.uart.status() },
    ] },
  { id: 'i2c-controller', name: 'oep.fixture.i2c-controller', title: text('I2C controller', 'I2C 主'), Class: fixture.I2cController,
    description: text('Initiate transfers to an I2C device. Connect SDA / SCL and suitable pull-ups.', 'I2C機器へ転送します。SDA・SCLと適切なpull-upを接続します。'),
    operations: [op('configure', 'Configure bus', 'バスを設定', 'CONFIGURE', [hz(100000), number('timeout', 'Stretch timeout (µs)', 'stretch timeout（µs）', 1000)], (c, v) => c.configure(v.hz, v.timeout)),
      op('write', 'Write', '書く', 'TRANSFER', [address(), hex()], (c, v) => c.write(v.address, v.data)),
      op('read', 'Read', '読む', 'TRANSFER', [address(), length()], (c, v) => c.read(v.address, v.length)),
      op('writeRead', 'Write then read', '書いてから読む', 'TRANSFER', [address(), hex(), length()], (c, v) => c.writeRead(v.address, v.data, v.length)),
      op('stop', 'Send STOP', 'STOPを送る', 'TRANSFER', [], (c) => c.stop()), status] },
  { id: 'spi-controller', name: 'oep.fixture.spi-controller', title: text('SPI controller', 'SPI 主'), Class: fixture.SpiController,
    description: text('Clock bytes out on MOSI and read MISO, with CS controlled by the probe.', 'プローブがCSとクロックを制御して、MOSI・MISOのbyte列を送受信します。'),
    operations: [op('configure', 'Configure bus', 'バスを設定', 'CONFIGURE', [mode(), order(), hz(250000)], (c, v) => c.configure(+v.mode, +v.order, v.hz)),
      op('exchange', 'Exchange bytes', '送受信する', 'TRANSFER', [hex('data', '9f 00 00 00'), number('setup', 'CS setup (ns)', 'CS setup（ns）', 0), number('hold', 'CS hold (ns)', 'CS hold（ns）', 0)],
        (c, v) => c.transfer([{ tx: v.data, setupNs: v.setup, holdNs: v.hold }])), status] },
  { id: 'i2c-target', name: 'oep.fixture.i2c-target', title: text('I2C peer', 'I2C 相手'), Class: fixture.I2cTarget,
    description: text('Let your target control the bus; the probe answers at the address you choose.', 'ターゲットがバスを制御し、プローブが指定したアドレスで応答します。'),
    operations: [op('configure', 'Set address', 'アドレスを設定', 'CONFIGURE', [address()], (c, v) => c.configure(v.address)),
      op('preload', 'Queue response', '応答を投入', 'PRELOAD_TX', [hex()], (c, v) => c.preloadTx(v.data)),
      op('receive', 'Receive frame', 'フレームを読む', 'READ_RX', [], (c) => c.readRx()), status] },
  { id: 'spi-target', name: 'oep.fixture.spi-target', title: text('SPI peer', 'SPI 相手'), Class: fixture.SpiTarget,
    description: text('Arm a response and receive a transaction clocked by your target.', '応答データを用意し、ターゲットがクロックを出す取引を受信します。'),
    operations: [op('configure', 'Configure bus', 'バスを設定', 'CONFIGURE', [mode(), order()], (c, v) => c.configure(+v.mode, +v.order)),
      op('arm', 'Arm transaction', '受信を待つ', 'ARM', [number('length', 'Maximum bytes', '最大byte数', 16, 1, 65535), hex()], (c, v) => c.arm(v.length, v.data)),
      op('receive', 'Receive transaction', '受信結果を読む', 'READ_RX', [], (c) => c.readRx()), status] },
  { id: 'pwm', name: 'oep.fixture.pwm', title: text('PWM', 'PWM'), Class: fixture.Pwm,
    description: text('Generate a PWM signal. Stopping or releasing changes stops its output.', 'PWM信号を出します。停止や変更権の解放で出力を止めます。'),
    operations: [op('start', 'Start output', '出力を開始', 'SET', [outputRole(), number('hz', 'Frequency (Hz)', '周波数（Hz）', 1000, 1), number('duty', 'Duty (0–65535)', 'duty（0〜65535）', 32768, 0, 65535)], (c, v) => c.start(v.role, v.hz, v.duty)),
      op('stop', 'Stop output', '出力を停止', 'SET', [outputRole()], (c, v) => c.stop(v.role)), status] },
  { id: 'counter', name: 'oep.fixture.counter', title: text('Edge counter', 'カウンタ'), Class: fixture.Counter,
    description: text('Count input edges over a chosen interval and read the actual gate time.', '指定した窓の間、入力のエッジを数えます。実際の計測時間も確認できます。'),
    operations: [op('measure', 'Measure', '計測する', 'MEASURE', [number('gate', 'Gate time (µs)', '計測窓（µs）', 100000, 1),
      choice('edge', 'Edge', 'エッジ', [option(0, 'Rising', '立上り'), option(1, 'Falling', '立下り'), option(2, 'Both', '両方')])], (c, v) => c.measure(v.gate, +v.edge))] },
  { id: 'dac', name: 'oep.fixture.dac', title: text('DAC', 'DAC'), Class: fixture.Dac,
    description: text('Set an analog output using the declared resolution and voltage range.', '宣言された分解能と電圧範囲に従い、アナログ値を出力します。'),
    operations: [op('set', 'Set output', '出力を設定', 'SET', [outputRole(), number('value', 'Raw value', 'raw値', 0)], (c, v) => c.set([[v.role, v.value]])), status] },
];
/** Parse every field before performing any device operation. */
export function valuesFor(fields, values) {
  return Object.fromEntries(fields.map((f) => [f.key, f.kind === 'number' ? integer(values[f.key], f.min, f.max)
    : f.kind === 'hex' ? hexBytes(values[f.key]) : values[f.key]]));
}
