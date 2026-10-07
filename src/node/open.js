// @ts-check
// Hosts on Node's transports, confirmed and ready.
import { connect } from '../open.js';
import { tcpTransport } from './tcp.js';
import { serialTransport } from './serial.js';
import { chooseProbe, describeProbe, findProbes, usbTransport } from './usb.js';
import { PROJECT_PID, PROJECT_VID, vendorTransport } from '../usbvendor.js';

/** `unitId`: describe must say this unit_id, else closed (UnitIdMismatch, transports §3).
 * @param {import('../open.js').SpeedOptions & { host?: string, port: number, framing?: 'length' | 'cobs', timeoutMs?: number, baudRate?: number, leaseMs?: number, owner?: string, unitId?: string, keepSession?: boolean | import('../keptsession.js').KeptStore }} opts */
export async function openTcp(opts) { return connect(await tcpTransport(opts), opts); }

/** portSpeed: the candidates to try once connected (port_speed, oep-if-link §3; true = the default 500000; the lock is
 * taken and kept, see connect), `flows` / `verify` for the full form, `record` for the record of passed / failed rates.
 * `unitId`: describe must say this unit_id, else closed (UnitIdMismatch, transports §3).
 * @param {import('../open.js').SpeedOptions & { path: string, baudRate?: number, timeoutMs?: number, leaseMs?: number, owner?: string, unitId?: string, keepSession?: boolean | import('../keptsession.js').KeptStore }} opts */
export async function openSerial(opts) { return connect(await serialTransport(opts), opts); }

/** A Host on a USB device's vendor bulk interface. `unitId`: the device whose USB serial it is (no other check), and
 * fn 0's describe must then say the same unit_id (else closed, UnitIdMismatch). Probed with a confirm first (connect).
 * With nothing given it looks at every device with the project's VID:PID (transports §3; findProbes, one device counted
 * once whatever ways in it has; `probes`: that list, if already made): exactly one -> it is opened, by vendor bulk,
 * else its CDC port (one; several: name it); several -> SeveralProbesError listing each (unit id, ways in), nothing
 * opened - name one (`unitId`, or openSerial with its port); none -> the USB error. As oep-client-python's bare `usb`.
 * `keepSession`: as connect's (default true).
 * @param {{ unitId?: string, vendorId?: number, productId?: number, timeoutMs?: number, probes?: import('./usb.js').UsbProbe[],
 *   keepSession?: boolean | import('../keptsession.js').KeptStore }} opts */
export async function openUsb(opts = {}) {
  const { probes, keepSession, ...rest } = opts;
  if (opts.unitId != null || opts.vendorId != null || opts.productId != null) {
    return connect(await usbTransport(rest), { timeoutMs: opts.timeoutMs, unitId: opts.unitId, keepSession });
  }
  const one = chooseProbe(probes ?? await findProbes());
  if (!one) return connect(await usbTransport(rest), { timeoutMs: opts.timeoutMs, keepSession });   // the "no device" error
  if (one.device && one.ways.includes('vendor')) {
    let transport = null;
    try {
      transport = await vendorTransport(one.device);
    } catch (e) {
      if (!one.ports.length) throw e;                      // not openable by vendor bulk (access, busy): its CDC port
    }
    if (transport) return connect(transport, { timeoutMs: opts.timeoutMs, keepSession });
  }
  const where = `the probe on ${hex(PROJECT_VID)}:${hex(PROJECT_PID)} (${describeProbe(one)})`;
  if (one.ports.length > 1) throw new Error(`${where} has ${one.ports.length} serial ports: name one (openSerial({ path }))`);
  if (!one.ports.length) throw new Error(`${where} has no way in this host opens (vendor bulk or a serial port)`);
  return openSerial({ path: one.ports[0], timeoutMs: opts.timeoutMs, keepSession });
}

/** @param {number} n */
const hex = (n) => n.toString(16).padStart(4, '0');
