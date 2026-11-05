// @ts-check
// SPDX-License-Identifier: MIT
// Writing an RP2040 / RP2350 straight over USB: the boot ROM's PICOBOOT interface (what picotool speaks), on a WebUSB
// USBDevice (the browser's, or the `usb` package's WebUSB in Node). The probe gets to its boot ROM by a 1200 baud touch
// of its CDC port (rp2Bootsel in src/browser); the image is a .uf2 (checkUf2), written sector by sector, read back and
// compared, then the chip restarts into it. The flash past the image (the settings' LittleFS area) is left as it is.
import { checkUf2 } from './firmware.js';

export const RP2_BOOT_VID = 0x2e8a;
/** The boot ROM's USB product id by model. */
export const RP2_BOOT_PID = { rp2040: 0x0003, rp2350: 0x000f };

const MAGIC = 0x431fd10b;
const CMD = { exclusive: 0x01, reboot: 0x02, erase: 0x03, read: 0x84, write: 0x05, exitXip: 0x06, reboot2: 0x0a };
const SECTOR = 4096, PAGE = 256;
const FLASH_START = 0x10000000;
const UF2_ABSOLUTE = 0xe48bff57;
const IF_RESET = 0x41, IF_STATUS = 0x42;

/** The image a .uf2 holds, as flash sectors: Map(sector address -> 4096 bytes, 0xFF where the image has nothing).
 * Blocks of the absolute family (the RP2350-E10 work-around block) are not flash and are left out.
 * @param {Uint8Array} uf2 @returns {Map<number, Uint8Array>} */
export function uf2Sectors(uf2) {
  const v = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  /** @type {Map<number, Uint8Array>} */
  const sectors = new Map();
  for (let at = 0; at < uf2.length; at += 512) {
    const flags = v.getUint32(at + 8, true);
    if (flags & 0x2000 && v.getUint32(at + 28, true) === UF2_ABSOLUTE) continue;
    if (flags & 0x1) continue;                                  // "not main flash"
    const addr = v.getUint32(at + 12, true), size = v.getUint32(at + 16, true);
    if (addr < FLASH_START || size > 476) throw new Error(`UF2 block at 0x${addr.toString(16)}: not flash`);
    for (let k = 0; k < size; k++) {
      const a = addr + k, base = a - (a % SECTOR);
      let s = sectors.get(base);
      if (!s) { s = new Uint8Array(SECTOR).fill(0xff); sectors.set(base, s); }
      s[a - base] = uf2[at + 32 + k];
    }
  }
  return new Map([...sectors.entries()].sort((a, b) => a[0] - b[0]));
}

export class PicobootError extends Error {}

/** PICOBOOT on a claimed interface (RP2040 datasheet §2.8.5, RP2350 datasheet §5.6). */
export class Picoboot {
  /** @param {any} device a USBDevice, opened @param {number} intf @param {number} epOut @param {number} epIn */
  constructor(device, intf, epOut, epIn) {
    this.device = device; this.intf = intf; this.epOut = epOut; this.epIn = epIn; this.token = 1;
  }

  /** Open the device and claim its PICOBOOT interface (vendor class 0xFF with one bulk IN and one bulk OUT).
   * @param {any} device @returns {Promise<Picoboot>} */
  static async open(device) {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    for (const i of device.configuration.interfaces) {
      const alt = i.alternates[0];
      if (alt.interfaceClass !== 0xff) continue;
      const out = alt.endpoints.find((/** @type {any} */ e) => e.type === 'bulk' && e.direction === 'out');
      const inn = alt.endpoints.find((/** @type {any} */ e) => e.type === 'bulk' && e.direction === 'in');
      if (!out || !inn) continue;
      await device.claimInterface(i.interfaceNumber);
      const pb = new Picoboot(device, i.interfaceNumber, out.endpointNumber, inn.endpointNumber);
      await pb.resetInterface();
      return pb;
    }
    throw new PicobootError('no PICOBOOT interface: is the chip in its boot ROM (BOOTSEL)?');
  }

  async resetInterface() {
    await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: IF_RESET, value: 0, index: this.intf }, new Uint8Array(0));
  }

  /** The last command's status (16 bytes: token, status code, command id, in progress). */
  async status() {
    const r = await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'interface', request: IF_STATUS, value: 0, index: this.intf }, 16);
    const v = r.data;
    return { token: v.getUint32(0, true), code: v.getUint32(4, true), cmd: v.getUint8(8), inProgress: v.getUint8(9) };
  }

  /** One command: its 32 bytes, then the data out (or in), then the handshake the other way.
   * @param {number} id @param {Uint8Array} args @param {{ out?: Uint8Array, inLength?: number }} [data] */
  async command(id, args, { out, inLength = 0 } = {}) {
    const length = out ? out.length : inLength;
    const c = new DataView(new ArrayBuffer(32));
    c.setUint32(0, MAGIC, true);
    c.setUint32(4, this.token++, true);
    c.setUint8(8, id);
    c.setUint8(9, args.length);
    c.setUint32(12, length, true);
    new Uint8Array(c.buffer).set(args, 16);
    const sent = await this.device.transferOut(this.epOut, c.buffer);
    if (sent.status !== 'ok') throw new PicobootError(`command 0x${id.toString(16)}: ${sent.status}`);
    let got = new Uint8Array();
    if (id & 0x80) {
      const r = await this.device.transferIn(this.epIn, length);
      if (r.status !== 'ok') throw new PicobootError(`command 0x${id.toString(16)}: ${r.status}`);
      got = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      await this.device.transferOut(this.epOut, new ArrayBuffer(0));   // the handshake
    } else {
      if (out) {
        const w = await this.device.transferOut(this.epOut, out);
        if (w.status !== 'ok') throw new PicobootError(`command 0x${id.toString(16)} data: ${w.status}`);
      }
      const ack = await this.device.transferIn(this.epIn, 1);           // the handshake: a zero-length packet
      if (ack.status !== 'ok') {
        const s = await this.status().catch(() => null);
        throw new PicobootError(`command 0x${id.toString(16)}: ${ack.status}${s ? `, status ${s.code}` : ''}`);
      }
    }
    return got;
  }

  /** @param {number[]} words */
  static args(...words) {
    const v = new DataView(new ArrayBuffer(words.length * 4));
    words.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
    return new Uint8Array(v.buffer);
  }

  exclusive() { return this.command(CMD.exclusive, Uint8Array.of(1)); }
  exitXip() { return this.command(CMD.exitXip, new Uint8Array()); }
  /** @param {number} addr @param {number} size */
  erase(addr, size) { return this.command(CMD.erase, Picoboot.args(addr, size)); }
  /** @param {number} addr @param {Uint8Array} data */
  write(addr, data) { return this.command(CMD.write, Picoboot.args(addr, data.length), { out: data }); }
  /** @param {number} addr @param {number} size */
  read(addr, size) { return this.command(CMD.read, Picoboot.args(addr, size), { inLength: size }); }

  /** Restart into the flash: REBOOT on an RP2040, REBOOT2 (normal boot) on an RP2350. The device leaves the bus.
   * @param {string} model */
  async reboot(model) {
    try {
      if (model === 'rp2350') await this.command(CMD.reboot2, Picoboot.args(0, 500, 0, 0));
      else await this.command(CMD.reboot, Picoboot.args(0, 0, 500));
    } catch { /* it may go before the handshake */ }
  }
}

const RESET_SUBCLASS = 0x00, RESET_PROTOCOL = 0x01, RESET_REQUEST_BOOTSEL = 0x01;

/** The pico-sdk reset interface of a running RP2 device (vendor class, subclass 0, protocol 1), or null.
 * @param {any} device @returns {number | null} */
export function rp2ResetInterface(device) {
  for (const c of device.configurations ?? (device.configuration ? [device.configuration] : [])) {
    for (const i of c.interfaces) {
      const a = i.alternates[0];
      if (a.interfaceClass === 0xff && a.interfaceSubclass === RESET_SUBCLASS && a.interfaceProtocol === RESET_PROTOCOL) return i.interfaceNumber;
    }
  }
  return null;
}

/** Restart a running RP2 probe into its boot ROM through its reset interface (the RP2 firmware's; what picotool
 * reboot -f does): no 1200 baud touch, no button. The device leaves the bus. -> false when it has no such interface.
 * @param {any} device a WebUSB USBDevice of the running probe */
export async function rp2ResetToBoot(device) {
  const intf = rp2ResetInterface(device);
  if (intf === null) return false;
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  await device.claimInterface(intf);
  try {
    await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: RESET_REQUEST_BOOTSEL, value: 0, index: intf }, new Uint8Array(0));
  } catch { /* it may go before the status stage */ }
  try { await device.close(); } catch { /* gone */ }
  return true;
}

/** @typedef {{ phase: 'erase-write' | 'verify' | 'reboot', done: number, total: number }} Rp2Progress */

/**
 * Write a .uf2 into an RP2040 / RP2350 in its boot ROM over PICOBOOT: check the image for the model (checkUf2), take
 * the interface, then per sector erase, write and read back, then restart into it.
 * @param {any} device a WebUSB USBDevice of the boot ROM (RP2_BOOT_VID / RP2_BOOT_PID)
 * @param {Uint8Array} uf2 @param {{ model: 'rp2040' | 'rp2350', onProgress?: (p: Rp2Progress) => void }} opts
 */
export async function rp2Write(device, uf2, { model, onProgress }) {
  if (device.vendorId !== RP2_BOOT_VID || device.productId !== RP2_BOOT_PID[model]) {
    throw new PicobootError(`not an ${model} in its boot ROM (${device.vendorId?.toString(16)}:${device.productId?.toString(16)})`);
  }
  checkUf2(uf2, { model });
  const sectors = uf2Sectors(uf2);
  const pb = await Picoboot.open(device);
  try {
    await pb.exclusive();
    await pb.exitXip();
    let done = 0;
    for (const [addr, data] of sectors) {
      await pb.erase(addr, SECTOR);
      for (let at = 0; at < SECTOR; at += PAGE * 4) await pb.write(addr + at, data.subarray(at, at + PAGE * 4));
      const back = await pb.read(addr, SECTOR);
      if (back.length !== SECTOR || back.some((b, i) => b !== data[i])) {
        throw new PicobootError(`sector 0x${addr.toString(16)}: what was read back differs from what was written`);
      }
      onProgress?.({ phase: 'erase-write', done: ++done, total: sectors.size });
    }
    onProgress?.({ phase: 'reboot', done, total: sectors.size });
    await pb.reboot(model);
    return { sectors: sectors.size };
  } finally {
    try { await device.close(); } catch { /* restarted */ }
  }
}
