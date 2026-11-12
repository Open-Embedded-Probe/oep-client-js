// OEP Web: the public entrance (P01-P04), probe creation (I01), connecting (C01) and the router. Screens follow
// docs/page.ja.md; the work screens are in work.js, operate.js and manage.js.
import { el, p, badge, actions, link, external, note, panel, heading, keyValues, sectionTitle, field, resetFieldIds, textLink } from './ui.js';
import { state, setRenderer, render, go, routeNow, discardThen, action, button, setErrorText, announce } from './core.js';
import * as D from './device.js';
import { BOARDS, TASKS, SETUP_PATTERNS, USE_CASE_DETAILS, DOCS, GUIDE_BASE, CONSOLE_TASK, ANALOG_TASK } from './data.js';
import { BOARDS as SPECS, FEATURES } from './boards.js';
import { connected, purposeRoute, purposeTitle, choosePurpose, patternChoices, workspaceShell, taskById } from './common.js';
import { setup, work, connections, editor, fixture } from './work.js';
import { operations, operate, capture, passthrough } from './operate.js';
import { settings, maintenance, handoff } from './manage.js';

setErrorText(D.errorText);
D.onChange(() => { if (!state.busy) render(); });

function shell(content, workspace) {
  const nav = [['/home', 'OEPとは'], ['/usecases', 'できること'], ['/boards', '対応ボード'], ['/learn', '技術・資料']];
  const route = routeNow();
  return [
    el('header', { class: 'site-header' }, el('a', { href: '#/home', class: 'brand', 'aria-label': 'OEP トップ' }, el('span', { class: 'brand-icon' }, 'OEP'), el('span', { class: 'brand-name' }, 'Open Embedded Probe', el('small', {}, 'CONNECT. EXPLORE. BUILD.'))),
      el('nav', { class: 'public-nav', 'aria-label': 'OEPの案内' }, ...nav.map(([path, name]) => el('a', { href: `#${path}`, class: route === path ? 'active' : '', 'aria-current': route === path ? 'page' : 'false' }, name))),
      el('a', { class: 'btn header-action', href: connected() ? '#/work' : '#/install/select' }, connected() ? '作業に戻る →' : 'プローブを作る →')),
    !D.browser.secure ? note('機器の接続にはHTTPSかlocalhostが必要です。説明はこのまま読めます。', 'amber') : (!D.browser.usb && !D.browser.serial) ? note('機器の接続には、デスクトップ版のChromeかEdgeを使ってください。説明はこのブラウザでも読めます。', 'amber') : null,
    workspace ? workspaceShell(content) : el('main', { id: 'content', class: 'container', tabindex: -1 }, content),
    el('footer', { class: 'footer' }, el('span', {}, 'Open Embedded Probe', p('ボードと開発ツールを、共通の方法でつなぐ。', 'mb0')), el('span', {}, `oep-client-js ${D.VERSION ?? ''}`), external('GitHub / OEP', 'https://github.com/Open-Embedded-Probe')),
  ];
}
function heroDiagram() {
  return el('div', { class: 'bench', role: 'img', 'aria-label': 'PCのブラウザや開発ツールがOEPプローブを介して、開発中のICや基板につながります。' },
    el('span', { class: 'bench-label' }, 'ONE PROBE, MANY POSSIBILITIES'),
    el('div', { class: 'bench-row' }, el('div', { class: 'diagram-box' }, 'ブラウザ', el('span', {}, 'セットアップ・操作')), el('div', { class: 'diagram-box' }, 'IDE / テスト', el('span', {}, '開発・自動化'))),
    el('div', { class: 'probe-board' }, el('strong', {}, 'OEP'), el('small', {}, 'YOUR DEVELOPMENT BOARD')),
    el('div', { class: 'connection-line' }, '↓ デバッグ・通信・信号・観測 ↓'),
    el('div', { class: 'bench-row' }, el('div', { class: 'diagram-box' }, '開発中のIC・基板', el('span', {}, 'ターゲット'))));
}

// -- public pages (P01-P04) --
function home() {
  return [
    el('section', { class: 'hero' }, el('div', { class: 'hero-copy' }, p('OPEN EMBEDDED PROBE', 'eyebrow'), el('h1', { tabindex: -1 }, '手元のボードを、', el('br'), '開発のための', el('br'), '共通プローブに。'),
      p('Open Embedded Probeは、デバッグ・通信・信号制御・計測を、PCから共通の方法で使うための仕様です。対応ファームウェアを入れた開発ボードを、用途に応じた道具として使えます。'),
      actions(link('ボードをプローブにする →', '/install/select', true), link(connected() ? '作業に戻る' : '導入済みのプローブを使う', connected() ? '/work' : '/connect')),
      p('まずはブラウザで導入・設定。必要に応じてIDEやテストツールへ。読むだけなら機器の許可は要りません。', 'hero-foot')), heroDiagram()),
    el('section', { class: 'section' }, sectionTitle('ひとつの接続から、いろいろな作業へ。', '利用できる機能は、ボードとファームウェアで異なります。接続後にプローブから確かめます。', 'WHAT YOU CAN DO'),
      patternChoices('public'), actions(link('自動テスト・開発ツールを知る', '/learn'))),
    el('section', { class: 'section' }, sectionTitle('これから用意するなら、ESP32-P4。', '推奨ボードはESP32-P4です。手元の対応ボードからも始められます。導入済みなら、種類を選ばず接続できます。', 'BOARDS'),
      el('div', { class: 'three-grid' }, ...BOARDS.slice(0, 3).map((b) => boardCard(b, false, true))), actions(link('すべてのボードと制約を見る', '/boards'))),
    el('section', { class: 'section' }, sectionTitle('書き込んだら、そのまま設定へ。', 'ターゲットがまだなくても、配線の登録はできます。', 'GET STARTED'),
      el('div', { class: 'steps-overview' }, ...[['ボードをつなぐ', '書き込みに使う機器を、ブラウザから一度選択。'], ['OEPを導入する', 'チップとファームウェアイメージを確かめ、書き込みから起動まで続けます。'], ['用途に合わせて設定する', 'デバッグ・UARTの素通し・観測など、使い方から配線と条件を準備。'], ['目的の作業を始める', 'ログ、通信、信号、デバッグ。必要な道具へ進みます。']].map(([t, d]) => el('div', {}, el('h3', {}, t), p(d)))),
      p('起動後にUSBの構成が変わる場合は、必要な使用許可やケーブルの抜き差しを、同じ画面で案内します。', 'muted compact')),
    el('section', { class: 'section' }, el('div', { class: 'tech-block' }, el('div', {}, p('HOW OEP WORKS', 'eyebrow'), el('h2', {}, 'ボードごとの違いを、', el('br'), '共通の機能として扱う。'), p('プローブ自身が機能とピンの制約を伝え、アプリは理解できる機能を利用します。OEPは、特定のボードだけのための道具ではありません。'), el('a', { class: 'text-link', href: '#/learn' }, '技術の概要と資料へ →')),
      el('div', { class: 'tech-lines' }, ...[['機能を宣言する', '提供できる機能と、その条件を実機から取得。'], ['共通の方法で使う', 'USBやシリアルの上で、同じ意味の操作を利用。'], ['用途に合わせて拡張する', '標準interfaceと独自の機能を組み合わせる。']].map(([t, d]) => el('div', {}, el('strong', {}, t), el('small', {}, d))))))];
}
function boardStatus(b) {
  const specs = b.ids.map((id) => SPECS.find((s) => s.id === id)).filter(Boolean);
  const released = specs.some((s) => s.tier === 'release');
  const verified = specs.map((s) => s.verified === true ? '実機で確認' : s.verified === false ? '実機は未確認' : s.verified.ja);
  return [released ? '配布firmwareあり' : '配布firmwareなし（自分でビルド）', b.installable ? (b.custom ? 'このページで導入（イメージを持ち込む）' : 'このページで新規導入') : 'このページでの新規導入は対象外', `検証: ${[...new Set(verified)].join(' / ')}`];
}
function boardCard(b, select = false, compact = false) {
  return el('section', { class: `board-card${b.recommended ? ' recommended' : ''}${select && state.install?.board === b.id ? ' selected' : ''}` },
    el('div', { class: 'board-meta' }, el('span', { class: 'chip-mark' }, b.code), badge(b.tag, b.installable ? '' : 'amber')),
    el('h3', {}, b.name), p(b.title), !compact ? p(b.description) : null,
    el('ul', {}, ...b.features.map((f) => el('li', {}, f))),
    !compact ? el('ul', { class: 'muted' }, ...boardStatus(b).map((t) => el('li', {}, t))) : null, !compact ? p(b.note, 'compact') : null,
    actions(select ? button(state.install?.board === b.id ? '選択中 ✓' : 'このボードを選ぶ', () => { newInstall(b.id); render(); }, state.install?.board === b.id ? 'primary' : '', { disabled: !b.installable, 'data-board': b.id })
      : button(b.installable ? 'このボードで始める →' : '導入済みの機器を使う', () => { state.intent = ''; if (b.installable) { newInstall(b.id); go('/install/prepare'); } else { state.connectReturn = '/work'; go('/connect'); } }, '', { 'data-board': b.id })));
}
function boards() {
  return el('div', { class: 'page' }, heading('手元のボードから、始められます。', '配布ファームウェア、使える機能、導入方法はボードごとに異なります。違いを見ながら、目的に合うものを選んでください。', 'SUPPORTED BOARDS'),
    el('div', { class: 'two-grid' }, ...BOARDS.map((b) => boardCard(b))),
    el('section', { class: 'section' }, sectionTitle('ボードごとの機能', '配布firmwareの機能の一覧です。実際に使える機能は、接続後にプローブの宣言で確かめます。'),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '機能'), ...SPECS.map((s) => el('th', {}, s.name.ja)))),
        el('tbody', {}, ...FEATURES.flatMap((g) => g.items.map((/** @type {any} */ [key, label]) => el('tr', {}, el('td', {}, label.ja), ...SPECS.map((s) => el('td', {}, s.features[key] === true ? 'あり' : s.features[key] === false ? '—' : /** @type {any} */ (s.features[key]).ja))))))))),
    note('プローブのピンはMCUの電圧で動作します。相手と接続する前にGNDと電圧を確認してください。必要なレベル変換は、別途用意します。'),
    external('ボードごとの機能・ピン・検証範囲', DOCS[1][2]));
}
function usecases() {
  return el('div', { class: 'page' }, heading('何を確かめたいですか。', '目的を選ぶと、用意するもの、このページでできる範囲、その後の手順が分かります。まだプローブがなくても読めます。', 'WHAT YOU CAN DO'),
    patternChoices('public'),
    el('div', { class: 'guide-path' }, el('h2', {}, '治具・自動テストとして使う'), p('毎回使う配線や待機状態を準備し、開発環境・スクリプトと組み合わせられます。'), external('用途別ガイドの全体を見る', GUIDE_BASE + 'use-cases.ja.md'), link('技術と開発ツールを見る', '/learn')));
}
function usecase(id) {
  const pattern = SETUP_PATTERNS.find((t) => t.id === id), detail = USE_CASE_DETAILS[id];
  const go2 = actions(link('この用途でプローブを作る →', `/install/select?purpose=${id}`, true), button(connected() ? '接続中のプローブで準備する →' : '導入済みのプローブで準備する →', () => choosePurpose(id), '', { 'data-purpose-connect': id }));
  if (pattern && detail) return el('div', { class: 'page' }, heading(pattern.title, detail.example, `USE CASE / ${pattern.label}`),
    el('div', { class: 'two-grid' }, panel(el('h2', {}, '得られるもの'), p(detail.result), el('h2', {}, 'このページと、組み合わせる道具'), p(detail.scope)),
      panel(el('h2', {}, '用意するもの'), p(detail.needs), p('配線の準備はターゲット未接続でもできます。使える機能はプローブとファームウェアにより異なります。', 'muted'))),
    el('section', { class: 'panel mt' }, el('h2', {}, 'この用途の進め方'), el('ol', { class: 'checklist' }, ...detail.steps.map((text, i) => el('li', {}, el('span', { class: 'check' }, i + 1), text)))),
    go2, external('詳しい手順・対応範囲', GUIDE_BASE + detail.guide), ' ', textLink('ほかの用途を見る', '/usecases'));
  const t = taskById(id);
  if (!t) return notFound();
  return el('div', { class: 'page' }, heading(t.title, t.description, `USE CASE / ${t.short}`),
    panel(el('h2', {}, '用意するもの'), el('ul', {}, el('li', {}, 'この機能を提供するOEPプローブ'), el('li', {}, t.roles?.length ? `${t.roles.join(' / ')}とGNDの配線` : '相手のデバッグ方式に合う信号線とGND'), el('li', {}, '電圧と接続条件を確認した相手のIC・基板'))),
    go2, textLink('用途の一覧に戻る', '/usecases'));
}
function learn() {
  return el('div', { class: 'page' }, heading('OEPは、ボードとソフトウェアの共通の約束です。', '組み込み開発に使うプローブの機能を、特定のボードやアプリの組み合わせに閉じず、共通の意味で公開・利用するための仕様です。', 'TECHNOLOGY & DOCUMENTATION'),
    el('div', { class: 'two-grid' }, heroDiagram(), el('div', {}, ...[['プローブが機能を伝える', '使えるinterface、ピン、範囲や制約を実機から読みます。ボードごとの固定表だけで操作を決めません。'], ['ひとつの機器を、複数の道具で使う', 'ブラウザ、IDE、CLI、テストから利用できます。操作が競合しないよう、セッションと変更権で調整します。'], ['標準機能と独自機能を組み合わせる', '標準のデバッグ・通信・信号機能に加え、独自interfaceを追加できます。ターゲット固有のflash手順はhost側が担います。OEP対応というだけで、全ICの書き込みに対応するわけではありません。']].map(([t, d]) => el('section', { class: 'mb' }, el('h2', {}, t), p(d, 'muted'))))),
    el('section', { class: 'section' }, sectionTitle('詳しく知る・作ってみる。', '詳細は、それぞれの仕様・実装リポジトリへ。'), el('div', { class: 'link-list' }, ...DOCS.map(([t, d, href]) => el('a', { href, target: '_blank', rel: 'noopener', class: 'link-row' }, el('div', {}, el('h3', {}, t), p(d)), el('span', { class: 'arrow' }, '↗'))))));
}

// -- probe creation (I01) --
function newInstall(boardId) {
  const keepIntent = state.install?.intent ?? state.intent;
  state.install = { board: boardId, target: null, custom: null, phase: 'idle', progress: { done: 0, total: 1, text: '' }, log: [], written: '', reason: '', intent: keepIntent };
}
function stepper(n) {
  return el('ol', { class: 'stepper', 'aria-label': 'プローブ作成の進行' }, ...['ボードを選ぶ', '接続・内容確認', '書き込み・起動', '初期設定'].map((t, i) => el('li', { class: i === n ? 'current' : i < n ? 'done' : '', 'aria-current': i === n ? 'step' : 'false' }, el('span', {}, i < n ? '✓' : String(i + 1)), t)));
}
function installContext() {
  const intent = state.install?.intent;
  return intent ? panel(badge('導入後に続ける用途'), el('h2', {}, purposeTitle(intent)), p('書き込みと起動確認が終わると、この用途の設定に進みます。'),
    button('用途を選び直す', () => { state.install.intent = ''; state.intent = ''; go('/usecases'); })) : null;
}
function installFrame(n, content) {
  const b = BOARDS.find((x) => x.id === state.install?.board);
  return el('div', { class: 'page' }, stepper(n), n === 0 ? content : el('div', { class: 'install-layout' }, el('div', {}, content),
    el('aside', { class: 'install-aside' }, el('span', { class: 'chip-mark' }, b?.code ?? 'OEP'), el('h3', {}, b?.name ?? ''), p('今回プローブにするボード'),
      state.install?.target ? p(`検出: ${state.install.target.chip}${state.install.target.revision != null ? ` v${state.install.target.revision}.x` : ''}`) : null,
      p('ターゲットはまだつながなくてかまいません。'), installContext())));
}
function installModel(t) {
  const b = BOARDS.find((x) => x.id === state.install.board);
  if (!t?.model) return { ok: false, why: `${t?.chip ?? '機器'}は、このページで導入できるチップとして判別できませんでした。` };
  if (b.custom) return ['esp32s3', 'esp32c3', 'esp32c6'].includes(t.model) ? { ok: true } : { ok: false, why: `${t.chip}には配布ファームウェアがあります。そのボードのカードから導入してください。` };
  if (t.method === 'serial' && !['esp32', 'esp32p4', 'esp32p4x'].includes(t.model)) return { ok: false, why: `${t.chip}には配布のOepProbeファームウェアイメージがありません。「ESP32-S3 / C3 / C6」から、互換イメージを持ち込んで導入できます。` };
  const kind = t.method === 'serial' ? 'merged' : 'uf2';
  if (!D.releaseEntry(t.model, kind)) return { ok: false, why: D.release.error ? '配布ファームウェアイメージを読み込めませんでした。再取得してください。' : `${t.chip}向けのイメージが、このサイトにありません。` };
  return { ok: true };
}
function install(view, query) {
  if (view === 'select') {
    const requested = query.get('purpose');
    if (!state.install || state.install.phase === 'done') newInstall('p4');
    if (requested !== null) state.install.intent = [...SETUP_PATTERNS, CONSOLE_TASK, ANALOG_TASK, ...TASKS].some((t) => t.id === requested) ? requested : '';
    else if (!query.has('keep')) { state.install.intent = ''; state.intent = ''; }
    return installFrame(0, [heading('どのボードをプローブにしますか。', '導入方法と特徴を見て選んでください。導入済みのプローブを使うときは、この選択は不要です。', 'CREATE A PROBE'),
      installContext(), note('これから用意するならESP32-P4を推奨します。デバッグ・UARTの素通し・ロジック観測など、幅広い用途に使えます。'),
      el('div', { class: 'two-grid' }, ...BOARDS.map((b) => boardCard(b, true))), actions(link('選んだボードで次へ →', '/install/prepare', true), link('導入済みのプローブを使う', '/connect'))]);
  }
  if (!state.install) { newInstall('p4'); }
  const ins = state.install, b = BOARDS.find((x) => x.id === ins.board) ?? BOARDS[0];
  if (view === 'prepare') {
    const t = ins.target, verdict = t ? installModel(t) : null;
    return installFrame(1, [heading(`${b.name}を用意する`, 'USBでつないだら、書き込み先を一度だけ選びます。接続方式の種類を選ぶ必要はありません。', 'CREATE A PROBE'),
      panel(el('h2', {}, '最初にすること'), el('ol', { class: 'checklist' }, ...[b.install, 'ほかのシリアルツールを閉じる', 'ターゲットとの配線は、導入のあとで準備できます', '下のボタンから書き込み先の機器を選択'].map((x, i) => el('li', {}, el('span', { class: 'check' }, `0${i + 1}`), x))),
        b.method === 'serial' ? p('自動で書き込みモードに入れない場合は、BOOTを押しながらRESETを押して離し、そのあとBOOTを離してから選び直します。', 'muted') : null,
        b.custom ? field('互換 merged .bin（offset 0、bootloaderと0x8000のpartition tableを含む）', '', () => {}, 'app単体のイメージでは新品のボードは起動できません。', null, 'file', { accept: '.bin', id: 'install-custom', onchange: (e) => { ins.custom = e.target.files[0] ?? null; render(); } }) : null,
        b.custom && ins.custom ? p(`選んだイメージ: ${ins.custom.name}（${ins.custom.size} bytes）`) : null,
        t ? el('div', { class: 'demo-device' }, el('span', { class: 'chip-mark' }, b.code), el('div', {}, el('strong', {}, `${t.chip}${t.revision != null ? ` v${t.revision}.x` : ''} — 選択済み`), p(b.port))) : null,
        verdict && !verdict.ok ? note(verdict.why, 'amber') : null,
        actions(action(t ? '書き込み先を選び直す' : '書き込み先を選ぶ', async () => { ins.target = await D.chooseInstallTarget(b.method); }, t ? '' : 'primary', { id: 'choose-device', disabled: !b.method }),
          t && verdict?.ok && (!b.custom || ins.custom) ? link('内容を確認する →', '/install/review', true) : null)),
      actions(link('ボード選択に戻る', '/install/select?keep=1'))]);
  }
  if (!ins.target && ['review', 'writing', 'continue'].includes(view)) return installFrame(1, [heading('書き込み先を選択してください', '先に、このボードの準備を行います。'), link('機器の選択へ', '/install/prepare', true)]);
  if (view === 'review') {
    const t = ins.target, kind = t.method === 'serial' ? 'merged' : 'uf2', entry = b.custom ? null : D.releaseEntry(t.model, kind);
    return installFrame(1, [heading('このボードにOEPを導入します。', '検出したチップと書き込む内容を確認してから実行します。', 'CREATE A PROBE'),
      panel(el('h2', {}, '導入内容'), keyValues([['検出した機器', `${t.chip}${t.revision != null ? ` v${t.revision}.x` : ''}`], ['ファームウェア', b.custom ? `持ち込みイメージ ${ins.custom?.name}` : `OepProbe ${D.release.manifest?.version ?? ''}（${entry?.file ?? '—'}）`],
        ['書き込み先', t.method === 'serial' ? 'flashの先頭から（イメージの範囲だけ。全消去はしません）' : 'BOOTSELのboot ROM経由でflashへ'], ['設定', '書き込む範囲の外にある設定は消しませんが、残ることは保証しません。更新なら先に「更新・保守」で控えを取ります。'], ['次の画面', '起動を確認し、そのまま初期設定へ']]),
        note('書き込み中はケーブルを抜かず、このタブを閉じないでください。'),
        actions(action('このボードにOEPを導入', startInstall, 'primary', { id: 'start-install' }), link('戻る', '/install/prepare')))]);
  }
  if (view === 'writing') {
    const pr = ins.progress;
    return installFrame(2, [heading('OEPを導入しています。', '書き込みから起動確認まで、同じ作業として続きます。', 'CREATE A PROBE'), panel(
      el('progress', { id: 'install-progress', max: pr.total || 1, value: pr.done, 'aria-label': '導入の進行' }),
      el('p', { id: 'install-status', role: 'status' }, ins.phase === 'connecting' ? '書き込み完了。OEPとしての起動を確かめています…' : pr.text || '準備しています…'),
      el('ul', { class: 'checklist' }, ...[['イメージとチップの確認', ins.phase !== 'idle'], ['書き込み', ['connecting', 'done', 'continue'].includes(ins.phase)], ['再起動・OEPの確認', ins.phase === 'done']].map(([v, ok]) => el('li', {}, el('span', { class: 'check' }, ok ? '✓' : '・'), v))),
      el('details', {}, el('summary', {}, '書き込みの記録'), el('pre', { id: 'install-log', class: 'terminal' }, ins.log.join('\n'))))]);
  }
  if (view === 'continue') {
    const serial = ins.target.method === 'serial';
    return installFrame(2, [heading('書き込みは完了しました。設定へ続けます。', 'OEPの応答をまだ確認できていません。書き込みをやり直さず、同じボードとの接続を続けます。', 'CONTINUE SETUP'),
      panel(el('div', { class: 'big-status' }, '✓'), badge(`書き込み完了: ${ins.written}`), ins.reason ? p(`確認できなかった理由: ${ins.reason}`, 'muted mt') : null,
        el('h2', { class: 'mt' }, serial ? 'ボードが起動するのを待って、同じポートで再試行します。' : '起動したOEPの機器を、ブラウザで許可します。'),
        p(serial ? 'BOOTを押したままなら離してください。ポートが一覧から消えた場合は、起動したOEPのポートを選び直します。' : 'Picoなどは、書き込み後にOEPのUSB機器として起動し直します。一覧に出るのは「OEP probe」です。', 'muted'),
        actions(action('同じ機器で再試行', async () => { const r = await D.reconnectAfterInstall(ins.target, 2); if (r.ok) finishInstall(); else { ins.reason = r.reason; throw new Error(r.reason); } }, serial ? 'primary' : '', { id: 'retry-install' }),
          action(serial ? '起動したOEPのポートを選ぶ' : '起動したOEPを許可して接続', async () => { await D.grantAfterInstall(ins.target); finishInstall(); }, serial ? '' : 'primary', { id: 'grant-install' })),
        el('details', { class: 'mt' }, el('summary', {}, '一覧に機器が出ないとき'), p('同じボードのUSBケーブルを抜いて、挿し直してください（BOOTSELやBOOTは押さない）。数秒待ってから上のボタンを押します。書き込みはやり直しません。'))),
      note('用途と書き込み結果は保持しています。別のボードを自動で開くことはありません。')]);
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
  } catch (error) { ins.phase = 'idle'; go('/install/review'); throw new Error(`書き込めませんでした。ボードの中身は変わっていないか、途中までの可能性があります。もう一度導入できます。（${D.errorText(error)}）`); }
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
  state.notice = `OEPの導入が完了しました（${ins.written}）。同じ接続のまま、設定を続けられます。`;
  state.intent = '';
  go(next);
}

// -- connecting (C01) --
let granted = null;
function connectScreen() {
  if (connected()) return el('div', { class: 'page' }, heading('プローブは接続済みです。', D.unit()), actions(link('作業に戻る →', state.connectReturn || '/work', true), action('接続を終了して別の機器を使う', D.disconnect)));
  if (granted === null && D.browser.usb) { granted = []; D.grantedUsbProbes().then((g) => { granted = g; render(); }).catch(() => {}); }
  const done = async (open, expected) => { await D.connectWith(open, expected); const next = state.connectReturn || '/work'; if (state.intent) D.rememberPurpose(state.intent); state.connectReturn = '/work'; state.intent = ''; granted = null; go(next); };
  const known = D.knownProbes(), usbKnown = (granted ?? []).map((d) => ({ d, k: known.find((k) => k.unitId.toLowerCase() === String(d.serialNumber).toLowerCase()) }));
  return el('div', { class: 'page' }, heading('手元のプローブを使う。', '導入済みの機器を選びます。ボードの種類と使える機能は、接続してから確かめます。', 'CONNECT YOUR PROBE'),
    state.intent ? note(`接続後に「${purposeTitle(state.intent)}」の準備へ戻ります。`) : null,
    usbKnown.length ? panel(el('h2', {}, 'このブラウザで許可済みのプローブ'), el('div', { class: 'stack' }, ...usbKnown.map(({ d, k }) => el('div', { class: 'connection-card' },
      el('header', {}, el('div', {}, el('h3', {}, d.productName ?? 'OEP probe'), p(`個体ID ${d.serialNumber ?? '—'}${k ? ` · ${k.model} · 前回 ${k.purpose ? purposeTitle(k.purpose) : '作業ホーム'}` : ''}`, 'muted mb0'))),
      actions(action('この個体に接続', () => done(D.openUsb(d, d.serialNumber && !String(d.serialNumber).toLowerCase().startsWith('x-') ? d.serialNumber : undefined)), 'primary', { 'data-unit': d.serialNumber })))))) : null,
    el('div', { class: 'two-grid mt' }, panel(el('h2', {}, 'ブラウザから機器を選ぶ'), p('USBケーブルでプローブをつなぎ、一覧から使う個体を選びます。classic ESP32やP4は、書き込みに使ったシリアルポートのままで使えます。'),
      actions(action('機器を選んで接続', () => done(D.openSerial()), 'primary', { id: 'connect-serial', disabled: !D.browser.serial }), action('OEPのUSB端子から選ぶ', () => done(D.openUsb()), '', { id: 'connect-usb', disabled: !D.browser.usb }))),
      panel(el('h2', {}, 'まだOEPを導入していない場合'), p('先に、ボードへOEPのファームウェアを入れます。書き込みのあと、そのまま設定を続けられます。'), actions(link('ボードをプローブにする', state.intent ? `/install/select?purpose=${state.intent}` : '/install/select')))),
    el('details', { class: 'panel mt' }, el('summary', {}, '一覧に機器が見つからないとき'),
      p('データ通信できるケーブルか、機器が起動しているか、ほかのアプリがポートを使っていないかを確かめます。シリアルの一覧に出ないプローブ（Pico、CH32、P4のnative USBなど）は「OEPのUSB端子から選ぶ」を使います。通常のUSBが使えない場合だけHIDを試します。', 'mt'),
      actions(action('HIDで接続を試す', () => done(D.openHid()), '', { disabled: !D.browser.hid }))));
}
function notFound() { return el('div', { class: 'page' }, heading('この画面は見つかりません。', '入口から、確認したい作業を選んでください。'), link('OEPの入口へ戻る', '/home', true)); }

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
  } catch (error) { console.error(error); content = el('div', { class: 'page' }, heading('この画面を表示できませんでした。', D.errorText(error)), link('作業ホームへ', '/work', true)); }
  const app = document.getElementById('app');
  const keepScroll = !focus ? window.scrollY : 0;
  const active = /** @type {HTMLElement|null} */ (document.activeElement)?.id;
  app.replaceChildren(...shell(content, WORKSPACE.includes(view)).filter(Boolean));
  document.title = `${document.querySelector('h1')?.textContent ?? 'OEP'} — OEP`;
  if (focus) { window.scrollTo(0, 0); document.querySelector('h1')?.focus({ preventScroll: true }); }
  else { window.scrollTo(0, keepScroll); if (active) document.getElementById(active)?.focus({ preventScroll: true }); }
}
setRenderer(draw);
document.addEventListener('click', (event) => {
  const target = /** @type {Element} */ (event.target);
  if (target.closest('.skip')) { event.preventDefault(); document.getElementById('content')?.focus(); return; }
  const anchor = target.closest('a[href^="#/"]');
  if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (state.install?.phase === 'writing') { announce('書き込み中は移動できません。'); return; }
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
