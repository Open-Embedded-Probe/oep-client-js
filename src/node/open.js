// @ts-check
// A host on Node's TCP transport, confirmed and ready.
import { connect } from '../open.js';
import { tcpTransport } from './tcp.js';

/** A probe over TCP: `{ host, port }` (host default 127.0.0.1; no port is fixed, transports §3). `unitId`: describe
 * must say this unit_id, else closed (UnitIdMismatch, transports §3). `keepSession`: as connect's (default true).
 * @param {{ host?: string, port: number, framing?: 'length' | 'cobs', timeoutMs?: number, unitId?: string,
 *   keepSession?: boolean | import('../keptsession.js').KeptStore }} opts */
export async function openTcp(opts) {
  return connect(await tcpTransport(opts), opts);
}
