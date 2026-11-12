// OEP Web: the public entrance (P01-P04), probe creation (I01), connecting (C01) and the router. Screens follow
// docs/page.ja.md; the work screens are in work.js, operate.js and manage.js.
import { el, p, badge, actions, link, external, note, panel, heading, keyValues, sectionTitle, field, resetFieldIds, textLink } from './ui.js';
import { state, setRenderer, render, go, routeNow, discardThen, action, button, setErrorText, announce } from './core.js';
import * as D from './device.js';
import { BOARDS, TASKS, SETUP_PATTERNS, USE_CASE_DETAILS, DOCS, guide, CONSOLE_TASK, ANALOG_TASK } from './data.js';
import { t, tr, lang, setLang, LANGUAGES, onLanguage, applyDocument } from './i18n.js';
import { BOARDS as SPECS, FEATURES } from './boards.js';
import { connected, purposeRoute, purposeTitle, choosePurpose, patternChoices, workspaceShell, taskById } from './common.js';
import { setup, work, connections, editor, fixture } from './work.js';
import { operations, operate, capture, passthrough } from './operate.js';
import { settings, maintenance, handoff } from './manage.js';

setErrorText(D.errorText);
D.onChange(() => { if (!state.busy) render(); });

function shell(content, workspace) {
  const nav = [['/home', t('About OEP', 'OEPとは')], ['/usecases', t('What it does', 'できること')], ['/boards', t('Boards', '対応ボード')], ['/learn', t('Technology and docs', '技術・資料')]];
  const route = routeNow();
  return [
    el('header', { class: 'site-header' }, el('a', { href: '#/home', class: 'brand', 'aria-label': t('OEP home', 'OEP トップ') }, el('span', { class: 'brand-icon' }, 'OEP'), el('span', { class: 'brand-name' }, 'Open Embedded Probe', el('small', {}, 'CONNECT. EXPLORE. BUILD.'))),
      el('nav', { class: 'public-nav', 'aria-label': t('About OEP', 'OEPの案内') }, ...nav.map(([path, name]) => el('a', { href: `#${path}`, class: route === path ? 'active' : '', 'aria-current': route === path ? 'page' : 'false' }, name))),
      el('label', { class: 'language' }, el('span', { class: 'sr-only' }, t('Language', '言語')),
        el('select', { id: 'language', onchange: (e) => setLang(e.target.value) }, ...LANGUAGES.map(([id, name]) => el('option', { value: id, selected: id === lang }, name)))),
      el('a', { class: 'btn header-action', href: connected() ? '#/work' : '#/install/select' }, connected() ? t('Back to work →', '作業に戻る →') : t('Make a probe →', 'プローブを作る →'))),
    !D.browser.secure ? note(t('Connecting devices needs HTTPS or localhost. You can still read everything here.', '機器の接続にはHTTPSかlocalhostが必要です。説明はこのまま読めます。'), 'amber') : (!D.browser.usb && !D.browser.serial) ? note(t('To connect devices, use desktop Chrome or Edge. You can still read everything in this browser.', '機器の接続には、デスクトップ版のChromeかEdgeを使ってください。説明はこのブラウザでも読めます。'), 'amber') : null,
    workspace ? workspaceShell(content) : el('main', { id: 'content', class: 'container', tabindex: -1 }, content),
    el('footer', { class: 'footer' }, el('span', {}, 'Open Embedded Probe', p(t('Connecting boards and development tools in a common way.', 'ボードと開発ツールを、共通の方法でつなぐ。'), 'mb0')), el('span', {}, `oep-client-js ${D.VERSION ?? ''}`), external('GitHub / OEP', 'https://github.com/Open-Embedded-Probe')),
  ];
}
function heroDiagram() {
  return el('div', { class: 'bench', role: 'img', 'aria-label': t('The browser and development tools on the PC reach the chip or board under development through an OEP probe.', 'PCのブラウザや開発ツールがOEPプローブを介して、開発中のICや基板につながります。') },
    el('span', { class: 'bench-label' }, 'ONE PROBE, MANY POSSIBILITIES'),
    el('div', { class: 'bench-row' }, el('div', { class: 'diagram-box' }, t('Browser', 'ブラウザ'), el('span', {}, t('Setup and operation', 'セットアップ・操作'))), el('div', { class: 'diagram-box' }, t('IDE / tests', 'IDE / テスト'), el('span', {}, t('Development, automation', '開発・自動化')))),
    el('div', { class: 'probe-board' }, el('strong', {}, 'OEP'), el('small', {}, 'YOUR DEVELOPMENT BOARD')),
    el('div', { class: 'connection-line' }, t('↓ debug, buses, signals, capture ↓', '↓ デバッグ・通信・信号・観測 ↓')),
    el('div', { class: 'bench-row' }, el('div', { class: 'diagram-box' }, t('Chip or board under development', '開発中のIC・基板'), el('span', {}, t('Target', 'ターゲット')))));
}

// -- public pages (P01-P04) --
function home() {
  return [
    el('section', { class: 'hero' }, el('div', { class: 'hero-copy' }, p('OPEN EMBEDDED PROBE', 'eyebrow'), el('h1', { tabindex: -1 }, t('Turn the board at hand', '手元のボードを、'), el('br'), t('into a common probe', '開発のための'), el('br'), t('for development.', '共通プローブに。')),
      p(t('Open Embedded Probe is a specification for using debug, buses, signal control and measurement from a PC in a common way. A development board with the firmware becomes a tool for the job at hand.', 'Open Embedded Probeは、デバッグ・通信・信号制御・計測を、PCから共通の方法で使うための仕様です。対応ファームウェアを入れた開発ボードを、用途に応じた道具として使えます。')),
      actions(link(t('Make a board a probe →', 'ボードをプローブにする →'), '/install/select', true), link(connected() ? t('Back to work', '作業に戻る') : t('Use an installed probe', '導入済みのプローブを使う'), connected() ? '/work' : '/connect')),
      p(t('Install and set up in the browser first, then go on to the IDE or test tools as needed. Reading needs no device permission.', 'まずはブラウザで導入・設定。必要に応じてIDEやテストツールへ。読むだけなら機器の許可は要りません。'), 'hero-foot')), heroDiagram()),
    el('section', { class: 'section' }, sectionTitle(t('From one connection to many tasks.', 'ひとつの接続から、いろいろな作業へ。'), t('What is available depends on the board and firmware. It is read from the probe after connecting.', '利用できる機能は、ボードとファームウェアで異なります。接続後にプローブから確かめます。'), 'WHAT YOU CAN DO'),
      patternChoices('public'), actions(link(t('Automated tests and development tools', '自動テスト・開発ツールを知る'), '/learn'))),
    el('section', { class: 'section' }, sectionTitle(t('Getting a board? Get an ESP32-P4.', 'これから用意するなら、ESP32-P4。'), t('The ESP32-P4 is recommended. You can also start with a supported board you have. An installed probe connects whatever its kind.', '推奨ボードはESP32-P4です。手元の対応ボードからも始められます。導入済みなら、種類を選ばず接続できます。'), 'BOARDS'),
      el('div', { class: 'three-grid' }, ...BOARDS.slice(0, 3).map((b) => boardCard(b, false, true))), actions(link(t('All boards and their limits', 'すべてのボードと制約を見る'), '/boards'))),
    el('section', { class: 'section' }, sectionTitle(t('Write it, then set it up straight away.', '書き込んだら、そのまま設定へ。'), t('You can register wiring before you have a target.', 'ターゲットがまだなくても、配線の登録はできます。'), 'GET STARTED'),
      el('div', { class: 'steps-overview' }, ...[[t('Connect the board', 'ボードをつなぐ'), t('Choose the device to write once in the browser.', '書き込みに使う機器を、ブラウザから一度選択。')], [t('Install OEP', 'OEPを導入する'), t('Check the chip and the firmware image, then write and boot in one go.', 'チップとファームウェアイメージを確かめ、書き込みから起動まで続けます。')], [t('Set it up for your purpose', '用途に合わせて設定する'), t('Prepare wiring and conditions from how you will use it: debug, UART pass-through, capture.', 'デバッグ・UARTの素通し・観測など、使い方から配線と条件を準備。')], [t('Start the work', '目的の作業を始める'), t('Logs, buses, signals, debug. Go on to the tool you need.', 'ログ、通信、信号、デバッグ。必要な道具へ進みます。')]].map(([tk, d]) => el('div', {}, el('h3', {}, tk), p(d)))),
      p(t('If the USB setup changes after boot, the same screen guides the permission and replugging needed.', '起動後にUSBの構成が変わる場合は、必要な使用許可やケーブルの抜き差しを、同じ画面で案内します。'), 'muted compact')),
    el('section', { class: 'section' }, el('div', { class: 'tech-block' }, el('div', {}, p('HOW OEP WORKS', 'eyebrow'), el('h2', {}, t('Board differences,', 'ボードごとの違いを、'), el('br'), t('handled as common functions.', '共通の機能として扱う。')), p(t('The probe itself tells its functions and pin limits, and apps use the functions they understand. OEP is not a tool for one particular board.', 'プローブ自身が機能とピンの制約を伝え、アプリは理解できる機能を利用します。OEPは、特定のボードだけのための道具ではありません。')), el('a', { class: 'text-link', href: '#/learn' }, t('Technology overview and docs →', '技術の概要と資料へ →'))),
      el('div', { class: 'tech-lines' }, ...[[t('Declare functions', '機能を宣言する'), t('Read what it offers, and the conditions, from the device.', '提供できる機能と、その条件を実機から取得。')], [t('Use them the same way', '共通の方法で使う'), t('Operations mean the same over USB or serial.', 'USBやシリアルの上で、同じ意味の操作を利用。')], [t('Extend for your needs', '用途に合わせて拡張する'), t('Combine standard interfaces with your own functions.', '標準interfaceと独自の機能を組み合わせる。')]].map(([tk, d]) => el('div', {}, el('strong', {}, tk), el('small', {}, d))))))];
}
function boardStatus(b) {
  const specs = b.ids.map((id) => SPECS.find((s) => s.id === id)).filter(Boolean);
  const released = specs.some((s) => s.tier === 'release');
  const verified = specs.map((s) => s.verified === true ? t('checked on hardware', '実機で確認') : s.verified === false ? t('not checked on hardware', '実機は未確認') : tr(s.verified));
  return [released ? t('Released firmware', '配布firmwareあり') : t('No released firmware (build it yourself)', '配布firmwareなし（自分でビルド）'), b.installable ? (b.custom ? t('Install here (bring an image)', 'このページで導入（イメージを持ち込む）') : t('Install here', 'このページで新規導入')) : t('Not installed from this page', 'このページでの新規導入は対象外'), t(`Checked: ${[...new Set(verified)].join(' / ')}`, `検証: ${[...new Set(verified)].join(' / ')}`)];
}
function boardCard(b, select = false, compact = false) {
  return el('section', { class: `board-card${b.recommended ? ' recommended' : ''}${select && state.install?.board === b.id ? ' selected' : ''}` },
    el('div', { class: 'board-meta' }, el('span', { class: 'chip-mark' }, b.code), badge(b.tag, b.installable ? '' : 'amber')),
    el('h3', {}, b.name), p(b.title), !compact ? p(b.description) : null,
    el('ul', {}, ...b.features.map((f) => el('li', {}, f))),
    !compact ? el('ul', { class: 'muted' }, ...boardStatus(b).map((tk) => el('li', {}, tk))) : null, !compact ? p(b.note, 'compact') : null,
    actions(select ? button(state.install?.board === b.id ? t('Selected ✓', '選択中 ✓') : t('Choose this board', 'このボードを選ぶ'), () => { newInstall(b.id); render(); }, state.install?.board === b.id ? 'primary' : '', { disabled: !b.installable, 'data-board': b.id })
      : button(b.installable ? t('Start with this board →', 'このボードで始める →') : t('Use an installed device', '導入済みの機器を使う'), () => { state.intent = ''; if (b.installable) { newInstall(b.id); go('/install/prepare'); } else { state.connectReturn = '/work'; go('/connect'); } }, '', { 'data-board': b.id })));
}
function boards() {
  return el('div', { class: 'page' }, heading(t('Start from a board you have.', '手元のボードから、始められます。'), t('Released firmware, features and installation differ by board. Compare them and choose one that suits your purpose.', '配布ファームウェア、使える機能、導入方法はボードごとに異なります。違いを見ながら、目的に合うものを選んでください。'), 'SUPPORTED BOARDS'),
    el('div', { class: 'two-grid' }, ...BOARDS.map((b) => boardCard(b))),
    el('section', { class: 'section' }, sectionTitle(t('Features by board', 'ボードごとの機能'), t('What the released firmware offers. What you can actually use is read from the probe\'s declarations after connecting.', '配布firmwareの機能の一覧です。実際に使える機能は、接続後にプローブの宣言で確かめます。')),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, t('Feature', '機能')), ...SPECS.map((s) => el('th', {}, tr(s.name))))),
        el('tbody', {}, ...FEATURES.flatMap((g) => g.items.map((/** @type {any} */ [key, label]) => el('tr', {}, el('td', {}, tr(label)), ...SPECS.map((s) => el('td', {}, s.features[key] === true ? t('yes', 'あり') : s.features[key] === false ? '—' : tr(s.features[key])))))))))),
    note(t('The probe\'s pins run at the MCU\'s voltage. Check GND and the voltage before connecting a target. Provide level shifting separately where needed.', 'プローブのピンはMCUの電圧で動作します。相手と接続する前にGNDと電圧を確認してください。必要なレベル変換は、別途用意します。')),
    external(t('Features, pins and checks by board', 'ボードごとの機能・ピン・検証範囲'), DOCS[1][2]));
}
function usecases() {
  return el('div', { class: 'page' }, heading(t('What do you want to look into?', '何を確かめたいですか。'), t('Choose a purpose to see what to prepare, what this page does, and the steps after it. You can read this without a probe.', '目的を選ぶと、用意するもの、このページでできる範囲、その後の手順が分かります。まだプローブがなくても読めます。'), 'WHAT YOU CAN DO'),
    patternChoices('public'),
    el('div', { class: 'guide-path' }, el('h2', {}, t('Use it as a fixture or in automated tests', '治具・自動テストとして使う')), p(t('Prepare the wiring and idle states you use every time, and combine them with your development environment and scripts.', '毎回使う配線や待機状態を準備し、開発環境・スクリプトと組み合わせられます。')), external(t('All use-case guides', '用途別ガイドの全体を見る'), guide('use-cases')), link(t('Technology and development tools', '技術と開発ツールを見る'), '/learn')));
}
function usecase(id) {
  const pattern = SETUP_PATTERNS.find((tk) => tk.id === id), detail = USE_CASE_DETAILS[id];
  const go2 = actions(link(t('Make a probe for this →', 'この用途でプローブを作る →'), `/install/select?purpose=${id}`, true), button(connected() ? t('Prepare with the connected probe →', '接続中のプローブで準備する →') : t('Prepare with an installed probe →', '導入済みのプローブで準備する →'), () => choosePurpose(id), '', { 'data-purpose-connect': id }));
  if (pattern && detail) return el('div', { class: 'page' }, heading(pattern.title, detail.example, `USE CASE / ${pattern.label}`),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, t('What you get', '得られるもの')), p(detail.result), el('h2', {}, t('This page and the tools to combine', 'このページと、組み合わせる道具')), p(detail.scope)),
      panel(el('h2', {}, t('What to prepare', '用意するもの')), p(detail.needs), p(t('Wiring can be prepared without a target connected. Available features depend on the probe and firmware.', '配線の準備はターゲット未接続でもできます。使える機能はプローブとファームウェアにより異なります。'), 'muted'))),
    el('section', { class: 'panel mt' }, el('h2', {}, t('How it goes', 'この用途の進め方')), el('ol', { class: 'checklist' }, ...detail.steps.map((text, i) => el('li', {}, el('span', { class: 'check' }, i + 1), text)))),
    go2, external(t('Detailed steps and coverage', '詳しい手順・対応範囲'), guide(detail.guide)), ' ', textLink(t('Other uses', 'ほかの用途を見る'), '/usecases'));
  const tk = taskById(id);
  if (!tk) return notFound();
  return el('div', { class: 'page' }, heading(tk.title, tk.description, `USE CASE / ${tk.short}`),
    panel(el('h2', {}, t('What to prepare', '用意するもの')), el('ul', {}, el('li', {}, t('An OEP probe offering this function', 'この機能を提供するOEPプローブ')), el('li', {}, tk.roles?.length ? t(`Wiring for ${tk.roles.join(' / ')} and GND`, `${tk.roles.join(' / ')}とGNDの配線`) : t('Signal lines for the target\'s debug method, and GND', '相手のデバッグ方式に合う信号線とGND')), el('li', {}, t('The target chip or board, its voltage and connection checked', '電圧と接続条件を確認した相手のIC・基板')))),
    go2, textLink(t('Back to the uses', '用途の一覧に戻る'), '/usecases'));
}
function learn() {
  return el('div', { class: 'page' }, heading(t('OEP is a common agreement between boards and software.', 'OEPは、ボードとソフトウェアの共通の約束です。'), t('A specification for offering and using the functions of probes for embedded development with a common meaning, not tied to one board and app pairing.', '組み込み開発に使うプローブの機能を、特定のボードやアプリの組み合わせに閉じず、共通の意味で公開・利用するための仕様です。'), 'TECHNOLOGY & DOCUMENTATION'),
    el('div', { class: 'two-grid' }, heroDiagram(), el('div', {}, ...[[t('The probe tells its functions', 'プローブが機能を伝える'), t('Usable interfaces, pins, ranges and limits are read from the device. Operations are not decided from a fixed per-board table alone.', '使えるinterface、ピン、範囲や制約を実機から読みます。ボードごとの固定表だけで操作を決めません。')], [t('One device, many tools', 'ひとつの機器を、複数の道具で使う'), t('Use it from the browser, IDE, CLI and tests. Sessions and the right to change keep operations from clashing.', 'ブラウザ、IDE、CLI、テストから利用できます。操作が競合しないよう、セッションと変更権で調整します。')], [t('Combine standard and your own functions', '標準機能と独自機能を組み合わせる'), t('Besides the standard debug, bus and signal functions, you can add your own interfaces. Target-specific flash procedures belong to the host. Supporting OEP does not by itself mean writing every chip.', '標準のデバッグ・通信・信号機能に加え、独自interfaceを追加できます。ターゲット固有のflash手順はhost側が担います。OEP対応というだけで、全ICの書き込みに対応するわけではありません。')]].map(([tk, d]) => el('section', { class: 'mb' }, el('h2', {}, tk), p(d, 'muted'))))),
    el('section', { class: 'section' }, sectionTitle(t('Learn more, build your own.', '詳しく知る・作ってみる。'), t('Details are in each spec and implementation repository.', '詳細は、それぞれの仕様・実装リポジトリへ。')), el('div', { class: 'link-list' }, ...DOCS.map(([tk, d, href]) => el('a', { href, target: '_blank', rel: 'noopener', class: 'link-row' }, el('div', {}, el('h3', {}, tk), p(d)), el('span', { class: 'arrow' }, '↗'))))));
}

// -- probe creation (I01) --
function newInstall(boardId) {
  const keepIntent = state.install?.intent ?? state.intent;
  state.install = { board: boardId, target: null, custom: null, phase: 'idle', progress: { done: 0, total: 1, text: '' }, log: [], written: '', reason: '', intent: keepIntent };
}
function stepper(n) {
  return el('ol', { class: 'stepper', 'aria-label': t('Probe creation progress', 'プローブ作成の進行') }, ...[t('Choose a board', 'ボードを選ぶ'), t('Connect and review', '接続・内容確認'), t('Write and boot', '書き込み・起動'), t('First setup', '初期設定')].map((tk, i) => el('li', { class: i === n ? 'current' : i < n ? 'done' : '', 'aria-current': i === n ? 'step' : 'false' }, el('span', {}, i < n ? '✓' : String(i + 1)), tk)));
}
function installContext() {
  const intent = state.install?.intent;
  return intent ? panel(badge(t('Purpose to continue with after installing', '導入後に続ける用途')), el('h2', {}, purposeTitle(intent)), p(t('After writing and the boot check, you go on to setting up this purpose.', '書き込みと起動確認が終わると、この用途の設定に進みます。')),
    button(t('Choose another purpose', '用途を選び直す'), () => { state.install.intent = ''; state.intent = ''; go('/usecases'); })) : null;
}
function installFrame(n, content) {
  const b = BOARDS.find((x) => x.id === state.install?.board);
  return el('div', { class: 'page' }, stepper(n), n === 0 ? content : el('div', { class: 'install-layout' }, el('div', {}, content),
    el('aside', { class: 'install-aside' }, el('span', { class: 'chip-mark' }, b?.code ?? 'OEP'), el('h3', {}, b?.name ?? ''), p(t('The board becoming a probe', '今回プローブにするボード')),
      state.install?.target ? p(t(`Detected: ${state.install.target.chip}${state.install.target.revision != null ? ` v${state.install.target.revision}.x` : ''}`, `検出: ${state.install.target.chip}${state.install.target.revision != null ? ` v${state.install.target.revision}.x` : ''}`)) : null,
      p(t('No need to connect the target yet.', 'ターゲットはまだつながなくてかまいません。')), installContext())));
}
function installModel(tk) {
  const b = BOARDS.find((x) => x.id === state.install.board);
  if (!tk?.model) return { ok: false, why: t(`${tk?.chip ?? 'The device'} was not recognised as a chip this page can install.`, `${tk?.chip ?? '機器'}は、このページで導入できるチップとして判別できませんでした。`) };
  if (b.custom) return ['esp32s3', 'esp32c3', 'esp32c6'].includes(tk.model) ? { ok: true } : { ok: false, why: t(`There is released firmware for the ${tk.chip}. Install it from that board's card.`, `${tk.chip}には配布ファームウェアがあります。そのボードのカードから導入してください。`) };
  if (tk.method === 'serial' && !['esp32', 'esp32p4', 'esp32p4x'].includes(tk.model)) return { ok: false, why: t(`There is no released OepProbe image for the ${tk.chip}. You can install a compatible image of your own from "ESP32-S3 / C3 / C6".`, `${tk.chip}には配布のOepProbeファームウェアイメージがありません。「ESP32-S3 / C3 / C6」から、互換イメージを持ち込んで導入できます。`) };
  const kind = tk.method === 'serial' ? 'merged' : 'uf2';
  if (!D.releaseEntry(tk.model, kind)) return { ok: false, why: D.release.error ? t('The released firmware images could not be loaded. Fetch them again.', '配布ファームウェアイメージを読み込めませんでした。再取得してください。') : t(`This site has no image for the ${tk.chip}.`, `${tk.chip}向けのイメージが、このサイトにありません。`) };
  return { ok: true };
}
function install(view, query) {
  if (view === 'select') {
    const requested = query.get('purpose');
    if (!state.install || state.install.phase === 'done') newInstall('p4');
    if (requested !== null) state.install.intent = [...SETUP_PATTERNS, CONSOLE_TASK, ANALOG_TASK, ...TASKS].some((tk) => tk.id === requested) ? requested : '';
    else if (!query.has('keep')) { state.install.intent = ''; state.intent = ''; }
    return installFrame(0, [heading(t('Which board will be the probe?', 'どのボードをプローブにしますか。'), t('Choose by how it installs and what it offers. To use an installed probe, you do not need this.', '導入方法と特徴を見て選んでください。導入済みのプローブを使うときは、この選択は不要です。'), 'CREATE A PROBE'),
      installContext(), note(t('If you are getting a board, the ESP32-P4 is recommended. It covers debug, UART pass-through, logic capture and more.', 'これから用意するならESP32-P4を推奨します。デバッグ・UARTの素通し・ロジック観測など、幅広い用途に使えます。')),
      el('div', { class: 'two-grid' }, ...BOARDS.map((b) => boardCard(b, true))), actions(link(t('Next with this board →', '選んだボードで次へ →'), '/install/prepare', true), link(t('Use an installed probe', '導入済みのプローブを使う'), '/connect'))]);
  }
  if (!state.install) { newInstall('p4'); }
  const ins = state.install, b = BOARDS.find((x) => x.id === ins.board) ?? BOARDS[0];
  if (view === 'prepare') {
    const tk = ins.target, verdict = tk ? installModel(tk) : null;
    return installFrame(1, [heading(t(`Prepare the ${b.name}`, `${b.name}を用意する`), t('Connect it over USB and choose the device to write once. You do not need to choose a connection type.', 'USBでつないだら、書き込み先を一度だけ選びます。接続方式の種類を選ぶ必要はありません。'), 'CREATE A PROBE'),
      panel(el('h2', {}, t('First', '最初にすること')), el('ol', { class: 'checklist' }, ...[b.install, t('Close other serial tools', 'ほかのシリアルツールを閉じる'), t('Wiring to the target can be prepared after installing', 'ターゲットとの配線は、導入のあとで準備できます'), t('Choose the device to write with the button below', '下のボタンから書き込み先の機器を選択')].map((x, i) => el('li', {}, el('span', { class: 'check' }, `0${i + 1}`), x))),
        b.method === 'serial' ? p(t('If it does not enter download mode by itself, hold BOOT, press and release RESET, release BOOT, then choose again.', '自動で書き込みモードに入れない場合は、BOOTを押しながらRESETを押して離し、そのあとBOOTを離してから選び直します。'), 'muted') : null,
        b.custom ? field(t('Compatible merged .bin (offset 0, with the bootloader and the partition table at 0x8000)', '互換 merged .bin（offset 0、bootloaderと0x8000のpartition tableを含む）'), '', () => {}, t('An app-only image cannot boot a blank board.', 'app単体のイメージでは新品のボードは起動できません。'), null, 'file', { accept: '.bin', id: 'install-custom', onchange: (e) => { ins.custom = e.target.files[0] ?? null; render(); } }) : null,
        b.custom && ins.custom ? p(t(`Chosen image: ${ins.custom.name} (${ins.custom.size} bytes)`, `選んだイメージ: ${ins.custom.name}（${ins.custom.size} bytes）`)) : null,
        tk ? el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, b.code), el('div', {}, el('strong', {}, t(`${tk.chip}${tk.revision != null ? ` v${tk.revision}.x` : ''} — chosen`, `${tk.chip}${tk.revision != null ? ` v${tk.revision}.x` : ''} — 選択済み`)), p(b.port))) : null,
        verdict && !verdict.ok ? note(verdict.why, 'amber') : null,
        actions(action(tk ? t('Choose the device again', '書き込み先を選び直す') : t('Choose the device to write', '書き込み先を選ぶ'), async () => { ins.target = await D.chooseInstallTarget(b.method); }, tk ? '' : 'primary', { id: 'choose-device', disabled: !b.method }),
          tk && verdict?.ok && (!b.custom || ins.custom) ? link(t('Review →', '内容を確認する →'), '/install/review', true) : null)),
      actions(link(t('Back to choosing a board', 'ボード選択に戻る'), '/install/select?keep=1'))]);
  }
  if (!ins.target && ['review', 'writing', 'continue'].includes(view)) return installFrame(1, [heading(t('Choose the device to write', '書き込み先を選択してください'), t('Prepare this board first.', '先に、このボードの準備を行います。')), link(t('To choosing the device', '機器の選択へ'), '/install/prepare', true)]);
  if (view === 'review') {
    const tk = ins.target, kind = tk.method === 'serial' ? 'merged' : 'uf2', entry = b.custom ? null : D.releaseEntry(tk.model, kind);
    return installFrame(1, [heading(t('Install OEP on this board.', 'このボードにOEPを導入します。'), t('Check the detected chip and what will be written, then run it.', '検出したチップと書き込む内容を確認してから実行します。'), 'CREATE A PROBE'),
      panel(el('h2', {}, t('What will be installed', '導入内容')), keyValues([[t('Detected device', '検出した機器'), `${tk.chip}${tk.revision != null ? ` v${tk.revision}.x` : ''}`], [t('Firmware', 'ファームウェア'), b.custom ? t(`Your image ${ins.custom?.name}`, `持ち込みイメージ ${ins.custom?.name}`) : t(`OepProbe ${D.release.manifest?.version ?? ''} (${entry?.file ?? '—'})`, `OepProbe ${D.release.manifest?.version ?? ''}（${entry?.file ?? '—'}）`)],
        [t('Written to', '書き込み先'), tk.method === 'serial' ? t('From the start of flash (only the image\'s range; no full erase)', 'flashの先頭から（イメージの範囲だけ。全消去はしません）') : t('To flash through the BOOTSEL boot ROM', 'BOOTSELのboot ROM経由でflashへ')], [t('Settings', '設定'), t('Settings outside the written range are not erased, but are not guaranteed to survive. For an update, back them up first in "Update and maintenance".', '書き込む範囲の外にある設定は消しませんが、残ることは保証しません。更新なら先に「更新・保守」で控えを取ります。')], [t('Next screen', '次の画面'), t('Check that it boots, then go on to the first setup', '起動を確認し、そのまま初期設定へ')]]),
        note(t('While writing, do not unplug the cable or close this tab.', '書き込み中はケーブルを抜かず、このタブを閉じないでください。')),
        actions(action(t('Install OEP on this board', 'このボードにOEPを導入'), startInstall, 'primary', { id: 'start-install' }), link(t('Back', '戻る'), '/install/prepare')))]);
  }
  if (view === 'writing') {
    const pr = ins.progress;
    return installFrame(2, [heading(t('Installing OEP.', 'OEPを導入しています。'), t('Writing through the boot check runs as one job.', '書き込みから起動確認まで、同じ作業として続きます。'), 'CREATE A PROBE'), panel(
      el('progress', { id: 'install-progress', max: pr.total || 1, value: pr.done, 'aria-label': t('Installation progress', '導入の進行') }),
      el('p', { id: 'install-status', role: 'status' }, ins.phase === 'connecting' ? t('Written. Checking that it boots as OEP…', '書き込み完了。OEPとしての起動を確かめています…') : pr.text || t('Preparing…', '準備しています…')),
      el('ul', { class: 'checklist' }, ...[[t('Check the image and chip', 'イメージとチップの確認'), ins.phase !== 'idle'], [t('Write', '書き込み'), ['connecting', 'done', 'continue'].includes(ins.phase)], [t('Restart and check OEP', '再起動・OEPの確認'), ins.phase === 'done']].map(([v, ok]) => el('li', {}, el('span', { class: 'check' }, ok ? '✓' : t('·', '・')), v))),
      el('details', {}, el('summary', {}, t('Write log', '書き込みの記録')), el('pre', { id: 'install-log', class: 'terminal' }, ins.log.join('\n'))))]);
  }
  if (view === 'continue') {
    const serial = ins.target.method === 'serial';
    return installFrame(2, [heading(t('Writing is done. Go on to the setup.', '書き込みは完了しました。設定へ続けます。'), t('OEP has not answered yet. Without writing again, keep connecting to the same board.', 'OEPの応答をまだ確認できていません。書き込みをやり直さず、同じボードとの接続を続けます。'), 'CONTINUE SETUP'),
      panel(el('div', { class: 'big-status' }, '✓'), badge(t(`Written: ${ins.written}`, `書き込み完了: ${ins.written}`)), ins.reason ? p(t(`Why it could not be checked: ${ins.reason}`, `確認できなかった理由: ${ins.reason}`), 'muted mt') : null,
        el('h2', { class: 'mt' }, serial ? t('Wait for the board to boot, then retry on the same port.', 'ボードが起動するのを待って、同じポートで再試行します。') : t('Allow the booted OEP device in the browser.', '起動したOEPの機器を、ブラウザで許可します。')),
        p(serial ? t('If you are still holding BOOT, release it. If the port left the list, choose the booted OEP\'s port.', 'BOOTを押したままなら離してください。ポートが一覧から消えた場合は、起動したOEPのポートを選び直します。') : t('A Pico and similar boards restart as an OEP USB device after writing. It shows in the list as "OEP probe".', 'Picoなどは、書き込み後にOEPのUSB機器として起動し直します。一覧に出るのは「OEP probe」です。'), 'muted'),
        actions(action(t('Retry with the same device', '同じ機器で再試行'), async () => { const r = await D.reconnectAfterInstall(ins.target, 2); if (r.ok) finishInstall(); else { ins.reason = r.reason; throw new Error(r.reason); } }, serial ? 'primary' : '', { id: 'retry-install' }),
          action(serial ? t('Choose the booted OEP\'s port', '起動したOEPのポートを選ぶ') : t('Allow the booted OEP and connect', '起動したOEPを許可して接続'), async () => { await D.grantAfterInstall(ins.target); finishInstall(); }, serial ? '' : 'primary', { id: 'grant-install' })),
        el('details', { class: 'mt' }, el('summary', {}, t('If the device is not listed', '一覧に機器が出ないとき')), p(t('Unplug the same board\'s USB cable and plug it in again (without BOOTSEL or BOOT). Wait a few seconds, then press the button above. Nothing is written again.', '同じボードのUSBケーブルを抜いて、挿し直してください（BOOTSELやBOOTは押さない）。数秒待ってから上のボタンを押します。書き込みはやり直しません。')))),
      note(t('Your purpose and the write result are kept. No other board is opened automatically.', '用途と書き込み結果は保持しています。別のボードを自動で開くことはありません。'))]);
  }
  return notFound();
}
async function startInstall() {
  const ins = state.install, b = BOARDS.find((x) => x.id === ins.board);
  ins.phase = 'writing'; ins.log = []; ins.reason = ''; ins.target.knownSerials = await D.knownSerials();
  go('/install/writing');
  const progress = (done, total, text) => {
    ins.progress = { done, total, text };
    const bar = /** @type {HTMLProgressElement} */ (document.getElementById('install-progress')); if (bar) { bar.max = total || 1; bar.value = done; }
    const s = document.getElementById('install-status'); if (s) s.textContent = text;
  };
  const log = (line) => { ins.log.push(String(line)); if (ins.log.length > 200) ins.log.shift(); const l = document.getElementById('install-log'); if (l) l.textContent = ins.log.join('\n'); };
  try {
    ins.written = String(await D.writeInstall(ins.target, { custom: b.custom ? ins.custom : null, onProgress: progress, log }));
  } catch (error) { ins.phase = 'idle'; go('/install/review'); throw new Error(t(`Could not write. The board may be unchanged or partly written. You can install again. (${D.errorText(error)})`, `書き込めませんでした。ボードの中身は変わっていないか、途中までの可能性があります。もう一度導入できます。（${D.errorText(error)}）`)); }
  ins.phase = 'connecting'; render();
  const r = await D.reconnectAfterInstall(ins.target);
  if (r.ok) finishInstall();
  else { ins.phase = 'continue'; ins.reason = r.reason; go('/install/continue'); }
}
function finishInstall() {
  const ins = state.install;
  ins.phase = 'done';
  const next = ins.intent ? purposeRoute(ins.intent) : '/setup';
  if (ins.intent) D.rememberPurpose(ins.intent);
  state.notice = t(`OEP is installed (${ins.written}). You can go on setting it up on the same connection.`, `OEPの導入が完了しました（${ins.written}）。同じ接続のまま、設定を続けられます。`);
  state.intent = '';
  go(next);
}

// -- connecting (C01) --
let granted = null;
function connectScreen() {
  if (connected()) return el('div', { class: 'page' }, heading(t('A probe is connected.', 'プローブは接続済みです。'), D.unit()), actions(link(t('Back to work →', '作業に戻る →'), state.connectReturn || '/work', true), action(t('Disconnect and use another device', '接続を終了して別の機器を使う'), D.disconnect)));
  if (granted === null && D.browser.usb) { granted = []; D.grantedUsbProbes().then((g) => { granted = g; render(); }).catch(() => {}); }
  const done = async (open, expected) => { await D.connectWith(open, expected); const next = state.connectReturn || '/work'; if (state.intent) D.rememberPurpose(state.intent); state.connectReturn = '/work'; state.intent = ''; granted = null; go(next); };
  const known = D.knownProbes(), usbKnown = (granted ?? []).map((d) => ({ d, k: known.find((k) => k.unitId.toLowerCase() === String(d.serialNumber).toLowerCase()) }));
  return el('div', { class: 'page' }, heading(t('Use your probe.', '手元のプローブを使う。'), t('Choose an installed device. Its board type and features are read after connecting.', '導入済みの機器を選びます。ボードの種類と使える機能は、接続してから確かめます。'), 'CONNECT YOUR PROBE'),
    state.intent ? note(t(`After connecting you return to preparing "${purposeTitle(state.intent)}".`, `接続後に「${purposeTitle(state.intent)}」の準備へ戻ります。`)) : null,
    usbKnown.length ? panel(el('h2', {}, t('Probes allowed in this browser', 'このブラウザで許可済みのプローブ')), el('div', { class: 'stack' }, ...usbKnown.map(({ d, k }) => el('div', { class: 'connection-card' },
      el('header', {}, el('div', {}, el('h3', {}, d.productName ?? 'OEP probe'), p(t(`Unit ID ${d.serialNumber ?? '—'}${k ? ` · ${k.model} · last ${k.purpose ? purposeTitle(k.purpose) : 'work home'}` : ''}`, `個体ID ${d.serialNumber ?? '—'}${k ? ` · ${k.model} · 前回 ${k.purpose ? purposeTitle(k.purpose) : '作業ホーム'}` : ''}`), 'muted mb0'))),
      actions(action(t('Connect to this unit', 'この個体に接続'), () => done(D.openUsb(d, d.serialNumber && !String(d.serialNumber).toLowerCase().startsWith('x-') ? d.serialNumber : undefined)), 'primary', { 'data-unit': d.serialNumber })))))) : null,
    el('div', { class: 'two-grid mt' }, panel(el('h2', {}, t('Choose a device in the browser', 'ブラウザから機器を選ぶ')), p(t('Connect the probe with a USB cable and choose the unit from the list. A classic ESP32 or P4 works on the serial port used for writing.', 'USBケーブルでプローブをつなぎ、一覧から使う個体を選びます。classic ESP32やP4は、書き込みに使ったシリアルポートのままで使えます。')),
      actions(action(t('Choose a device and connect', '機器を選んで接続'), () => done(D.openSerial()), 'primary', { id: 'connect-serial', disabled: !D.browser.serial }), action(t('Choose from OEP USB devices', 'OEPのUSB端子から選ぶ'), () => done(D.openUsb()), '', { id: 'connect-usb', disabled: !D.browser.usb }))),
      panel(el('h2', {}, t('If OEP is not installed yet', 'まだOEPを導入していない場合')), p(t('First put the OEP firmware on the board. After writing, you can go straight on to the setup.', '先に、ボードへOEPのファームウェアを入れます。書き込みのあと、そのまま設定を続けられます。')), actions(link(t('Make a board a probe', 'ボードをプローブにする'), state.intent ? `/install/select?purpose=${state.intent}` : '/install/select')))),
    el('details', { class: 'panel mt' }, el('summary', {}, t('If the device is not in the list', '一覧に機器が見つからないとき')),
      p(t('Check that the cable carries data, that the device has booted, and that no other app holds the port. Probes not in the serial list (Pico, CH32, P4 native USB and so on) use "Choose from OEP USB devices". Try HID only when plain USB does not work.', 'データ通信できるケーブルか、機器が起動しているか、ほかのアプリがポートを使っていないかを確かめます。シリアルの一覧に出ないプローブ（Pico、CH32、P4のnative USBなど）は「OEPのUSB端子から選ぶ」を使います。通常のUSBが使えない場合だけHIDを試します。'), 'mt'),
      actions(action(t('Try connecting over HID', 'HIDで接続を試す'), () => done(D.openHid()), '', { disabled: !D.browser.hid }))));
}
function notFound() { return el('div', { class: 'page' }, heading(t('This screen does not exist.', 'この画面は見つかりません。'), t('Choose what you want to do from the start page.', '入口から、確認したい作業を選んでください。')), link(t('Back to the OEP start page', 'OEPの入口へ戻る'), '/home', true)); }

// -- router --
const LEGACY = { home: '/home', help: '/learn', firmware: '/install/select', connect: '/connect', setup: '/setup', probe: '/work', targets: '/connections', 'target/new': '/connection/new', debug: '/operate/debug', settings: '/settings', storage: '/maintenance', diagnostics: '/maintenance', tools: '/handoff' };
const SIGNAL_ROUTE = { gpio: 'gpio', uart: 'uart', 'i2c-controller': 'i2c', 'spi-controller': 'spi', 'i2c-target': 'i2c-target', 'spi-target': 'spi-target', pwm: 'pwm', counter: 'counter', dac: 'dac' };
function legacy(hash) {
  const raw = hash.replace(/^#/, '');
  if (!raw || raw.startsWith('/')) return null;
  if (raw === 'firmware' && connected()) return '/maintenance';
  if (raw.startsWith('target/edit/')) return `/connection/${raw.slice(12)}`;
  if (raw.startsWith('signals/')) return `/operate/${SIGNAL_ROUTE[raw.slice(8)] ?? 'gpio'}`;
  if (raw === 'signals') return '/operations';
  return LEGACY[raw] ?? '/home';
}
const WORKSPACE = ['setup', 'work', 'connections', 'connection', 'operations', 'operate', 'capture', 'passthrough', 'fixture', 'settings', 'maintenance', 'handoff'];
let currentRoute = '';
function draw(focus = true) {
  resetFieldIds();
  const old = legacy(location.hash);
  if (old) { history.replaceState(null, '', `#${old}`); }
  const route = routeNow(); currentRoute = route;
  const [path, params] = route.split('?'), query = new URLSearchParams(params);
  const [, view, id = ''] = path.split('/');
  const rest = path.split('/').slice(2).join('/');
  let content;
  try {
    content = view === 'home' ? home() : view === 'boards' ? boards() : view === 'learn' ? learn() : view === 'usecases' ? usecases() : view === 'usecase' ? usecase(id)
      : view === 'install' ? install(id, query) : view === 'connect' ? connectScreen()
      : view === 'setup' ? setup(id, query) : view === 'work' ? work() : view === 'connections' ? connections() : view === 'connection' ? editor(decodeURIComponent(rest), query)
      : view === 'operations' ? operations() : view === 'operate' ? operate(id, query) : view === 'capture' ? capture(query) : view === 'passthrough' ? passthrough()
      : view === 'fixture' ? fixture() : view === 'settings' ? settings(query) : view === 'maintenance' ? maintenance(query) : view === 'handoff' ? handoff() : notFound();
  } catch (error) { console.error(error); content = el('div', { class: 'page' }, heading(t('This screen could not be shown.', 'この画面を表示できませんでした。'), D.errorText(error)), link(t('To the work home', '作業ホームへ'), '/work', true)); }
  const app = document.getElementById('app');
  const keepScroll = !focus ? window.scrollY : 0;
  const active = /** @type {HTMLElement|null} */ (document.activeElement)?.id;
  app.replaceChildren(...shell(content, WORKSPACE.includes(view)).filter(Boolean));
  document.title = `${document.querySelector('h1')?.textContent ?? 'OEP'} — OEP`;
  if (focus) { window.scrollTo(0, 0); document.querySelector('h1')?.focus({ preventScroll: true }); }
  else { window.scrollTo(0, keepScroll); if (active) document.getElementById(active)?.focus({ preventScroll: true }); }
}
setRenderer(draw);
applyDocument();
onLanguage(() => draw(false));
document.addEventListener('click', (event) => {
  const target = /** @type {Element} */ (event.target);
  if (target.closest('.skip')) { event.preventDefault(); document.getElementById('content')?.focus(); return; }
  const anchor = target.closest('a[href^="#/"]');
  if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (state.install?.phase === 'writing') { announce(t('You cannot leave while writing.', '書き込み中は移動できません。')); return; }
  go(anchor.getAttribute('href').slice(1));
});
window.addEventListener('hashchange', () => {
  const next = routeNow();
  if (state.install?.phase === 'writing' && next !== '/install/writing') { history.replaceState(null, '', '#/install/writing'); return; }
  if (state.dirty && next !== currentRoute) { history.replaceState(null, '', `#${currentRoute}`); discardThen(() => { location.hash = next; }); return; }
  if (currentRoute.startsWith('/connection/') && !next.startsWith(currentRoute.split('?')[0])) state.draft = null;
  if (next.startsWith('/connect') && currentRoute !== next) granted = null;
  draw(true);
});
window.addEventListener('beforeunload', (e) => { if (state.dirty || state.install?.phase === 'writing' || D.dev.active.size) { e.preventDefault(); e.returnValue = ''; } });
draw(false);
D.loadRelease();
