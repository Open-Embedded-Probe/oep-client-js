// Pieces several screens share: the workspace frame and status, the "connect first" screen, purpose cards, wiring.
import { el, p, badge, actions, link, panel, heading, note, textLink } from './ui.js';
import { state, go, routeNow, action, button } from './core.js';
import { dev, unit, pinName, portLines, isConnector, recordOf, disconnect, browser } from './device.js';
import { SETUP_PATTERNS, DEBUG_WIRES, GUIDE_BASE } from './data.js';
import { t, tr, onLanguage } from './i18n.js';
import { BOARDS as BOARD_SPECS, boardOf } from './boards.js';

export const wireById = (id) => DEBUG_WIRES.find((w) => w.id === id) ?? null;
export const connected = () => !!dev.host;
export const boardSpec = () => boardOf(dev.info?.model);
export const probeTitle = () => dev.info ? `${boardSpec() ? tr(boardSpec().name) : dev.info.model} · ${unit()}` : t('No probe connected', 'プローブ未接続');

/** A purpose's preparation on this page (I02): its wiring, then the tool that does the work. */
export const purposeRoute = (id) => `/setup/${id}`;
export const purposeById = (id) => SETUP_PATTERNS.find((x) => x.id === id) ?? null;
export const purposeTitle = (id) => purposeById(id)?.title ?? id;
/** From a public or setup card: go to the purpose, through C01 when no probe is connected (§4.2). */
export function choosePurpose(id) {
  const next = purposeRoute(id);
  if (connected()) { go(next); return; }
  state.intent = id; state.connectReturn = next; go('/connect');
}
export function patternChoices(from = 'setup') {
  return el('div', { class: 'two-grid' }, ...SETUP_PATTERNS.map((x) => el('a', { class: 'pattern-card', href: '#' + (from === 'public' ? `/usecase/${x.id}` : purposeRoute(x.id)), 'data-pattern': x.id },
    el('small', { class: 'eyebrow' }, x.label), el('strong', {}, x.title), el('span', {}, x.description), el('span', { class: 'pattern-next' }, x.next + ' →'))));
}
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

export function needConnection(returnTo, title = t('Connect a probe to go on.', 'プローブに接続して、続きを開きます。')) {
  return el('div', { class: 'page' }, heading(title, t('Your chosen task is kept. After connecting you come back to this screen.', '選んだ作業は保持されます。接続すると、この画面に戻ります。'), 'CONNECT'),
    actions(button(t('Choose a probe →', 'プローブを選ぶ →'), () => { state.connectReturn = returnTo; go('/connect'); }, 'primary', { 'data-connect': 'go' }), link(t('Make a board a probe', 'ボードをプローブにする'), '/install/select')));
}

/** The workspace frame (§3.1): current unit, connection, change right, unsaved settings — always visible. */
export function workspaceShell(content) {
  const nav = [['/work', t('Home', 'ホーム')], ['/connections', t('Wiring and targets', '配線・接続先')], ['/settings', t('Probe settings', '本体設定')], ['/maintenance', t('Update and maintenance', '更新・保守')], ['/handoff', t('External tools', '外部ツールとの連携')]];
  const active = routeNow().split('?')[0];
  const isActive = (path) => active === path || (path === '/connections' && active.startsWith('/connection/')) || (path === '/settings' && active === '/passthrough');
  const h = dev.host;
  return el('div', { class: 'workspace-layout' },
    el('aside', { class: 'workspace-nav' }, el('h2', {}, 'YOUR WORKSPACE'), ...nav.map(([path, title]) => el('a', { href: `#${path}`, class: isActive(path) ? 'active' : '', 'aria-current': isActive(path) ? 'page' : 'false' }, title))),
    el('main', { id: 'content', class: 'workspace-main', tabindex: -1 },
      el('div', { class: 'device-status', id: 'device-status' },
        el('div', {}, p(el('span', {}, el('span', { class: 'status-dot' }), h ? `${probeTitle()} · ${t('connected', '接続中')}` : t('No probe connected', 'プローブ未接続'))),
          el('small', { class: 'muted' }, h ? [`firmware ${dev.info.firmware ?? '—'} · ${t('path', '経路')} ${h.link.transport.kind ?? '—'} · `, h.session ? t('may change it', '変更権あり') : t('read only', '読み取りのみ'), dev.unsaved ? t(' · settings applied but not saved', ' · 適用済み・未保存の設定あり') : ''] : t('Choosing a task leads you to connect', '作業を選ぶと接続へ案内します'))),
        h ? action(t('Disconnect', '接続を終了'), async () => { await disconnect(); state.notice = t('Disconnected.', '接続を終了しました。'); }, '', { 'data-action': 'disconnect' })
          : button(t('Connect', '接続する'), () => { state.connectReturn = routeNow(); go('/connect'); })),
      dev.lost ? note(t(`The connection was lost: ${dev.lost}. The state is read again after reconnecting. Outputs and changes are not sent again automatically.`, `接続が切れました: ${dev.lost}。再接続後に状態を読み直します。出力や書き換えは自動で再送しません。`), 'error') : null,
      content));
}
export { browser, GUIDE_BASE, BOARD_SPECS, note, panel };
