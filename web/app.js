import { connectionChange } from './connections.js';
import { flashEsp } from './esp-flash.js';
import * as oep from './oep-client.js';
import { BOARDS, FEATURES, boardOf } from './boards.js';
import { integer, hexBytes, printable, parseRoute, firmwareState, validateBindings } from './model.js';
import { SIGNALS, valuesFor } from './signals.js';

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const CANCELLED = Symbol('cancelled');
const deviceAPIs = /** @type {any} */ (navigator);
let lang = (() => {
  try { const saved = localStorage.getItem('oep-lang'); if (saved === 'ja' || saved === 'en') return saved; } catch { /* private mode */ }
  for (const name of navigator.languages ?? [navigator.language]) { const base = name.split('-')[0]; if (base === 'ja' || base === 'en') return base; }
  return 'en';
})();
const L = (en, ja) => lang === 'ja' ? ja : en;
const T = (text) => text?.[lang] ?? text?.en ?? String(text ?? '');
const state = { installation: null, portRecords: new Map(), edit: null, granted: [], knownProbes: new Map(), returnRoute: null, host: null, info: null, caps: null, busy: false, firmwareBusy: false, dirty: false, epoch: 0,
  catalog: null, settings: [], settingsState: null, network: null, changeable: false, saveable: false, labels: [], ports: [], memos: [], memo: null,
  release: null, releaseError: false, clients: new Map(), plans: new Map(), debug: null, console: null,
  drafts: new Map(), results: new Map(), events: [], importPlan: null,
  wizard: { step: 0, found: [], picked: 0, saved: null }, notices: [], keepalive: null };
/** @type {[string, string, string, string, number][]} */
const NAV = [
  ['home', '⌂', 'Start', 'はじめる', 0], ['firmware', '↓', '1. Install', '1. 導入', 0], ['setup', '⚙', '2. Configure', '2. 接続先を設定', 0],
  ['probe', '◈', '3. Use', '3. 使用する', 1],
  ['signals', '⌁', 'Signal I/O', '信号を操作', 1], ['debug', '◎', 'Target tools', 'ターゲット操作', 1], ['tools', '▤', 'Capture & tools', '波形・道具', 1],
  ['settings', '⚙', 'Advanced settings', '本体の詳細設定', 2], ['storage', '▣', 'Storage', '保存領域', 2],
  ['diagnostics', '≡', 'Diagnostics', '診断', 2], ['help', '?', 'Guide & boards', '案内・ボード', 3],
];
const NEEDS_HOST = new Set(['probe', 'targets', 'target', 'signals', 'debug', 'settings', 'storage', 'diagnostics']);
function node(tag, props = {}, ...kids) {
  const item = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) item.addEventListener(k.slice(2), v);
    else if (k === 'class') item.className = v;
    else if (k in item && !k.startsWith('aria')) item[k] = v;
    else item.setAttribute(k, v);
  }
  if (state.busy && ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(item.tagName)) item.disabled = true;
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) item.append(kid instanceof Node ? kid : String(kid));
  return item;
}
const p = (text, cls = '') => node('p', { class: cls }, text);
const card = (title, ...kids) => node('section', { class: 'card' }, title ? node('h2', {}, title) : null, ...kids);
const notice = (text, cls = '') => node('div', { class: `notice ${cls}` }, text);
const link = (label, href, primary = false) => node('a', { href, class: `button${primary ? ' primary' : ''}` }, label);
const external = (label, href) => node('a', { href, target: '_blank', rel: 'noopener' }, label + ' ↗');
const actions = (...kids) => node('div', { class: 'actions' }, ...kids);
function button(label, fn, { write = false, primary = false, danger = false, disabled = false, id = '' } = {}) {
  return node('button', { type: 'button', id, class: primary ? 'primary' : danger ? 'danger' : '',
    disabled: disabled || state.busy || (write && !state.host?.session), onclick: () => run(label, fn) }, label);
}
function header(title, description, eyebrow = 'WORKSPACE') {
  return node('header', { class: 'screen-header' }, p(eyebrow, 'eyebrow'), node('h1', { tabindex: -1 }, title), p(description));
}
function entry(title, desc, href, n) {
  return node('a', { class: 'card entry', href }, n ? node('span', { class: 'card-number' }, n) : null,
    node('h2', {}, title), p(desc), node('strong', {}, L('Open workspace →', '作業を開く →')));
}
function selectField(id, label, choices, fallback = '') {
  const value = state.drafts.has(id) ? state.drafts.get(id) : String(fallback);
  const select = node('select', { id, onchange: () => state.drafts.set(id, select.value) }, ...choices.map(([v, text]) => node('option', { value: String(v) }, text)));
  if (choices.some(([v]) => String(v) === value)) select.value = value;
  state.drafts.set(id, select.value);
  return node('label', { htmlFor: id }, label, select);
}
// Important choices stay visible, with enough context to compare before selecting.
function choiceCards(id, label, choices, fallback = '', onChange = () => {}) {
  const current = state.drafts.has(id) ? value(id) : String(fallback);
  const selected = choices.some((c) => String(c.value) === current) ? current : '';
  state.drafts.set(id, selected);
  return node('fieldset', { class: 'choice-group', id }, node('legend', {}, label),
    node('div', { class: 'choice-grid' }, ...choices.map((c) => node('label', { class: `choice-card${String(c.value) === selected ? ' selected' : ''}` },
      node('input', { type: 'radio', name: id, value: String(c.value), checked: String(c.value) === selected, disabled: !!c.disabled,
        onchange: () => { state.drafts.set(id, String(c.value)); onChange(); render();
          (/** @type {HTMLInputElement | null} */ (document.querySelector(`input[name="${id}"]:checked`)))?.focus({ preventScroll: true }); } }),
      node('span', { class: 'choice-body' }, c.badge ? node('span', { class: 'tag' }, c.badge) : null,
        node('strong', { class: 'choice-title' }, c.title), c.description ? node('span', { class: 'choice-description' }, c.description) : null,
        c.facts?.length ? node('ul', { class: 'choice-facts' }, ...c.facts.map((f) => node('li', {}, f))) : null,
        node('span', { class: 'choice-state' }, String(c.value) === selected ? L('Selected', '選択中') : L('Select this option', 'これを選ぶ')))))));
}
function boardFacts(b) {
  const capability = (key, en, ja) => b.features[key] ? `${L(en, ja)}${b.features[key] === true ? '' : ` · ${T(b.features[key])}`}` : null;
  const debug = ['rvswd', 'swio', 'swd'].filter((k) => b.features[k]).map((k) => `${k.toUpperCase()}${b.features[k] === true ? '' : ` (${T(b.features[k])})`}`).join(' / ');
  return [debug ? `${L('Debug', 'デバッグ')}: ${debug}` : null,
    capability('logic', 'Logic capture', 'ロジック取得'), capability('analog', 'Analog capture', 'アナログ取得'),
    b.features.dac ? L('DAC analog output available', 'DACのアナログ出力あり') : null,
    b.verified === true ? L('Checked on hardware', '実機で確認済み') : b.verified === false ? L('Build / host tests; hardware not verified', 'ビルド・host試験のみ。実機は未確認') : T(b.verified),
  ].filter(Boolean);
}
function boardPurpose(b) {
  return ({ pico: L('A small USB probe. Install and update it here with BOOTSEL.', '小さなUSBプローブ。BOOTSELで、このページから導入・更新できます。'),
    pico2: L('The RP2350 board. Browser installation and updates via BOOTSEL.', 'RP2350のボード。BOOTSELでブラウザから導入・更新できます。'),
    p4: L('For wider, faster logic capture. Chip v1.x; install here through serial USB.', '多チャンネル・高速のロジック取得向け。チップv1.x用。このページでシリアルから初回導入できます。'),
    p4x: L('The P4 v3.x chip. Use its own firmware; the P4 image is not interchangeable.', 'P4のチップv3.x用。P4とは異なる専用firmwareを使います。'),
    esp32: L('Use a classic ESP32 over its USB–serial bridge. Includes a DAC output.', 'classic ESP32をUSBシリアル変換経由で使用。DAC出力も使えます。'),
    ch32: L('WCH CH32 boards. Functions vary by chip; installation needs WCH tools.', 'WCHのCH32ボード。機能はチップで異なり、導入にはWCHの道具を使います。'),
    esp32s3: L('For a custom build on S3 / C3 / C6. Functions depend on the example you built.', 'S3・C3・C6で自分でビルドする場合。使える機能はexampleにより異なります。'),
  })[b.id] ?? T(b.usb);
}
function boardChoices(id, label, fallback = '', onChange = () => {}) {
  const choices = BOARDS.map((b) => ({ value: b.id, title: T(b.name), description: boardPurpose(b), facts: boardFacts(b),
    badge: `${b.chip} · ${b.tier === 'release' ? L('Released firmware', '配布firmwareあり') : L('Build it yourself', '自分でビルド')}` }));
  return choiceCards(id, label, choices, fallback, onChange);
}
function wireChoices(id, offers, onChange = () => {}) {
  return choiceCards(id, L('Choose the debug line for your target', 'ターゲットに合うデバッグ線を選ぶ'), offers.map((o) => ({ value: o.entry.fn,
    title: `${o.entry.name.replace('oep.wire.', '').toUpperCase()} · ${o.entry.instance}`,
    description: ({ 'oep.wire.rvswd': L('WCH RISC-V targets over SWDIO + SWCLK.', 'WCHのRISC-V用。SWDIOとSWCLKの2本を使います。'),
      'oep.wire.swio': L('CH32V00x targets over a single SWIO signal.', 'CH32V00x用。SWIO信号1本を使います。'),
      'oep.wire.swd': L('ARM targets over SWDIO + SWCLK.', 'ARM用。SWDIOとSWCLKの2本を使います。') })[o.entry.name],
    facts: [o.description.maxClockHz ? `${L('Maximum clock', '上限クロック')}: ${o.description.maxClockHz.toLocaleString()} Hz` : null,
      `${L('Pin candidates', 'ピン候補')}: ${[...new Set([...roleChannels(o).values()].flat())].length} ${L('pins', '本')}`].filter(Boolean),
  })), offers[0]?.entry.fn ?? '', onChange);
}

function field(id, label, fallback = '', { multiline = false, password = false } = {}) {
  const input = node(multiline ? 'textarea' : 'input', { id, value: state.drafts.get(id) ?? String(fallback),
    ...(multiline ? { rows: 4 } : { type: password ? 'password' : 'text' }), autocomplete: password ? 'new-password' : 'off',
    spellcheck: false, oninput: (e) => state.drafts.set(id, e.target.value) });
  state.drafts.set(id, input.value);
  return node('label', { htmlFor: id, class: multiline ? 'wide' : '' }, label, input);
}
const value = (id) => String(state.drafts.get(id) ?? '');
const num = (id, min = 0, max = 0xffffffff) => integer(value(id), min, max);
function table(headings, rows) {
  return node('div', { class: 'table-wrap' }, node('table', {}, node('thead', {}, node('tr', {}, headings.map((x) => node('th', { scope: 'col' }, x)))),
    node('tbody', {}, rows.map((r) => node('tr', {}, r.map((x) => node('td', {}, x)))))));
}
function result(key) {
  const r = state.results.get(key);
  return r ? node('section', { class: 'result' }, node('h3', {}, L('Last result', '実行結果'), node('time', {}, r.time)), node('pre', {}, r.text)) : null;
}
function output(key, data) { state.results.set(key, { text: typeof data === 'string' ? data : printable(data), time: new Date().toLocaleTimeString() }); }
function event(text, bad = false) {
  state.events.unshift({ text, bad, time: new Date().toLocaleTimeString() });
  state.events.length = Math.min(state.events.length, 100);
  $('activity-list').replaceChildren(...state.events.map((e) => node('li', { class: e.bad ? 'bad' : '' }, node('time', {}, e.time), e.text)));
}
function feedback(text, kind = '') {
  $('feedback').hidden = !text;
  $('feedback').className = kind;
  $('feedback').textContent = text;
}
function invalidateLive() {
  clearInterval(state.keepalive); state.keepalive = null;
  state.clients.clear(); state.plans.clear(); state.debug = null; state.console = null;
}
function errorText(error) {
  if (error instanceof oep.Locked) return L(`Used by ${error.owner ?? 'another tool'}. Close that session and try again.`, `${error.owner ?? '別の道具'}が使用中です。そちらの接続を終了してから操作してください。`);
  if (error instanceof oep.NoSession) return L('Changes are no longer enabled. Enable them again and rebuild the connection or pin assignment.', '変更権が失われました。もう一度有効にし、ピン割当やターゲット接続を作り直してください。');
  if (error instanceof oep.TransportFailed) return L('The response was lost; the operation outcome is unknown. Reconnect and read the state before repeating it. ', '応答を受け取れず、操作結果は不明です。再接続して状態を確認してから操作してください。') + error.message;
  if (error?.name === 'NotFoundError' || error?.name === 'AbortError') return L('Device selection was cancelled.', '機器の選択をキャンセルしました。');
  return error instanceof Error ? error.message : String(error);
}
async function run(title, fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.dataset.busy = 'true';
  document.querySelectorAll('button, input, select, textarea').forEach((b) => { (/** @type {HTMLInputElement} */ (b)).disabled = true; });
  feedback(`${title}…`, 'busy'); event(`${title}…`);
  try {
    const outcome = await fn();
    if (outcome === CANCELLED) { feedback(L(`${title}: cancelled`, `${title}：キャンセルしました`)); event(`${title}: cancelled`); return; }
    if (state.host && state.epoch !== state.host.epoch) {
      await disconnect();
      throw new Error(L('The probe state changed. Temporary assignments and connections were cleared; reconnect before continuing.', 'プローブの状態が変わりました。一時割当と接続を破棄しました。再接続してから続けてください。'));
    }
    feedback(L(`${title}: complete`, `${title}：完了`)); event(`${title}: OK`);
  } catch (error) {
    if (error instanceof oep.NoSession) { invalidateLive(); if (state.host) state.epoch = state.host.epoch; }
    if (error instanceof oep.NoResource) { state.debug = null; state.console = null; }
    if (error instanceof oep.TransportFailed) await disconnect();
    const cancelled = error?.name === 'NotFoundError' || error?.name === 'AbortError';
    feedback(errorText(error), cancelled ? '' : 'bad'); event(`${title}: ${errorText(error)}`, !cancelled);
  } finally {
    state.busy = false; document.body.dataset.busy = 'false'; render();
  }
}
function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = node('a', { href: url, download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function copy(text) {
  return button(L('Copy', 'コピー'), async () => { await navigator.clipboard.writeText(text); });
}
const addressBox = (text) => node('div', { class: 'copy-line' }, node('code', {}, text), copy(text));
const unit = () => state.info?.unitId ?? '<unit-id>';
const pinName = (ch) => state.info?.channelNames.get(ch) ?? `#${ch}`;
function roleChannels(offer) {
  const roles = new Map([...offer.description.roles].map(([r, c]) => [r, [...c]]));
  for (const group of offer.description.groups.values()) for (const [r, ch] of group) roles.set(r, [...new Set([...(roles.get(r) ?? []), ch])]);
  return roles;
}
const offered = (name) => state.caps?.offers.filter((o) => o.entry.name === name && o.entry.revision === 1 && !o.description.unknownCritical.length && !o.description.opsInvalid) ?? [];
const supports = (offer, op) => !offer.description.ops || offer.description.ops.has(op);
function writeGate() {
  if (state.host?.session) return null;
  return notice(node('div', {}, p(L('Reading is available. Enable changes to drive pins, change settings or connect to a target.', '現在は読み取り専用です。ピン出力・設定変更・ターゲット接続には変更操作を有効にします。')),
    button(L('Enable changes', '変更操作を有効にする'), enableChanges, { primary: true })));
}
function connectionLink(label, primary = false) {
  return node('a', { href: '#connect', class: `button${primary ? ' primary' : ''}`, onclick: () => {
    if (parseRoute(location.hash).view !== 'connect') state.returnRoute = parseRoute(location.hash).view === 'home' ? '#setup' : location.hash || '#setup';
  } }, label);
}
function connectCard() {
  const go = connectionLink(L('Choose a probe and connect', 'プローブを選んで接続'), true);
  return card(L('Use your OEP probe', '手元のOEPプローブを使う'),
    p(L('Choose your device in the browser dialog. Its model and functions are read after connecting; no board selection is needed.', 'ブラウザの一覧から機器を選びます。ボードの種類と機能は接続後に読み取るので、事前のボード選択は不要です。'), 'muted'),
    actions(go), p(L('For Raspberry Pi Pico, ESP32, CH32 and custom OEP probes. No account needed.', 'Raspberry Pi Pico、ESP32、CH32などのOEPプローブに対応。アカウントは不要です。'), 'muted'));
}
function showConnect() {
  if (state.host) return [header(L('Your probe is connected', 'プローブは接続済みです'), `${state.info.model} · ${unit()}`),
    link(L('Open the probe workspace', 'プローブの画面へ'), '#probe', true)];
  const serial = value('connect-method') === 'serial';
  const api = serial ? 'serial' : 'usb';
  const browserSupported = !!deviceAPIs[api] && isSecureContext;
  const top = [header(L('Connect your probe', 'プローブに接続'),
    L('Select the actual device in the browser dialog. The probe tells us its model and functions after connection. No board type needs to be selected.',
      'ブラウザの一覧で、実際の機器を選択してください。種類と機能は接続したプローブから読み取ります。ボードの種類を選ぶ必要はありません。')),
    card(L('Connect the device at hand', '手元の機器に接続する'),
      p(serial ? L('The board you just programmed uses its serial port for OEP. Select that same port.', '先ほど書き込んだボードは、OEP接続にもシリアルポートを使います。同じポートを選択してください。')
        : L('Connect the probe’s OEP USB connector, then choose it below. Its name and serial number distinguish multiple devices.', 'プローブのOEP用USB端子につないで、下のボタンから機器を選びます。複数ある場合は名前とシリアル番号で見分けられます。')),
      actions(button(L('Select device and connect', '機器を選択して接続'), () => connect(() => serial ? oep.openWebSerial() : oep.openWebUsb()), { primary: true, disabled: !browserSupported, id: 'connect-selected' })),
      !browserSupported ? notice(L('Use Chrome or Edge over HTTPS or localhost with device access enabled.', 'HTTPSまたはlocalhostのChrome・Edgeで機器へのアクセスを有効にしてください。'), 'warn') : null,
      p(L('If the device does not appear, open the connection help below. Firmware installation is a separate step for a new board.', '一覧に機器が出ない場合は下の接続の案内を開いてください。新しいボードへのfirmware導入は別の手順です。'), 'muted')),
    node('details', { class: 'card', open: state.granted.length > 0 }, node('summary', {}, L('Choose a previously allowed device by its unit ID', '接続を許可済みの個体を、個体IDで選ぶ')),
      p(L('List USB probes this site already has permission to access. Unit IDs distinguish multiple devices of the same kind.', 'このサイトへのアクセスを許可済みのUSBプローブを表示します。同じ種類が複数ある場合は個体IDで区別できます。'), 'muted'),
      actions(button(L('Find allowed probes', '許可済みのプローブを表示'), async () => { state.granted = await oep.getUsbProbes(); state.drafts.set('probes-checked', 'true'); }, { disabled: !deviceAPIs.usb || !isSecureContext })),
      state.granted.length ? node('div', { class: 'choice-grid device-list' }, ...state.granted.map((d) => {
        const known = state.knownProbes.get(d.serialNumber);
        return card(known?.name ?? d.productName ?? L('OEP probe', 'OEPプローブ'),
          p(`${L('Unit ID', '個体ID')}: ${d.serialNumber || L('not provided', '未提供')}`),
          p(known?.features ?? L('Functions and firmware version will be checked after connecting.', '機能とfirmwareの版は接続後に確認します。'), 'muted'),
          actions(button(L('Connect to this device', 'この個体に接続'), () => connect(() => oep.openWebUsb(d, { unitId: d.serialNumber && !d.serialNumber.toLowerCase().startsWith('x-') ? d.serialNumber : undefined })), { primary: true })));
      })) : state.drafts.get('probes-checked') ? p(L('No previously allowed USB probes were found. Use the device chooser above to grant access.', '許可済みのUSBプローブは見つかりませんでした。上のボタンから機器を選び、アクセスを許可してください。'), 'muted') : null),
    node('details', { class: 'card' }, node('summary', {}, L('The probe does not appear / choose another connection method', '機器が見つからない・別の接続方法を使う')),
      p(L('An external USB–serial bridge, or an ESP32 USB-Serial/JTAG port, uses the serial connection. A native USB OEP probe can use HID if its regular USB interface is unavailable.',
        '外付けのUSBシリアル変換やESP32のUSB-Serial/JTAG端子には、シリアル接続を使います。native USBのOEPプローブで通常のUSB接続が使えない場合は、HIDを試せます。')),
      node('div', { class: 'grid' }, serial ? card(L('Direct OEP USB', 'OEPのUSB端子'), p(L('Use the native OEP USB connector on another probe.', '別のプローブやnative USBのOEP端子を使う場合はこちら。')), button(L('Choose a USB device', 'USB機器を選んで接続'), () => connect(() => oep.openWebUsb()), { disabled: !deviceAPIs.usb || !isSecureContext })) : null, card(L('USB serial port', 'USBシリアル端子'), p(L('For classic ESP32, USB–UART converters and USB-Serial/JTAG.', 'classic ESP32、USB–UART変換、USB-Serial/JTAG向け。')),
        button(L('Choose a serial port', 'シリアル端子を選んで接続'), () => connect(() => oep.openWebSerial()), { disabled: !deviceAPIs.serial || !isSecureContext })),
        card(L('HID USB alternative', 'HIDでUSB接続'), p(L('For a probe exposing an OEP HID interface. Not for USB–UART bridges.', 'OEPのHID機能を持つプローブ向け。USB–UART変換には使えません。')),
          button(L('Try the HID connection', 'HIDでの接続を試す'), () => connect(() => oep.openWebHid()), { disabled: !deviceAPIs.hid || !isSecureContext })))),
    card(L('No OEP firmware installed yet?', 'まだOEPを導入していない場合'), p(L('Choose a board and follow its installation instructions before connecting.', 'ボードを選び、firmwareの導入手順を確認してから接続します。')),
      actions(link(L('Prepare a board', 'ボードをプローブにする'), '#firmware')))];
  return top;
}
async function connect(open, expected = null) {
  let h;
  try {
    h = await open();
    const [info, caps] = await Promise.all([oep.core.probeInfo(h), oep.dump.collect(h)]);
    if (expected?.unitId && info.unitId?.toLowerCase() !== expected.unitId.toLowerCase()) throw new Error(L('This is a different probe. Select the programmed device.', '別のプローブです。書き込んだ個体を選んでください。'));
    if (expected && ['esp32','esp32p4','esp32p4x','rp2040','rp2350'].includes(expected.model) && info.model !== expected.model) throw new Error(L('The device model does not match the board just programmed.', '接続した機器のモデルが、書き込んだボードと一致しません。'));
    if (!info.unitId) throw new Error('The probe did not declare a usable unit ID.');
    if (state.installation && ((state.installation.unitId && state.installation.unitId !== info.unitId) || (['esp32','esp32p4','esp32p4x','rp2040','rp2350'].includes(state.installation.model) && state.installation.model !== info.model))) { state.installation = null; state.fwFinished = null; }
    state.host = h; state.info = info; state.caps = caps; state.epoch = h.epoch;
    state.notices = []; state.dirty = false;
    try { await refreshData(); } catch (error) { state.notices.push(errorText(error)); }
    state.knownProbes.set(info.unitId, { name: boardOf(info.model) ? T(boardOf(info.model).name) : info.model, features: `${info.firmware ?? '—'} · ${[...SIGNALS.filter((s) => offered(s.name).length).map((s) => T(s.title)), ...(offered('oep.fixture.logic').length ? [L('Logic capture', 'ロジック取得')] : []), ...(offered('oep.fixture.analog').length ? [L('Analog capture', 'アナログ取得')] : [])].join(' · ')}` });
    if (['home', 'connect'].includes(parseRoute(location.hash).view)) location.hash = state.returnRoute ?? '#setup';
  } catch (e) { if (h) await h.link.close().catch(() => {}); state.host = null; state.info = null; state.caps = null; throw e; }
}
async function disconnect() {
  const h = state.host;
  invalidateLive();
  state.host = null; state.info = null; state.caps = null; state.catalog = null; state.memo = null;
  state.labels = []; state.ports = []; state.settings = []; state.network = null; state.memos = []; state.importPlan = null;
  state.edit = null; state.portRecords.clear();
  state.returnRoute = null; state.dirty = false; state.changeable = false; state.saveable = false; state.notices = []; state.fwUpdateDevice = null;
  state.wizard = { step: 0, found: [], picked: 0, saved: null }; state.results.clear();
  state.drafts.forEach((_, k) => { if (!k.startsWith('fw-')) state.drafts.delete(k); });
  if (h) { try { if (h.session) await h.end(); } finally { await h.link.close(); } }
}
async function enableChanges() {
  const h = state.host;
  if (!h || h.session) return;
  await oep.core.take(h, 10000, { owner: 'OEP Probe Tool' }); state.epoch = h.epoch;
  clearInterval(state.keepalive);
  state.keepalive = setInterval(async () => {
    if (state.host !== h || !h.session) return;
    try { await h.keepalive(); }
    catch (e) { await disconnect().catch(() => {}); event(errorText(e), true); feedback(errorText(e), 'bad'); render(); }
  }, 3000);
}
async function releaseChanges() {
  try { if (state.host?.session) await state.host.end(); } finally { invalidateLive(); if (state.host) state.epoch = state.host.epoch; }
}
async function refreshData() {
  const st = new oep.settings.Settings(state.host);
  state.catalog = await st.catalog();
  state.changeable = await st.changeable(); state.saveable = await st.offers('save');
  state.settings = (await st.offers('get')) ? await st.show() : [];
  state.labels = await oep.settings.labels(state.host);
  state.settingsState = (await st.offers('state')) ? await st.state() : null;
  state.network = (await st.offers('network')) && state.catalog.netif.size ? await st.network() : null;
  state.memo = null; state.memos = [];
  if (offered('oep.probe.memo').length) {
    state.memo = await oep.memo.Memo.open(state.host);
    state.memos = await state.memo.list();
  }
  state.ports = oep.settings.portsNamed(state.labels).map((name) => ({ name,
    lines: state.labels.filter(([, l]) => oep.settings.parseLabel(l)?.[0].toLowerCase() === name.toLowerCase()) }));
  await Promise.all(state.ports.map(async (port) => {
    const record = state.memo ? await state.memo.readPortRecord(port.name) : readLocalRecord(port.name);
    state.portRecords.set(port.name.toLowerCase(), record && typeof record === 'object' && !Array.isArray(record) ? record : {});
  }));
}
function renderChrome() {
  document.documentElement.lang = lang;
  $('language').value = lang;
  $('language-label').textContent = L('Language', '表示言語');
  $('brand-caption').textContent = L('Your probe, ready to work.', 'プローブを準備して、その場で使う。');
  $('version').textContent = `oep-client-js ${oep.VERSION}`;
  $('activity-title').textContent = L('Activity', '操作履歴') + ` · ${state.events.length}`;
  const current = parseRoute(location.hash).view;
  const nav = $('navigation'); nav.replaceChildren(); let group = -1;
  for (const [id, icon, en, ja, g] of NAV) {
    if (group !== g) { nav.append(node('div', { class: 'nav-group' }, [L('Prepare', '準備'), L('Use', '使用'), L('Advanced', '詳細・保守'), L('Learn', '案内')][g])); group = g; }
    nav.append(node('a', { href: `#${id}`, ...(current === id || (id === 'setup' && current === 'connect') || (id === 'setup' && ['target', 'targets'].includes(current)) ? { 'aria-current': 'page' } : {}) }, node('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), L(en, ja)));
  }
  const bar = $('connection-bar');
  if (state.host) bar.replaceChildren(node('span', { class: 'status online' }, `${state.info.model ?? 'OEP'} · ${unit()}`),
    node('span', { class: 'tag' }, state.host.session ? L('Changes enabled', '変更操作 有効') : L('Read only', '読み取り専用')),
    button(state.host.session ? L('Release changes', '変更権を解放') : L('Enable changes', '変更操作を有効にする'), state.host.session ? releaseChanges : enableChanges),
    button(L('Disconnect', '切断'), disconnect));
  else bar.replaceChildren(node('span', { class: 'status' }, L('Not connected', '未接続')), connectionLink(L('Connect a probe', 'プローブに接続')));
  $('environment').replaceChildren(...(!isSecureContext ? [notice(L('Device access needs HTTPS or localhost.', '機器へのアクセスにはHTTPSまたはlocalhostが必要です。'), 'warn')]
    : !deviceAPIs.usb && !deviceAPIs.serial && !deviceAPIs.hid ? [notice(L('Use Chrome or Edge with device access enabled. You can still read the guide and board information.', '機器の接続にはChromeまたはEdgeを使ってください。案内とボード情報はこのブラウザでも読めます。'), 'warn')] : []));
  $('session-notice').replaceChildren(...(state.host?.session ? [notice(L(`Changes enabled. ${state.plans.size} pin assignment(s)${state.debug ? ', target connected' : ''}. Release changes to end temporary operations.`, `変更操作が有効です。ピン割当 ${state.plans.size}件${state.debug ? '・ターゲット接続中' : ''}。変更権の解放で一時的な操作を終了します。`))] : []));
}
function render() {
  renderChrome();
  const route = parseRoute(location.hash);
  const screen = $('screen'); screen.replaceChildren();
  const phase = ['firmware', 'home'].includes(route.view) ? 0 : ['setup','connect','targets','target','settings'].includes(route.view) ? 1 : ['probe','signals','debug','tools'].includes(route.view) ? 2 : -1;
  screen.append(node('nav', { class: 'setup-flow', 'aria-label': L('Setup progress', '準備の流れ') }, ...[['#firmware',L('1. Install firmware','1. 導入')],['#setup',L('2. Configure connections','2. 接続先を設定')],['#probe',L('3. Use your probe','3. 使用')]].map(([href,label],i)=>node('a',{href,...(i===phase?{'aria-current':'step'}:{})},label))));
  for (const n of state.notices) screen.append(notice(n, 'warn'));
  if (NEEDS_HOST.has(route.view) && !state.host) {
    const n = NAV.find(([id]) => id === route.view || (id === 'setup' && ['target','targets'].includes(route.view)));
    screen.append(header(n ? L(n[2], n[3]) : L('Connect first', '接続してください'), L('Connect a probe to open this workspace. You will return here after connecting.', 'プローブに接続すると、この作業画面を開きます。')), connectCard()); return;
  }
  const renderers = { home: showHome, setup: showSetup, connect: showConnect, probe: showProbe, targets: showSetup, target: showConnection, signals: showSignals, debug: showDebug,
    tools: showTools, settings: showSettings, storage: showStorage, firmware: showFirmware, diagnostics: showDiagnostics, help: showHelp };
  try { screen.append(...renderers[route.view](route.arg).filter(Boolean)); }
  catch (e) { screen.append(notice(errorText(e), 'bad')); console.error(e); }
}
function readLocalRecord(name) {
  try { return JSON.parse(localStorage.getItem(`oep-port:${unit()}:${name.toLowerCase()}`) ?? '{}'); }
  catch { return {}; }
}
function metadataFields() {
  return node('section', { class: 'form-section' }, node('h2', {}, L('1. What will you connect?', '1. 何をつなぎますか？')),
    p(L('A connection is a reusable name for the target-side device and its wiring. You can prepare it while the target is disconnected.', '接続先は、プローブの先につなぐ相手と配線に付ける名前です。ターゲットが未接続の状態で準備できます。')),
    field('wizard-name', L('Connection name — e.g. sensor or board-1', '接続名 — 例：sensor、board-1'), 'target'),
    p(L('Used in addresses and pin labels. Start with a letter; use up to 16 letters, digits or hyphens. Renaming changes its OEP address.', 'アドレスとピン名に使います。英字で始まる16文字以内の英数字・ハイフンで指定します。名前を変更するとOEPアドレスも変わります。'), 'muted'),
    field('wizard-part', L('Target IC / board part number (optional)', '相手のIC・基板の型番（任意）')),
    p(L('For example CH32V003F4P6, STM32F103C8T6 or a sensor module name. This is a human-readable record; choose the signal interface and pins below yourself.', '例：CH32V003F4P6、STM32F103C8T6、センサーモジュール名。後から相手を識別するための記録です。使用する信号とピンは下で指定します。'), 'muted'),
    field('wizard-note', L('Wiring notes (optional)', '配線・用途のメモ（任意）'), '', { multiline: true }),
    p(L('Record connector pin numbers, target voltage, intended use or other details needed next time.', 'コネクタの端子番号、ターゲットの電圧、用途など、次に使うときに必要な情報を記録します。'), 'muted'),
    notice(state.memo ? L('Part number and notes are stored in the probe’s memo area.', '型番とメモはプローブのメモ領域へ保存します。') : L('This probe has no memo area. Part number and notes are stored in this browser for this probe; wiring is stored on the probe.', 'このプローブにはメモ領域がないため、型番・メモはこのブラウザ内に個体別で保存します。配線はプローブへ保存します。')));
}
function showSetup() {
  const title = header(L('Configure connections', '接続先を設定する'), L('Name the device you will connect, choose its signals and pins, then save. You can connect and operate the target afterwards.', 'つなぐ相手に名前を付け、使用する信号とピンを指定して保存します。ターゲットへの接続と操作は、その後に行います。'));
  const completed = state.fwFinished ? notice(`${L('Firmware installed', 'firmwareの書き込み完了')}: ${state.fwFinished}`, 'good') : null;
  if (!state.host) return [title, completed,
    notice(state.installation?.phase === 'connecting' ? L('Starting the installed firmware and reconnecting to configure it…', '書き込んだfirmwareの起動を待ち、設定のために再接続しています…') : L('Connect the probe here to read its pins and saved connections. You will stay on this configuration page.', 'ここでプローブに接続すると、ピン候補と保存済みの接続先を読み込みます。そのままこの設定画面で続けられます。')),
    state.installation?.model?.startsWith('esp32p4') ? p(L('If the programming connector was a UART bridge, use the native OEP USB connector or USB-Serial/JTAG connector.', '書き込みにUART変換端子を使った場合は、OEPのnative USB端子またはUSB-Serial/JTAG端子につないでください。')) : null,
    state.installation?.error ? node('details', {}, node('summary', {}, L('Connection status', '再接続の状況')), p(state.installation.error)) : null,
    ...showConnect().slice(1, -1)];
  return [title, completed,
    p(`${state.info.model} · ${unit()} · ${state.info.firmware ?? ''}`, 'muted'),
    ...showTargets().slice(1),
    node('details', { class: 'card' }, node('summary', {}, L('Probe-wide settings and maintenance', 'プローブ本体の設定・保守')),
      p(L('Pin idle states, network settings and settings-file import affect the probe itself. Connection names and wiring are edited above.', 'ピンの待機状態、ネットワーク、設定ファイルの復元など、プローブ本体の設定を変更します。接続名と配線は上の接続先から編集します。')),
      actions(link(L('Open advanced probe settings', '本体の詳細設定を開く'), '#settings'), link(L('Inspect probe capabilities', 'プローブの機能を確認'), '#diagnostics'))),
    actions(link(L('Continue to use the probe', '使用する画面へ進む'), '#probe', true))];
}
async function continueSetup(model, { port = null, unitId = null, serialNumber = null } = {}) {
  state.installation = { model, port, unitId, phase: 'connecting', error: null };
  state.drafts.set('connect-method', port ? 'serial' : 'usb');
  state.firmwareBusy = false;
  location.hash = '#setup'; render();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        if (port) await connect(() => oep.openWebSerial(port, { timeoutMs: 3000, keepSession: false }), { model });
        else {
          const expected = unitId ?? serialNumber;
          const devices = expected && deviceAPIs.usb ? (await oep.getUsbProbes()).filter((d) => d.serialNumber?.toLowerCase() === expected.toLowerCase()) : [];
          if (!devices.length) continue;
          await connect(() => oep.openWebUsb(devices[0], { keepSession: false }), { model, unitId });
        }
        state.installation.phase = 'connected'; state.installation.unitId = state.info.unitId; return;
      } catch (error) { state.installation.error = errorText(error); }
    }
    state.installation.phase = 'permission';
  } finally { render(); }
}
function showHome() {
  return [node('section', { class: 'intro' }, p('OPEN EMBEDDED PROBE', 'eyebrow'), node('h1', {}, L('A workspace for your development probe.', '開発プローブを、ブラウザから。')),
    p(L('Start by installing OEP on your board. Then connect it to configure pins, exchange signals and work with your target.', 'まずボードへOEPを書き込みます。そのあとプローブとして接続し、ピンの設定、信号の送受信、ターゲットの調査を行います。'))),
    state.host ? entry(L('Configure connections', '接続先を設定する'), `${state.info.model} · ${unit()}`, '#setup', 'CONNECTED') : card(L('Start with a new board', 'まずは新規書き込みから'), p(L('Install OEP, then connect and use your probe. Everything from serial installation to signal I/O runs in this browser.', 'OEPを書き込んでから、プローブとして接続して使います。シリアルからの初回導入も、導入後の操作も、このブラウザで行います。')), link(L('Install OEP on a new board', '新しいボードにOEPを書き込む'), '#firmware', true)),
    node('div', { class: 'grid' }, entry(L('Already installed? Connect your probe', '導入済みのプローブを接続する'), L('Use this if OEP firmware is already installed.', 'OEPのfirmwareを書き込み済みの場合はこちら。'), '#connect', '02 / CONNECT'),
      entry(L('Understand OEP & choose a board', 'OEPを知る・ボードを選ぶ'), L('Compare debug, I/O and capture capabilities.', 'デバッグ・入出力・取得機能の違いを比較します。'), '#help', '02 / EXPLORE')),
    p(L('Device data stays in your browser. Firmware is fetched from this site. No login needed.', '機器のデータはブラウザ内で扱います。firmwareはこのサイトから取得します。ログインは不要です。'), 'muted')];
}
function showProbe() {
  const info = state.info;
  const b = boardOf(info.model);
  return [header(L('My probe', 'プローブ'), L('Check the connected device, then choose what to do.', '接続中の個体と機能を確認し、作業を選びます。')),
    card(b ? T(b.name) : info.model, node('dl', {}, ...[
      [L('Unit ID', '個体ID'), unit()], [L('Firmware', 'firmware'), info.firmware ?? '—'], [L('Connection', '接続経路'), state.host.link.transport.kind ?? '—'],
      [L('Pins', 'ピン'), String(info.channelNames.size)], [L('Registered connections', '登録済みの接続先'), String(state.ports.length)],
    ].flatMap(([a, b]) => [node('dt', {}, a), node('dd', {}, b)])),
      actions(link(L('Edit connections','接続先を設定・編集'),'#setup',true),button(L('Refresh device data', '状態を読み直す'), refreshData), link(L('Update firmware', 'firmwareを更新'), '#firmware'))),
    node('div', { class: 'grid' },
      entry(L('Set up reusable wiring', '配線を登録して使う'), L('Save known wiring now and attach later. Scan unknown wiring only when needed.', '配線を先に保存して、ターゲットは後で接続します。不明な配線だけ必要に応じて探索できます。'), '#setup', '01 / CONNECT'),
      entry(L('Control signals', '信号を操作する'), SIGNALS.filter((s) => offered(s.name).length).map((s) => T(s.title)).join(' · ') || L('No supported signal interfaces', '対応する信号機能はありません'), '#signals', '02 / I/O'),
      entry(L('Inspect a target', 'ターゲットを調べる'), L('Debug, memory, registers and target console.', 'デバッグ・メモリ・レジスタ・ターゲットコンソール。'), '#debug', '03 / DEBUG'),
      entry(L('Capture with WireSkein', 'WireSkeinで波形を取る'), L('Use this probe from capture and development tools.', 'このプローブをキャプチャや開発の道具から使います。'), '#tools', '04 / CAPTURE')),
    card(L('Declared capabilities', '宣言された機能'), node('div', { class: 'row' }, ...state.caps.offers.map((o) => node('span', { class: 'tag' }, `${o.entry.name.replace(/^oep\./, '')} · ${o.entry.instance}`))),
      actions(link(L('View full declarations', '詳しい宣言を見る'), '#diagnostics')))];
}
function showSignals(arg) {
  const tool = SIGNALS.find((s) => s.id === arg) ?? SIGNALS.find((s) => offered(s.name).length) ?? SIGNALS[0];
  const offers = offered(tool.name);
  const tabs = node('nav', { class: 'function-choices', 'aria-label': L('Signal type', '信号の種類') }, ...SIGNALS.map((s) => node('a', {
    href: `#signals/${s.id}`, class: `function-choice${offered(s.name).length ? '' : ' unavailable'}`, ...(tool.id === s.id ? { 'aria-current': 'page' } : {}) },
    node('strong', {}, T(s.title)), node('span', {}, T(s.description)), node('small', {}, offered(s.name).length
      ? `${L('Available interfaces', '使える系統')}: ${offered(s.name).length}` : L('Not available on this probe', 'このプローブは非対応')))));
  const top = [header(L('Signal I/O', '信号を操作'), T(tool.description)), tabs];
  if (!offers.length) return [...top, notice(L('This probe does not declare a supported revision of this interface.', 'このプローブは、この機能の対応revisionを宣言していません。'))];
  const selector = choiceCards(`signal-${tool.id}-instance`, L('Choose a hardware interface', '使用する機能を選ぶ'), offers.map((o) => ({
    value: o.entry.fn, title: `${T(tool.title)} · ${L('Interface', '系統')} ${o.entry.instance}`,
    description: T(tool.description), facts: [
      o.description.maxClockHz ? `${L('Maximum clock', '上限クロック')}: ${o.description.maxClockHz.toLocaleString()} Hz` : null,
      o.description.maxLength ? `${L('Maximum transfer', '最大転送')}: ${o.description.maxLength} bytes` : null,
      `${L('Pin candidates', 'ピン候補')}: ${[...new Set([...roleChannels(o).values()].flat())].length} ${L('pins', '本')}`,
      state.plans.has(o.entry.fn) ? L('Pins already assigned in this session', 'このセッションで割当済み') : L('No pins assigned by this page yet', 'このページでのピン割当は未設定'),
    ].filter(Boolean),
  })), offers[0].entry.fn);
  const offer = offers.find((o) => o.entry.fn === +value(`signal-${tool.id}-instance`)) ?? offers[0];
  const key = `signal-${offer.entry.fn}`;
  const cls = tool.id === 'uart' ? oep.fixture.FixtureUart : tool.Class;
  const getClient = async () => {
    if (!state.clients.has(offer.entry.fn)) state.clients.set(offer.entry.fn, await (/** @type {any} */ (tool.Class)).open(state.host, { fn: offer.entry.fn }));
    return state.clients.get(offer.entry.fn);
  };
  const pins = [...roleChannels(offer)].map(([role, channels]) => {
    const name = oep.interfaces.KNOWN[tool.name]?.roles[role] ?? `${L('Input/output', '入出力')} ${role}`;
    return selectField(`${key}-pin-${role}`, name, [['', L('Not assigned', '割り当てない')], ...channels.map((ch) => [ch, pinName(ch)])]);
  });
  const pinCard = card(L('1. Assign pins', '1. ピンを割り当てる'), selector,
    p(L('Only the declared pin candidates are shown. Assignments stay active until released or changes are disabled.', 'プローブが宣言するピン候補を表示します。割当は、解放するか変更権を解放するまで有効です。'), 'muted'),
    node('div', { class: 'fields' }, ...pins),
    state.plans.has(offer.entry.fn) ? notice(state.plans.get(offer.entry.fn).map(([, r, ch]) => `${oep.interfaces.KNOWN[tool.name]?.roles[r] ?? r}: ${pinName(ch)}`).join(' · '), 'good') : null,
    actions(button(L('Apply pin assignment', 'ピン割当を適用'), async () => {
      /** @type {[number, number, number][]} */
      const assignments = [...roleChannels(offer).keys()].filter((r) => value(`${key}-pin-${r}`) !== '').map((r) => [offer.entry.fn, r, num(`${key}-pin-${r}`, 0, 65534)]);
      if (!assignments.length) throw new Error(L('Choose at least one pin.', '少なくとも1本のピンを選んでください。'));
      if (new Set(assignments.map((a) => a[2])).size !== assignments.length) throw new Error(L('Each role needs a different pin.', 'それぞれの役割に異なるピンを指定してください。'));
      await oep.core.planApply(state.host, assignments); state.plans.set(offer.entry.fn, assignments);
    }, { write: true, primary: true }),
    button(L('Release pins', 'ピンを解放'), async () => { await oep.core.planRelease(state.host, [offer.entry.fn]); state.plans.delete(offer.entry.fn); state.clients.delete(offer.entry.fn); }, { write: true }),
    button(L('Read limits', '制限値を読む'), async () => { const c = await getClient(); output(key, c.declarations ? await c.declarations() : { modes: c.modes ? await c.modes() : null, declaration: oep.dump.describeOffer(offer) }); })), result(`${key}-pins`));
  const ops = tool.operations.filter((op) => supports(offer, cls[op.method]));
  const operationCards = ops.map((op) => {
    const prefix = `${key}-${op.id}`;
    const fields = op.fields.map((f) => {
      if (tool.id === 'gpio' && f.key === 'channel') return selectField(`${prefix}-${f.key}`, T(f.label), [...new Set([...roleChannels(offer).values()].flat())].map((ch) => [ch, pinName(ch)]));
      const modes = tool.id === 'gpio' && f.key === 'mode' ? oep.catalog.firstFixed(offer.tlvs, oep.fixture.Gpio.TAG_MODES, 4) : null;
      const options = modes ? f.options.filter(([v]) => (new DataView(modes.buffer, modes.byteOffset, 4).getUint32(0, true) >>> +v) & 1) : f.options;
      return options ? selectField(`${prefix}-${f.key}`, T(f.label), options.map(([v, t]) => [v, T(t)]), f.value)
        : field(`${prefix}-${f.key}`, T(f.label), f.value, { multiline: f.kind === 'hex' || f.key === 'text' });
    });
    return card(T(op.label), node('div', { class: 'fields' }, ...fields), actions(button(T(op.label), async () => {
      const raw = Object.fromEntries(op.fields.map((f) => [f.key, value(`${prefix}-${f.key}`)]));
      const vals = valuesFor(op.fields, raw);
      const c = await getClient();
      try {
        const response = await op.run(c, vals);
        output(prefix, response);
        if (response?.ok === false) throw new Error(['I2C transfer failed', 'I2C address NACK', 'I2C data NACK', 'I2C bus error', 'I2C stretch timeout'][response.result] ?? `I2C result ${response.result}`);
      } catch (error) {
        output(prefix, { response: state.results.get(prefix)?.text, error: errorText(error), done: error.done, data: error.data, values: error.values });
        throw error;
      }
    }, { write: op.write, primary: true })), result(prefix));
  });
  return [...top, writeGate(), pinCard, result(key), node('div', { class: 'grid' }, ...operationCards)];
}
const wireOffers = () => ['oep.wire.rvswd', 'oep.wire.swio', 'oep.wire.swd'].flatMap(offered);
function wireClient(offer) {
  return offer.entry.name === 'oep.wire.swd' ? new oep.arm.SwdWire(state.host, offer.entry.fn, offer.entry.name)
    : new oep.riscv.Wire(state.host, offer.entry.fn, offer.entry.name);
}
function portBindings(port, offer) {
  const bindings = /** @type {[number,number][]} */ ([...roleChannels(offer).keys()].flatMap((role) => {
    const line = port.lines.find(([, label]) => oep.settings.parseLabel(label)?.[1]?.toLowerCase() === roleLine(offer, role));
    return line ? [[role, line[0]]] : [];
  }));
  if (offer.entry.name.startsWith('oep.wire.') && (!bindings.some(([r]) => r === 1) || (offer.entry.name !== 'oep.wire.swio' && !bindings.some(([r]) => r === 2)))) return null;
  try { return validateBindings(offer.description.roles, offer.description.groups, bindings); }
  catch { return null; }
}
function usePort(port, offer) {
  const bindings = portBindings(port, offer);
  if (offer.entry.name.startsWith('oep.wire.') && state.debug) throw new Error(L('Detach the current target before loading different wiring.', '別の配線を読み込む前に、接続中のターゲットを切り離してください。'));
  if (!bindings) throw new Error(L('The saved wiring is not compatible with this interface.', '保存した配線は、この機能のピン候補に対応していません。'));
  if (offer.entry.name.startsWith('oep.wire.')) {
    state.drafts.set('debug-wire', String(offer.entry.fn));
    state.drafts.delete('debug-dio'); state.drafts.delete('debug-clk');
    for (const [r, ch] of bindings) if (r === 1 || r === 2) state.drafts.set(r === 1 ? 'debug-dio' : 'debug-clk', String(ch));
    location.hash = '#debug';
  } else {
    const tool = SIGNALS.find((s) => s.name === offer.entry.name);
    state.drafts.set(`signal-${tool.id}-instance`, String(offer.entry.fn));
    for (const role of roleChannels(offer).keys()) state.drafts.set(`signal-${offer.entry.fn}-pin-${role}`, '');
    for (const [role, ch] of bindings) state.drafts.set(`signal-${offer.entry.fn}-pin-${role}`, String(ch));
    location.hash = `#signals/${tool.id}`;
  }
}
function showTargets() {
  return [header(L('Connections', '接続先'), L('Names and wiring saved in this probe. Registration does not mean the target is connected or powered now.', 'このプローブに登録された名前と配線です。現在ターゲットが接続・通電されていることを示すものではありません。')),
    actions(node('a', { href: '#target/new', class: 'button primary', onclick: () => newConnection() }, L('Add a connection', '接続先を追加')), button(L('Refresh', '読み直す'), refreshData)),
    !state.ports.length ? card('', p(L('No connections have been registered yet.', '接続先はまだ登録されていません。'), 'empty')) : null,
    state.saveNotice ? notice(state.saveNotice,state.dirty?'warn':'good') : null,
    ...state.ports.map((port) => card(port.name,
      p(`${L('Target part','相手の型番')}: ${state.portRecords.get(port.name.toLowerCase())?.part || L('not recorded','未記入')}`),
      state.portRecords.get(port.name.toLowerCase())?.note ? p(state.portRecords.get(port.name.toLowerCase()).note,'muted') : null,
      p(port.lines.map(([ch, label]) => `${label} → ${pinName(ch)}`).join(' · '), 'muted'), addressBox(`oep://${unit()}/${port.name}`),
      p(L('Choose how to use this wiring. Loading it does not attach or drive pins.', 'この配線を使う機能を選びます。呼び出しただけではターゲット接続・ピン駆動は行いません。'), 'muted'),
      actions(link(L('Edit connection','接続先を編集'),`#target/edit/${port.name}`,true), ...registrationOffers().filter((o) => portBindings(port, o)).map((o) => button(L(`Use ${registrationTitle(o)}`, `${registrationTitle(o)}で使う`), async () => usePort(port, o))), link(L('Use from tools', '道具から使う'), '#tools'),
        state.memo ? button(L('Read notes', '記録を読む'), async () => { output(`port-${port.name}`, await state.memo.readPortRecord(port.name) ?? L('No notes.', '記録はありません。')); }) : null,
        state.changeable ? button(L('Remove registration', '登録を削除'), async () => {
          if (!confirm(L(`Remove ${port.name}, its saved wiring and its part number / notes?`, `${port.name}の接続名・配線・型番・メモを削除します。`))) return CANCELLED;
          state.dirty = true;
          try {
            await new oep.settings.Settings(state.host).unsetNamed('core', port.lines.map(([ch]) => `channel.${pinName(ch)}.label`));
            if (state.saveable){await new oep.settings.Settings(state.host).save();state.dirty=false;}
            if (state.memo){try{await state.memo.delete(oep.memo.portRecordName(port.name));} catch (error){if (!(error instanceof oep.NoResource))throw error;}}
            else localStorage.removeItem(`oep-port:${unit()}:${port.name.toLowerCase()}`);
          } finally {await refreshData();}
        }, { write: true, danger: true }) : null), result(`port-${port.name}`))),
    state.dirty ? notice(L('Settings have changes not saved to persistent storage. Save them in Settings to keep them after restarting.', '永続保存していない設定変更があります。再起動後も残す場合は「設定」で保存してください。'), 'warn') : null];
}
const registrationOffers = () => [...wireOffers(), ...SIGNALS.flatMap((s) => offered(s.name))];
const roleLine = (offer, role) => {
  const name = (oep.interfaces.KNOWN[offer.entry.name]?.roles[role] ?? `line${role}`).toLowerCase();
  return name === 'reset' ? 'nrst' : name;
};
function registrationTitle(offer) {
  const tool = SIGNALS.find((s) => s.name === offer.entry.name);
  return `${tool ? T(tool.title) : offer.entry.name.replace('oep.wire.', '').toUpperCase()} · ${offer.entry.instance}`;
}
function editorExtras(offer) {
  const roles = offer ? new Set([...roleChannels(offer).keys()].map((r) => roleLine(offer,r))) : new Set();
  return [...(state.edit?.original.lines ?? []).filter(([,label]) => !roles.has(oep.settings.parseLabel(label)?.[1]?.toLowerCase())).map(([ch,label]) => ({ id: String(ch), ch, line: label.slice(state.edit.original.name.length).replace(/^\./,'') })), ...(state.wizard.additional ?? [])];
}
function selectedWiring(offer) {
  const bindings = /** @type {[number,number][]} */ (offer ? [...roleChannels(offer).keys()].filter((r) => value(`registration-pin-${offer.entry.fn}-${r}`) !== '').map((r) => [r, num(`registration-pin-${offer.entry.fn}-${r}`, 0, 65534)]) : []);
  if (offer) {
    validateBindings(offer.description.roles, offer.description.groups, bindings);
    if (offer.entry.name.startsWith('oep.wire.') && (!bindings.some(([r]) => r===1) || (offer.entry.name !== 'oep.wire.swio' && !bindings.some(([r]) => r===2)))) throw new Error(L('Specify each debug signal pin.', 'デバッグの各信号ピンを指定してください。'));
  }
  const desired = bindings.map(([r,ch]) => {
    const line = roleLine(offer,r);
    const old = state.edit?.original.lines.map(([,l]) => oep.settings.parseLabel(l)).find((l)=>l?.[1]?.toLowerCase()===line);
    return [ch, `${line}${old?.[2] ? '@'+old[2] : ''}`];
  });
  for (const row of editorExtras(offer)) if (value(`extra-pin-${row.id}`) !== '') desired.push([num(`extra-pin-${row.id}`,0,65534),value(`extra-line-${row.id}`).trim()]);
  return desired;
}
async function saveConnection(offer, desired) {
  const name = value('wizard-name').trim();
  const original = state.edit?.original ?? null;
  await refreshData();
  const plan = connectionChange({ name, labels: state.labels, original, desired });
  const st = new oep.settings.Settings(state.host);
  state.saveNotice = null;
  let stage = L('applying wiring', '配線の適用');
  try {
    if (plan.unset.length || plan.set.length) state.dirty = true;
    if (plan.unset.length) await st.unsetNamed('core', plan.unset.map((ch)=>`channel.${pinName(ch)}.label`));
    if (plan.set.length) await st.setNamed('core', Object.fromEntries(plan.set.map(([ch,label])=>[`channel.${pinName(ch)}.label`,label])));
    stage = L('saving probe settings', 'プローブへの永続保存');
    if (state.saveable) { await st.save(); state.dirty = false; }
    stage = L('saving part number and notes', '型番・メモの保存');
    const previous = original ? state.portRecords.get(original.name.toLowerCase()) ?? {} : {};
    const fields = { ...previous, part: value('wizard-part'), note: value('wizard-note'), ...((plan.unset.length || plan.set.length) ? { target: null } : {}) };
    const renamed = original && original.name.toLowerCase() !== name.toLowerCase();
    if (state.memo) {
      await state.memo.updatePortRecord(name, fields);
      if (renamed) { try { await state.memo.delete(oep.memo.portRecordName(original.name)); } catch(error) { if (!(error instanceof oep.NoResource)) throw error; } }
    } else {
      const record = Object.fromEntries(Object.entries(fields).filter(([,v])=>v !== null && v !== ''));
      localStorage.setItem(`oep-port:${unit()}:${name.toLowerCase()}`, JSON.stringify(record));
      if (renamed) localStorage.removeItem(`oep-port:${unit()}:${original.name.toLowerCase()}`);
    }
    state.saveNotice = state.saveable ? L(`Saved ${name}. Choose Edit to change it, or a tool to use its wiring.`, `${name}を保存しました。「編集」で変更でき、使用する機能を選ぶと配線を呼び出せます。`) : L(`Applied ${name}. This probe cannot save settings across restarts.`, `${name}を適用しました。このプローブは再起動後の永続保存に対応していません。`);
    state.edit = null; resetWizard(); location.hash = '#setup';
  } catch(error) {
    throw new Error(L(`Could not complete ${stage}. Some changes may already be applied. Reload the connection before retrying. `, `${stage}を完了できませんでした。変更が一部適用されている可能性があります。接続先を読み直してから再試行してください。`) + errorText(error));
  } finally { await refreshData(); }
}
function fixedRegistration(top) {
  const offers = registrationOffers();
  const choices = choiceCards('registration-function', L('2. Which signals will you use?', '2. どの信号を使いますか？'), [...offers.map((offer) => ({
    value: offer.entry.fn, title: registrationTitle(offer),
    description: ({ 'oep.wire.rvswd': L('WCH RISC-V debug connector: SWDIO + SWCLK.', 'WCHのRISC-V向けデバッグ端子。SWDIOとSWCLKを使います。'), 'oep.wire.swio': L('CH32V00x debug connector: one SWIO signal.', 'CH32V00x向けデバッグ端子。SWIOの1本を使います。'), 'oep.wire.swd': L('ARM debug connector: SWDIO + SWCLK.', 'ARM向けデバッグ端子。SWDIOとSWCLKを使います。') })[offer.entry.name] ?? T(SIGNALS.find((s) => s.name === offer.entry.name)?.description),
    facts: [Object.values(oep.interfaces.KNOWN[offer.entry.name]?.roles ?? {}).join(' / '), `${L('Pin candidates', 'ピン候補')}: ${[...new Set([...roleChannels(offer).values()].flat())].length}`],
  })), { value:'custom', title:L('Other signal names','その他の信号名'), description:L('Name a custom connector or preserve signals already registered by another tool.','独自のコネクタや、他のツールで登録した信号名を編集します。'), facts:[] }], offers[0]?.entry.fn ?? 'custom');
  const offer = offers.find((o) => o.entry.fn === +value('registration-function'));
  const labels = new Map(state.labels);
  const owned = new Set(state.edit?.original.lines.map(([ch])=>ch) ?? []);
  const fields = offer ? [...roleChannels(offer)].map(([role,pins]) => selectField(`registration-pin-${offer.entry.fn}-${role}`,
    `${oep.interfaces.KNOWN[offer.entry.name]?.roles[role] ?? role}${offer.entry.name==='oep.fixture.uart' ? role===1 ? L(' ← target TX',' ← 相手のTX') : L(' → target RX',' → 相手のRX') : ''}`,
    [['',L('Not assigned','割り当てない')],...pins.map((ch)=>[ch,`${pinName(ch)}${labels.has(ch)?` · ${labels.get(ch)}`:''}`])], pins.length===1 && (!labels.has(pins[0]) || owned.has(pins[0])) && role!==3 ? String(pins[0]) : '')) : [];
  const extras = editorExtras(offer);
  return [...top, card('', metadataFields(), choices,
    node('section',{class:'form-section'},node('h2',{},L('3. Which probe pin carries each signal?','3. プローブのどのピンを使いますか？')),
      p(L('Choose the probe-side pins. The target may be disconnected or unpowered; saving does not drive these pins.','プローブ側のピンを指定します。相手は未配線・未通電で構いません。保存だけではピンを駆動しません。')),
      node('div',{class:'fields'},...fields),
      ...extras.map((row)=>node('div',{class:'fields'},field(`extra-line-${row.id}`,L('Signal name','信号名'),row.line),selectField(`extra-pin-${row.id}`,L('Probe pin (blank removes this signal)','プローブのピン（空欄でこの信号を削除）'),[['',L('Not assigned','割り当てない')],...[...state.info.channelNames].map(([ch,name])=>[ch,name])],row.ch===null?'':String(row.ch)))),
      button(L('Add another signal','信号を追加'),async () => {state.wizard.additional??=[];state.wizard.additional.push({id:`new${state.wizard.additional.length}`,ch:null,line:''});}),
      p(L('To move a registered signal, select its new pin. Clear the assignment to remove it. Pins used by another connection cannot be overwritten.','登録済みの信号はピンを選び直して変更できます。割当を空欄にすると削除します。他の接続先が使用するピンは上書きしません。'),'muted')),
    state.dirty ? notice(L('Saving also preserves all other current probe settings.','保存すると、プローブの他の現在の設定もまとめて永続保存します。'),'warn') : null,
    actions(button(state.edit ? L('Save changes','変更を保存') : L('Save connection','接続先を保存'),async () => {const desired=selectedWiring(offer);await enableChanges();await saveConnection(offer,desired);},{primary:true,disabled:!state.changeable}),node('a',{href:'#setup',class:'button',onclick:() => newConnection()},L('Cancel and return to configuration','キャンセルして設定へ戻る'))),
    p(L('Save → return to configuration → choose a tool when you are ready. The target is not attached automatically.','保存時にプローブの設定変更権限を取得します。完了すると接続先の設定画面へ戻ります。使うときに操作画面を選び、明示的に接続・出力を開始します。'),'muted'))];
}
function showConnection(arg) {
  if (arg.startsWith('edit/')) {
    const name = arg.slice(5);
    const port = state.ports.find((p)=>p.name.toLowerCase()===name.toLowerCase());
    if (!port) return [header(L('Connection not found','接続先が見つかりません'),L('It may have been renamed or removed.','名前の変更または削除が行われた可能性があります。')),link(L('Back to configuration','設定へ戻る'),'#setup',true)];
    if (state.edit?.original.name !== port.name) {
      resetWizard(); clearConnectionDrafts();
      state.edit = { original:{ name:port.name, lines:port.lines.map(([ch,label])=>[ch,label]) } };
      const record = state.portRecords.get(port.name.toLowerCase()) ?? {};
      state.drafts.set('wizard-name',port.name); state.drafts.set('wizard-part',typeof record.part==='string'?record.part:'');state.drafts.set('wizard-note',typeof record.note==='string'?record.note:'');
      const compatible = registrationOffers().map((o)=>({o,bindings:portBindings(port,o)})).filter((x)=>x.bindings).sort((a,b)=>b.bindings.length-a.bindings.length);
      const offer=compatible[0]?.o;
      state.drafts.set('registration-function',offer?String(offer.entry.fn):'custom');
      if (offer) for (const role of roleChannels(offer).keys()) state.drafts.set(`registration-pin-${offer.entry.fn}-${role}`,'');
      if (offer) for (const [role,ch] of compatible[0].bindings) state.drafts.set(`registration-pin-${offer.entry.fn}-${role}`,String(ch));
    }
    return fixedRegistration([header(L(`Edit ${port.name}`,`${port.name}を編集`),L('Change its name, part number, notes or wiring in one place. Saving returns to configuration.','接続名・型番・メモ・配線をこの画面で変更できます。保存すると設定画面へ戻ります。'))]);
  }
  if (state.edit){state.edit=null;resetWizard();clearConnectionDrafts();}
  return showWizard();
}
function clearConnectionDrafts() { state.drafts.forEach((_,key)=>{if (/^(wizard-|registration-pin-|registration-function|extra-)/.test(key))state.drafts.delete(key);}); }
function newConnection() { state.edit=null;resetWizard();clearConnectionDrafts();state.drafts.set('registration-mode','fixed'); }
function resetWizard() { state.wizard = { step: 0, found: [], picked: 0, saved: null }; }
function showWizard() {
  const w = state.wizard;
  const offers = wireOffers().filter((o) => supports(o, oep.riscv.WireBase.SCAN));
  const manual = value('registration-mode') !== 'scan';
  const steps = [L('1. Candidates','1. 候補ピン'),L('2. Scan','2. 探索'),L('3. Save wiring','3. 配線を保存')];
  const activeStep = w.step;
  if (manual) return fixedRegistration([header(L('Add a connection','接続先を追加'),L('Describe the device, choose signals and pins, then save. A connected target is not required.','つなぐ相手、使用する信号、ピンを指定して保存します。ターゲットへの接続は不要です。')),node('details',{},node('summary',{},L('The debug wiring is unknown? Scan it (optional)','デバッグの配線が不明な場合は探索する（任意）')),p(L('Scanning tries selected pins against a powered target.','給電したターゲットに対して選んだ候補ピンの組を試します。')),button(L('Open optional scan','任意の探索を開く'),async () => {state.drafts.set('registration-mode','scan');resetWizard();}))]);
  const top = [header(L('Find unknown debug wiring', '不明なデバッグ配線を探索'), L('Use a powered target to test selected pin pairs, then save the responding wiring.', '給電したターゲットに対して候補ピンの組を試し、応答のある配線を保存します。')),actions(button(L('Specify fixed wiring instead','固定ピン指定へ戻る'),async () => {state.drafts.set('registration-mode','fixed');resetWizard();})),
    node('ol', { class: 'wizard' }, ...steps.map((name, i) => node('li', { class: activeStep === i ? 'current' : activeStep > i ? 'done' : '', ...(activeStep === i ? { 'aria-current': 'step' } : {}) }, name))), writeGate()];
  if (!manual && !offers.length) return [...top, notice(L('This probe has no supported scan operation. Choose known pins above to register wiring without scanning.', 'このプローブには対応する探索操作がありません。上の「決まっているピンを指定」で、探索せずに配線を登録できます。'))];
  if (w.step === 0) {
    const wire = wireChoices('wizard-wire', offers, () => {
      state.drafts.forEach((_, k) => { if (k.startsWith('wizard-pin-')) state.drafts.delete(k); }); resetWizard();
    });
    const offer = offers.find((o) => o.entry.fn === +value('wizard-wire')) ?? offers[0];
    const candidates = [...new Set([...roleChannels(offer)].filter(([r]) => r !== 3).flatMap(([, pins]) => pins))];
    const labels = new Map(state.labels);
    return [...top, card(L('Select only the pins you wired', '配線したピンだけを選ぶ'),
      p(L('Connect a common GND and power your target at a compatible voltage. RVSWD / SWD use SWDIO + SWCLK; SWIO uses one signal.', 'GNDを共通にし、対応する電圧でターゲットを給電します。RVSWD・SWDはSWDIOとSWCLK、SWIOは信号1本を使います。')),
      wire, node('div', { class: 'pin-list' }, ...candidates.map((ch) => {
        const id = `wizard-pin-${ch}`;
        return node('label', {}, node('input', { type: 'checkbox', checked: value(id) === 'true', disabled: labels.has(ch),
          onchange: (e) => state.drafts.set(id, String(e.target.checked)) }), pinName(ch), labels.has(ch) ? node('small', {}, labels.get(ch)) : null);
      })), actions(button(L('Continue to scan', '探索へ進む'), async () => {
        const selected = candidates.filter((ch) => value(`wizard-pin-${ch}`) === 'true');
        if (selected.length < (offer.entry.name === 'oep.wire.swio' ? 1 : 2)) throw new Error(L('Select the pins connected to your target.', 'ターゲットに配線したピンを選んでください。'));
        w.step = 1; w.found = []; w.picked = 0;
      }, { primary: true })))];
  }
  if (w.step === 1) return [...top, card(L('Find the target', 'ターゲットを探す'),
    p(L('Only your selected pins will be tried. Scan can drive these pins. Enable changes before scanning.', '選択したピンの組だけを試します。探索ではこれらのピンを駆動します。変更操作を有効にしてから実行してください。')),
    button(L('Scan selected pins', '選択したピンで探索'), async () => {
      const offer = offers.find((o) => o.entry.fn === +value('wizard-wire'));
      const wire = wireClient(offer);
      const selected = new Set([...state.drafts].filter(([k, v]) => k.startsWith('wizard-pin-') && v === 'true').map(([k]) => +k.slice('wizard-pin-'.length)));
      const pairs = (await wire.candidatePairs()).filter(([a, b]) => selected.has(a) && (b === 65535 || selected.has(b)));
      if (!pairs.length) throw new Error(L('This pin combination is not declared for this line.', 'このピンの組は、この線の候補として宣言されていません。'));
      w.found = []; w.picked = 0;
      w.found = (await wire.scan(pairs)).map((r) => ({ ...r, offer }));
      output('scan', { tried: pairs.length, found: w.found.length });
    }, { write: true, primary: true }), result('scan'),
    ...w.found.map((f, i) => node('label', { class: 'select-result' }, node('input', { type: 'radio', name: 'found', checked: w.picked === i, onchange: () => { w.picked = i; } }),
      `${f.pins.map(pinName).filter((_, j) => f.pins[j] !== 65535).join(' / ')} · ID 0x${f.dmstatus.toString(16).padStart(8, '0')}`)),
    !w.found.length && state.results.has('scan') ? notice(L('No target responded. Check GND, power, line type and wiring before retrying.', 'ターゲットから応答がありません。GND・電源・線の種類・配線を確認してください。'), 'warn') : null,
    actions(button(L('Back to wiring', '配線に戻る'), async () => { w.step = 0; }), button(L('Name this connection', '名前を付ける'), async () => { w.step = 2; }, { disabled: !w.found.length, primary: true })))];
  if (w.step === 2) {
    const f = w.found[w.picked];
    const bindings = [[1, f.pins[0]], ...(f.pins[1] === 65535 ? [] : [[2, f.pins[1]]])];
    return [...top, card(L('Save the wiring', '配線を保存'), p(bindings.map(([r, ch]) => `${roleLine(f.offer, r)} → ${pinName(ch)}`).join(' · ')),
      notice(manual ? L('Wiring is not tested. Saving only changes labels; it does not scan, attach, or drive pins.', '配線は動作未確認です。保存はピン名の設定だけを変更し、スキャン・ターゲット接続・ピン駆動は行いません。') : L('The scan response confirms these pins at scan time only.', 'スキャン時点で応答のあったピンです。現在の接続状態を保証するものではありません。')),
      metadataFields(),
      state.dirty ? notice(L('Saving this connection also saves all other current settings on the probe.', '接続先の保存時に、プローブの他の現在の設定もまとめて永続保存します。'), 'warn') : null,
      p(L('The connection name prefixes each signal label, such as target.swdio or sensor.sda. Notes are saved when memo storage is available.', '接続名と信号名からtarget.swdioやsensor.sdaなどのピン名を作ります。メモ領域があれば型番とメモも保存します。'), 'muted'),
      !state.changeable ? notice(L('This probe has no writable settings; connection names cannot be saved.', 'このプローブには変更可能な設定がなく、接続名を保存できません。'), 'warn') : null,
      actions(button(manual ? L('Back to pin selection', 'ピン指定へ戻る') : L('Back to results', '探索結果へ戻る'), async () => { w.step = manual ? 0 : 1; }), button(L('Save connection', '接続先を保存'), async () => {
        await saveConnection(f.offer,bindings.map(([r,ch])=>[ch,roleLine(f.offer,r)]));
      }, { write: true, primary: true, disabled: !state.changeable })))];
  }
  return [...top, link(L('Back to configuration','設定へ戻る'),'#setup',true)];
}

function debugOffer() { return wireOffers().find((o) => o.entry.fn === +value('debug-wire')); }
async function memoryAccess() {
  const d = state.debug;
  if (!d) throw new Error(L('Attach a target first.', '先にターゲットへ接続してください。'));
  if (!d.target) {
    if (d.arm) {
      d.target = await oep.arm.ArmAdi.on(state.host, d.conn, { adiv6: value('debug-adi') === '6' });
      await d.target.powerUp();
    } else d.target = await oep.riscv.RiscvDm.on(state.host, d.conn);
  }
  if (d.arm && d.ap !== num('debug-ap')) { d.mem = null; d.cpu = null; d.ap = num('debug-ap'); }
  if (d.arm && !d.mem) d.mem = await oep.arm.MemAp.open(d.target, d.ap);
  if (d.arm && !d.cpu) d.cpu = new oep.arm.CortexM(d.mem, 0, 0);
  return d.arm ? d.mem : d.target;
}
function showDebug() {
  const offers = wireOffers();
  const top = [header(L('Target tools', 'ターゲット操作'), L('Attach over a debug line to inspect memory, registers and the target console.', 'デバッグの線でターゲットに接続し、メモリ・レジスタ・コンソールを操作します。')), writeGate()];
  if (!offers.length) return [...top, notice(L('This probe has no supported debug line.', 'このプローブには対応するデバッグ線がありません。'))];
  const select = wireChoices('debug-wire', offers, () => { state.drafts.delete('debug-dio'); state.drafts.delete('debug-clk'); });
  const offer = debugOffer() ?? offers[0];
  const one = offer.entry.name === 'oep.wire.swio';
  const pinOptions = (role) => (roleChannels(offer).get(role) ?? []).map((ch) => [ch, pinName(ch)]);
  const d = state.debug;
  const connection = card(L('Debug connection', 'デバッグ接続'), d ? notice(`${d.wire.name} · ${d.pins.map(pinName).filter((_, i) => d.pins[i] !== 65535).join(' / ')} · ${d.wire.speedHz} Hz`, 'good') : null,
    !d ? node('div', { class: 'fields' }, select, selectField('debug-dio', one ? 'SWIO' : 'SWDIO', pinOptions(1)),
      !one ? selectField('debug-clk', 'SWCLK', pinOptions(2)) : null, field('debug-speed', L('Maximum clock (Hz)', '上限クロック（Hz）'), String(offer.description.maxClockHz ?? 1000000)),
      offer.entry.name === 'oep.wire.swd' ? selectField('debug-adi', 'ADI version', [['5', 'ADIv5'], ['6', 'ADIv6']], '5') : null) : null,
    actions(!d ? button(L('Attach to target', 'ターゲットへ接続'), async () => {
      /** @type {[number, number]} */
      const pins = [num('debug-dio', 0, 65534), one ? 65535 : num('debug-clk', 0, 65534)];
      if (pins[0] === pins[1]) throw new Error(L('SWDIO and SWCLK need different pins.', 'SWDIOとSWCLKは異なるピンを選んでください。'));
      const wire = wireClient(offer);
      const attached = await wire.attach({ pins, maxSpeed: num('debug-speed', 1), halt: false });
      state.debug = { wire, conn: attached.conn, pins, arm: offer.entry.name === 'oep.wire.swd', target: null, mem: null, cpu: null };
      output('debug-connect', attached);
      if (offered('oep.target.console').length) { const c = await oep.targetConsole.Console.open(state.host); state.debug.mechanisms = await c.mechanisms(); }
    }, { write: true, primary: true, disabled: !supports(offer, oep.riscv.WireBase.ATTACH) }) : button(L('Detach target', 'ターゲットを切り離す'), async () => {
      await d.wire.detach(d.conn); state.debug = null; state.console = null;
    }, { write: true })), result('debug-connect'));
  if (!d) return [...top, connection, p(L('Saved connections can be selected below to fill the wiring; attaching is still explicit.', '登録済みの接続先から配線を入力できます。接続操作は別途実行します。'), 'muted'),
    actions(...state.ports.filter((port) => portBindings(port, offer)).map((port) => button(port.name, async () => usePort(port, offer))))];
  const targetName = d.arm ? 'oep.target.arm-adi' : 'oep.target.riscv-dm';
  const targetOffer = offered(targetName)[0];
  if (!targetOffer) return [...top, connection, notice(L('The wire is connected, but this probe has no supported target interface for the following operations.', '線は接続しましたが、このプローブには後続の操作に対応するターゲット機能がありません。'))];
  const control = card(d.arm ? 'Cortex-M' : 'RISC-V', d.arm ? node('div', { class: 'fields' }, field('debug-ap', 'MEM-AP', '0')) : null,
    actions(...[
      ['Halt', '停止', 'HALT', 'halt'], ['Resume', '再開', 'RESUME', 'resume'], ['Reset', 'reset', 'RESET', d.arm ? 'sysReset' : 'reset'],
      ...(!d.arm ? [['Single step', '1命令進める', 'STEP', 'step']] : []),
    ].filter(([, , op]) => d.arm || supports(targetOffer, oep.riscv.RiscvDm[op])).map(([en, ja, , method]) => button(L(en, ja), async () => {
      const target = await memoryAccess(); output('debug-control', await (d.arm ? d.cpu : target)[method]());
    }, { write: true }))), result('debug-control'));
  const memory = card(L('Memory', 'メモリ'), p(L('Addresses and values accept decimal or 0x hexadecimal. Writes affect the target immediately.', 'アドレスと値は10進数または0x付きの16進数です。書き込みはターゲットへ即時に反映します。'), 'muted'),
    node('div', { class: 'fields' }, field('debug-address', L('Address', 'アドレス'), '0x20000000'), field('debug-words', L('32-bit words to read', '読む32 bit word数'), '16'), field('debug-value', L('32-bit value to write', '書き込む32 bit値'), '0')),
    actions(button(L('Read memory', 'メモリを読む'), async () => {
      const m = await memoryAccess(); output('debug-memory', await m.readBlock(num('debug-address'), num('debug-words', 1, 65536)));
    }, { write: true, disabled: !d.arm && !supports(targetOffer, oep.riscv.RiscvDm.READ_BLOCK) }),
    button(L('Write one word', '1 wordを書き込む'), async () => {
      const m = await memoryAccess(); const address = num('debug-address'), value = num('debug-value');
      await m.write32(address, value); output('debug-memory', { address, value, written: true });
    }, { write: true, disabled: !d.arm && !supports(targetOffer, oep.riscv.RiscvDm.WRITE_BLOCK) })), result('debug-memory'));
  const registers = card(L('Registers', 'レジスタ'),
    p(d.arm ? L('Cortex-M register number: r0–r15 = 0–15, xPSR = 16.', 'Cortex-Mのレジスタ番号：r0〜r15 = 0〜15、xPSR = 16。') : L('RISC-V abstract register number: x0 = 0x1000, dpc = 0x7b1. Halt first.', 'RISC-V abstract register番号：x0 = 0x1000、dpc = 0x7b1。先に停止します。'), 'muted'),
    node('div', { class: 'fields' }, field('debug-register', L('Register number', 'レジスタ番号'), d.arm ? '15' : '0x7b1'), d.arm ? field('debug-reg-value', L('Value', '値'), '0') : null),
    actions(button(L('Read register', 'レジスタを読む'), async () => {
      const t = await memoryAccess(); const n = num('debug-register', 0, d.arm ? 20 : 65535);
      output('debug-register', d.arm ? await d.cpu.reg(n) : await t.readRegister(n));
    }, { write: true }), d.arm ? button(L('Write register', 'レジスタを書く'), async () => { await memoryAccess(); await d.cpu.setReg(num('debug-register', 0, 20), num('debug-reg-value')); }, { write: true }) : null), result('debug-register'));
  const consoleCard = offered('oep.target.console').length ? card(L('Target console', 'ターゲットコンソール'),
    !state.console ? selectField('debug-console-method', L('Mechanism', '方式'), (d.mechanisms ?? []).map((s) => [s, s])) : null,
    actions(!state.console ? button(L('Open console', 'コンソールを開く'), async () => {
      const c = await oep.targetConsole.Console.open(state.host); await c.open(d.conn, value('debug-console-method'));
      state.console = { source: c, io: new oep.targetConsole.ConsoleIO(c) };
    }, { write: true, disabled: !d.mechanisms?.length }) : button(L('Close console', 'コンソールを閉じる'), async () => { await state.console.source.close(); state.console = null; }, { write: true }),
    button(L('Receive', '受信'), async () => { output('debug-console', await state.console.io.readAll(65536)); }, { disabled: !state.console })),
    field('debug-console-text', L('Text to send', '送信文字列'), '', { multiline: true }),
    actions(button(L('Send text', '文字列を送信'), async () => { await state.console.io.write(new TextEncoder().encode(value('debug-console-text'))); }, { write: true, disabled: !state.console })), result('debug-console')) : null;
  return [...top, connection, control, node('div', { class: 'grid' }, memory, registers), consoleCard];
}
function showSettings() {
  const st = () => new oep.settings.Settings(state.host);
  const cat = state.catalog;
  const top = [header(L('Advanced probe settings', 'プローブ本体の詳細設定'), L('Apply changes to the running probe, then save them if they should survive a restart.', '現在のプローブへ変更を適用し、再起動後も残す場合は永続保存します。')), writeGate(),
    state.dirty ? notice(L('There are changes that have not been saved. Applying and saving are separate operations.', '永続保存していない変更があります。「適用」と「プローブに保存」は別の操作です。'), 'warn') : null,
    state.settingsState ? card(L('Storage state reported by the probe', 'プローブが報告する保存状態'), node('pre', {}, printable(state.settingsState))) : null,
    state.network ? card(L('Network status', 'ネットワークの状態'), node('pre', {}, printable(state.network))) : null,
    card(L('Current values', '現在の値'), actions(button(L('Read settings', '設定を読む'), refreshData),
      button(L('Save to probe', 'プローブに保存'), async () => { await st().save(); state.dirty = false; await refreshData(); }, { write: true, primary: true, disabled: !state.saveable }),
      button(L('Export file', 'ファイルに控える'), async () => download(`${unit()}.oep-settings.json`, JSON.stringify(await st().export(), null, 2), 'application/json'))),
      state.settings.length ? table([L('Category', '分類'), L('Name', '項目'), L('Value', '値'), ''], state.settings.map((r) => [r.category, r.name,
        r.item.secret ? L('Secret (not read back)', '秘密の値（読み出し不可）') : printable(r.value), state.changeable ? button(L('Unset', '解除'), async () => {
          await st().unsetNamed(r.category, [r.name]); state.dirty = true; await refreshData();
        }, { write: true }) : ''])) : p(L('No explicit settings.', '明示的な設定値はありません。'), 'empty'))];
  const categories = [...(cat?.category ?? [])].filter(([fn]) => cat.items.get(fn)?.length);
  if (state.changeable && categories.length) {
    const categoryField = selectField('setting-category', L('Category', '分類'), categories.map(([, name]) => [name, name]));
    categoryField.querySelector('select').addEventListener('change', () => { state.drafts.delete('setting-value'); render(); });
    const fn = cat.fnOf(value('setting-category'));
    const items = cat.items.get(fn) ?? [];
    const itemField = selectField('setting-item', L('Item', '項目'), items.map((it) => [it.number, `${it.name} · ${it.form}`]));
    itemField.querySelector('select').addEventListener('change', () => { state.drafts.delete('setting-value'); render(); });
    const it = items.find((x) => x.number === +value('setting-item'));
    if (it) {
      const keyChoices = it.keyKind === 'index' ? Array.from({ length: it.keys }, (_, k) => [k, String(k)])
        : it.keyKind === 'none' ? [] : [...cat.table(it.keyKind)].map(([, name]) => [name, name]);
      const choices = it.form === 'enum' ? [...it.choices.values()] : it.form === 'bool' ? ['true', 'false']
        : it.form === 'channel' ? [...cat.channel.values()] : it.form === 'transport' ? [...cat.route.values()] : it.form === 'fn' ? [...cat.category.values()] : null;
      top.push(card(L('Apply a value', '値を適用'), node('div', { class: 'fields' }, categoryField, itemField,
        it.keyKind !== 'none' ? selectField('setting-key', L('Applies to', '対象'), keyChoices) : null,
        choices ? selectField('setting-value', L('Value', '値'), choices.map((s) => [s, s])) : field('setting-value', L('Value', '値'), '', { password: it.secret })),
        it.secret ? notice(L('A blank secret keeps the current value. Secret values are never shown or logged.', '秘密の値を空欄にすると現在値を保ちます。秘密の値を表示や履歴へ出しません。')) : null,
        actions(button(L('Apply to running probe', '現在の設定へ適用'), async () => {
          const flat = it.keyKind === 'none' ? it.name : it.name.replace('{}', value('setting-key'));
          const raw = value('setting-value'); state.drafts.delete('setting-value');
          try {
            if (it.secret && !raw) { const [found, key] = cat.resolve(value('setting-category'), flat); await st().set([[found.fn, found.number, key, new Uint8Array()]]); }
            else await st().setNamed(value('setting-category'), { [flat]: it.form === 'bool' ? raw === 'true' : raw });
          } catch (error) { if (it.secret) throw new Error(L('The secret value could not be applied. Check its format and the connection.', '秘密の値を適用できませんでした。形式と接続を確認してください。')); throw error; }
          state.dirty = true; await refreshData();
        }, { write: true, primary: true }))));
    }
  }
  const fileInput = node('input', { type: 'file', accept: '.json,application/json', disabled: state.busy || !state.changeable, onchange: (e) => {
    const file = e.target.files[0]; if (file) run(L('Preview restore', '復元内容を確認'), async () => { state.importPlan = await st().planImport(JSON.parse(await file.text())); });
  } });
  top.push(card(L('Restore from a file', 'ファイルから戻す'), p(L('Choose a settings export. Review changes before applying; persistent save is a separate step.', '設定の控えを選び、変更内容を確認してから適用します。永続保存は適用後に別途行います。'), 'muted'),
    node('label', {}, L('Settings file', '設定ファイル'), fileInput), state.importPlan ? node('div', { class: 'result' },
      state.importPlan.otherProbe ? notice(L('This file belongs to another probe.', '別のプローブの設定ファイルです。'), 'warn') : null,
      p(`${L('Set', '適用')} ${state.importPlan.sets.length} · ${L('Unset', '解除')} ${state.importPlan.unsets.length}`),
      node('pre', {}, printable({ unresolved: state.importPlan.unresolved, secretsWithoutValue: state.importPlan.secretWithoutValue })),
      actions(button(L('Apply these changes', 'この変更を適用'), async () => { state.dirty = true; await st().applyImport(state.importPlan); state.importPlan = null; await refreshData(); }, { write: true, primary: true }),
        button(L('Cancel', 'キャンセル'), async () => { state.importPlan = null; }))) : null));
  if (state.changeable) top.push(card(L('Clear settings', '設定を消去'), p(L('Unset all current values. To also replace the persistent copy, save afterwards.', '現在の設定値をすべて解除します。保存済みの設定も空にする場合は、解除後に保存します。'), 'muted'),
    button(L('Unset all values…', 'すべての設定を解除…'), async () => {
      if (!confirm(L('Unset all current settings, including connection pin names?', '接続先のピン名を含め、現在の設定をすべて解除しますか？'))) return CANCELLED;
      await st().unsetAll(); state.dirty = true; await refreshData();
    }, { write: true, danger: true })));
  return top;
}
function showStorage() {
  const top = [header(L('Storage', '保存領域'), L('Read, write and export objects kept in the probe. These records can also be used by other tools.', 'プローブに保存した記録を読み書き・取り出しします。他の道具が使う記録も含まれます。')), writeGate()];
  if (!state.memo) return [...top, notice(L('This probe has no supported memo storage.', 'このプローブには対応するメモ領域がありません。'))];
  const selected = selectField('memo-index', L('Saved objects', '保存したオブジェクト'), [['', L('Choose an object', 'オブジェクトを選ぶ')], ...state.memos.map((m, i) => [i, `${new TextDecoder().decode(m.name)} · ${m.size} bytes`])]);
  const selectedEntry = () => {
    const v = value('memo-index');
    if (v === '' || !state.memos[+v]) throw new Error(L('Select an object.', 'オブジェクトを選んでください。'));
    return state.memos[+v];
  };
  return [...top, card(L('Objects in this probe', 'このプローブのオブジェクト'), selected,
    actions(button(L('Refresh list', '一覧を更新'), refreshData), button(L('Read as text', 'テキストで読む'), async () => {
      const entry = selectedEntry(); const data = await state.memo.read(entry.name);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      state.drafts.set('memo-name', new TextDecoder('utf-8', { fatal: true }).decode(entry.name));
      state.drafts.set('memo-text', text); output('memo', { bytes: data.length, crcVerified: true });
    }), button(L('Download bytes', 'ファイルに保存'), async () => {
      const entry = selectedEntry(); download(new TextDecoder().decode(entry.name).replace(/[/\\]/g, '_'), await state.memo.read(entry.name));
    }), button(L('Delete object…', 'オブジェクトを削除…'), async () => {
      const entry = selectedEntry();
      if (!confirm(L(`Permanently delete ${new TextDecoder().decode(entry.name)}?`, `${new TextDecoder().decode(entry.name)}を削除しますか？`))) return CANCELLED;
      await state.memo.delete(entry.name); await refreshData(); state.drafts.delete('memo-index');
    }, { write: true, danger: true })), !state.memos.length ? p(L('The memo area is empty.', 'メモ領域は空です。'), 'empty') : null),
    card(L('Write an object', 'オブジェクトを書き込む'), node('div', { class: 'fields' }, field('memo-name', L('Object name', 'オブジェクト名')),
      field('memo-text', L('UTF-8 text', 'UTF-8テキスト'), '', { multiline: true })),
      actions(button(L('Write text to probe', 'テキストを保存'), async () => {
        const name = value('memo-name'); if (!name) throw new Error(L('Enter an object name.', 'オブジェクト名を入力してください。'));
        if (state.memos.some((m) => new TextDecoder().decode(m.name) === name) && !confirm(L(`Replace ${name}?`, `${name}を上書きしますか？`))) return CANCELLED;
        await state.memo.write(name, new TextEncoder().encode(value('memo-text'))); await refreshData(); output('memo', L('Saved text.', 'テキストを保存しました。'));
      }, { write: true, primary: true })),
      node('label', {}, L('Or upload a binary file (uses the object name above)', 'またはバイナリファイルを保存（上のオブジェクト名を使用）'), node('input', { type: 'file', disabled: state.busy || !state.host.session, onchange: (e) => {
        const file = e.target.files[0]; if (file) run(L('Upload object', 'オブジェクトを保存'), async () => {
          const name = value('memo-name') || file.name;
          if (state.memos.some((m) => new TextDecoder().decode(m.name) === name) && !confirm(L(`Replace ${name}?`, `${name}を上書きしますか？`))) return CANCELLED;
          await state.memo.write(name, new Uint8Array(await file.arrayBuffer())); await refreshData(); output('memo', { name, bytes: file.size });
        });
      } })), result('memo'))];
}
function showTools() {
  const id = unit();
  const names = state.ports.map((p) => p.name);
  const portField = selectField('tools-port', L('Target connection', 'ターゲットの接続先'), names.length ? names.map((n) => [n, n]) : [['<connection>', '<connection>']]);
  portField.querySelector('select').addEventListener('change', render);
  const port = value('tools-port') || '<connection>';
  const logic = offered('oep.fixture.logic'), analog = offered('oep.fixture.analog');
  const samples = `wireskein capture --source oep:oep://${id} --channels SDA=<pin>,SCL=<pin> --rate 1M --samples 100k -o capture.wireskein\nwireskein gui capture.wireskein`;
  return [header(L('Capture & development tools', '波形・道具'), L('Use WireSkein to capture, view and check waveforms. Use target-specific tools to flash application firmware.', '波形の取得・表示・照合はWireSkeinへ。アプリケーションのflash書き込みは、ターゲットに対応する道具へ進みます。')),
    !state.host ? notice(L('Connect a probe to fill in its unit ID and inspect capture support.', 'プローブを接続すると個体IDをコマンドへ入れ、取得機能を確認できます。')) : null,
    card('WireSkein', state.host ? p(`${L('Logic', 'ロジック')}: ${logic.length} · ${L('Analog', 'アナログ')}: ${analog.length}`) : null,
      p(L('Replace <pin>, channels and rate for your wiring and probe limits. The viewer opens files; it does not acquire from the probe.', '<pin>、チャンネルとレートは配線とプローブの制限に合わせて指定します。ビューアはファイルを開く道具で、プローブからの取得はコマンドで行います。'), 'muted'),
      addressBox(samples), ...[...logic, ...analog].map((o) => node('details', {}, node('summary', {}, `${o.entry.name} · ${o.entry.instance}`), node('pre', {}, printable(oep.dump.describeOffer(o))))),
      actions(external(L('Open waveform viewer', '波形ビューアを開く'), 'https://open-embedded-probe.github.io/wireskein-web/'), external(L('Install & use WireSkein', 'WireSkeinの導入と使い方'), 'https://github.com/Open-Embedded-Probe/wireskein'))),
    card(L('Target development', 'ターゲットの開発'), portField,
      p(L('For CH32 targets, use ArduinoCore-CH32RV tooling. This page does not supply device-specific flash algorithms.', 'CH32のターゲットにはArduinoCore-CH32RVの道具を使えます。デバイス固有のflashアルゴリズムは、このページでは提供しません。'), 'muted'), addressBox(`ch32rv target info oep://${id}/${port}`),
      external('ArduinoCore-CH32RV', 'https://github.com/ch32-riscv-ug/ArduinoCore-CH32RV')),
    card(L('Automate with Python', 'Pythonで自動化'), addressBox(`oep dump --port oep://${id}`), external('oep-client-python', 'https://github.com/Open-Embedded-Probe/oep-client-python'))];
}
function showDiagnostics() {
  return [header(L('Diagnostics', '診断'), L('Inspect declarations and link behavior. Technical details are kept here.', '宣言と通信の状態を確認します。技術的な詳細はこの画面で確認できます。')),
    card(L('Probe declarations', 'プローブの宣言'), actions(button(L('Read declarations', '宣言を読み直す'), async () => { state.caps = await oep.dump.collect(state.host); }),
      button(L('Save JSON', 'JSONで保存'), async () => download(`oep-${unit()}.json`, oep.dump.toJson(state.caps), 'application/json'))), node('pre', {}, oep.dump.toText(state.caps))),
    card(L('Serial speed test', 'シリアル速度の検査'), writeGate(),
      p(L('For serial bridge probes that support speed negotiation. Tests both directions and keeps a verified rate.', '速度の交渉に対応するシリアル変換経由のプローブで、両方向を検査して通った速度を使います。'), 'muted'),
      field('speed-rates', L('Candidate baud rates (comma separated)', '候補のbaud（カンマ区切り）'), '500000'),
      actions(button(L('Test speed', '速度を検査'), async () => {
        const rates = value('speed-rates').split(',').map((s) => integer(s, 1));
        output('speed', oep.speedText(await oep.raiseSpeed(state.host, rates)));
      }, { write: true, disabled: !['serial', 'webserial'].includes(state.host.link.transport.kind) })), result('speed'))];
}
function showHelp(arg) {
  if (BOARDS.some((b) => b.id === arg) && !state.drafts.has('help-board')) state.drafts.set('help-board', arg);
  const selected = boardChoices('help-board', L('Compare the boards and choose one', '特徴を比較してボードを選ぶ'), 'pico');
  const b = BOARDS.find((x) => x.id === value('help-board')) ?? BOARDS[0];
  const has = (v) => v === true ? L('Yes', 'あり') : v === false ? '—' : T(v);
  return [header(L('Guide & boards', '案内・ボード'), L('One protocol connects development tools to debug probes, signal I/O and capture devices.', 'OEPは、開発の道具とデバッグプローブ・信号入出力・取得機器をつなぐ共通プロトコルです。')),
    card(L('How the parts connect', '何をつなぐか'), p(L('Browser / CLI ⇄ USB ⇄ OEP probe ⇄ debug lines / signals ⇄ your target', 'ブラウザ・コマンド ⇄ USB ⇄ OEPプローブ ⇄ デバッグ線・信号 ⇄ ターゲット')),
      p(L('A probe declares its own functions and pin candidates. The firmware and the selected board determine which operations are available.', 'プローブは自分の機能とピン候補を宣言します。使える操作はfirmwareとボードにより異なります。'), 'muted')),
    card(L('Choose a board', 'ボードを選ぶ'), selected,
      p(`${b.chip} · ${b.verified === true ? L('Hardware checked', '実機で確認') : b.verified === false ? L('Build / host tests only', 'ビルド・host試験のみ') : T(b.verified)}`, 'muted'),
      node('dl', {}, node('dt', {}, 'USB'), node('dd', {}, T(b.usb)), node('dt', {}, L('Available pins', '使用できるピン')), node('dd', {}, T(b.pins)), node('dt', {}, L('Reserved pins', 'ボードが使うピン')), node('dd', {}, T(b.reserved))),
      ...FEATURES.map((g) => node('details', {}, node('summary', {}, T(g.group)), table([L('Function', '機能'), L('Support', '対応')], g.items.map(([key, label]) => [T(label), has(b.features[String(key)])])))),
      p(T(b.write.how)), actions(button(L('Prepare this board', 'このボードで準備する'), async () => { state.drafts.set('fw-board', b.id); location.hash = '#firmware'; }, { primary: true }))),
    card(L('Resources', '資料'), node('div', { class: 'stack' }, external(L('Probe firmware & wiring guide', 'プローブのfirmware・配線ガイド'), 'https://github.com/Open-Embedded-Probe/oep-probe-arduino'),
      external('oep-client-python', 'https://github.com/Open-Embedded-Probe/oep-client-python'), external(L('OEP specification', 'OEPの仕様'), 'https://github.com/Open-Embedded-Probe/oep-spec'))),
    card(L('Connection troubleshooting', '接続で困ったとき'), p(L('Use HTTPS or localhost in Chrome / Edge. Check the data USB cable, board firmware and permissions. Close other tools using the same port. Network-only TCP probes require the CLI or a local broker.', 'Chrome・EdgeでHTTPSまたはlocalhostを使います。データ通信できるUSBケーブル、ボードのfirmware、権限を確認し、同じポートを使う他の道具を閉じます。TCPだけのプローブにはコマンドまたはローカルブローカーを使います。')))];
}
const IMAGE_KIND = { rp2040: 'uf2', rp2350: 'uf2', esp32p4: 'app', esp32p4x: 'app' };
async function loadRelease() {
  try {
    const response = await fetch('./firmware/firmware.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.release = oep.parseFirmwareManifest(await response.json()); state.releaseError = false;
  } catch { state.release = null; state.releaseError = true; }
  if (!state.busy) render();
}
async function firmwareImage(model, kind = IMAGE_KIND[model]) {
  const entry = state.release && oep.pickFirmware(state.release, { model, kind });
  if (!entry) throw new Error(L('No compatible firmware is bundled with this site.', 'このサイトには対応するfirmwareがありません。'));
  const response = await fetch(`./firmware/${entry.file}`);
  if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}`);
  return oep.verifyFirmware(new Uint8Array(await response.arrayBuffer()), entry);
}
function fwProgress(done, total, text) {
  state.fwProgress = { done, total, text };
  const bar = $('fw-progress'); if (bar) { bar.max = total || 1; bar.value = done; }
  if ($('fw-status')) $('fw-status').textContent = text;
}
async function flashFirmware(model, update) {
  const device = update ? state.fwUpdateDevice : state.fwBoot;
  const previousUnit = state.info?.unitId;
  if (!device || (!update && state.fwBootModel !== model)) throw new Error(L('Select the correct programming device first.', '先に書き込み対象の機器を選択してください。'));
  state.firmwareBusy = true; state.fwFinished = null;
  $('fw-status')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    fwProgress(0, 1, L('Fetching and verifying SHA-256…', '取得してSHA-256を検証中…'));
    const image = await firmwareImage(model);
    if (state.host) await disconnect();
    if (IMAGE_KIND[model] === 'app') {
      await oep.dfuUpdate(device, image, { onProgress: (p) => fwProgress(p.written, p.total, `${p.phase}: ${p.written} / ${p.total} bytes`) });
    } else {
      let boot = device;
      if (update) {
        if (!await oep.rp2ResetToBoot(device)) throw new Error(L('The probe has no USB reset interface. Use BOOTSEL and the initial-install section.', 'USBのreset機能がありません。BOOTSELで起動し、初回導入の欄を使ってください。'));
        boot = null;
        const usb = deviceAPIs.usb;
        for (let tries = 0; tries < 30 && !boot; tries++) {
          boot = (await usb.getDevices()).find((d) => d.vendorId === oep.RP2_BOOT_VID && d.productId === oep.RP2_BOOT_PID[model]);
          if (!boot) await new Promise((r) => setTimeout(r, 200));
        }
        if (!boot) throw new Error(L('The board is now in BOOTSEL mode. Select it in the initial-install section and write again.', 'ボードはBOOTSELモードです。初回導入の欄で機器を選び直して書き込んでください。'));
      }
      await oep.rp2Write(boot, image, { model, onProgress: (p) => fwProgress(p.done, p.total, `${p.done} / ${p.total} bytes`) });
    }
    fwProgress(1, 1, L('Firmware written. Reconnect the probe to check its version.', 'firmwareを書き込みました。プローブに再接続して版を確認してください。'));
    state.fwFinished = `${model} · ${state.release.version}`; state.fwFinishedModel = model;
  } finally { state.firmwareBusy = false; state.fwUpdateDevice = null; state.fwBoot = null; }
  await continueSetup(model, { unitId: previousUnit, serialNumber: device.serialNumber });
}
async function installEsp(model) {
  if (!state.fwSerial || state.fwSerialBoard !== value('fw-board')) throw new Error(L('Select the serial port first.', '先にシリアルポートを選択してください。'));
  const port = state.fwSerial;
  state.firmwareBusy = true; state.fwFinished = null;
  $('fw-status')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  state.fwLog = [];
  try {
    fwProgress(0, 1, L('Fetching and verifying image…', '画像を取得・検証中…'));
    let image;
    if (value('fw-board') === 'esp32s3') {
      if (!state.fwCustom) throw new Error(L('Select a compatible merged image.', '対応するmerged画像を選択してください。'));
      if (state.fwCustom.size > 32 * 1024 * 1024) throw new Error(L('The image exceeds 32 MiB.', '画像が32 MiBを超えています。'));
      image = new Uint8Array(await state.fwCustom.arrayBuffer());
    } else {
      const entry = state.release && oep.pickFirmware(state.release, { model, kind: 'merged' });
      if (!entry || entry.flash_offset !== 0) throw new Error(L('A merged image at offset 0 is required.', 'offset 0のmerged画像が必要です。'));
      image = await firmwareImage(model, 'merged');
    }
    if (state.host) await disconnect();
    const chip = await flashEsp({ port, model, image, onProgress: fwProgress, log: (line) => {
      state.fwLog.push(String(line));
      if (state.fwLog.length > 200) state.fwLog.shift();
      if ($('fw-log')) $('fw-log').textContent = state.fwLog.join('\n');
    } });
    state.fwFinished = `${chip} · ${state.fwCustom && model !== 'esp32' && !model.startsWith('esp32p4') ? state.fwCustom.name : state.release.version}`;
    state.fwFinishedModel = model;
    state.drafts.set('connect-method', ['esp32', 'esp32s3'].includes(value('fw-board')) ? 'serial' : 'usb');
    fwProgress(1, 1, L('Written. Reconnect the USB cable, then connect as an OEP probe.', '書き込み完了。USBを挿し直し、OEPプローブとして接続してください。'));
  } finally { state.firmwareBusy = false; state.fwSerial = null; }
  await continueSetup(model, { port });
}
function showFirmware() {
  const current = state.info;
  const model = current?.model;
  const b0 = boardOf(model);
  const boardSelect = boardChoices('fw-board', L('Choose the board to install OEP on', 'OEPを導入するボードを選ぶ'), b0?.id ?? 'pico', () => { state.fwBoot = null; state.fwSerial = null; state.fwCustom = null; state.fwFinished = null; });
  const b = BOARDS.find((b) => b.id === value('fw-board')) ?? BOARDS[0];
  const available = state.release && oep.pickFirmware(state.release, { model: b.models[0], kind: b.write.page === 'serial' ? 'merged' : IMAGE_KIND[b.models[0]] ?? '' });
  const status = firmwareState(current?.firmware, state.release?.version);
  const statusText = { current: L('The bundled release is already installed.', '同じリリースが導入済みです。'), update: L('A newer bundled release is available.', '新しいリリースがあります。'), newer: L('This probe has a newer version than the bundled release. Writing it would downgrade the probe.', 'このプローブは配布画像より新しい版です。書き込むと古い版になります。'), unknown: L('The version order could not be determined. Check both versions before writing.', '版の前後関係は判定できません。両方の版を確認してください。') };
  return [header(L('Install OEP on a new board', '新しいボードにOEPを書き込む'), L('1. Choose a board → 2. Select its programming port → 3. Write firmware → 4. Continue automatically to configuration.', '①ボードを選ぶ → ②書き込み先を選ぶ → ③firmwareを書き込む → ④完了すると設定画面へ進みます。')),
    state.release ? notice(`OepProbe ${state.release.version} · ${L('bundled release', 'このサイトで配布するリリース')}`) : notice(L('Release images could not be loaded. Retry loading them here; ESP custom merged images can still be selected below.', '配布画像を読み込めませんでした。この画面で再取得できます。ESPの持ち込みmerged画像は下で選択できます。'), 'warn'),
    current ? card(L('Update the connected probe', '接続中のプローブを更新'),
      node('dl', {}, node('dt', {}, L('Device', '機器')), node('dd', {}, `${model} · ${unit()}`), node('dt', {}, L('Installed', '導入済み')), node('dd', {}, current.firmware ?? '—'),
        node('dt', {}, L('Available release', '配布する版')), node('dd', {}, state.release?.version ?? '—')), p(statusText[status], 'muted'),
      actions(button(L('Select this probe’s programming interface', 'このプローブの書き込み先を選択'), async () => {
        const d = IMAGE_KIND[model] === 'app' ? await oep.requestDfuDevice() : await oep.requestUsbProbe();
        if ((d.serialNumber ?? '').toLowerCase() !== unit().toLowerCase()) throw new Error(L('The selected device is not the connected probe. Select the device with the matching unit ID.', '選択した機器は接続中のプローブと一致しません。個体IDが同じ機器を選んでください。'));
        state.fwUpdateDevice = d;
      }, { disabled: !IMAGE_KIND[model] || !deviceAPIs.usb || !state.release }),
      button(L('Write release to this probe', 'このプローブへ書き込む'), async () => {
        if (!confirm(L(`Write OepProbe ${state.release.version} to ${model} / ${unit()}? The probe will disconnect.`, `${model} / ${unit()}へOepProbe ${state.release.version}を書き込みます。プローブの接続を終了します。`))) return CANCELLED;
        await flashFirmware(model, true);
      }, { primary: true, disabled: !state.release || !IMAGE_KIND[model] || !state.fwUpdateDevice }))) : null,
    card(L('Install on a board', 'ボードへ初めて導入する'), boardSelect, p(T(b.write.how)),
      b.write.page === 'serial' ? node('div', { class: 'stack' },
        notice(L('Use the USB connector for the serial bridge / ROM download port. Close other serial tools. Hold BOOT, tap RESET, then release BOOT if automatic connection fails. P4 boards may have separate serial and native USB connectors.', 'シリアル変換・ROM書き込み用のUSB端子につなぎ、他のシリアルツールを閉じてください。自動接続できない場合はBOOTを押しながらRESETを押して離し、その後BOOTを離します。P4ではシリアル用とnative USB用の端子が別の場合があります。')),
        b.id === 'esp32s3' ? node('div', { class: 'stack' },
          choiceCards('fw-esp-family', L('Chip family of your image', '画像に対応するチップ'), ['esp32s3', 'esp32c3', 'esp32c6'].map((value) => ({ value, title: value.toUpperCase().replace('32', '32-'), description: L('Requires a merged image built for this chip.', 'このチップ向けに作られたmerged画像が必要です。'), facts: [] })), 'esp32s3'),
          notice(L('No prebuilt OepProbe image is distributed for S3 / C3 / C6. Upload a compatible merged image at offset 0, including its bootloader and partition table at 0x8000. An app-only image will not boot a blank board.', 'S3・C3・C6向けのOepProbe画像は未配布です。bootloaderと0x8000のpartition tableを含むoffset 0の対応merged画像を選んでください。app単体の画像では新品のボードは起動できません。'), 'warn'),
          node('label', {}, L('Merged .bin image', 'merged .bin画像'), node('input', { id: 'fw-custom', type: 'file', accept: '.bin', onchange: (e) => { state.fwCustom = e.target.files[0] ?? null; render(); } })),
          p(state.fwCustom?.name ?? L('No image selected', '画像未選択'))) : p(available ? `${available.file} · SHA-256 ${available.sha256}` : L('Waiting for the release image.', '配布画像を読み込むまでお待ちください。'), 'muted'),
        p(state.fwSerial ? L('Serial port selected. Ready to write.', 'シリアルポートを選択済みです。書き込めます。') : L('First choose the serial port of the blank board.', 'まず未導入ボードのシリアルポートを選びます。')),
        actions(button(L('Select serial programming port', '書き込み用シリアルポートを選ぶ'), async () => {
          state.fwSerial = await deviceAPIs.serial.requestPort(); state.fwSerialBoard = b.id;
        }, { disabled: !deviceAPIs.serial }),
        button(L('Write OEP firmware', 'OEPを書き込む'), async () => {
          if (!confirm(L('Write firmware to this board? Existing firmware and overlapping flash data will be replaced.', 'このボードにfirmwareを書き込みます。既存firmwareと書き込み領域のデータは置き換わります。'))) return CANCELLED;
          await installEsp(b.id === 'esp32s3' ? value('fw-esp-family') : b.models[0]);
        }, { primary: true, disabled: !state.fwSerial || (b.id === 'esp32s3' ? !state.fwCustom : !available) })),
        !deviceAPIs.serial ? notice(L('Web Serial requires Chrome / Edge on desktop over HTTPS or localhost.', 'Web Serial対応のデスクトップ版Chrome・Edgeで、HTTPSまたはlocalhostから開いてください。'), 'warn') : null)
        : b.write.page === 'any' ? node('div', { class: 'stack' },
          p(L('Hold BOOTSEL while plugging in the board, then select the boot device and write.', 'BOOTSELを押しながらUSBを挿し、boot機器を選んで書き込みます。')),
          actions(button(L('Select boot device', 'boot機器を選択'), async () => {
            state.fwBoot = await oep.requestRp2Boot(/** @type {'rp2040' | 'rp2350'} */ (b.models[0])); state.fwBootModel = b.models[0];
          }, { disabled: !deviceAPIs.usb || !available }),
          button(L('Write OEP firmware', 'OEPを書き込む'), async () => {
            await flashFirmware(b.models[0], false); state.drafts.set('connect-method', 'usb');
          }, { primary: true, disabled: !available || !state.fwBoot || state.fwBootModel !== b.models[0] })))
        : notice(L('Browser installation is not supported for CH32. Choose ESP32 or Pico to complete initial installation here. An already programmed CH32 probe can be connected here.', 'CH32のブラウザ初回書き込みには未対応です。初回導入からここで完結する場合はESP32またはPicoを選んでください。導入済みのCH32プローブは接続できます。'), 'warn'),
      actions(button(L('Reload release images', '配布画像を再取得'), loadRelease), link(L('Already installed? Connect', '書き込み済みの場合は接続へ'), '#connect'), link(L('Compare boards', 'ボードを比較'), '#help'))),
    card(L('Progress', '進行状況'), node('progress', { id: 'fw-progress', max: state.fwProgress?.total || 1, value: state.fwProgress?.done ?? 0, 'aria-label': L('Firmware progress', 'firmware書き込みの進行') }),
      node('p', { id: 'fw-status' }, state.fwProgress?.text ?? L('Select a device to begin. The image is verified before writing.', '書き込み対象を選択してください。画像を検証してから書き込みます。')), node('pre', { id: 'fw-log', role: 'log' }, (state.fwLog ?? []).join('\n')))];
}
$('language').addEventListener('change', (e) => {
  lang = /** @type {HTMLSelectElement} */ (e.target).value;
  try { localStorage.setItem('oep-lang', lang); } catch { /* private mode */ }
  render();
});
window.addEventListener('hashchange', () => {
  if (state.firmwareBusy && parseRoute(location.hash).view !== 'firmware') { location.replace('#firmware'); return; }
  render();
  $('screen').querySelector('h1')?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', (e) => { if (state.firmwareBusy) { e.preventDefault(); e.returnValue = ''; } });
$('workspace').addEventListener('click', (e) => { if (state.firmwareBusy && (/** @type {Element} */ (e.target)).closest('a')) e.preventDefault(); });
render();
loadRelease();
