// W04: each function as one piece of work (§7.1) — purpose, target and wiring, conditions, start, state and
// results, stop. Opening a screen or choosing saved wiring runs nothing (A17); a running operation stays in the
// status bar and can be stopped from any screen.
import { el, p, badge, actions, link, external, note, panel, heading, field, keyValues, terminal, textLink } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { SIGNALS, valuesFor } from './signals.js';
import { guide } from './data.js';
import { t, tr } from './i18n.js';
import { connected, needConnection, patternChoices, debugChoices, wireById, groupsOf, wiringSummary, taskById, TASK_TOOL, debugWireOf } from './common.js';

export function operations() {
  return [heading(t('Open the tool for your purpose.', '目的に合う道具を開く。'), t('Go from your purpose to the method, wiring and conditions it needs. Opening the screen starts nothing.', '用途から必要な方式と配線・条件へ進みます。画面を開いただけでは動作を開始しません。'), 'OPERATIONS'),
    patternChoices('operations'),
    connected() ? panel(el('h2', {}, t('Functions of this probe', 'このプローブで使える機能')), el('div', { class: 'choice-row' }, ...Object.entries(TASK_TOOL).map(([id, tool]) => {
      const tk = SIGNALS.find((s) => s.id === tool), has = D.offered(tk.name).length > 0;
      return has ? link(taskById(id)?.short ?? tr(tk.title), `/operate/${id}`) : el('span', { class: 'badge gray' }, t(`${taskById(id)?.short ?? tr(tk.title)} (not on this probe)`, `${taskById(id)?.short ?? tr(tk.title)}（このプローブは非対応）`));
    }), link(t('Debug', 'デバッグ'), '/operate/debug'), link(t('Debug-wire log', 'デバッグ線のログ'), '/operate/console'))) : null,
    actions(link(t('Prepare a fixed fixture', '据え置き治具を準備する'), '/fixture'), link(t('Hand over to external tools', '外部ツールへ引き継ぐ'), '/handoff'))];
}

export function operate(id, query) {
  if (id === 'analog') return capture(new URLSearchParams('mode=analog'));
  const tk = taskById(id);
  if (!tk && !['debug', 'console'].includes(id)) return [heading(t('This operation does not exist.', 'この操作は見つかりません。'), ''), link(t('To the operations', '操作の一覧へ'), '/operations', true)];
  if (!connected()) return [heading(tk?.title ?? t('Debug', 'デバッグ'), tk?.description ?? ''), note(t('After connecting a probe you come back here. Opening it runs nothing.', 'プローブに接続すると、この作業へ戻ります。開いただけでは何も動かしません。')), needConnection(`/operate/${id}${query?.toString() ? '?' + query : ''}`)];
  const o = state.operations[id] ??= { port: '', pins: {}, values: {}, log: '', results: {} };
  if (query?.get('port') && o.port !== query.get('port') && !D.dev.active.has(id)) { o.port = query.get('port'); o.pins = {}; }
  if (id === 'debug') return debugScreen(o);
  if (id === 'console') return consoleScreen(o);
  return functionScreen(id, tk, o);
}

// -- debug (A21: fixed wiring, no scan; the response shown, the record's part number never used as the ID) --
function debugInputs(o, consoleOnly = false) {
  const ports = D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && (!consoleOnly || g.wire !== 'swd')));
  const port = ports.find((x) => x.name === o.port);
  if (port) {
    const g = groupsOf(port).find((x) => x.type === 'debug');
    o.wire = g.wire || o.wire; o.pins = { dio: g.pins.swio ?? g.pins.swdio, clk: g.pins.swclk ?? '', nrst: g.pins.nrst ?? '' };
  }
  const offer = o.wire ? D.wireOffer(o.wire) : null;
  const choices = (role) => offer ? (D.roleChannels(offer).get(role) ?? []).map((ch) => [String(ch), D.pinName(ch)]) : D.channelList().map(([ch, n]) => [String(ch), n]);
  const running = !!D.dev.debug;
  return panel(el('h2', {}, t('01 / Target and wiring', '01 / 対象と配線')),
    field(t('Wiring to use', '使う配線'), o.port, (v) => { o.port = v; o.pins = {}; render(); }, t('Choosing wiring does not start a connection.', '配線を選んでも、接続は始まりません。'), [['', t('Choose pins here without saving', '保存せず、この場でピンを指定')], ...ports.map((x) => [x.name, t(`${x.name} — ${D.isConnector(x.name) ? 'connector' : D.recordOf(x.name).part || 'no part number'}`, `${x.name} — ${D.isConnector(x.name) ? 'コネクタ' : D.recordOf(x.name).part || '型番未記入'}`)])], 'text', { disabled: running, id: 'op-port' }),
    port ? [wiringSummary(port), textLink(t('Edit this wiring', 'この配線を編集'), `/connection/${encodeURIComponent(port.name)}?from=operate-debug`)] : null,
    !port || !o.wire ? el('div', {}, p(t('Method', '方式'), 'mb0'), debugChoices((w) => { o.wire = w; o.pins = {}; render(); }, o.wire, consoleOnly)) : null,
    !port && offer ? el('div', { class: 'wire-pins' }, field(o.wire === 'swio' ? 'SWIO' : 'SWDIO', o.pins.dio ?? '', (v) => { o.pins.dio = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...choices(1)], 'text', { id: 'op-dio', disabled: running }),
      o.wire !== 'swio' ? field('SWCLK', o.pins.clk ?? '', (v) => { o.pins.clk = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...choices(2)], 'text', { id: 'op-clk', disabled: running }) : null,
      field(t('NRST (optional)', 'NRST（任意）'), o.pins.nrst ?? '', (v) => { o.pins.nrst = v; }, t('Used only to connect under reset.', 'リセットしながら接続するときだけ使います。'), [['', t('Not connected', '接続しない')], ...D.channelList().map(([ch, n]) => [String(ch), n])], 'text', { id: 'op-nrst', disabled: running })) : null);
}
function debugScreen(o) {
  const inputs = debugInputs(o);
  const d = D.dev.debug, wire = wireById(o.wire);
  const pins = () => ({ ...o.pins, maxSpeed: o.values.speed || null, halt: o.values.attach === 'halt', reset: o.values.attach === 'reset' });
  const canStart = !!o.wire && !!o.pins.dio && (o.wire === 'swio' || !!o.pins.clk);
  const resetMissing = o.values.attach === 'reset' && !o.pins.nrst;
  const res = (k) => o.results[k] ? terminal(o.results[k]) : null;
  const put = (k, v) => { o.results[k] = typeof v === 'string' ? v : JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Array.from(x, (b) => b.toString(16).padStart(2, '0')).join(' ') : x, 2); };
  const hex = (v) => Number(/^0x/i.test(String(v).trim()) ? parseInt(String(v), 16) : Number(v));
  return [heading(t('Debug the target', 'ターゲットをデバッグ'), t('Connect on fixed wiring, see what answers, then halt, resume or look at memory.', '固定の配線で接続し、応答した相手を確かめ、停止・再開やメモリを調べます。'), `OPERATE / ${wire?.short ?? 'DEBUG'}`),
    wire ? panel(badge(wire.short), p(wire.note)) : null,
    el('div', { class: 'operation-grid' }, el('div', {}, inputs,
      panel(el('h2', {}, t('02 / Connection conditions for now', '02 / 今回の接続条件')), p(t('Not saved in the probe.', '本体には保存しません。'), 'compact muted'),
        field(t('Speed limit (Hz; empty lets the probe decide)', '速度の上限（Hz、空欄はプローブが決める）'), o.values.speed ?? '', (v) => { o.values.speed = v; }, '', null, 'text', { id: 'op-speed', disabled: !!d }),
        field(t('On connecting', '接続時の動作'), o.values.attach ?? 'running', (v) => { o.values.attach = v; render(); }, '', [['running', t('Connect while running', '動かしたまま接続')], ['halt', t('Halt and connect', '停止して接続')], ['reset', t('Connect under reset (needs NRST)', 'リセットしながら接続（NRSTが必要）')]], 'text', { id: 'op-attach', disabled: !!d }),
        resetMissing ? note(t('Set the NRST wiring before connecting.', 'NRSTの配線を指定してから接続してください。'), 'amber') : null,
        actions(!d ? action(t('Connect to the target', 'ターゲットに接続'), async () => { const id = await D.attachDebug(o.wire, pins()); o.results.connect = t(`Answered: ${id}`, `応答: ${id}`); }, 'primary', { id: 'start-operation', disabled: !canStart || resetMissing })
          : action(t('Detach the target', 'ターゲットを切り離す'), async () => { await D.detachDebug(); o.results.connect = t('Detached. If the target was halted, it does not necessarily resume.', '切り離しました。相手が止まっていた場合、再開するとは限りません。'); }, '', { id: 'stop-operation' })))),
      panel(el('h2', {}, t('03 / State and results', '03 / 状態と結果')), badge(d ? t(`Connected · ${d.id}`, `接続中 · ${d.id}`) : t('Not connected', '未接続'), d ? '' : 'gray'), el('div', { class: 'mt' }, res('connect') ?? el('div', { class: 'result-placeholder' }, t('Not connected yet. Check the wiring and conditions, then connect.', 'まだ接続していません。左の配線と条件を確認してから接続します。'))),
        d && D.debugTargetOffered() ? [
          el('h3', { class: 'mt' }, t('Run control', '実行の制御')), actions(...[['halt', t('Halt', '停止')], ['resume', t('Resume', '再開')], ['reset', t('Reset', 'リセット')], ...(!d.arm ? [['step', t('Step one instruction', '1命令進める')]] : [])].map(([m, label]) => action(label, async () => put('control', await D.debugControl(m))))), res('control'),
          el('h3', { class: 'mt' }, t('Memory', 'メモリ')), p(t('Addresses and values in decimal or hex with 0x. Writes reach the target at once.', 'アドレスと値は10進数か0x付きの16進数。書き込みはすぐ相手に反映します。'), 'compact muted'),
          el('div', { class: 'field-grid' }, field(t('Address', 'アドレス'), o.values.addr ?? '0x20000000', (v) => { o.values.addr = v; }), field(t('32-bit words to read', '読む32bit word数'), o.values.words ?? '8', (v) => { o.values.words = v; }), field(t('32-bit value to write', '書く32bit値'), o.values.value ?? '0', (v) => { o.values.value = v; })),
          actions(action(t('Read memory', 'メモリを読む'), async () => put('memory', await D.debugRead(hex(o.values.addr ?? '0x20000000'), hex(o.values.words ?? '8')))), action(t('Write one word', '1 wordを書く'), async () => { if (!confirm(t('Writing the target\'s memory.', 'ターゲットのメモリを書き換えます。'))) return false; await D.debugWrite(hex(o.values.addr ?? '0x20000000'), hex(o.values.value ?? '0')); put('memory', t('Written.', '書き込みました。')); }, 'danger')), res('memory'),
          el('h3', { class: 'mt' }, t('Registers', 'レジスタ')), p(d.arm ? t('r0-r15 = 0-15, xPSR = 16.', 'r0〜r15 = 0〜15、xPSR = 16。') : t('Abstract register numbers: x0 = 0x1000, dpc = 0x7b1. Halt first.', 'abstract register番号: x0 = 0x1000、dpc = 0x7b1。先に停止します。'), 'compact muted'),
          field(t('Register number', 'レジスタ番号'), o.values.reg ?? (d.arm ? '15' : '0x7b1'), (v) => { o.values.reg = v; }), actions(action(t('Read the register', 'レジスタを読む'), async () => { const v = await D.debugRegister(hex(o.values.reg ?? (d.arm ? '15' : '0x7b1'))); put('register', `0x${(Number(v) >>> 0).toString(16)}`); })), res('register')]
          : d ? note(t('The wire is connected, but this probe has no target functions for the next steps (halt, memory).', '線は接続しましたが、このプローブには続きの操作（停止・メモリ）に対応するターゲット機能がありません。'), 'amber') : null)),
    panel(el('h2', {}, t('Use this target from development tools', 'このターゲットを開発ツールで使う')), p(o.wire === 'swd' ? t('An RP2040 can be written and debugged from the Arduino IDE through the OEP broker.', 'RP2040はArduino IDEから、OEPのブローカー経由で書き込み・デバッグできます。') : t('A CH32 can be written and debugged on the OEP port from the ArduinoCore-CH32RV board definitions.', 'CH32はArduinoCore-CH32RVのボード定義から、OEPのポートで書き込み・デバッグできます。')), link(t('Hand-over to external tools', '外部ツールへの引継ぎ'), '/handoff'), ' ', external(t('Supported targets and cautions', '対応ターゲットと注意点'), guide('debug-targets'))),
    note(t('Even after detaching, the debug wire may keep some state. The pins return to the probe\'s idle setting.', '切り離しても、デバッグ線には保持状態があり得ます。ピンは本体の待機設定（idle）に戻ります。'))];
}
function consoleScreen(o) {
  const inputs = debugInputs(o, true);
  const c = D.dev.console, d = D.dev.debug;
  const mechanisms = d?.mechanisms?.length ? d.mechanisms : ['sdi', 'dmdata', 'dmseq'];
  o.values.mechanism ??= 'dmseq';
  return [heading(t('Read logs over the debug wire', 'デバッグ線でログを読む'), t('Read the target\'s log through the WCH debug module, without UART. The target needs a matching output too.', 'UARTを使わず、WCHのdebug module経由で相手が出すログを読みます。相手側にも対応する出力実装が必要です。'), 'OPERATE / CONSOLE'),
    !D.offered('oep.target.console').length ? note(t('This probe does not declare the target console function.', 'このプローブは、ターゲットのコンソール機能を宣言していません。'), 'amber') : null,
    el('div', { class: 'operation-grid' }, el('div', {}, inputs,
      panel(el('h2', {}, t('02 / Target\'s log output method', '02 / 相手のログ出力方式')), field(t('Method', '方式'), o.values.mechanism, (v) => { o.values.mechanism = v; }, t('sdi is target → PC only. dmdata and dmseq can also send.', 'sdiは相手→PCのみ。dmdata・dmseqは送信もできます。'), mechanisms.map((m) => [m, m]), 'text', { id: 'op-mechanism', disabled: !!c }),
        actions(!c ? action(t('Start receiving the log', 'ログの受信を開始'), async () => { if (!D.dev.debug) await D.attachDebug(o.wire, { ...o.pins }); await D.openConsole(o.values.mechanism); o.log = ''; poll('console', async () => D.consoleRead()); }, 'primary', { id: 'start-operation', disabled: !o.wire || !o.pins.dio || (o.wire === 'rvswd' && !o.pins.clk) || !D.offered('oep.target.console').length })
          : action(t('Stop receiving the log', 'ログの受信を停止'), async () => { await D.closeConsole(); await D.detachDebug(); }, '', { id: 'stop-operation' })))),
      panel(el('h2', {}, t('03 / Received log', '03 / 受信したログ')), badge(c ? t(`Receiving · ${c.mechanism}`, `受信中 · ${c.mechanism}`) : t('Not started', '未開始'), c ? '' : 'gray'), el('pre', { class: 'terminal mt', id: 'log-console', role: 'log' }, o.log || t('Nothing received yet.', 'まだ受信していません。')),
        c && c.mechanism !== 'sdi' ? [field(t('Text to send', '送る文字列'), o.values.text ?? '', (v) => { o.values.text = v; }), action(t('Send', '送信する'), async () => D.consoleWrite((o.values.text ?? '') + '\n'))] : null))];
}

// -- fixture functions --
const pollers = new Map();
/** Read while the operation runs and this screen shows its log; stops by itself when the operation ends. */
function poll(id, read) {
  clearInterval(pollers.get(id));
  pollers.set(id, setInterval(async () => {
    const o = state.operations[id];
    if (!D.dev.active.has(id) || !o) { clearInterval(pollers.get(id)); pollers.delete(id); return; }
    if (state.busy) return;
    try {
      const data = await read();
      if (data?.length) {
        o.log += new TextDecoder().decode(data).replace(/\r?\n/g, `\n[${new Date().toLocaleTimeString()}] `);
        if (o.log.length > 20000) o.log = o.log.slice(-20000);
        const l = document.getElementById(`log-${id}`); if (l) { l.textContent = o.log; l.scrollTop = l.scrollHeight; }
      }
    } catch (error) { o.log += t(`\n[receive error: ${D.errorText(error)}]`, `\n[受信エラー: ${D.errorText(error)}]`); clearInterval(pollers.get(id)); pollers.delete(id); }
  }, 500));
}
function functionScreen(id, tk, o) {
  const tool = SIGNALS.find((s) => s.id === TASK_TOOL[id]);
  const offers = D.offered(tool.name);
  const top = heading(tk.title, tk.description, `OPERATE / ${tk.short}`);
  if (!offers.length) return [top, note(t(`This probe does not declare "${tr(tool.title)}" (${tool.name}). Use another probe, or firmware that offers it.`, `このプローブは「${tr(tool.title)}」（${tool.name}）を宣言していません。別のプローブか、対応するファームウェアで使えます。`), 'amber'), link(t('To the operations', '操作の一覧へ'), '/operations')];
  o.fn ??= offers[0].entry.fn;
  const offer = offers.find((x) => x.entry.fn === +o.fn) ?? offers[0];
  const roles = [...D.roleChannels(offer)];
  const running = D.dev.active.has(id);
  const ports = D.dev.ports.filter((port) => roles.some(([r]) => D.portLines(port).has(D.roleLine(tool.name, r))));
  const port = ports.find((x) => x.name === o.port);
  if (port) { const lines = D.portLines(port); o.pins = Object.fromEntries(roles.map(([r]) => [r, lines.has(D.roleLine(tool.name, r)) ? String(lines.get(D.roleLine(tool.name, r))) : ''])); }
  const configure = tool.operations.find((x) => x.id === 'configure');
  const others = tool.operations.filter((x) => x.id !== 'configure' && D.supports(offer, tool.Class[x.method]));
  const fieldsOf = (op, prefix) => op.fields.map((f) => {
    const key = `${prefix}.${f.key}`, val = o.values[key] ?? f.value;
    if (id === 'gpio' && f.key === 'channel') return field(tr(f.label), o.values[key] ?? o.pins[1] ?? '', (v) => { o.values[key] = v; }, '', roles.flatMap(([, chs]) => chs).map((ch) => [String(ch), D.pinName(ch)]), 'text', { 'data-op-field': key });
    return f.options ? field(tr(f.label), val, (v) => { o.values[key] = v; }, '', f.options.map(([v, tx]) => [v, tr(tx)]), 'text', { 'data-op-field': key })
      : field(tr(f.label), val, (v) => { o.values[key] = v; }, '', null, f.kind === 'hex' || f.key === 'text' ? 'textarea' : 'text', { 'data-op-field': key });
  });
  const valuesOf = (op, prefix) => valuesFor(op.fields, Object.fromEntries(op.fields.map((f) => [f.key, o.values[`${prefix}.${f.key}`] ?? (id === 'gpio' && f.key === 'channel' ? o.pins[1] ?? '' : f.value)])));
  const show = (k, v) => { o.results[k] = typeof v === 'string' ? v : JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? { hex: Array.from(x, (b) => b.toString(16).padStart(2, '0')).join(' '), text: new TextDecoder().decode(x) } : x, 2); };
  const start = async () => {
    /** @type {[number, number][]} */
    const bindings = roles.filter(([r]) => o.pins[r] !== '' && o.pins[r] !== undefined).map(([r]) => [r, Number(o.pins[r])]);
    if (!bindings.length) throw new Error(t('Choose at least one pin.', '少なくとも1本のピンを選んでください。'));
    await D.startFunction(id, tool, offer, bindings, tk.short);
    if (configure && D.supports(offer, tool.Class[configure.method])) { const c = await D.functionClient(tool, offer); show('configure', (await configure.run(c, valuesOf(configure, 'configure'))) ?? t('Conditions applied.', '条件を適用しました。')); }
    else show('configure', t(`Pins assigned: ${bindings.map(([r, ch]) => `${D.roleName(offer, r)} → ${D.pinName(ch)}`).join(', ')}`, `ピンを割り当てました: ${bindings.map(([r, ch]) => `${D.roleName(offer, r)} → ${D.pinName(ch)}`).join('、')}`));
    if (id === 'uart' && others.some((x) => x.id === 'read')) { o.log = ''; poll(id, async () => (await D.functionClient(tool, offer)).readAll(65536)); }
  };
  const txMissing = id === 'uart' && !o.pins[2];
  return [top,
    offers.length > 1 ? field(t('Instance to use', '使う系統'), String(o.fn), (v) => { o.fn = v; o.pins = {}; render(); }, '', offers.map((x) => [String(x.entry.fn), t(`${tr(tool.title)} · instance ${x.entry.instance}`, `${tr(tool.title)} · 系統 ${x.entry.instance}`)]), 'text', { disabled: running }) : null,
    el('div', { class: 'operation-grid' }, el('div', {},
      panel(el('h2', {}, t('01 / Target and wiring', '01 / 対象と配線')),
        field(t('Wiring to use', '使う配線'), o.port, (v) => { o.port = v; o.pins = {}; render(); }, t('Choosing wiring starts nothing.', '配線を選んでも、動作は始まりません。'), [['', t('Choose pins here without saving', '保存せず、この場でピンを指定')], ...ports.map((x) => [x.name, t(`${x.name} — ${D.recordOf(x.name).part || 'no part number'}`, `${x.name} — ${D.recordOf(x.name).part || '型番未記入'}`)])], 'text', { id: 'op-port', disabled: running }),
        port ? [wiringSummary(port), textLink(t('Edit this wiring', 'この配線を編集'), `/connection/${encodeURIComponent(port.name)}?from=operate-${id}`)] : el('div', { class: 'wire-pins' }, ...roles.map(([r, chs]) => field(
          id === 'uart' ? (r === 1 ? t('RX (probe RX ← target TX)', 'RX（プローブRX ← 相手TX）') : t('TX (probe TX → target RX)', 'TX（プローブTX → 相手RX）')) : D.roleName(offer, r), o.pins[r] ?? '', (v) => { o.pins[r] = v; if (id === 'uart') render(); },
          id === 'uart' && r === 2 ? t('Not needed to receive only.', '受信だけなら接続不要です。') : '', [['', id === 'uart' && r === 2 ? t('Not connected (receive only)', '接続しない（受信のみ）') : t('Not assigned', '割り当てない')], ...chs.map((ch) => [String(ch), `${D.pinName(ch)}${D.dev.labels.find(([c]) => c === ch) ? ' · ' + D.dev.labels.find(([c]) => c === ch)[1] : ''}`])], 'text', { 'data-role': r, disabled: running }))),
        id.endsWith('target') ? p(t('Your board drives the clock and requests; the probe answers.', '開発中の基板がクロック・要求を出し、プローブが応答します。'), 'compact muted') : id === 'i2c' || id === 'spi' ? p(t('The probe drives the clock and requests. I2C needs pull-ups.', 'プローブがクロックと要求を出します。I2Cはpull-upが必要です。'), 'compact muted') : null),
      panel(el('h2', {}, t('02 / Conditions for now', '02 / 今回の条件')), p(t('Not saved in the probe. Passed when starting.', '本体には保存しません。開始時に渡す条件です。'), 'compact muted'),
        configure ? el('div', {}, ...fieldsOf(configure, 'configure')) : p(t('This function has no start conditions. Values are given per operation.', 'この機能は開始時の条件を持ちません。操作ごとに値を指定します。'), 'muted'),
        actions(!running ? action(id === 'uart' ? t('Start receiving', '受信を開始') : id.endsWith('target') ? t('Start listening', '待ち受けを開始') : t('Assign pins and start', 'ピンを割り当てて開始'), start, 'primary', { id: 'start-operation' })
          : action(id === 'uart' ? t('Stop receiving', '受信を停止') : t('Stop and release the pins', '停止してピンを解放'), async () => { await D.stopActive(id); show('configure', t('Ended. The pins return to the probe\'s idle setting (Hi-Z if none).', '終了しました。ピンは本体の待機設定（idle、無ければHi-Z）に戻ります。')); }, '', { id: 'stop-operation' })))),
      panel(el('h2', {}, t('03 / State and results', '03 / 状態と結果')), badge(running ? t('In use', '使用中') : t('Not started', '未開始'), running ? '' : 'gray'),
        o.results.configure ? terminal(o.results.configure) : el('div', { class: 'result-placeholder' }, t('Not started yet. Check the wiring and conditions, then start.', 'まだ開始していません。左の配線と条件を確認してから開始します。')),
        id === 'uart' ? el('pre', { class: 'terminal mt', id: 'log-uart', role: 'log' }, o.log || t('Received log lines appear here with timestamps.', '受信したログをここに時刻付きで表示します。')) : null,
        running ? el('div', { class: 'op-grid' }, ...others.filter((op) => !(id === 'uart' && op.id === 'read') && !(txMissing && ['send', 'hex'].includes(op.id))).map((op) => el('div', { class: 'panel' }, el('h3', {}, tr(op.label)), ...fieldsOf(op, op.id),
          actions(action(tr(op.label), async () => {
            const c = await D.functionClient(tool, offer);
            const r = await op.run(c, valuesOf(op, op.id));
            show(op.id, r ?? 'OK');
            if (r?.ok === false) throw new Error([t('I2C transfer failed', 'I2C転送に失敗'), t('NACK on the address', 'アドレスにNACK'), t('NACK on data', 'データにNACK'), t('Bus error', 'バスエラー'), t('Clock stretch timeout', 'clock stretchの時間切れ')][r.result] ?? t(`I2C result ${r.result}`, `I2C結果 ${r.result}`));
          }, '', { 'data-op': op.id })), o.results[op.id] ? terminal(o.results[op.id]) : null))) : null)),
    note(t('After stopping, pins whose idle setting is an output take that state. Not every pin is necessarily Hi-Z.', '停止しても、本体の待機設定が出力ならその状態になります。「全ピンがHi-Z」とは限りません。'))];
}

// -- capture preparation (A26, A34, A35): conditions for WireSkein; this page does not acquire --
export function capture(query) {
  const mode = query.get('mode') ?? 'standalone';
  if (!connected()) return needConnection(`/capture?mode=${mode}`);
  if (['during', 'test'].includes(mode)) return [heading(mode === 'during' ? t('Operate and capture together.', '操作と波形取得を一緒に行う。') : t('Check waveforms in automated tests.', '波形を自動テストで照合する。'), t('Build the operation and the capture in the same external code. Starting them separately in the browser does not count as synchronised.', '操作と取得を外部の同じ処理で組み立てます。ブラウザで別々に開始して同期したことにはしません。'), 'CAPTURE'),
    panel(el('h2', {}, t('What to prepare, and the steps', '用意するものと手順')), el('ol', {}, ...[t('Register wiring names if needed, and use the same names for operating and observing', '必要なら配線名を登録し、操作と観測で同じ名前を使う'), t('Prepare the capture conditions and operation steps in WireSkein / Python', 'WireSkein / Pythonで取得条件と操作の手順を用意する'), mode === 'during' ? t('Arm the capture, operate, and keep the waveform file', '取得を待機させて操作し、波形ファイルを残す') : t('Describe the expected waveform, record, compare and keep the verdict', '期待する波形を記述し、記録・照合して合否を残す')].map((x) => el('li', {}, x))),
      actions(link(t('Check registered wiring', '登録済みの配線を確認'), '/connections'), link(t('Hand over to the external setup', '外部環境へ引き継ぐ'), '/handoff')), external(t('Detailed steps', '具体的な手順'), guide('capture')))];
  const name = mode === 'analog' ? 'oep.fixture.analog' : 'oep.fixture.logic';
  const offers = D.offered(name);
  const allowed = [...new Set(offers.flatMap((o) => [...D.roleChannels(o).values()].flat()))];
  const c = state.capture ??= { mode, port: query.get('port') ?? '', channels: [{ name: 'signal1', pin: '' }], values: {}, reviewed: false };
  if (c.mode !== mode) { c.mode = mode; c.reviewed = false; }
  if (query.get('port')) c.port = query.get('port');
  const port = D.portOf(c.port);
  const channels = mode === 'named' ? (port ? [...D.portLines(port)].map(([line, ch]) => ({ name: `${port.name}.${line}`, pin: String(ch) })) : []) : c.channels;
  const rate = c.values.rate ?? '1000000', samples = c.values.samples ?? '100000';
  const cmd = t(`wireskein capture --source oep:oep://${D.unit()} --channels ${channels.filter((x) => x.pin !== '').map((x) => `${x.name}=${D.pinName(x.pin)}`).join(',') || '<signal>=<pin>'} --rate ${rate} --samples ${samples}${c.values.trigger ? ` --trigger ${c.values.trigger}` : ''} -o capture.wireskein`, `wireskein capture --source oep:oep://${D.unit()} --channels ${channels.filter((x) => x.pin !== '').map((x) => `${x.name}=${D.pinName(x.pin)}`).join(',') || '<信号>=<ピン>'} --rate ${rate} --samples ${samples}${c.values.trigger ? ` --trigger ${c.values.trigger}` : ''} -o capture.wireskein`);
  state.captureSummary = c.reviewed ? [[t('Probe', 'プローブ'), `${D.dev.info.model} / ${D.unit()}`], [t('Signals', '信号'), channels.map((x) => `${x.name} → ${D.pinName(x.pin)}`).join(', ')], [t('Rate (wanted)', '速さ（希望）'), `${rate} Hz`], [t('Samples', 'サンプル数'), samples], [t('Trigger', 'トリガ'), c.values.trigger || t('none', '指定なし')], [t('Example command', 'コマンド例'), cmd]] : null;
  const changed = () => { c.reviewed = false; };
  return [heading(mode === 'analog' ? t('Prepare an analog capture.', 'アナログ取得の準備。') : t('Decide the signals and capture conditions.', '観測する信号と取得条件を決める。'), mode === 'named' ? t('Observe by existing wiring names. Logic capture can also observe pins in use by debug, UART and so on, without changing who owns them.', '既存の配線名で観測します。ロジックは使用中のデバッグ・UART等のピンも観測でき、配線の持ち主を変えません。') : t('Capture conditions for now only. No probe settings or wiring names are needed.', '今回だけの取得条件です。本体設定や配線名の登録は不要です。'), 'CAPTURE'),
    !offers.length ? note(t(`This probe does not declare ${mode === 'analog' ? 'analog' : 'logic'} capture. You can sort out the conditions, but capturing needs a probe that offers it.`, `このプローブは${mode === 'analog' ? 'アナログ' : 'ロジック'}の取得機能を宣言していません。条件の整理はできますが、取得には対応するプローブが要ります。`), 'amber') : null,
    panel(el('h2', {}, t('01 / Signals to observe', '01 / 観測する信号')), mode === 'named' ? [field(t('Wiring to use', '使う配線'), c.port, (v) => { c.port = v; changed(); render(); }, '', [['', t('Choose wiring', '配線を選ぶ')], ...D.dev.ports.map((x) => [x.name, x.name])]),
      port ? wiringSummary(port) : link(t('Register wiring for reuse', '繰り返し使う配線を登録'), '/connection/new?purpose=custom&from=capture')]
      : [...c.channels.map((ch, i) => el('div', { class: 'field-grid mb' }, field(t(`Signal ${i + 1} name`, `信号${i + 1}の表示名`), ch.name, (v) => { ch.name = v; changed(); }, t('The name in the capture file. The probe\'s labels do not change.', '取得ファイル内の名前。本体のラベルは変えません。')),
        field(t(`Signal ${i + 1} pin`, `信号${i + 1}のピン`), ch.pin, (v) => { ch.pin = v; changed(); render(); }, mode === 'analog' ? t('Only ADC-capable pins are listed.', 'ADCに対応するピンだけを出しています。') : '', [['', t('Choose a pin', 'ピンを選ぶ')], ...(allowed.length ? allowed.map((x) => [String(x), D.pinName(x)]) : D.channelList().map(([x, n]) => [String(x), n]))], 'text', { id: `capture-pin-${i}` }))),
        actions(button(t('Add a signal', '観測する信号を追加'), () => { c.channels.push({ name: `signal${c.channels.length + 1}`, pin: '' }); changed(); render(); }), c.channels.length > 1 ? button(t('Remove the last signal', '末尾の信号を外す'), () => { c.channels.pop(); changed(); render(); }) : null)],
      note(mode === 'analog' ? t('Analog capture takes the pin to itself. To also see the signal with logic capture, wire it to another pin.', 'アナログ取得はピンを専有します。同じ信号をロジックでも見るなら別のピンへ配線します。') : t('Logic capture only listens and drives no pin. Check GND and the signal voltage.', 'ロジック取得は聞くだけで、ピンを駆動しません。GNDと信号電圧を確認します。'))),
    panel(el('h2', {}, t('02 / Capture conditions for WireSkein', '02 / WireSkeinで指定する取得条件')),
      field(t('Sample rate (Hz)', 'サンプルレート（Hz）'), rate, (v) => { c.values.rate = v; changed(); }, t('The rate you want. The actual rate depends on the channel count, method and path, and is confirmed in the capture setup.', '希望する速さです。実際の速さは本数・取り方・経路で変わり、取得環境で確かめます。')),
      field(t('Samples', 'サンプル数'), samples, (v) => { c.values.samples = v; changed(); }),
      field(t('Trigger (optional, for example signal1:rising)', 'トリガ（任意、例: signal1:rising）'), c.values.trigger ?? '', (v) => { c.values.trigger = v; changed(); }),
      p(t('Nothing is captured here, and nothing is saved in the probe.', 'ここでは取得を実行せず、プローブへ保存もしません。'), 'muted'),
      button(t('Review the hand-over', '引継ぎ内容を確認'), () => { c.reviewed = true; render(); }, 'primary', { disabled: !channels.some((x) => x.pin !== ''), id: 'review-capture' })),
    c.reviewed ? panel(el('h2', {}, t('What goes to the external setup', '外部環境に渡す内容')), keyValues(state.captureSummary.slice(0, -1)), el('code', {}, cmd), actions(link(t('Review the hand-over to WireSkein →', 'WireSkeinへの引継ぎを確認 →'), '/handoff', true))) : null,
    actions(link(t('Back to choosing a capture', '取得の使い分けに戻る'), '/setup/logic')), external(t('Capture methods and speed limits', 'キャプチャの使い分け・速度の条件'), guide('capture'))];
}

// -- passthrough (W05, initial scope): the probe's own setting, works only while no OEP session holds the probe --
export function passthrough() {
  if (!connected()) return needConnection('/passthrough');
  const uartCats = D.categoriesWith('passthrough.{}.rx'), consoleCats = D.categoriesWith('passthrough.{}.wire');
  const routes = D.routes();
  const s = state.passthrough ??= { source: uartCats.length ? 'uart' : 'console', category: '', route: routes[0] ?? '', rx: '', baud: '115200', format: '8n1', wire: 'rvswd', dio: '', clk: '', mechanism: 'dmseq', port: '' };
  const cats = s.source === 'uart' ? uartCats : consoleCats;
  if (!cats.includes(s.category)) s.category = cats[0] ?? '';
  const current = (flat) => D.currentValue(s.category, flat.replace('{}', s.route));
  const existing = routes.flatMap((r) => [...uartCats, ...consoleCats].flatMap((cat) => {
    const rx = D.currentValue(cat, `passthrough.${r}.rx`), wire = D.currentValue(cat, `passthrough.${r}.wire`);
    return rx !== undefined ? [[r, cat, `UART RX ${rx} · ${D.currentValue(cat, `passthrough.${r}.baud`) ?? 115200} baud · ${D.currentValue(cat, `passthrough.${r}.format`) ?? '8n1'}`]] : wire !== undefined ? [[r, cat, `${wire} · ${D.currentValue(cat, `passthrough.${r}.mechanism`) ?? ''}`]] : [];
  }));
  const debugPorts = D.dev.ports.filter((port) => groupsOf(port).some((g) => g.type === 'debug' && g.wire !== 'swd'));
  const uartPorts = D.dev.ports.filter((port) => D.portLines(port).has('rx'));
  const apply = async () => {
    if (!s.route) throw new Error(t('Choose the output port.', '出力先のポートを選んでください。'));
    if (s.source === 'uart') {
      if (s.rx === '') throw new Error(t('Choose the receiving pin (the target\'s TX).', '受けるピン（相手のTX）を選んでください。'));
      await D.applySettings(s.category, { [`passthrough.${s.route}.rx`]: D.pinName(s.rx), [`passthrough.${s.route}.baud`]: s.baud, [`passthrough.${s.route}.format`]: s.format });
    } else {
      if (s.dio === '' || (s.wire === 'rvswd' && s.clk === '')) throw new Error(t('Choose the debug-wire pins.', 'デバッグ線のピンを選んでください。'));
      await D.applySettings(s.category, { [`passthrough.${s.route}.wire`]: `oep.wire.${s.wire}`, [`passthrough.${s.route}.swdio`]: D.pinName(s.dio), ...(s.wire === 'rvswd' ? { [`passthrough.${s.route}.swclk`]: D.pinName(s.clk) } : {}), [`passthrough.${s.route}.mechanism`]: s.mechanism });
    }
    s.applied = true;
  };
  const fromPort = (name) => {
    const port = D.portOf(name); s.port = name; if (!port) return;
    const lines = D.portLines(port);
    if (s.source === 'uart') s.rx = lines.has('rx') ? String(lines.get('rx')) : '';
    else { const g = groupsOf(port).find((x) => x.type === 'debug'); s.wire = g?.wire || debugWireOf(port) || 'rvswd'; s.dio = String(lines.get('swio') ?? lines.get('swdio') ?? ''); s.clk = String(lines.get('swclk') ?? ''); }
  };
  return [heading(t('Send the log to an ordinary serial monitor.', '普通のシリアルモニタへログを流す。'), t('A probe pass-through setting that works only while no OEP session is open. It only receives, target → PC, and sends nothing to the target.', 'OEPのセッションがない間だけ働く、本体の素通し設定です。相手 → PCの受信だけで、相手へは送りません。'), 'SETTINGS / PASSTHROUGH'),
    !uartCats.length && !consoleCats.length ? note(t('This probe has no pass-through setting.', 'このプローブは素通しの設定を持っていません。'), 'amber') : null,
    existing.length ? panel(el('h2', {}, t('Current pass-through', '今の素通し')), keyValues(existing.map(([r, , txt]) => [r, txt])),
      actions(...existing.map(([r, cat]) => action(t(`Remove the pass-through on ${r}`, `${r}の素通しを外す`), () => D.applySettings(cat, {}, ['rx', 'baud', 'format', 'wire', 'swdio', 'swclk', 'mechanism', 'max-speed'].map((k) => `passthrough.${r}.${k}`).filter((f) => D.currentValue(cat, f) !== undefined)))))) : null,
    panel(el('h2', {}, t('01 / Where the target logs', '01 / 相手がログを出す経路')), field(t('Log source', 'ログの入力元'), s.source, (v) => { s.source = v; s.port = ''; render(); }, '', [...(uartCats.length ? [['uart', 'UART']] : []), ...(consoleCats.length ? [['console', t('Debug wire (WCH)', 'デバッグ線（WCH）')]] : [])], 'text', { id: 'pt-source' }),
      cats.length > 1 ? field(t('Instance to use', '使う系統'), s.category, (v) => { s.category = v; }, '', cats.map((x) => [x, x])) : null,
      (s.source === 'uart' ? uartPorts : debugPorts).length ? field(t('From registered wiring', '登録済みの配線から'), s.port, (v) => { fromPort(v); render(); }, '', [['', t('Choose pins directly', 'ピンを直接選ぶ')], ...(s.source === 'uart' ? uartPorts : debugPorts).map((x) => [x.name, x.name])]) : null,
      s.source === 'uart' ? [field(t('Receiving pin (from the target\'s TX)', '受けるピン（相手のTXから）'), s.rx, (v) => { s.rx = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])], 'text', { id: 'pt-rx' }), field(t('Speed (baud)', '速さ（baud）'), s.baud, (v) => { s.baud = v; }, '', null, 'text', { id: 'pt-baud' }), field(t('Format', '形式'), s.format, (v) => { s.format = v; }, t('8n1, 7e2 and so on', '8n1、7e2 など'), null, 'text', { id: 'pt-format' })]
        : [field(t('Debug wire', 'デバッグ線'), s.wire, (v) => { s.wire = v; render(); }, '', [['rvswd', t('RVSWD (2 wires)', 'RVSWD（2線）')], ['swio', t('1-wire DIO (SWIO)', '1線DIO（SWIO）')]]), field(s.wire === 'rvswd' ? 'SWDIO' : 'SWIO', s.dio, (v) => { s.dio = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])]),
          s.wire === 'rvswd' ? field('SWCLK', s.clk, (v) => { s.clk = v; }, '', [['', t('Choose a pin', 'ピンを選ぶ')], ...D.channelList().map(([ch, n]) => [String(ch), n])]) : null,
          field(t('Target\'s log output method', '相手のログ出力方式'), s.mechanism, (v) => { s.mechanism = v; }, '', [['sdi', 'sdi'], ['dmdata', 'dmdata'], ['dmseq', 'dmseq']]), p(t('This does not halt the target, though RVSWD may reset it on connecting.', '相手を止める設定ではありません。ただしRVSWDでは接続時に相手がリセットされる場合があります。'), 'muted')]),
    panel(el('h2', {}, t('02 / Probe port to output the log', '02 / ログを出すプローブのポート')), field(t('Output serial port', '出力先のシリアルポート'), s.route, (v) => { s.route = v; }, t('One pass-through per port. This does not change how you connect.', '1つのポートに置ける素通しは1つです。接続方式を選び直す操作ではありません。'), routes.map((r) => [r, r]), 'text', { id: 'pt-route' }),
      note(t('It pauses while an OEP tool is using the probe and resumes when the session ends. This page\'s connection is closed at the end too.', 'OEPの道具が使っている間は止まり、セッションが終わると再開します。このページの接続も、最後に終了します。')),
      el('p', { id: 'passthrough-status', role: 'status' }, D.dev.unsaved ? t('Applied, not saved (lost on restart)', '適用済み・未保存（再起動すると消えます）') : s.applied ? t('Saved', '保存済み') : t('Not applied', '未適用')),
      actions(action(t('Apply the pass-through', '素通し設定を適用'), apply, 'primary', { id: 'apply-passthrough', disabled: !s.category }), action(t('Save all current values in the probe', '本体の現在値全体を保存'), D.saveSettings, '', { id: 'save-passthrough', disabled: !D.dev.unsaved || !D.dev.saveable })),
      D.dev.saveable ? null : note(t('This probe cannot store settings. They are lost on restart.', 'このプローブは永続保存できません。再起動すると設定は消えます。'), 'amber'),
      s.applied ? actions(link(t('Disconnect and go to the serial monitor', '接続を終了してシリアルモニタへ'), '/handoff')) : null),
    external(t('Pass-through settings and limits', '素通し設定と制約'), guide('settings')), actions(link(t('To the fixed-fixture steps', '据え置き治具の手順へ'), '/fixture'), link(t('Choose another log method', 'ログの方法を選び直す'), '/setup/logs'))];
}
