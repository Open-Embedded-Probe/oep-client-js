// The connected probe and everything the page does with it. Screens call these; no screen sends a request itself.
// Loading, saving or moving between screens never scans, attaches, assigns pins or drives outputs (page.ja.md §6.3):
// only the functions named for that do, and only when a button asks.
import * as oep from './oep-client.js';
import { connectionChange } from './connections.js';
import { validateBindings } from './model.js';
import { t } from './i18n.js';
import { flashEsp, detectEsp } from './esp-flash.js';

const usbApi = /** @type {any} */ (navigator).usb, serialApi = /** @type {any} */ (navigator).serial, hidApi = /** @type {any} */ (navigator).hid;
export const VERSION = oep.VERSION;
export const browser = { usb: !!usbApi && isSecureContext, serial: !!serialApi && isSecureContext, hid: !!hidApi && isSecureContext, secure: isSecureContext };

/** The web page's own memo objects: a port registered as a connector (page.ja.md §6.3). oep-if-memo §4.1: our owner name. */
export const WEB_OWNER = 'io.github.open-embedded-probe.web';
const webPortName = (port) => `${WEB_OWNER}/port/${port.toLowerCase()}`;
const OWNER = 'OEP Web';

export const dev = {
  /** @type {any} */ host: null, /** @type {any} */ info: null, /** @type {any} */ caps: null, /** @type {any} */ catalog: null,
  /** @type {[number,string][]} */ labels: [], /** @type {{name:string, lines:[number,string][]}[]} */ ports: [],
  /** @type {Map<string, any>} */ records: new Map(), /** @type {Set<string>} */ connectors: new Set(),
  /** this page's own record of each port (kind: connector, debug: rvswd | swd) @type {Map<string, any>} */ webRecords: new Map(),
  /** @type {any} */ memo: null, /** @type {any[]} */ memos: [],
  changeable: false, saveable: false, /** @type {any[]} */ settingsRows: [], /** @type {any} */ settingsState: null, /** @type {any} */ network: null,
  /** settings applied but not saved by this page */ unsaved: false,
  epoch: 0, /** @type {any} */ keepalive: null, lost: '',
  /** running operations: id -> { title, route, stop } (shown in the status bar, stoppable from any screen) */
  /** @type {Map<string, {title:string, route:string, stop:()=>Promise<void>}>} */ active: new Map(),
  /** @type {Map<number, any>} */ clients: new Map(), /** @type {Map<number, [number,number,number][]>} */ plans: new Map(),
  /** @type {any} */ debug: null, /** @type {any} */ console: null,
};
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
const changed = () => listeners.forEach((fn) => fn());

// -- names and declarations --
export const unit = () => dev.info?.unitId ?? '<unit id>';
export const pinName = (ch) => dev.info?.channelNames.get(+ch) ?? `#${ch}`;
export const channelList = () => [...(dev.info?.channelNames ?? new Map())].sort((a, b) => a[0] - b[0]);
export const offered = (name) => dev.caps?.offers.filter((o) => o.entry.name === name && o.entry.revision === 1 && !o.description.unknownCritical.length && !o.description.opsInvalid) ?? [];
export const supports = (offer, op) => !offer.description.ops || offer.description.ops.has(op);
export function roleChannels(offer) {
  const roles = new Map([...offer.description.roles].map(([r, c]) => [r, [...c]]));
  for (const group of offer.description.groups.values()) for (const [r, ch] of group) roles.set(r, [...new Set([...(roles.get(r) ?? []), ch])]);
  return roles;
}
export const roleName = (offer, role) => oep.interfaces.KNOWN[offer.entry.name]?.roles[role] ?? `${role}`;
/** The label line of a role: the registry's line names (swdio, swclk, swio, rx, tx, nrst) or the role's name. */
export function roleLine(name, role) {
  const n = (oep.interfaces.KNOWN[name]?.roles[role] ?? `line${role}`).toLowerCase();
  return n === 'reset' ? 'nrst' : n;
}
export const WIRES = { rvswd: 'oep.wire.rvswd', swio: 'oep.wire.swio', swd: 'oep.wire.swd' };

export function errorText(error) {
  if (error instanceof oep.Locked) return t(`${error.owner ?? 'Another tool'} is using it. End that first, then try again. It is never taken by force.`, `${error.owner ?? '別の道具'}が使用中です。そちらを終了してから、もう一度操作してください。強制的に奪うことはしません。`);
  if (error instanceof oep.NoSession) return t('The right to change was lost. Pin assignments and the target connection have ended. Start again.', '変更権が失われました。ピンの割当やターゲットとの接続は終了しています。もう一度開始してください。');
  if (error instanceof oep.TransportFailed) return t(`No answer came, so the result is unknown. Reconnect and check the state before operating. (${error.message})`, `応答を受け取れず、操作の結果は不明です。再接続して状態を確かめてから操作してください。（${error.message}）`);
  return error instanceof Error ? error.message : String(error);
}

// -- remembered probes (this browser only) --
function known() { try { return JSON.parse(localStorage.getItem('oep-known-probes') ?? '{}'); } catch { return {}; } }
export function knownProbes() { return Object.entries(known()).map(([unitId, v]) => ({ unitId, ...v })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)); }
function remember(extra = {}) {
  try {
    const all = known();
    all[dev.info.unitId] = { ...(all[dev.info.unitId] ?? {}), model: dev.info.model, firmware: dev.info.firmware, transport: dev.host.link.transport.kind, at: Date.now(), ...extra };
    localStorage.setItem('oep-known-probes', JSON.stringify(all));
  } catch { /* private mode */ }
}
export function rememberPurpose(purpose) { if (dev.info) remember({ purpose }); }

// -- connecting --
/** Open a probe and read what it is (no board question: model, unit id and functions come from the probe, R05).
 * expected: { unitId?, models? } of the device just programmed; another probe is closed again (A08). */
export async function connectWith(open, expected = null) {
  if (dev.host) await disconnect();
  let h;
  try {
    h = await open();
    const [info, caps] = await Promise.all([oep.core.probeInfo(h), oep.dump.collect(h)]);
    if (!info.unitId) throw new Error(t('This probe does not declare a unit ID.', 'このプローブは個体IDを宣言していません。'));
    if (expected?.unitId && info.unitId.toLowerCase() !== expected.unitId.toLowerCase()) throw new Error(t('This is not the unit that was written. Choose the board you wrote.', '書き込んだ個体とは別のプローブです。書き込んだボードを選んでください。'));
    if (expected?.models?.length && !expected.models.includes(info.model)) throw new Error(t(`The written board (${expected.models.join(' / ')}) and the connected device (${info.model}) do not match.`, `書き込んだボード（${expected.models.join(' / ')}）と、接続した機器（${info.model}）が一致しません。`));
    Object.assign(dev, { host: h, info, caps, epoch: h.epoch, lost: '', unsaved: false });
    await refresh();
    remember();
    changed();
    return info;
  } catch (e) {
    if (h) await h.link.close().catch(() => {});
    if (dev.host === h) Object.assign(dev, { host: null, info: null, caps: null });
    throw e;
  }
}
export const openUsb = (device, unitId) => () => oep.openWebUsb(device, { unitId, keepSession: false });
export const openSerial = (port) => () => oep.openWebSerial(port, { keepSession: false });
export const openHid = () => () => oep.openWebHid(undefined, { keepSession: false });
export async function grantedUsbProbes() { return browser.usb ? await oep.getUsbProbes() : []; }

/** Stop every running operation and close the link (the session ends first, so the lock is free for other tools). */
export async function disconnect() {
  const h = dev.host;
  await stopAll().catch(() => {});
  clearInterval(dev.keepalive); dev.keepalive = null;
  Object.assign(dev, { host: null, info: null, caps: null, catalog: null, labels: [], ports: [], memo: null, memos: [], debug: null, console: null, settingsRows: [], settingsState: null, network: null });
  dev.records.clear(); dev.connectors.clear(); dev.webRecords.clear(); dev.clients.clear(); dev.plans.clear(); dev.active.clear();
  if (h) { try { if (h.session) await h.end(); } finally { await h.link.close().catch(() => {}); } }
  changed();
}

/** The change right, taken inside the action that needs it (§8): never a separate step, never forced. */
export async function ensureSession() {
  const h = dev.host;
  if (!h) throw new Error(t('No probe is connected.', 'プローブが接続されていません。'));
  if (h.session) return;
  await oep.core.take(h, 10000, { owner: OWNER });
  dev.epoch = h.epoch;
  clearInterval(dev.keepalive);
  dev.keepalive = setInterval(async () => {
    if (dev.host !== h || !h.session) return;
    try { await h.keepalive(); } catch (e) { dev.lost = errorText(e); await disconnect().catch(() => {}); }
  }, 3000);
}
export async function releaseSession() {
  await stopAll();
  clearInterval(dev.keepalive); dev.keepalive = null;
  if (dev.host?.session) await dev.host.end();
  dev.clients.clear(); dev.plans.clear(); dev.debug = null; dev.console = null;
  changed();
}
/** The probe restarted or the session was lost since the operation began: its temporary state is gone. */
export function checkEpoch() {
  if (dev.host && dev.host.epoch !== dev.epoch) {
    dev.clients.clear(); dev.plans.clear(); dev.debug = null; dev.console = null; dev.active.clear(); dev.epoch = dev.host.epoch;
    throw new Error(t('The probe\'s state changed (a restart or lost right to change). Temporary assignments and connections have ended. Read it again, then start again.', 'プローブの状態が変わりました（再起動か変更権の喪失）。一時的な割当と接続は終わっています。読み直してから、もう一度開始してください。'));
  }
}

// -- reading what the probe keeps --
export async function refresh() {
  const st = new oep.settings.Settings(dev.host);
  dev.catalog = await st.catalog();
  dev.changeable = await st.changeable(); dev.saveable = await st.offers('save');
  dev.settingsRows = (await st.offers('get')) ? await st.show() : [];
  dev.labels = await oep.settings.labels(dev.host);
  dev.settingsState = (await st.offers('state')) ? await st.state().catch(() => null) : null;
  dev.network = (await st.offers('network')) && dev.catalog.netif.size ? await st.network().catch(() => null) : null;
  dev.memo = null; dev.memos = []; dev.records.clear(); dev.connectors.clear(); dev.webRecords.clear();
  if (offered('oep.probe.memo').length) {
    dev.memo = await oep.memo.Memo.open(dev.host);
    dev.memos = await dev.memo.list();
  }
  dev.ports = oep.settings.portsNamed(dev.labels).map((name) => ({ name,
    lines: dev.labels.filter(([, l]) => oep.settings.parseLabel(l)?.[0].toLowerCase() === name.toLowerCase()) }));
  const names = new Set(dev.memos.map((m) => new TextDecoder().decode(m.name)));
  await Promise.all(dev.ports.map(async (port) => {
    const record = dev.memo ? await dev.memo.readPortRecord(port.name) : localRecord(port.name);
    dev.records.set(port.name.toLowerCase(), record && typeof record === 'object' && !Array.isArray(record) ? record : {});
    const web = dev.memo ? (names.has(webPortName(port.name)) ? await readJson(webPortName(port.name)) : null) : localWeb(port.name);
    if (web) dev.webRecords.set(port.name.toLowerCase(), web);
    if (web?.kind === 'connector') dev.connectors.add(port.name.toLowerCase());
  }));
}
async function readJson(name) {
  try { const v = JSON.parse(new TextDecoder().decode(await dev.memo.read(name))); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
const localKey = (port, kind = 'port') => `oep-${kind}:${unit()}:${port.toLowerCase()}`;
function localRecord(port) { try { return JSON.parse(localStorage.getItem(localKey(port)) ?? '{}'); } catch { return {}; } }
function localWeb(port) { try { return JSON.parse(localStorage.getItem(localKey(port, 'web')) ?? 'null'); } catch { return null; } }
export const recordOf = (port) => dev.records.get(port.toLowerCase()) ?? {};
export const isConnector = (port) => dev.connectors.has(port.toLowerCase());
export const portOf = (name) => dev.ports.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) ?? null;
/** A port's lines as { line -> channel } (lower case). */
export function portLines(port) {
  const out = new Map();
  for (const [ch, label] of port.lines) { const pl = oep.settings.parseLabel(label); if (pl?.[1]) out.set(pl[1].toLowerCase(), ch); }
  return out;
}

// -- saving a connection (W03) --
/**
 * Labels, then the probe's persistent save, then the records: three stores, not one transaction (§6.3). The stage that
 * failed is named; the stages before it stay done.
 * @param {{ original: {name:string, lines:[number,string][]} | null, name: string, desired: [number,string][], part: string, note: string, connector: boolean, debug?: string }} c
 */
export async function saveConnection(c) {
  await ensureSession();
  await refresh();
  if (!dev.changeable) throw new Error(t('This probe\'s settings cannot be changed, so wiring cannot be registered.', 'このプローブは設定を変更できないため、配線を登録できません。'));
  const plan = connectionChange({ name: c.name, labels: dev.labels, original: c.original, desired: c.desired });
  const st = new oep.settings.Settings(dev.host);
  const done = [];
  let stage = t('applying pin names (wiring)', 'ピン名（配線）の適用');
  try {
    if (plan.unset.length) await st.unsetNamed('core', plan.unset.map((ch) => `channel.${pinName(ch)}.label`));
    if (plan.set.length) await st.setNamed('core', Object.fromEntries(plan.set.map(([ch, label]) => [`channel.${pinName(ch)}.label`, label])));
    if (plan.unset.length || plan.set.length) { dev.unsaved = true; done.push(t('wiring applied', '配線を適用')); }
    stage = t('storing in the probe', 'プローブへの永続保存');
    if (dev.saveable) { await st.save(); dev.unsaved = false; done.push(t('stored', '永続保存')); }
    stage = t('saving the part number and memo', '相手の型番・メモの保存');
    const previous = c.original ? recordOf(c.original.name) : {};
    const wiringChanged = plan.unset.length > 0 || plan.set.length > 0;
    const fields = { ...previous, part: c.connector ? null : c.part, note: c.note, ...(wiringChanged || c.connector ? { target: null } : {}) };
    const renamed = c.original && c.original.name.toLowerCase() !== c.name.toLowerCase();
    const web = c.connector || c.debug ? { ...(c.connector ? { kind: 'connector' } : {}), ...(c.debug ? { debug: c.debug } : {}) } : null;
    if (dev.memo) {
      await dev.memo.updatePortRecord(c.name, fields);
      if (web) await dev.memo.write(webPortName(c.name), new TextEncoder().encode(JSON.stringify(web)));
      else await deleteMemo(webPortName(c.name));
      if (renamed) { await deleteMemo(oep.memo.portRecordName(c.original.name)); await deleteMemo(webPortName(c.original.name)); }
    } else {
      const record = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== ''));
      localStorage.setItem(localKey(c.name), JSON.stringify(record));
      if (web) localStorage.setItem(localKey(c.name, 'web'), JSON.stringify(web)); else localStorage.removeItem(localKey(c.name, 'web'));
      if (renamed) { localStorage.removeItem(localKey(c.original.name)); localStorage.removeItem(localKey(c.original.name, 'web')); }
    }
    done.push(dev.memo ? t('part number and memo saved in the probe', '型番・メモをプローブに保存') : t('part number and memo saved in this browser', '型番・メモをこのブラウザに保存'));
  } catch (error) {
    throw new Error(t(`Failed while ${stage}. ${done.length ? `Done: ${done.join(', ')}. ` : 'Nothing was changed. '}Read the list again, then save again. (${errorText(error)})`, `${stage}でエラーになりました。${done.length ? `済んだもの: ${done.join('、')}。` : '何も変更していません。'}一覧を読み直してから、もう一度保存してください。（${errorText(error)}）`));
  } finally { await refresh(); changed(); }
  return { done, persistent: dev.saveable, inProbe: !!dev.memo };
}
async function deleteMemo(name) {
  try { await dev.memo.delete(name); } catch (error) { if (!(error instanceof oep.NoResource)) throw error; }
}
export async function deleteConnection(port) {
  await ensureSession();
  const st = new oep.settings.Settings(dev.host);
  try {
    await st.unsetNamed('core', port.lines.map(([ch]) => `channel.${pinName(ch)}.label`)); dev.unsaved = true;
    if (dev.saveable) { await st.save(); dev.unsaved = false; }
    if (dev.memo) { await deleteMemo(oep.memo.portRecordName(port.name)); await deleteMemo(webPortName(port.name)); }
    else { localStorage.removeItem(localKey(port.name)); localStorage.removeItem(localKey(port.name, 'web')); }
  } finally { await refresh(); changed(); }
}

// -- debug wires: one connection check (I02/W03) and the debug operation (W04) --
export const wireOffer = (wire) => offered(WIRES[wire])[0] ?? null;
function wireClient(offer) {
  return offer.entry.name === WIRES.swd ? new oep.arm.SwdWire(dev.host, offer.entry.fn, offer.entry.name) : new oep.riscv.Wire(dev.host, offer.entry.fn, offer.entry.name);
}
/** RP2040's multi-drop SWD: core 0 (TARGETSEL, ADIv5.2). Tried when a plain SWD attach gets no answer. */
const RP2040_CORE0 = 0x01002927;
async function attachWire(offer, { dio, clk, nrst = null, maxSpeed = null, halt = false, reset = false }) {
  const client = wireClient(offer);
  /** @type {[number, number]} */
  const pins = [+dio, offer.entry.name === WIRES.swio ? 65535 : +clk];
  const opts = { pins, maxSpeed: maxSpeed ? +maxSpeed : null, ...(reset && nrst !== null && nrst !== '' ? { reset: /** @type {[number, number]} */ ([+nrst, 20]) } : {}) };
  if (offer.entry.name === WIRES.swd) {
    try { const r = await client.attach(opts); return { client, conn: r.conn, id: `DPIDR 0x${(r.dpidr >>> 0).toString(16).padStart(8, '0')}`, arm: true, pins }; }
    catch (first) {
      try { const r = await client.attach({ ...opts, targetsel: RP2040_CORE0 }); return { client, conn: r.conn, id: t(`DPIDR 0x${(r.dpidr >>> 0).toString(16).padStart(8, '0')} (RP2040 core 0, multi-drop)`, `DPIDR 0x${(r.dpidr >>> 0).toString(16).padStart(8, '0')}（RP2040 コア0、multi-drop）`), arm: true, pins, targetsel: RP2040_CORE0 }; }
      catch { throw first; }
    }
  }
  const r = await client.attach({ ...opts, halt });
  return { client, conn: r.conn, id: `dmstatus 0x${(r.dmstatus >>> 0).toString(16).padStart(8, '0')}`, arm: false, pins };
}
/** Attach once, report what answered, detach (§5.2): the result is shown, never saved as wiring. */
export async function checkDebug(wire, pins) {
  const offer = wireOffer(wire);
  if (!offer) throw new Error(t('This probe does not have this debug method.', 'このプローブはこのデバッグ方式を持っていません。'));
  if (dev.debug) throw new Error(t('A debug operation is connected to the target. Detach it first.', 'デバッグ操作でターゲットに接続中です。先に切り離してください。'));
  await ensureSession();
  try {
    const a = await attachWire(offer, pins);
    await a.client.detach(a.conn).catch(() => {});
    return { ok: true, id: a.id };
  } catch (error) {
    if (error instanceof oep.TransportFailed || error instanceof oep.Locked || error instanceof oep.NoSession) throw error;
    return { ok: false, id: '', reason: errorText(error) };
  }
}
/** Scan declared candidate pairs among `pins` (A42): results are candidates for the editor, not saved. */
export async function scanDebug(wire, pins) {
  const offer = wireOffer(wire);
  if (!offer || !supports(offer, oep.riscv.WireBase.SCAN)) throw new Error(t('This probe cannot search for this method. Name the pins and register them.', 'このプローブは、この方式の自動検索を持っていません。ピンを明示して登録してください。'));
  await ensureSession();
  const client = wireClient(offer);
  const chosen = new Set(pins.map(Number));
  const pairs = (await client.candidatePairs()).filter(([a, b]) => chosen.has(a) && (b === 65535 || chosen.has(b)));
  if (!pairs.length) throw new Error(t('The chosen pins are not declared as candidates for this method.', '選んだピンの組は、この方式の候補として宣言されていません。'));
  const found = await client.scan(pairs);
  return { tried: pairs.length, found: found.map((f) => ({ dio: f.pins[0], clk: f.pins[1] === 65535 ? '' : f.pins[1], id: `dmstatus 0x${(f.dmstatus >>> 0).toString(16).padStart(8, '0')}` })) };
}
export const scanOffered = (wire) => { const o = wireOffer(wire); return !!o && supports(o, oep.riscv.WireBase.SCAN); };
export async function attachDebug(wire, pins) {
  const offer = wireOffer(wire);
  if (!offer) throw new Error(t('This probe does not have this debug method.', 'このプローブはこのデバッグ方式を持っていません。'));
  if (dev.debug) throw new Error(t('Already connected to the target.', 'すでにターゲットに接続しています。'));
  await ensureSession();
  const a = await attachWire(offer, pins);
  dev.debug = { ...a, wire, offer, target: null, mem: null, cpu: null, mechanisms: [] };
  if (!a.arm && offered('oep.target.console').length) {
    try { dev.debug.mechanisms = await (await oep.targetConsole.Console.open(dev.host)).mechanisms(); } catch { dev.debug.mechanisms = []; }
  }
  dev.active.set('debug', { title: t(`Debug (${wire.toUpperCase()})`, `デバッグ（${wire.toUpperCase()}）`), route: '/operate/debug', stop: detachDebug });
  changed();
  return a.id;
}
export async function detachDebug() {
  const d = dev.debug;
  if (!d) return;
  try { if (dev.console) await closeConsole().catch(() => {}); await d.client.detach(d.conn); }
  finally { dev.debug = null; dev.active.delete('debug'); changed(); }
}
async function debugTarget() {
  const d = dev.debug;
  if (!d) throw new Error(t('Connect to the target first.', '先にターゲットに接続してください。'));
  checkEpoch();
  if (!d.target) {
    if (d.arm) { d.target = await oep.arm.ArmAdi.on(dev.host, d.conn, {}); await d.target.powerUp(); d.mem = await oep.arm.MemAp.open(d.target, 0); d.cpu = new oep.arm.CortexM(d.mem, 0, 0); }
    else d.target = await oep.riscv.RiscvDm.on(dev.host, d.conn);
  }
  return d;
}
export const debugTargetOffered = () => !!dev.debug && offered(dev.debug.arm ? 'oep.target.arm-adi' : 'oep.target.riscv-dm').length > 0;
export async function debugControl(method) {
  const d = await debugTarget();
  const m = d.arm ? { halt: 'halt', resume: 'resume', reset: 'sysReset', step: 'step' }[method] : method;
  const out = await (d.arm ? d.cpu : d.target)[m]();
  return out ?? 'OK';
}
export async function debugRead(address, words) { const d = await debugTarget(); return (d.arm ? d.mem : d.target).readBlock(address, words); }
export async function debugWrite(address, value) { const d = await debugTarget(); await (d.arm ? d.mem : d.target).write32(address, value); }
export async function debugRegister(n) { const d = await debugTarget(); return d.arm ? d.cpu.reg(n) : d.target.readRegister(n); }
export async function openConsole(mechanism) {
  if (!dev.debug) throw new Error(t('Connect to the target first.', '先にターゲットに接続してください。'));
  const c = await oep.targetConsole.Console.open(dev.host); await c.open(dev.debug.conn, mechanism);
  dev.console = { source: c, io: new oep.targetConsole.ConsoleIO(c), mechanism };
  dev.active.set('console', { title: t(`Debug-wire log (${mechanism})`, `デバッグ線のログ（${mechanism}）`), route: '/operate/console', stop: closeConsole });
  changed();
}
export async function closeConsole() { try { if (dev.console) await dev.console.source.close(); } finally { dev.console = null; dev.active.delete('console'); changed(); } }
export async function consoleRead() { return dev.console.io.readAll(65536); }
export async function consoleWrite(text) { await dev.console.io.write(new TextEncoder().encode(text)); }

// -- fixture functions (W04) --
/** Assign pins for one function and keep it until stopped (§7.1: start = lock, pins, conditions, in that order). */
export async function startFunction(id, tool, offer, bindings, title) {
  await ensureSession();
  validateBindings(offer.description.roles, offer.description.groups, bindings);
  /** @type {[number, number, number][]} */
  const assignments = bindings.map(([role, ch]) => [offer.entry.fn, role, ch]);
  await oep.core.planApply(dev.host, assignments);
  dev.plans.set(offer.entry.fn, assignments);
  dev.active.set(id, { title, route: `/operate/${id}`, stop: () => stopFunction(id, offer) });
  changed();
}
export async function functionClient(tool, offer) {
  checkEpoch();
  if (!dev.clients.has(offer.entry.fn)) dev.clients.set(offer.entry.fn, await tool.Class.open(dev.host, { fn: offer.entry.fn }));
  return dev.clients.get(offer.entry.fn);
}
export async function stopFunction(id, offer) {
  try { if (dev.host?.session && dev.plans.has(offer.entry.fn)) await oep.core.planRelease(dev.host, [offer.entry.fn]); }
  finally { dev.plans.delete(offer.entry.fn); dev.clients.delete(offer.entry.fn); dev.active.delete(id); changed(); }
}
export async function stopActive(id) { const a = dev.active.get(id); if (a) await a.stop(); }
export async function stopAll() { for (const id of [...dev.active.keys()].reverse()) await stopActive(id).catch(() => dev.active.delete(id)); }

// -- settings (W05) --
const st = () => new oep.settings.Settings(dev.host);
/** The categories whose items match `item` (e.g. passthrough.{}.rx), with the route names its keys take. */
export function categoriesWith(item) {
  if (!dev.catalog) return [];
  return [...dev.catalog.category].filter(([fn]) => dev.catalog.items.get(fn)?.some((it) => it.name === item)).map(([, name]) => name);
}
export const routes = () => [...(dev.catalog?.route.values() ?? [])].filter((r) => !r.startsWith('tcp'));
export function currentValue(category, flat) { return dev.settingsRows.find((r) => r.category === category && r.name === flat)?.value; }
export async function applySettings(category, values, unsets = []) {
  await ensureSession();
  const s = st();
  if (unsets.length) await s.unsetNamed(category, unsets);
  if (Object.keys(values).length) await s.setNamed(category, values);
  dev.unsaved = true;
  await refresh(); changed();
}
export async function saveSettings() { await ensureSession(); await st().save(); dev.unsaved = false; await refresh(); changed(); }
export async function exportSettings() { return st().export(); }
export async function planRestore(doc) { return st().planImport(doc); }
export async function applyRestore(plan) { await ensureSession(); await st().applyImport(plan); dev.unsaved = true; await refresh(); changed(); }
/** Save the settings and restart the probe (an item marked restart, such as usb.transports, takes effect then). The
 * link closes: a USB probe may come back as another device, so the page connects again through C01. */
export async function saveAndRestart() {
  await ensureSession();
  await st().save();
  dev.unsaved = false;
  const h = dev.host;
  await stopAll().catch(() => {});
  await h.requestRestart();
  await disconnect().catch(() => {});
}
export const restartOffered = () => offered('oep.probe.restart').length > 0;
export function itemOf(category, flat) { try { return dev.catalog.resolve(category, flat)?.[0] ?? null; } catch { return null; } }

// -- memo backup and restore (W06): the same shape as the bench's backup (unit_id, objects: name -> text | base64) --
export async function exportMemo() {
  if (!dev.memo) return null;
  const objects = {};
  for (const e of await dev.memo.list()) {
    const name = new TextDecoder().decode(e.name), data = await dev.memo.read(e.name);
    try { objects[name] = { text: new TextDecoder('utf-8', { fatal: true }).decode(data) }; }
    catch { objects[name] = { base64: btoa(String.fromCharCode(...data)) }; }
  }
  return { unit_id: unit(), objects: Object.fromEntries(Object.entries(objects).sort(([a], [b]) => a < b ? -1 : 1)) };
}
const bytesOf = (o) => o.text !== undefined ? new TextEncoder().encode(o.text) : Uint8Array.from(atob(o.base64), (c) => c.charCodeAt(0));
export async function planMemoRestore(doc) {
  if (!dev.memo) throw new Error(t('This probe has no memo area.', 'このプローブにはメモ領域がありません。'));
  if (!doc || typeof doc.objects !== 'object') throw new Error(t('This is not a memo backup file.', 'メモの控えのファイルではありません。'));
  const now = new Map((await dev.memo.list()).map((e) => [new TextDecoder().decode(e.name), e]));
  const todo = [];
  for (const [name, o] of Object.entries(doc.objects)) {
    const data = bytesOf(o);
    if (!now.has(name)) todo.push({ name, data, why: t('missing', '無い') });
    else { const cur = await dev.memo.read(name); if (cur.length !== data.length || cur.some((b, i) => b !== data[i])) todo.push({ name, data, why: t('differs', '内容が違う') }); }
  }
  return { otherProbe: doc.unit_id && doc.unit_id.toLowerCase() !== unit().toLowerCase(), todo };
}
export async function applyMemoRestore(plan) { await ensureSession(); for (const tk of plan.todo) await dev.memo.write(tk.name, tk.data); await refresh(); changed(); }
export async function memoRead(name) { return dev.memo.read(name); }
export async function memoWrite(name, data) { await ensureSession(); await dev.memo.write(name, data); await refresh(); changed(); }
export async function memoDelete(name) { await ensureSession(); await deleteMemo(name); await refresh(); changed(); }

// -- diagnostics --
export async function rereadDeclarations() { dev.caps = await oep.dump.collect(dev.host); changed(); }
export const declarationsText = () => oep.dump.toText(dev.caps);
export const declarationsJson = () => oep.dump.toJson(dev.caps);
export async function speedTest(rates) { await ensureSession(); return oep.speedText(await oep.raiseSpeed(dev.host, rates)); }
export const serialLink = () => ['serial', 'webserial'].includes(dev.host?.link.transport.kind);

/** End this page's use and leave the probe free for another tool (§7.4). */
export async function handOver() { await disconnect(); }

// -- firmware: release images, installation (I01) and update (W06) --
export const IMAGE_KIND = { rp2040: 'uf2', rp2350: 'uf2', esp32p4: 'app', esp32p4x: 'app' };
export const release = { manifest: null, error: false };
export async function loadRelease() {
  try {
    const response = await fetch('./firmware/firmware.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    release.manifest = oep.parseFirmwareManifest(await response.json()); release.error = false;
  } catch { release.manifest = null; release.error = true; }
  changed();
}
export const releaseEntry = (model, kind) => release.manifest && oep.pickFirmware(release.manifest, { model, kind });
async function firmwareImage(model, kind) {
  const entry = releaseEntry(model, kind);
  if (!entry) throw new Error(t('This site has no firmware image for this board.', 'このサイトには、このボード向けのファームウェアイメージがありません。'));
  const response = await fetch(`./firmware/${entry.file}`);
  if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}`);
  return oep.verifyFirmware(new Uint8Array(await response.arrayBuffer()), entry);
}
/** Choose the device to install on, once (§5.1 step 2), and read what it is: ESP from its ROM, RP2 from its boot ROM. */
export async function chooseInstallTarget(method) {
  if (method === 'serial') {
    if (!browser.serial) throw new Error(t('Open it in desktop Chrome or Edge with Web Serial, from HTTPS or localhost.', 'Web Serial に対応したデスクトップの Chrome・Edge で、HTTPS か localhost から開いてください。'));
    const port = await serialApi.requestPort();
    const chip = await detectEsp(port);
    return { method, port, chip: chip.name, revision: chip.major, model: chip.model };
  }
  if (method === 'bootsel') {
    if (!browser.usb) throw new Error(t('Open it in Chrome or Edge with WebUSB, from HTTPS or localhost.', 'WebUSB に対応した Chrome・Edge で、HTTPS か localhost から開いてください。'));
    const device = await usbApi.requestDevice({ filters: Object.entries(oep.RP2_BOOT_PID).map(([, productId]) => ({ vendorId: oep.RP2_BOOT_VID, productId })) });
    const model = Object.entries(oep.RP2_BOOT_PID).find(([, pid]) => pid === device.productId)?.[0];
    if (!model) throw new Error(t('Not an RP2040 / RP2350 BOOTSEL device.', 'RP2040 / RP2350 の BOOTSEL の機器ではありません。'));
    return { method, device, chip: model.toUpperCase(), model };
  }
  throw new Error(t('This board cannot be installed from this page.', 'このボードはこのページから導入できません。'));
}
/** Write the image (verified first) to the chosen device. custom: a File for S3/C3/C6. */
/** @param {any} target @param {{ custom?: any, onProgress?: (done:number, total:number, text:string) => void, log?: (line:string) => void }} [opts] */
export async function writeInstall(target, { custom = null, onProgress = () => {}, log = () => {} } = {}) {
  if (dev.host) await disconnect();
  if (target.method === 'serial') {
    let image;
    if (custom) image = new Uint8Array(await custom.arrayBuffer());
    else image = await firmwareImage(target.model, 'merged');
    onProgress(0, 1, t('Firmware image checked. Starting to write', 'ファームウェアイメージを確認しました。書き込みを始めます'));
    return flashEsp({ port: target.port, model: target.model, image, onProgress, log });
  }
  const image = await firmwareImage(target.model, 'uf2');
  await oep.rp2Write(target.device, image, { model: target.model, onProgress: (p) => onProgress(p.done, p.total, `${p.done} / ${p.total} bytes`) });
  return target.chip;
}
/** After writing: the same serial port when it stays (A04-A06), else the OEP USB device this site may already open. */
export async function reconnectAfterInstall(target, tries = 4) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, i ? 1200 : 700));
    try {
      if (target.method === 'serial') { await connectWith(openSerial(target.port), { models: [target.model] }); return { ok: true }; }
      const devices = (await grantedUsbProbes()).filter((d) => !target.knownSerials?.includes(d.serialNumber));
      if (devices.length === 1) { await connectWith(openUsb(devices[0]), { models: [target.model] }); return { ok: true }; }
      last = devices.length > 1 ? t('There are several devices of the same kind, so the written unit cannot be told apart.', '同じ種類の機器が複数あり、書き込んだ個体を決められません。') : t('This page cannot open the booted OEP device yet.', '起動した OEP の機器を、このページはまだ開けません。');
    } catch (error) { last = errorText(error); }
  }
  return { ok: false, reason: last };
}
/** The browser's permission for the started OEP device (the chooser, once, in the same screen). */
export async function grantAfterInstall(target) {
  if (target.method === 'serial') return connectWith(openSerial(await serialApi.requestPort()), { models: [target.model] });
  return connectWith(openUsb(await oep.requestUsbProbe()), { models: [target.model] });
}
export async function knownSerials() { try { return (await grantedUsbProbes()).map((d) => d.serialNumber); } catch { return []; } }

/** Update the connected probe (W06): RP2 through its reset interface and boot ROM, P4 through DFU. */
export function updateMethod() { return IMAGE_KIND[dev.info?.model] ?? null; }
export async function updateFirmware(onProgress) {
  const model = dev.info.model, kind = IMAGE_KIND[model], unitId = unit();
  if (!kind) throw new Error(t('This probe cannot be updated from this page. Rewrite it with the installation steps.', 'このプローブは、このページからの更新に対応していません。導入と同じ手順で書き直してください。'));
  const image = await firmwareImage(model, kind);
  if (kind === 'app') {
    const d = await oep.requestDfuDevice();
    if ((d.serialNumber ?? '').toLowerCase() !== unitId.toLowerCase()) throw new Error(t('The chosen device\'s unit ID differs from the connected probe.', '選んだ機器は、接続中のプローブと個体IDが違います。'));
    await disconnect();
    await oep.dfuUpdate(d, image, { onProgress: (p) => onProgress(p.written, p.total, `${p.phase}: ${p.written} / ${p.total} bytes`) });
  } else {
    const d = await oep.requestUsbProbe();
    if ((d.serialNumber ?? '').toLowerCase() !== unitId.toLowerCase()) throw new Error(t('The chosen device\'s unit ID differs from the connected probe.', '選んだ機器は、接続中のプローブと個体IDが違います。'));
    await disconnect();
    if (!await oep.rp2ResetToBoot(d)) throw new Error(t('This device cannot be restarted over USB. Plug it in holding BOOTSEL and rewrite it with the installation steps.', 'この機器には USB からの再起動の機能がありません。BOOTSEL を押しながら挿し、導入の手順で書き直してください。'));
    let boot = null;
    for (let i = 0; i < 30 && !boot; i++) {
      boot = (await usbApi.getDevices()).find((x) => x.vendorId === oep.RP2_BOOT_VID && x.productId === oep.RP2_BOOT_PID[model]);
      if (!boot) await new Promise((r) => setTimeout(r, 200));
    }
    if (!boot) boot = await usbApi.requestDevice({ filters: [{ vendorId: oep.RP2_BOOT_VID, productId: oep.RP2_BOOT_PID[model] }] });
    await oep.rp2Write(boot, image, { model, onProgress: (p) => onProgress(p.done, p.total, `${p.done} / ${p.total} bytes`) });
  }
  return { model, unitId, version: release.manifest?.version };
}
