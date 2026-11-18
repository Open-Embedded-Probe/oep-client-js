// The log pass-through (W05): a probe setting that sends the target's UART or debug-wire log to the probe's serial
// port while no OEP session holds the probe. Opening the screen applies nothing.
import { el, p, actions, link, external, note, panel, heading, field, keyValues } from './ui.js';
import { state, render, action } from './core.js';
import * as D from './device.js';
import { guide } from './data.js';
import { t } from './i18n.js';
import { connected, needConnection, groupsOf, debugWireOf } from './common.js';

// -- passthrough (W05, initial scope): the probe's own setting, works only while no OEP session holds the probe --
export function passthrough() {
  if (!connected()) return needConnection('/passthrough');
  const uartCats = D.categoriesWith('passthrough.{}.rx'), consoleCats = D.categoriesWith('passthrough.{}.wire');
  const routes = D.routes();
  const s = state.passthrough ??= { source: uartCats.length ? 'uart' : 'console', category: '', route: routes[0] ?? '', rx: '', baud: '115200', format: '8n1', wire: 'rvswd', dio: '', clk: '', mechanism: 'dmseq', port: '' };
  const cats = s.source === 'uart' ? uartCats : consoleCats;
  if (!cats.includes(s.category)) s.category = cats[0] ?? '';
  const current = (flat) => D.currentValue(s.category, flat.replace('{}', s.route));
  const existing = routes.flatMap((r) => [...uartCats, ...consoleCats].flatMap((cat) => {
    const rx = D.currentValue(cat, `passthrough.${r}.rx`), wire = D.currentValue(cat, `passthrough.${r}.wire`);
    return rx !== undefined ? [[r, cat, `UART RX ${rx} · ${D.currentValue(cat, `passthrough.${r}.baud`) ?? 115200} baud · ${D.currentValue(cat, `passthrough.${r}.format`) ?? '8n1'}`]] : wire !== undefined ? [[r, cat, `${wire} · ${D.currentValue(cat, `passthrough.${r}.mechanism`) ?? ''}`]] : [];
  }));
  const debugPorts = D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire !== 'swd'));
  const uartPorts = D.dev.ports.filter((port) => D.portLines(port).has('rx'));
  const apply = async () => {
    if (!s.route) throw new Error(t('Choose the output port.', '出力先のポートを選んでください。'));
    if (s.source === 'uart') {
      if (s.rx === '') throw new Error(t('Choose the receiving pin (the target\'s TX).', '受けるピン（相手のTX）を選んでください。'));
      await D.applySettings(s.category, { [`passthrough.${s.route}.rx`]: D.pinName(s.rx), [`passthrough.${s.route}.baud`]: s.baud, [`passthrough.${s.route}.format`]: s.format });
    } else {
      if (s.dio === '' || (s.wire === 'rvswd' && s.clk === '')) throw new Error(t('Choose the debug-wire pins.', 'デバッグ線のピンを選んでください。'));
      await D.applySettings(s.category, { [`passthrough.${s.route}.wire`]: `oep.wire.${s.wire}`, [`passthrough.${s.route}.swdio`]: D.pinName(s.dio), ...(s.wire === 'rvswd' ? { [`passthrough.${s.route}.swclk`]: D.pinName(s.clk) } : {}), [`passthrough.${s.route}.mechanism`]: s.mechanism });
    }
    s.applied = true;
  };
  const fromPort = (name) => {
    const port = D.portOf(name); s.port = name; if (!port) return;
    const lines = D.portLines(port);
    if (s.source === 'uart') s.rx = lines.has('rx') ? String(lines.get('rx')) : '';
    else { const g = groupsOf(port).find((x) => x.type === 'debug'); s.wire = g?.wire || debugWireOf(port) || 'rvswd'; s.dio = String(lines.get('swio') ?? lines.get('swdio') ?? ''); s.clk = String(lines.get('swclk') ?? ''); }
  };
  return [heading(t('Send the log to an ordinary serial monitor.', '普通のシリアルモニタへログを流す。'), t('A probe pass-through setting that works only while no OEP session is open. It only receives, target → PC, and sends nothing to the target.', 'OEPのセッションがない間だけ働く、本体の素通し設定です。相手 → PCの受信だけで、相手へは送りません。'), 'SETTINGS / PASSTHROUGH'),
    !uartCats.length && !consoleCats.length ? note(t('This probe has no pass-through setting.', 'このプローブは素通しの設定を持っていません。'), 'amber') : null,
    existing.length ? panel(el('h2', {}, t('Current pass-through', '今の素通し')), keyValues(existing.map(([r, , txt]) => [r, txt])),
      actions(...existing.map(([r, cat]) => action(t(`Remove the pass-through on ${r}`, `${r}の素通しを外す`), () => D.applySettings(cat, {}, ['rx', 'baud', 'format', 'wire', 'swdio', 'swclk', 'mechanism', 'max-speed'].map((k) => `passthrough.${r}.${k}`).filter((f) => D.currentValue(cat, f) !== undefined)))))) : null,
    panel(el('h2', {}, t('01 / Where the target logs', '01 / 相手がログを出す経路')), field(t('Log source', 'ログの入力元'), s.source, (v) => { s.source = v; s.port = ''; render(); }, '', [...(uartCats.length ? [['uart', 'UART']] : []), ...(consoleCats.length ? [['console', t('Debug wire (WCH)', 'デバッグ線（WCH）')]] : [])], 'text', { id: 'pt-source' }),
      cats.length > 1 ? field(t('Instance to use', '使う系統'), s.category, (v) => { s.category = v; }, '', cats.map((x) => [x, x])) : null,
      (s.source === 'uart' ? uartPorts : debugPorts).length ? field(t('From registered wiring', '登録済みの配線から'), s.port, (v) => { fromPort(v); render(); }, '', [['', t('Choose pins directly', 'ピンを直接選ぶ')], ...(s.source === 'uart' ? uartPorts : debugPorts).map((x) => [x.name, x.name])]) : null,
      s.source === 'uart' ? [field(t('Receiving pin (from the target\'s TX)', '受けるピン（相手のTXから）'), s.rx, (v) => { s.rx = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])], 'text', { id: 'pt-rx' }), field(t('Speed (baud)', '速さ（baud）'), s.baud, (v) => { s.baud = v; }, '', null, 'text', { id: 'pt-baud' }), field(t('Format', '形式'), s.format, (v) => { s.format = v; }, t('8n1, 7e2 and so on', '8n1、7e2 など'), null, 'text', { id: 'pt-format' })]
        : [field(t('Debug wire', 'デバッグ線'), s.wire, (v) => { s.wire = v; render(); }, '', [['rvswd', t('RVSWD (2 wires)', 'RVSWD（2線）')], ['swio', t('1-wire DIO (SWIO)', '1線DIO（SWIO）')]]), field(s.wire === 'rvswd' ? 'SWDIO' : 'SWIO', s.dio, (v) => { s.dio = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])]),
          s.wire === 'rvswd' ? field('SWCLK', s.clk, (v) => { s.clk = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])]) : null,
          field(t('Target\'s log output method', '相手のログ出力方式'), s.mechanism, (v) => { s.mechanism = v; }, '', [['sdi', 'sdi'], ['dmdata', 'dmdata'], ['dmseq', 'dmseq']]), p(t('This does not halt the target, though RVSWD may reset it on connecting.', '相手を止める設定ではありません。ただしRVSWDでは接続時に相手がリセットされる場合があります。'), 'muted')]),
    panel(el('h2', {}, t('02 / Probe port to output the log', '02 / ログを出すプローブのポート')), field(t('Output serial port', '出力先のシリアルポート'), s.route, (v) => { s.route = v; }, t('One pass-through per port. This does not change how you connect.', '1つのポートに置ける素通しは1つです。接続方式を選び直す操作ではありません。'), routes.map((r) => [r, r]), 'text', { id: 'pt-route' }),
      note(t('It pauses while an OEP tool is using the probe and resumes when the session ends. This page\'s connection is closed at the end too.', 'OEPの道具が使っている間は止まり、セッションが終わると再開します。このページの接続も、最後に終了します。')),
      el('p', { id: 'passthrough-status', role: 'status' }, D.dev.unsaved ? t('Applied, not saved (lost on restart)', '適用済み・未保存（再起動すると消えます）') : s.applied ? t('Saved', '保存済み') : t('Not applied', '未適用')),
      actions(action(t('Apply the pass-through', '素通し設定を適用'), apply, 'primary', { id: 'apply-passthrough', disabled: !s.category }), action(t('Save all current values in the probe', '本体の現在値全体を保存'), D.saveSettings, '', { id: 'save-passthrough', disabled: !D.dev.unsaved || !D.dev.saveable })),
      D.dev.saveable ? null : note(t('This probe cannot store settings. They are lost on restart.', 'このプローブは永続保存できません。再起動すると設定は消えます。'), 'amber'),
      s.applied ? actions(link(t('Disconnect and go to the serial monitor', '接続を終了してシリアルモニタへ'), '/handoff')) : null),
    external(t('Pass-through settings and limits', '素通し設定と制約'), guide('settings')), actions(link(t('To the fixed-fixture steps', '据え置き治具の手順へ'), '/fixture'), link(t('Choose another log method', 'ログの方法を選び直す'), '/setup/logs'))];
}
