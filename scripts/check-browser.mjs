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
  const flashManifest = { schema: 1, version: '0.0.47', firmware: [{ model: 'esp32', kind: 'merged', flash_offset: 0,
    file: 'test-esp32.merged.bin', example: 'Firmware/OepProbe', sha256: createHash('sha256').update(flashImage).digest('hex') }] };
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/firmware/firmware.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(flashManifest)); return; }
      if (path === '/firmware/test-esp32.merged.bin') { res.end(flashImage); return; }
      if (path === '/esp-loader.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`export class Transport { constructor(port){globalThis.__flashPort=port;} async disconnect(){globalThis.__flashClosed=true;} }
          export class ESPLoader { chip={CHIP_NAME:'ESP32'}; async main(){return 'ESP32 test ROM';}
            async writeFlash(o){globalThis.__flashWrite={address:o.fileArray[0].address,size:o.fileArray[0].data.length,eraseAll:o.eraseAll};o.reportProgress(0,o.fileArray[0].data.length,o.fileArray[0].data.length);}
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
          export const core={...lib.core,async planApply(...args){if(globalThis.__forbidTargetIO)throw Error('Unexpected pin assignment while registering');return lib.core.planApply(...args);}};
          export const dump={...lib.dump,async collect(h){const caps=await lib.dump.collect(h);if(globalThis.__withoutScan)for(const o of caps.offers)if(o.entry.name.startsWith('oep.wire.'))o.description.ops=new Set([lib.riscv.WireBase.ATTACH]);return caps;}};
          for(const [Class,method] of [[lib.riscv.WireBase,'scan'],[lib.riscv.Wire,'attach'],[lib.arm.SwdWire,'attach']]){const original=Class.prototype[method];Class.prototype[method]=function(...args){if(globalThis.__forbidTargetIO)throw Error('Unexpected '+method+' while registering');return original.apply(this,args);};}

          export async function getUsbProbes(){return [{productName:'OEP Probe',serialNumber:'fafe00000035'},{productName:'OEP Probe',serialNumber:'second-probe'}];}
          export async function openWebSerial(){const h=await openWebUsb();globalThis.__connectionMethod='serial';return h;}
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
  const heading = () => evaluate('document.querySelector("#screen h1")?.textContent');
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base });
  await until('[...document.querySelectorAll("#screen a")].some(a=>a.hash==="#firmware")'); await snapshot('01-start');
  assert.deepEqual(await evaluate('(async()=>{const m=await import("/esp-loader-real.js");return [typeof m.ESPLoader,typeof m.Transport]})()'), ['function','function']);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#screen .button")).minHeight'), '50px');
  for (const hash of ['connect', 'probe', 'targets', 'target/new', 'signals/pwm', 'debug', 'tools', 'settings', 'storage', 'firmware', 'diagnostics', 'help', 'details', 'try', 'unknown']) {
    await route(hash); assert.ok(await heading(), hash); assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, hash);
  }
  await route('home');
  assert.equal(await evaluate('document.querySelectorAll("#screen button").length'), 0, 'the first screen does not ask users to choose a transport');
  assert.equal(await evaluate('document.querySelector("#screen .button").hash'), '#firmware', 'fresh installation is the primary action');
  await evaluate('document.querySelector("#screen .button").click()'); await delay(100);
  assert.match(await heading(), /Install OEP/);
  await evaluate('Object.defineProperty(navigator.serial,"requestPort",{configurable:true,value:async()=>({testPort:true})})');
  await evaluate('document.querySelector("input[name=fw-board][value=esp32]").click()');
  await until('document.querySelector("#screen").textContent.includes("test-esp32.merged.bin")');
  await click('Select serial programming port'); await succeeded();
  await click('Write OEP firmware'); await succeeded();
  assert.deepEqual(await evaluate('globalThis.__flashWrite'), { address: 0, size: flashImage.length, eraseAll: false });
  assert.equal(await evaluate('globalThis.__flashClosed'), true);
  assert.equal(await evaluate('globalThis.__flashReset'), 'hard_reset');
  assert.equal(await evaluate('location.hash'), '#firmware', 'stay on installation until the user reconnects');
  assert.match(await evaluate('document.getElementById("fw-status").textContent'), /Written/);
  await snapshot('01c-initial-install');
  await evaluate('[...document.querySelectorAll("#screen a")].find(a=>a.textContent==="Connect and check the version").click()'); await delay(100);
  assert.equal(await evaluate('document.querySelector("input[name=connect-board]")'), null, 'no board selection after flashing');
  await click('Select device and connect'); await succeeded();
  assert.equal(await evaluate('globalThis.__connectionMethod'),'serial','serial install leads directly to serial OEP connection');
  await click('Disconnect'); await succeeded();
  await send('Page.navigate', { url: base }); await until('document.querySelector("#screen .button")?.hash==="#firmware"');
  await route('settings');
  await evaluate('[...document.querySelectorAll("#screen a")].find(a=>a.hash==="#connect").click()'); await delay(100);
  assert.equal(await evaluate('document.querySelector("input[name=connect-board]")'), null, 'no board type question before connecting');
  assert.equal(await evaluate('document.getElementById("connect-selected").disabled'), false, 'device chooser works immediately');
  await snapshot('01b-probe-choices');
  await click('Select device and connect'); await succeeded(); assert.equal(await heading(), 'Settings', 'deep link resumes after connection');
  assert.match(await evaluate('document.getElementById("connection-bar").textContent'), /Read only/);
  await route('probe'); await snapshot('02-probe');
  await click('Enable changes'); await succeeded();
  await route('signals/gpio');
  await set('signal-4-pin-1', '0'); await click('Apply pin assignment'); await succeeded();
  await set('signal-4-set-channel', '0'); await set('signal-4-set-mode', '4'); await click('Set mode'); await succeeded();
  await set('signal-4-read-channel', '0'); await click('Read level'); await succeeded();
  assert.match(await evaluate('document.querySelector("#screen").textContent'), /1/);
  await click('Release pins'); await succeeded();
  await route('signals/pwm'); await set('signal-15-pin-0', '4'); await click('Apply pin assignment'); await succeeded();
  await click('Start output'); await succeeded(); assert.match(await evaluate('document.getElementById("screen").textContent'), /out0: GPIO4/); await snapshot('03-signals'); await click('Read status'); await succeeded(); await click('Stop output'); await succeeded(); await click('Release pins');
  await route('signals/uart'); await set('signal-5-pin-1', '4'); await set('signal-5-pin-2', '5'); await click('Apply pin assignment'); await succeeded();
  await click('Configure UART'); await succeeded(); await click('Receive'); await succeeded(); await set('signal-5-send-text', 'hello'); await click('Send'); await succeeded(); await click('Release pins');
  assert.equal(await evaluate('document.querySelectorAll("#signal-uart-instance input[type=radio]").length'),2,'multiple UARTs remain visible');
  await evaluate('[...document.querySelectorAll("input[name=signal-uart-instance]")].find(e=>e.value==="6").click()');
  assert.ok(await evaluate('document.getElementById("signal-6-pin-1")!==null'),'choosing a different hardware instance changes the controls');
  assert.match(await evaluate('document.getElementById("signal-uart-instance").textContent'),/3,000,000 Hz/);

  await route('signals/counter'); await set('signal-16-pin-0', '4'); await click('Apply pin assignment'); await succeeded(); await click('Measure'); await succeeded(); await click('Release pins');
  for (const [name, fn, configure] of [['i2c-controller',13,'Configure bus'],['spi-controller',14,'Configure bus'],['i2c-target',8,'Set address'],['spi-target',9,'Configure bus']]) {
    await route(`signals/${name}`);
    await evaluate(`{const used=new Set();for(const e of document.querySelectorAll('select[id^="signal-${fn}-pin-"]')){const candidate=[...e.options].find(o=>o.value!==''&&!used.has(o.value));if(candidate){e.value=candidate.value;used.add(candidate.value);e.dispatchEvent(new Event('change'));}}}`);
    await click('Apply pin assignment'); await succeeded(); await click(configure); await succeeded();
    if(name==='i2c-controller') {
      await set('signal-13-write-data','f'); await click('Write');
      assert.equal(await evaluate('document.getElementById("feedback").className'),'bad','bad byte rejected');
      await set('signal-13-write-data','01'); await click('Write');
      assert.match(await evaluate('document.getElementById("feedback").textContent'),/complete|I2C/);
      await click('Read'); assert.match(await evaluate('document.getElementById("feedback").textContent'),/complete|I2C/);
    }
    if(name==='spi-controller') { await click('Exchange bytes'); await succeeded(); }
    if(name==='i2c-target') { await click('Queue response'); await succeeded(); await click('Receive frame'); await succeeded(); }
    if(name==='spi-target') { await click('Arm transaction'); await succeeded(); await click('Receive transaction'); await succeeded(); }
    await click('Read status'); await succeeded(); await click('Release pins'); await succeeded();
  }
  await route('signals/dac'); assert.match(await evaluate('document.querySelector("#screen").textContent'),/does not declare/);
  await route('targets'); assert.match(await evaluate('document.querySelector("#screen").textContent'), /x035/);
  await route('debug');
  assert.equal(await evaluate('document.getElementById("debug-dio").options.length'), 1, 'fixed channel groups are usable');
  await click('Attach to target'); await succeeded(); await snapshot('04-debug'); await click('Halt'); await succeeded(); await click('Read register'); await succeeded();
  await set('debug-words', '4'); await click('Read memory'); await succeeded(); await click('Resume'); await succeeded(); await click('Open console'); await succeeded(); await click('Receive'); await succeeded(); await click('Close console'); await succeeded(); await click('Detach target'); await succeeded();
  await route('targets'); acceptDialog = false; await click('Remove registration'); await succeeded();
  assert.match(await evaluate('document.querySelector("#screen").textContent'), /x035/);
  assert.match(await evaluate('document.getElementById("feedback").textContent'), /cancelled/);
  acceptDialog = true; await click('Remove registration'); await succeeded();
  await click('Release changes'); await succeeded();
  // Known wiring can be registered without target I/O and without a scan capability.
  await evaluate('globalThis.__forbidTargetIO=true;globalThis.__withoutScan=true');
  await route('diagnostics'); await click('Read declarations'); await succeeded();
  await route('target/new');
  assert.equal(await evaluate('document.querySelector("input[name=registration-mode]:checked").value'),'fixed');
  const fixedPins = await evaluate('[...document.querySelectorAll("select[id^=registration-pin-]")].filter(e=>e.value!=="").map(e=>e.value)');
  await click('Review wiring'); await succeeded();
  assert.equal(await evaluate('[...document.querySelectorAll("#screen button")].find(b=>b.textContent==="Save connection").disabled'),true,'only saving needs change permission');
  await click('Enable changes'); await succeeded();
  await set('wizard-name','fixture'); await click('Save connection'); await succeeded();
  assert.match(await evaluate('document.querySelector("#screen").textContent'),/Registration is saved wiring/);
  await click('Load wiring into its tool'); await succeeded();
  assert.equal(await evaluate('document.getElementById("debug-dio").value'),fixedPins[0]);
  assert.equal(await evaluate('document.getElementById("debug-clk").value'),fixedPins[1]);
  assert.equal(await evaluate('document.querySelectorAll("#debug-control").length'),0);
  await route('targets'); await click('Remove registration'); await succeeded();
  await evaluate('[...document.querySelectorAll("#screen a")].find(a=>a.hash==="#target/new").click()'); await delay(80);
  // A UART connector is reusable independently of target discovery.
  await evaluate('[...document.querySelectorAll("#registration-function .choice-card")].find(e=>e.textContent.includes("UART")).querySelector("input").click()');
  await evaluate(`{const used=new Set();for(const e of document.querySelectorAll('select[id^="registration-pin-"]')){const o=[...e.options].find(o=>o.value!==''&&!used.has(o.value));if(o){e.value=o.value;used.add(o.value);e.dispatchEvent(new Event('change'));}}}`);
  const uartPins = await evaluate('[...document.querySelectorAll("select[id^=registration-pin-]")].map(e=>e.value)');
  await click('Review wiring'); await succeeded(); await set('wizard-name','serial-fixture'); await click('Save connection'); await succeeded();
  await snapshot('05a-fixed-wiring');
  await click('Load wiring into its tool'); await succeeded();
  assert.equal(await evaluate('location.hash'),'#signals/uart');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("select[id^=signal-]")].filter(e=>e.id.includes("-pin-")).map(e=>e.value)'),uartPins);
  await route('targets'); await click('Remove registration'); await succeeded();
  await evaluate('globalThis.__forbidTargetIO=false;globalThis.__withoutScan=false');
  await route('diagnostics'); await click('Read declarations'); await succeeded();
  await evaluate('location.hash="#targets"'); await delay(80);
  await evaluate('[...document.querySelectorAll("#screen a")].find(a=>a.hash==="#target/new").click()'); await delay(80);
  await evaluate('document.querySelector("input[name=registration-mode][value=scan]").click()');
  await evaluate(`for(const e of document.querySelectorAll('.pin-list input')){if(!e.disabled){e.checked=true;e.dispatchEvent(new Event('change'));}}`);
  await click('Continue to scan'); await click('Scan selected pins'); await succeeded(); await snapshot('05-connection');
  await click('Name this connection'); await set('wizard-name','test-target'); await click('Save connection'); await succeeded();
  assert.match(await evaluate('document.querySelector("#screen").textContent'), /test-target/);
  await route('targets'); assert.match(await evaluate('document.querySelector("#screen").textContent'), /test-target/);
  await route('settings'); await click('Read settings'); await succeeded(); await click('Save to probe'); await succeeded();
  await route('storage'); assert.match(await evaluate('document.querySelector("#screen").textContent'), /no supported memo/);
  await route('tools'); assert.match(await evaluate('document.querySelector("#screen").textContent'), /fafe00000035/);
  await route('target/new'); await click('Register another');
  await evaluate('document.querySelector("input[name=registration-mode][value=fixed]").click()');
  await snapshot('05b-fixed-pin-form');
  await set('language', 'ja'); await route('probe'); assert.equal(await heading(), 'プローブ'); await snapshot('06-probe-ja');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const hash of ['home', 'connect', 'probe', 'target/new', 'signals/spi-controller', 'debug', 'settings', 'firmware', 'help']) {
    await route(hash); assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `mobile ${hash}`);
  }
  await click('変更権を解放'); await succeeded();
  assert.match(await evaluate('document.getElementById("connection-bar").textContent'), /読み取り専用/);
  await click('切断'); await succeeded(); assert.match(await evaluate('document.getElementById("connection-bar").textContent'), /未接続/);
  // A second physical shape supplies the optional DAC; the first profile has none.
  benchPort = Number(await start(python, ['-m','oep_client.virtual_bench_serve','--tcp','0','--profile','esp32-v003'], /PORT (\d+)/));
  await set('language','en'); await route('connect'); await evaluate('document.querySelectorAll("#screen details")[1].open=true'); await click('Choose a serial port'); await succeeded(); await click('Enable changes'); await succeeded();
  assert.equal(await evaluate('globalThis.__connectionMethod'),'serial','the serial help connects without a board type question');
  await route('signals/dac'); await set('signal-14-pin-0','25'); await click('Apply pin assignment'); await succeeded();
  await click('Set output'); await succeeded(); await click('Read status'); await succeeded(); await click('Release pins'); await succeeded();
  await click('Disconnect'); await succeeded();
  // Optional UART writes must disappear when the device does not advertise them.
  benchPort = Number(await start(python, ['-m','oep_client.virtual_bench_serve','--tcp','0','--profile','p4-x035','--minimal-ops'], /PORT (\d+)/));
  await route('connect'); await click('Select device and connect'); await succeeded(); await route('signals/uart');
  assert.equal(await evaluate('[...document.querySelectorAll("#screen button")].some(b=>b.textContent==="Send" || b.textContent==="Send bytes")'),false);
  await click('Disconnect'); await succeeded();
  await route('connect'); await evaluate('document.querySelector("#screen details").open=true'); await click('Find allowed probes'); await succeeded();
  const devices=await evaluate('document.querySelector(".device-list").textContent');
  assert.match(devices,/fafe00000035/); assert.match(devices,/second-probe/);
  await click('Connect to this device'); await succeeded();
  assert.equal(await evaluate('globalThis.__selectedProbe'),'fafe00000035','the exact chosen device is passed to the transport');
  await click('Disconnect'); await succeeded();
  assert.deepEqual(exceptions, []);
  console.log('Browser workspace: board-free connect, fixed wiring without scan/attach, saved UART/debug wiring, ESP initial install, bundled ROM loader, navigation, deep-link connect, GPIO, PWM, UART, I2C/SPI peers and controllers, counter, DAC, debug and console, settings, capabilities, language, mobile and session cleanup passed.');
} finally {
  browserSocket?.close(); socket?.destroy(); if (waiting) waiting.end(); server?.closeAllConnections(); server?.close();
  for (const child of children) { child.stdin?.end(); child.kill(); }
  await delay(300); await rm(temp, { recursive: true, force: true }).catch(() => {});
}
