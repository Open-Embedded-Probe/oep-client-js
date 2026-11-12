// Initial setup (I02), the workspace home (W01), the connections (W02) and their editor (W03).
// Saving writes labels and records only; it never scans, attaches, assigns pins or drives outputs (§6.3, A13).
import { el, p, badge, actions, link, external, note, panel, heading, field, checkbox, keyValues, textLink } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { LOG_PATHS, GUIDE_BASE, SETUP_PATTERNS } from './data.js';
import { connected, needConnection, patternChoices, debugChoices, wireById, groupsOf, wiringSummary, GROUP_TITLE, taskById, PEER_TASKS, probeTitle, purposeRoute } from './common.js';

function frame(content) { return el('div', {}, ...content); }
const installDone = () => state.install?.phase === 'done';

// -- I02: what to set up first --
export function setup(view, query) {
  if (!connected()) return needConnection(`/setup${view ? '/' + view : ''}${query.toString() ? '?' + query : ''}`);
  if (view === 'ready') return ready(query);
  if (view === 'debug' || view === 'debug-scan') return debugSetup(view, query);
  if (view === 'logs') return frame([heading('相手のログを、どの方法で見ますか。', '相手が出すログと、読みたい道具に合わせて選びます。', 'SETUP / LOGS'),
    el('div', { class: 'stack' }, ...LOG_PATHS.map(([id, title, description]) => el('a', { class: 'pattern-card', 'data-log-path': id, href: id === 'passthrough' ? '#/passthrough' : id === 'console' ? '#/operate/console' : '#/operate/uart' }, el('strong', {}, title), el('span', {}, description)))),
    note('初期の範囲では、普通のシリアルモニタへの素通し（本体設定）が主な経路です。画面の中でのUART・デバッグ線のログ操作も使えますが、実機での確認はこれからです。'),
    actions(link('UARTの配線に名前を付ける', '/connection/new?purpose=uart&from=setup'), link('利用パターンに戻る', '/setup')), external('ログ取得・素通しの説明', GUIDE_BASE + 'use-cases.ja.md')]);
  if (view === 'logic') return frame([heading('どのように波形を取りますか。', 'キャプチャだけなら、本体設定も配線名の登録も不要です。取得と解析はWireSkeinで行います。', 'SETUP / CAPTURE'),
    el('div', { class: 'two-grid' }, ...[
      ['standalone', '今回だけ、ピンを直接選んで取る', '信号名・ピン・取得条件を整理してWireSkeinへ。本体には何も保存しません。'],
      ['named', '登録済みの配線を観測する', 'デバッグやUARTなどの配線を、その名前で観測します。ロジック取得は出力せず、使用中のピンも観測できます。'],
      ['during', '操作の最中の波形を取る', '書き込み・リセット・通信とキャプチャを、同じPython処理で実行します。'],
      ['test', '波形を自動テストで照合する', 'WireSkeinとpytestで記録・期待値・合否を残します。'],
    ].map(([mode, title, description]) => el('a', { class: 'pattern-card', 'data-capture-mode': mode, href: `#/capture?mode=${mode}` }, el('strong', {}, title), el('span', {}, description)))),
    actions(link('観測用の配線に名前を付ける', '/connection/new?purpose=custom&from=setup')), external('キャプチャの使い分け', GUIDE_BASE + 'capture.ja.md')]);
  const group = { bus: ['i2c', 'spi'], signal: ['gpio', 'pwm', 'counter', 'dac', 'analog'], peer: ['i2c-target', 'spi-target'] }[view];
  if (group) {
    const pattern = SETUP_PATTERNS.find((t) => t.id === view);
    return frame([heading(pattern.title, '目的に合う方式を選ぶと、その配線と条件へ進みます。画面を開いただけでは動作しません。', 'SETUP / USE CASE'),
      el('div', { class: 'two-grid' }, ...group.map((id) => { const t = taskById(id); return el('a', { class: 'pattern-card', href: '#' + purposeRoute(id), 'data-task': id }, el('strong', {}, t.title), el('span', {}, t.description), el('span', { class: 'pattern-next' }, `${t.short}の配線と条件へ →`)); })),
      actions(link('配線に名前を付けて登録する', `/connection/new?purpose=${view === 'bus' ? 'i2c' : view === 'peer' ? 'i2c' : 'custom'}&from=setup`), link('利用パターンに戻る', '/setup'))]);
  }
  return frame([
    heading(installDone() ? 'OEPの導入が完了しました。' : 'このプローブを、何に使いますか。', 'まず利用パターンを選びます。用途に合う配線と条件を整えて、そのまま作業へ進みます。', 'READY TO CONFIGURE'),
    el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, 'OEP'), el('div', {}, el('strong', {}, `${probeTitle()} · 起動確認済み`),
      p(`firmware ${D.dev.info.firmware ?? '—'} · 機能 ${D.dev.caps.offers.length} 個 · 配線 ${D.dev.ports.length} 件${D.dev.ports.length ? '（設定済み。編集できます）' : ''}`))),
    state.notice ? note(state.notice) : null,
    el('h2', {}, 'どのように使いますか？'), patternChoices(),
    panel(el('h2', {}, '治具・ほかの環境で使う'), actions(link('据え置き治具の設定順を確認', '/fixture'), link('IDE・自動テストへ', '/handoff'), link('ネットワークなど本体設定', '/settings?from=setup')), external('用途別ガイド', GUIDE_BASE + 'use-cases.ja.md')),
    p('用途はひとつに固定されません。後から追加でき、同じ相手にデバッグとUARTなどを組み合わせられます。', 'muted mt'),
    el('details', { class: 'panel mt' }, el('summary', {}, '本体設定・復元・配線を保存せず試す'), actions(link('プローブ本体を設定する', '/settings?from=setup'), link('設定ファイルから戻す', '/maintenance?from=setup'), link('配線を保存せず試す', '/operations'))),
    actions(link('あとで設定する・作業ホームへ →', '/work'))]);
}
function debugSetup(view, query) {
  const from = query.get('from') ?? 'setup';
  if (view === 'debug') return frame([heading('デバッグの配線を決める。', '自動検索するか、分かっているピンを指定します。保存するかどうかは、配線を決めてから選べます。', 'SETUP / DEBUG'),
    el('div', { class: 'two-grid' },
      el('a', { class: 'pattern-card', href: `#/setup/debug-scan?from=${from}`, 'data-debug-path': 'scan' }, el('strong', {}, 'ターゲットをスキャンして自動検索'), p('信号の役割が分からないとき。ターゲットをつなぎ、方式と探索するピンを選んで検索します。'), el('span', { class: 'pattern-next' }, '候補ピン → スキャン → 見つかった配線を確認 →')),
      el('a', { class: 'pattern-card', href: `#/connection/new?purpose=debug&from=${from}`, 'data-debug-path': 'manual' }, el('strong', {}, 'ピンを明示的に指定'), p('配線が分かっているとき。方式と信号ごとのピンを指定し、必要なら接続確認します。ターゲット未接続のまま保存もできます。'), el('span', { class: 'pattern-next' }, '方式・ピン指定 → 確認・保存 →'))),
    note('決まったコネクタにいろいろなボードを付け替えて使う場合も、「ピンを明示的に指定」から「コネクタ」として登録します。'),
    actions(link('利用パターンに戻る', '/setup'))]);
  const s = state.debugScan ??= { wire: '', pins: [], result: null };
  const offer = s.wire ? D.wireOffer(s.wire) : null;
  const taken = new Map(D.dev.labels);
  const candidates = offer ? [...new Set([...D.roleChannels(offer)].filter(([r]) => r !== 3).flatMap(([, c]) => c))] : [];
  const need = s.wire === 'swio' ? 1 : 2;
  return frame([heading('ターゲットを自動検索する。', '探索する範囲を決めてから、明示的にスキャンを開始します。画面を開いただけでは検索しません。', 'SETUP / DEBUG SCAN'),
    panel(el('h2', {}, '01 / 相手のデバッグ方式'), debugChoices((id) => { s.wire = id; s.pins = []; s.result = null; render(); }, s.wire),
      s.wire && !D.scanOffered(s.wire) ? note('このプローブは、この方式の自動検索を持っていません。ピンを明示して登録してください。', 'amber') : null),
    offer ? panel(el('h2', {}, '02 / 探索するプローブ側のピン'), p('ターゲットにつないだピンだけを選びます。別の配線に登録済みのピンは選べません。'),
      el('div', { class: 'pin-grid' }, ...candidates.map((ch) => el('label', { class: taken.has(ch) ? 'taken' : '' }, el('input', { type: 'checkbox', 'data-scan-pin': ch, checked: s.pins.includes(ch), disabled: taken.has(ch), onchange: (e) => { s.pins = e.target.checked ? [...s.pins, ch] : s.pins.filter((x) => x !== ch); s.result = null; } }), D.pinName(ch), taken.has(ch) ? el('small', {}, taken.get(ch)) : null))),
      p('スキャンは選んだピンへ信号を出します。相手を接続し、GND・電圧を確認してから開始します。', 'mt'),
      action('選択したピンをスキャン', async () => { if (s.pins.length < need) throw new Error('ターゲットにつないだピンを選んでください。'); s.result = await D.scanDebug(s.wire, s.pins); }, 'primary', { disabled: !D.scanOffered(s.wire), id: 'start-scan' })) : null,
    s.result ? panel(el('h2', {}, `見つかった配線候補（${s.result.tried} 組を試行）`), s.result.found.length ? el('div', { class: 'stack' }, ...s.result.found.map((f) => el('div', { class: 'connection-card' },
      keyValues([[s.wire === 'swio' ? 'SWIO' : 'SWDIO', D.pinName(f.dio)], ...(f.clk !== '' ? [['SWCLK', D.pinName(f.clk)]] : []), ['応答', f.id]]),
      button('この配線を確認・保存へ →', () => { state.scanSelection = { wire: s.wire, ...f }; go(`/connection/new?purpose=debug&source=scan&from=${from}`); }, 'primary')))) : note('応答がありません。接続・電源・方式・候補ピンを見直して再検索できます。分かっている配線を直接指定して保存することもできます。', 'amber'),
      p('結果から型番を確定したり、自動保存したりはしません。', 'muted')) : null,
    actions(link('ピンを明示的に指定する', `/connection/new?purpose=debug&from=${from}`), link('配線の決め方に戻る', '/setup/debug'))]);
}
function ready(query) {
  const port = D.portOf(query.get('port') ?? '');
  if (!port) return frame([heading('保存した配線が見つかりません。', '一覧を読み直してください。'), link('配線・接続先へ', '/connections', true)]);
  const purpose = query.get('purpose') || '';
  const g = groupsOf(port), first = g[0];
  const op = purpose === 'custom' ? '/capture?mode=named&port=' + port.name : purpose ? purposeRoute(purpose) + `?port=${port.name}` : first?.type === 'debug' ? `/operate/debug?port=${port.name}` : first?.type === 'uart' ? `/operate/uart?port=${port.name}` : first?.type === 'i2c' ? `/operate/i2c?port=${port.name}` : first?.type === 'spi' ? `/operate/spi?port=${port.name}` : '/operations';
  return frame([heading('用途に合わせた設定ができました。', 'ターゲットが未接続でも、ここまで設定できます。保存によって接続・出力が始まることはありません。', 'READY TO USE'),
    state.notice ? note(state.notice) : null, panel(el('h2', {}, port.name), p(D.isConnector(port.name) ? 'コネクタ（相手を差し替える）' : D.recordOf(port.name).part || '相手の型番は未記入'), wiringSummary(port)),
    actions(link('この配線で操作の準備へ →', op, true), link('配線を編集する', `/connection/${port.name}`), link('別の利用パターンも設定する', '/setup')), textLink('あとで使う・作業ホームへ', '/work')]);
}
export function fixture() {
  if (!connected()) return needConnection('/fixture');
  return frame([heading('プローブを据え置きの治具にする。', '毎回同じ配線・待機状態で使うための本体設定です。ターゲットが未接続でも準備できます。', 'FIXTURE'),
    el('div', { class: 'stack' }, ...[
      ['1', '触らせないピンを決める', 'LED・ボタン・起動用の端子など、使わせないピンを指定します。', '/settings?section=pins'],
      ['2', '配線に名前を付ける', '相手ごとに接続名を付けます。分かっている固定配線を登録すれば、スキャンは不要です。', '/connections'],
      ['3', '空き時間のピン状態を決める', 'BOOT0、リセット、チップセレクトなどの待機状態を決めます。', '/settings?section=pins'],
      ['4', '必要ならログを素通しする', 'セッションがない間だけ、普通のシリアルモニタへログを流します。', '/passthrough'],
      ['5', '保存して控えを取る', '本体の現在値全体を保存し、設定とメモの控えをファイルに取ります。秘密値は控えに含めません。', '/maintenance?from=fixture'],
    ].map(([num, title, desc, route]) => el('a', { class: 'setup-choice', href: '#' + route }, el('span', { class: 'number' }, num), el('div', {}, el('h3', {}, title), p(desc)), el('span', { class: 'arrow' }, '→')))),
    note('画面を開いただけでは設定を適用しません。適用するとその場で効き、保存すると再起動後も残ります。'), external('治具として据え置く手順', GUIDE_BASE + 'use-cases.ja.md')]);
}

// -- W01 / W02 --
export function work() {
  if (!connected()) return needConnection('/work');
  return frame([heading('このプローブで、何をしますか。', '保存した配線から続けることも、その場でピンを指定して試すこともできます。'),
    state.notice ? note(state.notice) : null,
    el('section', { class: 'form-group' }, el('div', { class: 'mini-heading' }, el('h2', {}, '配線・接続先'), el('a', { href: '#/connections', class: 'text-link' }, '一覧・編集 →')),
      D.dev.ports.length ? el('div', { class: 'stack' }, ...D.dev.ports.map(portCard)) : emptyConnections()),
    el('section', {}, el('div', { class: 'mini-heading' }, el('h2', {}, '目的から操作を選ぶ'), el('a', { href: '#/operations', class: 'text-link' }, 'すべて見る →')), patternChoices('operations')),
    actions(link('初期設定の案内を開く', '/setup'), link('外部ツールへ', '/handoff'))]);
}
function emptyConnections() {
  return el('div', { class: 'empty' }, el('h3', {}, 'まだ配線を登録していません。'), p('相手の型番や、どの信号をどのピンにつなぐかを保存できます。ターゲットは未接続でかまいません。', 'muted'),
    actions(link('配線を登録する →', '/connection/new', true), link('登録せずに操作する', '/operations')));
}
function portCard(port) {
  const rec = D.recordOf(port.name), groups = groupsOf(port), connector = D.isConnector(port.name);
  const use = { debug: 'debug', uart: 'uart', i2c: 'i2c', spi: 'spi' };
  return el('article', { class: 'connection-card', 'data-port': port.name },
    el('header', {}, el('div', {}, el('h2', {}, port.name), p(connector ? 'コネクタ（相手はつなぐたびに識別）' : rec.part || '相手の型番は未記入', 'muted mb0')),
      badge(D.dev.memo ? 'プローブに保存' : '型番・メモはこのブラウザだけ', D.dev.memo ? '' : 'amber')),
    wiringSummary(port), rec.note ? p(rec.note, 'compact muted') : null, el('code', {}, `oep://${D.unit()}/${port.name}`),
    actions(link('配線・相手の情報を編集', `/connection/${encodeURIComponent(port.name)}`, true),
      ...groups.filter((g) => use[g.type]).map((g) => link(`${g.type === 'debug' ? (wireById(g.wire)?.short ?? 'デバッグ') : GROUP_TITLE[g.type]}で使う →`, `/operate/${use[g.type]}?port=${encodeURIComponent(port.name)}`)),
      action('削除…', async () => { if (!confirm(`${port.name}の接続名・配線（ピン名）・型番・メモを削除します。`)) return false; await D.deleteConnection(port); state.notice = `${port.name}を削除しました。`; }, 'danger', { disabled: !D.dev.changeable })));
}
export function connections() {
  if (!connected()) return needConnection('/connections');
  return frame([heading('配線と、つなぐ相手を記録する。', '固定の配線を登録して、同じ作業に繰り返し使えます。相手が未接続でも編集・保存できます。'),
    state.notice ? note(state.notice) : null, !D.dev.changeable ? note('このプローブは設定を変更できないため、配線を登録できません（読み取りのみ）。', 'amber') : null,
    D.dev.unsaved ? note('適用済みで永続保存していない設定があります。再起動後も残すには「本体設定」で保存します。', 'amber') : null,
    D.dev.ports.length ? [actions(link('新しい配線を登録', '/connection/new', true), action('読み直す', D.refresh)), el('div', { class: 'stack mt' }, ...D.dev.ports.map(portCard))] : emptyConnections()]);
}

// -- W03: the editor --
const LINES = { debug: { rvswd: ['swdio', 'swclk', 'nrst'], swd: ['swdio', 'swclk', 'nrst'], swio: ['swio', 'nrst'] }, uart: ['rx', 'tx'], i2c: ['sda', 'scl'], spi: ['sck', 'mosi', 'miso', 'cs'] };
const OPTIONAL = new Set(['nrst', 'tx', 'miso', 'cs']);
const LINE_TITLE = { rx: 'RX（プローブRX ← 相手TX）', tx: 'TX（プローブTX → 相手RX、任意）', nrst: 'NRST（任意）', swdio: 'SWDIO', swclk: 'SWCLK', swio: 'SWIO（1線DIO）', sda: 'SDA', scl: 'SCL', sck: 'SCK', mosi: 'MOSI', miso: 'MISO（任意）', cs: 'CS（任意）' };
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
  if (id === 'new' && !purpose && !state.draft) return frame([heading('どの用途の配線を登録しますか。', '信号の種類から始めます。あとで別の信号も同じ接続先に追加できます。ターゲットは未接続でかまいません。'),
    el('div', { class: 'two-grid' }, ...[['debug', 'デバッグ（SWD / RVSWD / 1線DIO）', '相手のデバッグ端子。決まったコネクタで相手を差し替える使い方もここから。'], ['uart', 'UART', '相手のログを読む・コマンドを送る線。'], ['i2c', 'I2C', 'センサや周辺IC、または代役で応答する線。'], ['spi', 'SPI', 'SPIの機器、または代役で応答する線。'], ['custom', 'そのほかの信号', 'GPIOの制御線、観測したい信号など。名前を自分で付けます。']].map(([t, title, d]) =>
      el('a', { class: 'pattern-card', href: `#/connection/new?purpose=${t}${from ? '&from=' + from : ''}`, 'data-new-purpose': t }, el('strong', {}, title), el('span', {}, d)))),
    actions(link('配線の一覧に戻る', '/connections'))]);
  if (!state.draft || state.draft.editId !== id) {
    const port = id === 'new' ? null : D.portOf(id);
    if (id !== 'new' && !port) return frame([heading('この配線は見つかりません。', '名前の変更か削除が行われた可能性があります。'), link('配線の一覧へ', '/connections', true)]);
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
  const kindPanel = el('fieldset', { class: 'form-group' }, el('legend', {}, '登録の種類'),
    el('div', { class: 'two-grid' }, ...[[false, '相手が決まっている', '配線ごと固定。相手の型番とメモを記録します。'], [true, 'コネクタ（相手を差し替える）', 'ピンを固定し、つなぐ相手はその都度識別して表示します。相手の型番は記録しません。']].map(([v, t, desc]) =>
      el('button', { type: 'button', class: `pattern-card${d.connector === v ? ' selected' : ''}`, 'aria-pressed': String(d.connector === v), 'data-kind': v ? 'connector' : 'fixed', onclick: () => { d.connector = v; touch(); render(); } }, el('strong', {}, t), el('span', {}, desc)))),
    d.original && d.connector !== D.isConnector(d.original.name) ? note('種類を変えると、相手の型番の扱いが変わります（コネクタでは型番を記録しません）。') : null);
  const targetFields = el('fieldset', { class: 'form-group' }, el('legend', {}, '名前・相手の情報'),
    el('div', { class: 'field-grid' }, field('接続名', d.name, (v) => { d.name = v; touch(); }, '例: sensor / board-1。英字で始まる16文字以内の英数字・ハイフン。アドレス oep://<個体>/<接続名> にも使います。', null, 'text', { id: 'conn-name' }),
      !d.connector ? field('相手のIC・基板の型番（任意）', d.part, (v) => { d.part = v; touch(); }, '例: CH32V003F4P6、STM32F103C8T6。プローブ自身の型番ではありません。接続確認の結果でもありません。', null, 'text', { id: 'conn-part' }) : null),
    el('div', { class: 'mt' }, field('用途・配線メモ（任意）', d.note, (v) => { d.note = v; touch(); }, 'コネクタ番号、電圧、用途など。電圧を書いても設定は変わりません。', null, 'textarea', { id: 'conn-note' })),
    d.original && d.name && d.name.toLowerCase() !== d.original.name.toLowerCase() ? note(`名前を変えると、アドレスが oep://${D.unit()}/${d.name} に変わり、型番・メモも新しい名前へ移します。`) : null,
    !D.dev.memo ? note('このプローブにはメモ領域がないため、型番・メモはこのブラウザだけに保存します（他のPCには渡りません）。配線はプローブに保存します。', 'amber') : null);
  const wiring = el('fieldset', { class: 'form-group' }, el('legend', {}, '信号とプローブ側のピン'), p('デバッグとUARTなど、複数の種類を一緒に登録できます。候補はこのプローブの宣言から出しています。', 'muted'),
    ...d.groups.map((g, i) => groupEditor(g, i, d, touch)),
    el('div', { class: 'mt' }, el('h3', {}, '別の信号も追加する'), el('div', { class: 'choice-row' }, ...['debug', 'uart', 'i2c', 'spi', 'custom'].map((t) => button(`＋ ${GROUP_TITLE[t]}`, () => { d.groups.push(newGroup(t)); touch(); render(); }, '', { disabled: t !== 'custom' && d.groups.some((g) => g.type === t), 'data-add-group': t })))));
  return frame([heading(id === 'new' ? '何を、どのピンにつなぎますか。' : `${d.original?.name}の配線を編集`, '相手の情報と配線を、ひとつの場所で設定します。保存しても接続・出力は始まりません。', 'CONNECTION'),
    el('form', { id: 'connection-form', onsubmit: (e) => { e.preventDefault(); } }, kindPanel, wiring, targetFields,
      el('div', { id: 'form-error', class: 'form-error', role: 'alert' }),
      el('div', { class: 'save-bar' }, p(D.dev.saveable ? '保存は、ピン名をプローブへ適用して永続保存し、型番・メモを記録します。本体の他の未保存の変更もまとめて保存されます。' : 'このプローブは永続保存できません。保存は「今回だけ適用」になります。'),
        actions(button('キャンセル', () => { state.dirty = false; state.draft = null; go(state.returnTo); }), action(D.dev.saveable ? (id === 'new' ? '配線を保存' : '変更を保存') : '今回だけ適用', () => saveDraft(id), 'primary', { id: 'save-connection', disabled: !D.dev.changeable })))),
    el('details', { class: 'panel mt' }, el('summary', {}, 'デバッグ配線が分からない場合'), p('ターゲットをつなぎ、候補ピンの中から配線をスキャンできます。', 'mt'), link('自動検索へ', '/setup/debug-scan'))]);
}
function groupEditor(g, index, d, touch) {
  const pinField = (line, label, optional) => {
    const choices = candidatesFor(g, line).map(([ch, name]) => [String(ch), `${name}${labelOf(ch, d) ? ` · ${labelOf(ch, d)}` : ''}`]);
    return field(label, g.pins[line] ?? '', (v) => { g.pins[line] = v; touch(); }, '', [['', optional ? '接続しない' : 'ピンを選ぶ'], ...choices], 'text', { 'data-line': `${index}-${line}` });
  };
  const lines = linesOf(g);
  return el('section', { class: 'wire-group', 'data-group': g.type },
    el('div', { class: 'wire-head' }, el('h3', {}, g.type === 'debug' ? `デバッグ${g.wire ? ' · ' + (wireById(g.wire)?.short ?? '') : ''}` : GROUP_TITLE[g.type]), button('この信号を外す', () => { d.groups.splice(index, 1); touch(); render(); })),
    g.type === 'debug' ? debugChoices((wire) => { if (wire === g.wire) return; g.wire = wire; g.pins = {}; touch(); render(); }, g.wire) : null,
    g.type === 'debug' && !g.wire ? note('方式を選ぶと、必要な信号のピンを指定できます。') : el('div', { class: 'wire-pins' },
      ...(g.type === 'custom' ? Object.keys(g.pins).map((line) => el('div', { class: 'field-grid' },
        field('信号名', line, (v) => { const val = g.pins[line]; delete g.pins[line]; g.pins[v] = val; touch(); }, '英数字・_・-。例: boot0、led、ch0', null, 'text', { 'data-custom-name': `${index}-${line}`, onchange: () => render() }),
        pinField(line, 'プローブのピン', false))) : lines.map((line) => pinField(line, LINE_TITLE[line] ?? line, OPTIONAL.has(line)))),
      g.type === 'custom' ? button('信号名を追加', () => { g.pins[`signal${Object.keys(g.pins).length + 1}`] = ''; touch(); render(); }) : null),
    lines.length || g.type === 'custom' ? el('details', { class: 'mt', open: Object.values(g.target ?? {}).some(Boolean) }, el('summary', {}, '相手側のピン名（任意）'),
      p('分かれば、相手の端子名（PA13 など）を記録します。分からなくても登録できます。', 'compact muted'),
      el('div', { class: 'wire-pins' }, ...(g.type === 'custom' ? Object.keys(g.pins) : lines).map((line) => field(line, g.target?.[line] ?? '', (v) => { g.target[line] = v; touch(); }, '', null, 'text', { 'data-target-pin': `${index}-${line}` })))) : null,
    p('GNDは相手と共通にします。速度・アドレスなどは操作を始める画面で指定し、配線には保存しません。', 'compact muted mt'),
    g.type === 'debug' && g.wire ? debugCheck(g, index, d) : null);
}
function labelOf(ch, d) {
  const l = D.dev.labels.find(([c]) => c === ch)?.[1];
  if (!l) return '';
  return d.original && d.original.lines.some(([c]) => c === ch) ? '' : `使用中: ${l}`;
}
function debugCheck(g, index, d) {
  const r = d.check[index];
  const pins = () => ({ dio: g.wire === 'swio' ? g.pins.swio : g.pins.swdio, clk: g.pins.swclk, nrst: g.pins.nrst });
  const ready = g.wire === 'swio' ? !!g.pins.swio : !!g.pins.swdio && !!g.pins.swclk;
  return panel(el('h3', {}, '接続確認（任意）'), p(d.connector ? 'つないだ相手を識別して表示します。識別した相手は配線の記録に保存しません。' : 'ターゲットがつながっていれば、指定した配線で応答を確認できます。未接続なら、この確認を飛ばして保存できます。'),
    action('指定したピンで接続確認', async () => { const out = await D.checkDebug(g.wire, pins()); d.check[index] = out; }, '', { disabled: !ready, 'data-check': index }),
    el('p', { class: 'mt', role: 'status', id: `debug-check-${index}` }, r ? (r.ok ? `応答あり: ${r.id}。確認用の接続は終了しています。配線はまだ保存していません。` : `応答なし（${r.reason}）。配線・電源・方式を見直せます。このまま保存することもできます。`) : '未確認。接続確認を省略して保存できます。'),
    button('この配線で操作へ（保存しない）', () => {
      if (!ready) return;
      state.operations.debug = { wire: g.wire, port: '', pins: { ...pins() } }; state.dirty = false; state.draft = null; go('/operate/debug');
    }, '', { disabled: !ready }));
}
async function saveDraft(id) {
  const d = state.draft, errorBox = document.getElementById('form-error');
  const name = d.name.trim();
  const fail = (m) => { if (errorBox) errorBox.textContent = m; throw new Error(m); };
  if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(name)) fail('接続名は英字で始まる、16文字以内の英数字・ハイフンにしてください。');
  if (!d.groups.length) fail('信号を1つ以上追加してください。');
  if (d.groups.some((g) => g.type === 'debug' && !g.wire)) fail('ターゲットのデバッグ方式を選んでください。');
  for (const g of d.groups) for (const line of linesOf(g)) if (!OPTIONAL.has(line) && !g.pins[line] && g.type !== 'custom') fail(`${GROUP_TITLE[g.type]}の${line}にピンを選んでください。`);
  /** @type {[number, string][]} */
  const desired = d.groups.flatMap((g) => Object.entries(g.pins).filter(([, ch]) => ch !== '' && ch !== undefined).map(([line, ch]) => [Number(ch), g.target?.[line] ? `${line}@${g.target[line]}` : line]));
  const debug = d.groups.find((g) => g.type === 'debug' && g.wire !== 'swio')?.wire ?? '';
  const out = await D.saveConnection({ original: d.original, name, desired, part: d.part.trim(), note: d.note, connector: d.connector, debug });
  state.dirty = false; state.draft = null;
  state.notice = `「${name}」を${out.persistent ? '保存しました' : '今回だけ適用しました（このプローブは永続保存できません）'}。${out.inProbe ? '' : '型番・メモはこのブラウザに保存しました。'}保存によって接続・出力が始まることはありません。`;
  if (id === 'new') go(`/setup/ready?port=${encodeURIComponent(name)}&purpose=${d.purpose ?? ''}`);
  else go(state.returnTo);
}
export { PEER_TASKS, checkbox };
