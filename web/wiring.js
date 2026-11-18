// The probe's wiring (page.ja.md §6.3) and its editor (§6.4). Saving writes labels and records only; it never attaches,
// assigns pins or drives outputs. The connection check attaches only when asked, and detaches at once.
import { el, p, badge, actions, link, external, note, panel, heading, field, checkbox, keyValues, textLink } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { t, tr } from './i18n.js';
import { debugChoices, wireById, groupsOf, wiringSummary, GROUP_TITLE } from './common.js';

function frame(content) { return el('div', {}, ...content); }

// -- P2: the wiring list --
function emptyConnections() {
  return el('div', { class: 'empty' }, el('h3', {}, t('No wiring is registered yet.', 'まだ配線を登録していません。')), p(t('You can save the target\'s part number and which signal goes to which pin. No target needs to be connected.', '相手の型番や、どの信号をどのピンにつなぐかを保存できます。ターゲットは未接続でかまいません。'), 'muted'),
    actions(link(t('Register wiring →', '配線を登録する →'), '/probe/wiring/new', true, { 'data-new-wiring': '' })));
}
function portCard(port) {
  const rec = D.recordOf(port.name), groups = groupsOf(port), connector = D.isConnector(port.name);
  return el('article', { class: 'connection-card', 'data-port': port.name },
    el('header', {}, el('div', {}, el('h2', {}, port.name), p(connector ? t('Connector (the target is identified each time)', 'コネクタ（相手はつなぐたびに識別）') : rec.part || t('Target part number not given', '相手の型番は未記入'), 'muted mb0')),
      badge(D.dev.memo ? t('saved in the probe', 'プローブに保存') : t('part number and memo in this browser only', '型番・メモはこのブラウザだけ'), D.dev.memo ? '' : 'amber')),
    wiringSummary(port), rec.note ? p(rec.note, 'compact muted') : null, el('code', {}, `oep://${D.unit()}/${port.name}`),
    actions(link(t('Edit wiring and target', '配線・相手の情報を編集'), `/probe/wiring/${encodeURIComponent(port.name)}`, true),
      action(t('Delete…', '削除…'), async () => { if (!confirm(t(`Delete the connection name, wiring (pin names), part number and memo of ${port.name}.`, `${port.name}の接続名・配線（ピン名）・型番・メモを削除します。`))) return false; await D.deleteConnection(port); state.notice = t(`${port.name} was deleted.`, `${port.name}を削除しました。`); }, 'danger', { disabled: !D.dev.changeable })));
}
export function wiringList() {
  return frame([heading(t('Wiring', '配線'), t('Name the wiring from the probe\'s pins to a target, and keep the target\'s part number and a memo. No target needs to be connected; saving starts nothing.', 'プローブのピンから相手への配線に名前を付け、相手の型番とメモを残します。相手が未接続でも登録でき、保存しても何も動きません。'), 'WIRING'),
    state.notice ? note(state.notice) : null, !D.dev.changeable ? note(t('This probe\'s settings cannot be changed, so wiring cannot be registered (read only).', 'このプローブは設定を変更できないため、配線を登録できません（読み取りのみ）。'), 'amber') : null,
    D.dev.ports.length ? [actions(link(t('Register new wiring', '新しい配線を登録'), '/probe/wiring/new', true), action(t('Read again', '読み直す'), D.refresh)), el('div', { class: 'stack mt' }, ...D.dev.ports.map(portCard))] : emptyConnections()]);
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
  const purpose = query.get('purpose');
  if (id === 'new' && !purpose && !state.draft) return frame([heading(t('What is the wiring for?', 'どの用途の配線を登録しますか。'), t('Start from the kind of signal. You can add other signals to the same target later. No target needs to be connected.', '信号の種類から始めます。あとで別の信号も同じ接続先に追加できます。ターゲットは未接続でかまいません。')),
    el('div', { class: 'two-grid' }, ...[['debug', t('Debug (SWD / RVSWD / 1-wire DIO)', 'デバッグ（SWD / RVSWD / 1線DIO）'), t('The target\'s debug pins. Swapping targets on a fixed connector also starts here.', '相手のデバッグ端子。決まったコネクタで相手を差し替える使い方もここから。')], ['uart', 'UART', t('Lines to read the target\'s log and send commands.', '相手のログを読む・コマンドを送る線。')], ['i2c', 'I2C', t('Lines to sensors and peripherals, or for answering as a stand-in.', 'センサや周辺IC、または代役で応答する線。')], ['spi', 'SPI', t('Lines to SPI devices, or for answering as a stand-in.', 'SPIの機器、または代役で応答する線。')], ['custom', t('Other signals', 'そのほかの信号'), t('GPIO control lines, signals to observe and so on. You name them.', 'GPIOの制御線、観測したい信号など。名前を自分で付けます。')]].map(([tk, title, d]) =>
      el('a', { class: 'pattern-card', href: `#/probe/wiring/new?purpose=${tk}`, 'data-new-purpose': tk }, el('strong', {}, title), el('span', {}, d)))),
    actions(link(t('Back to the wiring list', '配線の一覧に戻る'), '/probe/wiring'))]);
  if (!state.draft || state.draft.editId !== id) {
    const port = id === 'new' ? null : D.portOf(id);
    if (id !== 'new' && !port) return frame([heading(t('This wiring was not found.', 'この配線は見つかりません。'), t('It may have been renamed or deleted.', '名前の変更か削除が行われた可能性があります。')), link(t('To the wiring list', '配線の一覧へ'), '/probe/wiring', true)]);
    state.returnTo = '/probe/wiring';
    state.draft = port ? draftFrom(port) : { editId: 'new', name: '', part: '', note: '', connector: false, purpose, groups: [newGroup(purpose === 'debug' ? 'debug' : purpose, '')], original: null, check: {} };
    state.dirty = false;
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
]);
}
function groupEditor(g, index, d, touch) {
  const pinField = (line, label, optional) => {
    const choices = candidatesFor(g, line).map(([ch, name]) => [String(ch), `${name}${labelOf(ch, d) ? ` · ${labelOf(ch, d)}` : ''}`]);
    return field(label, g.pins[line] ?? '', (v) => { g.pins[line] = v; touch(); if (g.type === 'debug') render(); }, '', [['', optional ? t('Not connected', '接続しない') : t('Choose a pin', 'ピンを選ぶ')], ...choices], 'text', { 'data-line': `${index}-${line}` });
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
    p(t('Share GND with the target. Speed, address and the like are set in the tool that does the work, not saved with the wiring.', 'GNDは相手と共通にします。速度・アドレスなどは作業をする道具で指定し、配線には保存しません。'), 'compact muted mt'),
    g.type === 'debug' && g.wire ? debugCheck(g, index, d) : null);
}
function labelOf(ch, d) {
  const l = D.dev.labels.find(([c]) => c === ch)?.[1];
  if (!l) return '';
  return d.original && d.original.lines.some(([c]) => c === ch) ? '' : t(`In use: ${l}`, `使用中: ${l}`);
}
function debugCheck(g, index, d) {
  const r = d.check[index];
  const pins = () => ({ dio: g.wire === 'swio' ? g.pins.swio : g.pins.swdio, clk: g.pins.swclk });
  const ready = g.wire === 'swio' ? !!g.pins.swio : !!g.pins.swdio && !!g.pins.swclk;
  return panel(el('h3', {}, t('Connection check (optional)', '接続確認（任意）')), p(d.connector ? t('Identifies and shows what is connected. What is identified is not saved with the wiring.', 'つないだ相手を識別して表示します。識別した相手は配線の記録に保存しません。') : t('With the target connected you can check its answer on this wiring. Without it, skip the check and save.', 'ターゲットがつながっていれば、指定した配線で応答を確認できます。未接続なら、この確認を飛ばして保存できます。')),
    action(t('Check the connection on these pins', '指定したピンで接続確認'), async () => { const out = await D.checkDebug(g.wire, pins()); d.check[index] = out; }, '', { disabled: !ready, 'data-check': index }),
    el('p', { class: 'mt', role: 'status', id: `debug-check-${index}` }, r ? (r.ok ? t(`Answered: ${r.id}. The check connection is closed. The wiring is not saved yet.`, `応答あり: ${r.id}。確認用の接続は終了しています。配線はまだ保存していません。`) : t(`No answer (${r.reason}). Check the wiring, power and method. You can also save it as it is.`, `応答なし（${r.reason}）。配線・電源・方式を見直せます。このまま保存することもできます。`)) : t('Not checked. You can save without the connection check.', '未確認。接続確認を省略して保存できます。')));
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
  go(state.returnTo);
}
export { checkbox };
