// OEP Probe Tool (docs/page.ja.md): the start (S1), making a probe (S2), connecting (S3), the probe's tabs (P1-P6) and the
// router. The tabs are in probe.js and wiring.js; everything done to a probe goes through device.js.
import { el, p, badge, actions, link, external, note, panel, heading, keyValues, field, resetFieldIds, textLink } from './ui.js';
import { state, setRenderer, render, go, routeNow, discardThen, action, button, setErrorText, announce } from './core.js';
import * as D from './device.js';
import { BOARDS, USES, DOCS } from './data.js';
import { t, tr, lang, setLang, LANGUAGES, onLanguage, applyDocument } from './i18n.js';
import { BOARDS as SPECS, FEATURES } from './boards.js';
import { connected, needConnection, probeFrame } from './common.js';
import { wiringList, editor } from './wiring.js';
import { overview, settings, tools, maintenance } from './probe.js';

setErrorText(D.errorText);
D.onChange(() => { if (!state.busy) render(); });

function shell(content) {
  return [
    el('header', { class: 'site-header' }, el('a', { href: '#/', class: 'brand', 'aria-label': t('OEP Probe Tool start', 'OEP Probe Tool のスタート') }, el('span', { class: 'brand-icon' }, 'OEP'), el('span', { class: 'brand-name' }, 'OEP Probe Tool', el('small', {}, t('MAKE. SET UP. HAND OVER.', 'MAKE. SET UP. HAND OVER.')))),
      el('span', { class: 'header-gap' }),
      el('label', { class: 'language' }, el('span', { class: 'sr-only' }, t('Language', '言語')),
        el('select', { id: 'language', onchange: (e) => setLang(e.target.value) }, ...LANGUAGES.map(([id, name]) => el('option', { value: id, selected: id === lang }, name)))),
      connected() && !routeNow().startsWith('/probe') ? el('a', { class: 'btn header-action', href: '#/probe' }, t('To the probe →', 'プローブへ →')) : null),
    !D.browser.secure ? note(t('Connecting devices needs HTTPS or localhost. You can still read everything here.', '機器の接続にはHTTPSかlocalhostが必要です。説明はこのまま読めます。'), 'amber') : (!D.browser.usb && !D.browser.serial) ? note(t('To connect devices, use desktop Chrome or Edge. You can still read everything in this browser.', '機器の接続には、デスクトップ版のChromeかEdgeを使ってください。説明はこのブラウザでも読めます。'), 'amber') : null,
    el('main', { id: 'content', class: 'container', tabindex: -1 }, content),
    el('footer', { class: 'footer' }, el('span', {}, 'Open Embedded Probe', p(t('Connecting boards and development tools in a common way.', 'ボードと開発ツールを、共通の方法でつなぐ。'), 'mb0')), el('span', {}, `oep-client-js ${D.VERSION ?? ''}`), external('GitHub / OEP', 'https://github.com/Open-Embedded-Probe')),
  ];
}

// -- S1: the start (page.ja.md §3) --
function start() {
  const known = D.knownProbes().slice(0, 5);
  return el('div', { class: 'page' },
    el('section', { class: 'hero start' }, el('div', { class: 'hero-copy' }, p('OPEN EMBEDDED PROBE', 'eyebrow'),
      el('h1', { tabindex: -1 }, t('Turn the board at hand into a common probe for embedded development.', '手元のボードを、組み込み開発の共通プローブに。')),
      p(t('This page makes a board an OEP probe, sets it up, keeps it, and hands it to the tools that do the work: the IDE, Python and WireSkein. Reading needs no device permission.', 'このページは、ボードをOEPのプローブにし、設定して保守し、作業をする道具（IDE、Python、WireSkein）へ渡します。読むだけなら機器の許可は要りません。')),
      actions(link(t('Make a board a probe →', 'ボードをプローブにする →'), '/make', true, { 'data-start': 'make' }), connected() ? link(t('To the probe →', 'プローブへ →'), '/probe', false, { 'data-start': 'probe' }) : link(t('Connect a probe', 'プローブにつなぐ'), '/connect', false, { 'data-start': 'connect' })))),
    known.length ? el('section', { class: 'section' }, el('h2', {}, t('Probes used in this browser', 'このブラウザで使ったプローブ')),
      el('div', { class: 'stack' }, ...known.map((k) => el('a', { class: 'setup-choice', href: '#/connect', 'data-known': k.unitId }, el('div', {}, el('h3', {}, k.unitId), p(k.model ?? '', 'muted mb0')), el('span', { class: 'arrow' }, '→')))),
      p(t('This list is kept in this browser only.', 'この一覧はこのブラウザだけにあります。'), 'muted compact')) : null,
    el('section', { class: 'section' }, el('h2', {}, t('What OEP is used for, and where', 'OEPでできることと、作業する場所')),
      p(t('This page prepares the probe for each use; the work itself is done in the tool on the right.', 'このページは用途ごとにプローブを準備し、作業そのものは右の道具で行います。'), 'muted'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'uses' }, el('thead', {}, el('tr', {}, el('th', {}, t('Use', '用途')), el('th', {}, t('Prepared on this page', 'このページで準備すること')), el('th', {}, t('Tool that does the work', '作業をする道具')))),
        el('tbody', {}, ...USES.map((u) => el('tr', { 'data-use': u.id }, el('td', {}, u.title), el('td', {}, u.prepare), el('td', {}, u.tool))))))),
    el('section', { class: 'section' }, el('h2', {}, t('Documents', '資料')),
      el('div', { class: 'link-list' }, ...DOCS.map(([tk, d, href]) => el('a', { href, target: '_blank', rel: 'noopener', class: 'link-row' }, el('div', {}, el('h3', {}, tk), p(d)), el('span', { class: 'arrow' }, '↗'))))));
}

function boardStatus(b) {
  const specs = b.ids.map((id) => SPECS.find((s) => s.id === id)).filter(Boolean);
  const released = specs.some((s) => s.tier === 'release');
  const verified = specs.map((s) => s.verified === true ? t('checked on hardware', '実機で確認') : s.verified === false ? t('not checked on hardware', '実機は未確認') : tr(s.verified));
  return [released ? t('Released firmware', '配布firmwareあり') : t('No released firmware (build it yourself)', '配布firmwareなし（自分でビルド）'), b.installable ? (b.custom ? t('Install here (bring an image)', 'このページで導入（イメージを持ち込む）') : t('Install here', 'このページで新規導入')) : t('Not installed from this page', 'このページでの新規導入は対象外'), t(`Checked: ${[...new Set(verified)].join(' / ')}`, `検証: ${[...new Set(verified)].join(' / ')}`)];
}
/** A board's card on the make screen: the whole card chooses the board and goes on to preparing it (page.ja.md §4). */
function boardCard(b) {
  const choose = () => { if (b.installable) { newInstall(b.id); go('/make/prepare'); } else { state.connectReturn = '/probe'; go('/connect'); } };
  return el('section', { class: `board-card pickable${b.recommended ? ' recommended' : ''}`, role: 'button', tabindex: 0, 'data-board': b.id,
    'aria-label': b.installable ? t(`Make a probe from ${b.name}`, `${b.name}をプローブにする`) : t(`${b.name}: connect an installed probe`, `${b.name}: 導入済みのプローブにつなぐ`),
    onclick: (/** @type {MouseEvent} */ e) => { if (!(/** @type {Element} */ (e.target)).closest('a')) choose(); },
    onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } } },
    el('div', { class: 'board-meta' }, el('span', { class: 'chip-mark' }, b.code), badge(b.tag, b.installable ? '' : 'amber')),
    el('h3', {}, b.name), p(b.title), p(b.description),
    el('ul', {}, ...b.features.map((f) => el('li', {}, f))),
    el('ul', { class: 'muted' }, ...boardStatus(b).map((tk) => el('li', {}, tk))), p(b.note, 'compact'),
    el('span', { class: 'card-go' }, b.installable ? t('Make a probe from this board →', 'このボードでプローブを作る →') : t('Installed already: connect →', '導入済み: つなぐ →')));
}

// -- probe creation (I01) --
function newInstall(boardId) {
  state.install = { board: boardId, target: null, custom: null, phase: 'idle', progress: { done: 0, total: 1, text: '' }, log: [], written: '', reason: '' };
}
function stepper(n) {
  return el('ol', { class: 'stepper', 'aria-label': t('Probe creation progress', 'プローブ作成の進行') }, ...[t('Choose a board', 'ボードを選ぶ'), t('Connect and review', '接続・内容確認'), t('Write and boot', '書き込み・起動'), t('Start using it', '使い始める')].map((tk, i) => el('li', { class: i === n ? 'current' : i < n ? 'done' : '', 'aria-current': i === n ? 'step' : 'false' }, el('span', {}, i < n ? '✓' : String(i + 1)), tk)));
}
function installFrame(n, content) {
  const b = BOARDS.find((x) => x.id === state.install?.board);
  return el('div', { class: 'page' }, stepper(n), n === 0 ? content : el('div', { class: 'install-layout' }, el('div', {}, content),
    el('aside', { class: 'install-aside' }, el('span', { class: 'chip-mark' }, b?.code ?? 'OEP'), el('h3', {}, b?.name ?? ''), p(t('The board becoming a probe', '今回プローブにするボード')),
      state.install?.target ? p(t(`Detected: ${state.install.target.chip}${state.install.target.revision != null ? ` v${state.install.target.revision}.x` : ''}`, `検出: ${state.install.target.chip}${state.install.target.revision != null ? ` v${state.install.target.revision}.x` : ''}`)) : null,
      p(t('No need to connect the target yet.', 'ターゲットはまだつながなくてかまいません。')))));
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
    if (!state.install || state.install.phase === 'done') newInstall('p4');
    return installFrame(0, [heading(t('Which board will be the probe?', 'どのボードをプローブにしますか。'), t('Click the board you have. To use an installed probe, connect it instead.', '手元のボードをクリックしてください。導入済みのプローブなら、つなぐだけで使えます。'), 'CREATE A PROBE'),
      note(t('If you are getting a board, the ESP32-P4 is recommended. It covers debug, UART pass-through, logic capture and more.', 'これから用意するならESP32-P4を推奨します。デバッグ・UARTの素通し・ロジック観測など、幅広い用途に使えます。')),
      el('div', { class: 'two-grid' }, ...BOARDS.map((b) => boardCard(b))),
      el('details', { class: 'panel mt' }, el('summary', {}, t('Features by board', 'ボードごとの機能')), p(t('What the released firmware offers. What a probe really offers is read from its declarations after connecting.', '配布ファームの機能です。実際に使える機能は、接続後にプローブの宣言で確かめます。'), 'muted'),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, t('Feature', '機能')), ...SPECS.map((x) => el('th', {}, tr(x.name))))),
          el('tbody', {}, ...FEATURES.flatMap((g) => g.items.map((/** @type {any} */ [key, label]) => el('tr', {}, el('td', {}, tr(label)), ...SPECS.map((x) => el('td', {}, x.features[key] === true ? t('yes', 'あり') : x.features[key] === false ? '—' : tr(x.features[key])))))))))), actions(link(t('Use an installed probe', '導入済みのプローブを使う'), '/connect'))]);
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
          tk && verdict?.ok && (!b.custom || ins.custom) ? link(t('Review →', '内容を確認する →'), '/make/review', true) : null)),
      actions(link(t('Back to choosing a board', 'ボード選択に戻る'), '/make'))]);
  }
  if (!ins.target && ['review', 'writing', 'continue'].includes(view)) return installFrame(1, [heading(t('Choose the device to write', '書き込み先を選択してください'), t('Prepare this board first.', '先に、このボードの準備を行います。')), link(t('To choosing the device', '機器の選択へ'), '/make/prepare', true)]);
  if (view === 'review') {
    const tk = ins.target, kind = tk.method === 'serial' ? 'merged' : 'uf2', entry = b.custom ? null : D.releaseEntry(tk.model, kind);
    return installFrame(1, [heading(t('Install OEP on this board.', 'このボードにOEPを導入します。'), t('Check the detected chip and what will be written, then run it.', '検出したチップと書き込む内容を確認してから実行します。'), 'CREATE A PROBE'),
      panel(el('h2', {}, t('What will be installed', '導入内容')), keyValues([[t('Detected device', '検出した機器'), `${tk.chip}${tk.revision != null ? ` v${tk.revision}.x` : ''}`], [t('Firmware', 'ファームウェア'), b.custom ? t(`Your image ${ins.custom?.name}`, `持ち込みイメージ ${ins.custom?.name}`) : t(`OepProbe ${D.release.manifest?.version ?? ''} (${entry?.file ?? '—'})`, `OepProbe ${D.release.manifest?.version ?? ''}（${entry?.file ?? '—'}）`)],
        [t('Written to', '書き込み先'), tk.method === 'serial' ? t('From the start of flash (only the image\'s range; no full erase)', 'flashの先頭から（イメージの範囲だけ。全消去はしません）') : t('To flash through the BOOTSEL boot ROM', 'BOOTSELのboot ROM経由でflashへ')], [t('Settings', '設定'), t('Settings outside the written range are not erased, but are not guaranteed to survive. For an update, back them up first in "Update and maintenance".', '書き込む範囲の外にある設定は消しませんが、残ることは保証しません。更新なら先に「保守」で設定をエクスポートします。')], [t('Next screen', '次の画面'), t('Check that it boots, then go on to the first setup', '起動を確認し、そのまま初期設定へ')]]),
        note(t('While writing, do not unplug the cable or close this tab.', '書き込み中はケーブルを抜かず、このタブを閉じないでください。')),
        actions(action(t('Install OEP on this board', 'このボードにOEPを導入'), startInstall, 'primary', { id: 'start-install' }), link(t('Back', '戻る'), '/make/prepare')))]);
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
      note(t('The write result is kept. No other board is opened automatically.', '書き込み結果は保持しています。別のボードを自動で開くことはありません。'))]);
  }
  return notFound();
}
async function startInstall() {
  const ins = state.install, b = BOARDS.find((x) => x.id === ins.board);
  ins.phase = 'writing'; ins.log = []; ins.reason = ''; ins.target.knownSerials = await D.knownSerials();
  go('/make/writing');
  const progress = (done, total, text) => {
    ins.progress = { done, total, text };
    const bar = /** @type {HTMLProgressElement} */ (document.getElementById('install-progress')); if (bar) { bar.max = total || 1; bar.value = done; }
    const s = document.getElementById('install-status'); if (s) s.textContent = text;
  };
  const log = (line) => { ins.log.push(String(line)); if (ins.log.length > 200) ins.log.shift(); const l = document.getElementById('install-log'); if (l) l.textContent = ins.log.join('\n'); };
  try {
    ins.written = String(await D.writeInstall(ins.target, { custom: b.custom ? ins.custom : null, onProgress: progress, log }));
  } catch (error) { ins.phase = 'idle'; go('/make/review'); throw new Error(t(`Could not write. The board may be unchanged or partly written. You can install again. (${D.errorText(error)})`, `書き込めませんでした。ボードの中身は変わっていないか、途中までの可能性があります。もう一度導入できます。（${D.errorText(error)}）`)); }
  ins.phase = 'connecting'; render();
  const r = await D.reconnectAfterInstall(ins.target);
  if (r.ok) finishInstall();
  else { ins.phase = 'continue'; ins.reason = r.reason; go('/make/continue'); }
}
function finishInstall() {
  const ins = state.install;
  ins.phase = 'done';
  state.notice = t(`OEP is installed (${ins.written}). Go on below, on the same connection.`, `OEPを導入できました（${ins.written}）。同じ接続のまま、下から続けられます。`);
  go('/probe');
}

// -- connecting (C01) --
let granted = null;
function connectScreen() {
  if (connected()) return el('div', { class: 'page' }, heading(t('A probe is connected.', 'プローブは接続済みです。'), D.unit()), actions(link(t('To the probe →', 'プローブへ →'), state.connectReturn || '/probe', true), action(t('Disconnect and use another device', '接続を終了して別の機器を使う'), D.disconnect)));
  if (granted === null && D.browser.usb) { granted = []; D.grantedUsbProbes().then((g) => { granted = g; render(); }).catch(() => {}); }
  const done = async (open, expected) => { await D.connectWith(open, expected); const next = state.connectReturn || '/probe'; state.connectReturn = '/probe'; granted = null; go(next); };
  const known = D.knownProbes(), usbKnown = (granted ?? []).map((d) => ({ d, k: known.find((k) => k.unitId.toLowerCase() === String(d.serialNumber).toLowerCase()) }));
  return el('div', { class: 'page' }, heading(t('Use your probe.', '手元のプローブを使う。'), t('Choose an installed device. Its board type and features are read after connecting.', '導入済みの機器を選びます。ボードの種類と使える機能は、接続してから確かめます。'), 'CONNECT YOUR PROBE'),
    usbKnown.length ? panel(el('h2', {}, t('Probes allowed in this browser', 'このブラウザで許可済みのプローブ')), el('div', { class: 'stack' }, ...usbKnown.map(({ d, k }) => el('div', { class: 'connection-card' },
      el('header', {}, el('div', {}, el('h3', {}, d.productName ?? 'OEP probe'), p(t(`Unit ID ${d.serialNumber ?? '—'}${k ? ` · ${k.model}` : ''}`, `個体ID ${d.serialNumber ?? '—'}${k ? ` · ${k.model}` : ''}`), 'muted mb0'))),
      actions(action(t('Connect to this unit', 'この個体に接続'), () => done(D.openUsb(d, d.serialNumber && !String(d.serialNumber).toLowerCase().startsWith('x-') ? d.serialNumber : undefined)), 'primary', { 'data-unit': d.serialNumber })))))) : null,
    el('section', { class: 'mt' }, el('h2', {}, t('Choose how the probe is plugged in', 'つなぎ方を選んで、ブラウザの一覧から選ぶ')),
      p(t('A probe can offer OEP on several USB paths; any one of them reaches the same unit. Use the one your board has.', 'プローブはOEPを複数のつなぎ方で出せます。どれを使っても同じ個体につながります。ボードが対応しているつなぎ方を選んでください。'), 'muted'),
      el('div', { class: 'three-grid' },
        panel(el('h3', {}, t('USB serial', 'USBシリアル')), p(t('A serial port: a USB-UART bridge or the chip\'s own USB serial (CDC). The classic ESP32, and the P4\'s port used for writing.', 'シリアルポート。USB-UART変換か、チップ自身のUSBシリアル（CDC）。classic ESP32と、P4の書き込みに使ったポート。'), 'muted'),
          action(t('Choose a serial port', 'シリアルポートを選ぶ'), () => done(D.openSerial()), 'primary', { id: 'connect-serial', disabled: !D.browser.serial })),
        panel(el('h3', {}, t('USB (OEP device)', 'USB（OEPの機器）')), p(t('The probe\'s own USB device (WebUSB, vendor bulk). The Pico, a P4\'s native USB, CH32 and others not in the serial list.', 'プローブ自身のUSB機器（WebUSB、vendor bulk）。Pico、P4のnative USB、CH32など、シリアルの一覧に出ないもの。'), 'muted'),
          action(t('Choose an OEP USB device', 'OEPのUSB機器を選ぶ'), () => done(D.openUsb()), '', { id: 'connect-usb', disabled: !D.browser.usb })),
        panel(el('h3', {}, t('USB HID', 'USB HID')), p(t('The same OEP USB device through the OS\'s HID driver (WebHID). For when the USB device above cannot be opened, as on Windows without a driver for it.', '同じOEPのUSB機器を、OSのHIDドライバ越しに使います（WebHID）。上のUSB機器を開けないとき（ドライバの無いWindowsなど）に。'), 'muted'),
          action(t('Choose an OEP HID device', 'OEPのHID機器を選ぶ'), () => done(D.openHid()), '', { id: 'connect-hid', disabled: !D.browser.hid })))),
    el('details', { class: 'panel mt' }, el('summary', {}, t('If the device is not in the list', '一覧に機器が見つからないとき')),
      p(t('Check that the cable carries data, that the device has booted, and that no other app holds the port. A probe without OEP yet needs it installed first.', 'データ通信できるケーブルか、機器が起動しているか、ほかのアプリがその機器を使っていないかを確かめます。まだOEPを入れていないボードは、先に導入します。'), 'mt'),
      actions(link(t('Make a board a probe', 'ボードをプローブにする'), '/make'))));
}
function notFound() { return el('div', { class: 'page' }, heading(t('This screen does not exist.', 'この画面は見つかりません。'), t('Start again from the start page.', 'スタートからやり直してください。')), link(t('To the start', 'スタートへ'), '/', true)); }

// -- router (page.ja.md §2) --
/** Addresses of earlier versions of this page, sent to the screen that does that now (page-acceptance.ja.md §4). */
const OLD = { '/home': '/', '/usecases': '/', '/boards': '/make', '/learn': '/', '/install/select': '/make', '/setup': '/probe', '/work': '/probe', '/connections': '/probe/wiring',
  '/connection/new': '/probe/wiring/new', '/passthrough': '/probe/settings', '/fixture': '/probe/settings', '/settings': '/probe/settings', '/maintenance': '/probe/maintenance', '/handoff': '/probe/tools',
  home: '/', help: '/', firmware: '/make', connect: '/connect', setup: '/probe', probe: '/probe', targets: '/probe/wiring', 'target/new': '/probe/wiring/new', debug: '/probe/wiring',
  settings: '/probe/settings', storage: '/probe/maintenance', diagnostics: '/probe/maintenance', tools: '/probe/tools', signals: '/probe/tools' };
function moved(hash) {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const path = raw.split('?')[0];
  if (!raw.startsWith('/')) {
    if (raw.startsWith('target/edit/')) return `/probe/wiring/${raw.slice(12)}`;
    if (raw.startsWith('signals/')) return '/probe/tools';
    return OLD[raw] ?? '/';
  }
  if (OLD[path]) return OLD[path];
  if (path.startsWith('/install/')) return `/make/${path.slice(9)}`;
  if (path.startsWith('/usecase/') || path.startsWith('/setup/')) return path.startsWith('/setup/') ? '/probe' : '/';
  if (path.startsWith('/connection/')) return `/probe/wiring/${path.slice(12)}`;
  return OLD[path] ?? null;
}
let currentRoute = '';
function screen(path, query) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return start();
  if (parts[0] === 'make') return install(parts[1] ?? 'select', query);
  if (parts[0] === 'connect') return connectScreen();
  if (parts[0] !== 'probe') return notFound();
  if (!connected()) return needConnection(path + (query.toString() ? `?${query}` : ''));
  const tab = parts[1] ?? '';
  const content = tab === '' ? overview() : tab === 'wiring' ? (parts[2] ? editor(decodeURIComponent(parts.slice(2).join('/')), query) : wiringList())
    : tab === 'settings' ? settings() : tab === 'tools' ? tools() : tab === 'maintenance' ? maintenance() : null;
  return content ? probeFrame(content) : notFound();
}
function draw(focus = true) {
  resetFieldIds();
  const old = moved(location.hash);
  if (old !== null) history.replaceState(null, '', `#${old}`);
  const route = routeNow(); currentRoute = route;
  const [path, params] = route.split('?'), query = new URLSearchParams(params);
  let content;
  try { content = screen(path, query); }
  catch (error) { console.error(error); content = el('div', { class: 'page' }, heading(t('This screen could not be shown.', 'この画面を表示できませんでした。'), D.errorText(error)), link(t('To the start', 'スタートへ'), '/', true)); }
  const app = document.getElementById('app');
  const keepScroll = !focus ? window.scrollY : 0;
  const active = /** @type {HTMLElement|null} */ (document.activeElement)?.id;
  app.replaceChildren(...shell(content).filter(Boolean));
  state.notice = focus ? '' : state.notice;
  document.title = `${document.querySelector('h1')?.textContent ?? 'OEP'} — OEP Probe Tool`;
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
  if (state.install?.phase === 'writing' && next !== '/make/writing') { history.replaceState(null, '', '#/make/writing'); return; }
  if (state.dirty && next !== currentRoute) { history.replaceState(null, '', `#${currentRoute}`); discardThen(() => { location.hash = next; }); return; }
  if (currentRoute.startsWith('/probe/wiring/') && !next.startsWith(currentRoute.split('?')[0])) state.draft = null;
  if (next.startsWith('/connect') && currentRoute !== next) granted = null;
  draw(true);
});
window.addEventListener('beforeunload', (e) => { if (state.dirty || state.install?.phase === 'writing') { e.preventDefault(); e.returnValue = ''; } });
draw(false);
D.loadRelease();
