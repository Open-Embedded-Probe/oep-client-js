// W04: each function as one piece of work (§7.1) — purpose, target and wiring, conditions, start, state and
// results, stop. Opening a screen or choosing saved wiring runs nothing (A17); a running operation stays in the
// status bar and can be stopped from any screen.
import { el, p, badge, actions, link, external, note, panel, heading, field, keyValues, terminal, textLink } from './ui.js';
import { state, render, go, action, button } from './core.js';
import * as D from './device.js';
import { SIGNALS, valuesFor } from './signals.js';
import { GUIDE_BASE } from './data.js';
import { connected, needConnection, patternChoices, debugChoices, wireById, groupsOf, wiringSummary, taskById, TASK_TOOL, debugWireOf } from './common.js';

export function operations() {
  return [heading('目的に合う道具を開く。', '用途から必要な方式と配線・条件へ進みます。画面を開いただけでは動作を開始しません。', 'OPERATIONS'),
    patternChoices('operations'),
    connected() ? panel(el('h2', {}, 'このプローブで使える機能'), el('div', { class: 'choice-row' }, ...Object.entries(TASK_TOOL).map(([id, tool]) => {
      const t = SIGNALS.find((s) => s.id === tool), has = D.offered(t.name).length > 0;
      return has ? link(taskById(id)?.short ?? t.title.ja, `/operate/${id}`) : el('span', { class: 'badge gray' }, `${taskById(id)?.short ?? t.title.ja}（このプローブは非対応）`);
    }), link('デバッグ', '/operate/debug'), link('デバッグ線のログ', '/operate/console'))) : null,
    actions(link('据え置き治具を準備する', '/fixture'), link('外部ツールへ引き継ぐ', '/handoff'))];
}

export function operate(id, query) {
  if (id === 'analog') return capture(new URLSearchParams('mode=analog'));
  const t = taskById(id);
  if (!t && !['debug', 'console'].includes(id)) return [heading('この操作は見つかりません。', ''), link('操作の一覧へ', '/operations', true)];
  if (!connected()) return [heading(t?.title ?? 'デバッグ', t?.description ?? ''), note('プローブに接続すると、この作業へ戻ります。開いただけでは何も動かしません。'), needConnection(`/operate/${id}${query?.toString() ? '?' + query : ''}`)];
  const o = state.operations[id] ??= { port: '', pins: {}, values: {}, log: '', results: {} };
  if (query?.get('port') && o.port !== query.get('port') && !D.dev.active.has(id)) { o.port = query.get('port'); o.pins = {}; }
  if (id === 'debug') return debugScreen(o);
  if (id === 'console') return consoleScreen(o);
  return functionScreen(id, t, o);
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
  return panel(el('h2', {}, '01 / 対象と配線'),
    field('使う配線', o.port, (v) => { o.port = v; o.pins = {}; render(); }, '配線を選んでも、接続は始まりません。', [['', '保存せず、この場でピンを指定'], ...ports.map((x) => [x.name, `${x.name} — ${D.isConnector(x.name) ? 'コネクタ' : D.recordOf(x.name).part || '型番未記入'}`])], 'text', { disabled: running, id: 'op-port' }),
    port ? [wiringSummary(port), textLink('この配線を編集', `/connection/${encodeURIComponent(port.name)}?from=operate-debug`)] : null,
    !port || !o.wire ? el('div', {}, p('方式', 'mb0'), debugChoices((w) => { o.wire = w; o.pins = {}; render(); }, o.wire, consoleOnly)) : null,
    !port && offer ? el('div', { class: 'wire-pins' }, field(o.wire === 'swio' ? 'SWIO' : 'SWDIO', o.pins.dio ?? '', (v) => { o.pins.dio = v; }, '', [['', 'ピンを選ぶ'], ...choices(1)], 'text', { id: 'op-dio', disabled: running }),
      o.wire !== 'swio' ? field('SWCLK', o.pins.clk ?? '', (v) => { o.pins.clk = v; }, '', [['', 'ピンを選ぶ'], ...choices(2)], 'text', { id: 'op-clk', disabled: running }) : null,
      field('NRST（任意）', o.pins.nrst ?? '', (v) => { o.pins.nrst = v; }, 'リセットしながら接続するときだけ使います。', [['', '接続しない'], ...D.channelList().map(([ch, n]) => [String(ch), n])], 'text', { id: 'op-nrst', disabled: running })) : null);
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
  return [heading('ターゲットをデバッグ', '固定の配線で接続し、応答した相手を確かめ、停止・再開やメモリを調べます。', `OPERATE / ${wire?.short ?? 'DEBUG'}`),
    wire ? panel(badge(wire.short), p(wire.note)) : null,
    el('div', { class: 'operation-grid' }, el('div', {}, inputs,
      panel(el('h2', {}, '02 / 今回の接続条件'), p('本体には保存しません。', 'compact muted'),
        field('速度の上限（Hz、空欄はプローブが決める）', o.values.speed ?? '', (v) => { o.values.speed = v; }, '', null, 'text', { id: 'op-speed', disabled: !!d }),
        field('接続時の動作', o.values.attach ?? 'running', (v) => { o.values.attach = v; render(); }, '', [['running', '動かしたまま接続'], ['halt', '停止して接続'], ['reset', 'リセットしながら接続（NRSTが必要）']], 'text', { id: 'op-attach', disabled: !!d }),
        resetMissing ? note('NRSTの配線を指定してから接続してください。', 'amber') : null,
        actions(!d ? action('ターゲットに接続', async () => { o.results.connect = `応答: ${await D.attachDebug(o.wire, pins())}`; }, 'primary', { id: 'start-operation', disabled: !canStart || resetMissing })
          : action('ターゲットを切り離す', async () => { await D.detachDebug(); o.results.connect = '切り離しました。相手が止まっていた場合、再開するとは限りません。'; }, '', { id: 'stop-operation' })))),
      panel(el('h2', {}, '03 / 状態と結果'), badge(d ? `接続中 · ${d.id}` : '未接続', d ? '' : 'gray'), el('div', { class: 'mt' }, res('connect') ?? el('div', { class: 'result-placeholder' }, 'まだ接続していません。左の配線と条件を確認してから接続します。')),
        d && D.debugTargetOffered() ? [
          el('h3', { class: 'mt' }, '実行の制御'), actions(...[['halt', '停止'], ['resume', '再開'], ['reset', 'リセット'], ...(!d.arm ? [['step', '1命令進める']] : [])].map(([m, label]) => action(label, async () => put('control', await D.debugControl(m))))), res('control'),
          el('h3', { class: 'mt' }, 'メモリ'), p('アドレスと値は10進数か0x付きの16進数。書き込みはすぐ相手に反映します。', 'compact muted'),
          el('div', { class: 'field-grid' }, field('アドレス', o.values.addr ?? '0x20000000', (v) => { o.values.addr = v; }), field('読む32bit word数', o.values.words ?? '8', (v) => { o.values.words = v; }), field('書く32bit値', o.values.value ?? '0', (v) => { o.values.value = v; })),
          actions(action('メモリを読む', async () => put('memory', await D.debugRead(hex(o.values.addr ?? '0x20000000'), hex(o.values.words ?? '8')))), action('1 wordを書く', async () => { if (!confirm('ターゲットのメモリを書き換えます。')) return false; await D.debugWrite(hex(o.values.addr ?? '0x20000000'), hex(o.values.value ?? '0')); put('memory', '書き込みました。'); }, 'danger')), res('memory'),
          el('h3', { class: 'mt' }, 'レジスタ'), p(d.arm ? 'r0〜r15 = 0〜15、xPSR = 16。' : 'abstract register番号: x0 = 0x1000、dpc = 0x7b1。先に停止します。', 'compact muted'),
          field('レジスタ番号', o.values.reg ?? (d.arm ? '15' : '0x7b1'), (v) => { o.values.reg = v; }), actions(action('レジスタを読む', async () => { const v = await D.debugRegister(hex(o.values.reg ?? (d.arm ? '15' : '0x7b1'))); put('register', `0x${(Number(v) >>> 0).toString(16)}`); })), res('register')]
          : d ? note('線は接続しましたが、このプローブには続きの操作（停止・メモリ）に対応するターゲット機能がありません。', 'amber') : null)),
    panel(el('h2', {}, 'このターゲットを開発ツールで使う'), p(o.wire === 'swd' ? 'RP2040はArduino IDEから、OEPのブローカー経由で書き込み・デバッグできます。' : 'CH32はArduinoCore-CH32RVのボード定義から、OEPのポートで書き込み・デバッグできます。'), link('外部ツールへの引継ぎ', '/handoff'), ' ', external('対応ターゲットと注意点', GUIDE_BASE + 'debug-targets.ja.md')),
    note('切り離しても、デバッグ線には保持状態があり得ます。ピンは本体の待機設定（idle）に戻ります。')];
}
function consoleScreen(o) {
  const inputs = debugInputs(o, true);
  const c = D.dev.console, d = D.dev.debug;
  const mechanisms = d?.mechanisms?.length ? d.mechanisms : ['sdi', 'dmdata', 'dmseq'];
  o.values.mechanism ??= 'dmseq';
  return [heading('デバッグ線でログを読む', 'UARTを使わず、WCHのdebug module経由で相手が出すログを読みます。相手側にも対応する出力実装が必要です。', 'OPERATE / CONSOLE'),
    !D.offered('oep.target.console').length ? note('このプローブは、ターゲットのコンソール機能を宣言していません。', 'amber') : null,
    el('div', { class: 'operation-grid' }, el('div', {}, inputs,
      panel(el('h2', {}, '02 / 相手のログ出力方式'), field('方式', o.values.mechanism, (v) => { o.values.mechanism = v; }, 'sdiは相手→PCのみ。dmdata・dmseqは送信もできます。', mechanisms.map((m) => [m, m]), 'text', { id: 'op-mechanism', disabled: !!c }),
        actions(!c ? action('ログの受信を開始', async () => { if (!D.dev.debug) await D.attachDebug(o.wire, { ...o.pins }); await D.openConsole(o.values.mechanism); o.log = ''; poll('console', async () => D.consoleRead()); }, 'primary', { id: 'start-operation', disabled: !o.wire || !o.pins.dio || (o.wire === 'rvswd' && !o.pins.clk) || !D.offered('oep.target.console').length })
          : action('ログの受信を停止', async () => { await D.closeConsole(); await D.detachDebug(); }, '', { id: 'stop-operation' })))),
      panel(el('h2', {}, '03 / 受信したログ'), badge(c ? `受信中 · ${c.mechanism}` : '未開始', c ? '' : 'gray'), el('pre', { class: 'terminal mt', id: 'log-console', role: 'log' }, o.log || 'まだ受信していません。'),
        c && c.mechanism !== 'sdi' ? [field('送る文字列', o.values.text ?? '', (v) => { o.values.text = v; }), action('送信する', async () => D.consoleWrite((o.values.text ?? '') + '\n'))] : null))];
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
    } catch (error) { o.log += `\n[受信エラー: ${D.errorText(error)}]`; clearInterval(pollers.get(id)); pollers.delete(id); }
  }, 500));
}
function functionScreen(id, t, o) {
  const tool = SIGNALS.find((s) => s.id === TASK_TOOL[id]);
  const offers = D.offered(tool.name);
  const top = heading(t.title, t.description, `OPERATE / ${t.short}`);
  if (!offers.length) return [top, note(`このプローブは「${tool.title.ja}」（${tool.name}）を宣言していません。別のプローブか、対応するファームウェアで使えます。`, 'amber'), link('操作の一覧へ', '/operations')];
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
    if (id === 'gpio' && f.key === 'channel') return field(f.label.ja, o.values[key] ?? o.pins[1] ?? '', (v) => { o.values[key] = v; }, '', roles.flatMap(([, chs]) => chs).map((ch) => [String(ch), D.pinName(ch)]), 'text', { 'data-op-field': key });
    return f.options ? field(f.label.ja, val, (v) => { o.values[key] = v; }, '', f.options.map(([v, tx]) => [v, tx.ja]), 'text', { 'data-op-field': key })
      : field(f.label.ja, val, (v) => { o.values[key] = v; }, '', null, f.kind === 'hex' || f.key === 'text' ? 'textarea' : 'text', { 'data-op-field': key });
  });
  const valuesOf = (op, prefix) => valuesFor(op.fields, Object.fromEntries(op.fields.map((f) => [f.key, o.values[`${prefix}.${f.key}`] ?? (id === 'gpio' && f.key === 'channel' ? o.pins[1] ?? '' : f.value)])));
  const show = (k, v) => { o.results[k] = typeof v === 'string' ? v : JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? { hex: Array.from(x, (b) => b.toString(16).padStart(2, '0')).join(' '), text: new TextDecoder().decode(x) } : x, 2); };
  const start = async () => {
    /** @type {[number, number][]} */
    const bindings = roles.filter(([r]) => o.pins[r] !== '' && o.pins[r] !== undefined).map(([r]) => [r, Number(o.pins[r])]);
    if (!bindings.length) throw new Error('少なくとも1本のピンを選んでください。');
    await D.startFunction(id, tool, offer, bindings, t.short);
    if (configure && D.supports(offer, tool.Class[configure.method])) { const c = await D.functionClient(tool, offer); show('configure', (await configure.run(c, valuesOf(configure, 'configure'))) ?? '条件を適用しました。'); }
    else show('configure', `ピンを割り当てました: ${bindings.map(([r, ch]) => `${D.roleName(offer, r)} → ${D.pinName(ch)}`).join('、')}`);
    if (id === 'uart' && others.some((x) => x.id === 'read')) { o.log = ''; poll(id, async () => (await D.functionClient(tool, offer)).readAll(65536)); }
  };
  const txMissing = id === 'uart' && !o.pins[2];
  return [top,
    offers.length > 1 ? field('使う系統', String(o.fn), (v) => { o.fn = v; o.pins = {}; render(); }, '', offers.map((x) => [String(x.entry.fn), `${tool.title.ja} · 系統 ${x.entry.instance}`]), 'text', { disabled: running }) : null,
    el('div', { class: 'operation-grid' }, el('div', {},
      panel(el('h2', {}, '01 / 対象と配線'),
        field('使う配線', o.port, (v) => { o.port = v; o.pins = {}; render(); }, '配線を選んでも、動作は始まりません。', [['', '保存せず、この場でピンを指定'], ...ports.map((x) => [x.name, `${x.name} — ${D.recordOf(x.name).part || '型番未記入'}`])], 'text', { id: 'op-port', disabled: running }),
        port ? [wiringSummary(port), textLink('この配線を編集', `/connection/${encodeURIComponent(port.name)}?from=operate-${id}`)] : el('div', { class: 'wire-pins' }, ...roles.map(([r, chs]) => field(
          id === 'uart' ? (r === 1 ? 'RX（プローブRX ← 相手TX）' : 'TX（プローブTX → 相手RX）') : D.roleName(offer, r), o.pins[r] ?? '', (v) => { o.pins[r] = v; if (id === 'uart') render(); },
          id === 'uart' && r === 2 ? '受信だけなら接続不要です。' : '', [['', id === 'uart' && r === 2 ? '接続しない（受信のみ）' : '割り当てない'], ...chs.map((ch) => [String(ch), `${D.pinName(ch)}${D.dev.labels.find(([c]) => c === ch) ? ' · ' + D.dev.labels.find(([c]) => c === ch)[1] : ''}`])], 'text', { 'data-role': r, disabled: running }))),
        id.endsWith('target') ? p('開発中の基板がクロック・要求を出し、プローブが応答します。', 'compact muted') : id === 'i2c' || id === 'spi' ? p('プローブがクロックと要求を出します。I2Cはpull-upが必要です。', 'compact muted') : null),
      panel(el('h2', {}, '02 / 今回の条件'), p('本体には保存しません。開始時に渡す条件です。', 'compact muted'),
        configure ? el('div', {}, ...fieldsOf(configure, 'configure')) : p('この機能は開始時の条件を持ちません。操作ごとに値を指定します。', 'muted'),
        actions(!running ? action(id === 'uart' ? '受信を開始' : id.endsWith('target') ? '待ち受けを開始' : 'ピンを割り当てて開始', start, 'primary', { id: 'start-operation' })
          : action(id === 'uart' ? '受信を停止' : '停止してピンを解放', async () => { await D.stopActive(id); show('configure', '終了しました。ピンは本体の待機設定（idle、無ければHi-Z）に戻ります。'); }, '', { id: 'stop-operation' })))),
      panel(el('h2', {}, '03 / 状態と結果'), badge(running ? '使用中' : '未開始', running ? '' : 'gray'),
        o.results.configure ? terminal(o.results.configure) : el('div', { class: 'result-placeholder' }, 'まだ開始していません。左の配線と条件を確認してから開始します。'),
        id === 'uart' ? el('pre', { class: 'terminal mt', id: 'log-uart', role: 'log' }, o.log || '受信したログをここに時刻付きで表示します。') : null,
        running ? el('div', { class: 'op-grid' }, ...others.filter((op) => !(id === 'uart' && op.id === 'read') && !(txMissing && ['send', 'hex'].includes(op.id))).map((op) => el('div', { class: 'panel' }, el('h3', {}, op.label.ja), ...fieldsOf(op, op.id),
          actions(action(op.label.ja, async () => {
            const c = await D.functionClient(tool, offer);
            const r = await op.run(c, valuesOf(op, op.id));
            show(op.id, r ?? 'OK');
            if (r?.ok === false) throw new Error(['I2C転送に失敗', 'アドレスにNACK', 'データにNACK', 'バスエラー', 'clock stretchの時間切れ'][r.result] ?? `I2C結果 ${r.result}`);
          }, '', { 'data-op': op.id })), o.results[op.id] ? terminal(o.results[op.id]) : null))) : null)),
    note('停止しても、本体の待機設定が出力ならその状態になります。「全ピンがHi-Z」とは限りません。')];
}

// -- capture preparation (A26, A34, A35): conditions for WireSkein; this page does not acquire --
export function capture(query) {
  const mode = query.get('mode') ?? 'standalone';
  if (!connected()) return needConnection(`/capture?mode=${mode}`);
  if (['during', 'test'].includes(mode)) return [heading(mode === 'during' ? '操作と波形取得を一緒に行う。' : '波形を自動テストで照合する。', '操作と取得を外部の同じ処理で組み立てます。ブラウザで別々に開始して同期したことにはしません。', 'CAPTURE'),
    panel(el('h2', {}, '用意するものと手順'), el('ol', {}, ...['必要なら配線名を登録し、操作と観測で同じ名前を使う', 'WireSkein / Pythonで取得条件と操作の手順を用意する', mode === 'during' ? '取得を待機させて操作し、波形ファイルを残す' : '期待する波形を記述し、記録・照合して合否を残す'].map((x) => el('li', {}, x))),
      actions(link('登録済みの配線を確認', '/connections'), link('外部環境へ引き継ぐ', '/handoff')), external('具体的な手順', GUIDE_BASE + 'capture.ja.md'))];
  const name = mode === 'analog' ? 'oep.fixture.analog' : 'oep.fixture.logic';
  const offers = D.offered(name);
  const allowed = [...new Set(offers.flatMap((o) => [...D.roleChannels(o).values()].flat()))];
  const c = state.capture ??= { mode, port: query.get('port') ?? '', channels: [{ name: 'signal1', pin: '' }], values: {}, reviewed: false };
  if (c.mode !== mode) { c.mode = mode; c.reviewed = false; }
  if (query.get('port')) c.port = query.get('port');
  const port = D.portOf(c.port);
  const channels = mode === 'named' ? (port ? [...D.portLines(port)].map(([line, ch]) => ({ name: `${port.name}.${line}`, pin: String(ch) })) : []) : c.channels;
  const rate = c.values.rate ?? '1000000', samples = c.values.samples ?? '100000';
  const cmd = `wireskein capture --source oep:oep://${D.unit()} --channels ${channels.filter((x) => x.pin !== '').map((x) => `${x.name}=${D.pinName(x.pin)}`).join(',') || '<信号>=<ピン>'} --rate ${rate} --samples ${samples}${c.values.trigger ? ` --trigger ${c.values.trigger}` : ''} -o capture.wireskein`;
  state.captureSummary = c.reviewed ? [['プローブ', `${D.dev.info.model} / ${D.unit()}`], ['信号', channels.map((x) => `${x.name} → ${D.pinName(x.pin)}`).join(', ')], ['速さ（希望）', `${rate} Hz`], ['サンプル数', samples], ['トリガ', c.values.trigger || '指定なし'], ['コマンド例', cmd]] : null;
  const changed = () => { c.reviewed = false; };
  return [heading(mode === 'analog' ? 'アナログ取得の準備。' : '観測する信号と取得条件を決める。', mode === 'named' ? '既存の配線名で観測します。ロジックは使用中のデバッグ・UART等のピンも観測でき、配線の持ち主を変えません。' : '今回だけの取得条件です。本体設定や配線名の登録は不要です。', 'CAPTURE'),
    !offers.length ? note(`このプローブは${mode === 'analog' ? 'アナログ' : 'ロジック'}の取得機能を宣言していません。条件の整理はできますが、取得には対応するプローブが要ります。`, 'amber') : null,
    panel(el('h2', {}, '01 / 観測する信号'), mode === 'named' ? [field('使う配線', c.port, (v) => { c.port = v; changed(); render(); }, '', [['', '配線を選ぶ'], ...D.dev.ports.map((x) => [x.name, x.name])]),
      port ? wiringSummary(port) : link('繰り返し使う配線を登録', '/connection/new?purpose=custom&from=capture')]
      : [...c.channels.map((ch, i) => el('div', { class: 'field-grid mb' }, field(`信号${i + 1}の表示名`, ch.name, (v) => { ch.name = v; changed(); }, '取得ファイル内の名前。本体のラベルは変えません。'),
        field(`信号${i + 1}のピン`, ch.pin, (v) => { ch.pin = v; changed(); render(); }, mode === 'analog' ? 'ADCに対応するピンだけを出しています。' : '', [['', 'ピンを選ぶ'], ...(allowed.length ? allowed.map((x) => [String(x), D.pinName(x)]) : D.channelList().map(([x, n]) => [String(x), n]))], 'text', { id: `capture-pin-${i}` }))),
        actions(button('観測する信号を追加', () => { c.channels.push({ name: `signal${c.channels.length + 1}`, pin: '' }); changed(); render(); }), c.channels.length > 1 ? button('末尾の信号を外す', () => { c.channels.pop(); changed(); render(); }) : null)],
      note(mode === 'analog' ? 'アナログ取得はピンを専有します。同じ信号をロジックでも見るなら別のピンへ配線します。' : 'ロジック取得は聞くだけで、ピンを駆動しません。GNDと信号電圧を確認します。')),
    panel(el('h2', {}, '02 / WireSkeinで指定する取得条件'),
      field('サンプルレート（Hz）', rate, (v) => { c.values.rate = v; changed(); }, '希望する速さです。実際の速さは本数・取り方・経路で変わり、取得環境で確かめます。'),
      field('サンプル数', samples, (v) => { c.values.samples = v; changed(); }),
      field('トリガ（任意、例: signal1:rising）', c.values.trigger ?? '', (v) => { c.values.trigger = v; changed(); }),
      p('ここでは取得を実行せず、プローブへ保存もしません。', 'muted'),
      button('引継ぎ内容を確認', () => { c.reviewed = true; render(); }, 'primary', { disabled: !channels.some((x) => x.pin !== ''), id: 'review-capture' })),
    c.reviewed ? panel(el('h2', {}, '外部環境に渡す内容'), keyValues(state.captureSummary.slice(0, -1)), el('code', {}, cmd), actions(link('WireSkeinへの引継ぎを確認 →', '/handoff', true))) : null,
    actions(link('取得の使い分けに戻る', '/setup/logic')), external('キャプチャの使い分け・速度の条件', GUIDE_BASE + 'capture.ja.md')];
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
    if (!s.route) throw new Error('出力先のポートを選んでください。');
    if (s.source === 'uart') {
      if (s.rx === '') throw new Error('受けるピン（相手のTX）を選んでください。');
      await D.applySettings(s.category, { [`passthrough.${s.route}.rx`]: D.pinName(s.rx), [`passthrough.${s.route}.baud`]: s.baud, [`passthrough.${s.route}.format`]: s.format });
    } else {
      if (s.dio === '' || (s.wire === 'rvswd' && s.clk === '')) throw new Error('デバッグ線のピンを選んでください。');
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
  return [heading('普通のシリアルモニタへログを流す。', 'OEPのセッションがない間だけ働く、本体の素通し設定です。相手 → PCの受信だけで、相手へは送りません。', 'SETTINGS / PASSTHROUGH'),
    !uartCats.length && !consoleCats.length ? note('このプローブは素通しの設定を持っていません。', 'amber') : null,
    existing.length ? panel(el('h2', {}, '今の素通し'), keyValues(existing.map(([r, , txt]) => [r, txt])),
      actions(...existing.map(([r, cat]) => action(`${r}の素通しを外す`, () => D.applySettings(cat, {}, ['rx', 'baud', 'format', 'wire', 'swdio', 'swclk', 'mechanism', 'max-speed'].map((k) => `passthrough.${r}.${k}`).filter((f) => D.currentValue(cat, f) !== undefined)))))) : null,
    panel(el('h2', {}, '01 / 相手がログを出す経路'), field('ログの入力元', s.source, (v) => { s.source = v; s.port = ''; render(); }, '', [...(uartCats.length ? [['uart', 'UART']] : []), ...(consoleCats.length ? [['console', 'デバッグ線（WCH）']] : [])], 'text', { id: 'pt-source' }),
      cats.length > 1 ? field('使う系統', s.category, (v) => { s.category = v; }, '', cats.map((x) => [x, x])) : null,
      (s.source === 'uart' ? uartPorts : debugPorts).length ? field('登録済みの配線から', s.port, (v) => { fromPort(v); render(); }, '', [['', 'ピンを直接選ぶ'], ...(s.source === 'uart' ? uartPorts : debugPorts).map((x) => [x.name, x.name])]) : null,
      s.source === 'uart' ? [field('受けるピン（相手のTXから）', s.rx, (v) => { s.rx = v; }, '', [['', 'ピンを選ぶ'], ...D.channelList().map(([ch, n]) => [String(ch), n])], 'text', { id: 'pt-rx' }), field('速さ（baud）', s.baud, (v) => { s.baud = v; }, '', null, 'text', { id: 'pt-baud' }), field('形式', s.format, (v) => { s.format = v; }, '8n1、7e2 など', null, 'text', { id: 'pt-format' })]
        : [field('デバッグ線', s.wire, (v) => { s.wire = v; render(); }, '', [['rvswd', 'RVSWD（2線）'], ['swio', '1線DIO（SWIO）']]), field(s.wire === 'rvswd' ? 'SWDIO' : 'SWIO', s.dio, (v) => { s.dio = v; }, '', [['', 'ピンを選ぶ'], ...D.channelList().map(([ch, n]) => [String(ch), n])]),
          s.wire === 'rvswd' ? field('SWCLK', s.clk, (v) => { s.clk = v; }, '', [['', 'ピンを選ぶ'], ...D.channelList().map(([ch, n]) => [String(ch), n])]) : null,
          field('相手のログ出力方式', s.mechanism, (v) => { s.mechanism = v; }, '', [['sdi', 'sdi'], ['dmdata', 'dmdata'], ['dmseq', 'dmseq']]), p('相手を止める設定ではありません。ただしRVSWDでは接続時に相手がリセットされる場合があります。', 'muted')]),
    panel(el('h2', {}, '02 / ログを出すプローブのポート'), field('出力先のシリアルポート', s.route, (v) => { s.route = v; }, '1つのポートに置ける素通しは1つです。接続方式を選び直す操作ではありません。', routes.map((r) => [r, r]), 'text', { id: 'pt-route' }),
      note('OEPの道具が使っている間は止まり、セッションが終わると再開します。このページの接続も、最後に終了します。'),
      el('p', { id: 'passthrough-status', role: 'status' }, D.dev.unsaved ? '適用済み・未保存（再起動すると消えます）' : s.applied ? '保存済み' : '未適用'),
      actions(action('素通し設定を適用', apply, 'primary', { id: 'apply-passthrough', disabled: !s.category }), action('本体の現在値全体を保存', D.saveSettings, '', { id: 'save-passthrough', disabled: !D.dev.unsaved || !D.dev.saveable })),
      D.dev.saveable ? null : note('このプローブは永続保存できません。再起動すると設定は消えます。', 'amber'),
      s.applied ? actions(link('接続を終了してシリアルモニタへ', '/handoff')) : null),
    external('素通し設定と制約', GUIDE_BASE + 'settings.ja.md'), actions(link('据え置き治具の手順へ', '/fixture'), link('ログの方法を選び直す', '/setup/logs'))];
}
