// @ts-check
// OEP Probe Tool: connect to a probe from the browser, show what it declares, set up its settings, try simple
// operations, update its firmware (docs/design.md §4). Everything goes through oep-client-js.
import {
  VERSION, settings, core, dump, fixture, openWebHid, openWebSerial, openWebUsb, parseFirmwareManifest, pickFirmware,
  requestDfuDevice, dfuUpdate, verifyFirmware, Rejected, Unavailable, raiseSpeed, speedText, riscv, arm, memo, requestRp2Boot, rp2Write, rp2ResetToBoot, getUsbProbes, requestUsbProbe, getDfuDevices, RP2_BOOT_VID, RP2_BOOT_PID,
} from './oep-client.js';

// ---- words ---------------------------------------------------------------------------------------------------

const WORDS = {
  en: {
    tagline: 'Prepare an OEP probe from the browser: its firmware, the target wired to it, its settings.',
    unsupported: 'This browser has no WebUSB / Web Serial / WebHID. Use Chrome or Edge, over HTTPS or localhost.',
    connectUsb: 'Connect', connectSerial: 'Serial', connectHid: 'HID', disconnect: 'Disconnect',
    takeLock: 'Allow changes', notConnected: 'Not connected', locked: 'changes allowed', noLock: 'read only',
    tabHome: 'Start', tabHomeDesc: 'What to do',
    homeTitle: 'What do you want to do?', homeDesc: 'Pick a task. Connect the probe with the button at the top first; to change anything, tick "Allow changes".',
    tabSetup: 'Prepare a new probe', tabSetupDesc: 'Firmware, wiring, finding the target, naming it',
    tabFirmware: 'Update the firmware', tabFirmwareDesc: 'The latest release, picked for this probe',
    tabSettings: 'Settings', tabSettingsDesc: 'Read, change, save, back up',
    tabTools: 'Try it', tabToolsDesc: 'GPIO, UART, the serial speed',
    tabDescribe: 'What the probe offers', tabDescribeDesc: 'Everything it declares, as text or JSON',
    setup1: '1. Firmware', setup1Go: 'Update the firmware',
    setup1Hint: 'The probe needs the OEP firmware. A board with none yet: write it on "Update the firmware". Then connect it with the button at the top and tick "Allow changes".',
    setup2: '2. Wire the target', setupPins: 'List the probe\'s pins',
    setup2Hint: 'Wire the target chip\'s debug lines and GND to free pins of the probe: SWDIO and SWCLK (two wires: RVSWD for WCH RISC-V chips, SWD for ARM) or SWIO (one wire). Pins that already have a name are in use.',
    setup3: '3. Find the target', setupScan: 'Search the pins ticked', setupWire: 'debug line',
    setup3Hint: 'Tick the pins you wired in the list above. The search drives only those pins, trying them both ways round, and lists the chips that answer.',
    setup4: '4. Name the connection', setupPort: 'connection name', setupPart: 'part number', setupNote: 'note', setupApply: 'Save the names',
    setup4Hint: 'Give the target a connection name (a letter, then letters, digits or -, up to 16, e.g. x035). Its pins get names from it (x035.swdio, x035.swclk) in the probe\'s settings, saved in the probe. The part number and note are kept in the probe too, for any computer to read.',
    setup5: '5. Use it',
    setup5Hint: 'Tools that take an OEP address reach this target with it, whichever computer the probe is plugged into.',
    setupNoScan: 'This probe cannot search on that debug line.', setupNoPins: 'Tick at least the two pins of one line pair.',
    setupNothing: 'No chip answered on those pins', setupPick: 'Pick a chip that was found first.',
    describeRun: 'Read everything it declares', saveJson: 'Save as JSON', read: 'Read', saveToProbe: 'Save in the probe',
    unsetAll: 'Clear all (save after it to empty the stored settings)', fixedValues: 'values fixed by the probe (cannot be changed)',
    exportFile: 'Back up to a file', importFile: 'Restore from a file', importAsk: 'Make the probe\'s settings this file\'s?', addItem: 'Set a value',
    category: 'category', item: 'item', key: 'which', value: 'value',
    secretHint: 'A secret: the probe never gives it back and this page never shows it. Left empty, the value it has is kept.',
    set: 'Set', remove: 'Remove', configure: 'Configure', send: 'Send',
    gpioHint: 'Take the pin for GPIO first (it is kept for this connection).', gpioPlan: 'Take the pin',
    uartHint: 'The UART needs its RX / TX pins taken for this connection.',
    speedHint: 'A probe behind a USB-UART bridge can run faster for this connection: each rate is tried and kept only after full frames ran 1 s each way at it; the probe goes back to 115200 when changes are no longer allowed. The default is 500000.',
    speedTry: 'Try the rates',
    fwLatest: 'This probe', fwUpdate: 'Update to the latest',
    fwNew: 'A board with no firmware yet', fwBoard: 'board', fwNewWrite: 'Write',
    fwNewHint: 'Hold the BOOTSEL button while plugging the board in, then Write and choose "RP2 Boot". The latest release is written.',
    fwOther: 'The classic ESP32, the ESP32-P4 / P4X with no firmware and the WCH CH32 are written with their own tools for now (esptool, WCH-LinkUtility).',
    fwRp2Hold: 'Hold BOOTSEL while plugging the board in, then choose "RP2 Boot".',
  },
  ja: {
    tagline: 'ブラウザから OEP のプローブを準備します。firmware、つないだターゲット、設定。',
    unsupported: 'このブラウザには WebUSB / Web Serial / WebHID がありません。Chrome か Edge で、HTTPS か localhost で開いてください。',
    connectUsb: '接続', connectSerial: 'シリアル', connectHid: 'HID', disconnect: '切断',
    takeLock: '変更を許可', notConnected: '未接続', locked: '変更可', noLock: '読むだけ',
    tabHome: 'はじめに', tabHomeDesc: '何をするか選ぶ',
    homeTitle: '何をしますか？', homeDesc: '作業を選びます。先に上のボタンでプローブをつなぎます。何かを変えるときは「変更を許可」にチェックを入れます。',
    tabSetup: '新しいプローブを準備する', tabSetupDesc: 'firmware、配線、ターゲットを見つける、名前を付ける',
    tabFirmware: 'firmware を更新する', tabFirmwareDesc: '最新のリリースを、このプローブに合わせて選ぶ',
    tabSettings: '設定', tabSettingsDesc: '読む、変える、保存する、ファイルに控える',
    tabTools: '動かしてみる', tabToolsDesc: 'GPIO、UART、シリアルの速さ',
    tabDescribe: 'プローブの機能', tabDescribeDesc: '宣言をすべて、テキストか JSON で',
    setup1: '1. firmware', setup1Go: 'firmware を更新する',
    setup1Hint: 'プローブには OEP の firmware が要ります。まだ無いボードは「firmware を更新する」で書きます。書けたら上のボタンでつなぎ、「変更を許可」にチェックを入れます。',
    setup2: '2. ターゲットを配線する', setupPins: 'プローブのピンを並べる',
    setup2Hint: 'ターゲットのチップのデバッグの線と GND を、プローブの空いたピンにつなぎます。SWDIO と SWCLK（2 線: WCH の RISC-V は RVSWD、ARM は SWD）か、SWIO（1 線）です。名前の付いたピンは、もう使われています。',
    setup3: '3. ターゲットを探す', setupScan: 'チェックしたピンで探す', setupWire: 'デバッグの線',
    setup3Hint: '上の一覧で、配線したピンにチェックを付けます。探すときはそのピンだけを、両方の向きで試し、答えたチップを並べます。',
    setup4: '4. 接続に名前を付ける', setupPort: '接続名', setupPart: '型番', setupNote: 'メモ', setupApply: '名前を保存する',
    setup4Hint: 'ターゲットに接続名を付けます（英字で始まり、英字・数字・- で 16 文字まで。例: x035）。この名前から、そのピンに名前が付き（x035.swdio、x035.swclk）、プローブの設定に保存されます。型番とメモもプローブに置かれ、どのパソコンからも読めます。',
    setup5: '5. 使う',
    setup5Hint: 'OEP のアドレスを受ける道具は、このアドレスでこのターゲットに届きます。プローブをどのパソコンにつないでも同じです。',
    setupNoScan: 'このプローブは、そのデバッグの線で探せません。', setupNoPins: '線の組 1 つ分（2 本）のピンに、少なくともチェックを付けます。',
    setupNothing: 'そのピンでは、どのチップも答えませんでした', setupPick: '先に、見つかったチップを選びます。',
    describeRun: '宣言をすべて読む', saveJson: 'JSON で保存', read: '読む', saveToProbe: 'プローブに保存',
    unsetAll: 'すべて消す（その後に保存すると、保存した設定が空になる）', fixedValues: 'プローブが固定した値（変えられない）',
    exportFile: 'ファイルに控える', importFile: 'ファイルから戻す', importAsk: 'プローブの設定を、このファイルの内容にしますか？', addItem: '値を設定する',
    category: '分類', item: '項目', key: '対象', value: '値',
    secretHint: '秘密の値です。プローブは返さず、このページも表示しません。空のままなら今の値を保ちます。',
    set: '設定', remove: '消す', configure: '設定', send: '送る',
    gpioHint: '先にそのピンを GPIO 用に取ります（この接続の間、持ち続けます）。', gpioPlan: 'ピンを取る',
    uartHint: 'UART は、この接続の間、RX と TX のピンを取る必要があります。',
    speedHint: 'USB-UART の変換チップを通すプローブは、この接続の間、速くできます。速さを順に試し、両方向それぞれ 1 秒、最大のフレームを流して通ったときだけ使います。「変更を許可」を外すと、プローブは 115200 に戻ります。既定は 500000 です。',
    speedTry: '速さを試す',
    fwLatest: 'このプローブ', fwUpdate: '最新に更新する',
    fwNew: 'まだ firmware の無いボード', fwBoard: 'ボード', fwNewWrite: '書く',
    fwNewHint: 'BOOTSEL のボタンを押しながらボードを挿し、「書く」を押して「RP2 Boot」を選びます。最新のリリースが書かれます。',
    fwOther: 'classic ESP32、firmware の無い ESP32-P4 / P4X、WCH の CH32 は、今はそれぞれの道具（esptool、WCH-LinkUtility）で書きます。',
    fwRp2Hold: 'BOOTSEL を押しながらボードを挿し、「RP2 Boot」を選びます。',
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

function applyWords() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = /** @type {keyof typeof WORDS.en} */ (el.getAttribute('data-i18n'));
    el.textContent = t(key);
  }
  // a label's own words: its first text node, before its input
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    const key = /** @type {keyof typeof WORDS.en} */ (el.getAttribute('data-i18n-label'));
    const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    if (node) node.textContent = `${t(key)} `;
  }
  /** @type {HTMLSelectElement} */ ($('lang-select')).value = lang;
  showProbe();
  showFirmware();
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
  showProbe();
  showFirmware();
  /** @type {HTMLButtonElement} */ ($('disconnect')).disabled = !host;
  input('lock').disabled = !host;
  input('lock').checked = locked;
}

function showProbe() {
  const el = $('probe');
  $('status').classList.toggle('connected', !!(host && info));
  if (!host || !info) { el.textContent = t('notConnected'); return; }
  el.textContent = [`${info.model ?? '?'}`, info.unitId ?? '?', info.firmware ?? '?', host.link.transport.kind ?? '',
    locked ? t('locked') : t('noLock')].filter(Boolean).join(' · ');
}

/** @param {string} name the tab to show */
function showTab(name) {
  if (!document.getElementById(`tab-${name}`)) name = 'home';
  if (location.hash !== `#${name}`) history.replaceState(null, '', name === 'home' ? location.pathname + location.search : `#${name}`);
  for (const x of document.querySelectorAll('nav.side button')) x.classList.toggle('active', x.getAttribute('data-tab') === name);
  for (const sec of document.querySelectorAll('section.tab')) /** @type {HTMLElement} */ (sec).hidden = sec.id !== `tab-${name}`;
  window.scrollTo(0, 0);
}

// ---- connecting ------------------------------------------------------------------------------------------------

/** @param {() => Promise<import('../src/host.js').Host>} open */
async function connectWith(open) {
  await act(async () => {
    host = await open();
    info = await core.probeInfo(host);
    caps = null;
    uarts.clear();
    showProbe();
    await fillUarts();
    log(`connected: ${info.model} ${info.unitId}`);
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
    showProbe();
    log('disconnected');
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
  showProbe();
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

// ---- firmware ------------------------------------------------------------------------------------------------------

/** The latest release's OepProbe firmware the page was built with (scripts/fetch-firmware.js: ./firmware/). */
/** @type {any} */ let release = null;

async function loadRelease() {
  try {
    const r = await fetch('./firmware/firmware.json', { cache: 'no-cache' });
    if (r.ok) release = { ...parseFirmwareManifest(await r.json()) };
  } catch { release = null; }
  showFirmware();
}

const KIND = { esp32p4: 'app', esp32p4x: 'app', rp2040: 'uf2', rp2350: 'uf2' };

function showFirmware() {
  $('fw-release').textContent = release ? `OepProbe ${release.version}` : '-';
  const el = $('fw-probe');
  if (!host || !info) { el.textContent = t('notConnected'); return; }
  const supported = /** @type {Record<string, string>} */ (KIND)[info.model ?? ''];
  el.textContent = `${info.model ?? '?'} · ${info.firmware ?? '?'}` + (release && supported ? ` → ${release.version}` : '');
  /** @type {HTMLButtonElement} */ ($('fw-update')).disabled = !supported || !release;
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
    text: p.phase === 'manifest' ? 'the probe checks the image' : `${p.written} / ${p.total} bytes` }) });
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
  await rp2Write(boot, image, { model, onProgress: (p) => progress({ done: p.done, total: p.total,
    text: p.phase === 'reboot' ? 'written and read back: restarting' : `${p.done} / ${p.total}` }) });
  return (performance.now() - t0) / 1000;
}

async function updateProbe() {
  if (!info) return;
  const model = /** @type {string} */ (info.model);
  const image = await latestImage(model);
  const s = KIND[/** @type {keyof typeof KIND} */ (model)] === 'app' ? await updateOverDfu(image)
    : await updateRp2(/** @type {'rp2040' | 'rp2350'} */ (model), image);
  $('fw-status').textContent = `OepProbe ${release.version}: written in ${s.toFixed(1)} s, the probe restarts into it`;
}

async function writeNewBoard() {
  const model = /** @type {'rp2040' | 'rp2350'} */ (/** @type {HTMLSelectElement} */ ($('fw-new-model')).value);
  const image = await latestImage(model);
  if (host) await disconnect();
  const s = await updateRp2(model, image);
  $('fw-status').textContent = `OepProbe ${release.version}: written in ${s.toFixed(1)} s, the board restarts into it`;
}

// ---- set up: wire, scan, name the port, record it (host guide §5.3, oep-if-memo §4.3) ------------------------------

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
    row.insertCell().textContent = labels.get(ch) ?? '';
  }
  const sel = /** @type {HTMLSelectElement} */ ($('setup-wire'));
  setOptions(sel, (await scanWires()).map((w) => [w.name, w.name]));
  log(`${info.channelNames.size} pins, ${labels.size} labelled`);
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
    row.insertCell().textContent = f.wire.replace('oep.wire.', '');
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
  $('setup-address').textContent = address;
  log(`port ${port} set${recorded}`);
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
  for (const b of document.querySelectorAll('nav.side button')) {
    /** @type {HTMLButtonElement} */ (b).onclick = () => showTab(/** @type {string} */ (b.getAttribute('data-tab')));
  }
  for (const b of document.querySelectorAll('.choices [data-go]')) {
    /** @type {HTMLButtonElement} */ (b).onclick = () => showTab(/** @type {string} */ (b.getAttribute('data-go')));
  }
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
  $('setup-to-firmware').onclick = () => showTab('firmware');
  $('setup-pins').onclick = () => act(listPins);
  $('setup-scan').onclick = () => act(scanPins);
  input('setup-port').oninput = preview;
  const nameForm = /** @type {HTMLFormElement} */ ($('setup-name'));
  nameForm.onsubmit = (e) => { e.preventDefault(); act(applyPort); };
  wireTools();
  applyWords();
  refreshButtons();
  loadRelease();
  showTab(location.hash.slice(1) || 'home');   // #setup, #firmware, ... open that task
}

main();
