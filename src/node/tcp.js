// @ts-check
// TCP (oep-core §3.1: length(u16) message) - a local broker, or the tests' fake probe. `framing: 'cobs'` for a TCP
// that carries a serial port's bytes (oep-client-python's fake_serve --framing cobs).
import { connect } from 'node:net';

/**
 * @param {{ host?: string, port: number, framing?: 'length' | 'cobs', connectTimeoutMs?: number }} opts
 * @returns {Promise<import('../link.js').Transport>}
 */
export function tcpTransport({ host = '127.0.0.1', port, framing = 'length', connectTimeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    sock.setNoDelay(true);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`no TCP connection to ${host}:${port}`)); }, connectTimeoutMs);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve({
        framing,
        kind: 'tcp',
        write: (data) => new Promise((res, rej) => sock.write(data, (e) => (e ? rej(e) : res()))),
        start(onData, onClose) {
          sock.on('data', (chunk) => onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
          sock.on('close', () => onClose());
          sock.on('error', (e) => onClose(e));
        },
        close: () => new Promise((res) => { sock.end(() => res()); setTimeout(() => { sock.destroy(); res(); }, 200); }),
      });
    });
  });
}
