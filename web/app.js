// @ts-check
// OEP Probe Tool: connect to a probe from the browser, show what it declares, set up its settings, try simple
// operations, update its firmware (docs/design.md §4). Everything goes through oep-client-js.
import {
  VERSION, settings, core, dump, fixture, openWebHid, openWebSerial, openWebUsb, parseFirmwareManifest, pickFirmware,
  requestDfuDevice, dfuUpdate, verifyFirmware, Rejected, Unavailable, raiseSpeed, speedText, riscv, arm, memo, rp2Bootsel, requestRp2Boot, rp2Write, rp2ResetToBoot, checkUf2, getUsbProbes, requestUsbProbe, RP2_BOOT_VID, RP2_BOOT_PID,
} from './oep-client.js';

// ---- words ---------------------------------------------------------------------------------------------------

const WORDS = {
  en: {
    tabSetup: 'Set up',
    setup1: '1. Firmware', setup1Go: 'Open the firmware tab',
    setup1Hint: 'Put the OEP firmware on the board first. ESP32-P4 / P4X: over DFU in the firmware tab. RP2040 / RP2350: hold BOOTSEL while plugging it in and copy the .uf2. Classic ESP32: the .merged.bin with esptool. Then connect it with the buttons above and take the lock.',
    setup2: '2. Wire the target', setupPins: 'List the pins',
    setup2Hint: 'Wire the target\'s debug lines and GND to free pins of the probe: SWDIO and SWCLK (two wires: RVSWD for WCH RISC-V, SWD for ARM) or SWIO (one wire). Pins with a label are in use already.',
    setup3: '3. Scan', setupScan: 'Scan the pins checked', setupWire: 'wire', setupUse: 'use',
    setup3Hint: 'Check the pins you wired in the list above. The scan drives only them, trying them as the line pair both ways round, and lists what answers.',
    setup4: '4. Name the port', setupPort: 'port', setupPart: 'part', setupNote: 'note', setupApply: 'Set the labels and the record',
    setup4Hint: 'A port name (a letter, then letters, digits or -, up to 16) names the pins in the probe\'s settings (S.swdio, S.swclk or S.swio) and is saved in the probe. The part number and note go to the probe\'s memo area (oep.probe.memo/port/<port>), for any host to read.',
    setup5: '5. Use it',
    setup5Hint: 'Tools that take OEP addresses (the cores, oep-client-python) reach the port with this address, from any host the probe is plugged into.',
    setupNoScan: 'This probe has no scan on that wire.', setupNoPins: 'Check at least the pins of one line pair.',
    setupNothing: 'nothing answered on those pins', setupPick: 'Pick a found target first.',
    unsupported: 'This browser has no WebUSB / WebSerial / WebHID. Use Chrome or Edge, over HTTPS or localhost.',
    connectUsb: 'Connect (USB)', connectSerial: 'Connect (serial)', connectHid: 'Connect (HID)', disconnect: 'Disconnect',
    takeLock: 'Take the lock (to change things)', notConnected: 'Not connected.',
    tabDescribe: 'Probe', tabSettings: 'Settings', tabTools: 'Tools', tabFirmware: 'Firmware',
    describeRun: 'Read everything it declares', saveJson: 'Save as JSON', read: 'Read', saveToProbe: 'Save in the probe',
    unsetAll: 'Unset all (save after it to empty the storage)', fixedValues: 'values fixed by the probe (no set / unset)', exportFile: 'Export to a file', importFile: 'Import a file',
    importAsk: 'Make the probe\'s values this file\'s?', addItem: 'Set a value',
    secretHint: 'A secret: the probe never gives it back and this page never shows it. Left empty, the value it has is kept.',
    uart: 'UART', set: 'Set', remove: 'Remove', configure: 'Configure', send: 'Send',
    gpioHint: 'Plan the channel to oep.fixture.gpio first (it takes the pin for this session).', gpioPlan: 'Plan it',
    uartHint: 'The UART needs its RX / TX planned to oep.fixture.uart in this session.',
    fwP4: 'ESP32-P4 (DFU over its HS port)',
    fwP4Hint: 'Pick OepProbe-esp32p4-<version>.bin (the app image from the Release) and, to check it, firmware-<version>.json. The probe restarts into it; its settings stay.',
    fwWrite: 'Choose the device and write', fwEsp32: 'ESP32 (USB-Serial/JTAG, UART bridge)',
    fwEsp32Hint: 'Write OepProbe-<model>-<version>.merged.bin at 0x0 with esptool (esptool.py or the web esptool). Not in this page yet.',
    fwRp2: 'RP2040 / RP2350',
    fwRp2Hint: 'Pick OepProbe-<model>-<version>.uf2 (and, to check it, firmware-<version>.json), then Write. A connected probe goes into its boot ROM by itself (over USB; the first time the browser may ask for the probe and for "RP2 Boot", then remembers them); a board with no firmware yet: hold BOOTSEL while plugging it in. It is written over USB, read back and restarted; its settings stay. On Linux the boot ROM needs a udev rule for 2e8a:0003 / 2e8a:000f.',
    fwRp2Write: 'Write', fwUf2: 'image (.uf2)', fwRp2Hold: 'Hold BOOTSEL while plugging the board in, then choose "RP2 Boot".',
    locked: 'lock held', noLock: 'no lock',
    speedHint: 'A UART bridge (serial) probe that offers port_speed runs faster for this session: each candidate is tried, confirmed at the new rate and committed - the first that passes is kept (the probe goes back to 115200 when the lock is released); in use, a rate whose frames keep breaking is left for the session. Which rates pass depends on the bridge chip. The default is 500000: a faster rate is tried only when you enter it here, and is used only after full frames ran 1 s each way at it (host guide §17).',
    speedTry: 'Try the rates',
  },
  ja: {
    tabSetup: 'セットアップ',
    setup1: '1. firmware', setup1Go: 'firmware のタブを開く',
    setup1Hint: '先にボードに OEP の firmware を書きます。ESP32-P4 / P4X は firmware のタブから DFU で。RP2040 / RP2350 は BOOTSEL を押しながら挿して .uf2 をコピー。classic ESP32 は .merged.bin を esptool で。書けたら上のボタンでつなぎ、ロックを取ります。',
    setup2: '2. target の配線', setupPins: 'ピンを並べる',
    setup2Hint: 'target のデバッグの線と GND を、probe の空いたピンにつなぎます。SWDIO と SWCLK（2 線: WCH の RISC-V は RVSWD、ARM は SWD）か、SWIO（1 線）です。label のあるピンはもう使われています。',
    setup3: '3. スキャン', setupScan: 'チェックしたピンでスキャン', setupWire: '線', setupUse: '使う',
    setup3Hint: '上の一覧で、配線したピンにチェックを付けます。スキャンはそのピンだけを、線の組として両方の向きで試し、答えたものを並べます。',
    setup4: '4. 口の名付け', setupPort: '口', setupPart: '型番', setupNote: '注', setupApply: 'label と記録を設定する',
    setup4Hint: '口の名前（英字で始まり、英字・数字・- で 16 文字まで）で、probe の設定のピンに名前を付けて（S.swdio、S.swclk か S.swio）probe に保存します。型番と注は probe のメモ欄（oep.probe.memo/port/<口>）に置き、どの host からも読めます。',
    setup5: '5. 使う',
    setup5Hint: 'OEP のアドレスを受ける道具（コア、oep-client-python）は、このアドレスでこの口に届きます。probe をどの host につないでも同じです。',
    setupNoScan: 'この probe はその線のスキャンを持ちません。', setupNoPins: '少なくとも線の組 1 つ分のピンにチェックを付けます。',
    setupNothing: 'そのピンでは何も答えなかった', setupPick: '先に見つかった target を選びます。',
    unsupported: 'このブラウザには WebUSB / WebSerial / WebHID がありません。Chrome か Edge で、HTTPS か localhost で開いてください。',
    connectUsb: '接続（USB）', connectSerial: '接続（シリアル）', connectHid: '接続（HID）', disconnect: '切断',
    takeLock: 'ロックを取る（変更するとき）', notConnected: 'つながっていません。',
    tabDescribe: 'probe', tabSettings: '設定', tabTools: '操作', tabFirmware: 'firmware',
    describeRun: '宣言をすべて読む', saveJson: 'JSON で保存', read: '読む', saveToProbe: 'probe に保存',
    unsetAll: 'すべて消す（その後に保存すると保存領域が空になる）', fixedValues: 'probe が値を固定（変更不可）', exportFile: 'ファイルに書き出す', importFile: 'ファイルを読み込む',
    importAsk: 'probe の値をこのファイルの内容にしますか？', addItem: '値を設定する',
    secretHint: '秘密の値です。probe は返さず、このページも表示しません。空のままなら今の値を保ちます。',
    uart: 'UART', set: '設定', remove: '消す', configure: '設定', send: '送る',
    gpioHint: '先にその channel を oep.fixture.gpio に plan します（このセッションの間、ピンを持ちます）。', gpioPlan: 'plan する',
    uartHint: 'UART は、このセッションで RX / TX を oep.fixture.uart に plan する必要があります。',
    fwP4: 'ESP32-P4（HS の口で DFU）',
    fwP4Hint: 'OepProbe-esp32p4-<version>.bin（Release の app の image）を選び、確かめるなら firmware-<version>.json も選びます。probe はそれで再起動し、設定は残ります。',
    fwWrite: 'デバイスを選んで書く', fwEsp32: 'ESP32（USB-Serial/JTAG、UART bridge）',
    fwEsp32Hint: 'OepProbe-<model>-<version>.merged.bin を esptool（esptool.py か Web の esptool）で 0x0 に書きます。このページではまだできません。',
    fwRp2: 'RP2040 / RP2350',
    fwRp2Hint: 'OepProbe-<model>-<version>.uf2 を選び（確かめるなら firmware-<version>.json も）、「書く」を押します。つないでいる probe は自分で boot ROM に入ります（USB で。初めの 1 回だけ、ブラウザが probe と「RP2 Boot」を選ばせ、その後は覚えます）。まだ firmware の無いボードは、BOOTSEL を押しながら挿します。USB から書き、読み戻して確かめ、再起動します。設定は残ります。Linux では boot ROM（2e8a:0003 / 2e8a:000f）に udev の規則が要ります。',
    fwRp2Write: '書く', fwUf2: 'image（.uf2）', fwRp2Hold: 'BOOTSEL を押しながらボードを挿し、「RP2 Boot」を選びます。',
    locked: 'ロックあり', noLock: 'ロックなし',
    speedHint: 'port_speed を持つ UART bridge（シリアル）の probe は、このセッションの間速くできます。候補を順に試し、新しい速さで confirm して決め、最初に通った速さを使います（ロックを放すと probe は 115200 に戻る）。使っている間にフレームが壊れ続ける速さはそのセッションでは降ります。通る速さは変換チップで決まります。既定は 500000 で、それより速い速さはここに入れたときだけ試し、両方向それぞれ 1 秒、最大のフレームを流して通ったときだけ使います（oep-if-link §3 の義務 7）。',
    speedTry: '速さを試す',
  },
};
/** @type {'en' | 'ja'} */
let lang = (() => { try { return localStorage.getItem('oep-lang') === 'ja' ? 'ja' : 'en'; } catch { return 'en'; } })();
/** @param {keyof typeof WORDS.en} key */
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

function applyWords() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = /** @type {keyof typeof WORDS.en} */ (el.getAttribute('data-i18n'));
    el.textContent = t(key);
  }
  $('lang').textContent = lang === 'en' ? '日本語' : 'English';
  showProbe();
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
  /** @type {HTMLButtonElement} */ ($('disconnect')).disabled = !host;
  input('lock').disabled = !host;
  input('lock').checked = locked;
}

function showProbe() {
  const el = $('probe');
  if (!host || !info) { el.textContent = t('notConnected'); return; }
  el.textContent = [`${info.model ?? '?'} ${info.chip ? `(${info.chip})` : ''}`, `unit ${info.unitId ?? '?'}`,
    `firmware ${info.firmware ?? '?'}`, host.link.transport.kind ?? '',
    info.maxOpMs !== null ? `max op ${info.maxOpMs} ms` : '', locked ? t('locked') : t('noLock')].filter(Boolean).join(' · ');
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

async function writeFirmware() {
  const imageFile = input('fw-image').files?.[0];
  if (!imageFile) throw new Error('pick the .bin image first');
  const image = new Uint8Array(await imageFile.arrayBuffer());
  const manifestFile = input('fw-manifest').files?.[0];
  if (manifestFile) {
    const manifest = parseFirmwareManifest(JSON.parse(await manifestFile.text()));
    const entry = manifest.firmware.find((f) => f.file === imageFile.name) ?? pickFirmware(manifest, { model: 'esp32p4', kind: 'app' });
    if (!entry) throw new Error(`${manifestFile.name} lists no ${imageFile.name}`);
    await verifyFirmware(image, entry);
    log(`sha256 matches ${entry.file}`);
  }
  if (host) await disconnect();
  const device = await requestDfuDevice();
  const bar = /** @type {HTMLProgressElement} */ ($('fw-progress'));
  bar.hidden = false;
  bar.max = image.length;
  const t0 = performance.now();
  await dfuUpdate(device, image, { onProgress: (p) => {          // a DfuProgress: phase, written, total, block
    bar.max = p.total;
    bar.value = p.written;
    $('fw-status').textContent = p.phase === 'manifest' ? `${p.total} bytes written: the probe checks the image`
      : `${p.written} / ${p.total} bytes`;
  } });
  $('fw-status').textContent = `${image.length} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s: the probe restarts into it`;
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

async function rp2Image() {
  const model = /** @type {'rp2040' | 'rp2350'} */ (/** @type {HTMLSelectElement} */ ($('rp2-model')).value);
  const file = input('rp2-image').files?.[0];
  if (!file) throw new Error('pick the .uf2 image first');
  const image = new Uint8Array(await file.arrayBuffer());
  checkUf2(image, { model });
  const manifestFile = input('rp2-manifest').files?.[0];
  if (manifestFile) {
    const manifest = parseFirmwareManifest(JSON.parse(await manifestFile.text()));
    const entry = manifest.firmware.find((f) => f.file === file.name) ?? pickFirmware(manifest, { model, kind: 'uf2' });
    if (!entry) throw new Error(`${manifestFile.name} lists no ${file.name}`);
    await verifyFirmware(image, entry);
    log(`sha256 matches ${entry.file}`);
  }
  return { model, image };
}

/** The boot ROM of `model` the browser was given before, if it is on the bus. @param {'rp2040' | 'rp2350'} model */
async function grantedBoot(model) {
  const usb = /** @type {any} */ (navigator).usb;
  return (await usb.getDevices()).find((/** @type {any} */ d) => d.vendorId === RP2_BOOT_VID && d.productId === RP2_BOOT_PID[model]) ?? null;
}

/** Into the boot ROM: the connected probe by its reset interface (its USB device: one the browser was given, or chosen
 * once), else a 1200 baud touch of its serial port (firmware without the reset interface); not connected: nothing (the
 * board comes up in BOOTSEL by its button). -> whether it was asked to. */
async function rp2IntoBoot() {
  if (!host || !info) return false;
  const unitId = info.unitId;
  const usb = /** @type {any} */ (navigator).usb;
  let device = usb ? (await getUsbProbes({ unitId }))[0] ?? null : null;
  await disconnect();
  if (!device && usb) device = await requestUsbProbe();
  if (device && await rp2ResetToBoot(device)) return true;
  await rp2Bootsel();                                   // no reset interface: the touch (choose its serial port)
  return true;
}

async function rp2WriteImage() {
  const { model, image } = await rp2Image();
  const asked = await rp2IntoBoot();
  let device = null;
  for (let i = 0; i < (asked ? 20 : 1) && !device; i++) {
    device = await grantedBoot(model);
    if (!device && asked) await new Promise((r) => setTimeout(r, 250));
  }
  if (!device) {
    $('rp2-status').textContent = asked ? '' : t('fwRp2Hold');
    device = await requestRp2Boot(model);
  }
  const bar = /** @type {HTMLProgressElement} */ ($('rp2-progress'));
  bar.hidden = false;
  const t0 = performance.now();
  const r = await rp2Write(device, image, { model, onProgress: (p) => {
    bar.max = p.total;
    bar.value = p.done;
    $('rp2-status').textContent = p.phase === 'reboot' ? 'written and read back: restarting' : `${p.done} / ${p.total} sectors`;
  } });
  $('rp2-status').textContent = `${r.sectors} sectors written and read back in ${((performance.now() - t0) / 1000).toFixed(1)} s: the probe restarts into it`;
}

// ---- start ---------------------------------------------------------------------------------------------------------

function main() {
  $('version').textContent = `oep-client-js ${VERSION}`;
  const nav = /** @type {any} */ (navigator);
  if (!nav.usb && !nav.serial && !nav.hid) $('unsupported').hidden = false;
  $('lang').onclick = () => { lang = lang === 'en' ? 'ja' : 'en'; try { localStorage.setItem('oep-lang', lang); } catch { /* none */ } applyWords(); };
  for (const b of document.querySelectorAll('nav.tabs button')) {
    /** @type {HTMLButtonElement} */ (b).onclick = () => {
      for (const x of document.querySelectorAll('nav.tabs button')) x.classList.toggle('active', x === b);
      for (const s of document.querySelectorAll('section.tab')) /** @type {HTMLElement} */ (s).hidden = s.id !== `tab-${b.getAttribute('data-tab')}`;
    };
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
  $('fw-dfu').onclick = () => act(writeFirmware);
  $('rp2-write').onclick = () => act(rp2WriteImage);
  $('setup-to-firmware').onclick = () => /** @type {HTMLButtonElement} */ (document.querySelector('nav.tabs button[data-tab=firmware]')).click();
  $('setup-pins').onclick = () => act(listPins);
  $('setup-scan').onclick = () => act(scanPins);
  input('setup-port').oninput = preview;
  const nameForm = /** @type {HTMLFormElement} */ ($('setup-name'));
  nameForm.onsubmit = (e) => { e.preventDefault(); act(applyPort); };
  wireTools();
  applyWords();
  refreshButtons();
}

main();
