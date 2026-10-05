// @ts-check
// Hosts on Node's transports, confirmed and ready.
import { connect } from '../open.js';
import { tcpTransport } from './tcp.js';
import { findSerialProbes, serialTransport } from './serial.js';
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
 * With nothing given it is the device with the project's VID:PID (core §3.3); when no such device can be opened by
 * vendor bulk (a probe with only a CDC port, RP2040 / RP2350), the one serial port with that VID:PID is opened instead
 * (findSerialProbes; none or several: the USB error stands - name the port, openSerial), as oep-client-python's bare
 * `usb` target does.
 * @param {{ unitId?: string, vendorId?: number, productId?: number, timeoutMs?: number }} opts */
export async function openUsb(opts = {}) {
  let transport;
  try {
    transport = await usbTransport(opts);
  } catch (e) {
    if (opts.unitId != null || opts.vendorId != null || opts.productId != null) throw e;
    const ports = await findSerialProbes().catch(() => []);
    if (ports.length !== 1) throw e;
    return openSerial({ path: ports[0].path, timeoutMs: opts.timeoutMs });
  }
  return connect(transport, { timeoutMs: opts.timeoutMs, unitId: opts.unitId });
}
