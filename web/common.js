// Pieces several screens share: the probe's band and tabs (page.ja.md §6.1), the "connect first" screen, wiring.
import { el, p, badge, actions, link, panel, heading, note } from './ui.js';
import { state, go, routeNow, action, button } from './core.js';
import { dev, unit, pinName, portLines, isConnector, recordOf, disconnect, browser, saveSettings } from './device.js';
import { DEBUG_WIRES, GUIDE_BASE } from './data.js';
import { t, tr, onLanguage } from './i18n.js';
import { BOARDS as BOARD_SPECS, boardOf } from './boards.js';

export const wireById = (id) => DEBUG_WIRES.find((w) => w.id === id) ?? null;
export const connected = () => !!dev.host;
export const boardSpec = () => boardOf(dev.info?.model);
export const probeTitle = () => dev.info ? `${boardSpec() ? tr(boardSpec().name) : dev.info.model} · ${unit()}` : t('No probe connected', 'プローブ未接続');

export function debugChoices(onChoose, selected = '', consoleOnly = false) {
  return el('div', { class: 'three-grid debug-choices' }, ...DEBUG_WIRES.filter((w) => !consoleOnly || w.id !== 'swd').map((w) => {
    const has = !connected() || dev.caps.offers.some((o) => o.entry.name === `oep.wire.${w.id}`);
    return el('button', { type: 'button', class: `pattern-card${selected === w.id ? ' selected' : ''}`, 'data-wire': w.id, 'aria-pressed': String(selected === w.id), disabled: !has, onclick: () => onChoose(w.id) },
      el('strong', {}, w.title), el('span', {}, w.description), el('span', { class: 'pattern-next' }, `${w.roles.join(' + ')} / ${t('common GND', 'GND共通')}`),
      el('small', {}, has ? w.note : t('This probe does not declare this method.', 'このプローブはこの方式を宣言していません。')));
  }));
}

/** The signal groups a saved port has, read from its line names (labels are the wiring's truth, §6.3). */
export function groupsOf(port) {
  const lines = portLines(port), groups = [];
  const take = (names) => Object.fromEntries(names.filter((n) => lines.has(n)).map((n) => [n, lines.get(n)]));
  const web = dev.records && port ? (isConnector(port.name) ? 'connector' : 'fixed') : 'fixed';
  if (lines.has('swio')) groups.push({ type: 'debug', wire: 'swio', pins: take(['swio', 'nrst']) });
  else if (lines.has('swdio') || lines.has('swclk')) groups.push({ type: 'debug', wire: debugWireOf(port), pins: take(['swdio', 'swclk', 'nrst']) });
  if (lines.has('rx') || lines.has('tx')) groups.push({ type: 'uart', pins: take(['rx', 'tx']) });
  if (lines.has('sda') || lines.has('scl')) groups.push({ type: 'i2c', pins: take(['sda', 'scl']) });
  if (['sck', 'mosi', 'miso', 'cs'].some((n) => lines.has(n))) groups.push({ type: 'spi', pins: take(['sck', 'mosi', 'miso', 'cs']) });
  const known = new Set(['swio', 'swdio', 'swclk', 'nrst', 'rx', 'tx', 'sda', 'scl', 'sck', 'mosi', 'miso', 'cs']);
  const other = [...lines].filter(([n]) => !known.has(n));
  if (other.length) groups.push({ type: 'custom', pins: Object.fromEntries(other) });
  return groups.map((g) => ({ ...g, kind: web }));
}
/** rvswd and swd share swdio / swclk: the web record tells which, else the record's part, else unknown. */
export function debugWireOf(port) {
  const r = recordOf(port.name), w = dev.webRecords?.get(port.name.toLowerCase())?.debug;
  if (w === 'rvswd' || w === 'swd') return w;
  if (/^ch32/i.test(r.part ?? '')) return 'rvswd';
  if (/^(rp20|stm32|nrf|samd|atsam)/i.test(r.part ?? '')) return 'swd';
  const one = ['rvswd', 'swd'].filter((x) => dev.caps?.offers.some((o) => o.entry.name === `oep.wire.${x}`));
  return one.length === 1 ? one[0] : '';
}
export const GROUP_TITLE = { get debug() { return t('Debug', 'デバッグ'); }, uart: 'UART', i2c: 'I2C', spi: 'SPI', get custom() { return t('Other signals', 'そのほかの信号'); } };
export function wiringSummary(port) {
  return el('div', { class: 'wiring-summary' }, ...groupsOf(port).flatMap((g) => [
    badge(g.type === 'debug' ? (wireById(g.wire)?.short ?? 'SWD / RVSWD') : GROUP_TITLE[g.type], 'gray'),
    ...Object.entries(g.pins).map(([line, ch]) => el('span', {}, `${line} → ${pinName(ch)}`))]));
}

export function needConnection(returnTo) {
  return el('div', { class: 'page' }, heading(dev.lost ? t('The connection ended.', '接続が切れました。') : t('Connect a probe to go on.', 'プローブにつないで、続きを開きます。'), t('After connecting you come back to this screen.', 'つなぐと、この画面に戻ります。'), 'CONNECT'),
    dev.lost ? note(dev.lost, 'error') : null,
    actions(button(t('Connect a probe →', 'プローブにつなぐ →'), () => { state.connectReturn = returnTo; go('/connect'); }, 'primary', { 'data-connect': 'go' }), dev.lost ? null : link(t('Make a board a probe', 'ボードをプローブにする'), '/make')));
}

/** The probe's tabs (page.ja.md §6.1). */
export const TABS = () => [['/probe', t('Overview', '概要')], ['/probe/wiring', t('Wiring', '配線')], ['/probe/settings', t('Probe settings', '本体設定')],
  ['/probe/tools', t('Hand over to tools', '道具へ渡す')], ['/probe/maintenance', t('Maintenance', '保守')]];

/** The probe's band (unit, firmware, path, change right, unsaved changes with Save, Disconnect) and tabs, around a tab's content. */
export function probeFrame(content) {
  const h = dev.host;
  const active = routeNow().split('?')[0];
  const isActive = (path) => path === '/probe' ? active === '/probe' : active === path || active.startsWith(`${path}/`);
  return el('div', { class: 'probe-page' },
    el('section', { class: 'probe-band', id: 'device-status' },
      el('div', {}, el('strong', {}, probeTitle()),
        el('small', { class: 'muted' }, `firmware ${dev.info.firmware ?? '—'} · ${t('path', '経路')} ${h.link.transport.kind ?? '—'} · `, h.session ? t('may change it', '変更権あり') : t('read only', '読み取りのみ'))),
      el('div', { class: 'actions' }, action(t('Disconnect', '接続を終了'), async () => { await disconnect(); state.notice = t('Disconnected.', '接続を終了しました。'); go('/'); }, '', { 'data-action': 'disconnect' }))),
    dev.unsaved ? el('div', { class: 'unsaved-bar', id: 'unsaved' }, p(t('Unsaved changes: they are lost on restart.', '未保存の変更があります（再起動すると消えます）。'), 'mb0'),
      dev.saveable ? action(t('Save', '保存'), saveSettings, 'primary', { id: 'save-settings' }) : p(t('This probe cannot store settings.', 'このプローブは設定を保存できません。'), 'mb0 muted')) : null,
    el('nav', { class: 'probe-tabs', 'aria-label': t('Probe', 'プローブ') }, ...TABS().map(([path, title]) => el('a', { href: `#${path}`, class: isActive(path) ? 'active' : '', 'aria-current': isActive(path) ? 'page' : 'false' }, title))),
    el('div', { class: 'probe-content' }, content));
}
export { browser, GUIDE_BASE, BOARD_SPECS, note, panel };
