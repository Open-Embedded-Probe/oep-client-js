// UI-only regression: the preview must never request access to hardware or load device/flash modules.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import './build-site.js';

const root = resolve('site'), temp = await mkdtemp(join(tmpdir(), 'oep-preview-chrome-'));
const artifacts = process.env.OEP_PREVIEW_ARTIFACTS ?? '/tmp/oep-preview-review';
await mkdir(artifacts, { recursive: true });
const errors = [], requests = [];
let chrome, socket, server;
const delay = ms => new Promise(r => setTimeout(r, ms));
try {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
    requests.push(url.pathname);
    if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    try { const data = await readFile(path); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream'); res.end(data); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const debugUrl = await new Promise((accept, reject) => {
    chrome = spawn(process.env.OEP_CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${temp}`, 'about:blank']);
    let output = ''; const timer = setTimeout(() => reject(new Error(output)), 20000);
    chrome.on('error', reject);
    chrome.stderr.on('data', b => { output += b; const m = output.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); accept(m[1]); } });
  });
  const pages = await (await fetch(`http://127.0.0.1:${new URL(debugUrl).port}/json`)).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => socket.addEventListener('open', r));
  let seq = 0; const pending = new Map();
  socket.addEventListener('message', e => { const msg = JSON.parse(e.data); if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(40); } throw Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`); };
  const route = async path => { await evaluate(`location.hash=${JSON.stringify(path)}`); await delay(100); };
  const click = async text => { await evaluate(`(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button: '+${JSON.stringify(text)});if(e.disabled)throw Error('Button disabled');e.click()})()`); await delay(100); };
  const set = async (label, value) => { await evaluate(`(()=>{const l=[...document.querySelectorAll('label')].find(e=>e.childNodes[0]?.textContent===${JSON.stringify(label)});if(!l)throw Error('Missing field: '+${JSON.stringify(label)}+'\\n'+document.body.innerText);const e=l.querySelector('input,select,textarea');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`); };
  const chooseWire = async wire => { await evaluate(`document.querySelector('[data-wire="${wire}"]').click()`); await delay(100); };
  const choosePattern = async pattern => { await evaluate(`document.querySelector('[data-pattern="${pattern}"]').click()`); await delay(100); };
  const shot = async name => { const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(artifacts, name + '.png'), Buffer.from(data, 'base64')); };
  const reset = async () => { await send('Page.navigate', { url: base + '/preview/' }); await until('!!document.querySelector(".hero")'); };
  const install = async (board, scenario = 'auto', keepPurpose = false) => {
    if (!keepPurpose) await route('/install/select');
    await evaluate(`document.querySelector('[data-board="${board}"]').click()`);
    await set('書き込み後のシナリオ', scenario);
    await route('/install/prepare'); await click('書き込み先を選ぶ（デモ）'); await click('内容を確認する →'); await click('OEPの導入をプレビュー →');
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__deviceCalls=[];for(const api of ['usb','serial','hid'])Object.defineProperty(navigator,api,{configurable:true,value:new Proxy({}, {get(_target,key){return()=>{__deviceCalls.push(api+'.'+String(key));throw Error('Hardware access forbidden in preview');};}})});` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await reset(); await shot('01-home');
  assert.match(await evaluate('document.body.innerText'), /OEPは|Open Embedded Probeは/);
  // Public information and connected work use the same purposes; reading never needs a probe.
  const purposes = ['debug', 'logs', 'logic', 'bus', 'signal', 'peer'];
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-pattern]")].map(e=>e.dataset.pattern)'), purposes);
  for (const purpose of purposes) {
    await route('/usecases'); await choosePattern(purpose);
    assert.equal(await evaluate('location.hash'), '#/usecase/' + purpose);
    assert.match(await evaluate('document.body.innerText'), /用意するもの/);
    assert.match(await evaluate('document.body.innerText'), /このページと、組み合わせる道具/);
    assert.deepEqual(await evaluate('__deviceCalls'), []);
  }
  await route('/usecase/logic'); await shot('25-public-logic');
  await route('/boards'); await shot('02-boards');
  assert.equal(await evaluate('document.querySelectorAll(".board-card").length'), 5);
  assert.match(await evaluate('document.querySelector(".board-card").innerText'), /ESP32-P4.*|推奨ボード/);
  await route('/install/select'); assert.equal(await evaluate('document.querySelector(".board-card.selected button").dataset.board'), 'p4');
  // Same-port install, without any connection-method or permission screen.
  await install('esp32');
  await until('location.hash==="#/setup"'); await shot('03-setup');
  assert.match(await evaluate('document.querySelector("h1").textContent'), /導入が完了/);
  await choosePattern('logs'); await evaluate('document.querySelector("[data-log-path=uart]").click()'); await delay(100); await click('配線に名前を付ける →');
  await set('接続名', 'board-1'); await set('相手のIC・基板の型番（任意）', 'STM32F103C8T6'); await set('用途・配線メモ（任意）', 'ログとデバッグ。相手は未接続。');
  await set('プローブRX ← 相手TX', '1'); await set('プローブTX → 相手RX', '0');
  assert.equal(await evaluate('[...document.querySelectorAll("label")].some(e=>e.firstChild.textContent==="通信速度（baud）")'), false);
  await click('＋ デバッグ'); await chooseWire('swd');
  for (const [label, pin] of [['SWDIO','2'],['SWCLK','3'],['NRST（任意）','4']]) await set(label, pin);
  await shot('04-connection-editor'); await click('配線を保存');
  await until('location.hash.startsWith("#/setup/ready?")');
  assert.match(await evaluate('document.body.innerText'), /board-1.*保存しました/);
  await route('/connections'); await shot('05-connections');
  await click('配線・相手の情報を編集');
  assert.equal(await evaluate('document.querySelector("input").value'), 'board-1');
  await set('相手のIC・基板の型番（任意）', 'CHANGED'); await click('キャンセル');
  assert.equal(await evaluate('document.querySelector("dialog").open'), true);
  await click('編集を続ける');
  assert.equal(await evaluate('document.querySelectorAll("input")[1].value'), 'CHANGED');
  await click('キャンセル'); await click('破棄して移動');
  await until('location.hash==="#/connections"');
  assert.match(await evaluate('document.body.innerText'), /STM32F103C8T6/);
  await click('UARTで使う →');
  assert.match(await evaluate('document.body.innerText'), /未開始/);
  await set('通信速度（baud）', '9600');
  await route('/work'); await route('/operate/uart');
  assert.equal(await evaluate('[...document.querySelectorAll("label")].find(e=>e.firstChild.textContent==="通信速度（baud）").querySelector("input").value'), '9600');
  await click('受信を開始'); await shot('06-uart');
  await set('送る文字列', '<img src=x onerror=alert(1)>'); await click('送信する（デモ）');
  assert.equal(await evaluate('document.querySelectorAll(".workspace-main img").length'), 0);
  await route('/work'); assert.match(await evaluate('document.body.innerText'), /UART · 使用中/);
  await click('停止'); assert.equal(await evaluate('document.querySelectorAll(".active-work").length'), 0);
  await shot('07-workspace');
  // All purpose-based operation layouts and their result/stop states.
  for (const [id, action] of [['i2c','書いてから読む'],['spi','送受信する'],['gpio','モードを適用して読む'],['pwm','出力を開始'],['counter','計測する'],['dac','出力を適用'],['debug','ターゲットに接続'],['peer','待ち受けを開始']]) {
    await route('/operate/'+id); if (id === 'debug') await chooseWire('swd'); await click(action); assert.equal(await evaluate('document.querySelectorAll(".terminal").length'), 1);
  }
  await route('/settings'); await set('SSID','sample-network'); await click('現在の設定に適用（デモ）'); await click('次回起動用に保存（デモ）'); assert.match(await evaluate('document.body.innerText'), /保存済み（デモ）/);
  await route('/maintenance'); await click('設定ファイルの確認例を見る'); await click('この変更を適用（デモ）'); assert.match(await evaluate('document.body.innerText'), /復元を適用した状態/);
  await route('/handoff'); await click('このページでの利用を終了して渡す（デモ）'); assert.match(await evaluate('document.body.innerText'), /デモ接続と操作を終了/);
  // Boot/runtime permission, replug and delayed-start handoffs stay inside installation.
  await reset(); await install('pico'); await until('location.hash==="#/install/permission"'); await shot('08-permission'); await click('起動したOEPを許可（デモ）'); await until('location.hash==="#/setup"');
  await reset(); await install('s3'); await until('location.hash==="#/install/replug"'); await shot('09-replug'); await click('つなぎ直した状態を確認（デモ）'); await click('起動したOEPを許可（デモ）'); await until('location.hash==="#/setup"');
  await reset(); await install('p4','timeout'); await until('location.hash==="#/install/timeout"'); await click('同じ機器で再試行（デモ）'); await until('location.hash==="#/setup"');
  // A purpose chosen before installation survives board changes and every runtime handoff.
  for (const [purpose, board, scenario, next] of [['logs','p4','auto','/setup/logs'], ['debug','pico','auto','/setup/debug'], ['logic','s3','auto','/setup/logic'], ['uart','p4','timeout','/setup/task?task=uart']]) {
    await reset(); await route('/usecase/' + purpose); await click('この用途でプローブを作る →');
    await click('選んだボードで次へ →'); await click('ボード選択に戻る');
    assert.equal(await evaluate('location.hash'), '#/install/select?purpose=' + purpose);
    await install(board, scenario, true);
    if (board === 'pico') { await until('location.hash==="#/install/permission"'); await click('起動したOEPを許可（デモ）'); }
    if (board === 's3') { await until('location.hash==="#/install/replug"'); await click('つなぎ直した状態を確認（デモ）'); await click('起動したOEPを許可（デモ）'); }
    if (scenario === 'timeout') { await until('location.hash==="#/install/timeout"'); await click('同じ機器で再試行（デモ）'); }
    await until(`location.hash===${JSON.stringify('#' + next)}`);
    assert.match(await evaluate('document.body.innerText'), /OEPの導入完了/);
    assert.equal(await evaluate('document.querySelectorAll(".active-work").length'), 0);
  }
  // Existing-device entry goes to the chosen setup without an installation progress indicator.
  for (const purpose of purposes) {
    await reset(); await route('/usecase/' + purpose); await click('導入済みのプローブで準備する →'); await click('機器を選んで接続（デモ）');
    assert.equal(await evaluate('location.hash'), '#/setup/' + (purpose === 'peer' ? 'task?task=peer' : purpose));
    assert.equal(await evaluate('document.querySelectorAll(".stepper").length'), 0);
  }
  await route('/operations'); assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-pattern]")].map(e=>e.dataset.pattern)'), purposes);
  // A visitor who tries an existing device first can switch to installation with the same purpose.
  await reset(); await route('/usecase/logs'); await click('導入済みのプローブで準備する →'); await click('ボードをプローブにする');
  assert.equal(await evaluate('location.hash'), '#/install/select?purpose=logs');
  // Direct setup links keep their purpose as well when the visitor needs to create a probe.
  await reset(); await route('/setup/bus'); await click('ボードから作る');
  assert.equal(await evaluate('location.hash'), '#/install/select?purpose=bus');
  // Abandoning a purpose for the generic installation entry must not leave an old continuation.
  await reset(); await route('/usecase/debug'); await click('この用途でプローブを作る →');
  await click('用途を選び直す'); await choosePattern('logs'); await click('この用途でプローブを作る →');
  await install('p4'); await until('location.hash==="#/setup"');
  // Each debug protocol keeps its own required pins, optional reset and method through save/edit/use.
  for (const [wire, roles, title] of [['swd', ['SWDIO','SWCLK'], 'SWD'], ['rvswd', ['SWDIO','SWCLK'], 'RVSWD'], ['swio', ['DIO'], '1線DIO（SWIO）']]) {
    await reset(); await route('/setup'); await click('プローブを選ぶ（デモ）'); await click('機器を選んで接続（デモ）');
    await choosePattern('debug'); await evaluate('document.querySelector("[data-debug-path=manual]").click()'); await delay(100); await chooseWire(wire);
    assert.equal(await evaluate('document.querySelectorAll("[data-group=debug] .wire-pins select").length'), roles.length);
    await set('接続名', 'debug-'+wire);
    for (const [i, label] of roles.entries()) await set(label, String(6+i));
    assert.equal(await evaluate('[...document.querySelectorAll("label")].some(e=>e.textContent.includes("速度上限"))'), false);
    await shot('16-debug-'+wire); await click('配線を保存');
    await until('location.hash.startsWith("#/setup/ready?")');
    await click(title+'の操作へ →');
    assert.match(await evaluate('document.body.innerText'), /未開始/);
    await set('速度上限（kHz、空欄は自動）', '500');
    await click('ターゲットに接続'); assert.ok((await evaluate('document.querySelector(".terminal").textContent')).includes(title));
    await click('ターゲットを切り離す'); await click('この配線を編集');
    assert.equal(await evaluate('document.querySelector("[data-wire][aria-pressed=true]").dataset.wire'), wire);
    assert.equal(await evaluate('document.querySelectorAll("[data-group=debug] .wire-pins select").length'), roles.length);
    await click('キャンセル'); await until('location.hash==="#/operate/debug"');
  }
  // Pin discovery and explicit wiring converge on the same editor. Checking is optional.
  await reset(); await route('/setup'); await click('プローブを選ぶ（デモ）'); await click('機器を選んで接続（デモ）');
  await choosePattern('debug'); await shot('28-debug-paths');
  assert.equal(await evaluate('document.body.innerText.includes("まず一度使う")'), false);
  await evaluate('document.querySelector("[data-debug-path=scan]").click()'); await delay(100);
  assert.equal(await evaluate('document.body.innerText.includes("見つかった配線候補")'), false);
  await chooseWire('rvswd');
  assert.equal(await evaluate(`document.querySelector('[data-scan-pin="4"]').disabled`), true);
  await set('検索結果（デモ）','empty'); await click('選択したピンをスキャン（デモ）');
  assert.match(await evaluate('document.body.innerText'), /応答なしの表示例/);
  await set('検索結果（デモ）','found'); await click('選択したピンをスキャン（デモ）'); await shot('29-debug-scan');
  await click('この配線を確認・保存へ →');
  assert.equal(await evaluate('document.querySelector("[data-group=debug] .wire-pins select").value'), '6');
  await set('接続名', 'scanned');
  await click('指定したピンで接続確認（デモ）');
  assert.match(await evaluate('document.getElementById("debug-check-0").textContent'), /応答を確認/);
  await set('SWDIO','8');
  assert.match(await evaluate('document.getElementById("debug-check-0").textContent'), /未確認/);
  await set('接続確認の結果（デモ）','empty'); await click('指定したピンで接続確認（デモ）');
  assert.match(await evaluate('document.getElementById("debug-check-0").textContent'), /応答なし/);
  await click('配線を保存'); await until('location.hash.startsWith("#/setup/ready?")');
  await click('配線を編集する');
  assert.match(await evaluate('document.getElementById("debug-check-0").textContent'), /未確認/);
  await click('キャンセル');
  // Optional direct use transfers the chosen pins, without saving or starting a session.
  await route('/connection/new?purpose=debug&wire=swio'); await set('DIO','10');
  await click('この配線で操作へ（保存しない）');
  await until('location.hash==="#/operate/debug"');
  assert.equal(await evaluate('[...document.querySelectorAll("label")].find(e=>e.firstChild.textContent==="DIO").querySelector("select").value'), '10');
  assert.equal(await evaluate('document.querySelectorAll(".active-work").length'), 0);
  await route('/connections'); assert.equal(await evaluate('document.querySelectorAll(".connection-card").length'), 2);
  // Standalone capture needs no label. Named capture can observe an existing I2C wiring record.
  await reset(); await route('/setup'); await click('プローブを選ぶ（デモ）'); await click('機器を選んで接続（デモ）');
  await choosePattern('logic'); await evaluate('document.querySelector("[data-capture-mode=standalone]").click()'); await delay(100);
  assert.equal(await evaluate('!!document.querySelector("#connection-form")'), false);
  await set('信号1の表示名','SDA'); await set('サンプルレート（Hz）','2000000'); await set('トリガ','SDA:fall');
  await click('引継ぎ内容を確認（デモ）'); await shot('17-logic');
  assert.match(await evaluate('document.querySelector("#capture-summary").textContent'), /2000000/);
  await click('WireSkeinへの引継ぎを確認 →'); assert.match(await evaluate('document.body.innerText'), /SDA:fall/);
  await route('/capture?mode=named'); await set('使う配線','sample-sensor'); await click('引継ぎ内容を確認（デモ）');
  assert.match(await evaluate('document.querySelector("#capture-summary").textContent'), /sensor.sda/);
  await click('配線を編集'); await click('キャンセル'); await until('location.hash==="#/capture?mode=named"');
  await route('/connections'); assert.equal(await evaluate('document.querySelectorAll(".connection-card").length'), 1);
  for (const mode of ['during','test','analog']) { await route('/capture?mode='+mode); assert.equal(await evaluate('!!document.querySelector("h1")'), true); }
  // Receive-only UART wiring and console direction are distinct from idle-time passthrough settings.
  await route('/connection/new?purpose=uart'); await set('接続名','rx-only'); await set('プローブRX ← 相手TX','8'); await click('配線を保存');
  await until('location.hash.startsWith("#/setup/ready?record=")'); await click('UARTの操作へ →'); await click('受信を開始');
  assert.equal(await evaluate('[...document.querySelectorAll("button")].some(e=>e.textContent=== "送信する（デモ）")'), false);
  await click('受信を停止');
  await route('/setup/logs'); await evaluate('document.querySelector("[data-log-path=console]").click()'); await delay(100);
  assert.equal(await evaluate('!!document.querySelector("[data-wire=swd]")'), false); await chooseWire('swio'); await click('保存せず操作の準備へ →');
  await set('相手のログ出力方式','sdi'); await click('ログの受信を開始');
  assert.equal(await evaluate('[...document.querySelectorAll("button")].some(e=>e.textContent=== "送信する（デモ）")'), false);
  await set('相手のログ出力方式','dmseq'); await click('ログの受信を開始'); await set('送る文字列','test'); await click('送信する（デモ）'); await shot('18-console');
  await route('/passthrough'); await set('ログの入力元','console'); await set('デバッグ線','swio');
  assert.equal(await evaluate('[...document.querySelectorAll("label")].some(e=>e.firstChild.textContent==="SWCLK")'), false);
  await click('素通し設定を適用（デモ）'); await click('本体の現在値全体を保存（デモ）'); assert.match(await evaluate('document.getElementById("passthrough-status").textContent'), /保存済み/);
  await set('出力先シリアルポート','bridge0'); assert.equal(await evaluate('document.getElementById("save-passthrough").disabled'), true); await shot('19-passthrough');
  await route('/fixture'); assert.equal(await evaluate('document.querySelectorAll(".setup-choice").length'), 5); await shot('20-fixture');
  await route('/settings'); assert.equal(await evaluate('[...document.querySelectorAll("label")].some(e=>e.firstChild.textContent==="SSID")'), false);
  await route('/maintenance?from=fixture'); await click('控えの内容例を見る'); assert.match(await evaluate('document.body.innerText'), /ファイルはまだ生成しません/);
  for (const pattern of ['bus','signal']) { await route('/setup'); await choosePattern(pattern); assert.ok((await evaluate('document.querySelectorAll(".pattern-card").length')) >= 2); }
  // Existing-device entry skips board selection. A direct operation link retains the requested task.
  await reset(); await route('/operate/uart'); await click('プローブを選ぶ（デモ）'); await click('機器を選んで接続（デモ）'); await until('location.hash==="#/operate/uart"');
  await route('/connections'); await click('配線・相手の情報を編集'); await set('接続名','edited'); await click('変更を保存'); assert.match(await evaluate('document.body.innerText'), /edited/);
  // Mobile widths and no horizontal document overflow on representative screens.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const [path, name] of [['/home','10-mobile-home'],['/install/select','11-mobile-boards'],['/setup','12-mobile-setup'],['/connection/new?purpose=debug&wire=swio','13-mobile-editor'],['/operate/uart','14-mobile-operation'],['/learn','15-mobile-learn'],['/setup/logs','21-mobile-logs'],['/capture?mode=standalone','22-mobile-capture'],['/passthrough','23-mobile-passthrough'],['/fixture','24-mobile-fixture'],['/usecase/debug','26-mobile-usecase'],['/operations','27-mobile-purposes'],['/setup/debug','30-mobile-debug-paths'],['/setup/debug-scan','31-mobile-scan']]) {
    await route(path); await shot(name);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'overflow at '+path);
  }
  assert.deepEqual(await evaluate('__deviceCalls'), []);
  assert.deepEqual(errors, []);
  assert.equal(requests.some(p => /oep-client\.js|esp-loader|\/src\/|\/firmware\//.test(p)), false, 'preview must not load device or firmware code');
  console.log(`PASS: hardware-free preview, installation scenarios, setup choices, connection create/edit/cancel, purpose-based tools, settings, handoff and mobile layouts. Screenshots: ${artifacts}`);
} catch (error) {
  console.error('Browser exceptions:', errors);
  throw error;
} finally {
  socket?.close(); chrome?.kill(); server?.closeAllConnections(); server?.close();
  await delay(250); await rm(temp,{ recursive: true, force: true }).catch(()=>{});
}
