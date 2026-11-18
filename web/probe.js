// The probe's tabs but wiring (page.ja.md §6): overview, probe settings, hand over to tools, maintenance.
import { el, p, badge, actions, link, external, note, panel, heading, field, checkbox, keyValues, table, terminal, copyLine, download } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { DOCS, guide } from './data.js';
import { t, tr } from './i18n.js';
import { groupsOf, debugWireOf, boardSpec, probeTitle } from './common.js';
import { firmwareState } from './model.js';

const IDLE = () => [['', t('None (Hi-Z)', '指定なし（Hi-Z）')], ['hi-z', 'Hi-Z'], ['pull-up', 'pull-up'], ['pull-down', 'pull-down'], ['low', t('Output low', '出力 Low')], ['high', t('Output high', '出力 High')]];
const show = (v) => typeof v === 'object' && v !== null ? (v.secret ? t('secret (not read)', '秘密の値（読み出さない）') : JSON.stringify(v)) : String(v);


// -- P4: probe settings (page.ja.md §6.5) --
export function settings() {
  const s = state.settingsDraft;
  const hasIdle = !!D.itemOf('core', `channel.${D.channelList()[0]?.[1]}.idle`), hasDisable = !!D.itemOf('core', `channel.${D.channelList()[0]?.[1]}.disable`);
  const wifi = !!D.itemOf('core', 'wifi.0.ssid');
  s.pins ??= {};
  const pinRows = D.channelList().map(([ch, name]) => {
    const idle = D.currentValue('core', `channel.${name}.idle`) ?? '', dis = D.currentValue('core', `channel.${name}.disable`) === true;
    const d = s.pins[name]?.changed ? s.pins[name] : (s.pins[name] = { idle: String(idle), disable: dis });   // an untouched row follows the probe
    const label = D.dev.labels.find(([c]) => c === ch)?.[1] ?? '';
    return [name, label, hasIdle ? field(t(`${name} idle`, `${name} の待機`), d.idle, (v) => { d.idle = v; d.changed = true; }, '', IDLE(), 'text', { 'data-idle': name }) : '—',
      hasDisable ? checkbox(t('keep off', '使わせない'), d.disable, (v) => { d.disable = v; d.changed = true; }, { 'data-disable': name }) : '—'];
  });
  const applyPins = async () => {
    const set = {}, unset = [];
    for (const [name, d] of Object.entries(s.pins)) {
      if (!d.changed) continue;
      if (hasIdle) { if (d.idle) set[`channel.${name}.idle`] = d.idle; else if (D.currentValue('core', `channel.${name}.idle`) !== undefined) unset.push(`channel.${name}.idle`); }
      if (hasDisable) { if (d.disable) set[`channel.${name}.disable`] = true; else if (D.currentValue('core', `channel.${name}.disable`) !== undefined) unset.push(`channel.${name}.disable`); }
    }
    if (!Object.keys(set).length && !unset.length) throw new Error(t('No pins were changed.', '変更したピンがありません。'));
    await D.applySettings('core', set, unset); s.pins = {};
  };
  return [heading(t('Probe settings', '本体設定'), t('Each "Apply" takes effect at once. To keep the changes after a restart, press "Save" at the top: it stores all of the probe\'s current values.', '「適用」はその場で効きます。再起動後も残すには、上の「保存」を押します（本体の現在値全体を保存します）。'), 'PROBE SETTINGS'),
    !D.dev.changeable ? note(t('This probe\'s settings cannot be changed (read only).', 'このプローブは設定を変更できません（読み取りのみ）。'), 'amber') : null,
    actions(action(t('Read again', '読み直す'), D.refresh)),
    panel(el('h2', {}, t('Idle states and pins kept off', '待機状態・使わせないピン')), p(t('The state of pins while no function uses them, and pins no function may use. Free pins change at once; pins in use change when released.', '機能が使っていない間のピンの状態と、どの機能にも使わせないピンです。空いているピンにはすぐ、使用中のピンには解放したときに効きます。'), 'muted'),
      hasIdle || hasDisable ? [el('details', {}, el('summary', {}, t(`Pins (${pinRows.length})`, `ピンの一覧（${pinRows.length} 本）`)), table([t('Pin', 'ピン'), t('Label', 'ラベル'), t('Idle', '待機'), t('Use', '使用')], pinRows)),
        actions(action(t('Apply the pin settings', 'ピンの設定を適用'), applyPins, 'primary', { id: 'apply-pins' }))] : note(t('This probe has no idle pin settings.', 'このプローブは、ピンの待機状態の設定を持っていません。'))),
    passthroughPanel(),
    panel(el('h2', {}, t('Network', 'ネットワーク')), wifi ? [p(t('Settings to join a Wi-Fi probe to the bench network. This page cannot connect over TCP itself.', 'Wi-Fiに対応したプローブを、ベンチのネットワークにつなぐ設定です。このページから直接TCPで接続できるわけではありません。'), 'muted'),
      field('SSID', s.ssid ?? D.currentValue('core', 'wifi.0.ssid') ?? '', (v) => { s.ssid = v; }, '', null, 'text', { id: 'wifi-ssid' }),
      field(t('Passphrase', 'パスフレーズ'), s.pass ?? '', (v) => { s.pass = v; }, t('Secrets are neither shown nor written to backups. Leave it empty to keep the current value.', '秘密の値は表示も控えのファイルへの書き出しもしません。空欄なら今の値のままです。'), null, 'password', { id: 'wifi-pass' }),
      actions(action(t('Apply the network settings', 'ネットワーク設定を適用'), async () => { const v = { 'wifi.0.ssid': s.ssid ?? '' }; if (s.pass) v['wifi.0.passphrase'] = s.pass; await D.applySettings('core', v); s.pass = ''; })),
      D.dev.network ? el('details', {}, el('summary', {}, t('Network state', 'ネットワークの状態')), terminal(JSON.stringify(D.dev.network, null, 2))) : null]
      : p(t('This probe has no Wi-Fi settings. That is not an installation failure.', 'このプローブにはWi-Fiの設定がありません。導入の失敗ではありません。'), 'muted')),
    usbPanel(s),
    el('details', { class: 'panel mt' }, el('summary', {}, t('All setting values (details)', 'すべての設定値（詳細）')),
      D.dev.settingsRows.length ? table([t('Category', '分類'), t('Item', '項目'), t('Value', '値')], D.dev.settingsRows.map((r) => [r.category, r.name, D.itemOf(r.category, r.name)?.restart ? [show(r.value), ' ', badge(t('after restart', '再起動で有効'), 'amber')] : show(r.value)])) : p(t('No explicit setting values.', '明示的な設定値はありません。'), 'muted'),
      D.dev.changeable ? el('div', { class: 'field-grid mt' }, field(t('Category', '分類'), s.cat ?? 'core', (v) => { s.cat = v; }, '', [...(D.dev.catalog?.category.values() ?? [])].map((c) => [c, c])),
        field(t('Item (for example channel.GPIO5.idle)', '項目（例: channel.GPIO5.idle）'), s.flat ?? '', (v) => { s.flat = v; }), field(t('Value', '値'), s.value ?? '', (v) => { s.value = v; })) : null,
      D.dev.changeable ? actions(action(t('Apply this value', 'この値を適用'), () => D.applySettings(s.cat ?? 'core', { [s.flat]: s.value })), action(t('Clear this item', 'この項目を解除'), () => D.applySettings(s.cat ?? 'core', {}, [s.flat]))) : null),
  ];
}


/** The log pass-through (page.ja.md §6.5): the probe's own setting, working while no OEP session holds the probe. */
function passthroughPanel() {
  const uartCats = D.categoriesWith('passthrough.{}.rx'), consoleCats = D.categoriesWith('passthrough.{}.wire');
  const routes = D.routes();
  const s = state.passthrough ??= { source: uartCats.length ? 'uart' : 'console', category: '', route: routes[0] ?? '', rx: '', baud: '115200', format: '8n1', wire: 'rvswd', dio: '', clk: '', mechanism: 'dmseq', port: '' };
  const cats = s.source === 'uart' ? uartCats : consoleCats;
  if (!cats.includes(s.category)) s.category = cats[0] ?? '';
  const current = (flat) => D.currentValue(s.category, flat.replace('{}', s.route));
  const existing = D.currentPassthroughs();
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
  if (!uartCats.length && !consoleCats.length) return panel(el('h2', {}, t('Log pass-through', 'ログの素通し')), p(t('This probe has no pass-through setting.', 'このプローブは素通しの設定を持っていません。'), 'muted'));
  return el('section', { class: 'panel', id: 'passthrough' }, el('h2', {}, t('Log pass-through', 'ログの素通し')),
    p(t('While no OEP session is open, the probe sends the target\'s UART or debug-wire (WCH) log to one of its serial ports, so an ordinary serial monitor shows it. One way, target → PC.', 'OEPのセッションが無い間、相手のUARTかデバッグ線（WCH）のログをプローブのシリアルポートへ流し、普通のシリアルモニタで読めるようにします。相手 → PCの一方向です。'), 'muted'),
    existing.length ? el('div', { class: 'sub' }, el('h3', {}, t('Now set', '今の素通し')), keyValues(existing.map(([r, , txt]) => [r, txt])),
      actions(...existing.map(([r, cat]) => action(t(`Remove the pass-through on ${r}`, `${r}の素通しを外す`), () => D.applySettings(cat, {}, ['rx', 'baud', 'format', 'wire', 'swdio', 'swclk', 'mechanism', 'max-speed'].map((k) => `passthrough.${r}.${k}`).filter((f) => D.currentValue(cat, f) !== undefined)))))) : null,
    el('div', { class: 'sub' }, el('h3', {}, t('Where the target logs', '相手がログを出す経路')), field(t('Log source', 'ログの入力元'), s.source, (v) => { s.source = v; s.port = ''; render(); }, '', [...(uartCats.length ? [['uart', 'UART']] : []), ...(consoleCats.length ? [['console', t('Debug wire (WCH)', 'デバッグ線（WCH）')]] : [])], 'text', { id: 'pt-source' }),
      cats.length > 1 ? field(t('Instance to use', '使う系統'), s.category, (v) => { s.category = v; }, '', cats.map((x) => [x, x])) : null,
      (s.source === 'uart' ? uartPorts : debugPorts).length ? field(t('From registered wiring', '登録済みの配線から'), s.port, (v) => { fromPort(v); render(); }, '', [['', t('Choose pins directly', 'ピンを直接選ぶ')], ...(s.source === 'uart' ? uartPorts : debugPorts).map((x) => [x.name, x.name])]) : null,
      s.source === 'uart' ? [field(t('Receiving pin (from the target\'s TX)', '受けるピン（相手のTXから）'), s.rx, (v) => { s.rx = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])], 'text', { id: 'pt-rx' }), field(t('Speed (baud)', '速さ（baud）'), s.baud, (v) => { s.baud = v; }, '', null, 'text', { id: 'pt-baud' }), field(t('Format', '形式'), s.format, (v) => { s.format = v; }, t('8n1, 7e2 and so on', '8n1、7e2 など'), null, 'text', { id: 'pt-format' })]
        : [field(t('Debug wire', 'デバッグ線'), s.wire, (v) => { s.wire = v; render(); }, '', [['rvswd', t('RVSWD (2 wires)', 'RVSWD（2線）')], ['swio', t('1-wire DIO (SWIO)', '1線DIO（SWIO）')]]), field(s.wire === 'rvswd' ? 'SWDIO' : 'SWIO', s.dio, (v) => { s.dio = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])]),
          s.wire === 'rvswd' ? field('SWCLK', s.clk, (v) => { s.clk = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])]) : null,
          field(t('Target\'s log output method', '相手のログ出力方式'), s.mechanism, (v) => { s.mechanism = v; }, '', [['sdi', 'sdi'], ['dmdata', 'dmdata'], ['dmseq', 'dmseq']]), p(t('This does not halt the target, though RVSWD may reset it on connecting.', '相手を止める設定ではありません。ただしRVSWDでは接続時に相手がリセットされる場合があります。'), 'muted')]),
    el('div', { class: 'sub' }, el('h3', {}, t('The probe port it goes out on', 'ログを出すプローブのポート')), field(t('Output serial port', '出力先のシリアルポート'), s.route, (v) => { s.route = v; }, t('One pass-through per port. This does not change how you connect.', '1つのポートに置ける素通しは1つです。接続方式を選び直す操作ではありません。'), routes.map((r) => [r, r]), 'text', { id: 'pt-route' }),
      note(t('It pauses while an OEP tool is using the probe and resumes when the session ends. This page\'s connection is closed at the end too.', 'OEPの道具が使っている間は止まり、セッションが終わると再開します。このページの接続も、最後に終了します。')),
      actions(action(t('Apply the pass-through', '素通し設定を適用'), apply, 'primary', { id: 'apply-passthrough', disabled: !s.category })),
      s.applied ? p(t('Applied. Save it (at the top) to keep it after a restart; then open the port in a serial monitor once this page has disconnected (Hand over to tools).', '適用しました。再起動後も残すには上の「保存」を押します。シリアルモニタでは、このページの接続を終えてから（道具へ渡す）ポートを開きます。'), 'muted') : null),
    external(t('Pass-through settings and limits', '素通し設定と制約'), guide('settings')));
}

/** usb.transports (transports §3.1): the OEP transports the probe's own USB device offers, after a restart. */
function usbPanel(s) {
  const item = D.itemOf('core', 'usb.transports');
  if (!item) return null;
  const now = D.currentValue('core', 'usb.transports');
  const choices = [['', t('Default (the probe\'s standard combination)', '既定（プローブの標準の組み合わせ）')], ...[...item.choices.values()].map((c) => [c, c])];
  const restart = async () => {
    await D.saveAndRestart();
    state.notice = t('The probe restarted. Its USB device may have changed, so choose the probe again.', 'プローブを再起動しました。USBの機器が変わることがあるため、もう一度プローブを選んでください。');
    state.connectReturn = '/probe/settings'; go('/connect');
  };
  return panel(el('h2', {}, t('Paths offered over USB', 'USBで出す接続経路')),
    p(t('The combination of OEP paths (bulk, HID, CDC) on the probe\'s own USB. Takes effect after a restart. The browser uses one of bulk (WebUSB), HID (WebHID) or CDC (Web Serial).', 'プローブ自身のUSBが出すOEPの経路（bulk・HID・CDC）の組み合わせです。再起動した後に効きます。ブラウザで使うのはbulk（WebUSB）・HID（WebHID）・CDC（Web Serial）のどれかです。'), 'muted'),
    keyValues([[t('Current setting', '今の設定'), now === undefined ? t('default', '既定') : show(now)]]),
    D.dev.changeable ? [field(t('Combination of paths', '経路の組み合わせ'), s.usb ?? (now === undefined ? '' : String(now)), (v) => { s.usb = v; }, t('Only the combinations the probe declares can be chosen.', '選べるのはプローブが宣言した組み合わせだけです。'), choices, 'text', { id: 'usb-transports' }),
      actions(action(t('Apply', '適用する'), () => (s.usb ? D.applySettings('core', { 'usb.transports': s.usb }) : D.applySettings('core', {}, ['usb.transports']))),
        D.restartOffered() ? action(t('Save and restart', '保存して再起動'), restart, 'primary', { id: 'save-restart' }) : null),
      D.restartOffered() ? null : note(t('This probe has no restart function. Save, then power it off and on.', 'このプローブは再起動の機能を持っていません。保存してから電源を入れ直してください。'), 'amber')] : null);
}


// -- P6: maintenance (page.ja.md §6.7) --
export function maintenance() {
  const m = state.maintenance;
  const status = firmwareState(D.dev.info.firmware, D.release.manifest?.version);
  const statusText = { current: t('Same as the released version.', '配布している版と同じです。'), update: t('A newer version is available.', '新しい版があります。'), newer: t('This probe is newer than the release. Writing would make it older.', 'このプローブは配布している版より新しい版です。書き込むと古くなります。'), unknown: t('Cannot tell which version is newer. Check both before writing.', '版の前後を判定できません。両方の版を確かめてから書き込みます。') }[status];
  const method = D.updateMethod();
  const progress = (done, total, text) => { m.progress = { done, total, text }; const b = /** @type {HTMLProgressElement} */ (document.getElementById('update-progress')); if (b) { b.max = total || 1; b.value = done; } const tk = document.getElementById('update-status'); if (tk) tk.textContent = text; };
  const readFile = (handler) => el('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { handler(JSON.parse(await f.text()), f.name); } catch (error) { m.restoreError = t(`The file cannot be read: ${D.errorText(error)}`, `読めないファイルです: ${D.errorText(error)}`); render(); }
  } });
  return [heading(t('Maintenance', '保守'), t('Update the firmware, back up and restore the settings and memo, and look into problems.', 'ファームの更新、設定とメモの控えと戻し、問題の切り分けをします。'), 'MAINTENANCE'),
    el('div', { class: 'two-grid' },
      panel(el('h2', {}, t('Firmware update', 'ファームウェアの更新')), keyValues([[t('Device', '機器'), `${D.dev.info.model} / ${D.unit()}`], [t('Installed', '導入済み'), D.dev.info.firmware ?? '—'], [t('Released version', '配布している版'), D.release.manifest?.version ?? (D.release.error ? t('cannot be loaded', '読み込めません') : t('loading', '読み込み中'))]]), p(statusText, 'muted'),
        method ? [p(method === 'app' ? t('Written over native USB (DFU). You choose the device to write once.', 'native USB（DFU）で書き込みます。書き込み先の機器を一度選びます。') : t('Switched to the boot ROM over USB and written. You choose the device to write once.', 'USBから boot ROM に切り替えて書き込みます。書き込み先の機器を一度選びます。'), 'muted'),
          note(t('Before updating, it is safest to take "Settings and memo backup" below. The connection closes during the update and reconnects to the same unit afterwards.', '更新の前に、下の「設定とメモの控え」を取っておくと安全です。更新中は接続を終了し、終わったら同じ個体に接続し直します。')),
          actions(action(t('Update this probe', 'このプローブを更新'), async () => {
            if (!confirm(t(`Writing OepProbe ${D.release.manifest?.version} to ${D.dev.info.model} / ${D.unit()}. The connection will close.`, `${D.dev.info.model} / ${D.unit()} へ OepProbe ${D.release.manifest?.version} を書き込みます。接続は終了します。`))) return false;
            const before = { unit: D.unit(), model: D.dev.info.model };
            m.updated = await D.updateFirmware(progress);
            m.afterUpdate = before;
          }, 'primary', { disabled: !D.release.manifest || status === 'current' && false })),
          el('progress', { id: 'update-progress', max: m.progress?.total || 1, value: m.progress?.done ?? 0 }), el('p', { id: 'update-status' }, m.progress?.text ?? '')]
          : note(t('This probe cannot be updated from this page (a classic ESP32 is rewritten with the same serial steps as installing; a CH32 is written with WCH\'s tools).', 'このプローブはこのページからの更新に対応していません（classic ESP32は導入と同じシリアルの手順で書き直します。CH32はWCHの道具で書きます）。')),
        actions(action(t('Fetch the released images again', '配布イメージを再取得'), D.loadRelease))),
      panel(el('h2', {}, t('Settings and memo backup', '設定とメモの控え')), p(t('Back up the settings (pin names, idle, pass-through and so on) and the memo records (part numbers, memos, tool records) to separate files. Secrets are not included.', '設定（ピン名・待機・素通しなど）と、メモ領域の記録（型番・メモ、道具の記録）を別々のファイルに控えます。秘密の値は含みません。'), 'muted'),
        actions(action(t('Back up settings', '設定を控える'), async () => download(`${D.unit()}.oep-settings.json`, JSON.stringify(await D.exportSettings(), null, 2) + '\n', 'application/json'), 'primary', { id: 'export-settings' }),
          action(t('Back up the memo', 'メモを控える'), async () => { const doc = await D.exportMemo(); if (!doc) throw new Error(t('This probe has no memo area.', 'このプローブにはメモ領域がありません。')); download(`${D.unit()}.oep-memo.json`, JSON.stringify(doc, null, 2) + '\n', 'application/json'); }, '', { disabled: !D.dev.memo, id: 'export-memo' })),
        el('h3', { class: 'mt' }, t('Restore from a backup', '控えから戻す')), p(t('Choosing a file shows the differences before anything is applied.', 'ファイルを選ぶと、適用する前に差分を表示します。'), 'muted'),
        el('label', { class: 'field' }, t('Settings or memo backup file', '設定またはメモの控えのファイル'), readFile(async (doc, name) => {
          m.restoreError = '';
          if (doc.objects) { m.memoPlan = await D.planMemoRestore(doc); m.memoFile = name; }
          else { m.plan = await D.planRestore(doc); m.planFile = name; }
          render();
        })),
        m.restoreError ? note(m.restoreError, 'error') : null,
        m.plan ? el('div', { class: 'panel' }, el('h3', {}, t(`Settings differences (${m.planFile})`, `設定の差分（${m.planFile}）`)), m.plan.otherProbe ? note(t('This backup is from another probe. Applying it puts that unit\'s settings into this one.', '別のプローブの控えです。適用すると、この個体に別の個体の設定が入ります。'), 'amber') : null,
          keyValues([[t('Values to apply', '適用する値'), String(m.plan.sets.length)], [t('Values to clear', '解除する値'), String(m.plan.unsets.length)], [t('Items this unit does not have', 'この個体に無い項目'), String(m.plan.unresolved?.length ?? 0)], [t('Secrets (not in the file)', '秘密の値（ファイルに無い）'), String(m.plan.secretWithoutValue?.length ?? 0)]]),
          actions(action(t('Apply these changes', 'この変更を適用'), async () => { await D.applyRestore(m.plan); m.plan = null; m.restored = t('Settings applied. Save them to keep them after a restart.', '設定を適用しました。再起動後も残すには保存します。'); }, 'primary'), button(t('Cancel', 'やめる'), () => { m.plan = null; render(); }))) : null,
        m.memoPlan ? el('div', { class: 'panel' }, el('h3', {}, t(`Memo differences (${m.memoFile})`, `メモの差分（${m.memoFile}）`)), m.memoPlan.otherProbe ? note(t('This backup is from another probe.', '別のプローブの控えです。'), 'amber') : null,
          m.memoPlan.todo.length ? keyValues(m.memoPlan.todo.map((tk) => [tk.name, t(`${tk.why} (${tk.data.length} B)`, `${tk.why}（${tk.data.length} B）`)])) : p(t('Nothing to restore.', '戻すものはありません。'), 'muted'),
          actions(action(t('Write these records back', 'この記録を書き戻す'), async () => { await D.applyMemoRestore(m.memoPlan); m.memoPlan = null; m.restored = t('The memo records were written back.', 'メモの記録を書き戻しました。'); }, 'primary', { disabled: !m.memoPlan.todo.length }), button(t('Cancel', 'やめる'), () => { m.memoPlan = null; render(); }))) : null,
        m.restored ? note(m.restored) : null,
        )),
    el('details', { class: 'panel mt' }, el('summary', {}, t('Diagnostics, declarations, storage', '診断・機能の宣言・保存領域')),
      p(t('What the probe declares and how its storage stands, to narrow down a problem or to send with a report.', '問題の切り分けや報告のために、プローブの宣言と保存の状態を出します。'), 'mt'),
      keyValues([[t('Connection path', '接続経路'), D.dev.host.link.transport.kind ?? '—'], [t('Unit ID', '個体ID'), D.unit()], [t('Functions', '機能の数'), String(D.dev.caps.offers.length)], [t('Storage state', '保存の状態'), D.dev.settingsState ? JSON.stringify(D.dev.settingsState) : '—']]),
      actions(action(t('Read the declarations again', '宣言を読み直す'), D.rereadDeclarations), button(t('Save the declarations as JSON', '宣言をJSONで保存'), () => download(`oep-${D.unit()}.json`, D.declarationsJson(), 'application/json'))),
      el('pre', { class: 'terminal' }, D.declarationsText()),
      D.dev.memo ? [el('h3', { class: 'mt' }, t('Memo area records', 'メモ領域の記録')), table([t('Name', '名前'), t('Size', '大きさ')], D.dev.memos.map((x) => [new TextDecoder().decode(x.name), `${x.size} B`])),
        p(t('A broken record never removes wiring labels. Write it back from a backup, or delete just that record.', '壊れた記録があっても、配線のラベルは消しません。控えから書き戻すか、その記録だけを消します。'), 'muted')] : null),
  ];
}

// -- P5: hand over to tools (page.ja.md §6.6), in the order of the uses --
export function tools() {
  const id = D.unit();
  const swdPorts = D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire === 'swd'));
  const ch32Ports = D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire !== 'swd'));
  const s = state.handoff ??= { port: '' };
  const swd = swdPorts.find((x) => x.name === s.port) ?? swdPorts[0];
  const board = s.board ?? 'rpipico';
  const broker = t(`python -m oep_client.ota_broker oep://${id}/${swd?.name ?? '<port>'}=${board} --gdb-port 3333`, `python -m oep_client.ota_broker oep://${id}/${swd?.name ?? '<口>'}=${board} --gdb-port 3333`);
  const debugJson = JSON.stringify([{ configId: `rp2040:rp2040:${board}`, servertype: 'external', gdbTarget: 'localhost:3333' }], null, 2);
  const passthroughs = D.currentPassthroughs();
  const section = (anchor, title, ...kids) => el('section', { class: 'panel mt', id: `tool-${anchor}` }, el('h2', {}, title), ...kids);
  return [heading(t('Hand over to tools', '道具へ渡す'), t('The work itself is done in these tools. Here are what each needs from this probe; when a tool opens the probe, end this page\'s connection at the bottom.', '作業そのものは次の道具で行います。それぞれがこのプローブについて要る情報を出します。道具がプローブを開くときは、下でこのページの接続を終えます。'), 'TOOLS'),
    section('debug', t('1. Debug and write a target', '1. ターゲットをデバッグ・書き込み'),
      el('h3', {}, t('CH32 (ArduinoCore-CH32RV)', 'CH32（ArduinoCore-CH32RV）')), p(t('The board definitions know OEP ports. Use this address as the IDE\'s port.', 'ボードの定義がOEPのポートを持ちます。IDEのポートにこのアドレスを使います。'), 'muted'),
      ...(ch32Ports.length ? ch32Ports.map((x) => copyLine(`oep://${id}/${x.name}`)) : [copyLine(t(`oep://${id}/<port>`, `oep://${id}/<口>`))]), external('ArduinoCore-CH32RV', 'https://github.com/ch32-riscv-ug/ArduinoCore-CH32RV'),
      el('h3', { class: 'mt' }, t('SWD (RP2040, Arduino IDE)', 'SWD（RP2040、Arduino IDE）')), p(t('With the broker running, the IDE\'s Upload and Debug use OEP\'s SWD. Put debug_custom.json in the sketch folder (match configId to the value the IDE writes in .theia/launch.json).', 'ブローカーを起動しておくと、IDEの「書き込み」と「デバッグ」がOEPのSWDを使います。スケッチのフォルダに debug_custom.json を置きます（configId はIDEが .theia/launch.json に書く値に合わせます）。'), 'muted'),
      swdPorts.length > 1 ? field(t('Port', '口'), s.port, (v) => { s.port = v; render(); }, '', swdPorts.map((x) => [x.name, x.name])) : null,
      field(t('Board name shown to the IDE', 'IDEに見せるボード名'), board, (v) => { s.board = v; render(); }, t('For example rpipico', '例: rpipico')),
      copyLine(broker), el('pre', { class: 'terminal' }, debugJson), external(t('Using SWD (oep-client-python docs/swd)', 'SWDの使い方（oep-client-python docs/swd）'), t('https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/swd.md', 'https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/swd.ja.md')),
      p(t('Other targets are debugged from Python. There is no hand-over for ESP32 or JTAG.', 'ほかのターゲットはPythonからデバッグします。ESP32とJTAGへの引継ぎはありません。'), 'muted mt')),
    section('logs', t('2. Read logs', '2. ログを読む'),
      passthroughs.length ? [p(t('The probe sends the target\'s log to these ports while no OEP session is open. Open the port in a serial monitor after ending this page\'s connection below.', 'OEPのセッションが無い間、プローブは相手のログを次のポートへ流します。下でこのページの接続を終えてから、シリアルモニタでそのポートを開きます。')),
        keyValues(passthroughs.map(([r, , txt]) => [r, txt]))]
        : p(t('No pass-through is set. Set one up in Probe settings to read the log in a serial monitor.', '素通しが設定されていません。シリアルモニタで読むには、本体設定で素通しを設定します。')),
      actions(link(t('Set up the pass-through', '素通しを設定する'), '/probe/settings')), p(t('To send to the target too, or to keep the log in a script, use Python (the addresses in 4).', '相手へ送ったり、スクリプトでログを扱ったりするなら、Python（4のアドレス）を使います。'), 'muted')),
    section('capture', t('3. Capture waveforms', '3. 波形を取る'),
      p(t('WireSkein captures from the probe (in Python) and analyses; its browser viewer shows captured .wireskein / .sr files. Opening files in the viewer needs no disconnecting here.', 'WireSkeinがプローブから取得（Python）して解析し、ブラウザのViewerが取得済みの .wireskein / .sr を表示します。Viewerでファイルを開くだけなら、ここの接続を終える必要はありません。')),
      copyLine(`wireskein capture --source oep:oep://${id}`),
      actions(external(t('Installing and using WireSkein', 'WireSkeinの導入・使い方'), 'https://github.com/Open-Embedded-Probe/wireskein'), external(t('Open the WireSkein viewer', 'WireSkein Viewerを開く'), 'https://open-embedded-probe.github.io/wireskein-web/'))),
    section('python', t('4. Sensors, signals, peers and automated tests (Python)', '4. センサ・信号・相手役・自動テスト（Python）'),
      p(t('oep-client-python points at this unit, and at each registered wiring, by its address.', 'oep-client-pythonは、この個体と登録した配線を、アドレスで指します。')),
      copyLine(`oep dump --port oep://${id}`), ...D.dev.ports.map((x) => copyLine(`oep://${id}/${x.name}`)),
      actions(external(t('Using Python and the CLI', 'Python・CLIの使い方'), DOCS[5][2]), external(t('Automated test steps', '自動テストの手順'), guide('use-cases')))),
    section('end', t('End this page\'s use', 'このページでの利用を終える'),
      p(t('A tool that opens the probe needs this page to let go of it: this releases the right to change and the connection. Reading the docs needs no ending.', 'プローブを開く道具のために、このページの変更権と接続を解放します。資料を読むだけなら終える必要はありません。')),
      action(t('End here and hand it over', 'このページでの利用を終了して渡す'), async () => { await D.handOver(); state.transferred = true; state.notice = t('This page\'s connection is ended. Other tools can connect now.', 'このページでの接続を終えました。ほかの道具から接続できます。'); go('/'); }, 'primary', { id: 'hand-over' }))];
}

// -- P1: overview (page.ja.md §6.2) --
export function overview() {
  const status = firmwareState(D.dev.info.firmware, D.release.manifest?.version);
  const fw = { update: t('A newer version is available.', '新しい版があります。'), current: t('The released version.', '配布している版です。'), newer: t('Newer than the release.', '配布している版より新しい版です。') }[status] ?? '';
  const next = [];
  if (!D.dev.ports.length) next.push([t('Register the wiring to your target', 'ターゲットへの配線を登録する'), t('Name the pins and keep the target\'s part number. No target needs to be connected.', 'ピンに名前を付け、相手の型番を残します。相手は未接続でかまいません。'), '/probe/wiring/new']);
  if (status === 'update') next.push([t('Update the firmware', 'ファームを更新する'), fw, '/probe/maintenance']);
  next.push([t('Hand the probe over to a tool', '道具へプローブを渡す'), t('Debug in the IDE, read logs in a serial monitor, capture with WireSkein, script with Python.', 'IDEでデバッグ、シリアルモニタでログ、WireSkeinで波形、Pythonでスクリプト。'), '/probe/tools']);
  const names = [...new Set(D.dev.caps.offers.map((o) => o.entry.name))];
  return [heading(t('Overview', '概要'), t('What this probe is and what to do next.', 'このプローブと、次にすること。'), 'OVERVIEW'),
    state.notice ? note(state.notice) : null,
    el('div', { class: 'two-grid' },
      panel(el('h2', {}, t('This probe', 'このプローブ')), keyValues([[t('Board', 'ボード'), boardSpec() ? tr(boardSpec().name) : D.dev.info.model], [t('Unit ID', '個体ID'), D.unit()],
        [t('Firmware', 'ファーム'), [D.dev.info.firmware ?? '—', fw ? ` · ${fw}` : '']], [t('Path', '経路'), D.dev.host.link.transport.kind ?? '—'], [t('Wiring registered', '登録した配線'), String(D.dev.ports.length)]])),
      panel(el('h2', {}, t('Next', '次にすること')), el('div', { class: 'stack' }, ...next.map(([title, desc, route]) => el('a', { class: 'setup-choice', href: `#${route}` }, el('div', {}, el('h3', {}, title), p(desc)), el('span', { class: 'arrow' }, '→')))))),
    el('details', { class: 'panel mt' }, el('summary', {}, t(`Functions this probe declares (${names.length})`, `このプローブが宣言する機能（${names.length}）`)), el('ul', { class: 'name-list' }, ...names.map((n) => el('li', {}, el('code', {}, n)))),
      p(t('The full declarations are under Maintenance.', '宣言の全文は「保守」にあります。'), 'muted'))];
}
