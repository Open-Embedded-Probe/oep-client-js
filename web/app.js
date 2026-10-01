// @ts-check
// OEP Probe Tool: connect to a probe from the browser, show what it declares, set up its settings, try simple
// operations, update its firmware (docs/design.md §4). Everything goes through oep-client-js.
import {
  VERSION, config, core, dump, fixture, openWebHid, openWebSerial, openWebUsb, parseFirmwareManifest, pickFirmware,
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
    erase: 'Erase the saved', addItem: 'Add or change', slot: 'Slot', bind: 'Bind', label: 'Label', idle: 'Idle state',
    disable: 'Disable channels (not on this board: never used or touched)',
    plan: 'Plan', uart: 'UART', set: 'Set', remove: 'Remove', configure: 'Configure', send: 'Send',
    gpioHint: 'Plan the channel to oep.fixture.gpio first (it takes the pin for this session).', gpioPlan: 'Plan it',
    uartHint: 'The UART needs its RX / TX planned (Settings: plan, or a saved plan).',
    fwP4: 'ESP32-P4 (DFU over its HS port)',
    fwP4Hint: 'Pick OepProbe-esp32p4-<version>.bin (the app image from the Release) and, to check it, firmware-<version>.json. The probe restarts into it; its settings stay.',
    fwWrite: 'Choose the device and write', fwEsp32: 'ESP32 (USB-Serial/JTAG, UART bridge)',
    fwEsp32Hint: 'Write OepProbe-<model>-<version>.merged.bin at 0x0 with esptool (esptool.py or the web esptool). Not in this page yet.',
    fwRp2: 'RP2040 / RP2350',
    fwRp2Hint: 'Hold BOOTSEL while plugging it in, then copy OepProbe-<profile>-<version>.uf2 to the drive that appears.',
    locked: 'lock held', noLock: 'no lock',
    speedHint: 'A UART bridge (serial) probe that offers port_speed runs faster for this session: each rate is tried, checked both ways with full frames, and the first that passes is kept (the probe goes back to 115200 when the lock is released). Which rates pass depends on the bridge chip.',
    speedTry: 'Try the rates',
  },
  ja: {
    unsupported: 'このブラウザには WebUSB / WebSerial / WebHID がありません。Chrome か Edge で、HTTPS か localhost で開いてください。',
    connectUsb: '接続（USB）', connectSerial: '接続（シリアル）', connectHid: '接続（HID）', disconnect: '切断',
    takeLock: 'ロックを取る（変更するとき）', notConnected: 'つながっていません。',
    tabDescribe: 'probe', tabSettings: '設定', tabTools: '操作', tabFirmware: 'firmware',
    describeRun: '宣言をすべて読む', saveJson: 'JSON で保存', read: '読む', saveToProbe: 'probe に保存', erase: '保存を消す',
    addItem: '足す・変える', slot: 'スロット', bind: 'bind', label: 'ラベル', idle: '空きのときの状態', plan: 'plan',
    disable: '使わない channel（このボードに出ていない: 使わず、触れない）',
    uart: 'UART', set: '設定', remove: '消す', configure: '設定', send: '送る',
    gpioHint: '先にその channel を oep.fixture.gpio に plan します（このセッションの間、ピンを持ちます）。', gpioPlan: 'plan する',
    uartHint: 'UART は RX / TX の plan が要ります（設定の plan か、保存した plan）。',
    fwP4: 'ESP32-P4（HS の口で DFU）',
    fwP4Hint: 'OepProbe-esp32p4-<version>.bin（Release の app の image）を選び、確かめるなら firmware-<version>.json も選びます。probe はそれで再起動し、設定は残ります。',
    fwWrite: 'デバイスを選んで書く', fwEsp32: 'ESP32（USB-Serial/JTAG、UART bridge）',
    fwEsp32Hint: 'OepProbe-<model>-<version>.merged.bin を esptool（esptool.py か Web の esptool）で 0x0 に書きます。このページではまだできません。',
    fwRp2: 'RP2040 / RP2350',
    fwRp2Hint: 'BOOTSEL を押しながら挿し、出てきたドライブに OepProbe-<profile>-<version>.uf2 をコピーします。',
    locked: 'ロックあり', noLock: 'ロックなし',
    speedHint: 'port_speed を持つ UART bridge（シリアル）の probe は、このセッションの間速くできます。速さを順に試し、両方向に大きなフレームで確かめ、最初に通った速さを使います（ロックを放すと probe は 115200 に戻る）。通る速さは変換チップで決まります。',
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
      e.holderFn !== null && `held by fn ${e.holderFn}${e.holderKind ? ` (${e.holderKind})` : ''}`];
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
    `firmware ${info.firmware ?? '?'}`, host.link.transport.kind ?? '', info.discoverable ? 'discoverable' : '',
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

async function probeConfig() {
  if (!host) throw new Error('not connected');
  return config.ProbeConfig.open(host);
}

/** @param {any} it */
function itemText(it) {
  if (it instanceof config.Slot) {
    return [`slot ${it.slot} "${it.name}"`, `wire fn ${it.wireFn}`, `pins ${it.pins.join('/')}`, it.attach,
      it.retryS ? `retry ${it.retryS} s` : '', it.maxSpeed ? `≤ ${it.maxSpeed} Hz` : '', `idle ${it.idleClock}`,
      it.mechanism, it.lock ? 'lock' : ''].filter(Boolean).join(', ');
  }
  if (it instanceof config.Bind) return `bind port ${it.port} ${it.mode}: ${it.streams.map((s) => s.join(':')).join(', ')}`;
  if (it instanceof config.Label) return `label ${it.channel} "${it.text}"`;
  if (it instanceof config.Idle) return `idle ${it.channel} ${it.mode}`;
  if (it instanceof config.Disable) return `disable ${it.channel}`;
  if (it instanceof config.Plan) return `plan fn ${it.fn} role ${it.role} → channel ${it.channel}`;
  if (it instanceof config.Uart) return `uart fn ${it.fn} ${it.baud} baud, format 0x${it.format.toString(16).padStart(2, '0')}`;
  return `tag 0x${it.tag?.toString(16)}`;
}

/** The key unset takes for this item (a plan's: its fn, the whole plan of that fn).
 * @param {any} it @returns {[config.ItemKind, number] | null} */
function itemKey(it) {
  if (it instanceof config.Slot) return ['slot', it.slot];
  if (it instanceof config.Bind) return ['bind', it.port];
  if (it instanceof config.Label) return ['label', it.channel];
  if (it instanceof config.Idle) return ['idle', it.channel];
  if (it instanceof config.Disable) return ['disable', it.channel];
  if (it instanceof config.Plan) return ['plan', it.fn];
  if (it instanceof config.Uart) return ['uart', it.fn];
  return null;
}

/** The settings: the items (get), what the probe declares (describe) and the live slot / bind / storage state (op
 * state, lock-free). */
async function readSettings() {
  const cfg = await probeConfig();
  const [items, declared, state] = await Promise.all([cfg.items(), cfg.describe(), cfg.state()]);
  const slots = state.slots.map((s) => `slot ${s.slot}: ${s.state}${s.connection ? ` (connection ${s.connection})` : ''}`
    + (s.lastTryAtNs !== null ? ` (last try at ${(Number(s.lastTryAtNs / 1_000_000n) / 1000).toFixed(3)} s)` : ''));
  const binds = state.binds.map((b) => `port ${b.port}: ${b.flow}`);
  $('settings-state').textContent = [`storage ${state.storage}${state.unreadable ? ` (${state.unreadable})` : ''}`
    + (declared.storageBytes ? ` of ${declared.storageBytes} bytes` : ''), `${declared.slotsMax} slots`,
  `bind modes ${declared.bindModes.join(', ') || '-'}`, ...slots, ...binds].join(' · ');
  const body = /** @type {HTMLTableSectionElement} */ ($('settings-items').querySelector('tbody'));
  body.replaceChildren();
  for (const it of items) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = itemText(it);
    const td2 = document.createElement('td');
    const key = itemKey(it);
    if (key) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('remove');
      b.dataset.needs = 'lock';
      b.onclick = () => act(async () => { await (await probeConfig()).unset([key]); await readSettings(); });
      td2.append(b);
    }
    tr.append(td, td2);
    body.append(tr);
  }
  refreshButtons();
}

/** @param {any[]} items */
async function setItems(items) {
  await (await probeConfig()).set(items);
  await readSettings();
  log('set');
}

/** @param {HTMLFormElement} form */
const formData = (form) => Object.fromEntries(new FormData(form).entries());

function wireForms() {
  const on = (/** @type {string} */ id, /** @type {(d: Record<string, any>) => any[]} */ make) => {
    const form = /** @type {HTMLFormElement} */ ($(id));
    form.onsubmit = (e) => { e.preventDefault(); act(() => setItems(make(formData(form)))); };
  };
  on('form-slot', (d) => [new config.Slot({ slot: +d.slot, wireFn: +d.wireFn, pins: [+d.swdio, d.swclk === '' ? 0xffff : +d.swclk],
    name: d.name, attach: d.attach, retryS: +d.retryS, maxSpeed: +d.maxSpeed, idleClock: d.idleClock, mechanism: d.mechanism })]);
  on('form-bind', (d) => [new config.Bind({ port: +d.port, mode: d.mode,
    streams: String(d.streams).split(',').map((s) => { const [k, v] = s.trim().split(':'); return [k, +v]; }) })]);
  on('form-label', (d) => [new config.Label({ channel: +d.channel, text: d.text })]);
  on('form-idle', (d) => [new config.Idle({ channel: +d.channel, mode: d.mode })]);
  on('form-disable', (d) => String(d.channels).split(',').filter((s) => s.trim() !== '')
    .map((s) => new config.Disable({ channel: +s.trim() })));
  on('form-plan', (d) => String(d.roles).split(',').map((s) => {
    const [role, ch] = s.trim().split('=');
    return new config.Plan({ fn: +d.fn, role: +role, channel: +ch });
  }));
  on('form-uart', (d) => [new config.Uart({ fn: +d.fn, baud: +d.baud,
    format: fixture.FixtureUart.formatByte(+d.dataBits, d.parity, +d.stopBits) })]);
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
  await dfuUpdate(device, image, { onProgress: (/** @type {number} */ n) => { bar.value = n; $('fw-status').textContent = `${n} / ${image.length} bytes`; } });
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
  $('settings-save').onclick = () => act(async () => { const h = await (await probeConfig()).save(); log(`saved (hash ${h.toString(16)})`); await readSettings(); });
  $('settings-erase').onclick = () => act(async () => { await (await probeConfig()).erase(); log('erased'); await readSettings(); });
  $('fw-dfu').onclick = () => act(writeFirmware);
  wireForms();
  wireTools();
  applyWords();
  refreshButtons();
}

main();
