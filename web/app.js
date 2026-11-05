// @ts-check
// OEP Probe Tool: what OEP is, the boards that can be probes, writing their firmware, connecting a probe, wiring and
// naming its targets, its settings, and the way to the tools (WireSkein for capture, the cores, oep-client-python).
// The screens and the words: docs/page.ja.md. Everything goes through oep-client-js.
import {
  VERSION, settings, core, dump, fixture, openWebHid, openWebSerial, openWebUsb, parseFirmwareManifest, pickFirmware,
  requestDfuDevice, dfuUpdate, verifyFirmware, Rejected, Unavailable, raiseSpeed, speedText, riscv, arm, memo, requestRp2Boot,
  rp2Write, rp2ResetToBoot, getUsbProbes, requestUsbProbe, getDfuDevices, RP2_BOOT_VID, RP2_BOOT_PID,
} from './oep-client.js';
import { BOARDS, FEATURES, boardOf } from './boards.js';

const WIRESKEIN_VIEWER = 'https://open-embedded-probe.github.io/wireskein-web/';

// ---- words (docs/page.ja.md §5: no spec words on the screens but the details) ----------------------------------------

const WORDS = {
  en: {
    navAbout: 'What OEP is',
    navStart: 'Get started',
    heroLead: 'One protocol for development probes - debuggers, logic analyzers, test fixtures. Write the OEP firmware to a Raspberry Pi Pico or an ESP32 board, and every tool that speaks OEP can debug your target chip, drive its pins and capture its signals through it.',
    heroStart: 'Get started',
    heroConnect: 'Connect a probe',
    aboutTitle: 'What OEP is',
    about1: 'A probe says what it can do',
    about1Desc: 'It lists its debug lines, pins and captures; a tool reads the list and needs no driver for that probe.',
    about2: 'Every tool, the same way',
    about2Desc: 'Debuggers, test scripts and waveform viewers use any OEP probe alike. The knowledge of your target chip stays in the tool.',
    about3: 'A cheap board becomes a probe',
    about3Desc: 'A Raspberry Pi Pico or an ESP32 board with the OEP firmware is a probe; this page writes it.',
    featuresTitle: 'What a probe can do',
    tierRelease: 'Released firmware',
    tierBuild: 'Build it yourself',
    pageBuild: 'build an example',
    startTitle: 'Get started',
    st1: '1. Write the firmware',
    st1Desc: 'Pick your board in "Boards" above or here; the latest release is written. A board that is already an OEP probe: connect it (step 2) and update it.',
    st2: '2. Connect the probe',
    st3: '3. Wire and name your target',
    st3Desc: 'Wire the target\'s debug lines to free pins, find it, and give the connection a name.',
    st4: '4. Use it from your tools',
    st4Desc: 'Capture with WireSkein, write and debug with the cores, script with Python - with the address.',
    toolsTitle: 'Tools and documents',
    toolWireskein: 'Capture, view and check signals (its own page).',
    toolPython: 'The Python host: the library and the oep command.',
    toolArduino: 'The probe firmware, and the library to build your own.',
    toolSpec: 'The OEP specification.',
    lockHint: 'To change the probe (find a target, save names), tick "Allow changes" at the top right.',
    tagline: 'Turn a board into an OEP probe, wire your target to it, and reach it from your tools.',
    unsupported: 'This browser has no WebUSB / Web Serial / WebHID. Use Chrome or Edge, over HTTPS or localhost.',
     navBoards: 'Boards', navProbe: 'My probe',
    notConnected: 'Not connected', disconnect: 'Disconnect', takeLock: 'Allow changes', locked: 'changes allowed', noLock: 'read only',
    
    
    diagHost: 'your tools', diagProbe: 'OEP probe', diagWires: 'wires', diagTarget: 'your target chip',
     
     
     
       
        
     
    
    
    
    
    
    
    
    feat_debug: 'Stop the target chip, read and write its memory and registers, write its flash.',
    feat_fixture: 'Drive and read the target\'s pins for tests: GPIO, UART, I2C / SPI, PWM, counting edges.',
    feat_capture: 'Record signals as waveforms - logic and analog - to view and check them in WireSkein.',
    feat_store: 'Keep the pin names and the tools\' records in the probe, so they go with it to any computer.',
    boardsTitle: 'Boards that can be OEP probes', boardsLead: 'Boards with released firmware, and boards you build an example for. Pick one for what it can do, its pins and how to write it.',
    compare: 'Compare the boards', verified: 'checked on hardware', notVerified: 'builds and host tests only',
    pageWrites: 'written from this page', pageUpdates: 'updated from this page', pageNot: 'written with its own tools',
    bChip: 'Chip', bUsb: 'Connects by', bPins: 'Pins for your target', bReserved: 'Pins it keeps', bWrite: 'Writing the firmware', bFeatures: 'What it can do',
    yes: 'yes', no: 'no', writeThis: 'Write this board',
    probeTitle: 'My probe', probeTargets: 'Targets on this probe', noTargets: 'None yet.',
    pModel: 'Board', pUnit: 'Unit id', pFirmware: 'Firmware', pLatest: 'latest', pUpdate: 'update available', pVia: 'Connected by',
    actTarget: 'Add a target', actTargetDesc: 'Wire, find and name a target chip.',
    actFirmware: 'Update the firmware', actFirmwareDesc: 'The latest release, picked for this probe.',
    actSettings: 'Settings', actSettingsDesc: 'Read, change, save, back up and restore the probe\'s settings.',
    actTry: 'Try the pins', actTryDesc: 'GPIO, UART and the serial speed, by hand.',
    actDetails: 'Details', actDetailsDesc: 'Everything the probe declares, as text or JSON.',
    
    connectLead: 'Plug the probe in by USB and press Connect; in the browser\'s list choose "OEP probe".',
    connectHint: 'Serial: a probe behind a USB-UART bridge (the classic ESP32). HID: where USB is not allowed.',
    connectUsb: 'Connect', connectSerial: 'Serial', connectHid: 'HID', connected: 'Connected:',
    needProbe: 'Connect a probe first.',
    targetTitle: 'Add a target', targetLead: 'Wire the target, find it on the pins you wired, and name the connection.',
    tg1: '1. Wire', tg1Hint: 'Connect the target\'s debug lines and GND to free pins: SWDIO and SWCLK (two wires: RVSWD for WCH RISC-V, SWD for ARM) or SWIO (one wire, CH32V00x). Tick the pins you used. Pins with a name are in use.',
    tg2: '2. Find', tg2Hint: 'Only the pins ticked are tried, both ways round. Allow changes first.', setupScan: 'Find the target', setupWire: 'debug line',
    tg3: '3. Name', tg3Hint: 'A connection name (a letter, then letters, digits or -, up to 16): its pins are named from it and saved in the probe; the part number and note are kept in the probe for every tool.',
    setupPort: 'connection name', setupPart: 'part number', setupNote: 'note', setupApply: 'Save',
    tg4: '4. Its address', tg4Hint: 'Tools reach the target with this address, from any computer the probe is plugged into.',
    setupNoScan: 'This probe cannot search on that debug line.', setupNoPins: 'Tick at least the two pins of one line pair.',
    setupNothing: 'No chip answered: check the wiring, GND and the target\'s power.', setupPick: 'Pick a chip that was found first.',
    pinUsed: 'in use', pinFree: 'free',
    firmwareTitle: 'Firmware', fwThisProbe: 'The connected probe', fwUpdate: 'Update to the latest', fwNew: 'A board without OEP firmware yet',
    fwBoard: 'board', fwNewWrite: 'Write', fwRelease: 'Latest release:', fwUpToDate: 'up to date', fwCannot: 'This board cannot be written from this page.',
    fwRp2Hold: 'Hold BOOTSEL while plugging the board in, then choose "RP2 Boot".',
    useTitle: 'Use it from your tools',
    useWireskein: 'WireSkein: capture signals (on its own page)',
    useWireskeinHow: 'Capture with the probe, save it and view it. The channels are the probe\'s pins or pin names.',
    useViewer: 'Open the WireSkein viewer', useCore: 'ArduinoCore-CH32RV: write and inspect a CH32 target', usePython: 'oep-client-python: from Python and the command line',
    describeRun: 'Read everything it declares', saveJson: 'Save as JSON', read: 'Read', saveToProbe: 'Save in the probe',
    unsetAll: 'Clear all (save after it to empty the stored settings)', fixedValues: 'values fixed by the probe (cannot be changed)',
    exportFile: 'Back up to a file', importFile: 'Restore from a file', importAsk: 'Make the probe\'s settings this file\'s?', addItem: 'Set a value',
    category: 'category', item: 'item', key: 'which', value: 'value',
    secretHint: 'A secret: the probe never gives it back and this page never shows it. Left empty, the value it has is kept.',
    set: 'Set', remove: 'Remove', configure: 'Configure', send: 'Send',
    gpioHint: 'Take the pin for GPIO first (it is kept while connected). Allow changes first.', gpioPlan: 'Take the pin',
    uartHint: 'The UART needs its RX / TX pins taken while connected.',
    speedTitle: 'Serial speed', speedHint: 'A probe behind a USB-UART bridge can run faster while connected: each rate is tried and kept only after full frames ran 1 s each way at it. The default is 500000.',
    speedTry: 'Try the rates',
  },
  ja: {
    navAbout: 'OEP とは',
    navStart: 'はじめ方',
    heroLead: 'デバッガ、ロジックアナライザ、治具のような開発用のプローブのための、ひとつのプロトコルです。Raspberry Pi Pico や ESP32 のボードに OEP の firmware を書くと、OEP を話すどの道具からも、そのボードを通してターゲットのチップをデバッグし、ピンを動かし、信号を取れます。',
    heroStart: 'はじめる',
    heroConnect: 'プローブをつなぐ',
    aboutTitle: 'OEP とは',
    about1: 'プローブが、できることを名乗る',
    about1Desc: 'デバッグの線、ピン、キャプチャを一覧で名乗ります。道具はその一覧を読むので、プローブごとのドライバが要りません。',
    about2: 'どの道具も、同じ方法で',
    about2Desc: 'デバッガ、試験のスクリプト、波形のビューアが、どの OEP のプローブも同じように使います。ターゲットのチップの知識は、道具の側にあります。',
    about3: '安いボードがプローブになる',
    about3Desc: 'Raspberry Pi Pico や ESP32 のボードに OEP の firmware を書けば、プローブになります。このページで書けます。',
    featuresTitle: 'プローブでできること',
    tierRelease: 'リリースの firmware があるボード',
    tierBuild: '自分でビルドするボード',
    pageBuild: 'example をビルド',
    startTitle: 'はじめ方',
    st1: '1. firmware を書く',
    st1Desc: '上の「ボード」か、ここでボードを選びます。最新のリリースを書きます。もう OEP のプローブになっているボードは、つないで（2）更新します。',
    st2: '2. プローブをつなぐ',
    st3: '3. ターゲットを配線して名前を付ける',
    st3Desc: 'ターゲットのデバッグの線を空いたピンに配線し、見つけて、接続に名前を付けます。',
    st4: '4. 道具から使う',
    st4Desc: 'アドレスを使って、WireSkein で信号を取り、コアで書き込みとデバッグをし、Python で試験を組みます。',
    toolsTitle: '道具と文書',
    toolWireskein: '信号を取り、見て、照合する（別のページ）。',
    toolPython: 'Python の host: ライブラリと oep コマンド。',
    toolArduino: 'プローブの firmware と、自分のボード向けに作るためのライブラリ。',
    toolSpec: 'OEP の仕様。',
    lockHint: 'プローブを変えるとき（ターゲットを探す、名前を保存する）は、右上の「変更を許可」にチェックを入れます。',
    tagline: 'ボードを OEP のプローブにして、ターゲットをつなぎ、手元の道具から使えるようにします。',
    unsupported: 'このブラウザには WebUSB / Web Serial / WebHID がありません。Chrome か Edge で、HTTPS か localhost で開いてください。',
     navBoards: 'ボード', navProbe: 'わたしのプローブ',
    notConnected: '未接続', disconnect: '切断', takeLock: '変更を許可', locked: '変更可', noLock: '読むだけ',
    
    
    diagHost: 'パソコンの道具', diagProbe: 'OEP のプローブ', diagWires: '線', diagTarget: '開発中のチップ',
     
     
     
       
        
     
    
    
    
    
    
    
    
    feat_debug: 'ターゲットのチップを止め、メモリとレジスタを読み書きし、flash に書きます。',
    feat_fixture: '試験のために、ターゲットのピンを動かし、読みます。GPIO、UART、I2C / SPI、PWM、エッジを数える。',
    feat_capture: '信号を波形（ロジックとアナログ）として取り、WireSkein で見て照合します。',
    feat_store: 'ピンの名前と道具の記録をプローブに持つので、どのパソコンにつないでもついて来ます。',
    boardsTitle: 'OEP のプローブになれるボード', boardsLead: 'リリースの firmware があるボードと、example を自分でビルドするボードです。選ぶと、できること、ピン、書き方が出ます。',
    compare: 'ボードを比べる', verified: '実機で確認済み', notVerified: 'ビルドと host の試験のみ',
    pageWrites: 'このページで書ける', pageUpdates: 'このページで更新できる', pageNot: '専用の道具で書く',
    bChip: 'チップ', bUsb: 'つなぎ方', bPins: 'ターゲットに使えるピン', bReserved: 'ボードが使うピン', bWrite: 'firmware の書き方', bFeatures: 'できること',
    yes: 'あり', no: '無し', writeThis: 'このボードに書く',
    probeTitle: 'わたしのプローブ', probeTargets: 'このプローブのターゲット', noTargets: 'まだありません。',
    pModel: 'ボード', pUnit: '個体の ID', pFirmware: 'firmware', pLatest: '最新', pUpdate: '更新があります', pVia: 'つなぎ方',
    actTarget: 'ターゲットを追加する', actTargetDesc: 'ターゲットのチップを配線し、見つけ、名前を付けます。',
    actFirmware: 'firmware を更新する', actFirmwareDesc: '最新のリリースを、このプローブに合わせて選びます。',
    actSettings: '設定', actSettingsDesc: 'プローブの設定を読む、変える、保存する、ファイルに控える、戻す。',
    actTry: 'ピンを試す', actTryDesc: 'GPIO、UART、シリアルの速さを手で試します。',
    actDetails: '詳しい情報', actDetailsDesc: 'プローブの宣言をすべて、テキストか JSON で。',
    
    connectLead: 'プローブを USB で挿し、「接続」を押します。ブラウザの一覧で「OEP probe」を選びます。',
    connectHint: 'シリアル: USB-UART の変換チップを通すプローブ（classic ESP32）。HID: USB が許されない環境で。',
    connectUsb: '接続', connectSerial: 'シリアル', connectHid: 'HID', connected: 'つながりました:',
    needProbe: '先にプローブをつなぎます。',
    targetTitle: 'ターゲットを追加する', targetLead: 'ターゲットを配線し、配線したピンで見つけ、接続に名前を付けます。',
    tg1: '1. 配線する', tg1Hint: 'ターゲットのデバッグの線と GND を、空いたピンにつなぎます。SWDIO と SWCLK（2 線: WCH の RISC-V は RVSWD、ARM は SWD）か、SWIO（1 線、CH32V00x）です。使ったピンにチェックを付けます。名前の付いたピンは使用中です。',
    tg2: '2. 見つける', tg2Hint: 'チェックしたピンだけを、両方の向きで試します。先に「変更を許可」にチェックを入れます。', setupScan: 'ターゲットを探す', setupWire: 'デバッグの線',
    tg3: '3. 名前を付ける', tg3Hint: '接続名（英字で始まり、英字・数字・- で 16 文字まで）。この名前からピンに名前が付き、プローブに保存されます。型番とメモも、どの道具からも読めるようにプローブに置きます。',
    setupPort: '接続名', setupPart: '型番', setupNote: 'メモ', setupApply: '保存する',
    tg4: '4. アドレス', tg4Hint: '道具は、このアドレスでターゲットに届きます。プローブをどのパソコンにつないでも同じです。',
    setupNoScan: 'このプローブは、そのデバッグの線で探せません。', setupNoPins: '線の組 1 つ分（2 本）のピンに、少なくともチェックを付けます。',
    setupNothing: 'どのチップも答えませんでした。配線、GND、ターゲットの電源を確かめます。', setupPick: '先に、見つかったチップを選びます。',
    pinUsed: '使用中', pinFree: '空き',
    firmwareTitle: 'firmware', fwThisProbe: 'つないでいるプローブ', fwUpdate: '最新に更新する', fwNew: 'まだ OEP の firmware の無いボード',
    fwBoard: 'ボード', fwNewWrite: '書く', fwRelease: '最新のリリース:', fwUpToDate: '最新です', fwCannot: 'このボードは、このページでは書けません。',
    fwRp2Hold: 'BOOTSEL を押しながらボードを挿し、「RP2 Boot」を選びます。',
    useTitle: '道具から使う',
    useWireskein: 'WireSkein: 信号を取る（別のページ）',
    useWireskeinHow: 'プローブで信号を取り、保存して見ます。チャンネルは、プローブのピンかピンの名前で指します。',
    useViewer: 'WireSkein のビューアを開く', useCore: 'ArduinoCore-CH32RV: CH32 のターゲットを書き、調べる', usePython: 'oep-client-python: Python とコマンドから',
    describeRun: '宣言をすべて読む', saveJson: 'JSON で保存', read: '読む', saveToProbe: 'プローブに保存',
    unsetAll: 'すべて消す（その後に保存すると、保存した設定が空になる）', fixedValues: 'プローブが固定した値（変えられない）',
    exportFile: 'ファイルに控える', importFile: 'ファイルから戻す', importAsk: 'プローブの設定を、このファイルの内容にしますか？', addItem: '値を設定する',
    category: '分類', item: '項目', key: '対象', value: '値',
    secretHint: '秘密の値です。プローブは返さず、このページも表示しません。空のままなら今の値を保ちます。',
    set: '設定', remove: '消す', configure: '設定', send: '送る',
    gpioHint: '先にそのピンを GPIO 用に取ります（つないでいる間、持ち続けます）。先に「変更を許可」にチェックを入れます。', gpioPlan: 'ピンを取る',
    uartHint: 'UART は、つないでいる間、RX と TX のピンを取る必要があります。',
    speedTitle: 'シリアルの速さ', speedHint: 'USB-UART の変換チップを通すプローブは、つないでいる間、速くできます。速さを順に試し、両方向それぞれ 1 秒、最大のフレームを流して通ったときだけ使います。既定は 500000 です。',
    speedTry: '速さを試す',
  },
};

/** The language: the one chosen here before, else the browser's (navigator.languages), else English. */
const LANGS = ['en', 'ja'];
/** @type {'en' | 'ja'} */
let lang = (() => {
  try { const v = localStorage.getItem('oep-lang'); if (v && LANGS.includes(v)) return /** @type {'en' | 'ja'} */ (v); } catch { /* none */ }
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = String(l).toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return /** @type {'en' | 'ja'} */ (base);
  }
  return 'en';
})();
/** @param {keyof typeof WORDS.en} key */
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];
/** A board text in the page's language. @param {{ en: string, ja: string }} x */
const tx = (x) => x[lang] ?? x.en;

function applyWords() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(/** @type {any} */ (el.getAttribute('data-i18n')));
  for (const el of document.querySelectorAll('[data-i18n-label]')) {   // a label's own words: its first text node
    const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    if (node) node.textContent = `${t(/** @type {any} */ (el.getAttribute('data-i18n-label')))} `;
  }
  /** @type {HTMLSelectElement} */ ($('lang-select')).value = lang;
  route();
}

// ---- state and helpers ---------------------------------------------------------------------------------------

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/** @type {import('../src/host.js').Host | null} */ let host = null;
/** @type {Awaited<ReturnType<typeof core.probeInfo>> | null} */ let info = null;
/** @type {Awaited<ReturnType<typeof dump.collect>> | null} */ let caps = null;
let locked = false;
/** @type {any} */ let keepalive = null;
/** @type {Map<number, any>} */ const uarts = new Map();

/** @param {string} text @param {boolean} [bad] */
function log(text, bad = false) {
  const el = $('log');
  el.textContent = text;
  el.className = bad ? 'bad' : '';
}

/** @param {unknown} e */
function describeError(e) {
  if (e instanceof Unavailable) {
    const parts = [e.message, e.cause && `cause ${e.cause}`, e.channels.length && `channel ${e.channels.join(',')}`,
      e.fn !== null && `fn ${e.fn}`, e.cause === 'held_by_settings' && 'the settings hold it (see the settings)'];
    return parts.filter(Boolean).join(', ');
  }
  if (e instanceof Rejected) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Run an action, showing its error. @param {() => Promise<void>} fn */
async function act(fn) {
  try { await fn(); } catch (e) { log(describeError(e), true); console.error(e); }
  refreshButtons();
}

function refreshButtons() {
  for (const el of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-needs]'))) {
    const need = el.getAttribute('data-needs');
    el.disabled = need === 'host' ? !host : need === 'lock' ? !host || !locked : need === 'dump' ? !caps : false;
  }
  for (const id of ['connect-usb', 'connect-serial', 'connect-hid']) /** @type {HTMLButtonElement} */ ($(id)).disabled = !!host;
  $('disconnect').hidden = !host;
  $('lock-box').hidden = !host;
  input('lock').checked = locked;
  $('status').classList.toggle('connected', !!(host && info));
  $('probe-line').textContent = host && info ? `${probeTitle()} · ${locked ? t('locked') : t('noLock')}` : t('notConnected');
}

// ---- screens (docs/page.ja.md §2): one at a time, chosen by the URL's # ---------------------------------------------

/** The screens that need a connected probe (else the connect part shows above them). */
const NEEDS_PROBE = new Set(['probe', 'target', 'settings', 'try', 'details']);

/** @param {string} tag @param {Record<string, any>} [props] @param {(Node | string | null | undefined | false)[]} kids */
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** A part (#part-...) into a slot of the screen showing. @param {string} part @param {string | HTMLElement} slot */
function place(part, slot) {
  const s = typeof slot === 'string' ? $(slot) : slot;
  if ($(part).parentElement !== s) s.append($(part));
}

const SECTIONS = new Set(['about', 'features', 'boards', 'start', 'tools']);

function route() {
  for (const p of ['part-boards', 'part-firmware', 'part-connect', 'part-target', 'part-use']) $('parts').append($(p));
  const [name, arg] = (location.hash.slice(1) || 'home').split('/');
  const section = SECTIONS.has(name) ? name : null;
  const view = section ? 'home' : document.querySelector(`section.view[data-view="${name}"]`) ? name : 'home';
  for (const v of document.querySelectorAll('section.view')) /** @type {HTMLElement} */ (v).hidden = v.getAttribute('data-view') !== view;
  for (const a of document.querySelectorAll('.top-nav a')) a.classList.toggle('active', a.getAttribute('href') === `#${section ?? view}`);
  if (name === 'boards' && arg && BOARDS.some((b) => b.id === arg)) chosenBoard = arg;
  if (view === 'home') showHome();
  if (view === 'firmware') { place('part-firmware', 'firmware-slot'); showFirmware(); }
  if (view === 'probe') showProbeView();
  if (view === 'target') { place('part-target', 'target-slot'); showTarget(); }
  const sec = /** @type {HTMLElement} */ (document.querySelector(`section.view[data-view="${view}"]`));
  sec.classList.toggle('no-probe', NEEDS_PROBE.has(view) && !host);   // only the connect part shows (styles: .no-probe)
  if (NEEDS_PROBE.has(view) && !host) {
    sec.insertBefore($('part-connect'), sec.children[1] ?? null);
    showConnect();
  }
  refreshButtons();
  const target = section ? document.getElementById(section) : null;
  if (target) target.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
}

const go = (/** @type {string} */ hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ---- 3.1 home -------------------------------------------------------------------------------------------------------

function showHome() {
  const box = $('home-probe');
  box.hidden = !host || !info;
  if (host && info) box.replaceChildren(el('span', {}, `${t('connected')} ${probeTitle()}`), el('a', { href: '#probe', className: 'button' }, t('navProbe')));
  showFeatures();
  place('part-boards', 'boards-slot'); showBoards();
  place('part-firmware', 'start-firmware'); showFirmware();
  place('part-connect', 'start-connect'); showConnect();
  if (host) { place('part-target', 'start-target'); showTarget(); }
  else $('start-target').replaceChildren(el('p', { className: 'muted' }, t('needProbe')));
  place('part-use', 'start-use'); showUse();
  $('st-1').classList.toggle('done', !!host);
  $('st-2').classList.toggle('done', !!host);
}

function probeTitle() {
  if (!info) return '';
  const b = boardOf(info.model);
  return `${b ? tx(b.name) : info.model} · ${info.unitId}`;
}

function diagram() {
  return el('div', { className: 'diagram' }, el('span', {}, t('diagHost')), el('i', {}, 'USB'), el('span', { className: 'probe' }, t('diagProbe')),
    el('i', {}, t('diagWires')), el('span', {}, t('diagTarget')));
}

/** The feature cards (docs/page.ja.md §3.2, §4.1). */
function showFeatures() {
  const what = /** @type {const} */ (['feat_debug', 'feat_fixture', 'feat_capture', 'feat_store']);
  $('feature-cards').replaceChildren(...FEATURES.map((g, i) => el('div', { className: 'feature' }, el('b', {}, tx(g.group)),
    el('p', {}, t(what[i])), el('p', { className: 'muted' }, g.items.map(([, n]) => tx(n)).join(' · ')))));
}

// ---- 3.3 boards ------------------------------------------------------------------------------------------------------

/** @type {string | null} */ let chosenBoard = null;

/** @param {import('./boards.js').Has} v */
const hasText = (v) => (v === true ? t('yes') : v === false ? t('no') : tx(v));

function showBoards() {
  const cards = $('board-cards');
  const card = (/** @type {import('./boards.js').Board} */ b) => el('button', { type: 'button', className: `board-card${b.id === chosenBoard ? ' chosen' : ''}`,
    onclick: () => { chosenBoard = b.id; showBoards(); } },
    el('b', {}, tx(b.name)), el('span', { className: 'muted' }, b.chip),
    el('span', { className: `badge ${b.verified === true ? 'ok' : 'warn'}` }, b.verified === true ? t('verified') : b.verified === false ? t('notVerified') : tx(b.verified)),
    el('span', { className: 'badge' }, b.tier === 'build' ? t('pageBuild') : b.write.page === 'any' ? t('pageWrites') : b.write.page === 'dfu' ? t('pageUpdates') : t('pageNot')));
  cards.replaceChildren(el('h3', {}, t('tierRelease')), el('div', { className: 'board-grid' }, ...BOARDS.filter((b) => b.tier === 'release').map(card)),
    el('h3', {}, t('tierBuild')), el('div', { className: 'board-grid' }, ...BOARDS.filter((b) => b.tier === 'build').map(card)));
  const table = /** @type {HTMLTableElement} */ ($('board-table'));
  table.replaceChildren(el('tr', {}, el('th'), ...BOARDS.map((b) => el('th', {}, tx(b.name)))));
  for (const g of FEATURES) {
    table.append(el('tr', { className: 'group' }, el('th', { colSpan: BOARDS.length + 1 }, tx(g.group))));
    for (const [k, n] of g.items) {
      table.append(el('tr', {}, el('td', {}, tx(n)), ...BOARDS.map((b) => el('td', { className: b.features[k] === false ? 'no' : '' }, hasText(b.features[k])))));
    }
  }
  const b = BOARDS.find((x) => x.id === chosenBoard);
  const d = $('board-detail');
  d.hidden = !b;
  if (!b) return;
  const feats = el('table', { className: 'items' });
  for (const g of FEATURES) for (const [k, n] of g.items) feats.append(el('tr', {}, el('td', {}, tx(n)), el('td', { className: b.features[k] === false ? 'no' : '' }, hasText(b.features[k]))));
  d.replaceChildren(el('h3', {}, tx(b.name)),
    el('dl', {}, el('dt', {}, t('bChip')), el('dd', {}, b.chip), el('dt', {}, t('bUsb')), el('dd', {}, tx(b.usb)),
      el('dt', {}, t('bPins')), el('dd', {}, tx(b.pins)), el('dt', {}, t('bReserved')), el('dd', {}, tx(b.reserved)),
      el('dt', {}, t('bWrite')), el('dd', {}, tx(b.write.how))),
    el('h4', {}, t('bFeatures')), feats,
    b.tier === 'release' ? el('a', { className: 'button', href: '#start', onclick: () => { chosenBoard = b.id; } }, t('writeThis')) : null);
}

// ---- connect ---------------------------------------------------------------------------------------------------------

function showConnect() {
  $('lock-hint').hidden = !host || locked;
  $('connect-result').replaceChildren(...(host && info ? [el('p', { className: 'ok' }, `${t('connected')} ${probeTitle()}`)] : []));
}

// ---- 3.4 my probe ----------------------------------------------------------------------------------------------------

async function showProbeView() {
  const sum = $('probe-summary');
  if (!host || !info) { sum.replaceChildren(el('p', { className: 'muted' }, t('needProbe'))); $('probe-targets').replaceChildren(); return; }
  const b = boardOf(info.model);
  const latest = release?.version;
  const fw = info.firmware ?? '?';
  const status = !latest ? '' : fw.split('+')[0] === latest ? ` (${t('fwUpToDate')})` : ` (${t('pUpdate')}: ${latest})`;
  sum.replaceChildren(el('dl', {},
    el('dt', {}, t('pModel')), el('dd', {}, `${b ? tx(b.name) : '?'} (${info.model})`),
    el('dt', {}, t('pUnit')), el('dd', {}, info.unitId ?? '?'),
    el('dt', {}, t('pFirmware')), el('dd', {}, fw + status),
    el('dt', {}, t('pVia')), el('dd', {}, host.link.transport.kind ?? '')));
  place('part-use', 'probe-use-slot');
  const ports = await probeTargets();
  const box = $('probe-targets');
  box.replaceChildren(...(ports.length ? ports.map((p) => el('div', { className: 'target-row' },
    el('b', {}, p.name), el('span', { className: 'muted' }, p.lines.join(', ')),
    p.record ? el('span', {}, Object.entries(p.record).map(([k, v]) => `${k}: ${v}`).join(' · ')) : null,
    el('code', {}, `oep://${info?.unitId}/${p.name}`))) : [el('p', { className: 'muted' }, t('noTargets'))]));
  showUse(ports.map((p) => p.name));
}

/** The connections the pin names make (host guide §5.3) and their memo records. */
async function probeTargets() {
  if (!host || !info) return [];
  const labels = await settings.labels(host);
  /** @type {any} */ let mm = null;
  try { mm = await memo.Memo.open(host); } catch { /* no memo area */ }
  const out = [];
  for (const name of settings.portsNamed(labels)) {
    const lines = labels.filter(([, l]) => settings.parseLabel(l)?.[0].toLowerCase() === name.toLowerCase())
      .map(([ch, l]) => `${l} (${info?.channelNames.get(ch) ?? ch})`);
    let record = null;
    try { record = mm ? await mm.readPortRecord(name) : null; } catch { record = null; }
    out.push({ name, lines, record });
  }
  return out;
}

// ---- 3.7 the tools -------------------------------------------------------------------------------------------------

/** @param {string[]} [ports] the connection names to show (the connected probe's) */
function showUse(ports) {
  const unit = info?.unitId ?? '<unit id>';
  const port = ports?.[0] ?? (input('setup-port').value.trim() || '<name>');
  const code = (/** @type {string} */ s) => el('pre', { className: 'out small' }, s);
  $('part-use').replaceChildren(
    el('h4', {}, t('useWireskein')), el('p', {}, t('useWireskeinHow')),
    code(`wireskein capture --source oep:oep://${unit} --channels SDA=<pin>,SCL=<pin> --rate 20M --samples 200k -o capture.wireskein\nwireskein gui capture.wireskein`),
    el('a', { className: 'button', href: WIRESKEIN_VIEWER, target: '_blank', rel: 'noopener' }, t('useViewer')),
    el('h4', {}, t('useCore')), code(`ch32rv target info oep://${unit}/${port}`),
    el('h4', {}, t('usePython')), code(`oep dump --port oep://${unit}`));
}

// ---- 3.6 firmware ----------------------------------------------------------------------------------------------------

/** The latest release's OepProbe firmware the page was built with (scripts/fetch-firmware.js: ./firmware/). */
/** @type {any} */ let release = null;

async function loadRelease() {
  try {
    const r = await fetch('./firmware/firmware.json', { cache: 'no-cache' });
    if (r.ok) release = parseFirmwareManifest(await r.json());
  } catch { release = null; }
  route();
}

const KIND = { esp32p4: 'app', esp32p4x: 'app', rp2040: 'uf2', rp2350: 'uf2' };

function showFirmware() {
  $('fw-release').textContent = release ? `${t('fwRelease')} OepProbe ${release.version}` : '';
  const card = $('fw-probe-card');
  card.hidden = !host || !info;
  if (host && info) {
    const supported = /** @type {Record<string, string>} */ (KIND)[info.model ?? ''];
    const fw = info.firmware ?? '?';
    $('fw-probe').textContent = `${probeTitle()} · ${fw}` + (release ? (fw.split('+')[0] === release.version ? ` (${t('fwUpToDate')})` : ` → ${release.version}`) : '')
      + (supported ? '' : ` · ${t('fwCannot')}`);
    /** @type {HTMLButtonElement} */ ($('fw-update')).disabled = !supported || !release;
  }
  const sel = /** @type {HTMLSelectElement} */ ($('fw-board'));
  const was = chosenBoard ?? sel.value;
  sel.replaceChildren(...BOARDS.map((b) => el('option', { value: b.id }, tx(b.name))));
  if (was && BOARDS.some((b) => b.id === was)) sel.value = was;
  const b = BOARDS.find((x) => x.id === sel.value);
  $('fw-how').textContent = b ? tx(b.write.how) : '';
  /** @type {HTMLButtonElement} */ ($('fw-new-write')).disabled = !b || b.write.page !== 'any' || !release;
}

/** The latest image for `model`, fetched from beside the page and checked against its sha256. @param {string} model */
async function latestImage(model) {
  if (!release) throw new Error('no firmware list beside this page');
  const kind = /** @type {Record<string, string>} */ (KIND)[model];
  const entry = kind && pickFirmware(release, { model, kind });
  if (!entry) throw new Error(`the latest release has no ${model} firmware this page can write`);
  const r = await fetch(`./firmware/${entry.file}`);
  if (!r.ok) throw new Error(`${entry.file}: HTTP ${r.status}`);
  return verifyFirmware(new Uint8Array(await r.arrayBuffer()), entry);
}

/** @param {{ done: number, total: number, text: string }} p */
function progress(p) {
  const bar = /** @type {HTMLProgressElement} */ ($('fw-progress'));
  bar.hidden = false;
  bar.max = p.total;
  bar.value = p.done;
  $('fw-status').textContent = p.text;
}

/** The ESP32-P4 / P4X: its DFU interface (the same USB device as the probe). @param {Uint8Array} image */
async function updateOverDfu(image) {
  const unitId = info?.unitId;
  await disconnect();
  const device = (await getDfuDevices()).find((d) => (d.serialNumber ?? '').toLowerCase() === (unitId ?? '').toLowerCase())
    ?? await requestDfuDevice();
  const t0 = performance.now();
  await dfuUpdate(device, image, { onProgress: (p) => progress({ done: p.written, total: p.total,
    text: p.phase === 'manifest' ? '...' : `${p.written} / ${p.total} bytes` }) });
  return (performance.now() - t0) / 1000;
}

/** The boot ROM of `model` the browser was given before, if it is on the bus. @param {'rp2040' | 'rp2350'} model */
async function grantedBoot(model) {
  const usb = /** @type {any} */ (navigator).usb;
  return (await usb.getDevices()).find((/** @type {any} */ d) => d.vendorId === RP2_BOOT_VID && d.productId === RP2_BOOT_PID[model]) ?? null;
}

/** An RP2: the connected probe into its boot ROM by its reset interface (when one is connected), then PICOBOOT.
 * @param {'rp2040' | 'rp2350'} model @param {Uint8Array} image */
async function updateRp2(model, image) {
  let asked = false;
  if (host && info) {
    const unitId = info.unitId;
    let device = (await getUsbProbes({ unitId }))[0] ?? null;
    await disconnect();
    if (!device) device = await requestUsbProbe();
    if (!await rp2ResetToBoot(device)) throw new Error('this probe has no reset interface');
    asked = true;
  }
  let boot = null;
  for (let i = 0; i < (asked ? 20 : 1) && !boot; i++) {
    boot = await grantedBoot(model);
    if (!boot && asked) await new Promise((r) => setTimeout(r, 250));
  }
  if (!boot) {
    $('fw-status').textContent = t('fwRp2Hold');
    boot = await requestRp2Boot(model);
  }
  const t0 = performance.now();
  await rp2Write(boot, image, { model, onProgress: (p) => progress({ done: p.done, total: p.total, text: `${p.done} / ${p.total}` }) });
  return (performance.now() - t0) / 1000;
}

async function updateProbe() {
  if (!info) return;
  const model = /** @type {string} */ (info.model);
  const image = await latestImage(model);
  const s = KIND[/** @type {keyof typeof KIND} */ (model)] === 'app' ? await updateOverDfu(image)
    : await updateRp2(/** @type {'rp2040' | 'rp2350'} */ (model), image);
  $('fw-status').textContent = `OepProbe ${release.version}: ${s.toFixed(1)} s`;
}

async function writeNewBoard() {
  const b = BOARDS.find((x) => x.id === /** @type {HTMLSelectElement} */ ($('fw-board')).value);
  if (!b || b.write.page !== 'any') throw new Error(t('fwCannot'));
  const model = /** @type {'rp2040' | 'rp2350'} */ (b.models[0]);
  const image = await latestImage(model);
  if (host) await disconnect();
  const s = await updateRp2(model, image);
  $('fw-status').textContent = `OepProbe ${release.version}: ${s.toFixed(1)} s`;
}

// ---- connecting ------------------------------------------------------------------------------------------------

/** @param {() => Promise<import('../src/host.js').Host>} open */
async function connectWith(open) {
  await act(async () => {
    host = await open();
    info = await core.probeInfo(host);
    caps = null;
    uarts.clear();
    await fillUarts();
    log(`connected: ${info.model} ${info.unitId}`);
    route();
  });
}

async function disconnect() {
  await act(async () => {
    if (!host) return;
    const h = host;
    if (locked) await setLock(false);
    host = null;
    info = null;
    await h.link.close();
    log('disconnected');
    route();
  });
}

/** @param {boolean} on */
async function setLock(on) {
  if (!host) return;
  if (on) {
    const opened = await core.take(host, 10000, { owner: 'OEP Probe Tool' });
    locked = true;
    keepalive = setInterval(() => { host?.keepalive().catch((e) => { log(describeError(e), true); locked = false; refreshButtons(); }); }, 3000);
    log(`lock taken (lease ${opened.leaseMs} ms)`);
  } else {
    clearInterval(keepalive);
    if (locked) await host.end().catch(() => {});
    locked = false;
    log('lock given back');
  }
  refreshButtons();
}

// ---- describe ------------------------------------------------------------------------------------------------------

async function runDescribe() {
  if (!host) return;
  caps = await dump.collect(host);
  $('describe-out').textContent = dump.toText(caps);
  log(`${caps.offers.length} interfaces`);
}

function saveDescribe() {
  if (!caps || !info) return;
  const blob = new Blob([dump.toJson(caps)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `oep-${info.unitId ?? 'probe'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- settings ------------------------------------------------------------------------------------------------------
// Every item comes from what the probe declares (core §13.2): the table shows each value by its names, the form sets
// one by category, item and key; a file holds the user's values by name (export / import).

function probeSettings() {
  if (!host) throw new Error('not connected');
  return new settings.Settings(host);
}

/** @type {import('../src/settings.js').Catalog | null} */ let catalog = null;
let changeable = true;   // set / unset offered (a probe of initial values only has get alone, core §13.5)

/** A value as shown (a secret never: the probe gives none). @param {unknown} v */
const valueText = (v) => (typeof v === 'object' && v !== null ? '(secret)' : JSON.stringify(v));

/** The values (get), the storage state (op state) and the network (op network, when the probe declares a netif); all
 * lock-free. */
async function readSettings() {
  const st = probeSettings();
  catalog = await st.catalog();
  changeable = await st.changeable();
  const [rows, state, net] = await Promise.all([st.show(), (await st.offers('state')) ? st.state() : Promise.resolve(null),
    catalog.netif.size ? st.network() : Promise.resolve(null)]);
  const netifs = net ? [`TCP port ${net.tcpPort || 'none'}`, ...net.netifs.map((n) => `${n.netif} ${n.state}`
    + (n.entry !== null ? `, entry ${n.entry}` : '') + (n.reason !== 'none' ? `, reason ${n.reason}` : '')
    + (n.rssi ? `, rssi ${n.rssi} dBm` : '') + (n.address ? `, ${n.address}` : ''))] : [];
  $('settings-state').textContent = [state ? `storage ${state.storage}${state.reason ? ` (${state.reason})` : ''}` : 'no storage',
    ...(changeable ? [] : [t('fixedValues')]), ...netifs].join(' · ');
  const body = /** @type {HTMLTableSectionElement} */ ($('settings-items').querySelector('tbody'));
  body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const text of [r.category, r.name, valueText(r.value)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const td = document.createElement('td');
    if (changeable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('remove');
      b.dataset.needs = 'lock';
      b.onclick = () => act(async () => { await probeSettings().unsetNamed(r.category, [r.name]); await readSettings(); });
      td.append(b);
    }
    tr.append(td);
    body.append(tr);
  }
  fillSettingForm();
  refreshButtons();
}

/** @param {HTMLSelectElement} sel @param {[string, string][]} options value, text */
function setOptions(sel, options) {
  const was = sel.value;
  sel.replaceChildren(...options.map(([value, text]) => Object.assign(document.createElement('option'), { value, textContent: text })));
  if (options.some(([v]) => v === was)) sel.value = was;
}

/** The form's selects from the catalog: the categories with items, the chosen category's items, the chosen item's keys
 * and, for a value that names something, its choices. */
function fillSettingForm() {
  const form = /** @type {HTMLFormElement} */ ($('form-setting'));
  const el = (/** @type {string} */ n) => /** @type {HTMLSelectElement} */ (form.elements.namedItem(n));
  const cat = catalog;
  form.hidden = !cat || !changeable || ![...cat.items.values()].some((items) => items.length);
  if (!cat) return;
  setOptions(el('category'), [...cat.category].filter(([fn]) => cat.items.get(fn)?.length).map(([, c]) => [c, c]));
  const fn = cat.fnOf(el('category').value);
  const items = fn === null ? [] : cat.items.get(fn) ?? [];
  setOptions(el('item'), items.map((it) => [String(it.number), it.name]));
  const it = items.find((x) => String(x.number) === el('item').value);
  if (!it) return;
  const keys = it.keyKind === 'none' ? [] : it.keyKind === 'index' ? Array.from({ length: it.keys }, (_, k) => String(k))
    : [...cat.table(it.keyKind).values()];
  el('key').parentElement?.toggleAttribute('hidden', it.keyKind === 'none');
  setOptions(el('key'), keys.map((k) => [k, k]));
  /** @type {string[] | null} */
  const choices = it.form === 'enum' ? [...it.choices.values()] : it.form === 'bool' ? ['true', 'false']
    : it.form === 'channel' ? [...cat.channel.values()] : it.form === 'transport' ? [...cat.route.values()]
      : it.form === 'fn' ? [...cat.category.values()] : null;
  el('choice').hidden = !choices;
  setOptions(el('choice'), (choices ?? []).map((c) => [c, c]));
  const value = input('setting-value');
  value.hidden = !!choices;
  value.type = it.secret ? 'password' : 'text';
  value.autocomplete = it.secret ? 'new-password' : 'off';
  value.placeholder = it.form === 'ipv4' ? 'a.b.c.d' : it.form === 'u32' ? 'number' : it.form === 'bytes' ? 'hex bytes' : '';
  $('setting-hint').textContent = it.secret ? t('secretHint') : '';
}

/** Set the form's value by name. A secret left empty keeps what the probe has (0 bytes, core §13.5); the field is
 * cleared once read and never written to the log. */
async function setFromForm() {
  const form = /** @type {HTMLFormElement} */ ($('form-setting'));
  const d = Object.fromEntries(new FormData(form).entries());
  const value = input('setting-value');
  const cat = /** @type {import('../src/settings.js').Catalog} */ (catalog);
  const it = cat.item(/** @type {number} */ (cat.fnOf(String(d.category))), +d.item);
  if (!it) throw new Error('no such item');
  const flat = it.keyKind === 'none' ? it.name : it.name.replace('{}', String(d.key));
  const raw = String(value.hidden ? d.choice : value.value);
  value.value = '';
  const st = probeSettings();
  if (it.secret && raw === '') {
    const [found, key] = /** @type {[import('../src/settings.js').Item, number]} */ (cat.resolve(String(d.category), flat));
    await st.set([[found.fn, found.number, key, new Uint8Array()]]);
  } else {
    await st.setNamed(String(d.category), { [flat]: it.form === 'bool' ? raw === 'true' : raw });
  }
  log(it.secret ? `set ${flat}` : `set ${flat} = ${raw}`);
  await readSettings();
}

/** The user's values to a file (settings file §3; secrets as { secret: true }). */
async function exportSettings() {
  const doc = await probeSettings().export();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' }));
  a.download = `${info?.unitId ?? 'probe'}.oep-settings.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** A file's values made the probe's (settings file §4): what changes is shown and asked first. @param {File} file */
async function importSettings(file) {
  const st = probeSettings();
  const plan = await st.planImport(JSON.parse(await file.text()));
  const lines = [`set ${plan.sets.length}, unset ${plan.unsets.length}`,
    ...(plan.otherProbe ? ['the file is of another probe'] : []),
    ...plan.unresolved.map(([c, n]) => `not on this probe: ${c} ${n}`),
    ...plan.secretWithoutValue.map(([c, n]) => `a secret the probe has no value for (set it): ${c} ${n}`)];
  if (!plan.sets.length && !plan.unsets.length) { log(lines.join('; ')); return; }
  if (!window.confirm(`${t('importAsk')}\n\n${lines.join('\n')}`)) return;
  await st.applyImport(plan);
  log(lines.join('; '));
  await readSettings();
}

// ---- tools ---------------------------------------------------------------------------------------------------------

async function fillUarts() {
  const sel = /** @type {HTMLSelectElement} */ ($('uart-fn'));
  sel.replaceChildren();
  if (!host) return;
  for (const fn of await core.findAll(host, 'oep.fixture.uart')) {
    const o = document.createElement('option');
    o.value = String(fn);
    o.textContent = `fn ${fn}`;
    sel.append(o);
  }
}

async function uart() {
  if (!host) throw new Error('not connected');
  const fn = Number(/** @type {HTMLSelectElement} */ ($('uart-fn')).value);
  if (!uarts.has(fn)) uarts.set(fn, await fixture.FixtureUartIO.open(host, { fn }));
  return uarts.get(fn);
}

function wireTools() {
  $('gpio-plan').onclick = () => act(async () => {
    if (!host) return;
    await core.planApply(host, [[await core.find(host, 'oep.fixture.gpio'), 1, +input('gpio-channel').value]]);
    log('planned');
  });
  $('gpio-set').onclick = () => act(async () => {
    if (!host) return;
    const g = await fixture.Gpio.open(host);
    await g.set([[+input('gpio-channel').value, +/** @type {HTMLSelectElement} */ ($('gpio-mode')).value]]);
    log('set');
  });
  $('gpio-read').onclick = () => act(async () => {
    if (!host) return;
    const g = await fixture.Gpio.open(host);
    const [level] = await g.read([+input('gpio-channel').value]);
    $('gpio-level').textContent = String(level);
  });
  $('uart-configure').onclick = () => act(async () => { const baud = await (await uart()).configure(+input('uart-baud').value); log(`baud ${baud}`); });
  $('uart-read').onclick = () => act(async () => {
    const data = await (await uart()).readAll();
    $('uart-out').textContent += new TextDecoder().decode(data);
  });
  $('speed-try').onclick = () => act(async () => {
    if (!host) return;
    const rates = input('speed-rates').value.split(',').map((r) => Number(r.trim())).filter((r) => r > 0);
    $('speed-out').textContent = '...';
    const report = await raiseSpeed(host, rates);
    $('speed-out').textContent = speedText(report);
    log(report.chosen ? `link at ${report.chosen}` : `link at ${report.rate}`);
  });
  $('uart-send').onclick = () => act(async () => {
    const text = input('uart-text').value + (input('uart-crlf').checked ? '\r\n' : '');
    await (await uart()).write(new TextEncoder().encode(text));
    log('sent');
  });
}

// ---- 3.5 a target: wire, find, name (host guide §5.3, oep-if-memo §4.3) -------------------------------------------

async function showTarget() {
  if (!host) return;
  await listPins();
}

const WIRES = ['oep.wire.rvswd', 'oep.wire.swio', 'oep.wire.swd'];
/** @type {{ kind: number, pins: [number, number], dmstatus: number, wire: string }[]} */ let found = [];
/** @type {number | null} */ let picked = null;

/** The wires this probe offers that can scan. @returns {Promise<{ name: string, wire: any }[]>} */
async function scanWires() {
  if (!host) return [];
  const out = [];
  for (const name of WIRES) {
    let fn;
    try { fn = await core.find(host, name); } catch { continue; }
    const wire = name === 'oep.wire.swd' ? new arm.SwdWire(host, fn, name) : new riscv.WireBase(host, fn, name);
    if (await core.offers(host, fn, riscv.WireBase.SCAN)) out.push({ name, wire });
  }
  return out;
}

async function listPins() {
  if (!host || !info) return;
  const labels = new Map(await settings.labels(host));
  const body = /** @type {HTMLTableElement} */ ($('setup-pin-table')).tBodies[0];
  body.replaceChildren();
  for (const [ch, name] of [...info.channelNames.entries()].sort((a, b) => a[0] - b[0])) {
    const row = body.insertRow();
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.channel = String(ch);
    box.disabled = labels.has(ch);
    row.insertCell().append(box);
    row.insertCell().textContent = name;
    row.insertCell().textContent = labels.get(ch) ?? t('pinFree');
  }
  const sel = /** @type {HTMLSelectElement} */ ($('setup-wire'));
  const names = { 'oep.wire.rvswd': 'RVSWD', 'oep.wire.swio': 'SWIO', 'oep.wire.swd': 'SWD' };
  setOptions(sel, (await scanWires()).map((w) => [w.name, /** @type {Record<string, string>} */ (names)[w.name] ?? w.name]));
}

function checkedPins() {
  return [...document.querySelectorAll('#setup-pin-table input[type=checkbox]:checked')]
    .map((b) => Number(/** @type {HTMLInputElement} */ (b).dataset.channel));
}

async function scanPins() {
  const name = /** @type {HTMLSelectElement} */ ($('setup-wire')).value;
  const w = (await scanWires()).find((x) => x.name === name);
  if (!w) throw new Error(t('setupNoScan'));
  const pins = checkedPins();
  /** @type {[number, number][]} */
  const pairs = w.wire.oneWire ? pins.map((p) => [p, 0xffff])
    : pins.flatMap((a) => pins.filter((b) => b !== a).map((b) => /** @type {[number, number]} */ ([a, b])));
  if (!pairs.length) throw new Error(t('setupNoPins'));
  log(`${name}: scanning ${pairs.length} pin pairs`);
  found = (await w.wire.scan(pairs)).map((f) => ({ ...f, wire: name }));
  picked = found.length ? 0 : null;
  showFound();
  log(found.length ? `${found.length} found` : t('setupNothing'), !found.length);
}

/** @param {number} ch */
const pinName = (ch) => (ch === 0xffff ? '' : info?.channelNames.get(ch) ?? `channel ${ch}`);

function showFound() {
  const body = /** @type {HTMLTableElement} */ ($('setup-found')).tBodies[0];
  body.replaceChildren();
  found.forEach((f, i) => {
    const row = body.insertRow();
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'setup-found';
    radio.checked = i === picked;
    radio.onchange = () => { picked = i; preview(); };
    row.insertCell().append(radio);
    row.insertCell().textContent = f.wire.replace('oep.wire.', '').toUpperCase();
    row.insertCell().textContent = f.pins[1] === 0xffff ? `swio ${pinName(f.pins[0])}` : `swdio ${pinName(f.pins[0])}, swclk ${pinName(f.pins[1])}`;
    row.insertCell().textContent = `id 0x${f.dmstatus.toString(16).padStart(8, '0')}`;
  });
  preview();
}

/** The labels the port name gives the picked target's pins. @returns {Record<string, string>} */
function portLabels() {
  const port = input('setup-port').value.trim();
  if (picked === null || !port) return {};
  const f = found[picked];
  const out = {};
  if (f.pins[1] === 0xffff) out[`channel.${pinName(f.pins[0])}.label`] = `${port}.swio`;
  else {
    out[`channel.${pinName(f.pins[0])}.label`] = `${port}.swdio`;
    out[`channel.${pinName(f.pins[1])}.label`] = `${port}.swclk`;
  }
  return out;
}

function preview() {
  $('setup-preview').textContent = Object.entries(portLabels()).map(([k, v]) => `${k} = ${v}`).join(', ');
}

async function applyPort() {
  if (!host || !info) return;
  if (picked === null) throw new Error(t('setupPick'));
  const port = input('setup-port').value.trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(port)) throw new Error(`port name ${JSON.stringify(port)}: a letter, then letters, digits or -, up to 16`);
  const st = probeSettings();
  await st.setNamed('core', portLabels());
  if (await st.offers('save')) await st.save();
  let mm = null;
  try { mm = await memo.Memo.open(host); } catch { /* no memo area (an optional interface) */ }
  let recorded = ' (no memo area on this probe: no record)';
  if (mm) {
    const record = await mm.updatePortRecord(port, { part: input('setup-part').value.trim(), note: input('setup-note').value.trim() });
    recorded = `, ${memo.portRecordName(port)} = ${JSON.stringify(record)}`;
  }
  const address = `oep://${info.unitId}/${port}`;
  $('setup-address').replaceChildren(el('code', { className: 'address' }, address));
  log(`${port}: saved${recorded}`);
  await listPins();
}

// ---- start ---------------------------------------------------------------------------------------------------------

function main() {
  $('version').textContent = `oep-client-js ${VERSION}`;
  const nav = /** @type {any} */ (navigator);
  if (!nav.usb && !nav.serial && !nav.hid) $('unsupported').hidden = false;
  const langSelect = /** @type {HTMLSelectElement} */ ($('lang-select'));
  langSelect.onchange = () => {
    lang = /** @type {'en' | 'ja'} */ (langSelect.value);
    try { localStorage.setItem('oep-lang', lang); } catch { /* none */ }
    applyWords();
  };
  window.addEventListener('hashchange', route);
  $('connect-usb').onclick = () => connectWith(() => openWebUsb());
  $('connect-serial').onclick = () => connectWith(() => openWebSerial());
  $('connect-hid').onclick = () => connectWith(() => openWebHid());
  $('disconnect').onclick = () => disconnect();
  input('lock').onchange = () => act(() => setLock(input('lock').checked));
  $('describe-run').onclick = () => act(runDescribe);
  $('describe-save').onclick = saveDescribe;
  $('settings-read').onclick = () => act(readSettings);
  $('settings-save').onclick = () => act(async () => { log(`saved (generation ${await probeSettings().save()})`); await readSettings(); });
  $('settings-unset-all').onclick = () => act(async () => { await probeSettings().unsetAll(); log('unset all'); await readSettings(); });
  $('settings-export').onclick = () => act(exportSettings);
  $('settings-import-pick').onclick = () => input('settings-import').click();
  input('settings-import').onchange = () => {
    const file = input('settings-import').files?.[0];
    input('settings-import').value = '';
    if (file) act(() => importSettings(file));
  };
  const settingForm = /** @type {HTMLFormElement} */ ($('form-setting'));
  settingForm.onchange = (e) => { if (/** @type {HTMLElement} */ (e.target).id !== 'setting-value') fillSettingForm(); };
  settingForm.onsubmit = (e) => { e.preventDefault(); act(setFromForm); };
  $('fw-update').onclick = () => act(updateProbe);
  $('fw-new-write').onclick = () => act(writeNewBoard);
  $('fw-board').onchange = () => { chosenBoard = /** @type {HTMLSelectElement} */ ($('fw-board')).value; showFirmware(); };
  $('setup-scan').onclick = () => act(scanPins);
  input('setup-port').oninput = preview;
  const nameForm = /** @type {HTMLFormElement} */ ($('setup-name'));
  nameForm.onsubmit = (e) => { e.preventDefault(); act(applyPort); };
  wireTools();
  applyWords();
  loadRelease();
}

main();
