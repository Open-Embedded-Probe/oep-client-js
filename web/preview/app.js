import { BOARDS, TASKS, DEBUG_WIRES, LOGIC_TASK, CONSOLE_TASK, ANALOG_TASK, LOG_PATHS, GUIDE_BASE, SETUP_PATTERNS, USE_CASE_DETAILS, SCENARIOS, DOCS } from './data.js';

// Isolated interaction prototype: no OEP library, device API, firmware download or persistent device settings.
/** @type {any} */
const state = { board: 'p4', connectedBoard: 'p4', scenario: 'auto', connected: false, selected: false, installation: false,
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
const taskById = id => [LOGIC_TASK, CONSOLE_TASK, ANALOG_TASK, ...TASKS].find(t => t.id === id) ?? TASKS[0];
const wireById = id => DEBUG_WIRES.find(w => w.id === id);
const groupSpec = g => ['debug', 'console'].includes(g.type) ? { ...taskById(g.type), ...(wireById(g.wire) ?? { short: 'デバッグ方式を選択', roles: [] }) } : taskById(g.type);
const pinChoices = () => Array.from({ length: 23 }, (_, n) => [String(n), pinName(n)]);
const groupPins = g => [...g.pins.filter(Boolean), ...(g.resetPin ? [g.resetPin] : [])];
const groupOptions = g => taskById(g.type).options;
function debugChoices(onChoose, selected = '', consoleOnly = false) {
  return el('div', { class: 'three-grid debug-choices' }, ...DEBUG_WIRES.filter(w => !consoleOnly || w.id !== 'swd').map(w => el('button', { type: 'button', class: `pattern-card${selected === w.id ? ' selected' : ''}`, 'data-wire': w.id, 'aria-pressed': selected === w.id, onclick: () => onChoose(w.id) },
    el('strong', {}, w.title), el('span', {}, w.description), el('span', { class: 'pattern-next' }, `${w.roles.join(' + ')} / GND共通`), el('small', {}, w.note))));
}
function patternChoices(from = 'setup') {
  return [el('div', { class: 'two-grid' }, ...SETUP_PATTERNS.map(t => el('a', { class: 'pattern-card', href: '#' + (from === 'public' ? `/usecase/${t.id}` : `${purposeRoute(t.id)}${purposeRoute(t.id).includes('?') ? '&' : '?'}from=${from}`), 'data-pattern': t.id },
    el('small', { class: 'eyebrow' }, t.label), el('strong', {}, t.title), el('span', {}, t.description), el('span', { class: 'pattern-next' }, t.next + ' →'))))];
}
function purposeRoute(id) {
  if (['debug', 'logs', 'logic', 'bus', 'signal'].includes(id)) return `/setup/${id}`;
  return `/setup/task?task=${id}`;
}
const purposeTitle = id => SETUP_PATTERNS.find(t => t.id === id)?.title ?? taskById(id).title;
const installRoute = () => '/install/select' + (state.intent ? '?purpose=' + state.intent : '');
function choosePurpose(id) {
  const next = purposeRoute(id);
  state.intent = state.connected ? '' : id; state.connectReturn = next;
  go(state.connected ? next : '/connect');
}
function finishConnect() {
  state.connected = true; state.connectedBoard = state.board;
  if (!state.records.length) state.records = [sampleRecord()];
  const next = state.connectReturn;
  state.notice = ''; state.intent = ''; state.connectReturn = '/work'; go(next);
}
function installationContext() {
  return state.intent ? panel(badge('導入後に続ける用途'), el('h2', {}, purposeTitle(state.intent)), p('書き込みと起動確認が終わると、この用途の設定に進みます。'), button('用途を選び直す', () => { state.intent = ''; go('/usecases'); })) : null;
}
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
      button('最初からやり直す', () => discardThen(() => { clearInterval(flashTimer); Object.assign(state, { board: 'p4', connectedBoard: 'p4', connected: false, selected: false, installation: false, flash: 'idle', progress: 0, records: [], draft: null, dirty: false, active: {}, operations: {}, settings: {}, capture: null, passthrough: null, settingsApplied: false, settingsSaved: false, notice: '', intent: '', connectReturn: '/work', transferDone: false, maintenance: '' }); location.hash = '/home'; render(); })),
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
      ...patternChoices('public'), actions(link('自動テスト・開発ツールを知る', '/learn'))),
    el('section', { class: 'section' }, sectionTitle('これから用意するなら、ESP32-P4。', '推奨ボードはESP32-P4です。手元の対応ボードからも始められます。導入済みなら、種類を選ばず接続できます。', 'BOARDS'),
      el('div', { class: 'three-grid' }, ...BOARDS.slice(0, 3).map(b => boardCard(b, false, true))), actions(link('すべてのボードと制約を見る', '/boards'))),
    el('section', { class: 'section' }, sectionTitle('書き込んだら、そのまま設定へ。', 'ターゲットがまだなくても、配線の登録はできます。', 'GET STARTED'),
      el('div', { class: 'steps-overview' }, ...[['ボードをつなぐ', '書き込みに使う機器を、ブラウザから一度選択。'], ['OEPを導入する', 'ファームウェアイメージとチップを確認し、書き込みから起動まで続けます。'], ['用途に合わせて設定する', 'デバッグ・ロジックアナライザ・UART転送など、使い方から配線と条件を準備。'], ['目的の作業を始める', 'ログ、通信、信号、デバッグ。必要な道具へ進みます。']].map(([t, d]) => el('div', {}, el('h3', {}, t), p(d)))),
      p('起動後にUSBの構成が変わる場合は、必要な使用許可やケーブルの抜き差しを、同じ画面で案内します。', 'muted compact')),
    el('section', { class: 'section' }, el('div', { class: 'tech-block' }, el('div', {}, p('HOW OEP WORKS', 'eyebrow'), el('h2', {}, 'ボードごとの違いを、', el('br'), '共通の機能として扱う。'), p('プローブ自身が機能とピンの制約を伝え、アプリは理解できる機能を利用します。OEPは、特定のボードだけのための道具ではありません。'), el('a', { class: 'text-link', href: '#/learn' }, '技術の概要と資料へ →')),
      el('div', { class: 'tech-lines' }, ...[['機能を宣言する', '提供できる機能と、その条件を実機から取得。'], ['共通の方法で使う', 'USBやシリアルの上で、同じ意味の操作を利用。'], ['用途に合わせて拡張する', '標準interfaceと独自の機能を組み合わせる。']].map(([t, d]) => el('div', {}, el('strong', {}, t), el('small', {}, d))))))
  ];
}
function boardCard(b, select = false, compact = false) {
  return el('section', { class: `board-card${b.recommended ? ' recommended' : ''}${select && state.board === b.id ? ' selected' : ''}` },
    el('div', { class: 'board-meta' }, el('span', { class: 'chip-mark' }, b.code), badge(b.tag, b.installable ? '' : 'amber')),
    el('h3', {}, b.name), p(b.title), !compact ? p(b.description) : null,
    el('ul', {}, ...b.features.map(f => el('li', {}, f))), !compact ? p(b.note, 'compact') : null,
    actions(select ? button(state.board === b.id ? '選択中 ✓' : 'このボードを選ぶ', () => { state.board = b.id; state.selected = false; render(false); }, state.board === b.id ? 'primary' : '', { disabled: !b.installable, 'data-board': b.id })
      : button(b.installable ? 'このボードで始める →' : '導入済みの機器を使う', () => { state.board = b.id; state.selected = false; state.intent = ''; state.connectReturn = '/work'; go(b.installable ? '/install/prepare' : '/connect'); }, '', { 'data-board': b.id })));
}
function boards() {
  return el('div', { class: 'page' }, heading('手元のボードから、始められます。', '配布ファームウェア、使える機能、導入方法はボードごとに異なります。違いを見ながら、目的に合うものを選んでください。', 'SUPPORTED BOARDS'),
    el('div', { class: 'two-grid' }, ...BOARDS.map(b => boardCard(b))),
    note('プローブのピンはMCUの電圧で動作します。相手と接続する前にGNDと電圧を確認してください。必要なレベル変換は、別途用意します。'),
    external('ボードごとの機能・ピン・検証範囲', DOCS[1][2]));
}
function usecases() {
  return el('div', { class: 'page' }, heading('何を確かめたいですか。', '目的を選ぶと、用意するもの、このページでできる範囲、その後の手順が分かります。まだプローブがなくても読めます。', 'WHAT YOU CAN DO'),
    ...patternChoices('public'),
    el('div', { class: 'guide-path' }, el('h2', {}, '治具・自動テストとして使う'), p('毎回使う配線や待機状態を準備し、開発環境・スクリプトと組み合わせられます。'), external('用途別ガイドの全体を見る', GUIDE_BASE + 'use-cases.ja.md'), link('技術と開発ツールを見る', '/learn')));
}
function usecase(id) {
  const pattern = SETUP_PATTERNS.find(t => t.id === id), detail = USE_CASE_DETAILS[id];
  if (pattern && detail) return el('div', { class: 'page' }, heading(pattern.title, detail.example, `USE CASE / ${pattern.label}`),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, '得られるもの'), p(detail.result), el('h2', {}, 'このページと、組み合わせる道具'), p(detail.scope)),
      panel(el('h2', {}, '用意するもの'), p(detail.needs), p('配線の準備はターゲット未接続でもできます。使える機能はプローブとファームウェアにより異なります。', 'muted'))),
    el('section', { class: 'panel mt' }, el('h2', {}, 'この用途の進め方'), el('ol', { class: 'checklist' }, ...detail.steps.map((text, i) => el('li', {}, el('span', { class: 'check' }, i + 1), text)))),
    actions(link('この用途でプローブを作る →', `/install/select?purpose=${id}`, true), button(state.connected ? '接続中のプローブで準備する →' : '導入済みのプローブで準備する →', () => choosePurpose(id))),
    external('詳しい手順・対応範囲', GUIDE_BASE + detail.guide), link('ほかの用途を見る', '/usecases'));
  const t = [CONSOLE_TASK, ANALOG_TASK, ...TASKS].find(t => t.id === id);
  if (!t) return notFound();
  return el('div', { class: 'page' }, heading(t.title, t.description, `USE CASE / ${t.short}`),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'この作業でできること'), p(t.result), t.output ? el('div', { class: 'terminal' }, '結果の表示例\n\n' + t.output) : null),
      panel(el('h2', {}, '用意するもの'), el('ul', {}, el('li', {}, 'この機能を提供するOEPプローブ'), el('li', {}, t.roles.length ? `${t.roles.join(' / ')}とGNDの配線` : '相手のデバッグ方式に合う信号線とGND'), el('li', {}, '電圧と接続条件を確認した相手のIC・基板')),
        p('固定配線が分かっていれば、スキャンや配線名の登録は不要です。', 'muted'))),
    actions(link('この用途でプローブを作る →', `/install/select?purpose=${id}`, true), button(state.connected ? '接続中のプローブで準備する →' : '導入済みのプローブで準備する →', () => choosePurpose(id))), link('用途の一覧に戻る', '/usecases'));
}
function learn() {
  return el('div', { class: 'page' }, heading('OEPは、ボードとソフトウェアの共通の約束です。', '組み込み開発に使うプローブの機能を、特定のボードやアプリの組み合わせに閉じず、共通の意味で公開・利用するための仕様です。', 'TECHNOLOGY & DOCUMENTATION'),
    el('div', { class: 'two-grid' }, heroDiagram(), el('div', {}, ...[['プローブが機能を伝える', '使えるinterface、ピン、範囲や制約を実機から読みます。すべてのボードに同じ機能があるとは限りません。'], ['ひとつの機器を、複数の道具で使う', 'ブラウザ、IDE、CLI、テストから利用できます。操作が競合しないよう、セッションと変更権で調整します。'], ['標準機能と独自機能を組み合わせる', '標準のデバッグ・通信・信号機能に加え、独自interfaceを追加できます。ターゲット固有のflash手順はhost側が担います。']].map(([t, d]) => el('section', { class: 'mb' }, el('h2', {}, t), p(d, 'muted'))))),
    el('section', { class: 'section' }, sectionTitle('詳しく知る・作ってみる。', '詳細は、それぞれの仕様・実装リポジトリへ。'), el('div', { class: 'link-list' }, ...DOCS.map(([t, d, href]) => el('a', { href, target: '_blank', rel: 'noopener', class: 'link-row' }, el('div', {}, el('h3', {}, t), p(d)), el('span', { class: 'arrow' }, '↗'))))));
}
function stepper(n) {
  return el('ol', { class: 'stepper', 'aria-label': 'プローブ作成の進行' }, ...['ボードを選ぶ', '接続・内容確認', '書き込み・起動', '初期設定'].map((t, i) => el('li', { class: i === n ? 'current' : i < n ? 'done' : '', 'aria-current': i === n ? 'step' : 'false' }, el('span', {}, i < n ? '✓' : String(i + 1)), t)));
}
function installAside(configure = false) {
  const b = configure ? probeBoard() : board();
  return el('aside', { class: 'install-aside' }, el('span', { class: 'chip-mark' }, b.code), el('h3', {}, b.name), p(configure ? '接続中のプローブ' : '今回プローブにするボード'),
    el('hr', { style: 'border:0;border-top:1px solid #cbdcd1;margin:20px 0' }), p(configure ? 'この機器で使う配線と条件を準備します。画面を開いただけでは動作を開始しません。' : '書き込んだ機器を引き継いで、初期設定へ進みます。'),
    p('ターゲットはまだつながなくてかまいません。'), !configure ? installationContext() : null, badge('サンプル機器 / 実機操作なし', 'gray'));
}
function installFrame(n, content) {
  return el('div', { class: 'page' }, state.installation || n < 3 ? stepper(n) : null, n === 3 && state.flash === 'done' ? note('✓ OEPの導入完了 · 同じ機器に接続中（デモ）') : null, n === 0 ? content : el('div', { class: 'install-layout' }, el('div', {}, content), installAside(n === 3)));
}
function install(view, query) {
  if (view === 'select') {
    const requested = query.get('purpose');
    state.intent = [...SETUP_PATTERNS, CONSOLE_TASK, ANALOG_TASK, ...TASKS].some(t => t.id === requested) ? requested : '';
    state.connectReturn = state.intent ? purposeRoute(state.intent) : '/work';
  }
  const b = board();
  if (view === 'select' && !b.installable) state.board = 'p4';
  if (view === 'select') return installFrame(0, [heading('どのボードをプローブにしますか。', '導入方法と特徴を見て選んでください。導入済みのプローブを使うときは、この選択は不要です。', 'CREATE A PROBE'),
    installationContext(), note('これから用意するならESP32-P4を推奨します。デバッグ・UART転送・ロジック観測など、幅広い用途に使えます。'),
    el('div', { class: 'two-grid' }, ...BOARDS.map(b => boardCard(b, true))), actions(link('選んだボードで次へ →', '/install/prepare', true), link('導入済みのプローブを使う', '/connect'))]);
  if (view === 'prepare') return installFrame(1, [heading(`${b.name}を用意する`, 'USBでつないだら、書き込み先を選びます。接続方式の種類を選ぶ必要はありません。', 'CREATE A PROBE'),
    panel(el('h2', {}, '最初にすること'), el('ol', { class: 'checklist' }, ...[b.install, 'ターゲットとの配線は、導入のあとで準備できます', '下のボタンから書き込み先の機器を選択'].map((t, i) => el('li', {}, el('span', { class: 'check' }, `0${i + 1}`), t))),
      b.id === 's3' ? note('持込ファームウェアイメージの選択も今回は表示例です。ファイルの読込やアップロードは行いません。') : null,
      state.selected ? el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, b.code), el('div', {}, el('strong', {}, `${b.model} — 選択済み`), p(`${b.port} / デモ機器`))) : null,
      actions(button(state.selected ? '書き込み先を選び直す（デモ）' : '書き込み先を選ぶ（デモ）', () => { state.selected = true; render(false); announce('サンプルの書き込み先を選択しました'); }, state.selected ? '' : 'primary', { id: 'choose-device' }), state.selected ? link('内容を確認する →', '/install/review', true) : null)),
    actions(link('ボード選択に戻る', installRoute()))]);
  if (!state.selected && ['review', 'writing'].includes(view)) return installFrame(1, [heading('書き込み先を選択してください', '先に、このボードの準備を行います。'), link('機器の選択へ', '/install/prepare', true)]);
  if (view === 'review') return installFrame(1, [heading('このボードにOEPを導入します。', '検出したチップと書き込む内容を確認します。今回は画面の動作だけを確認できます。', 'CREATE A PROBE'),
    panel(el('h2', {}, '導入内容'), keyValues([['対象', b.model], ['チップ', `${b.chip}（検出結果の例）`], ['ファームウェア', b.id === 's3' ? '持込ファームウェアイメージ（サンプル）' : 'OepProbe / 配布ファームウェアイメージの例'], ['書き込み先', b.port], ['次の画面', '起動を確認し、そのまま初期設定へ']]),
      note('本番ではファームウェアイメージの適合性と、既存の設定への影響を確認してから実行します。このプレビューでは書き込みません。'),
      actions(button('OEPの導入をプレビュー →', beginFlash, 'primary', { id: 'start-install' }), link('戻る', '/install/prepare')))]);
  if (view === 'writing') return installFrame(2, [heading('OEPを導入しています。', '書き込みから起動確認まで、同じ作業として続きます。', 'CREATE A PROBE'), panel(
    badge('進行表示のシミュレーション'), el('div', { class: 'progress-track', role: 'progressbar', 'aria-label': '導入の進行', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': state.progress }, el('div', { class: 'progress-fill', style: `width:${state.progress}%` })),
    el('div', { class: 'progress-label' }, el('span', {}, state.progress < 35 ? 'ファームウェアイメージとチップを確認しています' : state.progress < 90 ? 'ファームウェアを書き込んでいます' : 'OEPとしての起動を待っています'), `${state.progress}%`),
    el('ul', { class: 'checklist' }, ...['ファームウェアイメージ・チップを確認', '書き込み', '再起動・OEPの確認'].map((v, i) => el('li', {}, el('span', { class: 'check' }, state.progress >= [25, 90, 100][i] ? '✓' : '・'), v))))]);
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
  state.capture = null; state.passthrough = null; state.settings = {}; state.settingsApplied = false; state.settingsSaved = false; state.maintenance = ''; state.notice = ''; state.transferDone = false;
  state.progress = 0; state.handoff = state.scenario === 'auto' ? board().handoff : state.scenario;
  go('/install/writing');
  flashTimer = setInterval(() => { state.progress = Math.min(100, state.progress + 20);
    if (state.progress === 100) { clearInterval(flashTimer); state.flash = 'done'; if (state.handoff === 'direct') finishInstall(); else go(`/install/${state.handoff}`); }
    else if (currentRoute === '/install/writing') render(false);
  }, 450);
}
function finishInstall() {
  state.connected = true; state.connectedBoard = state.board; state.flash = 'done';
  const next = state.intent ? purposeRoute(state.intent) : '/setup';
  state.notice = 'OEPの導入が完了しました。同じ接続のまま、用途の設定を続けられます（デモ）。';
  state.intent = ''; go(next);
}
function keyValues(rows) { return el('dl', { class: 'key-value' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])); }
function setup(view, query) {
  if (!state.connected) return needConnection(currentRoute);
  if (view === 'ready') {
    const record = state.records.find(r => r.id === query.get('record'));
    if (!record) return [heading('保存した配線を確認してください。', '再読み込みするとプレビューの記録は消えます。'), link('利用パターンへ', '/setup')];
    return installFrame(3, [heading('用途に合わせた設定ができました。', 'ターゲットが未接続でも、ここまで設定できます。接続や出力はまだ開始していません。', 'READY TO USE'),
      note(state.notice), panel(el('h2', {}, record.name), p(record.part || '相手の型番は未記入'), wiringSummary(record)),
      actions(button(record.purpose === 'logic' ? '取得条件とWireSkeinへの引継ぎへ →' : `${groupSpec(record.groups.find(g => g.type === record.purpose) ?? record.groups[0]).short}の操作へ →`, () => startTask(record.purpose), 'primary'), link('配線を編集する', `/connection/${record.id}`), link('別の利用パターンも設定する', '/setup')), link('あとで使う・作業ホームへ', '/work')]);
  }
  const pattern = SETUP_PATTERNS.find(t => t.id === view);
  if (pattern?.tasks) return installFrame(3, [heading(pattern.title, '目的に合う方式を選ぶと、その配線と条件へ進みます。', 'SETUP / USE CASE'),
    el('div', { class: 'two-grid' }, ...pattern.tasks.map(id => { const t = taskById(id); return el('a', { class: 'pattern-card', href: `#/setup/task?task=${id}&from=${query.get('from') === 'connections' ? 'connections' : 'setup'}` }, el('strong', {}, t.title), el('span', {}, t.description), el('span', { class: 'pattern-next' }, `${t.short}の配線と条件へ →`)); })),
    actions(link('利用パターンに戻る', query.get('from') === 'connections' ? '/connection/new' : '/setup'))]);
  if (['logs', 'logic', 'task'].includes(view)) return setupPath(view, query);
  if (view === 'debug') return installFrame(3, [heading('ターゲットのデバッグ方式を選ぶ。', 'プローブの種類ではなく、つなぐ相手の方式です。型番の資料を確認し、必要な信号を選びます。', 'SETUP / DEBUG'),
    debugChoices(wire => go(`/setup/task?task=debug&wire=${wire}&from=${query.get('from') === 'connections' ? 'connections' : 'setup'}`)),
    note('2線・1線はデバッグ信号の数です。どの方式もGNDを共通にし、電圧を確認します。例示した系列のすべての型番への対応を保証するものではありません。'),
    actions(link('利用パターンに戻る', query.get('from') === 'connections' ? '/connection/new' : '/setup'))]);
  return installFrame(3, [heading(state.installation ? 'OEPの導入が完了しました。' : 'このプローブを、何に使いますか。', 'まず利用パターンを選びます。用途に合う配線と条件を整えて、そのまま作業へ進みます。', 'READY TO CONFIGURE'),
    el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, probeBoard().code), el('div', {}, el('strong', {}, `${probeBoard().model} · 起動確認済み（デモ）`), p('同じ接続のまま設定を続けます。ターゲットは未接続でかまいません。'))),
    state.notice ? note(state.notice) : null,
    el('h2', {}, 'どのように使いますか？'), ...patternChoices(),
    panel(el('h2', {}, '治具・ほかの環境で使う'), actions(link('据え置き治具の設定順を確認', '/fixture'), link('自動テスト・開発ツールへ', '/handoff'), link('ネットワーク設定', '/settings?from=setup')), external('用途別ガイド', GUIDE_BASE + 'use-cases.ja.md')),
    p('用途はひとつに固定されません。後から追加でき、同じ相手にデバッグとUARTなどを組み合わせられます。', 'muted mt'),
    el('details', { class: 'panel mt' }, el('summary', {}, '本体設定・復元・配線を保存せず試す'), actions(link('プローブ本体を設定する', '/settings?from=setup'), link('設定ファイルから戻す', '/maintenance?from=setup'), link('配線を保存せず試す', '/operations'))),
    actions(link('あとで設定する・作業ホームへ →', '/work'))]);
}
function setupPath(view, query) {
  if (view === 'logs') return installFrame(3, [heading('相手のログを、どの方法で見ますか。', '相手が出すログと、読みたい道具に合わせて選びます。'),
    el('div', { class: 'stack' }, ...LOG_PATHS.map(([id, title, description]) => el('a', { class: 'pattern-card', 'data-log-path': id, href: id === 'passthrough' ? '#/passthrough' : `#/setup/task?task=${id}` }, el('strong', {}, title), el('span', {}, description)))), external('ログ取得・素通しの説明', GUIDE_BASE + 'use-cases.ja.md#2-相手のログを見るコマンドを送る')]);
  if (view === 'logic') return installFrame(3, [heading('どのように波形を取りますか。', 'キャプチャだけなら、本体設定も配線名の登録も不要です。'),
    el('div', { class: 'two-grid' }, ...[
      ['standalone', '今回だけ、ピンを直接選んで取る', '信号名・ピン・取得条件を指定してWireSkeinへ。本体には何も保存しません。'],
      ['named', '登録済みの配線を観測する', 'デバッグやUARTなどの配線を、その名前で観測します。ロジック取得は出力せず、使用中のピンも観測できます。'],
      ['during', '操作の最中の波形を取る', '書き込み・リセット・通信とキャプチャを、同じPython処理で実行します。'],
      ['test', '波形を自動テストで照合する', 'WireSkeinとpytestで記録・期待値・合否を残します。']
    ].map(([mode, title, description]) => el('a', { class: 'pattern-card', 'data-capture-mode': mode, href: `#/capture?mode=${mode}` }, el('strong', {}, title), el('span', {}, description)))), external('キャプチャの使い分け', GUIDE_BASE + 'capture.ja.md')]);
  const id = query.get('task') ?? 'uart', t = taskById(id), wire = query.get('wire');
  if (id === 'console' && !wireById(wire)) return installFrame(3, [heading('ログを出す相手のデバッグ線を選ぶ。', 'WCHのRVSWDまたは1線DIO（SWIO）を使います。'), debugChoices(w => go(`/setup/task?task=console&wire=${w}`), '', true)]);
  if (id === 'analog') return installFrame(3, [heading(t.title, t.description), note('ロジックとの同一ピン共有はできません。同じ信号を同時に見るなら別々のピンに接続します。'), actions(link('アナログ取得の準備へ', '/capture?mode=analog', true))]);
  return installFrame(3, [heading(t.title, t.description), wire ? panel(badge(wireById(wire)?.title ?? wire), p(wireById(wire)?.note)) : null,
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'まず一度使う'), p('操作画面でピンと条件を指定します。名前の登録は不要で、画面を開いても動作は始まりません。'), button('保存せず操作の準備へ →', () => { state.operations[id] = { values: {}, wire, recordId: '' }; startTask(id); }, 'primary')),
      panel(el('h2', {}, '同じ相手を繰り返し使う'), p('配線に名前を付け、相手の型番やメモを記録します。速度やアドレスは、操作を始める画面で決めます。'), link('配線に名前を付ける →', `/connection/new?purpose=${id}${wire ? '&wire=' + wire : ''}&from=${query.get('from') === 'connections' ? 'connections' : 'setup'}`))),
    actions(link('利用パターンに戻る', '/setup'))]);
}
function fixture() {
  if (!state.connected) return needConnection('/fixture');
  return [heading('プローブを据え置きの治具にする。', '毎回同じ配線・待機状態で使うための本体設定です。ターゲットが未接続でも準備できます。'),
    el('div', { class: 'stack' }, ...[
      ['1', '触らせないピンを決める', 'LED・ボタン・起動用の端子など、使わせないピンを指定します。', '/settings?section=disable'],
      ['2', '配線に名前を付ける', '相手ごとに接続名を付けます。分かっている固定配線を登録すれば、スキャンは不要です。', '/connections'],
      ['3', '空き時間のピン状態を決める', 'BOOT0、リセット、チップセレクトなどの待機状態を決めます。', '/settings?section=idle'],
      ['4', '必要ならログを素通しする', 'セッションがない間だけ、普通のシリアルモニタへログを流します。', '/passthrough'],
      ['5', '保存して控えを取る', '本体の現在値全体を保存し、更新・別個体への移行に備えます。秘密値は控えに含めません。', '/maintenance?from=fixture']
    ].map(([num, title, desc, route]) => el('a', { class: 'setup-choice', href: '#' + route }, el('span', { class: 'number' }, num), el('div', {}, el('h3', {}, title), p(desc)), el('span', { class: 'arrow' }, '→')))),
    note('画面を開いただけでは設定を適用しません。適用するとその場で効き、保存すると再起動後も残る、という違いを確認してください。'), external('治具として据え置く手順', GUIDE_BASE + 'use-cases.ja.md#10-プローブを治具として据え置く')];
}
function connect() {
  return el('div', { class: 'page' }, heading('手元のプローブを使う。', '導入済みの機器を選びます。ボードの種類と使える機能は、接続してから確認します。', 'CONNECT YOUR PROBE'),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'ブラウザから機器を選ぶ'), p('USBケーブルでプローブをつなぎ、一覧から使う個体を選びます。'),
      note('プレビューでは、接続済みのプローブと保存済み配線のサンプルを開きます。機器の許可は要求しません。'),
      actions(button('機器を選んで接続（デモ）', finishConnect, 'primary', { id: 'connect-demo' }))),
      panel(el('h2', {}, 'まだOEPを導入していない場合'), p('先に、ボードへOEPのファームウェアを入れます。書き込みのあと、そのまま設定を続けられます。'), actions(link('ボードをプローブにする', installRoute())))),
    el('details', { class: 'panel mt' }, el('summary', {}, '一覧に機器が見つからないとき'), p('ケーブル、使用中のアプリ、機器の起動を確認します。OEPのUSB端子から接続する案内は、必要なときにここへ表示します。', 'mt'), button('OEPのUSB機器を選ぶ（デモ）', finishConnect)));
}
function needConnection(returnTo) {
  state.connectReturn = returnTo;
  const [path, params] = returnTo.split('?'), query = new URLSearchParams(params), id = path.split('/')[2];
  state.intent = path.startsWith('/setup/') ? (id === 'task' ? query.get('task') : id) : path.startsWith('/capture') ? (query.get('mode') === 'analog' ? 'analog' : 'logic') : '';
  return el('div', { class: 'page' }, heading('プローブに接続して、続きを開きます。', '選んだ作業は保持されます。接続後にこの画面へ戻ります。'), actions(link('プローブを選ぶ（デモ）', '/connect', true), link('ボードから作る', installRoute())));
}
function startTask(id) { if (id === 'logic' && state.operations.logic?.recordId) state.capture = { mode: 'named', recordId: state.operations.logic.recordId, channels: [], values: {}, reviewed: false }; const next = id === 'logic' ? '/capture?mode=named' : id === 'analog' ? '/capture?mode=analog' : `/operate/${id}`; if (!state.connected) state.connectReturn = next; go(state.connected ? next : '/connect'); }
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
    el('section', {}, el('div', { class: 'mini-heading' }, el('h2', {}, '目的から操作を選ぶ'), el('a', { href: '#/operations', class: 'text-link' }, 'すべて見る →')), ...patternChoices('operations')),
    actions(link('初期設定の案内を開く', '/setup'), link('波形・外部ツールへ', '/handoff'))];
}
function emptyConnections() { return el('div', { class: 'empty' }, el('h3', {}, 'まだ配線を登録していません。'), p('相手の型番や、どの信号をどのピンにつなぐかを保存できます。', 'muted'), actions(link('配線を登録する →', '/connection/new', true), link('登録せずに操作する', '/operations'))); }
function wiringSummary(record) {
  return el('div', { class: 'wiring-summary' }, ...record.groups.flatMap(g => [badge(groupSpec(g).short, 'gray'), ...groupSpec(g).roles.flatMap((r, i) => g.pins[i] ? [el('span', {}, `${r} → ${pinName(g.pins[i])}`)] : []), g.resetPin ? el('span', {}, `NRST → ${pinName(g.resetPin)}`) : null]));
}
function recordCard(record) {
  return el('article', { class: 'connection-card' }, el('header', {}, el('div', {}, el('h2', {}, record.name), p(record.part || '相手の型番は未記入', 'muted mb0')), badge('タブ内に保存（デモ）')),
    wiringSummary(record), record.note ? p(record.note, 'compact muted') : null,
    actions(link('配線・相手の情報を編集', `/connection/${record.id}`, true), ...record.groups.map(g => button(`${groupSpec(g).short}で使う →`, () => { state.operations[g.type] = { ...(state.operations[g.type] ?? {}), recordId: record.id }; startTask(g.type); }))));
}
function connections() {
  if (!state.connected) return needConnection('/connections');
  return [heading('配線と、つなぐ相手を記録する。', '固定の配線を登録して、同じ作業に繰り返し使えます。相手が未接続でも編集・保存できます。'),
    state.notice ? note(state.notice) : null, state.records.length ? [actions(link('新しい配線を登録', '/connection/new', true)), el('div', { class: 'stack mt' }, ...state.records.map(r => recordCard(r)))] : emptyConnections()];
}
function newGroup(type, wire = '') {
  const g = { type, wire, pins: [], resetPin: '', config: {} };
  g.pins = groupSpec(g).roles.map(() => '');
  return g;
}
function wiringEditor(g, index, draft) {
  const spec = groupSpec(g), changed = () => { state.dirty = true; };
  g.config ??= {};
  return el('section', { class: 'wire-group', 'data-group': g.type },
    el('div', { class: 'wire-head' }, el('h3', {}, spec.short), button('この信号を外す', () => { draft.groups.splice(index, 1); changed(); render(false); })),
    ['debug', 'console'].includes(g.type) ? debugChoices(wire => { if (wire === g.wire) return; g.wire = wire; g.pins = groupSpec(g).roles.map(() => ''); g.resetPin = ''; g.config = {}; changed(); render(false); }, g.wire, g.type === 'console') : null,
    p(spec.description, 'compact muted'),
    ['debug', 'console'].includes(g.type) && !g.wire ? note('方式を選ぶと、そのターゲットに必要な配線と条件が表示されます。') : [
      el('div', { class: 'wire-pins' }, ...spec.roles.map((role, i) => field(role === 'RX' ? 'プローブRX ← 相手TX' : role === 'TX' ? 'プローブTX → 相手RX' : role, g.pins[i] ?? '', v => { g.pins[i] = v; changed(); }, g.type === 'uart' && role === 'TX' ? 'ログを受けるだけなら未接続でかまいません。' : '', [['', g.type === 'uart' && role === 'TX' ? '接続しない（受信のみ）' : 'ピンを選ぶ'], ...pinChoices()]))),
      g.type === 'debug' ? field('NRST（任意）', g.resetPin ?? '', v => { g.resetPin = v; changed(); }, '相手が対応し、リセット線を使う場合だけ指定します。', [['', '接続しない'], ...pinChoices()]) : null,
      p('GNDは相手と共通にします。信号の電圧と、相手の端子名を確認してください。', 'compact muted mt'),
      p('ここで記録するのは配線と相手の情報です。速度・アドレスなどは操作を始める画面で指定し、本体には保存しません。', 'compact muted'),
      g.type === 'logic' ? note('繰り返し使う4チャネルの配線例です。今回だけの取得なら配線名の登録は不要です。取得条件は次の画面で決めます。') : null]);
}
function editor(id, query) {
  if (!state.connected) return needConnection(currentRoute);
  const purpose = query.get('purpose');
  if (id === 'new' && !purpose && !state.draft) return [heading('どの用途の配線を登録しますか。', '利用パターンに合った信号と条件から設定します。ターゲットは未接続でもかまいません。'), ...patternChoices(query.get('from') === 'setup' ? 'setup' : 'connections')];
  if (id === 'new' && ['debug', 'console'].includes(purpose) && !wireById(query.get('wire')) && !state.draft) return [heading('ターゲットのデバッグ方式を選ぶ。', '方式ごとに必要な配線が異なります。'), debugChoices(wire => go(`/connection/new?purpose=${purpose}&wire=${wire}&from=${query.get('from') ?? 'connections'}`), '', purpose === 'console')];
  if (!state.draft || state.draft.editId !== id) {
    const record = state.records.find(r => r.id === id);
    if (id !== 'new' && !record) return [heading('この配線は見つかりません。', '再読み込みすると、プレビュー中の記録は初期状態に戻ります。'), link('配線の一覧へ', '/connections')];
    state.returnTo = query.get('from') === 'setup' ? '/setup' : query.get('from') === 'capture' ? '/capture?mode=named' : query.get('from')?.startsWith('operate-') ? `/operate/${query.get('from').slice(8)}` : '/connections';
    state.draft = { ...(record ? structuredClone(record) : { id: `connection-${Date.now()}`, name: '', part: '', note: '', purpose, groups: [newGroup(purpose, query.get('wire'))] }), editId: id }; state.dirty = false;
  }
  const d = state.draft;
  const update = (key, value) => { d[key] = value; state.dirty = true; };
  return [heading(id === 'new' ? '何を、どのピンにつなぎますか。' : `${d.name || '接続先'}の配線を編集`, '相手の情報と配線を、ひとつの場所で設定します。保存しても接続・出力は始まりません。'),
    el('form', { id: 'connection-form', onsubmit: e => { e.preventDefault(); saveRecord(); } },
      el('fieldset', { class: 'form-group' }, el('legend', {}, '01 / つなぐ相手'),
        el('div', { class: 'field-grid' }, field('接続名', d.name, v => update('name', v), '例: sensor / board-1。アドレスにも使う名前です。'), field('相手のIC・基板の型番（任意）', d.part, v => update('part', v), `例: ${wireById(d.groups.find(g => g.type === 'debug')?.wire)?.part ?? 'センサモジュール名'}。プローブ自身の型番ではありません。`)),
        el('div', { class: 'mt' }, field('用途・配線メモ（任意）', d.note, v => update('note', v), 'コネクタ番号、電圧、用途など。型番やメモは人が読む記録です。', null, 'textarea'))),
      el('fieldset', { class: 'form-group' }, el('legend', {}, '02 / 信号とプローブ側のピン'), p('デバッグとUARTなど、複数の種類を一緒に登録できます。下のピン候補は構成例です。', 'muted'),
        ...d.groups.map((g, index) => wiringEditor(g, index, d)),
        el('div', { class: 'mt' }, el('h3', {}, '別の用途・信号も追加する'), el('div', { class: 'choice-row' }, ...[...TASKS, LOGIC_TASK].map(t => button(`＋ ${t.short}`, () => { d.groups.push(newGroup(t.id)); state.dirty = true; render(false); }, '', { disabled: d.groups.some(g => g.type === t.id) }))))),
      el('div', { id: 'form-error', class: 'form-error', role: 'alert' }),
      note('配線の保存は、ターゲットの探索や接続を行いません。このプレビューでは、名前・型番・メモ・配線をこのタブだけに保持します。'),
      el('div', { class: 'save-bar' }, p('再読み込みすると、プレビュー中の記録はリセットされます。'), actions(button('キャンセル', () => discardThen(() => { state.draft = null; go(state.returnTo); })), el('button', { type: 'submit', class: 'btn primary' }, id === 'new' ? '配線を保存' : '変更を保存')))),
    el('details', { class: 'panel mt' }, el('summary', {}, 'デバッグ配線が分からない場合'), p('探索は任意です。実機版では候補ピンを指定し、信号を送ることを確認してから実行します。固定配線の登録には必要ありません。', 'mt'))];
}
function saveRecord() {
  const d = state.draft, name = d.name.trim(), pins = d.groups.flatMap(groupPins);
  let error = '';
  if (!/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(name)) error = '接続名は英字で始まる、16文字以内の英数字・ハイフンにしてください。';
  else if (state.records.some(r => r.id !== d.id && r.name.toLowerCase() === name.toLowerCase())) error = 'その接続名はすでに使われています。別の名前にしてください。';
  else if (d.groups.some(g => ['debug', 'console'].includes(g.type) && !wireById(g.wire))) error = 'ターゲットのデバッグ方式を選んでください。';
  else if (!d.groups.length || d.groups.some(g => groupSpec(g).roles.some((role, i) => !g.pins[i] && !(g.type === 'uart' && role === 'TX')))) error = '信号を追加し、それぞれの役割にピンを選んでください。';
  else if (new Set(pins).size !== pins.length) error = '同じピンが複数の役割に選ばれています。配線を確認してください。';
  else if (state.records.some(r => r.id !== d.id && r.groups.some(g => groupPins(g).some(pin => pins.includes(pin))))) error = '他の接続先で使用しているピンが含まれています。別のピンを選んでください。';
  if (error) { document.getElementById('form-error').textContent = error; return; }
  const record = { id: d.id, name, part: d.part, note: d.note, purpose: d.groups.some(g => g.type === d.purpose) ? d.purpose : d.groups[0].type, groups: structuredClone(d.groups) };
  state.records = [...state.records.filter(r => r.id !== d.id), record]; state.dirty = false; state.draft = null;
  state.notice = `「${name}」を保存しました（このタブ内のデモ）。接続や出力は開始していません。`;
  if (record.purpose && d.editId === 'new') { state.operations[record.purpose] = { recordId: record.id, values: {} }; go(`/setup/ready?record=${record.id}`); }
  else go(state.returnTo);
}
function operations() { return [heading('目的に合う道具を開く。', '用途から必要な方式と配線・条件へ進みます。画面を開いただけでは動作を開始しません。'), ...patternChoices('operations'), actions(link('据え置き治具を準備する', '/fixture'), link('外部ツールへ引き継ぐ', '/handoff'))]; }
function stopTask(id) { state.active[id] = false; state.operations[id] = { ...(state.operations[id] ?? {}), stopped: true }; render(false); announce('サンプルの操作を終了しました'); }
function operate(id) {
  if (id === 'analog') return capture(new URLSearchParams('mode=analog'));
  const t = taskById(id);
  if (!state.connected) { state.connectReturn = `/operate/${id}`; state.intent = id; return [heading(t.title, t.description), note('プローブに接続すると、この作業へ戻ります。'), actions(link('プローブを選ぶ（デモ）', '/connect', true), link('ボードをプローブにする', installRoute()))]; }
  const o = state.operations[id] ??= { recordId: '', values: {} }; o.values ??= {};
  const records = state.records.filter(r => r.groups.some(g => g.type === id || id === 'console' && g.type === 'debug' && g.wire !== 'swd'));
  const selected = records.find(r => r.id === o.recordId);
  const g = selected?.groups.find(g => g.type === id || id === 'console' && g.type === 'debug' && g.wire !== 'swd') ?? { type: id, wire: o.wire, config: o.values };
  if (['debug', 'console'].includes(id) && !wireById(g.wire)) return [heading('ターゲットのデバッグ方式を選ぶ。', '使う方式に合った配線と条件を表示します。'), debugChoices(wire => { o.wire = wire; o.recordId = ''; o.values = {}; render(false); }, '', id === 'console')];
  const spec = groupSpec(g), config = o.values;
  const canReset = selected ? !!g.resetPin : !!o.values.resetPin;
  return [heading(t.title, t.description),
    ['debug', 'console'].includes(id) ? panel(badge(spec.short), p(spec.note), !selected ? actions(button('デバッグ方式を選び直す', () => { state.active[id] = false; state.operations[id] = { values: {} }; render(false); })) : null) : null,
    id === 'dac' && !['esp32', 'ch32'].includes(probeBoard().id) ? note('このボードにはDAC出力がありません。以下は、DAC対応プローブの操作画面例です。', 'amber') : null,
    el('div', { class: 'operation-grid' }, panel(el('h2', {}, '01 / 対象と配線'), field('使う配線', o.recordId ?? '', v => { o.recordId = v; o.values = {}; o.result = false; state.active[id] = false; render(false); }, '配線を選んでも、動作は始まりません。', [['', '保存せず、この場でピンを指定'], ...records.map(r => [r.id, `${r.name} — ${r.part || '型番未記入'}`])]),
      selected ? [wiringSummary(selected), link('この配線を編集', `/connection/${selected.id}?from=operate-${id}`)] : el('div', { class: 'wire-pins' }, ...spec.roles.map((r, i) => field(r, o.values[`pin-${i}`] ?? String(i), v => { o.values[`pin-${i}`] = v; if (id === 'uart' && r === 'TX') render(false); }, id === 'uart' && r === 'TX' ? '受信だけなら接続不要です。' : '', [...(id === 'uart' && r === 'TX' ? [['', '接続しない（受信のみ）']] : []), ...pinChoices()]))),
      id === 'debug' && !selected ? field('NRST（任意）', o.values.resetPin ?? '', v => { o.values.resetPin = v; render(false); }, 'リセットしながら接続するときだけ必要です。', [['', '接続しない'], ...pinChoices()]) : null,
      el('h2', { class: 'mt' }, '02 / 今回の操作条件'), p('本体には保存しません。開始時に道具から渡す条件です。', 'compact muted'),
      id === 'debug' ? el('details', {}, el('summary', {}, '接続条件を変更する（通常は自動）'), ...groupOptions(g).map(([label, value]) => field(label, config[label] ?? value, v => { o.values[label] = v; })), field('接続時の動作', config.attach ?? 'running', v => { o.values.attach = v; render(false); }, '', [['running', '動かしたまま接続'], ['halt', '停止して接続'], ['reset', 'リセットしながら接続（NRSTが必要）']]))
        : id === 'console' ? field('相手のログ出力方式', config.mechanism ?? 'dmseq', v => { o.values.mechanism = v; o.result = false; state.active[id] = false; render(false); }, '相手のアプリが使う方式を選びます。sdiは相手→PCのみ。', [['sdi', 'sdi（受信のみ）'], ['dmdata', 'dmdata（双方向）'], ['dmseq', 'dmseq（双方向）']])
        : groupOptions(g).map(([label, value]) => field(label, config[label] ?? value, v => { o.values[label] = v; })),
      id === 'debug' && config.attach === 'reset' && !canReset ? note('NRSTの配線を指定してから接続してください。', 'amber') : null,
      actions(button(t.action, () => { o.result = true; o.stopped = false; o.snapshot = structuredClone(o.values); state.active[id] = !['counter', 'i2c', 'spi', 'gpio'].includes(id); render(false); announce('サンプル結果を表示しました'); }, 'primary', { id: 'start-operation', disabled: id === 'debug' && config.attach === 'reset' && !canReset }), (o.result && !o.stopped) ? button(t.stop, () => stopTask(id)) : null)),
      panel(el('h2', {}, '03 / 状態と結果'), badge(o.stopped ? '終了（デモ）' : o.result ? (state.active[id] ? '使用中（デモ）' : '単発操作が完了（デモ）') : '未開始', o.result ? '' : 'gray'),
        el('div', { class: 'mt' }, o.result ? el('div', { class: 'terminal', role: 'log', 'aria-label': 'サンプル結果' }, o.stopped ? '使用を終了しました（デモ）。\n終了後のピン状態は本体設定と機能の仕様に従います。' : id === 'debug' ? `方式: ${spec.short}\n対象: ${spec.target}（サンプル）\n状態: 接続済み / ${o.debugState ?? '実行中'}` : t.output) : el('div', { class: 'result-placeholder' }, 'まだ操作を開始していません。', el('br'), '左の配線と条件を確認してから実行します。')),
        o.result && !o.stopped && (id === 'uart' && (selected ? !!g.pins[1] : (o.values['pin-1'] ?? '1') !== '') || id === 'console' && (config.mechanism ?? 'dmseq') !== 'sdi') ? [field('送る文字列', o.text ?? '', v => { o.text = v; }, '送信も画面上のシミュレーションです。'), button('送信する（デモ）', () => { o.sent = o.text || '(空)'; render(false); }), o.sent ? p(`送信例: ${o.sent}`, 'mt') : null] : null,
        o.result && !o.stopped && id === 'debug' ? actions(button('停止（デモ）', () => { o.debugState = '停止中'; render(false); }), button('再開（デモ）', () => { o.debugState = '実行中'; render(false); }), o.debugState ? badge(o.debugState) : null) : null,
        p('表示される結果は固定のサンプルです。入力した値による実際の送受信・計測は行いません。', 'compact muted mt'))),
    id === 'debug' ? panel(el('h2', {}, 'このターゲットを開発ツールで使う'), p(g.wire === 'swd' ? 'ARM Cortex-MはPythonで操作します。現行ツールにはflash loaderとGDB serverはありません。' : 'CH32の書き込み・GDBはch32rv、Arduino IDEからの書き込みはArduinoCore-CH32RVを使います。'), external('対応ターゲットと注意点', GUIDE_BASE + 'debug-targets.ja.md'), link('開発ツールへの引継ぎ', '/handoff')) : null,
    note('使用を終了しても、ピンの待機設定やデバッグ線の保持状態は別に扱います。実機版では終了後の状態を案内します。')];
}
function capture(query) {
  if (!state.connected) return needConnection(currentRoute);
  const mode = query.get('mode') ?? 'standalone';
  if (['during', 'test'].includes(mode)) return [heading(mode === 'during' ? '操作と波形取得を一緒に行う。' : '波形を自動テストで照合する。', '操作と取得を外部の同じ処理で組み立てます。ブラウザで別々に開始して同期したことにはしません。'),
    panel(el('h2', {}, '用意するものと手順'), el('ol', {}, ...['必要なら配線名を登録し、操作と観測で同じ名前を使う', 'WireSkein / Pythonで取得条件と操作の手順を用意する', mode === 'during' ? '取得を待機させて操作し、波形ファイルを残す' : '期待する波形を記述し、記録・照合して合否を残す'].map(t => el('li', {}, t))),
      actions(link('登録済みの配線を確認', '/connections'), link('利用を終了して外部環境へ', '/handoff')), external('具体的な手順', GUIDE_BASE + 'capture.ja.md'))];
  const c = state.capture ??= { mode, recordId: '', channels: [{ name: 'signal-1', pin: '6' }, { name: 'signal-2', pin: '7' }], values: {}, reviewed: false };
  if (c.mode !== mode) { c.mode = mode; c.reviewed = false; }
  const record = state.records.find(r => r.id === c.recordId);
  const channels = mode === 'named' ? (record?.groups.flatMap(g => groupSpec(g).roles.flatMap((role, i) => g.pins[i] ? [{ name: `${record.name}.${role.toLowerCase() === 'dio' ? 'swio' : role.toLowerCase()}`, pin: g.pins[i] }] : [])) ?? []) : c.channels;
  const summaryRows = [['プローブ', `${probeBoard().model} / demo-oep-01`], ['信号', channels.map(ch => `${ch.name} → ${pinName(ch.pin)}`).join(', ')], ['速さ', `${c.values.rate ?? '1000000'} Hz（希望値）`], ['取り方', c.values.kind ?? 'oneshot'], ...(c.values.kind === 'stream' ? [['取得時間', `${c.values.duration ?? '100'} ms`]] : [['サンプル数', c.values.samples ?? '10000'], ['トリガ', c.values.trigger ?? '指定なし'], ['プリトリガ', c.values.pretrigger ?? '0']]), ['上限', '実機の宣言・接続経路に合わせてWireSkeinで確認']];
  c.summary = summaryRows;
  const setValue = (key, value) => { c.values[key] = value; c.reviewed = false; document.getElementById('capture-summary')?.remove(); };
  return [heading(mode === 'analog' ? 'アナログ取得の準備。' : '観測する信号と取得条件を決める。', mode === 'named' ? '既存の配線名で観測します。ロジックは使用中のデバッグ・UART等のピンも観測でき、配線の所有を変更しません。' : '今回だけの取得条件です。本体設定や配線名の登録は不要です。'),
    panel(el('h2', {}, '01 / 観測する信号'), mode === 'named' ? [field('使う配線', c.recordId, v => { c.recordId = v; c.reviewed = false; render(false); }, '', [['', '配線を選ぶ'], ...state.records.map(r => [r.id, r.name])]),
      record ? [wiringSummary(record), link('配線を編集', `/connection/${record.id}?from=capture`)] : link('繰り返し使う配線を登録', '/connection/new?purpose=logic&from=setup')]
      : [ ...c.channels.map((ch, i) => el('div', { class: 'field-grid mb' }, field(`信号${i + 1}の表示名`, ch.name, v => { ch.name = v; c.reviewed = false; document.getElementById('capture-summary')?.remove(); }, '取得ファイル内の名前。本体のラベルは変更しません。'), field(`信号${i + 1}のピン`, ch.pin, v => { ch.pin = v; c.reviewed = false; document.getElementById('capture-summary')?.remove(); }, mode === 'analog' ? '実機ではADC対応ピンに限定します。ここでは候補の表示例です。' : '', pinChoices()))),
        actions(button('観測する信号を追加', () => { c.channels.push({ name: `signal-${c.channels.length + 1}`, pin: String(6 + c.channels.length) }); c.reviewed = false; render(false); }), c.channels.length > 1 ? button('末尾の信号を外す', () => { c.channels.pop(); c.reviewed = false; render(false); }) : null)],
      note(mode === 'analog' ? 'アナログ取得はピンを専有します。同じ信号をロジックでも見るなら別のピンへ配線します。' : 'ロジック取得は聞くだけで、ピンを駆動しません。GNDと信号電圧を確認します。')),
    panel(el('h2', {}, '02 / WireSkeinで指定する取得条件'),
      field('取り方', c.values.kind ?? 'oneshot', v => { setValue('kind', v); render(false); }, '利用できる取り方と上限は実機の宣言で確認します。', [['oneshot', 'ワンショット'], ['stream', 'PCへ流し続ける'], ['repeat', 'トリガごとに繰り返す']]),
      field('サンプルレート（Hz）', c.values.rate ?? '1000000', v => setValue('rate', v), '希望する速さです。実際の速さは本数・取り方・経路により変わり、取得環境で確認します。'),
      c.values.kind === 'stream' ? field('取得時間（ms）', c.values.duration ?? '100', v => setValue('duration', v)) : [field('サンプル数', c.values.samples ?? '10000', v => setValue('samples', v)), field('トリガ', c.values.trigger ?? '指定なし', v => setValue('trigger', v), '信号とエッジ/レベルを指定する入力例。'), field('プリトリガ（サンプル）', c.values.pretrigger ?? '0', v => setValue('pretrigger', v))],
      p('このタブ内で準備する値です。ここでは取得を実行せず、プローブへ保存もしません。', 'muted'),
      button('引継ぎ内容を確認（デモ）', () => { c.reviewed = true; render(false); }, 'primary', { disabled: !channels.length })),
    c.reviewed ? panel(el('div', { id: 'capture-summary' }, el('h2', {}, '外部環境に渡す内容'), keyValues(summaryRows), link('WireSkeinへの引継ぎを確認 →', '/handoff', true))) : null,
    actions(link('取得の使い分けに戻る', '/setup/logic')), external('キャプチャの使い分け・P4の速度条件', GUIDE_BASE + 'capture.ja.md')];
}
function passthrough() {
  if (!state.connected) return needConnection('/passthrough');
  const d = state.passthrough ??= { source: 'uart', wire: 'rvswd', rx: '6', dio: '6', clk: '7', port: 'cdc0', baud: '115200', format: '8n1', mechanism: 'dmseq', applied: false, saved: false };
  const update = (key, value) => { d[key] = value; d.applied = d.saved = false; const summary = document.getElementById('passthrough-status'); if (summary) summary.textContent = '未適用'; const save = /** @type {HTMLButtonElement} */ (document.getElementById('save-passthrough')); if (save) save.disabled = true; };
  return [heading('普通のシリアルモニタへログを流す。', 'OEPセッションがない間だけ働く、本体の素通し設定です。相手 → PCの受信専用で、相手へは送信しません。'),
    panel(el('h2', {}, '01 / 相手がログを出す経路'), field('ログの入力元', d.source, v => { update('source', v); render(false); }, '', [['uart', 'UART'], ['console', 'デバッグ線（WCH）']]),
      d.source === 'uart' ? [field('受信ピン（相手TXから）', d.rx, v => update('rx', v), '', pinChoices()), field('素通しの通信速度（baud）', d.baud, v => update('baud', v)), field('素通しの形式', d.format, v => update('format', v))]
      : [field('デバッグ線', d.wire, v => { update('wire', v); render(false); }, '', [['rvswd', 'RVSWD（2線）'], ['swio', '1線DIO（SWIO）']]), field(d.wire === 'rvswd' ? 'SWDIO' : 'DIO', d.dio, v => update('dio', v), '', pinChoices()), d.wire === 'rvswd' ? field('SWCLK', d.clk, v => update('clk', v), '', pinChoices()) : null,
        field('相手のログ出力方式', d.mechanism, v => update('mechanism', v), '', [['sdi', 'sdi'], ['dmdata', 'dmdata'], ['dmseq', 'dmseq']]), p('相手を停止・リセットする設定ではありません。ただしRVSWDでは接続時に相手がリセットされる場合があります。', 'muted')]),
    panel(el('h2', {}, '02 / ログを出すプローブのポート'), field('出力先シリアルポート', d.port, v => update('port', v), '接続方式を選び直す操作ではありません。実機では宣言されたポートを表示し、1ポートに素通し1つだけを設定します。以下は構成例です。', [['cdc0', 'cdc0 — USBシリアルの例'], ['bridge0', 'bridge0 — UART bridgeの例'], ['usj0', 'usj0 — USB-Serial/JTAGの例']]),
      note('OEPツールが使用中は止まり、セッションが終わると再開します。現在のブラウザ接続を閉じる操作は最後に行います。'),
      el('p', { id: 'passthrough-status' }, d.saved ? '保存済み（デモ）' : d.applied ? '適用済み・未保存（デモ）' : '未適用'),
      actions(button('素通し設定を適用（デモ）', () => { d.applied = true; render(false); }, 'primary'), button('本体の現在値全体を保存（デモ）', () => { d.saved = true; render(false); }, '', { id: 'save-passthrough', disabled: !d.applied })),
      d.applied ? link('接続を終了してシリアルモニタへ', '/handoff') : null),
    external('素通し設定と制約', GUIDE_BASE + 'settings.ja.md#素通し'), actions(link('据え置き治具の手順へ', '/fixture'), link('ログの方法を選び直す', '/setup/logs'))];
}
function settings(query) {
  if (!state.connected) return needConnection(currentRoute);
  const update = (key, value) => { state.settings[key] = value; state.settingsApplied = false; state.settingsSaved = false; document.getElementById('settings-summary').textContent = '入力中・未適用'; (/** @type {HTMLButtonElement} */ (document.getElementById('save-settings'))).disabled = true; };
  return [heading('プローブ本体の動作を整える。', '配線の名前とは別に、待機時や次回起動後の動作を設定します。必要な項目だけ変更してください。'),
    note('ここは設定項目の構成例です。実機版では、接続したプローブが提供する設定だけを表示します。'),
    panel(el('h2', {}, '触らせないピン'), field('使用禁止にするピン（例）', state.settings.disabledPins ?? '', v => update('disabledPins', v), 'ボードのLED・ボタン・起動用端子など。ピン名を記録する画面例です。')),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, '空いているピンの状態'), p('治具の制御線など、機能が使っていないときの状態を設定します。', 'muted'),
      field('対象のピン', state.settings.pin ?? '4', v => update('pin', v), '', Array.from({ length: 23 }, (_, n) => [String(n), pinName(n)])),
      el('div', { class: 'mt' }, field('空き状態', state.settings.idle ?? 'hi-z', v => update('idle', v), '空いているピンには適用時に、使用中なら解放時に反映されます。', [['hi-z', 'Hi-Z（入力・pullなし）'], ['pull-up', 'pull-up'], ['pull-down', 'pull-down'], ['low', '出力 Low'], ['high', '出力 High']]))),
      probeBoard().id === 'esp32' ? panel(el('h2', {}, 'ネットワーク'), p('Wi-Fi対応の構成で、プローブをベンチのネットワークにつなぐ設定です。', 'muted'),
        field('SSID', state.settings.ssid ?? '', v => update('ssid', v), '入力はこのタブ内だけに保持します。'), el('div', { class: 'mt' }, field('パスワード', state.settings.password ?? '', v => update('password', v), '実際のパスワードを入力する必要はありません。', null, 'password'))) : panel(el('h2', {}, 'ネットワーク'), p('このサンプルのプローブにはWi-Fi設定がありません。対応するプローブだけにSSIDの入力を表示します。'))),
    el('div', { class: 'save-bar mt' }, el('p', { id: 'settings-summary' }, state.settingsSaved ? '保存済み（デモ）' : state.settingsApplied ? '適用済み・永続保存はまだです（デモ）' : '入力中・未適用'), actions(button('現在の設定に適用（デモ）', () => { state.settingsApplied = true; render(false); }, 'primary'), button('次回起動用に保存（デモ）', () => { state.settingsSaved = true; render(false); }, '', { disabled: !state.settingsApplied, id: 'save-settings' }))),
    p('永続保存は、本体の現在の設定全体を保存する操作です。Wi-Fiを設定しても、このページから直接TCP接続できるわけではありません。', 'compact muted'),
    actions(link('据え置き治具の手順へ', '/fixture'), link('初期設定の続きへ', '/setup'))];
}
function maintenance(query) {
  if (!state.connected) return needConnection('/maintenance');
  return [heading('更新・復元と、困ったときの確認。', '作業内容を確認してから実行し、終わったら同じプローブの作業に戻ります。'),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, 'ファームウェアの更新'), p(`${probeBoard().model}のファームウェアイメージと、設定を保持できる条件を確認します。`, 'muted'), badge('版・ファームウェアイメージはプレビュー用'),
      actions(button('更新内容の確認例を見る', () => { state.maintenance = 'update'; render(false); }))),
      panel(el('h2', {}, '設定の控え・復元'), p('復元前に、別個体の設定や未対応の項目、上書き内容を確認します。', 'muted'), actions(link('本体の保存状態を確認', '/settings'), button('控えの内容例を見る', () => { state.maintenance = 'backup'; render(false); }), button('設定ファイルの確認例を見る', () => { state.maintenance = 'restore'; render(false); })))),
    state.maintenance === 'backup' ? panel(el('h2', {}, '控えに含める内容の例'), keyValues([['本体設定', '配線名・使用禁止・待機状態・素通し等'], ['操作条件', 'UART速度やキャプチャ条件は対象外'], ['秘密値', 'Wi-Fiパスフレーズは含めない'], ['メモ', '型番・メモは本体設定とは別の記録']]), p('ファイルはまだ生成しません。本体の現在値全体を保存したうえで控えを取る流れの表示例です。')) : null,
    state.maintenance === 'restore' ? panel(el('h2', {}, '復元する変更の例'), keyValues([['配線', 'sensor: SDA → GP4 / SCL → GP5'], ['記録', '相手の型番・メモは別の保存対象'], ['秘密値', 'Wi-Fiパスワードは含まれていません']]), actions(button('この変更を適用（デモ）', () => { state.maintenance = 'restored'; render(false); }, 'primary'))) : null,
    state.maintenance === 'update' ? panel(el('h2', {}, '更新前の確認'), p('個体・チップ・revision・ファームウェアイメージの適合性と、既存設定への影響を確認する画面です。'), note('今回は実際の更新を行いません。導入と同じ、起動後の接続引継ぎを使用します。'), button('更新後の状態を見る（デモ）', () => { state.maintenance = 'updated'; render(false); }, 'primary')) : null,
    ['restored', 'updated'].includes(state.maintenance) ? note(state.maintenance === 'restored' ? '復元を適用した状態の例です。次回起動にも残す場合は、本体設定で永続保存します。' : '更新後、同じ個体と起動版を確認した状態の例です。設定は維持されています。') : null,
    el('details', { class: 'panel mt' }, el('summary', {}, '診断・機能の宣言・保存領域'), p('通常の配線編集では開く必要はありません。接続状態や対応機能を調べ、問題を切り分けるための詳細画面です。', 'mt'), keyValues([['接続', '確認済み（デモ）'], ['個体ID', 'demo-oep-01'], ['保存領域', 'タブ内のサンプル'], ['記録', '秘密値を含まない診断情報を表示する想定']])),
    actions(link('据え置き治具の手順へ', '/fixture'), link(query.get('from') === 'setup' ? '初期設定の続きへ' : '作業ホームへ戻る', query.get('from') === 'setup' ? '/setup' : '/work'))];
}
function handoff() {
  return [heading('目的に合う道具へ、つなぐ。', 'このページで整えたプローブと配線を、観測や開発・自動化にも使えます。', 'CONNECTED TOOLS'),
    state.capture?.reviewed ? panel(el('h2', {}, '今回の取得条件の控え'), keyValues(state.capture.summary), p('外部のWireSkeinで指定する内容です。ブラウザから設定や接続を自動転送するものではありません。')) : null,
    el('div', { class: 'two-grid' }, panel(badge('ファイル表示 / ブラウザ'), el('h2', { class: 'mt' }, '取得した波形をWireSkeinで見る'), p('取得済みの .wireskein / .sr ファイルを、公開Viewerで表示します。ファイルを開くだけなら、このページの機器接続を終了する必要はありません。'), external('WireSkein Viewerを開く', 'https://open-embedded-probe.github.io/wireskein-web/')),
      panel(badge('取得・解析 / 外部環境'), el('h2', { class: 'mt' }, 'プローブから波形を取得する'), p('取得と高度な解析はPython側のWireSkeinを使います。公開Viewerだけで機器から取得することはできません。'), external('WireSkeinの導入・使い方', 'https://github.com/Open-Embedded-Probe/wireskein'))),
    el('section', { class: 'panel mt' }, el('h2', {}, 'IDEやPythonから使う'), p('ターゲット固有の書き込みや自動テストは、対応する開発ツールへ。個体と配線を特定する情報を確認できます。'),
      keyValues([['プローブ', state.connected ? `${probeBoard().model} / demo-oep-01` : 'プローブ未接続'], ['接続先', state.records.map(r => r.name).join(', ') || '配線は未登録'], ['アドレス例', `oep://demo-oep-01${state.records[0] ? '/' + state.records[0].name : ''}`]]),
      actions(external('Python・CLIの使い方', DOCS[5][2]), external('CH32の書き込み・GDB（ch32rv）', 'https://github.com/ch32-riscv-ug/ch32rv'), external('自動テストの手順', GUIDE_BASE + 'use-cases.ja.md#8-自動テストの治具にする'), state.connected ? button('このページでの利用を終了して渡す（デモ）', () => { state.active = {}; state.connected = false; state.transferDone = true; render(false); }) : null),
      state.transferDone ? note('デモ接続と操作を終了しました。実機版では変更権と通信を解放して、別の道具で接続できる状態にします。') : null)];
}
function notFound() { return el('div', { class: 'page' }, heading('この画面は見つかりません。', '入口から、確認したい作業を選んでください。'), link('OEPの入口へ戻る', '/home', true)); }
function render(focus = true) {
  fieldCount = 0;
  const route = routeNow(); currentRoute = route;
  const [path, params] = route.split('?'), query = new URLSearchParams(params);
  const [, view, id] = path.split('/');
  const workspace = ['work', 'connections', 'connection', 'operations', 'operate', 'capture', 'passthrough', 'fixture', 'settings', 'maintenance', 'handoff'].includes(view);
  let content;
  if (view === 'home') content = home();
  else if (view === 'boards') content = boards();
  else if (view === 'learn') content = learn();
  else if (view === 'usecases') content = usecases();
  else if (view === 'usecase') content = usecase(id);
  else if (view === 'install') content = install(id, query);
  else if (view === 'setup') content = setup(id, query);
  else if (view === 'connect') content = connect();
  else if (view === 'work') content = work();
  else if (view === 'connections') content = connections();
  else if (view === 'connection') content = editor(id, query);
  else if (view === 'operations') content = operations();
  else if (view === 'operate') content = operate(id);
  else if (view === 'capture') content = capture(query);
  else if (view === 'passthrough') content = passthrough();
  else if (view === 'fixture') content = fixture();
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
  if (currentRoute.startsWith('/connection/') && next !== currentRoute) state.draft = null;
  if (currentRoute === '/install/writing' && next !== currentRoute && state.flash === 'writing') { clearInterval(flashTimer); state.flash = 'idle'; }
  render();
});
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
render(false);
