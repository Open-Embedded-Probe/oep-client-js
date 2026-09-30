// @ts-check
// Hosts on Node's transports, confirmed and ready.
import { connect } from '../open.js';
import { tcpTransport } from './tcp.js';
import { serialTransport } from './serial.js';
import { usbTransport } from './usb.js';

/** @param {{ host?: string, port: number, framing?: 'length' | 'cobs', timeoutMs?: number }} opts */
export async function openTcp(opts) { return connect(await tcpTransport(opts), { timeoutMs: opts.timeoutMs }); }

/** @param {{ path: string, baudRate?: number, timeoutMs?: number }} opts */
export async function openSerial(opts) { return connect(await serialTransport(opts), { timeoutMs: opts.timeoutMs }); }

/** @param {{ unitId?: string, vendorId?: number, productId?: number, timeoutMs?: number }} opts */
export async function openUsb(opts = {}) { return connect(await usbTransport(opts), { timeoutMs: opts.timeoutMs }); }
