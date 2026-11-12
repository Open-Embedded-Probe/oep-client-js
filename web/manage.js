// W05 probe settings, W06 update / backup / restore / diagnostics, W07 handing over to other tools.
import { el, p, badge, actions, link, external, note, panel, heading, field, checkbox, keyValues, table, terminal, copyLine, download } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { DOCS, GUIDE_BASE } from './data.js';
import { connected, needConnection, groupsOf, wireById } from './common.js';
import { firmwareState } from './model.js';

const IDLE = [['', '指定なし（Hi-Z）'], ['hi-z', 'Hi-Z'], ['pull-up', 'pull-up'], ['pull-down', 'pull-down'], ['low', '出力 Low'], ['high', '出力 High']];
const show = (v) => typeof v === 'object' && v !== null ? (v.secret ? '秘密の値（読み出さない）' : JSON.stringify(v)) : String(v);

export function settings(query) {
  if (!connected()) return needConnection('/settings');
  const s = state.settingsDraft;
  const from = query.get('from');
  const hasIdle = !!D.itemOf('core', `channel.${D.channelList()[0]?.[1]}.idle`), hasDisable = !!D.itemOf('core', `channel.${D.channelList()[0]?.[1]}.disable`);
  const wifi = !!D.itemOf('core', 'wifi.0.ssid');
  s.pins ??= {};
  const pinRows = D.channelList().map(([ch, name]) => {
    const idle = D.currentValue('core', `channel.${name}.idle`) ?? '', dis = D.currentValue('core', `channel.${name}.disable`) === true;
    const d = s.pins[name] ??= { idle: String(idle), disable: dis };
    const label = D.dev.labels.find(([c]) => c === ch)?.[1] ?? '';
    return [name, label, hasIdle ? field(`${name} の待機`, d.idle, (v) => { d.idle = v; d.changed = true; }, '', IDLE, 'text', { 'data-idle': name }) : '—',
      hasDisable ? checkbox('使わせない', d.disable, (v) => { d.disable = v; d.changed = true; }, { 'data-disable': name }) : '—'];
  });
  const applyPins = async () => {
    const set = {}, unset = [];
    for (const [name, d] of Object.entries(s.pins)) {
      if (!d.changed) continue;
      if (hasIdle) { if (d.idle) set[`channel.${name}.idle`] = d.idle; else if (D.currentValue('core', `channel.${name}.idle`) !== undefined) unset.push(`channel.${name}.idle`); }
      if (hasDisable) { if (d.disable) set[`channel.${name}.disable`] = true; else if (D.currentValue('core', `channel.${name}.disable`) !== undefined) unset.push(`channel.${name}.disable`); }
    }
    if (!Object.keys(set).length && !unset.length) throw new Error('変更したピンがありません。');
    await D.applySettings('core', set, unset); s.pins = {};
  };
  return [heading('プローブ本体の動作を整える。', '配線の名前とは別に、待機時や次回起動後の動作を設定します。必要な項目だけ変更してください。', 'PROBE SETTINGS'),
    !D.dev.changeable ? note('このプローブは設定を変更できません（読み取りのみ）。', 'amber') : null,
    el('div', { class: 'save-bar' }, el('p', { id: 'settings-summary' }, D.dev.unsaved ? '適用済み・永続保存はまだです（再起動すると消えます）' : '保存されている値と同じです'),
      actions(action('次回起動用に保存', D.saveSettings, 'primary', { id: 'save-settings', disabled: !D.dev.unsaved || !D.dev.saveable }), action('読み直す', D.refresh))),
    p('「適用」はその場で効きます。「保存」は本体の現在の設定全体を、次回起動後にも残します。', 'compact muted'),
    panel(el('h2', {}, 'ログの素通し（起動時の経路）'), p('セッションの無い間、相手のUART・デバッグ線のログをプローブのシリアルポートへ流します。'), link('素通しを設定する →', '/passthrough', true)),
    panel(el('h2', {}, '待機状態・使わせないピン'), p('機能が使っていない間のピンの状態と、どの機能にも使わせないピンです。空いているピンにはすぐ、使用中のピンには解放したときに効きます。', 'muted'),
      hasIdle || hasDisable ? [el('details', { open: query.get('section') === 'pins' }, el('summary', {}, `ピンの一覧（${pinRows.length} 本）`), table(['ピン', 'ラベル', '待機', '使用'], pinRows)),
        actions(action('ピンの設定を適用', applyPins, 'primary', { id: 'apply-pins' }))] : note('このプローブは、ピンの待機状態の設定を持っていません。')),
    panel(el('h2', {}, 'ネットワーク'), wifi ? [p('Wi-Fiに対応したプローブを、ベンチのネットワークにつなぐ設定です。このページから直接TCPで接続できるわけではありません。', 'muted'),
      field('SSID', s.ssid ?? D.currentValue('core', 'wifi.0.ssid') ?? '', (v) => { s.ssid = v; }, '', null, 'text', { id: 'wifi-ssid' }),
      field('パスフレーズ', s.pass ?? '', (v) => { s.pass = v; }, '秘密の値は表示も控えのファイルへの書き出しもしません。空欄なら今の値のままです。', null, 'password', { id: 'wifi-pass' }),
      actions(action('ネットワーク設定を適用', async () => { const v = { 'wifi.0.ssid': s.ssid ?? '' }; if (s.pass) v['wifi.0.passphrase'] = s.pass; await D.applySettings('core', v); s.pass = ''; })),
      D.dev.network ? el('details', {}, el('summary', {}, 'ネットワークの状態'), terminal(JSON.stringify(D.dev.network, null, 2))) : null]
      : p('このプローブにはWi-Fiの設定がありません。導入の失敗ではありません。', 'muted')),
    usbPanel(s),
    el('details', { class: 'panel mt' }, el('summary', {}, 'すべての設定値（詳細）'),
      D.dev.settingsRows.length ? table(['分類', '項目', '値'], D.dev.settingsRows.map((r) => [r.category, r.name, D.itemOf(r.category, r.name)?.restart ? [show(r.value), ' ', badge('再起動で有効', 'amber')] : show(r.value)])) : p('明示的な設定値はありません。', 'muted'),
      D.dev.changeable ? el('div', { class: 'field-grid mt' }, field('分類', s.cat ?? 'core', (v) => { s.cat = v; }, '', [...(D.dev.catalog?.category.values() ?? [])].map((c) => [c, c])),
        field('項目（例: channel.GPIO5.idle）', s.flat ?? '', (v) => { s.flat = v; }), field('値', s.value ?? '', (v) => { s.value = v; })) : null,
      D.dev.changeable ? actions(action('この値を適用', () => D.applySettings(s.cat ?? 'core', { [s.flat]: s.value })), action('この項目を解除', () => D.applySettings(s.cat ?? 'core', {}, [s.flat]))) : null),
    actions(link('据え置き治具の手順へ', '/fixture'), from === 'setup' ? link('初期設定の続きへ', '/setup') : null)];
}

/** usb.transports (transports §3.1): the OEP transports the probe's own USB device offers, after a restart. */
function usbPanel(s) {
  const item = D.itemOf('core', 'usb.transports');
  if (!item) return null;
  const now = D.currentValue('core', 'usb.transports');
  const choices = [['', '既定（プローブの標準の組み合わせ）'], ...[...item.choices.values()].map((c) => [c, c])];
  const restart = async () => {
    await D.saveAndRestart();
    state.notice = 'プローブを再起動しました。USBの機器が変わることがあるため、もう一度プローブを選んでください。';
    state.connectReturn = '/settings'; go('/connect');
  };
  return panel(el('h2', {}, 'USBで出す接続経路'),
    p('プローブ自身のUSBが出すOEPの経路（bulk・HID・CDC）の組み合わせです。再起動した後に効きます。ブラウザで使うのはbulk（WebUSB）・HID（WebHID）・CDC（Web Serial）のどれかです。', 'muted'),
    keyValues([['今の設定', now === undefined ? '既定' : show(now)]]),
    D.dev.changeable ? [field('経路の組み合わせ', s.usb ?? (now === undefined ? '' : String(now)), (v) => { s.usb = v; }, '選べるのはプローブが宣言した組み合わせだけです。', choices, 'text', { id: 'usb-transports' }),
      actions(action('適用する', () => (s.usb ? D.applySettings('core', { 'usb.transports': s.usb }) : D.applySettings('core', {}, ['usb.transports']))),
        D.restartOffered() ? action('保存して再起動', restart, 'primary', { id: 'save-restart' }) : null),
      D.restartOffered() ? null : note('このプローブは再起動の機能を持っていません。保存してから電源を入れ直してください。', 'amber')] : null);
}

export function maintenance(query) {
  if (!connected()) return needConnection('/maintenance');
  const m = state.maintenance;
  const from = query.get('from');
  const status = firmwareState(D.dev.info.firmware, D.release.manifest?.version);
  const statusText = { current: '配布している版と同じです。', update: '新しい版があります。', newer: 'このプローブは配布している版より新しい版です。書き込むと古くなります。', unknown: '版の前後を判定できません。両方の版を確かめてから書き込みます。' }[status];
  const method = D.updateMethod();
  const progress = (done, total, text) => { m.progress = { done, total, text }; const b = /** @type {HTMLProgressElement} */ (document.getElementById('update-progress')); if (b) { b.max = total || 1; b.value = done; } const t = document.getElementById('update-status'); if (t) t.textContent = text; };
  const readFile = (handler) => el('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { handler(JSON.parse(await f.text()), f.name); } catch (error) { m.restoreError = `読めないファイルです: ${D.errorText(error)}`; render(); }
  } });
  return [heading('更新・復元と、困ったときの確認。', '作業内容を確認してから実行し、終わったら同じプローブの作業に戻ります。', 'MAINTENANCE'),
    el('div', { class: 'two-grid' },
      panel(el('h2', {}, 'ファームウェアの更新'), keyValues([['機器', `${D.dev.info.model} / ${D.unit()}`], ['導入済み', D.dev.info.firmware ?? '—'], ['配布している版', D.release.manifest?.version ?? (D.release.error ? '読み込めません' : '読み込み中')]]), p(statusText, 'muted'),
        method ? [p(method === 'app' ? 'native USB（DFU）で書き込みます。書き込み先の機器を一度選びます。' : 'USBから boot ROM に切り替えて書き込みます。書き込み先の機器を一度選びます。', 'muted'),
          note('更新の前に、下の「設定とメモの控え」を取っておくと安全です。更新中は接続を終了し、終わったら同じ個体に接続し直します。'),
          actions(action('このプローブを更新', async () => {
            if (!confirm(`${D.dev.info.model} / ${D.unit()} へ OepProbe ${D.release.manifest?.version} を書き込みます。接続は終了します。`)) return false;
            const before = { unit: D.unit(), model: D.dev.info.model };
            m.updated = await D.updateFirmware(progress);
            m.afterUpdate = before;
          }, 'primary', { disabled: !D.release.manifest || status === 'current' && false })),
          el('progress', { id: 'update-progress', max: m.progress?.total || 1, value: m.progress?.done ?? 0 }), el('p', { id: 'update-status' }, m.progress?.text ?? '')]
          : note('このプローブはこのページからの更新に対応していません（classic ESP32は導入と同じシリアルの手順で書き直します。CH32はWCHの道具で書きます）。'),
        actions(action('配布イメージを再取得', D.loadRelease))),
      panel(el('h2', {}, '設定とメモの控え'), p('設定（ピン名・待機・素通しなど）と、メモ領域の記録（型番・メモ、道具の記録）を別々のファイルに控えます。秘密の値は含みません。', 'muted'),
        actions(action('設定を控える', async () => download(`${D.unit()}.oep-settings.json`, JSON.stringify(await D.exportSettings(), null, 2) + '\n', 'application/json'), 'primary', { id: 'export-settings' }),
          action('メモを控える', async () => { const doc = await D.exportMemo(); if (!doc) throw new Error('このプローブにはメモ領域がありません。'); download(`${D.unit()}.oep-memo.json`, JSON.stringify(doc, null, 2) + '\n', 'application/json'); }, '', { disabled: !D.dev.memo, id: 'export-memo' })),
        el('h3', { class: 'mt' }, '控えから戻す'), p('ファイルを選ぶと、適用する前に差分を表示します。', 'muted'),
        el('label', { class: 'field' }, '設定またはメモの控えのファイル', readFile(async (doc, name) => {
          m.restoreError = '';
          if (doc.objects) { m.memoPlan = await D.planMemoRestore(doc); m.memoFile = name; }
          else { m.plan = await D.planRestore(doc); m.planFile = name; }
          render();
        })),
        m.restoreError ? note(m.restoreError, 'error') : null,
        m.plan ? el('div', { class: 'panel' }, el('h3', {}, `設定の差分（${m.planFile}）`), m.plan.otherProbe ? note('別のプローブの控えです。適用すると、この個体に別の個体の設定が入ります。', 'amber') : null,
          keyValues([['適用する値', String(m.plan.sets.length)], ['解除する値', String(m.plan.unsets.length)], ['この個体に無い項目', String(m.plan.unresolved?.length ?? 0)], ['秘密の値（ファイルに無い）', String(m.plan.secretWithoutValue?.length ?? 0)]]),
          actions(action('この変更を適用', async () => { await D.applyRestore(m.plan); m.plan = null; m.restored = '設定を適用しました。再起動後も残すには保存します。'; }, 'primary'), button('やめる', () => { m.plan = null; render(); }))) : null,
        m.memoPlan ? el('div', { class: 'panel' }, el('h3', {}, `メモの差分（${m.memoFile}）`), m.memoPlan.otherProbe ? note('別のプローブの控えです。', 'amber') : null,
          m.memoPlan.todo.length ? keyValues(m.memoPlan.todo.map((t) => [t.name, `${t.why}（${t.data.length} B）`])) : p('戻すものはありません。', 'muted'),
          actions(action('この記録を書き戻す', async () => { await D.applyMemoRestore(m.memoPlan); m.memoPlan = null; m.restored = 'メモの記録を書き戻しました。'; }, 'primary', { disabled: !m.memoPlan.todo.length }), button('やめる', () => { m.memoPlan = null; render(); }))) : null,
        m.restored ? note(m.restored) : null,
        D.dev.unsaved ? actions(action('本体の現在値全体を保存', D.saveSettings)) : null)),
    el('details', { class: 'panel mt' }, el('summary', {}, '診断・機能の宣言・保存領域'),
      p('通常の配線編集では開く必要はありません。接続状態や対応機能を調べ、問題を切り分けるための詳細です。', 'mt'),
      keyValues([['接続経路', D.dev.host.link.transport.kind ?? '—'], ['個体ID', D.unit()], ['機能の数', String(D.dev.caps.offers.length)], ['保存の状態', D.dev.settingsState ? JSON.stringify(D.dev.settingsState) : '—']]),
      actions(action('宣言を読み直す', D.rereadDeclarations), button('宣言をJSONで保存', () => download(`oep-${D.unit()}.json`, D.declarationsJson(), 'application/json'))),
      el('pre', { class: 'terminal' }, D.declarationsText()),
      D.serialLink() ? [el('h3', {}, 'シリアルの速度の検査'), p('速度の交渉に対応するプローブで、両方向を検査して通った速度を使います。検査中は他の操作を止めます。', 'muted'),
        field('候補のbaud（カンマ区切り）', m.rates ?? '500000', (v) => { m.rates = v; }), action('速度を検査', async () => { m.speed = await D.speedTest((m.rates ?? '500000').split(',').map((x) => Number(x.trim()))); }), m.speed ? terminal(m.speed) : null] : null,
      D.dev.memo ? [el('h3', { class: 'mt' }, 'メモ領域の記録'), table(['名前', '大きさ'], D.dev.memos.map((x) => [new TextDecoder().decode(x.name), `${x.size} B`])),
        p('壊れた記録があっても、配線のラベルは消しません。控えから書き戻すか、その記録だけを消します。', 'muted')] : null),
    actions(link('据え置き治具の手順へ', '/fixture'), link(from === 'setup' ? '初期設定の続きへ' : '作業ホームへ戻る', from === 'setup' ? '/setup' : '/work'))];
}

export function handoff() {
  const id = connected() ? D.unit() : '<個体ID>';
  const swdPorts = connected() ? D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire === 'swd')) : [];
  const ch32Ports = connected() ? D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire !== 'swd')) : [];
  const s = state.handoff ??= { port: '' };
  const swd = swdPorts.find((x) => x.name === s.port) ?? swdPorts[0];
  const board = s.board ?? 'rpipico';
  const broker = `python -m oep_client.ota_broker oep://${id}/${swd?.name ?? '<口>'}=${board} --gdb-port 3333`;
  const debugJson = JSON.stringify([{ configId: `rp2040:rp2040:${board}`, servertype: 'external', gdbTarget: 'localhost:3333' }], null, 2);
  return [heading('目的に合う道具へ、つなぐ。', 'このページで整えたプローブと配線を、観測や開発・自動化にも使えます。', 'CONNECTED TOOLS'),
    state.captureSummary ? panel(el('h2', {}, '今回の取得条件の控え'), keyValues(state.captureSummary.slice(0, -1)), copyLine(state.captureSummary.at(-1)[1]), p('WireSkeinで指定する内容です。ブラウザから設定や接続を自動で渡すものではありません。')) : null,
    el('div', { class: 'two-grid' }, panel(badge('ファイル表示 / ブラウザ'), el('h2', { class: 'mt' }, '取得した波形をWireSkeinで見る'), p('取得済みの .wireskein / .sr ファイルを、公開Viewerで表示します。ファイルを開くだけなら、このページの接続を終了する必要はありません。'), external('WireSkein Viewerを開く', 'https://open-embedded-probe.github.io/wireskein-web/')),
      panel(badge('取得・解析 / 外部環境'), el('h2', { class: 'mt' }, 'プローブから波形を取得する'), p('取得と解析はPython側のWireSkeinを使います。公開Viewerだけで機器から取得することはできません。'), external('WireSkeinの導入・使い方', 'https://github.com/Open-Embedded-Probe/wireskein'))),
    el('section', { class: 'panel mt' }, el('h2', {}, 'IDEから書く・デバッグする'),
      el('h3', {}, 'CH32（ArduinoCore-CH32RV）'), p('ボードの定義がOEPのポートを持ちます。IDEのポートにこのアドレスを使います。', 'muted'),
      ...(ch32Ports.length ? ch32Ports.map((x) => copyLine(`oep://${id}/${x.name}`)) : [copyLine(`oep://${id}/<口>`)]), external('ArduinoCore-CH32RV', 'https://github.com/ch32-riscv-ug/ArduinoCore-CH32RV'),
      el('h3', { class: 'mt' }, 'SWD（RP2040、Arduino IDE）'), p('ブローカーを起動しておくと、IDEの「書き込み」と「デバッグ」がOEPのSWDを使います。スケッチのフォルダに debug_custom.json を置きます（configId はIDEが .theia/launch.json に書く値に合わせます）。', 'muted'),
      swdPorts.length > 1 ? field('口', s.port, (v) => { s.port = v; render(); }, '', swdPorts.map((x) => [x.name, x.name])) : null,
      field('IDEに見せるボード名', board, (v) => { s.board = v; render(); }, '例: rpipico'),
      copyLine(broker), el('pre', { class: 'terminal' }, debugJson), external('SWDの使い方（oep-client-python docs/swd）', 'https://github.com/Open-Embedded-Probe/oep-client-python/blob/main/docs/swd.ja.md'),
      p('ESP32とJTAGへの引継ぎは、まだありません。', 'muted mt')),
    el('section', { class: 'panel mt' }, el('h2', {}, 'Python・CLI・自動テストから使う'), p('同じ個体を、アドレスで指します。'),
      copyLine(`oep dump --port oep://${id}`), ...(connected() ? D.dev.ports.map((x) => copyLine(`oep://${id}/${x.name}`)) : []),
      actions(external('Python・CLIの使い方', DOCS[5][2]), external('自動テストの手順', GUIDE_BASE + 'use-cases.ja.md'))),
    el('section', { class: 'panel mt' }, el('h2', {}, 'このページでの利用を終える'),
      p('ほかの道具が同じプローブを使うときは、このページの操作と接続を終えて渡します。資料を読むだけなら終える必要はありません。'),
      connected() ? action('このページでの利用を終了して渡す', async () => { const n = D.dev.active.size; await D.handOver(); state.transferred = true; state.notice = `操作 ${n} 件を止め、変更権と通信を解放しました。`; }, 'primary', { id: 'hand-over' }) : null,
      state.transferred ? note('このページでの操作と接続を終えました。ほかの道具から接続できます。') : null)];
}
export { wireById };
