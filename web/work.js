// Initial setup (I02), the workspace home (W01), the connections (W02) and their editor (W03).
// Saving writes labels and records only; it never scans, attaches, assigns pins or drives outputs (§6.3, A13).
import { el, p, badge, actions, link, external, note, panel, heading, field, checkbox, keyValues, textLink } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { LOG_PATHS, guide, SETUP_PATTERNS } from './data.js';
import { t, tr } from './i18n.js';
import { connected, needConnection, patternChoices, debugChoices, wireById, groupsOf, wiringSummary, GROUP_TITLE, taskById, PEER_TASKS, probeTitle, purposeRoute } from './common.js';

function frame(content) { return el('div', {}, ...content); }
const installDone = () => state.install?.phase === 'done';

// -- I02: what to set up first --
export function setup(view, query) {
  if (!connected()) return needConnection(`/setup${view ? '/' + view : ''}${query.toString() ? '?' + query : ''}`);
  if (view === 'ready') return ready(query);
  if (view === 'debug' || view === 'debug-scan') return debugSetup(view, query);
  if (view === 'logs') return frame([heading(t('How will you read the target\'s log?', '相手のログを、どの方法で見ますか。'), t('Choose by how the target logs and the tool you want to read it in.', '相手が出すログと、読みたい道具に合わせて選びます。'), 'SETUP / LOGS'),
    el('div', { class: 'stack' }, ...LOG_PATHS.map(([id, title, description]) => el('a', { class: 'pattern-card', 'data-log-path': id, href: id === 'passthrough' ? '#/passthrough' : id === 'console' ? '#/operate/console' : '#/operate/uart' }, el('strong', {}, title), el('span', {}, description)))),
    note(t('For now the main path is pass-through to an ordinary serial monitor (a probe setting). UART and debug-wire logs on this page also work, but are not yet checked on hardware.', '初期の範囲では、普通のシリアルモニタへの素通し（本体設定）が主な経路です。画面の中でのUART・デバッグ線のログ操作も使えますが、実機での確認はこれからです。')),
    actions(link(t('Name the UART wiring', 'UARTの配線に名前を付ける'), '/connection/new?purpose=uart&from=setup'), link(t('Back to the usage patterns', '利用パターンに戻る'), '/setup')), external(t('About logs and pass-through', 'ログ取得・素通しの説明'), guide('use-cases'))]);
  if (view === 'logic') return frame([heading(t('How will you capture waveforms?', 'どのように波形を取りますか。'), t('Capturing alone needs neither probe settings nor named wiring. Capture and analysis happen in WireSkein.', 'キャプチャだけなら、本体設定も配線名の登録も不要です。取得と解析はWireSkeinで行います。'), 'SETUP / CAPTURE'),
    el('div', { class: 'two-grid' }, ...[
      ['standalone', t('Capture once, choosing pins directly', '今回だけ、ピンを直接選んで取る'), t('Sort out signal names, pins and conditions and take them to WireSkein. Nothing is saved in the probe.', '信号名・ピン・取得条件を整理してWireSkeinへ。本体には何も保存しません。')],
      ['named', t('Observe registered wiring', '登録済みの配線を観測する'), t('Observe debug, UART and other wiring by its name. Logic capture drives nothing, so pins in use can be observed too.', 'デバッグやUARTなどの配線を、その名前で観測します。ロジック取得は出力せず、使用中のピンも観測できます。')],
      ['during', t('Capture during an operation', '操作の最中の波形を取る'), t('Run writing, reset or transfers and the capture in the same Python code.', '書き込み・リセット・通信とキャプチャを、同じPython処理で実行します。')],
      ['test', t('Check waveforms in automated tests', '波形を自動テストで照合する'), t('Keep the record, expectations and verdict with WireSkein and pytest.', 'WireSkeinとpytestで記録・期待値・合否を残します。')],
    ].map(([mode, title, description]) => el('a', { class: 'pattern-card', 'data-capture-mode': mode, href: `#/capture?mode=${mode}` }, el('strong', {}, title), el('span', {}, description)))),
    actions(link(t('Name the capture wiring', '観測用の配線に名前を付ける'), '/connection/new?purpose=custom&from=setup')), external(t('Choosing a capture method', 'キャプチャの使い分け'), guide('capture'))]);
  const group = { bus: ['i2c', 'spi'], signal: ['gpio', 'pwm', 'counter', 'dac', 'analog'], peer: ['i2c-target', 'spi-target'] }[view];
  if (group) {
    const pattern = SETUP_PATTERNS.find((tk) => tk.id === view);
    return frame([heading(pattern.title, t('Choose a method for your purpose to go on to its wiring and conditions. Opening the screen runs nothing.', '目的に合う方式を選ぶと、その配線と条件へ進みます。画面を開いただけでは動作しません。'), 'SETUP / USE CASE'),
      el('div', { class: 'two-grid' }, ...group.map((id) => { const tk = taskById(id); return el('a', { class: 'pattern-card', href: '#' + purposeRoute(id), 'data-task': id }, el('strong', {}, tk.title), el('span', {}, tk.description), el('span', { class: 'pattern-next' }, t(`${tk.short}: wiring and conditions →`, `${tk.short}の配線と条件へ →`))); })),
      actions(link(t('Name and register the wiring', '配線に名前を付けて登録する'), `/connection/new?purpose=${view === 'bus' ? 'i2c' : view === 'peer' ? 'i2c' : 'custom'}&from=setup`), link(t('Back to the usage patterns', '利用パターンに戻る'), '/setup'))]);
  }
  return frame([
    heading(installDone() ? t('OEP is installed.', 'OEPの導入が完了しました。') : t('What will you use this probe for?', 'このプローブを、何に使いますか。'), t('Choose a usage pattern first. Prepare the wiring and conditions for it, then go straight to work.', 'まず利用パターンを選びます。用途に合う配線と条件を整えて、そのまま作業へ進みます。'), 'READY TO CONFIGURE'),
    el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, 'OEP'), el('div', {}, el('strong', {}, t(`${probeTitle()} · boot checked`, `${probeTitle()} · 起動確認済み`)),
      p(t(`firmware ${D.dev.info.firmware ?? '—'} · ${D.dev.caps.offers.length} functions · ${D.dev.ports.length} wirings${D.dev.ports.length ? ' (set up; you can edit them)' : ''}`, `firmware ${D.dev.info.firmware ?? '—'} · 機能 ${D.dev.caps.offers.length} 個 · 配線 ${D.dev.ports.length} 件${D.dev.ports.length ? '（設定済み。編集できます）' : ''}`)))),
    state.notice ? note(state.notice) : null,
    el('h2', {}, t('How will you use it?', 'どのように使いますか？')), patternChoices(),
    panel(el('h2', {}, t('Use as a fixture or elsewhere', '治具・ほかの環境で使う')), actions(link(t('Steps for a fixed fixture', '据え置き治具の設定順を確認'), '/fixture'), link(t('To the IDE and automated tests', 'IDE・自動テストへ'), '/handoff'), link(t('Probe settings such as network', 'ネットワークなど本体設定'), '/settings?from=setup')), external(t('Use-case guides', '用途別ガイド'), guide('use-cases'))),
    p(t('A probe is not tied to one use. Add more later, and combine debug, UART and more on the same target.', '用途はひとつに固定されません。後から追加でき、同じ相手にデバッグとUARTなどを組み合わせられます。'), 'muted mt'),
    el('details', { class: 'panel mt' }, el('summary', {}, t('Probe settings, restore, or try without saving wiring', '本体設定・復元・配線を保存せず試す')), actions(link(t('Set up the probe', 'プローブ本体を設定する'), '/settings?from=setup'), link(t('Restore from a settings file', '設定ファイルから戻す'), '/maintenance?from=setup'), link(t('Try without saving wiring', '配線を保存せず試す'), '/operations'))),
    actions(link(t('Set up later, to the work home →', 'あとで設定する・作業ホームへ →'), '/work'))]);
}
function debugSetup(view, query) {
  const from = query.get('from') ?? 'setup';
  if (view === 'debug') return frame([heading(t('Decide the debug wiring.', 'デバッグの配線を決める。'), t('Search automatically, or name the pins you know. Whether to save is chosen after the wiring is decided.', '自動検索するか、分かっているピンを指定します。保存するかどうかは、配線を決めてから選べます。'), 'SETUP / DEBUG'),
    el('div', { class: 'two-grid' },
      el('a', { class: 'pattern-card', href: `#/setup/debug-scan?from=${from}`, 'data-debug-path': 'scan' }, el('strong', {}, t('Scan the target to search automatically', 'ターゲットをスキャンして自動検索')), p(t('When you do not know which signal is which. Connect the target, choose the method and the pins to search, and search.', '信号の役割が分からないとき。ターゲットをつなぎ、方式と探索するピンを選んで検索します。')), el('span', { class: 'pattern-next' }, t('Candidate pins → scan → check the wiring found →', '候補ピン → スキャン → 見つかった配線を確認 →'))),
      el('a', { class: 'pattern-card', href: `#/connection/new?purpose=debug&from=${from}`, 'data-debug-path': 'manual' }, el('strong', {}, t('Name the pins', 'ピンを明示的に指定')), p(t('When you know the wiring. Choose the method and each signal\'s pin, and check the connection if you like. You can save without a target connected.', '配線が分かっているとき。方式と信号ごとのピンを指定し、必要なら接続確認します。ターゲット未接続のまま保存もできます。')), el('span', { class: 'pattern-next' }, t('Method and pins → check, save →', '方式・ピン指定 → 確認・保存 →')))),
    note(t('To swap various boards on a fixed connector, also use "Name the pins" and register it as a "connector".', '決まったコネクタにいろいろなボードを付け替えて使う場合も、「ピンを明示的に指定」から「コネクタ」として登録します。')),
    actions(link(t('Back to the usage patterns', '利用パターンに戻る'), '/setup'))]);
  const s = state.debugScan ??= { wire: '', pins: [], result: null };
  const offer = s.wire ? D.wireOffer(s.wire) : null;
  const taken = new Map(D.dev.labels);
  const candidates = offer ? [...new Set([...D.roleChannels(offer)].filter(([r]) => r !== 3).flatMap(([, c]) => c))] : [];
  const need = s.wire === 'swio' ? 1 : 2;
  return frame([heading(t('Search for the target.', 'ターゲットを自動検索する。'), t('Decide the range to search, then start the scan yourself. Opening the screen searches nothing.', '探索する範囲を決めてから、明示的にスキャンを開始します。画面を開いただけでは検索しません。'), 'SETUP / DEBUG SCAN'),
    panel(el('h2', {}, t('01 / Target\'s debug method', '01 / 相手のデバッグ方式')), debugChoices((id) => { s.wire = id; s.pins = []; s.result = null; render(); }, s.wire),
      s.wire && !D.scanOffered(s.wire) ? note(t('This probe cannot search for this method. Name the pins and register them.', 'このプローブは、この方式の自動検索を持っていません。ピンを明示して登録してください。'), 'amber') : null),
    offer ? panel(el('h2', {}, t('02 / Probe pins to search', '02 / 探索するプローブ側のピン')), p(t('Choose only the pins connected to the target. Pins registered for other wiring cannot be chosen.', 'ターゲットにつないだピンだけを選びます。別の配線に登録済みのピンは選べません。')),
      el('div', { class: 'pin-grid' }, ...candidates.map((ch) => el('label', { class: taken.has(ch) ? 'taken' : '' }, el('input', { type: 'checkbox', 'data-scan-pin': ch, checked: s.pins.includes(ch), disabled: taken.has(ch), onchange: (e) => { s.pins = e.target.checked ? [...s.pins, ch] : s.pins.filter((x) => x !== ch); s.result = null; } }), D.pinName(ch), taken.has(ch) ? el('small', {}, taken.get(ch)) : null))),
      p(t('The scan drives the chosen pins. Connect the target and check GND and the voltage before starting.', 'スキャンは選んだピンへ信号を出します。相手を接続し、GND・電圧を確認してから開始します。'), 'mt'),
      action(t('Scan the chosen pins', '選択したピンをスキャン'), async () => { if (s.pins.length < need) throw new Error(t('Choose the pins connected to the target.', 'ターゲットにつないだピンを選んでください。')); s.result = await D.scanDebug(s.wire, s.pins); }, 'primary', { disabled: !D.scanOffered(s.wire), id: 'start-scan' })) : null,
    s.result ? panel(el('h2', {}, t(`Wiring found (${s.result.tried} combinations tried)`, `見つかった配線候補（${s.result.tried} 組を試行）`)), s.result.found.length ? el('div', { class: 'stack' }, ...s.result.found.map((f) => el('div', { class: 'connection-card' },
      keyValues([[s.wire === 'swio' ? 'SWIO' : 'SWDIO', D.pinName(f.dio)], ...(f.clk !== '' ? [['SWCLK', D.pinName(f.clk)]] : []), [t('answer', '応答'), f.id]]),
      button(t('Check and save this wiring →', 'この配線を確認・保存へ →'), () => { state.scanSelection = { wire: s.wire, ...f }; go(`/connection/new?purpose=debug&source=scan&from=${from}`); }, 'primary')))) : note(t('No answer. Check the connection, power, method and candidate pins, and search again. You can also name the wiring you know and save it.', '応答がありません。接続・電源・方式・候補ピンを見直して再検索できます。分かっている配線を直接指定して保存することもできます。'), 'amber'),
      p(t('The result does not fix a part number or save anything by itself.', '結果から型番を確定したり、自動保存したりはしません。'), 'muted')) : null,
    actions(link(t('Name the pins', 'ピンを明示的に指定する'), `/connection/new?purpose=debug&from=${from}`), link(t('Back to deciding the wiring', '配線の決め方に戻る'), '/setup/debug'))]);
}
function ready(query) {
  const port = D.portOf(query.get('port') ?? '');
  if (!port) return frame([heading(t('The saved wiring was not found.', '保存した配線が見つかりません。'), t('Read the list again.', '一覧を読み直してください。')), link(t('To wiring and targets', '配線・接続先へ'), '/connections', true)]);
  const purpose = query.get('purpose') || '';
  const g = groupsOf(port), first = g[0];
  const op = purpose === 'custom' ? '/capture?mode=named&port=' + port.name : purpose ? purposeRoute(purpose) + `?port=${port.name}` : first?.type === 'debug' ? `/operate/debug?port=${port.name}` : first?.type === 'uart' ? `/operate/uart?port=${port.name}` : first?.type === 'i2c' ? `/operate/i2c?port=${port.name}` : first?.type === 'spi' ? `/operate/spi?port=${port.name}` : '/operations';
  return frame([heading(t('Set up for your purpose.', '用途に合わせた設定ができました。'), t('All this can be set without a target. Saving never starts a connection or an output.', 'ターゲットが未接続でも、ここまで設定できます。保存によって接続・出力が始まることはありません。'), 'READY TO USE'),
    state.notice ? note(state.notice) : null, panel(el('h2', {}, port.name), p(D.isConnector(port.name) ? t('Connector (targets are swapped)', 'コネクタ（相手を差し替える）') : D.recordOf(port.name).part || t('Target part number not given', '相手の型番は未記入')), wiringSummary(port)),
    actions(link(t('Prepare an operation with this wiring →', 'この配線で操作の準備へ →'), op, true), link(t('Edit the wiring', '配線を編集する'), `/connection/${port.name}`), link(t('Set up another usage pattern', '別の利用パターンも設定する'), '/setup')), textLink(t('Later, to the work home', 'あとで使う・作業ホームへ'), '/work')]);
}
export function fixture() {
  if (!connected()) return needConnection('/fixture');
  return frame([heading(t('Make the probe a fixed fixture.', 'プローブを据え置きの治具にする。'), t('Probe settings for using the same wiring and idle states every time. They can be prepared without a target.', '毎回同じ配線・待機状態で使うための本体設定です。ターゲットが未接続でも準備できます。'), 'FIXTURE'),
    el('div', { class: 'stack' }, ...[
      ['1', t('Decide the pins to keep off', '触らせないピンを決める'), t('Name the pins nothing may use, such as LEDs, buttons and boot pins.', 'LED・ボタン・起動用の端子など、使わせないピンを指定します。'), '/settings?section=pins'],
      ['2', t('Name the wiring', '配線に名前を付ける'), t('Give each target a connection name. Registering known fixed wiring makes scanning unnecessary.', '相手ごとに接続名を付けます。分かっている固定配線を登録すれば、スキャンは不要です。'), '/connections'],
      ['3', t('Decide the idle pin states', '空き時間のピン状態を決める'), t('Decide the idle state of BOOT0, reset, chip selects and so on.', 'BOOT0、リセット、チップセレクトなどの待機状態を決めます。'), '/settings?section=pins'],
      ['4', t('Pass the log through if needed', '必要ならログを素通しする'), t('Send the log to an ordinary serial monitor while no session is open.', 'セッションがない間だけ、普通のシリアルモニタへログを流します。'), '/passthrough'],
      ['5', t('Save and back up', '保存して控えを取る'), t('Save all current values in the probe and back up the settings and memo to a file. Secrets are not included.', '本体の現在値全体を保存し、設定とメモの控えをファイルに取ります。秘密値は控えに含めません。'), '/maintenance?from=fixture'],
    ].map(([num, title, desc, route]) => el('a', { class: 'setup-choice', href: '#' + route }, el('span', { class: 'number' }, num), el('div', {}, el('h3', {}, title), p(desc)), el('span', { class: 'arrow' }, '→')))),
    note(t('Opening a screen applies nothing. Applying takes effect at once; saving keeps it after a restart.', '画面を開いただけでは設定を適用しません。適用するとその場で効き、保存すると再起動後も残ります。')), external(t('Steps for a fixed fixture', '治具として据え置く手順'), guide('use-cases'))]);
}

// -- W01 / W02 --
export function work() {
  if (!connected()) return needConnection('/work');
  return frame([heading(t('What will you do with this probe?', 'このプローブで、何をしますか。'), t('Continue from saved wiring, or try by choosing pins on the spot.', '保存した配線から続けることも、その場でピンを指定して試すこともできます。')),
    state.notice ? note(state.notice) : null,
    el('section', { class: 'form-group' }, el('div', { class: 'mini-heading' }, el('h2', {}, t('Wiring and targets', '配線・接続先')), el('a', { href: '#/connections', class: 'text-link' }, t('List, edit →', '一覧・編集 →'))),
      D.dev.ports.length ? el('div', { class: 'stack' }, ...D.dev.ports.map(portCard)) : emptyConnections()),
    el('section', {}, el('div', { class: 'mini-heading' }, el('h2', {}, t('Choose an operation by purpose', '目的から操作を選ぶ')), el('a', { href: '#/operations', class: 'text-link' }, t('See all →', 'すべて見る →'))), patternChoices('operations')),
    actions(link(t('Open the setup guide', '初期設定の案内を開く'), '/setup'), link(t('To external tools', '外部ツールへ'), '/handoff'))]);
}
function emptyConnections() {
  return el('div', { class: 'empty' }, el('h3', {}, t('No wiring is registered yet.', 'まだ配線を登録していません。')), p(t('You can save the target\'s part number and which signal goes to which pin. No target needs to be connected.', '相手の型番や、どの信号をどのピンにつなぐかを保存できます。ターゲットは未接続でかまいません。'), 'muted'),
    actions(link(t('Register wiring →', '配線を登録する →'), '/connection/new', true), link(t('Operate without registering', '登録せずに操作する'), '/operations')));
}
function portCard(port) {
  const rec = D.recordOf(port.name), groups = groupsOf(port), connector = D.isConnector(port.name);
  const use = { debug: 'debug', uart: 'uart', i2c: 'i2c', spi: 'spi' };
  return el('article', { class: 'connection-card', 'data-port': port.name },
    el('header', {}, el('div', {}, el('h2', {}, port.name), p(connector ? t('Connector (the target is identified each time)', 'コネクタ（相手はつなぐたびに識別）') : rec.part || t('Target part number not given', '相手の型番は未記入'), 'muted mb0')),
      badge(D.dev.memo ? t('saved in the probe', 'プローブに保存') : t('part number and memo in this browser only', '型番・メモはこのブラウザだけ'), D.dev.memo ? '' : 'amber')),
    wiringSummary(port), rec.note ? p(rec.note, 'compact muted') : null, el('code', {}, `oep://${D.unit()}/${port.name}`),
    actions(link(t('Edit wiring and target', '配線・相手の情報を編集'), `/connection/${encodeURIComponent(port.name)}`, true),
      ...groups.filter((g) => use[g.type]).map((g) => link(t(`Use for ${g.type === 'debug' ? (wireById(g.wire)?.short ?? 'debug') : GROUP_TITLE[g.type]} →`, `${g.type === 'debug' ? (wireById(g.wire)?.short ?? 'デバッグ') : GROUP_TITLE[g.type]}で使う →`), `/operate/${use[g.type]}?port=${encodeURIComponent(port.name)}`)),
      action(t('Delete…', '削除…'), async () => { if (!confirm(t(`Delete the connection name, wiring (pin names), part number and memo of ${port.name}.`, `${port.name}の接続名・配線（ピン名）・型番・メモを削除します。`))) return false; await D.deleteConnection(port); state.notice = t(`${port.name} was deleted.`, `${port.name}を削除しました。`); }, 'danger', { disabled: !D.dev.changeable })));
}
export function connections() {
  if (!connected()) return needConnection('/connections');
  return frame([heading(t('Record wiring and what it connects to.', '配線と、つなぐ相手を記録する。'), t('Register fixed wiring to reuse for the same work. You can edit and save it without the target connected.', '固定の配線を登録して、同じ作業に繰り返し使えます。相手が未接続でも編集・保存できます。')),
    state.notice ? note(state.notice) : null, !D.dev.changeable ? note(t('This probe\'s settings cannot be changed, so wiring cannot be registered (read only).', 'このプローブは設定を変更できないため、配線を登録できません（読み取りのみ）。'), 'amber') : null,
    D.dev.unsaved ? note(t('Some settings are applied but not saved. To keep them after a restart, save them in "Probe settings".', '適用済みで永続保存していない設定があります。再起動後も残すには「本体設定」で保存します。'), 'amber') : null,
    D.dev.ports.length ? [actions(link(t('Register new wiring', '新しい配線を登録'), '/connection/new', true), action(t('Read again', '読み直す'), D.refresh)), el('div', { class: 'stack mt' }, ...D.dev.ports.map(portCard))] : emptyConnections()]);
}

// -- W03: the editor --
const LINES = { debug: { rvswd: ['swdio', 'swclk', 'nrst'], swd: ['swdio', 'swclk', 'nrst'], swio: ['swio', 'nrst'] }, uart: ['rx', 'tx'], i2c: ['sda', 'scl'], spi: ['sck', 'mosi', 'miso', 'cs'] };
const OPTIONAL = new Set(['nrst', 'tx', 'miso', 'cs']);
const LINE_TITLE = () => ({ rx: t('RX (probe RX ← target TX)', 'RX（プローブRX ← 相手TX）'), tx: t('TX (probe TX → target RX, optional)', 'TX（プローブTX → 相手RX、任意）'), nrst: t('NRST (optional)', 'NRST（任意）'), swdio: 'SWDIO', swclk: 'SWCLK', swio: t('SWIO (1-wire DIO)', 'SWIO（1線DIO）'), sda: 'SDA', scl: 'SCL', sck: 'SCK', mosi: 'MOSI', miso: t('MISO (optional)', 'MISO（任意）'), cs: t('CS (optional)', 'CS（任意）') });
const OFFER_OF = { uart: 'oep.fixture.uart', i2c: 'oep.fixture.i2c-controller', spi: 'oep.fixture.spi-controller' };
function linesOf(g) { return g.type === 'debug' ? (LINES.debug[g.wire] ?? []) : g.type === 'custom' ? Object.keys(g.pins) : LINES[g.type]; }
/** The channels a line may use: the declared candidates of the matching function (any instance), else every channel. */
function candidatesFor(g, line) {
  const name = g.type === 'debug' ? D.WIRES[g.wire] : OFFER_OF[g.type];
  const offers = name ? D.offered(name) : [];
  const set = new Set();
  for (const o of offers) for (const [role, chs] of D.roleChannels(o)) if (D.roleLine(o.entry.name, role) === line) chs.forEach((c) => set.add(c));
  const all = D.channelList();
  return set.size ? all.filter(([ch]) => set.has(ch)) : all;
}
function newGroup(type, wire = '') { return { type, wire, pins: type === 'custom' ? { signal1: '' } : {}, target: {} }; }
function draftFrom(port) {
  const groups = groupsOf(port).map((g) => ({ ...g, pins: Object.fromEntries(Object.entries(g.pins).map(([k, v]) => [k, String(v)])), target: {} }));
  for (const [, label] of port.lines) { const pl = /** @type {any} */ (label).split('@'); if (pl[1]) { const line = pl[0].split('.')[1]?.toLowerCase(); for (const g of groups) if (line in g.pins) g.target[line] = pl[1]; } }
  const rec = D.recordOf(port.name);
  return { editId: port.name, name: port.name, part: rec.part ?? '', note: rec.note ?? '', connector: D.isConnector(port.name), groups, purpose: groups[0]?.type ?? '', original: { name: port.name, lines: port.lines.map(([c, l]) => [c, l]) }, check: {} };
}
export function editor(id, query) {
  if (!connected()) return needConnection(`/connection/${id}${query.toString() ? '?' + query : ''}`);
  const purpose = query.get('purpose');
  const from = query.get('from');
  if (id === 'new' && !purpose && !state.draft) return frame([heading(t('What is the wiring for?', 'どの用途の配線を登録しますか。'), t('Start from the kind of signal. You can add other signals to the same target later. No target needs to be connected.', '信号の種類から始めます。あとで別の信号も同じ接続先に追加できます。ターゲットは未接続でかまいません。')),
    el('div', { class: 'two-grid' }, ...[['debug', t('Debug (SWD / RVSWD / 1-wire DIO)', 'デバッグ（SWD / RVSWD / 1線DIO）'), t('The target\'s debug pins. Swapping targets on a fixed connector also starts here.', '相手のデバッグ端子。決まったコネクタで相手を差し替える使い方もここから。')], ['uart', 'UART', t('Lines to read the target\'s log and send commands.', '相手のログを読む・コマンドを送る線。')], ['i2c', 'I2C', t('Lines to sensors and peripherals, or for answering as a stand-in.', 'センサや周辺IC、または代役で応答する線。')], ['spi', 'SPI', t('Lines to SPI devices, or for answering as a stand-in.', 'SPIの機器、または代役で応答する線。')], ['custom', t('Other signals', 'そのほかの信号'), t('GPIO control lines, signals to observe and so on. You name them.', 'GPIOの制御線、観測したい信号など。名前を自分で付けます。')]].map(([tk, title, d]) =>
      el('a', { class: 'pattern-card', href: `#/connection/new?purpose=${tk}${from ? '&from=' + from : ''}`, 'data-new-purpose': tk }, el('strong', {}, title), el('span', {}, d)))),
    actions(link(t('Back to the wiring list', '配線の一覧に戻る'), '/connections'))]);
  if (!state.draft || state.draft.editId !== id) {
    const port = id === 'new' ? null : D.portOf(id);
    if (id !== 'new' && !port) return frame([heading(t('This wiring was not found.', 'この配線は見つかりません。'), t('It may have been renamed or deleted.', '名前の変更か削除が行われた可能性があります。')), link(t('To the wiring list', '配線の一覧へ'), '/connections', true)]);
    state.returnTo = from === 'setup' ? '/setup' : from?.startsWith('operate-') ? `/operate/${from.slice(8)}` : from === 'capture' ? '/capture?mode=named' : '/connections';
    state.draft = port ? draftFrom(port) : { editId: 'new', name: '', part: '', note: '', connector: false, purpose, groups: [newGroup(purpose === 'debug' ? 'debug' : purpose, '')], original: null, check: {} };
    state.dirty = false;
    const sel = state.scanSelection;
    if (id === 'new' && purpose === 'debug' && query.get('source') === 'scan' && sel) {
      const g = state.draft.groups[0]; g.wire = sel.wire;
      g.pins = sel.wire === 'swio' ? { swio: String(sel.dio) } : { swdio: String(sel.dio), swclk: String(sel.clk) };
      state.scanSelection = null; state.dirty = true;
    }
  }
  const d = state.draft;
  const touch = () => { state.dirty = true; d.check = {}; };
  const kindPanel = el('fieldset', { class: 'form-group' }, el('legend', {}, t('Kind of registration', '登録の種類')),
    el('div', { class: 'two-grid' }, ...[[false, t('Fixed target', '相手が決まっている'), t('Fixed with its wiring. Records the target\'s part number and memo.', '配線ごと固定。相手の型番とメモを記録します。')], [true, t('Connector (targets are swapped)', 'コネクタ（相手を差し替える）'), t('Fixed pins; whatever is connected is identified and shown each time. No part number is recorded.', 'ピンを固定し、つなぐ相手はその都度識別して表示します。相手の型番は記録しません。')]].map(([v, tk, desc]) =>
      el('button', { type: 'button', class: `pattern-card${d.connector === v ? ' selected' : ''}`, 'aria-pressed': String(d.connector === v), 'data-kind': v ? 'connector' : 'fixed', onclick: () => { d.connector = v; touch(); render(); } }, el('strong', {}, tk), el('span', {}, desc)))),
    d.original && d.connector !== D.isConnector(d.original.name) ? note(t('Changing the kind changes how the part number is kept (a connector records none).', '種類を変えると、相手の型番の扱いが変わります（コネクタでは型番を記録しません）。')) : null);
  const targetFields = el('fieldset', { class: 'form-group' }, el('legend', {}, t('Name and target', '名前・相手の情報')),
    el('div', { class: 'field-grid' }, field(t('Connection name', '接続名'), d.name, (v) => { d.name = v; touch(); }, t('For example sensor / board-1. Up to 16 letters, digits and hyphens, starting with a letter. Also used in the address oep://<unit>/<name>.', '例: sensor / board-1。英字で始まる16文字以内の英数字・ハイフン。アドレス oep://<個体>/<接続名> にも使います。'), null, 'text', { id: 'conn-name' }),
      !d.connector ? field(t('Target chip or board part number (optional)', '相手のIC・基板の型番（任意）'), d.part, (v) => { d.part = v; touch(); }, t('For example CH32V003F4P6, STM32F103C8T6. Not the probe\'s own part number, nor a connection check result.', '例: CH32V003F4P6、STM32F103C8T6。プローブ自身の型番ではありません。接続確認の結果でもありません。'), null, 'text', { id: 'conn-part' }) : null),
    el('div', { class: 'mt' }, field(t('Use and wiring memo (optional)', '用途・配線メモ（任意）'), d.note, (v) => { d.note = v; touch(); }, t('Connector number, voltage, use and so on. Writing a voltage changes no setting.', 'コネクタ番号、電圧、用途など。電圧を書いても設定は変わりません。'), null, 'textarea', { id: 'conn-note' })),
    d.original && d.name && d.name.toLowerCase() !== d.original.name.toLowerCase() ? note(t(`Renaming changes the address to oep://${D.unit()}/${d.name}, and the part number and memo move to the new name.`, `名前を変えると、アドレスが oep://${D.unit()}/${d.name} に変わり、型番・メモも新しい名前へ移します。`)) : null,
    !D.dev.memo ? note(t('This probe has no memo area, so the part number and memo are saved in this browser only (other PCs do not get them). The wiring is saved in the probe.', 'このプローブにはメモ領域がないため、型番・メモはこのブラウザだけに保存します（他のPCには渡りません）。配線はプローブに保存します。'), 'amber') : null);
  const wiring = el('fieldset', { class: 'form-group' }, el('legend', {}, t('Signals and probe pins', '信号とプローブ側のピン')), p(t('Several kinds, such as debug and UART, can be registered together. The choices come from this probe\'s declarations.', 'デバッグとUARTなど、複数の種類を一緒に登録できます。候補はこのプローブの宣言から出しています。'), 'muted'),
    ...d.groups.map((g, i) => groupEditor(g, i, d, touch)),
    el('div', { class: 'mt' }, el('h3', {}, t('Add another signal', '別の信号も追加する')), el('div', { class: 'choice-row' }, ...['debug', 'uart', 'i2c', 'spi', 'custom'].map((tk) => button(t(`+ ${GROUP_TITLE[tk]}`, `＋ ${GROUP_TITLE[tk]}`), () => { d.groups.push(newGroup(tk)); touch(); render(); }, '', { disabled: tk !== 'custom' && d.groups.some((g) => g.type === tk), 'data-add-group': tk })))));
  return frame([heading(id === 'new' ? t('What goes to which pin?', '何を、どのピンにつなぎますか。') : t(`Edit the wiring of ${d.original?.name}`, `${d.original?.name}の配線を編集`), t('Set the target and its wiring in one place. Saving starts no connection or output.', '相手の情報と配線を、ひとつの場所で設定します。保存しても接続・出力は始まりません。'), 'CONNECTION'),
    el('form', { id: 'connection-form', onsubmit: (e) => { e.preventDefault(); } }, kindPanel, wiring, targetFields,
      el('div', { id: 'form-error', class: 'form-error', role: 'alert' }),
      el('div', { class: 'save-bar' }, p(D.dev.saveable ? t('Saving applies the pin names to the probe and stores them, and records the part number and memo. Other unsaved changes in the probe are saved too.', '保存は、ピン名をプローブへ適用して永続保存し、型番・メモを記録します。本体の他の未保存の変更もまとめて保存されます。') : t('This probe cannot store settings. Saving becomes "Apply for now".', 'このプローブは永続保存できません。保存は「今回だけ適用」になります。')),
        actions(button(t('Cancel', 'キャンセル'), () => { state.dirty = false; state.draft = null; go(state.returnTo); }), action(D.dev.saveable ? (id === 'new' ? t('Save the wiring', '配線を保存') : t('Save changes', '変更を保存')) : t('Apply for now', '今回だけ適用'), () => saveDraft(id), 'primary', { id: 'save-connection', disabled: !D.dev.changeable })))),
    el('details', { class: 'panel mt' }, el('summary', {}, t('If you do not know the debug wiring', 'デバッグ配線が分からない場合')), p(t('Connect the target and scan candidate pins for the wiring.', 'ターゲットをつなぎ、候補ピンの中から配線をスキャンできます。'), 'mt'), link(t('To the search', '自動検索へ'), '/setup/debug-scan'))]);
}
function groupEditor(g, index, d, touch) {
  const pinField = (line, label, optional) => {
    const choices = candidatesFor(g, line).map(([ch, name]) => [String(ch), `${name}${labelOf(ch, d) ? ` · ${labelOf(ch, d)}` : ''}`]);
    return field(label, g.pins[line] ?? '', (v) => { g.pins[line] = v; touch(); }, '', [['', optional ? t('Not connected', '接続しない') : t('Choose a pin', 'ピンを選ぶ')], ...choices], 'text', { 'data-line': `${index}-${line}` });
  };
  const lines = linesOf(g);
  return el('section', { class: 'wire-group', 'data-group': g.type },
    el('div', { class: 'wire-head' }, el('h3', {}, g.type === 'debug' ? t(`Debug${g.wire ? ' · ' + (wireById(g.wire)?.short ?? '') : ''}`, `デバッグ${g.wire ? ' · ' + (wireById(g.wire)?.short ?? '') : ''}`) : GROUP_TITLE[g.type]), button(t('Remove this signal', 'この信号を外す'), () => { d.groups.splice(index, 1); touch(); render(); })),
    g.type === 'debug' ? debugChoices((wire) => { if (wire === g.wire) return; g.wire = wire; g.pins = {}; touch(); render(); }, g.wire) : null,
    g.type === 'debug' && !g.wire ? note(t('Choose a method to set the pins of the signals it needs.', '方式を選ぶと、必要な信号のピンを指定できます。')) : el('div', { class: 'wire-pins' },
      ...(g.type === 'custom' ? Object.keys(g.pins).map((line) => el('div', { class: 'field-grid' },
        field(t('Signal name', '信号名'), line, (v) => { const val = g.pins[line]; delete g.pins[line]; g.pins[v] = val; touch(); }, t('Letters, digits, _ and -. For example boot0, led, ch0', '英数字・_・-。例: boot0、led、ch0'), null, 'text', { 'data-custom-name': `${index}-${line}`, onchange: () => render() }),
        pinField(line, t('Probe pin', 'プローブのピン'), false))) : lines.map((line) => pinField(line, LINE_TITLE()[line] ?? line, OPTIONAL.has(line)))),
      g.type === 'custom' ? button(t('Add a signal name', '信号名を追加'), () => { g.pins[`signal${Object.keys(g.pins).length + 1}`] = ''; touch(); render(); }) : null),
    lines.length || g.type === 'custom' ? el('details', { class: 'mt', open: Object.values(g.target ?? {}).some(Boolean) }, el('summary', {}, t('Target pin name (optional)', '相手側のピン名（任意）')),
      p(t('If known, record the target\'s pin name (PA13 and so on). You can register without it.', '分かれば、相手の端子名（PA13 など）を記録します。分からなくても登録できます。'), 'compact muted'),
      el('div', { class: 'wire-pins' }, ...(g.type === 'custom' ? Object.keys(g.pins) : lines).map((line) => field(line, g.target?.[line] ?? '', (v) => { g.target[line] = v; touch(); }, '', null, 'text', { 'data-target-pin': `${index}-${line}` })))) : null,
    p(t('Share GND with the target. Speed, address and the like are set where the operation starts, not saved with the wiring.', 'GNDは相手と共通にします。速度・アドレスなどは操作を始める画面で指定し、配線には保存しません。'), 'compact muted mt'),
    g.type === 'debug' && g.wire ? debugCheck(g, index, d) : null);
}
function labelOf(ch, d) {
  const l = D.dev.labels.find(([c]) => c === ch)?.[1];
  if (!l) return '';
  return d.original && d.original.lines.some(([c]) => c === ch) ? '' : t(`In use: ${l}`, `使用中: ${l}`);
}
function debugCheck(g, index, d) {
  const r = d.check[index];
  const pins = () => ({ dio: g.wire === 'swio' ? g.pins.swio : g.pins.swdio, clk: g.pins.swclk, nrst: g.pins.nrst });
  const ready = g.wire === 'swio' ? !!g.pins.swio : !!g.pins.swdio && !!g.pins.swclk;
  return panel(el('h3', {}, t('Connection check (optional)', '接続確認（任意）')), p(d.connector ? t('Identifies and shows what is connected. What is identified is not saved with the wiring.', 'つないだ相手を識別して表示します。識別した相手は配線の記録に保存しません。') : t('With the target connected you can check its answer on this wiring. Without it, skip the check and save.', 'ターゲットがつながっていれば、指定した配線で応答を確認できます。未接続なら、この確認を飛ばして保存できます。')),
    action(t('Check the connection on these pins', '指定したピンで接続確認'), async () => { const out = await D.checkDebug(g.wire, pins()); d.check[index] = out; }, '', { disabled: !ready, 'data-check': index }),
    el('p', { class: 'mt', role: 'status', id: `debug-check-${index}` }, r ? (r.ok ? t(`Answered: ${r.id}. The check connection is closed. The wiring is not saved yet.`, `応答あり: ${r.id}。確認用の接続は終了しています。配線はまだ保存していません。`) : t(`No answer (${r.reason}). Check the wiring, power and method. You can also save it as it is.`, `応答なし（${r.reason}）。配線・電源・方式を見直せます。このまま保存することもできます。`)) : t('Not checked. You can save without the connection check.', '未確認。接続確認を省略して保存できます。')),
    button(t('Operate with this wiring (without saving)', 'この配線で操作へ（保存しない）'), () => {
      if (!ready) return;
      state.operations.debug = { wire: g.wire, port: '', pins: { ...pins() } }; state.dirty = false; state.draft = null; go('/operate/debug');
    }, '', { disabled: !ready }));
}
async function saveDraft(id) {
  const d = state.draft, errorBox = document.getElementById('form-error');
  const name = d.name.trim();
  const fail = (m) => { if (errorBox) errorBox.textContent = m; throw new Error(m); };
  if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(name)) fail(t('The connection name must be up to 16 letters, digits and hyphens, starting with a letter.', '接続名は英字で始まる、16文字以内の英数字・ハイフンにしてください。'));
  if (!d.groups.length) fail(t('Add at least one signal.', '信号を1つ以上追加してください。'));
  if (d.groups.some((g) => g.type === 'debug' && !g.wire)) fail(t('Choose the target\'s debug method.', 'ターゲットのデバッグ方式を選んでください。'));
  for (const g of d.groups) for (const line of linesOf(g)) if (!OPTIONAL.has(line) && !g.pins[line] && g.type !== 'custom') fail(t(`Choose a pin for ${line} of ${GROUP_TITLE[g.type]}.`, `${GROUP_TITLE[g.type]}の${line}にピンを選んでください。`));
  /** @type {[number, string][]} */
  const desired = d.groups.flatMap((g) => Object.entries(g.pins).filter(([, ch]) => ch !== '' && ch !== undefined).map(([line, ch]) => [Number(ch), g.target?.[line] ? `${line}@${g.target[line]}` : line]));
  const debug = d.groups.find((g) => g.type === 'debug' && g.wire !== 'swio')?.wire ?? '';
  const out = await D.saveConnection({ original: d.original, name, desired, part: d.part.trim(), note: d.note, connector: d.connector, debug });
  state.dirty = false; state.draft = null;
  state.notice = t(`"${name}" ${out.persistent ? 'was saved' : 'was applied for now (this probe cannot store settings)'}. ${out.inProbe ? '' : 'The part number and memo were saved in this browser. '}Saving never starts a connection or an output.`, `「${name}」を${out.persistent ? '保存しました' : '今回だけ適用しました（このプローブは永続保存できません）'}。${out.inProbe ? '' : '型番・メモはこのブラウザに保存しました。'}保存によって接続・出力が始まることはありません。`);
  if (id === 'new') go(`/setup/ready?port=${encodeURIComponent(name)}&purpose=${d.purpose ?? ''}`);
  else go(state.returnTo);
}
export { PEER_TASKS, checkbox };
