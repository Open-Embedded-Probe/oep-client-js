// @ts-check
// OEP Probe Tool: connect to a probe from the browser, show what it declares, set up its settings, try simple
// operations, update its firmware (docs/design.md §4). Everything goes through oep-client-js.
import {
  VERSION, settings, core, dump, fixture, openWebHid, openWebSerial, openWebUsb, parseFirmwareManifest, pickFirmware,
  requestDfuDevice, dfuUpdate, verifyFirmware, Rejected, Unavailable, raiseSpeed, speedText,
} from './oep-client.js';

// ---- words ---------------------------------------------------------------------------------------------------

const WORDS = {
  en: {
    unsupported: 'This browser has no WebUSB / WebSerial / WebHID. Use Chrome or Edge, over HTTPS or localhost.',
    connectUsb: 'Connect (USB)', connectSerial: 'Connect (serial)', connectHid: 'Connect (HID)', disconnect: 'Disconnect',
    takeLock: 'Take the lock (to change things)', notConnected: 'Not connected.',
    tabDescribe: 'Probe', tabSettings: 'Settings', tabTools: 'Tools', tabFirmware: 'Firmware',
    describeRun: 'Read everything it declares', saveJson: 'Save as JSON', read: 'Read', saveToProbe: 'Save in the probe',
    unsetAll: 'Unset all (save after it to empty the storage)', exportFile: 'Export to a file', importFile: 'Import a file',
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
    fwRp2Hint: 'Hold BOOTSEL while plugging it in, then copy OepProbe-<profile>-<version>.uf2 to the drive that appears.',
    locked: 'lock held', noLock: 'no lock',
    speedHint: 'A UART bridge (serial) probe that offers port_speed runs faster for this session: each candidate is tried, confirmed at the new rate and committed - the first that passes is kept (the probe goes back to 115200 when the lock is released); in use, a rate whose frames keep breaking is left for the session. Which rates pass depends on the bridge chip. The default is 500000: a faster rate is tried only when you enter it here, and is used only after full frames ran 1 s each way at it (host guide §17).',
    speedTry: 'Try the rates',
  },
  ja: {
    unsupported: 'このブラウザには WebUSB / WebSerial / WebHID がありません。Chrome か Edge で、HTTPS か localhost で開いてください。',
    connectUsb: '接続（USB）', connectSerial: '接続（シリアル）', connectHid: '接続（HID）', disconnect: '切断',
    takeLock: 'ロックを取る（変更するとき）', notConnected: 'つながっていません。',
    tabDescribe: 'probe', tabSettings: '設定', tabTools: '操作', tabFirmware: 'firmware',
    describeRun: '宣言をすべて読む', saveJson: 'JSON で保存', read: '読む', saveToProbe: 'probe に保存',
    unsetAll: 'すべて既定に戻す（その後に保存すると保存領域が空になる）', exportFile: 'ファイルに書き出す', importFile: 'ファイルを読み込む',
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
    fwRp2Hint: 'BOOTSEL を押しながら挿し、出てきたドライブに OepProbe-<profile>-<version>.uf2 をコピーします。',
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

/** A value as shown (a secret never: the probe gives none). @param {unknown} v */
const valueText = (v) => (typeof v === 'object' && v !== null ? '(secret)' : JSON.stringify(v));

/** The values (get), the storage state (op state) and the network (op network, when the probe declares a netif); all
 * lock-free. */
async function readSettings() {
  const st = probeSettings();
  catalog = await st.catalog();
  const [rows, state, net] = await Promise.all([st.show(), (await st.offers('state')) ? st.state() : Promise.resolve(null),
    catalog.netif.size ? st.network() : Promise.resolve(null)]);
  const netifs = net ? [`TCP port ${net.tcpPort || 'none'}`, ...net.netifs.map((n) => `${n.netif} ${n.state}`
    + (n.entry !== null ? `, entry ${n.entry}` : '') + (n.reason !== 'none' ? `, reason ${n.reason}` : '')
    + (n.rssi ? `, rssi ${n.rssi} dBm` : '') + (n.address ? `, ${n.address}` : ''))] : [];
  $('settings-state').textContent = [state ? `storage ${state.storage}${state.reason ? ` (${state.reason})` : ''}` : 'no storage',
    ...netifs].join(' · ');
  const body = /** @type {HTMLTableSectionElement} */ ($('settings-items').querySelector('tbody'));
  body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const text of [r.category, r.name, valueText(r.value), r.origin]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const td = document.createElement('td');
    if (r.origin === 'user') {
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
  form.hidden = !cat || ![...cat.items.values()].some((items) => items.length);
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
  wireTools();
  applyWords();
  refreshButtons();
}

main();
