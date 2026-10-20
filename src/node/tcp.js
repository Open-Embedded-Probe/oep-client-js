// @ts-check
// TCP (transports §1: length(u16) message) - a local broker, or the tests' virtual bench. `framing: 'cobs'` for a TCP
// that carries a serial port's bytes (oep-client-python's virtual_bench_serve --framing cobs).
import { connect } from 'node:net';

/**
 * `baudRate` (tests only): a TCP that stands for a serial port this host opened (the virtual bench's --framing cobs) gets
 * a `setBaudRate` that only records the rate, so port_speed can be exercised against the virtual bench (whose line model,
 * --broken-rate, follows the probe's rate alone).
 * @param {{ host?: string, port: number, framing?: 'length' | 'cobs', connectTimeoutMs?: number, baudRate?: number }} opts
 * @returns {Promise<import('../link.js').Transport>}
 */
export function tcpTransport({ host = '127.0.0.1', port, framing = 'length', connectTimeoutMs = 3000, baudRate }) {
  /** One connection, open. @returns {Promise<import('node:net').Socket>} */
  const open = () => new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    sock.setNoDelay(true);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no TCP connection to ${host}:${port}`)); }, connectTimeoutMs);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
  });
  return open().then((first) => {
    let sock = first;
    /** @type {((chunk: Uint8Array) => void) | null} */ let deliver = null;
    /** @type {((error?: unknown) => void) | null} */ let closed = null;
    /** @param {import('node:net').Socket} s */
    const listen = (s) => {
      s.on('data', (chunk) => { if (s === sock && deliver) deliver(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)); });
      s.on('close', () => { if (s === sock && closed) closed(); });   // a socket left by reopen says nothing
      s.on('error', (e) => { if (s === sock && closed) closed(e); });
    };
    /** @param {import('node:net').Socket} s */
    const end = (s) => new Promise((res) => { s.end(() => res(undefined)); setTimeout(() => { s.destroy(); res(undefined); }, 200); });
    /** @type {import('../link.js').Transport} */
    const transport = {
      framing,
      kind: 'tcp',
      keepsBoundaries: true,   // a pause inside a frame is normal on TCP, never a lost boundary (transports §5)
      write: (data) => new Promise((res, rej) => sock.write(data, (e) => (e ? rej(e) : res()))),
      start(onData, onClose) {
        deliver = onData;
        closed = onClose;
        listen(sock);
      },
      close: () => end(sock),
      // transports §5: a connection whose framing broke is closed and opened again (the same callbacks)
      async reopen() {
        const old = sock;
        sock = await open();
        if (deliver) listen(sock);
        await end(old);
      },
    };
    if (baudRate !== undefined) {
      transport.baudRate = baudRate;
      transport.setBaudRate = async (rate) => { transport.baudRate = rate; };
    }
    return transport;
  });
}
