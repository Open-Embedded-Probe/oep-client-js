// @ts-nocheck
// A real probe over Linux hidraw through the page's own WebHID transport (src/browser/webhid.js): a WebHID-shaped
// device on /dev/hidrawN, then connect, describe, list, dump, settings, a session, and a burst of pipelined requests.
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
const root = new URL('../src/', import.meta.url).href;
const { webHidTransport } = await import(root + 'browser/webhid.js');
const { connect } = await import(root + 'open.js');
const core = await import(root + 'core.js');
const dump = await import(root + 'dump.js');
const settings = await import(root + 'settings.js');
const m = await import(root + 'message.js');
// Usage (Linux, a probe on hidraw): node scripts/check-hid.mjs /dev/hidrawN
// The OEP collection's report ID and size are read from the node's report descriptor in sysfs (usage page 0xFF4F,
// usage 0x45; one Input and one Output of 8-bit items, as the reference firmware declares).
const node = process.argv[2];
if (!node) { console.error('usage: node scripts/check-hid.mjs /dev/hidrawN'); process.exit(2); }
const desc = await (await import('node:fs/promises')).readFile(`/sys/class/hidraw/${node.split('/').pop()}/device/report_descriptor`);
let id = 0, count = 0;
for (let i = 0; i < desc.length;) {
  const prefix = desc[i], n = [0, 1, 2, 4][prefix & 3], v = n ? desc.readUIntLE(i + 1, n) : 0;
  if ((prefix & 0xfc) === 0x84) id = v;          // Report ID
  if ((prefix & 0xfc) === 0x94) count = v;       // Report Count (8-bit items)
  i += 1 + n;
}
const size = count;
const fh = await open(node, 'r+');
const listeners = new Set();
const items = [{ reportSize: 8, reportCount: size }];
const device = {
  vendorId: 0x1209, productId: 0x4f45, opened: true,
  collections: [{ usagePage: 0xff4f, usage: 0x45, inputReports: [{ reportId: id, items }], outputReports: [{ reportId: id, items }] }],
  async open() {}, async close() { rs.destroy(); await fh.close().catch(() => {}); },
  async sendReport(rid, data) { const b = Buffer.alloc(1 + data.length); b[0] = rid; b.set(data, 1); await fh.write(b); },
  addEventListener(_t, l) { listeners.add(l); }, removeEventListener(_t, l) { listeners.delete(l); },
};
const rs = createReadStream(null, { fd: fh.fd, highWaterMark: 4096, autoClose: false });
// hidraw: a descriptor with a report ID puts it first in every read; without one (ID 0) the read is the report alone
rs.on('data', (chunk) => { const skip = id ? 1 : 0; if (id && chunk[0] !== id) return; const data = new DataView(chunk.buffer, chunk.byteOffset + skip, chunk.length - skip); for (const l of listeners) l({ reportId: id, data }); });
rs.on('error', () => {});
const t0 = performance.now();
const transport = await webHidTransport(device);
const hst = await connect(transport, { timeoutMs: 3000, keepSession: false });
const lim = await hst.confirmed();
console.log('confirm', { maxFrame: lim.maxFrame, transport: lim.transport, ms: Math.round(performance.now() - t0) });
const info = await core.probeInfo(hst);
console.log('describe fn0', { unitId: info.unitId, model: info.model, firmware: info.firmware });
const caps = await dump.collect(hst);
console.log('list+describe', caps.offers.length, 'interfaces; dump text', dump.toText(caps).length, 'chars');
const st = new settings.Settings(hst); const got = await st.get(); const rows = await st.show(); console.log('settings get', got.values.length, 'raw values, generation', got.generation, '; labels', (await settings.labels(hst)).length);
console.log('settings', rows.length, 'values');
await core.take(hst, 5000, { owner: 'oep-client-js HID check' });
const t1 = performance.now(); let n = 0;
for (let round = 0; round < 20; round++) {
  const reqs = Array.from({ length: 8 }, () => [m.CORE_FN, m.OP.describe, Uint8Array.of(0, 0, 0, 0)]);
  const answers = await hst.pipeline(reqs); n += answers.length;
  if (answers.some((a) => !a.succeeded)) throw new Error('a describe failed');
}
console.log('pipelined describes', n, 'in', Math.round(performance.now() - t1), 'ms');
await hst.end();
console.log('link', hst.link.stats, 'reports lost or broken', transport.reader.losses);
await hst.link.close();
