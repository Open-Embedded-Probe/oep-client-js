// Real Chromium UI tests against the Python virtual probe. The HTTP transport below is test-only;
// production pages still use WebUSB / WebSerial / WebHID. No runtime or npm dependency is added.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './build-site.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.OEP_PYTHON ?? join(root, 'test/virtual-bench/.venv/bin/python');
const chromeCommand = process.env.OEP_CHROME ?? 'google-chrome';
const temp = await mkdtemp(join(tmpdir(), 'oep-browser-'));
const children = [];
let socket, waiting, chunks = [], server, browserSocket;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function start(command, args, pattern, stream = 'stdout') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Timed out starting ${command}: ${out}`)), 20000);
    child[stream].on('data', (data) => { out += data; const m = out.match(pattern); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${command} exited ${code}: ${out}`)); });
  });
}
try {
  let benchPort = Number(await start(python, ['-m', 'oep_client.virtual_bench_serve', '--tcp', '0', '--profile', 'p4-x035', '--uart-rx', 'browser test'], /PORT (\d+)/));
  function flush() { if (waiting && chunks.length) { waiting.end(Buffer.concat(chunks)); chunks = []; waiting = null; } }
  const flashImage = Buffer.alloc(0x20000);
  flashImage[0x1000] = 0xe9; flashImage[0x8000] = 0xaa; flashImage[0x8001] = 0x50;
  const rpImage = Buffer.alloc(512);
  for(const [at,n] of [[0,0x0a324655],[4,0x9e5d5157],[8,0x2000],[12,0x10000000],[16,256],[24,1],[28,0xe48bff56],[508,0x0ab16f30]]) rpImage.writeUInt32LE(n,at);
  const flashManifest = { schema: 1, version: '0.0.47', firmware: [{ model: 'esp32', kind: 'merged', flash_offset: 0,
    file: 'test-esp32.merged.bin', example: 'Firmware/OepProbe', sha256: createHash('sha256').update(flashImage).digest('hex') }] };
  flashManifest.firmware.push({model:'rp2040',kind:'uf2',file:'test-pico.uf2',example:'Firmware/OepProbe',sha256:createHash('sha256').update(rpImage).digest('hex')});
  const p4Image = Buffer.alloc(4096, 0xe9);
  flashManifest.firmware.push({ model: 'esp32p4', kind: 'app', file: 'test-p4.bin', example: 'Firmware/OepProbe', sha256: createHash('sha256').update(p4Image).digest('hex') });
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/firmware/firmware.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(flashManifest)); return; }
      if (path === '/firmware/test-esp32.merged.bin') { res.end(flashImage); return; }
      if (path === '/firmware/test-pico.uf2') {res.end(rpImage);return;}
      if (path === '/firmware/test-p4.bin') { res.end(p4Image); return; }
      if (path === '/esp-loader.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`export class Transport { constructor(port){globalThis.__flashPort=port;} async disconnect(){globalThis.__flashClosed=true;} }
          export class ESPLoader { chip={CHIP_NAME:'ESP32'}; async main(){return 'ESP32 test ROM';}
            async writeFlash(o){globalThis.__flashCount=(globalThis.__flashCount??0)+1;globalThis.__flashWrite={address:o.fileArray[0].address,size:o.fileArray[0].data.length,eraseAll:o.eraseAll};o.reportProgress(0,o.fileArray[0].data.length,o.fileArray[0].data.length);}
            async after(mode){globalThis.__flashReset=mode;} }`); return;
      }
      if (path === '/_test/open') {
        chunks = [];
        socket = tcpConnect({ host: '127.0.0.1', port: benchPort });
        socket.on('data', (b) => { chunks.push(b); flush(); });
        socket.on('close', () => { if (waiting) { waiting.end(); waiting = null; } });
        socket.on('error', () => {});
        socket.once('connect', () => res.end('OK')); return;
      }
      if (path === '/_test/read') { waiting = res; flush(); return; }
      if (path === '/_test/write') { const data = []; for await (const b of req) data.push(b); socket.write(Buffer.concat(data), () => res.end('OK')); return; }
      if (path === '/_test/close') { socket?.destroy(); res.end('OK'); return; }
      if (path === '/oep-client.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`export * from './src/index.js'; export * from './src/browser/index.js';
          import {connect} from './src/open.js';
          import * as lib from './src/index.js';
          export const core={...lib.core,async probeInfo(h){const info=await lib.core.probeInfo(h);const model=globalThis.__model??(globalThis.__flashWrite?'esp32':null);return model?{...info,model}:info;},async planApply(...args){if(globalThis.__forbidTargetIO)throw Error('Unexpected pin assignment while registering');return lib.core.planApply(...args);}};
          const memoKey=(n)=>typeof n==='string'?n:new TextDecoder().decode(n);
          const memoStore=()=>globalThis.__memoObjects??=new Map();
          const fakeMemo={
            async list(){return [...memoStore()].map(([k,v])=>({name:new TextEncoder().encode(k),size:v.length}));},
            async read(n){const v=memoStore().get(memoKey(n));if(!v)throw new lib.NoResource(new lib.message.Result(1,0,lib.registry.REJECT_REASONS.no_resource));return v.slice();},
            async write(n,data){if(globalThis.__failMemoSave)throw Error('memo storage full');memoStore().set(memoKey(n),Uint8Array.from(data));},
            async delete(n){if(!memoStore().delete(memoKey(n)))throw new lib.NoResource(new lib.message.Result(1,0,lib.registry.REJECT_REASONS.no_resource));},
            async readPortRecord(name){const v=memoStore().get(lib.memo.portRecordName(name));return v?JSON.parse(new TextDecoder().decode(v)):null;},
            async updatePortRecord(name,fields){const record={...(await this.readPortRecord(name)??{})};for(const [k,v] of Object.entries(fields)){if(v===null||v==='')delete record[k];else record[k]=v;}await this.write(lib.memo.portRecordName(name),new TextEncoder().encode(JSON.stringify(record)));return record;},
          };
          export const memo={...lib.memo,Memo:class extends lib.memo.Memo{static async open(h){return globalThis.__withMemo?fakeMemo:lib.memo.Memo.open(h);}}};
          export const dump={...lib.dump,async collect(h){const caps=await lib.dump.collect(h);if(globalThis.__withMemo)caps.offers.push({...caps.offers[0],entry:{...caps.offers[0].entry,name:'oep.probe.memo',revision:1,fn:99}});if(globalThis.__withoutScan)for(const o of caps.offers)if(o.entry.name.startsWith('oep.wire.'))o.description.ops=new Set([lib.riscv.WireBase.ATTACH]);return caps;}};
          for(const [Class,method] of [[lib.riscv.WireBase,'scan'],[lib.riscv.Wire,'attach'],[lib.arm.SwdWire,'attach']]){const original=Class.prototype[method];Class.prototype[method]=function(...args){if(globalThis.__forbidTargetIO)throw Error('Unexpected '+method+' while registering');return original.apply(this,args);};}

          export async function requestRp2Boot(){return {serialNumber:'boot-rom-only'};}
          export async function rp2Write(device,image,{onProgress}){globalThis.__rpWritten=true;onProgress({done:image.length,total:image.length});}
          export async function getUsbProbes(){return [{productName:'OEP Probe',serialNumber:'fafe00000035'},{productName:'OEP Probe',serialNumber:'second-probe'},...(globalThis.__rpWritten?[{productName:'OEP Probe',serialNumber:'new-pico'}]:[])];}
          export async function requestUsbProbe(){return {productName:'OEP Probe',serialNumber:globalThis.__usbProbeSerial??'fafe00000035'};}
          export async function requestDfuDevice(){return {serialNumber:'FAFE00000035'};}
          export async function dfuUpdate(device,image,{onProgress}){globalThis.__dfuWritten=image.length;onProgress({phase:'download',written:image.length,total:image.length});}
          export async function rp2ResetToBoot(){globalThis.__resetToBoot=true;return true;}
          export async function openWebSerial(port){if(globalThis.__rejectSerial)throw Error('Device is still restarting');globalThis.__reusedSerialPort=port?.testPort===true;const h=await openWebUsb();globalThis.__connectionMethod='serial';return h;}
          export async function openWebUsb(device,opts){
            globalThis.__connectionMethod='usb';
            globalThis.__selectedProbe=device?.serialNumber??null;
            await fetch('/_test/open'); let active=true;
            return connect({kind:'usb',framing:'length',keepsBoundaries:true,
              start(onData,onClose){(async()=>{while(active){try{const r=await fetch('/_test/read');const b=new Uint8Array(await r.arrayBuffer());if(!active)return;if(!b.length){onClose();return;}onData(b);}catch(e){if(active)onClose(e);return;}}})();},
              async write(b){await fetch('/_test/write',{method:'POST',body:b});},
              async close(){active=false;await fetch('/_test/close');}
            },{keepSession:false});
          }`); return;
      }
      const file = resolve(root, 'site', path === '/' ? 'index.html' : path === '/esp-loader-real.js' ? 'esp-loader.js' : path.slice(1));
      if (!file.startsWith(resolve(root, 'site') + '/')) { res.writeHead(403).end(); return; }
      const data = await readFile(file);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' })[extname(file)] ?? 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const debugUrl = await start(chromeCommand, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${temp}`, 'about:blank'], /DevTools listening on (ws:\/\/[^\s]+)/, 'stderr');
  const debugPort = new URL(debugUrl).port;
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  browserSocket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => browserSocket.addEventListener('open', r));
  let id = 0, acceptDialog = true; const pending = new Map(), exceptions = [];
  browserSocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(message.error) : p.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: acceptDialog });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); browserSocket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  const until = async (expression, timeout = 10000) => {
    const end = Date.now() + timeout;
    do { if (await evaluate(expression)) return; await delay(40); } while (Date.now() < end);
    throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
  };
  const route = async (hash) => { await evaluate(`location.hash=${JSON.stringify(hash)}`); await delay(80); };
  const set = (id, v) => evaluate(`{const e=document.getElementById(${JSON.stringify(id)}); if(!e)throw Error('missing field: '+${JSON.stringify(id)});e.value=${JSON.stringify(String(v))};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));}`);
  const click = async (text) => {
    await evaluate(`{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw Error('missing button: '+${JSON.stringify(text)});if(b.disabled)throw Error('disabled button: '+${JSON.stringify(text)});b.click();}`);
    await until('document.body.dataset.busy !== "true"');
  };
  const succeeded = async () => assert.notEqual(await evaluate('document.getElementById("feedback").className'), 'bad', await evaluate('document.getElementById("feedback").textContent'));
  const snapshot = async (name) => {
    if (!process.env.OEP_SCREENSHOTS) return;
    await mkdir(process.env.OEP_SCREENSHOTS, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.OEP_SCREENSHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const h1 = () => evaluate('document.querySelector("h1")?.textContent');
  const text = () => evaluate('document.getElementById("app").textContent');
  const ok = async (what) => { const f = await evaluate('[document.getElementById("feedback").className, document.getElementById("feedback").textContent]'); assert.ok(!f[0].includes('bad'), `${what}: ${f[1]}`); };
  const go = async (hash) => { await evaluate(`location.hash=${JSON.stringify('#' + hash)}`); await delay(120); };
  const press = async (label) => { await click(label); await ok(label); };
  const follow = async (label) => {
    await evaluate(`{const a=[...document.querySelectorAll('a')].find(a=>a.textContent===${JSON.stringify(label)});if(!a)throw Error('missing link: '+${JSON.stringify(label)});a.click();}`); await delay(120);
  };
  const choose = (selector, index = 1) => evaluate(`{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.selectedIndex=${index};e.dispatchEvent(new Event('change',{bubbles:true}));e.value}`);
  const pick = (selector, value) => evaluate(`{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));}`);
  const tap = async (selector) => { await evaluate(`{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.click();}`); await delay(80); await until('document.body.dataset.busy !== "true"'); };
  const noOverflow = async (what) => assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `overflow: ${what}`);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base });
  await until('document.querySelector("h1")'); await snapshot('01-home');
  // P01-P04 need no device permission (A01).
  assert.match(await h1(), /共通プローブ/);
  assert.equal(await evaluate('document.querySelector(".hero .btn.primary").hash'), '#/install/select', 'creating a probe is the primary action');
  for (const r of ['/usecases', '/usecase/debug', '/usecase/uart', '/boards', '/learn']) { await go(r); assert.ok(await h1(), r); await noOverflow(r); }
  // Old addresses still land somewhere sensible (acceptance §4).
  await evaluate('location.hash="#help"'); await delay(120); assert.equal(await evaluate('location.hash'), '#/learn');
  // I01: install a classic ESP32 over serial; detection, write, the same port reopened, then I02 (A04).
  await evaluate('Object.defineProperty(navigator.serial,"requestPort",{configurable:true,value:async()=>({testPort:true})})');
  await go('/install/select'); await tap('[data-board=esp32]'); await follow('選んだボードで次へ →');
  assert.match(await h1(), /ESP32を用意する/);
  await press('書き込み先を選ぶ'); assert.match(await text(), /ESP32 — 選択済み/);
  await follow('内容を確認する →'); assert.match(await text(), /test-esp32\.merged\.bin/);
  await click('このボードにOEPを導入'); await until('location.hash.startsWith("#/setup")', 20000); await ok('install');
  assert.deepEqual(await evaluate('globalThis.__flashWrite'), { address: 0, size: flashImage.length, eraseAll: false });
  assert.equal(await evaluate('globalThis.__reusedSerialPort'), true, 'the programming port is reused');
  assert.equal(await h1(), 'OEPの導入が完了しました。'); await snapshot('02-installed');
  await press('接続を終了');
  // A failed reconnection keeps the write and offers a retry without writing again (A09).
  await evaluate('globalThis.__rejectSerial=true');
  await go('/install/prepare'); await press('書き込み先を選び直す'); await follow('内容を確認する →'); await click('このボードにOEPを導入');
  await until('location.hash==="#/install/continue"', 30000);
  assert.match(await text(), /書き込み完了/); assert.equal(await evaluate('globalThis.__flashCount'), 2);
  await evaluate('globalThis.__rejectSerial=false'); await press('同じ機器で再試行');
  assert.equal(await evaluate('location.hash'), '#/setup'); assert.equal(await evaluate('globalThis.__flashCount'), 2, 'no second write');
  await press('接続を終了');
  // I01 for a Pico: the BOOTSEL device chosen once, the UF2 written through the boot ROM, the one new OEP device this site
  // may open taken without another chooser (A07).
  await evaluate(`{const boot={vendorId:0x2e8a,productId:0x0003,serialNumber:'boot'};Object.defineProperty(navigator.usb,'requestDevice',{configurable:true,value:async()=>boot});Object.defineProperty(navigator.usb,'getDevices',{configurable:true,value:async()=>globalThis.__resetToBoot?[boot]:[]});}`);
  await evaluate('globalThis.__model="rp2040"');
  await go('/install/select'); await tap('[data-board=pico]'); await follow('選んだボードで次へ →');
  await press('書き込み先を選ぶ'); assert.match(await text(), /RP2040 — 選択済み/);
  await follow('内容を確認する →'); assert.match(await text(), /test-pico\.uf2/);
  await click('このボードにOEPを導入'); await until('location.hash.startsWith("#/setup")', 20000); await ok('pico install');
  assert.equal(await evaluate('globalThis.__rpWritten'), true); assert.equal(await evaluate('globalThis.__selectedProbe'), 'new-pico', 'the new device, not one known before');
  // W06 update of the connected Pico: back to its boot ROM over USB, the UF2 written, then the same unit again.
  await evaluate('globalThis.__rpWritten=false; globalThis.__usbProbeSerial="fafe00000035"');
  acceptDialog = true; await go('/maintenance'); await press('このプローブを更新');
  assert.equal(await evaluate('globalThis.__resetToBoot && globalThis.__rpWritten'), true);
  await evaluate('globalThis.__model=null'); if (await evaluate('!!document.querySelector("[data-action=disconnect]")')) await press('接続を終了');
  // W06 update of a P4 through its USB DFU: the DFU device must be the same unit (its serial is the unit id).
  await evaluate('globalThis.__model="esp32p4"'); await go('/connect'); await press('機器を選んで接続');
  await go('/maintenance'); await press('このプローブを更新'); assert.equal(await evaluate('globalThis.__dfuWritten'), p4Image.length);
  await evaluate('globalThis.__model=null'); if (await evaluate('!!document.querySelector("[data-action=disconnect]")')) await press('接続を終了');
  // From here the probe has a memo area (oep.probe.memo, a stand-in kept in the page): records go there, not to the browser.
  await evaluate('globalThis.__withMemo=true; globalThis.__downloads=[]; {const o=URL.createObjectURL; URL.createObjectURL=(b)=>{globalThis.__downloads.push(b); return o(b);};}');
  // A purpose chosen before connecting is kept through C01 (A02, A40).
  await go('/usecase/logs'); await tap('[data-purpose-connect=logs]');
  assert.equal(await evaluate('location.hash'), '#/connect'); assert.match(await text(), /ログを読む・コマンドを送る/);
  await press('機器を選んで接続'); assert.equal(await evaluate('location.hash'), '#/setup/logs');
  // W03: debug + UART wiring saved with the target absent: no scan, attach or pin assignment (A13).
  await evaluate('globalThis.__forbidTargetIO=true');
  await go('/connection/new?purpose=uart'); await tap('[data-kind=connector]');
  await choose('[data-line="0-rx"]', 3);
  await tap('[data-add-group=custom]'); await choose('[data-line="1-signal1"]', 6);
  await pick('#conn-name', 'dut'); await pick('#conn-note', 'swap connector');
  assert.equal(await evaluate('document.getElementById("conn-part")'), null, 'a connector records no part number');
  await snapshot('03-editor');
  await press('配線を保存'); assert.match(await evaluate('location.hash'), /^#\/setup\/ready\?port=dut/);
  await evaluate('globalThis.__forbidTargetIO=false');
  await go('/connections'); assert.match(await text(), /コネクタ（相手はつなぐたびに識別）/); assert.match(await text(), /rx → GPIO/);
  // Editing a saved port keeps its debug lines and changes the record (A14).
  await go('/connection/x035'); await pick('#conn-part', 'CH32X035G8U6'); await press('変更を保存');
  assert.equal(await evaluate('location.hash'), '#/connections'); assert.match(await text(), /CH32X035G8U6/); assert.match(await text(), /swclk → GPIO54/);
  // One connection check from the editor, results not saved (A43).
  await go('/connection/x035'); await press('指定したピンで接続確認'); assert.match(await evaluate('document.getElementById("debug-check-0").textContent'), /応答あり: dmstatus/);
  await click('キャンセル'); await delay(100);
  // A scan fills the same editor and saves nothing by itself (A42).
  await go('/setup/debug-scan'); await tap('[data-wire=rvswd]'); await tap('[data-scan-pin="2"]');
  assert.match(await text(), /選択したピンをスキャン/);
  // W04 debug: attach to the saved wiring, halt, read memory, detach (A21).
  await go('/operate/debug?port=x035'); await press('ターゲットに接続'); assert.match(await text(), /接続中 · dmstatus/);
  assert.equal(await evaluate('[...document.querySelectorAll(".active-work")].length'), 1, 'the running debug shows in the status bar');
  await press('停止'); await press('メモリを読む'); await press('ターゲットを切り離す'); assert.match(await text(), /未接続/);
  // W04 UART on the saved RX; GPIO with pins chosen on the spot.
  await go('/operate/uart?port=dut'); await press('受信を開始'); await delay(1200); await press('受信を停止');
  await go('/operate/gpio'); await pick('[data-role="1"]', 5); await press('ピンを割り当てて開始'); await press('レベルを読む'); await press('停止してピンを解放');
  // W04 the other fixture functions: pins chosen on the spot, started, every operation it offers, stopped (A22).
  const fixtureRun = async (id) => {
    await go(`/operate/${id}`);
    const roles = await evaluate('[...document.querySelectorAll("[data-role]")].map(e=>e.dataset.role)');
    for (const [k, r] of roles.entries()) await choose(`[data-role="${r}"]`, k + 1);
    await tap('#start-operation'); await ok(`${id} start`);
    assert.equal(await evaluate('document.querySelector(".status-bar-ops")?.textContent.includes("使用中")'), true, `${id} shows in the status bar`);
    const ops = await evaluate('[...document.querySelectorAll("[data-op]")].map(e=>e.dataset.op)');
    assert.ok(ops.length, `${id} offers operations`);
    for (const op of ops) { await tap(`[data-op="${op}"]`); await ok(`${id} ${op}`); }
    await tap('#stop-operation'); await ok(`${id} stop`);
    assert.equal(await evaluate('!!document.querySelector(".status-bar-ops")'), false, `${id} left the status bar`);
  };
  for (const id of ['i2c', 'spi', 'pwm', 'counter', 'i2c-target', 'spi-target']) await fixtureRun(id);
  // W05 passthrough: apply, then save (A36).
  await go('/passthrough'); await pick('#pt-rx', 7); await press('素通し設定を適用'); assert.match(await text(), /適用済み・未保存/);
  await press('本体の現在値全体を保存'); assert.match(await text(), /今の素通し/);
  await go('/settings'); assert.match(await text(), /保存されている値と同じです/);
  // W04 the debug wire's console (dmseq) on the saved wiring, started and stopped.
  await go('/operate/console?port=x035'); await tap('#start-operation'); await ok('console start');
  assert.match(await text(), /受信中 · dmseq/); await tap('#stop-operation'); await ok('console stop');
  // W05 idle and disable per pin: applied, then saved; the raw table shows them.
  await go('/settings'); await pick('[data-idle="GPIO20"]', 'pull-up'); await press('ピンの設定を適用');
  assert.match(await text(), /適用済み・永続保存はまだ/); await press('次回起動用に保存'); assert.match(await text(), /channel\.GPIO20\.idle/);
  // W06: the settings and memo backups, a restore shown as a difference before it is applied, diagnostics (A27, A28).
  const lastDownload = () => evaluate('globalThis.__downloads.at(-1).text()');
  const upload = (json) => evaluate(`{const i=document.querySelector('input[type=file]');const t=new DataTransfer();t.items.add(new File([${JSON.stringify(json)}],'backup.json',{type:'application/json'}));i.files=t.files;i.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await go('/maintenance'); await press('設定を控える');
  const backup = JSON.parse(await lastDownload());
  await press('メモを控える');
  const memoBackup = JSON.parse(await lastDownload());
  assert.ok(Object.keys(memoBackup.objects).some((k) => k.endsWith('/port/dut')), 'the memo backup has the port records');
  await go('/settings'); await pick('[data-idle="GPIO20"]', 'pull-down'); await press('ピンの設定を適用'); await press('次回起動用に保存');
  await go('/maintenance'); await upload(JSON.stringify(backup)); await until('document.body.textContent.includes("設定の差分")');
  await press('この変更を適用'); await go('/settings');
  assert.equal(await evaluate('document.querySelector(\'[data-idle="GPIO20"]\').value'), 'pull-up', 'the backup put back the idle state');
  await press('次回起動用に保存');
  await evaluate('globalThis.__memoObjects.delete([...globalThis.__memoObjects.keys()].find(k=>k.endsWith("/port/dut")))');
  await go('/maintenance'); await upload(JSON.stringify(memoBackup)); await until('document.body.textContent.includes("メモの差分")');
  assert.match(await text(), /無い/); await press('この記録を書き戻す');
  await go('/connections'); assert.match(await text(), /swap connector/, 'the restored record is read back');
  await go('/maintenance'); await press('宣言を読み直す'); assert.match(await text(), /oep\.fixture\.i2c-controller/);
  // Capture preparation hands a command to WireSkein; the page acquires nothing (A26).
  await go('/capture?mode=standalone'); await choose('#capture-pin-0', 3); await press('引継ぎ内容を確認'); assert.match(await text(), /wireskein capture --source oep:oep:\/\/fafe00000035/);
  // W07 hand over.
  await go('/handoff'); assert.match(await text(), /oep:\/\/fafe00000035\/x035/); await press('このページでの利用を終了して渡す');
  assert.match(await text(), /プローブ未接続/);
  // A classic ESP32 probe (another virtual bench): DAC and the Wi-Fi settings.
  const p4Port = benchPort;
  benchPort = Number(await start(python, ['-m', 'oep_client.virtual_bench_serve', '--tcp', '0', '--profile', 'esp32-v003'], /PORT (\d+)/));
  await evaluate('globalThis.__withMemo=false');
  await go('/connect'); await press('機器を選んで接続');
  await fixtureRun('dac');
  await go('/settings'); await set('wifi-ssid', 'bench'); await set('wifi-pass', 'bench-passphrase'); await press('ネットワーク設定を適用');
  assert.match(await text(), /wifi\.0\.ssid/); assert.doesNotMatch(await text(), /bench-passphrase/, 'a secret is never shown');
  await press('接続を終了');
  benchPort = p4Port;
  // Narrow screens (A29).
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const r of ['/home', '/usecases', '/boards', '/install/select', '/connect', '/work', '/handoff']) { await go(r); await noOverflow(r); }
  await go('/connect'); await press('機器を選んで接続');
  for (const r of ['/setup', '/work', '/connections', '/connection/x035', '/operate/debug', '/operate/uart', '/passthrough', '/settings', '/maintenance', '/handoff']) { await go(r); assert.ok(await h1(), r); await noOverflow(r); }
  await snapshot('04-mobile');
  await press('接続を終了');
  assert.deepEqual(exceptions, []);
  console.log('Browser page: public pages, ESP install with the port reused and a retry without rewriting, Pico install by BOOTSEL and the new device taken, Pico and P4 (DFU) updates, purpose kept through connecting, wiring saved without target I/O (memo records), edit, connection check, debug attach / halt / memory / detach, UART, GPIO, I2C, SPI, PWM, counter, I2C / SPI peers, the debug-wire console, passthrough apply and save, idle pins, settings and memo backup and restore, declarations, capture preparation, DAC and Wi-Fi (classic ESP32), hand-over and narrow screens passed.');
} finally {
  browserSocket?.close(); socket?.destroy(); if (waiting) waiting.end(); server?.closeAllConnections(); server?.close();
  for (const child of children) { child.stdin?.end(); child.kill(); }
  await delay(300); await rm(temp, { recursive: true, force: true }).catch(() => {});
}
