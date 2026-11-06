import { BOARDS, TASKS, SCENARIOS, DOCS } from './data.js';

// Isolated interaction prototype: no OEP library, device API, firmware download or persistent device settings.
/** @type {any} */
const state = { board: 'pico', connectedBoard: 'pico', scenario: 'auto', connected: false, selected: false, installation: false,
  flash: 'idle', progress: 0, handoff: 'direct', records: [], draft: null, dirty: false, returnTo: '/connections',
  connectReturn: '/work', intent: '', notice: '', operations: {}, active: {}, settings: {}, settingsApplied: false,
  settingsSaved: false, maintenance: '', transferDone: false, controlOpen: false };
let currentRoute = '', flashTimer = null;
/** @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag @param {Record<string,any>} [attrs] @param {...any} kids
 * @returns {HTMLElementTagNameMap[T]} */
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key in node && !key.startsWith('aria')) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== false && kid !== undefined) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}
const p = (text, cls = '') => el('p', { class: cls }, text);
const badge = (text, cls = '') => el('span', { class: `badge ${cls}` }, text);
const actions = (...items) => el('div', { class: 'actions' }, ...items);
const link = (text, route, primary = false) => el('a', { href: `#${route}`, class: `btn${primary ? ' primary' : ''}` }, text);
const external = (title, href) => el('a', { href, target: '_blank', rel: 'noopener', class: 'text-link' }, `${title} ↗`);
const button = (text, onClick, style = '', attrs = {}) => el('button', { type: 'button', class: `btn ${style}`, onclick: onClick, ...attrs }, text);
const note = (text, cls = '') => el('div', { class: `note ${cls}` }, text);
const panel = (...children) => el('section', { class: 'panel' }, ...children);
const board = () => BOARDS.find(b => b.id === state.board) ?? BOARDS[0];
const probeBoard = () => BOARDS.find(b => b.id === state.connectedBoard) ?? BOARDS[0];
const pinName = n => `${probeBoard().id === 'pico' ? 'GP' : 'GPIO'}${n}`;
const taskById = id => TASKS.find(t => t.id === id) ?? TASKS[0];
const routeNow = () => location.hash.startsWith('#/') ? location.hash.slice(1) : '/home';
const heading = (title, description, eyebrow = 'OEP WORKSPACE') => el('header', { class: 'page-heading' }, p(eyebrow, 'eyebrow'), el('h1', { tabindex: -1 }, title), p(description));
function announce(text) { document.getElementById('announcer').textContent = text; }
function discardThen(next) {
  if (!state.dirty) { next(); return; }
  const dialog = el('dialog', { class: 'exit-dialog', 'aria-labelledby': 'discard-title' },
    el('h2', { id: 'discard-title' }, '保存していない配線があります'), p('編集を続けるか、変更を破棄して移動してください。'),
    actions(button('編集を続ける', () => { dialog.close(); dialog.remove(); }, 'primary'), button('破棄して移動', () => { state.dirty = false; state.draft = null; dialog.close(); dialog.remove(); next(); })));
  dialog.addEventListener('cancel', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
function go(route) {
  if (route === currentRoute) return;
  discardThen(() => { location.hash = route; });
}
function field(label, value, onInput, help = '', choices = null, type = 'text') {
  const id = `field-${++fieldCount}`;
  const input = choices ? el('select', { id, onchange: e => onInput(e.target.value) }, ...choices.map(c => el('option', { value: c[0] }, c[1])))
    : el(type === 'textarea' ? 'textarea' : 'input', { id, type: type === 'textarea' ? undefined : type, value, oninput: e => onInput(e.target.value) });
  (/** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (input)).value = value;
  return el('label', { class: 'field', htmlFor: id }, label, input, help ? el('small', {}, help) : null);
}
let fieldCount = 0;
function shell(content, workspace) {
  const nav = [['/home', 'OEPとは'], ['/usecases', 'できること'], ['/boards', '対応ボード'], ['/learn', '技術・資料']];
  return [
    el('div', { class: 'prototype-bar' }, el('span', {}, el('strong', {}, '画面プレビュー'), '実機への接続・書き込みは行いません。表示値はサンプルです。'), el('div', { class: 'prototype-actions' }, button('確認シナリオ', () => { const controls = /** @type {HTMLDetailsElement} */ (document.querySelector('.review-controls')); controls.open = true; controls.scrollIntoView({ block: 'start' }); }, 'bar-action'), el('a', { href: '../' }, '既存の操作ページ ↗'))),
    el('header', { class: 'site-header' }, el('a', { href: '#/home', class: 'brand', 'aria-label': 'OEP トップ' }, el('span', { class: 'brand-icon' }, 'OEP'), el('span', { class: 'brand-name' }, 'Open Embedded Probe', el('small', {}, 'CONNECT. EXPLORE. BUILD.'))),
      el('nav', { class: 'public-nav', 'aria-label': 'OEPの案内' }, ...nav.map(([path, name]) => el('a', { href: `#${path}`, class: currentRoute === path ? 'active' : '', 'aria-current': currentRoute === path ? 'page' : 'false' }, name))),
      el('a', { class: 'btn header-action', href: state.connected ? '#/work' : '#/install/select' }, state.connected ? '作業に戻る →' : 'プローブを作る →')),
    workspace ? workspaceShell(content) : el('main', { id: 'content', class: 'container', tabindex: -1 }, content),
    el('footer', { class: 'footer' }, el('span', {}, 'Open Embedded Probe', p('ボードと開発ツールを、共通の方法でつなぐ。', 'mb0')), external('GitHub / OEP', 'https://github.com/Open-Embedded-Probe')),
    previewControls(),
  ];
}
function previewControls() {
  const details = el('details', { class: 'review-controls', open: state.controlOpen, ontoggle: e => { state.controlOpen = e.target.open; } },
    el('summary', {}, 'プレビューの確認用：接続シナリオ・最初からやり直す'),
    el('div', { class: 'review-content' }, field('書き込み後のシナリオ', state.scenario, v => { state.scenario = v; }, '次の書き込みプレビューに反映されます。', SCENARIOS),
      button('最初からやり直す', () => discardThen(() => { clearInterval(flashTimer); Object.assign(state, { connected: false, selected: false, installation: false, flash: 'idle', progress: 0, records: [], draft: null, dirty: false, active: {}, operations: {}, settings: {}, settingsApplied: false, settingsSaved: false, notice: '', intent: '', transferDone: false, maintenance: '' }); location.hash = '/home'; render(); })),
      p('設定はこのタブ内だけに保持します。再読み込みすると初期状態に戻ります。日本語で画面構成を確認する段階です。')));
  return details;
}
function heroDiagram() {
  return el('div', { class: 'bench', role: 'img', 'aria-label': 'PCのブラウザや開発ツールがOEPプローブを介して、開発中のICや基板につながります。' },
    el('span', { class: 'bench-label' }, 'ONE PROBE, MANY POSSIBILITIES'),
    el('div', { class: 'bench-row' }, el('div', { class: 'diagram-box' }, 'ブラウザ', el('span', {}, 'セットアップ・操作')), el('div', { class: 'diagram-box' }, 'IDE / テスト', el('span', {}, '開発・自動化'))),
    el('div', { class: 'probe-board' }, el('strong', {}, 'OEP'), el('small', {}, 'YOUR DEVELOPMENT BOARD')),
    el('div', { class: 'connection-line' }, '↓ デバッグ・通信・信号・観測 ↓'),
    el('div', { class: 'bench-row' }, el('div', { class: 'diagram-box' }, '開発中のIC・基板', el('span', {}, 'ターゲット'))),
  );
}
function taskCard(task, browse = true) {
  return el('a', { class: 'task-card', href: `#/${browse ? 'usecase' : 'operate'}/${task.id}` },
    el('span', { class: 'task-number' }, `${task.num} / ${task.short}`), el('h3', {}, task.title), p(task.description),
    el('span', { class: 'card-end' }, browse ? '使い方を見る →' : 'この作業を開く →'));
}
function sectionTitle(title, description, eyebrow) {
  return el('div', { class: 'section-head' }, el('div', {}, eyebrow ? p(eyebrow, 'eyebrow') : null, el('h2', {}, title)), description ? p(description) : null);
}
function home() {
  return [
    el('section', { class: 'hero' }, el('div', { class: 'hero-copy' }, p('OPEN EMBEDDED PROBE', 'eyebrow'), el('h1', { tabindex: -1 }, '手元のボードを、', el('br'), '開発のための', el('br'), '共通プローブに。'),
      p('Open Embedded Probeは、デバッグ・通信・信号制御・計測を、PCから共通の方法で使うための仕様です。対応ボードにOEPを入れて、つなぎたい相手と、やりたいことへ。'),
      actions(link('ボードをプローブにする →', '/install/select', true), link('導入済みのプローブを使う', '/connect')),
      p('まずはブラウザで導入・設定。必要に応じてIDEやテストツールへ。', 'hero-foot')), heroDiagram()),
    el('section', { class: 'section' }, sectionTitle('ひとつの接続から、いろいろな作業へ。', '利用できる機能は、ボードとファームウェアで異なります。', 'WHAT YOU CAN DO'),
      el('div', { class: 'three-grid' }, ...[TASKS[0], TASKS[1], TASKS[3], TASKS[7]].map(t => taskCard(t)),
        el('a', { class: 'task-card', href: '#/handoff' }, el('span', { class: 'task-number' }, 'OBSERVE / WireSkein'), el('h3', {}, '波形を観測・解析する'), p('取得した信号を見比べ、通信を読み解く。WireSkeinの取得・表示環境へ。'), el('span', { class: 'card-end' }, 'できることと必要な環境 →')),
        el('a', { class: 'task-card', href: '#/learn' }, el('span', { class: 'task-number' }, 'AUTOMATE / Python・IDE'), el('h3', {}, 'いつもの開発につなげる'), p('配線に名前を付けて再利用。スクリプトや自動テストからも同じプローブを使えます。'), el('span', { class: 'card-end' }, '技術と開発ツールを見る →')))),
    el('section', { class: 'section' }, sectionTitle('どのボードから始めますか。', '特徴と導入方法を見て選べます。導入済みなら、種類を選ばず接続できます。', 'BOARDS'),
      el('div', { class: 'three-grid' }, ...BOARDS.slice(0, 3).map(b => boardCard(b, false, true))), actions(link('すべてのボードと制約を見る', '/boards'))),
    el('section', { class: 'section' }, sectionTitle('書き込んだら、そのまま設定へ。', 'ターゲットがまだなくても、配線の登録はできます。', 'GET STARTED'),
      el('div', { class: 'steps-overview' }, ...[['ボードをつなぐ', '書き込みに使う機器を、ブラウザから一度選択。'], ['OEPを導入する', '画像とチップを確認し、書き込みから起動まで続けます。'], ['必要な設定をする', '配線・本体設定・復元。あとで設定してもかまいません。'], ['目的の作業を始める', 'ログ、通信、信号、デバッグ。必要な道具へ進みます。']].map(([t, d]) => el('div', {}, el('h3', {}, t), p(d)))),
      p('起動後にUSBの構成が変わる場合は、必要な使用許可やケーブルの抜き差しを、同じ画面で案内します。', 'muted compact')),
    el('section', { class: 'section' }, el('div', { class: 'tech-block' }, el('div', {}, p('HOW OEP WORKS', 'eyebrow'), el('h2', {}, 'ボードごとの違いを、', el('br'), '共通の機能として扱う。'), p('プローブ自身が機能とピンの制約を伝え、アプリは理解できる機能を利用します。OEPは、特定のボードだけのための道具ではありません。'), el('a', { class: 'text-link', href: '#/learn' }, '技術の概要と資料へ →')),
      el('div', { class: 'tech-lines' }, ...[['機能を宣言する', '提供できる機能と、その条件を実機から取得。'], ['共通の方法で使う', 'USBやシリアルの上で、同じ意味の操作を利用。'], ['用途に合わせて拡張する', '標準interfaceと独自の機能を組み合わせる。']].map(([t, d]) => el('div', {}, el('strong', {}, t), el('small', {}, d))))))
  ];
}
function boardCard(b, select = false, compact = false) {
  return el('section', { class: `board-card${select && state.board === b.id ? ' selected' : ''}` },
    el('div', { class: 'board-meta' }, el('span', { class: 'chip-mark' }, b.code), badge(b.tag, b.installable ? '' : 'amber')),
    el('h3', {}, b.name), p(b.title), !compact ? p(b.description) : null,
    el('ul', {}, ...b.features.map(f => el('li', {}, f))), !compact ? p(b.note, 'compact') : null,
    actions(select ? button(state.board === b.id ? '選択中 ✓' : 'このボードを選ぶ', () => { state.board = b.id; state.selected = false; render(false); }, state.board === b.id ? 'primary' : '', { disabled: !b.installable, 'data-board': b.id })
      : button(b.installable ? 'このボードで始める →' : '導入済みの機器を使う', () => { state.board = b.id; state.selected = false; go(b.installable ? '/install/prepare' : '/connect'); }, '', { 'data-board': b.id })));
}
function boards() {
  return el('div', { class: 'page' }, heading('手元のボードから、始められます。', '配布ファームウェア、使える機能、導入方法はボードごとに異なります。違いを見ながら、目的に合うものを選んでください。', 'SUPPORTED BOARDS'),
    el('div', { class: 'two-grid' }, ...BOARDS.map(b => boardCard(b))),
    note('プローブのピンはMCUの電圧で動作します。相手と接続する前にGNDと電圧を確認してください。必要なレベル変換は、別途用意します。'),
    external('ボードごとの機能・ピン・検証範囲', DOCS[1][2]));
}
function usecases() {
  return el('div', { class: 'page' }, heading('何を確かめたいですか。', '使いたい信号の名前だけでなく、目的から作業を選べます。配線の登録は任意です。', 'WHAT YOU CAN DO'),
    el('div', { class: 'three-grid' }, ...TASKS.map(t => taskCard(t))),
    el('div', { class: 'guide-path' }, el('h2', {}, '波形・自動テスト・ターゲット固有の書き込み'), p('専用の道具と組み合わせる用途もあります。必要な環境と引き継ぐ情報を案内します。'), actions(link('外部ツールとの連携を見る', '/handoff'))));
}
function usecase(id) {
  const t = taskById(id);
  return el('div', { class: 'page' }, heading(t.title, t.description, `USE CASE / ${t.short}`),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'この作業でできること'), p(t.result), el('div', { class: 'terminal' }, '結果の表示例\n\n' + t.output)),
      panel(el('h2', {}, '用意するもの'), el('ul', {}, el('li', {}, 'この機能を提供するOEPプローブ'), el('li', {}, `${t.roles.join(' / ')}とGNDの配線`), el('li', {}, '電圧と接続条件を確認した相手のIC・基板')),
        p('相手の配線が決まっていれば、スキャンは不要です。保存済みの配線を呼び出すか、その場でピンを指定します。', 'muted'),
        actions(button('この作業を始める →', () => startTask(t.id), 'primary'), button('プローブを作るところから', () => { state.intent = t.id; go('/install/select'); })))),
    el('div', { class: 'guide-path' }, el('h2', {}, '操作の流れ'), el('ol', {}, ...['プローブに接続する', '配線と通信・信号の条件を確認する', `${t.action} → 結果を確認する`, t.stop].map(v => el('li', {}, v)))));
}
function learn() {
  return el('div', { class: 'page' }, heading('OEPは、ボードとソフトウェアの共通の約束です。', '組み込み開発に使うプローブの機能を、特定のボードやアプリの組み合わせに閉じず、共通の意味で公開・利用するための仕様です。', 'TECHNOLOGY & DOCUMENTATION'),
    el('div', { class: 'two-grid' }, heroDiagram(), el('div', {}, ...[['プローブが機能を伝える', '使えるinterface、ピン、範囲や制約を実機から読みます。すべてのボードに同じ機能があるとは限りません。'], ['ひとつの機器を、複数の道具で使う', 'ブラウザ、IDE、CLI、テストから利用できます。操作が競合しないよう、セッションと変更権で調整します。'], ['標準機能と独自機能を組み合わせる', '標準のデバッグ・通信・信号機能に加え、独自interfaceを追加できます。ターゲット固有のflash手順はhost側が担います。']].map(([t, d]) => el('section', { class: 'mb' }, el('h2', {}, t), p(d, 'muted'))))),
    el('section', { class: 'section' }, sectionTitle('詳しく知る・作ってみる。', '詳細は、それぞれの仕様・実装リポジトリへ。'), el('div', { class: 'link-list' }, ...DOCS.map(([t, d, href]) => el('a', { href, target: '_blank', rel: 'noopener', class: 'link-row' }, el('div', {}, el('h3', {}, t), p(d)), el('span', { class: 'arrow' }, '↗'))))));
}
function stepper(n) {
  return el('ol', { class: 'stepper', 'aria-label': 'プローブ作成の進行' }, ...['ボードを選ぶ', '接続・内容確認', '書き込み・起動', '初期設定'].map((t, i) => el('li', { class: i === n ? 'current' : i < n ? 'done' : '', 'aria-current': i === n ? 'step' : 'false' }, el('span', {}, i < n ? '✓' : String(i + 1)), t)));
}
function installAside() {
  const b = board();
  return el('aside', { class: 'install-aside' }, el('span', { class: 'chip-mark' }, b.code), el('h3', {}, b.name), p('今回プローブにするボード'),
    el('hr', { style: 'border:0;border-top:1px solid #cbdcd1;margin:20px 0' }), p('書き込んだ機器を引き継いで、初期設定へ進みます。'),
    p('ターゲットはまだつながなくてかまいません。'), badge('サンプル機器 / 実機操作なし', 'gray'));
}
function installFrame(n, content) {
  return el('div', { class: 'page' }, stepper(n), n === 0 ? content : el('div', { class: 'install-layout' }, el('div', {}, content), installAside()));
}
function install(view) {
  const b = board();
  if (view === 'select' && !b.installable) state.board = 'pico';
  if (view === 'select') return installFrame(0, [heading('どのボードをプローブにしますか。', '導入方法と特徴を見て選んでください。導入済みのプローブを使うときは、この選択は不要です。', 'CREATE A PROBE'),
    el('div', { class: 'two-grid' }, ...BOARDS.map(b => boardCard(b, true))), actions(link('選んだボードで次へ →', '/install/prepare', true), link('導入済みのプローブを使う', '/connect'))]);
  if (view === 'prepare') return installFrame(1, [heading(`${b.name}を用意する`, 'USBでつないだら、書き込み先を選びます。接続方式の種類を選ぶ必要はありません。', 'CREATE A PROBE'),
    panel(el('h2', {}, '最初にすること'), el('ol', { class: 'checklist' }, ...[b.install, 'ターゲットとの配線は、導入のあとで準備できます', '下のボタンから書き込み先の機器を選択'].map((t, i) => el('li', {}, el('span', { class: 'check' }, `0${i + 1}`), t))),
      b.id === 's3' ? note('持込画像の選択も今回は表示例です。ファイルの読込やアップロードは行いません。') : null,
      state.selected ? el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, b.code), el('div', {}, el('strong', {}, `${b.model} — 選択済み`), p(`${b.port} / デモ機器`))) : null,
      actions(button(state.selected ? '書き込み先を選び直す（デモ）' : '書き込み先を選ぶ（デモ）', () => { state.selected = true; render(false); announce('サンプルの書き込み先を選択しました'); }, state.selected ? '' : 'primary', { id: 'choose-device' }), state.selected ? link('内容を確認する →', '/install/review', true) : null)),
    actions(link('ボード選択に戻る', '/install/select'))]);
  if (!state.selected && ['review', 'writing'].includes(view)) return installFrame(1, [heading('書き込み先を選択してください', '先に、このボードの準備を行います。'), link('機器の選択へ', '/install/prepare', true)]);
  if (view === 'review') return installFrame(1, [heading('このボードにOEPを導入します。', '検出したチップと書き込む内容を確認します。今回は画面の動作だけを確認できます。', 'CREATE A PROBE'),
    panel(el('h2', {}, '導入内容'), keyValues([['対象', b.model], ['チップ', `${b.chip}（検出結果の例）`], ['ファームウェア', b.id === 's3' ? '持込画像（サンプル）' : 'OepProbe / 配布画像の例'], ['書き込み先', b.port], ['次の画面', '起動を確認し、そのまま初期設定へ']]),
      note('本番では画像の適合性と、既存の設定への影響を確認してから実行します。このプレビューでは書き込みません。'),
      actions(button('OEPの導入をプレビュー →', beginFlash, 'primary', { id: 'start-install' }), link('戻る', '/install/prepare')))]);
  if (view === 'writing') return installFrame(2, [heading('OEPを導入しています。', '書き込みから起動確認まで、同じ作業として続きます。', 'CREATE A PROBE'), panel(
    badge('進行表示のシミュレーション'), el('div', { class: 'progress-track', role: 'progressbar', 'aria-label': '導入の進行', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': state.progress }, el('div', { class: 'progress-fill', style: `width:${state.progress}%` })),
    el('div', { class: 'progress-label' }, el('span', {}, state.progress < 35 ? '画像とチップを確認しています' : state.progress < 90 ? 'ファームウェアを書き込んでいます' : 'OEPとしての起動を待っています'), `${state.progress}%`),
    el('ul', { class: 'checklist' }, ...['画像・チップを確認', '書き込み', '再起動・OEPの確認'].map((v, i) => el('li', {}, el('span', { class: 'check' }, state.progress >= [25, 90, 100][i] ? '✓' : '・'), v))))]);
  if (['permission', 'replug', 'timeout'].includes(view)) {
    const text = view === 'permission' ? ['起動したOEPへの接続を許可します。', '書き込みは完了しています。起動後のUSB機器として、ブラウザの使用許可を確認します。']
      : view === 'replug' ? ['USBをつなぎ直して、設定を続けます。', '書き込みは完了しています。USB構成が切り替わり、起動後の機器が一覧に現れない場合の案内です。']
      : ['書き込みは完了。起動を確認しています。', 'OEPの応答をまだ確認できていません。書き込みをやり直さず、同じ機器との接続を確認します。'];
    return installFrame(2, [heading(text[0], text[1], 'CONTINUE SETUP'),
      panel(el('div', { class: 'big-status' }, '✓'), badge('書き込み完了（デモ）'),
        el('h2', { class: 'mt' }, view === 'replug' ? '同じボードのUSBケーブルを、抜いて挿し直してください。' : view === 'permission' ? `${b.model}として起動したOEPを選びます。` : 'BOOTを離し、機器が起動していることを確認してください。'),
        p(view === 'replug' ? '実際に抜き差しする必要はありません。下のボタンで、再認識された状態を確認できます。' : 'USB / Serial / HIDや、ボードの種類を選び直す必要はありません。', 'muted'),
        actions(button(view === 'replug' ? 'つなぎ直した状態を確認（デモ）' : view === 'permission' ? '起動したOEPを許可（デモ）' : '同じ機器で再試行（デモ）', () => view === 'replug' ? go('/install/permission') : finishInstall(), 'primary', { id: 'continue-install' }))),
      note('目的と書き込み結果を保持して、初期設定へ進みます。再書き込みは行いません。')]);
  }
  return notFound();
}
function beginFlash() {
  clearInterval(flashTimer);
  state.flash = 'writing'; state.installation = true; state.connected = false; state.records = []; state.active = {}; state.operations = {};
  state.settings = {}; state.settingsApplied = false; state.settingsSaved = false; state.maintenance = ''; state.notice = ''; state.transferDone = false;
  state.progress = 0; state.handoff = state.scenario === 'auto' ? board().handoff : state.scenario;
  go('/install/writing');
  flashTimer = setInterval(() => { state.progress = Math.min(100, state.progress + 20);
    if (state.progress === 100) { clearInterval(flashTimer); state.flash = 'done'; if (state.handoff === 'direct') finishInstall(); else go(`/install/${state.handoff}`); }
    else if (currentRoute === '/install/writing') render(false);
  }, 450);
}
function finishInstall() { state.connected = true; state.connectedBoard = state.board; state.flash = 'done'; go('/setup'); }
function keyValues(rows) { return el('dl', { class: 'key-value' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])); }
function setup() {
  if (!state.connected) return needConnection('/setup');
  const choices = [
    ['01', '相手につなぐ配線を用意する', '接続名、相手の型番、信号とピンを登録します。相手は未接続でもかまいません。', '/connection/new?from=setup'],
    ['02', 'すぐに通信や信号を試す', 'ログを読む、センサと通信する、信号を出す。その場で配線を指定して試せます。', state.intent ? `/operate/${state.intent}` : '/operations'],
    ['03', 'プローブ本体を設定する', '待機時のピンやWi-Fiなど、使い方に必要な設定だけ整えます。', '/settings?from=setup'],
    ['04', '設定ファイルから戻す', '以前の設定を確認し、差分を見て復元します。', '/maintenance?from=setup'],
  ];
  return installFrame(3, [heading(state.installation ? 'OEPの導入が完了しました。' : '必要な設定から、始めましょう。', '次に何をしますか。すべてを設定する必要はありません。', 'READY TO CONFIGURE'),
    el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, board().code), el('div', {}, el('strong', {}, `${probeBoard().model} · 起動確認済み（デモ）`), p('機能・設定を読み込んだ状態のサンプル'))),
    state.notice ? note(state.notice) : null,
    el('div', { class: 'stack' }, ...choices.map(([num, title, desc, href]) => el('a', { class: 'setup-choice', href: `#${href}` }, el('span', { class: 'number' }, num), el('div', {}, el('h3', {}, title), p(desc)), el('span', { class: 'arrow' }, '→')))),
    actions(link('あとで設定する・作業ホームへ →', '/work')), p('配線を保存しても、ターゲットへの接続やピンの出力は始まりません。', 'muted compact mt')]);
}
function connect() {
  return el('div', { class: 'page' }, heading('手元のプローブを使う。', '導入済みの機器を選びます。ボードの種類と使える機能は、接続してから確認します。', 'CONNECT YOUR PROBE'),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'ブラウザから機器を選ぶ'), p('USBケーブルでプローブをつなぎ、一覧から使う個体を選びます。'),
      note('プレビューでは、接続済みのプローブと保存済み配線のサンプルを開きます。機器の許可は要求しません。'),
      actions(button('機器を選んで接続（デモ）', () => { state.connected = true; state.connectedBoard = state.board; if (!state.records.length) state.records = [sampleRecord()]; state.notice = ''; go(state.connectReturn); }, 'primary', { id: 'connect-demo' }))),
      panel(el('h2', {}, 'まだOEPを導入していない場合'), p('先に、ボードへOEPのファームウェアを入れます。書き込みのあと、そのまま設定を続けられます。'), actions(link('ボードをプローブにする', '/install/select')))),
    el('details', { class: 'panel mt' }, el('summary', {}, '一覧に機器が見つからないとき'), p('ケーブル、使用中のアプリ、機器の起動を確認します。OEPのUSB端子から接続する案内は、必要なときにここへ表示します。', 'mt'), button('OEPのUSB機器を選ぶ（デモ）', () => { state.connected = true; state.connectedBoard = state.board; state.records = state.records.length ? state.records : [sampleRecord()]; go(state.connectReturn); })));
}
function needConnection(returnTo) {
  state.connectReturn = returnTo;
  return el('div', { class: 'page' }, heading('プローブに接続して、続きを開きます。', '選んだ作業は保持されます。接続後にこの画面へ戻ります。'), actions(link('プローブを選ぶ（デモ）', '/connect', true), link('ボードから作る', '/install/select')));
}
function startTask(id) { if (!state.connected) state.connectReturn = `/operate/${id}`; go(state.connected ? `/operate/${id}` : '/connect'); }
function sampleRecord() { return { id: 'sample-sensor', name: 'sensor', part: 'I2C温度センサ（例）', note: 'ベンチ上のセンサ評価用。3.3 V / 共通GND。', groups: [{ type: 'i2c', pins: ['4', '5'] }] }; }
function workspaceShell(content) {
  const nav = [['/work', '作業ホーム'], ['/connections', '配線・接続先'], ['/operations', '目的別の操作'], ['/settings', '本体設定'], ['/maintenance', '更新・保守'], ['/handoff', '外部ツールとの連携']];
  const active = currentRoute.split('?')[0];
  return el('div', { class: 'workspace-layout' }, el('aside', { class: 'workspace-nav' }, el('h2', {}, 'YOUR WORKSPACE'), ...nav.map(([path, title]) => el('a', { href: `#${path}`, class: (active === path || path === '/connections' && active.startsWith('/connection/') || path === '/operations' && active.startsWith('/operate/')) ? 'active' : '' }, title))),
    el('main', { id: 'content', class: 'workspace-main', tabindex: -1 }, el('div', { class: 'device-status' }, el('div', {}, p(el('span', {}, el('span', { class: 'status-dot' }), state.connected ? `${probeBoard().model} · デモ接続中` : 'プローブ未接続')), el('small', { class: 'muted' }, state.connected ? '個体ID: demo-oep-01 / サンプルの機能・設定' : '操作を選ぶと接続へ案内します')),
      button(state.connected ? '接続を終了' : '接続する', () => { if (state.connected) { state.connected = false; state.active = {}; state.notice = 'デモ接続を終了しました。'; render(); } else { state.connectReturn = currentRoute; go('/connect'); } })),
      ...Object.keys(state.active).filter(id => state.active[id]).map(id => el('div', { class: 'active-work' }, el('strong', {}, `${taskById(id).short} · 使用中（デモ）`), el('a', { href: `#/operate/${id}`, class: 'text-link' }, '操作画面へ'), button('停止', () => stopTask(id)))), content));
}
function work() {
  if (!state.connected) return needConnection('/work');
  return [heading('このプローブで、何をしますか。', '保存した配線から続けることも、その場でピンを指定して試すこともできます。'),
    state.notice ? note(state.notice) : null,
    el('section', { class: 'form-group' }, el('div', { class: 'mini-heading' }, el('h2', {}, '配線・接続先'), el('a', { href: '#/connections', class: 'text-link' }, '一覧・編集 →')),
      state.records.length ? el('div', { class: 'stack' }, ...state.records.map(r => recordCard(r))) : emptyConnections()),
    el('section', {}, el('div', { class: 'mini-heading' }, el('h2', {}, '目的から操作を選ぶ'), el('a', { href: '#/operations', class: 'text-link' }, 'すべて見る →')), el('div', { class: 'three-grid' }, ...[TASKS[0], TASKS[1], TASKS[7]].map(t => taskCard(t, false)))),
    actions(link('初期設定の案内を開く', '/setup'), link('波形・外部ツールへ', '/handoff'))];
}
function emptyConnections() { return el('div', { class: 'empty' }, el('h3', {}, 'まだ配線を登録していません。'), p('相手の型番や、どの信号をどのピンにつなぐかを保存できます。', 'muted'), actions(link('配線を登録する →', '/connection/new', true), link('登録せずに操作する', '/operations'))); }
function wiringSummary(record) { return el('div', { class: 'wiring-summary' }, ...record.groups.flatMap(g => taskById(g.type).roles.map((r, i) => el('span', {}, `${r} → ${pinName(g.pins[i] ?? '—')}`)))); }
function recordCard(record) {
  return el('article', { class: 'connection-card' }, el('header', {}, el('div', {}, el('h2', {}, record.name), p(record.part || '相手の型番は未記入', 'muted mb0')), badge('タブ内に保存（デモ）')),
    wiringSummary(record), record.note ? p(record.note, 'compact muted') : null,
    actions(link('配線・相手の情報を編集', `/connection/${record.id}`, true), ...record.groups.map(g => button(`${taskById(g.type).short}で使う →`, () => { state.operations[g.type] = { ...(state.operations[g.type] ?? {}), recordId: record.id }; startTask(g.type); }))));
}
function connections() {
  if (!state.connected) return needConnection('/connections');
  return [heading('配線と、つなぐ相手を記録する。', '固定の配線を登録して、同じ作業に繰り返し使えます。相手が未接続でも編集・保存できます。'),
    state.notice ? note(state.notice) : null, state.records.length ? [actions(link('新しい配線を登録', '/connection/new', true)), el('div', { class: 'stack mt' }, ...state.records.map(r => recordCard(r)))] : emptyConnections()];
}
function editor(id, query) {
  if (!state.connected) return needConnection(`/connection/${id}`);
  if (!state.draft || state.draft.editId !== id) {
    const record = state.records.find(r => r.id === id);
    if (id !== 'new' && !record) return [heading('この配線は見つかりません。', '再読み込みすると、プレビュー中の記録は初期状態に戻ります。'), link('配線の一覧へ', '/connections')];
    state.returnTo = query.get('from') === 'setup' ? '/setup' : query.get('from')?.startsWith('operate-') ? `/operate/${query.get('from').slice(8)}` : '/connections';
    state.draft = { ...(record ? structuredClone(record) : { id: `connection-${Date.now()}`, name: '', part: '', note: '', groups: [{ type: 'uart', pins: ['1', '0'] }] }), editId: id }; state.dirty = false;
  }
  const d = state.draft;
  const update = (key, value) => { d[key] = value; state.dirty = true; };
  return [heading(id === 'new' ? '何を、どのピンにつなぎますか。' : `${d.name || '接続先'}の配線を編集`, '相手の情報と配線を、ひとつの場所で設定します。保存しても接続・出力は始まりません。'),
    el('form', { id: 'connection-form', onsubmit: e => { e.preventDefault(); saveRecord(); } },
      el('fieldset', { class: 'form-group' }, el('legend', {}, '01 / つなぐ相手'),
        el('div', { class: 'field-grid' }, field('接続名', d.name, v => update('name', v), '例: sensor / board-1。アドレスにも使う名前です。'), field('相手のIC・基板の型番（任意）', d.part, v => update('part', v), '例: CH32V003F4P6 / センサモジュール名。プローブ自身の型番ではありません。')),
        el('div', { class: 'mt' }, field('用途・配線メモ（任意）', d.note, v => update('note', v), 'コネクタ番号、電圧、用途など。型番やメモは人が読む記録です。', null, 'textarea'))),
      el('fieldset', { class: 'form-group' }, el('legend', {}, '02 / 信号とプローブ側のピン'), p('デバッグとUARTなど、複数の種類を一緒に登録できます。下のピン候補は構成例です。', 'muted'),
        ...d.groups.map((g, index) => el('section', { class: 'wire-group' }, el('div', { class: 'wire-head' }, el('h3', {}, taskById(g.type).short), button('この信号を外す', () => { d.groups.splice(index, 1); state.dirty = true; render(false); })),
          p(taskById(g.type).description, 'compact muted'), el('div', { class: 'wire-pins' }, ...taskById(g.type).roles.map((role, pinIndex) => field(role === 'RX' ? 'プローブRX ← 相手TX' : role === 'TX' ? 'プローブTX → 相手RX' : role, g.pins[pinIndex] ?? '', v => { g.pins[pinIndex] = v; state.dirty = true; }, '', [['', 'ピンを選ぶ'], ...Array.from({ length: 23 }, (_, n) => [String(n), pinName(n)])]))))),
        el('div', { class: 'mt' }, el('h3', {}, '信号を追加'), el('div', { class: 'choice-row' }, ...TASKS.filter(t => ['uart', 'debug', 'i2c', 'spi', 'gpio'].includes(t.id)).map(t => button(`＋ ${t.short}`, () => { d.groups.push({ type: t.id, pins: t.roles.map(() => '') }); state.dirty = true; render(false); }, '', { disabled: d.groups.some(g => g.type === t.id) }))))),
      el('div', { id: 'form-error', class: 'form-error', role: 'alert' }),
      note('配線の保存は、ターゲットの探索や接続を行いません。このプレビューでは、名前・型番・メモ・配線をこのタブだけに保持します。'),
      el('div', { class: 'save-bar' }, p('再読み込みすると、プレビュー中の記録はリセットされます。'), actions(button('キャンセル', () => discardThen(() => { state.draft = null; go(state.returnTo); })), el('button', { type: 'submit', class: 'btn primary' }, id === 'new' ? '配線を保存' : '変更を保存')))),
    el('details', { class: 'panel mt' }, el('summary', {}, 'デバッグ配線が分からない場合'), p('探索は任意です。実機版では候補ピンを指定し、信号を送ることを確認してから実行します。固定配線の登録には必要ありません。', 'mt'))];
}
function saveRecord() {
  const d = state.draft, name = d.name.trim(), pins = d.groups.flatMap(g => g.pins);
  let error = '';
  if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(name)) error = '接続名は英字で始まる、16文字以内の英数字・ハイフンにしてください。';
  else if (state.records.some(r => r.id !== d.id && r.name.toLowerCase() === name.toLowerCase())) error = 'その接続名はすでに使われています。別の名前にしてください。';
  else if (!d.groups.length || pins.some(v => v === '')) error = '信号を追加し、それぞれの役割にピンを選んでください。';
  else if (new Set(pins).size !== pins.length) error = '同じピンが複数の役割に選ばれています。配線を確認してください。';
  else if (state.records.some(r => r.id !== d.id && r.groups.some(g => g.pins.some(pin => pins.includes(pin))))) error = '他の接続先で使用しているピンが含まれています。別のピンを選んでください。';
  if (error) { document.getElementById('form-error').textContent = error; return; }
  const record = { id: d.id, name, part: d.part, note: d.note, groups: structuredClone(d.groups) };
  state.records = [...state.records.filter(r => r.id !== d.id), record]; state.dirty = false; state.draft = null;
  state.notice = `「${name}」を保存しました（このタブ内のデモ）。接続や出力は開始していません。`; go(state.returnTo);
}
function operations() { return [heading('目的に合う道具を開く。', '配線と条件を確認してから開始します。ここでは機能ごとの画面例を確認できます。'), el('div', { class: 'three-grid' }, ...TASKS.map(t => taskCard(t, false))), actions(link('波形・外部ツールはこちら', '/handoff'))]; }
function stopTask(id) { state.active[id] = false; state.operations[id] = { ...(state.operations[id] ?? {}), stopped: true }; render(false); announce('サンプルの操作を終了しました'); }
function operate(id) {
  const t = taskById(id);
  if (!state.connected) { state.connectReturn = `/operate/${id}`; return [heading(t.title, t.description), note('プローブに接続すると、この作業へ戻ります。'), actions(link('プローブを選ぶ（デモ）', '/connect', true), link('ボードをプローブにする', '/install/select'))]; }
  const o = state.operations[id] ??= { recordId: '', values: {} }; o.values ??= {};
  const records = state.records.filter(r => r.groups.some(g => g.type === id));
  const selected = records.find(r => r.id === o.recordId);
  return [heading(t.title, t.description),
    id === 'dac' && !['esp32', 'ch32'].includes(probeBoard().id) ? note('このボードにはDAC出力がありません。以下は、DAC対応プローブの操作画面例です。', 'amber') : null,
    el('div', { class: 'operation-grid' }, panel(el('h2', {}, '01 / 対象と配線'), field('使う配線', o.recordId ?? '', v => { o.recordId = v; render(false); }, '配線を選んでも、動作は始まりません。', [['', '保存せず、この場でピンを指定'], ...records.map(r => [r.id, `${r.name} — ${r.part || '型番未記入'}`])]),
      selected ? [wiringSummary(selected), link('この配線を編集', `/connection/${selected.id}?from=operate-${id}`)] : el('div', { class: 'wire-pins' }, ...t.roles.map((r, i) => field(r, o.values[`pin-${i}`] ?? String(i), v => { o.values[`pin-${i}`] = v; }, '', Array.from({ length: 23 }, (_, n) => [String(n), pinName(n)])))),
      el('h2', { class: 'mt' }, '02 / 条件'), ...t.options.map(([label, value]) => field(label, o.values[label] ?? value, v => { o.values[label] = v; })),
      actions(button(t.action, () => { o.result = true; o.stopped = false; o.snapshot = structuredClone(o.values); state.active[id] = !['counter', 'i2c', 'spi', 'gpio'].includes(id); render(false); announce('サンプル結果を表示しました'); }, 'primary', { id: 'start-operation' }), (o.result && !o.stopped) ? button(t.stop, () => stopTask(id)) : null)),
      panel(el('h2', {}, '03 / 状態と結果'), badge(o.stopped ? '終了（デモ）' : o.result ? (state.active[id] ? '使用中（デモ）' : '単発操作が完了（デモ）') : '未開始', o.result ? '' : 'gray'),
        el('div', { class: 'mt' }, o.result ? el('div', { class: 'terminal', role: 'log', 'aria-label': 'サンプル結果' }, o.stopped ? '使用を終了しました（デモ）。\n終了後のピン状態は本体設定と機能の仕様に従います。' : t.output) : el('div', { class: 'result-placeholder' }, 'まだ操作を開始していません。', el('br'), '左の配線と条件を確認してから実行します。')),
        o.result && !o.stopped && id === 'uart' ? [field('送る文字列', o.text ?? '', v => { o.text = v; }, '送信も画面上のシミュレーションです。'), button('送信する（デモ）', () => { o.sent = o.text || '(空)'; render(false); }), o.sent ? p(`送信例: ${o.sent}`, 'mt') : null] : null,
        o.result && !o.stopped && id === 'debug' ? actions(button('停止（デモ）', () => { o.debugState = '停止中'; render(false); }), button('再開（デモ）', () => { o.debugState = '実行中'; render(false); }), o.debugState ? badge(o.debugState) : null) : null,
        p('表示される結果は固定のサンプルです。入力した値による実際の送受信・計測は行いません。', 'compact muted mt'))),
    note('使用を終了しても、ピンの待機設定やデバッグ線の保持状態は別に扱います。実機版では終了後の状態を案内します。')];
}
function settings(query) {
  if (!state.connected) return needConnection('/settings');
  const update = (key, value) => { state.settings[key] = value; state.settingsApplied = false; state.settingsSaved = false; document.getElementById('settings-summary').textContent = '入力中・未適用'; (/** @type {HTMLButtonElement} */ (document.getElementById('save-settings'))).disabled = true; };
  return [heading('プローブ本体の動作を整える。', '配線の名前とは別に、待機時や次回起動後の動作を設定します。必要な項目だけ変更してください。'),
    note('ここは設定項目の構成例です。実機版では、接続したプローブが提供する設定だけを表示します。'),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, '空いているピンの状態'), p('治具の制御線など、機能が使っていないときの状態を設定します。', 'muted'),
      field('対象のピン', state.settings.pin ?? '4', v => update('pin', v), '', Array.from({ length: 23 }, (_, n) => [String(n), pinName(n)])),
      el('div', { class: 'mt' }, field('空き状態', state.settings.idle ?? 'hi-z', v => update('idle', v), '空いているピンには適用時に、使用中なら解放時に反映されます。', [['hi-z', 'Hi-Z（入力・pullなし）'], ['pull-up', 'pull-up'], ['pull-down', 'pull-down'], ['low', '出力 Low'], ['high', '出力 High']]))),
      panel(el('h2', {}, 'ネットワーク'), p('Wi-Fi対応の構成で、プローブをベンチのネットワークにつなぐ設定です。', 'muted'),
        field('SSID', state.settings.ssid ?? '', v => update('ssid', v), '入力はこのタブ内だけに保持します。'), el('div', { class: 'mt' }, field('パスワード', state.settings.password ?? '', v => update('password', v), '実際のパスワードを入力する必要はありません。', null, 'password')))),
    el('div', { class: 'save-bar mt' }, el('p', { id: 'settings-summary' }, state.settingsSaved ? '保存済み（デモ）' : state.settingsApplied ? '適用済み・永続保存はまだです（デモ）' : '入力中・未適用'), actions(button('現在の設定に適用（デモ）', () => { state.settingsApplied = true; render(false); }, 'primary'), button('次回起動用に保存（デモ）', () => { state.settingsSaved = true; render(false); }, '', { disabled: !state.settingsApplied, id: 'save-settings' }))),
    p('永続保存は、本体の現在の設定全体を保存する操作です。Wi-Fiを設定しても、このページから直接TCP接続できるわけではありません。', 'compact muted'),
    query.get('from') === 'setup' ? actions(link('初期設定の続きへ', '/setup')) : null];
}
function maintenance(query) {
  if (!state.connected) return needConnection('/maintenance');
  return [heading('更新・復元と、困ったときの確認。', '作業内容を確認してから実行し、終わったら同じプローブの作業に戻ります。'),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'ファームウェアの更新'), p(`${probeBoard().model}の画像と、設定を保持できる条件を確認します。`, 'muted'), badge('版・画像はプレビュー用'),
      actions(button('更新内容の確認例を見る', () => { state.maintenance = 'update'; render(false); }))),
      panel(el('h2', {}, '設定の控え・復元'), p('復元前に、別個体の設定や未対応の項目、上書き内容を確認します。', 'muted'), actions(button('設定ファイルの確認例を見る', () => { state.maintenance = 'restore'; render(false); })))),
    state.maintenance === 'restore' ? panel(el('h2', {}, '復元する変更の例'), keyValues([['配線', 'sensor: SDA → GP4 / SCL → GP5'], ['記録', '相手の型番・メモは別の保存対象'], ['秘密値', 'Wi-Fiパスワードは含まれていません']]), actions(button('この変更を適用（デモ）', () => { state.maintenance = 'restored'; render(false); }, 'primary'))) : null,
    state.maintenance === 'update' ? panel(el('h2', {}, '更新前の確認'), p('個体・チップ・revision・画像の適合性と、既存設定への影響を確認する画面です。'), note('今回は実際の更新を行いません。導入と同じ、起動後の接続引継ぎを使用します。'), button('更新後の状態を見る（デモ）', () => { state.maintenance = 'updated'; render(false); }, 'primary')) : null,
    ['restored', 'updated'].includes(state.maintenance) ? note(state.maintenance === 'restored' ? '復元を適用した状態の例です。次回起動にも残す場合は、本体設定で永続保存します。' : '更新後、同じ個体と起動版を確認した状態の例です。設定は維持されています。') : null,
    el('details', { class: 'panel mt' }, el('summary', {}, '診断・機能の宣言・保存領域'), p('通常の配線編集では開く必要はありません。接続状態や対応機能を調べ、問題を切り分けるための詳細画面です。', 'mt'), keyValues([['接続', '確認済み（デモ）'], ['個体ID', 'demo-oep-01'], ['保存領域', 'タブ内のサンプル'], ['記録', '秘密値を含まない診断情報を表示する想定']])),
    actions(link(query.get('from') === 'setup' ? '初期設定の続きへ' : '作業ホームへ戻る', query.get('from') === 'setup' ? '/setup' : '/work'))];
}
function handoff() {
  return [heading('目的に合う道具へ、つなぐ。', 'このページで整えたプローブと配線を、観測や開発・自動化にも使えます。', 'CONNECTED TOOLS'),
    el('div', { class: 'two-grid' }, panel(badge('ファイル表示 / ブラウザ'), el('h2', { class: 'mt' }, '取得した波形をWireSkeinで見る'), p('取得済みの .wireskein / .sr ファイルを、公開Viewerで表示します。ファイルを開くだけなら、このページの機器接続を終了する必要はありません。'), external('WireSkein Viewerを開く', 'https://open-embedded-probe.github.io/wireskein-web/')),
      panel(badge('取得・解析 / 外部環境'), el('h2', { class: 'mt' }, 'プローブから波形を取得する'), p('取得と高度な解析はPython側のWireSkeinを使います。公開Viewerだけで機器から取得することはできません。'), external('WireSkeinの導入・使い方', 'https://github.com/Open-Embedded-Probe/wireskein'))),
    el('section', { class: 'panel mt' }, el('h2', {}, 'IDEやPythonから使う'), p('ターゲット固有の書き込みや自動テストは、対応する開発ツールへ。個体と配線を特定する情報を確認できます。'),
      keyValues([['プローブ', state.connected ? `${probeBoard().model} / demo-oep-01` : 'プローブ未接続'], ['接続先', state.records.map(r => r.name).join(', ') || '配線は未登録'], ['アドレス例', `oep://demo-oep-01${state.records[0] ? '/' + state.records[0].name : ''}`]]),
      actions(external('Python・CLIの使い方', DOCS[5][2]), state.connected ? button('このページでの利用を終了して渡す（デモ）', () => { state.active = {}; state.connected = false; state.transferDone = true; render(false); }) : null),
      state.transferDone ? note('デモ接続と操作を終了しました。実機版では変更権と通信を解放して、別の道具で接続できる状態にします。') : null)];
}
function notFound() { return el('div', { class: 'page' }, heading('この画面は見つかりません。', '入口から、確認したい作業を選んでください。'), link('OEPの入口へ戻る', '/home', true)); }
function render(focus = true) {
  fieldCount = 0;
  const route = routeNow(); currentRoute = route;
  const [path, params] = route.split('?'), query = new URLSearchParams(params);
  const [, view, id] = path.split('/');
  const workspace = ['work', 'connections', 'connection', 'operations', 'operate', 'settings', 'maintenance', 'handoff'].includes(view);
  let content;
  if (view === 'home') content = home();
  else if (view === 'boards') content = boards();
  else if (view === 'learn') content = learn();
  else if (view === 'usecases') content = usecases();
  else if (view === 'usecase') content = usecase(id);
  else if (view === 'install') content = install(id);
  else if (view === 'setup') content = setup();
  else if (view === 'connect') content = connect();
  else if (view === 'work') content = work();
  else if (view === 'connections') content = connections();
  else if (view === 'connection') content = editor(id, query);
  else if (view === 'operations') content = operations();
  else if (view === 'operate') content = operate(id);
  else if (view === 'settings') content = settings(query);
  else if (view === 'maintenance') content = maintenance(query);
  else if (view === 'handoff') content = handoff();
  else content = notFound();
  document.getElementById('app').replaceChildren(...shell(content, workspace));
  document.title = `${document.querySelector('h1')?.textContent ?? 'OEP'} — 画面プレビュー`;
  if (focus) { window.scrollTo(0, 0); document.querySelector('h1')?.focus({ preventScroll: true }); }
}
document.addEventListener('click', event => {
  if (/** @type {Element} */ (event.target).closest('.skip')) { event.preventDefault(); document.getElementById('content')?.focus(); return; }
  const anchor = /** @type {Element} */ (event.target).closest('a[href^="#/"]');
  if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); go(anchor.getAttribute('href').slice(1));
});
window.addEventListener('hashchange', () => {
  const next = routeNow();
  if (state.dirty && next !== currentRoute) { history.replaceState(null, '', `#${currentRoute}`); discardThen(() => { location.hash = next; }); return; }
  if (currentRoute.startsWith('/connection/') && !next.startsWith('/connection/')) state.draft = null;
  if (currentRoute === '/install/writing' && next !== currentRoute && state.flash === 'writing') { clearInterval(flashTimer); state.flash = 'idle'; }
  render();
});
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
render(false);
