// @ts-check
// Hosts on Node's transports, confirmed and ready.
import { connect } from '../open.js';
import { tcpTransport } from './tcp.js';
import { serialTransport } from './serial.js';
import { usbTransport } from './usb.js';

/** `unitId`: describe must say this unit_id, else closed (UnitIdMismatch, core §3.3).
 * @param {import('../open.js').SpeedOptions & { host?: string, port: number, framing?: 'length' | 'cobs', timeoutMs?: number, baudRate?: number, leaseMs?: number, owner?: string, unitId?: string }} opts */
export async function openTcp(opts) { return connect(await tcpTransport(opts), opts); }

/** portSpeed: the candidates to try once connected (port_speed, oep-core §3.5; true = the default 500000; the lock is
 * taken and kept, see connect), `flows` / `verify` for the full form, `record` for the record of passed / failed rates.
 * `unitId`: describe must say this unit_id, else closed (UnitIdMismatch, core §3.3).
 * @param {import('../open.js').SpeedOptions & { path: string, baudRate?: number, timeoutMs?: number, leaseMs?: number, owner?: string, unitId?: string }} opts */
export async function openSerial(opts) { return connect(await serialTransport(opts), opts); }

/** A Host on a USB device's vendor bulk interface. `unitId`: the device whose USB serial it is (no other check), and
 * fn 0's describe must then say the same unit_id (else closed, UnitIdMismatch). Probed with a confirm first (connect).
 * @param {{ unitId?: string, vendorId?: number, productId?: number, timeoutMs?: number }} opts */
export async function openUsb(opts = {}) {
  return connect(await usbTransport(opts), { timeoutMs: opts.timeoutMs, unitId: opts.unitId });
}
