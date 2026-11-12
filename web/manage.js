// W05 probe settings, W06 update / backup / restore / diagnostics, W07 handing over to other tools.
import { el, p, badge, actions, link, external, note, panel, heading, field, checkbox, keyValues, table, terminal, copyLine, download } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { DOCS, guide } from './data.js';
import { t, tr } from './i18n.js';
import { connected, needConnection, groupsOf, wireById } from './common.js';
import { firmwareState } from './model.js';

const IDLE = () => [['', t('None (Hi-Z)', '指定なし（Hi-Z）')], ['hi-z', 'Hi-Z'], ['pull-up', 'pull-up'], ['pull-down', 'pull-down'], ['low', t('Output low', '出力 Low')], ['high', t('Output high', '出力 High')]];
const show = (v) => typeof v === 'object' && v !== null ? (v.secret ? t('secret (not read)', '秘密の値（読み出さない）') : JSON.stringify(v)) : String(v);

export function settings(query) {
  if (!connected()) return needConnection('/settings');
  const s = state.settingsDraft;
  const from = query.get('from');
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
  return [heading(t('Set up how the probe behaves.', 'プローブ本体の動作を整える。'), t('Apart from wiring names, set how it behaves when idle and after the next boot. Change only what you need.', '配線の名前とは別に、待機時や次回起動後の動作を設定します。必要な項目だけ変更してください。'), 'PROBE SETTINGS'),
    !D.dev.changeable ? note(t('This probe\'s settings cannot be changed (read only).', 'このプローブは設定を変更できません（読み取りのみ）。'), 'amber') : null,
    el('div', { class: 'save-bar' }, el('p', { id: 'settings-summary' }, D.dev.unsaved ? t('Applied, not yet stored (lost on restart)', '適用済み・永続保存はまだです（再起動すると消えます）') : t('Same as the stored values', '保存されている値と同じです')),
      actions(action(t('Save for the next boot', '次回起動用に保存'), D.saveSettings, 'primary', { id: 'save-settings', disabled: !D.dev.unsaved || !D.dev.saveable }), action(t('Read again', '読み直す'), D.refresh))),
    p(t('"Apply" takes effect at once. "Save" keeps all of the probe\'s current settings after the next boot.', '「適用」はその場で効きます。「保存」は本体の現在の設定全体を、次回起動後にも残します。'), 'compact muted'),
    panel(el('h2', {}, t('Log pass-through (the path at boot)', 'ログの素通し（起動時の経路）')), p(t('While no session is open, send the target\'s UART or debug-wire log to the probe\'s serial port.', 'セッションの無い間、相手のUART・デバッグ線のログをプローブのシリアルポートへ流します。')), link(t('Set up pass-through →', '素通しを設定する →'), '/passthrough', true)),
    panel(el('h2', {}, t('Idle states and pins kept off', '待機状態・使わせないピン')), p(t('The state of pins while no function uses them, and pins no function may use. Free pins change at once; pins in use change when released.', '機能が使っていない間のピンの状態と、どの機能にも使わせないピンです。空いているピンにはすぐ、使用中のピンには解放したときに効きます。'), 'muted'),
      hasIdle || hasDisable ? [el('details', { open: query.get('section') === 'pins' }, el('summary', {}, t(`Pins (${pinRows.length})`, `ピンの一覧（${pinRows.length} 本）`)), table([t('Pin', 'ピン'), t('Label', 'ラベル'), t('Idle', '待機'), t('Use', '使用')], pinRows)),
        actions(action(t('Apply the pin settings', 'ピンの設定を適用'), applyPins, 'primary', { id: 'apply-pins' }))] : note(t('This probe has no idle pin settings.', 'このプローブは、ピンの待機状態の設定を持っていません。'))),
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
    actions(link(t('To the fixed-fixture steps', '据え置き治具の手順へ'), '/fixture'), from === 'setup' ? link(t('Continue the setup', '初期設定の続きへ'), '/setup') : null)];
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
    state.connectReturn = '/settings'; go('/connect');
  };
  return panel(el('h2', {}, t('Paths offered over USB', 'USBで出す接続経路')),
    p(t('The combination of OEP paths (bulk, HID, CDC) on the probe\'s own USB. Takes effect after a restart. The browser uses one of bulk (WebUSB), HID (WebHID) or CDC (Web Serial).', 'プローブ自身のUSBが出すOEPの経路（bulk・HID・CDC）の組み合わせです。再起動した後に効きます。ブラウザで使うのはbulk（WebUSB）・HID（WebHID）・CDC（Web Serial）のどれかです。'), 'muted'),
    keyValues([[t('Current setting', '今の設定'), now === undefined ? t('default', '既定') : show(now)]]),
    D.dev.changeable ? [field(t('Combination of paths', '経路の組み合わせ'), s.usb ?? (now === undefined ? '' : String(now)), (v) => { s.usb = v; }, t('Only the combinations the probe declares can be chosen.', '選べるのはプローブが宣言した組み合わせだけです。'), choices, 'text', { id: 'usb-transports' }),
      actions(action(t('Apply', '適用する'), () => (s.usb ? D.applySettings('core', { 'usb.transports': s.usb }) : D.applySettings('core', {}, ['usb.transports']))),
        D.restartOffered() ? action(t('Save and restart', '保存して再起動'), restart, 'primary', { id: 'save-restart' }) : null),
      D.restartOffered() ? null : note(t('This probe has no restart function. Save, then power it off and on.', 'このプローブは再起動の機能を持っていません。保存してから電源を入れ直してください。'), 'amber')] : null);
}

export function maintenance(query) {
  if (!connected()) return needConnection('/maintenance');
  const m = state.maintenance;
  const from = query.get('from');
  const status = firmwareState(D.dev.info.firmware, D.release.manifest?.version);
  const statusText = { current: t('Same as the released version.', '配布している版と同じです。'), update: t('A newer version is available.', '新しい版があります。'), newer: t('This probe is newer than the release. Writing would make it older.', 'このプローブは配布している版より新しい版です。書き込むと古くなります。'), unknown: t('Cannot tell which version is newer. Check both before writing.', '版の前後を判定できません。両方の版を確かめてから書き込みます。') }[status];
  const method = D.updateMethod();
  const progress = (done, total, text) => { m.progress = { done, total, text }; const b = /** @type {HTMLProgressElement} */ (document.getElementById('update-progress')); if (b) { b.max = total || 1; b.value = done; } const tk = document.getElementById('update-status'); if (tk) tk.textContent = text; };
  const readFile = (handler) => el('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { handler(JSON.parse(await f.text()), f.name); } catch (error) { m.restoreError = t(`The file cannot be read: ${D.errorText(error)}`, `読めないファイルです: ${D.errorText(error)}`); render(); }
  } });
  return [heading(t('Update, restore, and checks when stuck.', '更新・復元と、困ったときの確認。'), t('Review the job before running it; afterwards you return to the same probe.', '作業内容を確認してから実行し、終わったら同じプローブの作業に戻ります。'), 'MAINTENANCE'),
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
        D.dev.unsaved ? actions(action(t('Save all current values in the probe', '本体の現在値全体を保存'), D.saveSettings)) : null)),
    el('details', { class: 'panel mt' }, el('summary', {}, t('Diagnostics, declarations, storage', '診断・機能の宣言・保存領域')),
      p(t('Not needed for ordinary wiring edits. Details for looking into the connection and functions to narrow down problems.', '通常の配線編集では開く必要はありません。接続状態や対応機能を調べ、問題を切り分けるための詳細です。'), 'mt'),
      keyValues([[t('Connection path', '接続経路'), D.dev.host.link.transport.kind ?? '—'], [t('Unit ID', '個体ID'), D.unit()], [t('Functions', '機能の数'), String(D.dev.caps.offers.length)], [t('Storage state', '保存の状態'), D.dev.settingsState ? JSON.stringify(D.dev.settingsState) : '—']]),
      actions(action(t('Read the declarations again', '宣言を読み直す'), D.rereadDeclarations), button(t('Save the declarations as JSON', '宣言をJSONで保存'), () => download(`oep-${D.unit()}.json`, D.declarationsJson(), 'application/json'))),
      el('pre', { class: 'terminal' }, D.declarationsText()),
      D.serialLink() ? [el('h3', {}, t('Serial speed test', 'シリアルの速度の検査')), p(t('On probes that negotiate speed, both directions are tested and a speed that passed is used. Other operations stop during the test.', '速度の交渉に対応するプローブで、両方向を検査して通った速度を使います。検査中は他の操作を止めます。'), 'muted'),
        field(t('Candidate baud rates (comma separated)', '候補のbaud（カンマ区切り）'), m.rates ?? '500000', (v) => { m.rates = v; }), action(t('Test the speed', '速度を検査'), async () => { m.speed = await D.speedTest((m.rates ?? '500000').split(',').map((x) => Number(x.trim()))); }), m.speed ? terminal(m.speed) : null] : null,
      D.dev.memo ? [el('h3', { class: 'mt' }, t('Memo area records', 'メモ領域の記録')), table([t('Name', '名前'), t('Size', '大きさ')], D.dev.memos.map((x) => [new TextDecoder().decode(x.name), `${x.size} B`])),
        p(t('A broken record never removes wiring labels. Write it back from a backup, or delete just that record.', '壊れた記録があっても、配線のラベルは消しません。控えから書き戻すか、その記録だけを消します。'), 'muted')] : null),
    actions(link(t('To the fixed-fixture steps', '据え置き治具の手順へ'), '/fixture'), link(from === 'setup' ? t('Continue the setup', '初期設定の続きへ') : t('Back to the work home', '作業ホームへ戻る'), from === 'setup' ? '/setup' : '/work'))];
}

export function handoff() {
  const id = connected() ? D.unit() : t('<unit ID>', '<個体ID>');
  const swdPorts = connected() ? D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire === 'swd')) : [];
  const ch32Ports = connected() ? D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire !== 'swd')) : [];
  const s = state.handoff ??= { port: '' };
  const swd = swdPorts.find((x) => x.name === s.port) ?? swdPorts[0];
  const board = s.board ?? 'rpipico';
  const broker = t(`python -m oep_client.ota_broker oep://${id}/${swd?.name ?? '<port>'}=${board} --gdb-port 3333`, `python -m oep_client.ota_broker oep://${id}/${swd?.name ?? '<口>'}=${board} --gdb-port 3333`);
  const debugJson = JSON.stringify([{ configId: `rp2040:rp2040:${board}`, servertype: 'external', gdbTarget: 'localhost:3333' }], null, 2);
  return [heading(t('Connect to the tool for the job.', '目的に合う道具へ、つなぐ。'), t('The probe and wiring prepared here also serve capture, development and automation.', 'このページで整えたプローブと配線を、観測や開発・自動化にも使えます。'), 'CONNECTED TOOLS'),
    state.captureSummary ? panel(el('h2', {}, t('The capture conditions prepared', '今回の取得条件の控え')), keyValues(state.captureSummary.slice(0, -1)), copyLine(state.captureSummary.at(-1)[1]), p(t('What to give WireSkein. The browser does not pass settings or the connection automatically.', 'WireSkeinで指定する内容です。ブラウザから設定や接続を自動で渡すものではありません。'))) : null,
    el('div', { class: 'two-grid' }, panel(badge(t('Viewing files / browser', 'ファイル表示 / ブラウザ')), el('h2', { class: 'mt' }, t('View captured waveforms in WireSkein', '取得した波形をWireSkeinで見る')), p(t('Show captured .wireskein / .sr files in the public viewer. Just opening files needs no disconnecting here.', '取得済みの .wireskein / .sr ファイルを、公開Viewerで表示します。ファイルを開くだけなら、このページの接続を終了する必要はありません。')), external(t('Open the WireSkein viewer', 'WireSkein Viewerを開く'), 'https://open-embedded-probe.github.io/wireskein-web/')),
      panel(badge(t('Capture and analysis / external setup', '取得・解析 / 外部環境')), el('h2', { class: 'mt' }, t('Capture waveforms from the probe', 'プローブから波形を取得する')), p(t('Capture and analysis use WireSkein in Python. The public viewer alone cannot capture from a device.', '取得と解析はPython側のWireSkeinを使います。公開Viewerだけで機器から取得することはできません。')), external(t('Installing and using WireSkein', 'WireSkeinの導入・使い方'), 'https://github.com/Open-Embedded-Probe/wireskein'))),
    el('section', { class: 'panel mt' }, el('h2', {}, t('Write and debug from the IDE', 'IDEから書く・デバッグする')),
      el('h3', {}, t('CH32 (ArduinoCore-CH32RV)', 'CH32（ArduinoCore-CH32RV）')), p(t('The board definitions know OEP ports. Use this address as the IDE\'s port.', 'ボードの定義がOEPのポートを持ちます。IDEのポートにこのアドレスを使います。'), 'muted'),
      ...(ch32Ports.length ? ch32Ports.map((x) => copyLine(`oep://${id}/${x.name}`)) : [copyLine(t(`oep://${id}/<port>`, `oep://${id}/<口>`))]), external('ArduinoCore-CH32RV', 'https://github.com/ch32-riscv-ug/ArduinoCore-CH32RV'),
      el('h3', { class: 'mt' }, t('SWD (RP2040, Arduino IDE)', 'SWD（RP2040、Arduino IDE）')), p(t('With the broker running, the IDE\'s Upload and Debug use OEP\'s SWD. Put debug_custom.json in the sketch folder (match configId to the value the IDE writes in .theia/launch.json).', 'ブローカーを起動しておくと、IDEの「書き込み」と「デバッグ」がOEPのSWDを使います。スケッチのフォルダに debug_custom.json を置きます（configId はIDEが .theia/launch.json に書く値に合わせます）。'), 'muted'),
      swdPorts.length > 1 ? field(t('Port', '口'), s.port, (v) => { s.port = v; render(); }, '', swdPorts.map((x) => [x.name, x.name])) : null,
      field(t('Board name shown to the IDE', 'IDEに見せるボード名'), board, (v) => { s.board = v; render(); }, t('For example rpipico', '例: rpipico')),
      copyLine(broker), el('pre', { class: 'terminal' }, debugJson), external(t('Using SWD (oep-client-python docs/swd)', 'SWDの使い方（oep-client-python docs/swd）'), t('https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/swd.md', 'https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/swd.ja.md')),
      p(t('There is no hand-over for ESP32 or JTAG yet.', 'ESP32とJTAGへの引継ぎは、まだありません。'), 'muted mt')),
    el('section', { class: 'panel mt' }, el('h2', {}, t('Use from Python, the CLI and automated tests', 'Python・CLI・自動テストから使う')), p(t('Point at the same unit by its address.', '同じ個体を、アドレスで指します。')),
      copyLine(`oep dump --port oep://${id}`), ...(connected() ? D.dev.ports.map((x) => copyLine(`oep://${id}/${x.name}`)) : []),
      actions(external(t('Using Python and the CLI', 'Python・CLIの使い方'), DOCS[5][2]), external(t('Automated test steps', '自動テストの手順'), guide('use-cases')))),
    el('section', { class: 'panel mt' }, el('h2', {}, t('Finish using this page', 'このページでの利用を終える')),
      p(t('When another tool uses the same probe, end this page\'s operations and connection to hand it over. Reading the docs needs no ending.', 'ほかの道具が同じプローブを使うときは、このページの操作と接続を終えて渡します。資料を読むだけなら終える必要はありません。')),
      connected() ? action(t('End here and hand it over', 'このページでの利用を終了して渡す'), async () => { const n = D.dev.active.size; await D.handOver(); state.transferred = true; state.notice = t(`Stopped ${n} operations and released the right to change and the connection.`, `操作 ${n} 件を止め、変更権と通信を解放しました。`); }, 'primary', { id: 'hand-over' }) : null,
      state.transferred ? note(t('This page\'s operations and connection are ended. Other tools can connect now.', 'このページでの操作と接続を終えました。ほかの道具から接続できます。')) : null)];
}
export { wireById };
