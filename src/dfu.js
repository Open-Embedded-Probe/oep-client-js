// @ts-check
// A USB DFU 1.1 download client (outside OEP): how the ESP32-P4 probe takes a new firmware over its HS port.
// The probe's DFU interface (EspUsbDeviceDfu, Download mode) is class 0xFE subclass 0x01 on EP0 only: blocks of
// wTransferSize go with DNLOAD, each followed by GETSTATUS until the device is idle again (waiting bwPollTimeout
// while it is busy); a zero-length DNLOAD starts the manifestation (verify, move the boot partition, restart).
// Failures are DFU status codes (errWRITE 3 on the first block for a file that is not an app image, errVERIFY 7 at
// the manifestation); CLRSTATUS / ABORT bring the device back to dfuIDLE.
//
// Environment-free: it runs on anything with WebUSB's controlTransferIn / controlTransferOut (a browser's USBDevice,
// the `usb` package's WebUSBDevice in Node, a test's mock).

import { openDevice } from './usbvendor.js';

/** @typedef {import('./usbtypes.js').UsbControl} UsbControl */
/** @typedef {import('./usbtypes.js').UsbDevice} UsbDevice */

export const DFU_CLASS = 0xfe;
export const DFU_SUBCLASS = 0x01;
export const DFU_PROTOCOL_RUNTIME = 0x01;
export const DFU_PROTOCOL_DFU = 0x02;

export const DFU_REQUEST = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };

export const DFU_STATE = {
  appIDLE: 0, appDETACH: 1, dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7, dfuMANIFEST_WAIT_RESET: 8, dfuUPLOAD_IDLE: 9, dfuERROR: 10,
};

export const DFU_STATUS = {
  OK: 0x00, errTARGET: 0x01, errFILE: 0x02, errWRITE: 0x03, errERASE: 0x04, errCHECK_ERASED: 0x05, errPROG: 0x06,
  errVERIFY: 0x07, errADDRESS: 0x08, errNOTDONE: 0x09, errFIRMWARE: 0x0a, errVENDOR: 0x0b, errUSBR: 0x0c,
  errPOR: 0x0d, errUNKNOWN: 0x0e, errSTALLEDPKT: 0x0f,
};

/** Functional descriptor bmAttributes bits. */
export const DFU_ATTR = { canDnload: 0x01, canUpload: 0x02, manifestationTolerant: 0x04, willDetach: 0x08 };

const STATUS_NAMES = Object.fromEntries(Object.entries(DFU_STATUS).map(([k, v]) => [v, k]));
const STATE_NAMES = Object.fromEntries(Object.entries(DFU_STATE).map(([k, v]) => [v, k]));
/** @param {number} status */ export const dfuStatusName = (status) => STATUS_NAMES[status] ?? `status 0x${status.toString(16)}`;
/** @param {number} state */ export const dfuStateName = (state) => STATE_NAMES[state] ?? `state ${state}`;

/** A DFU request that did not work: `status` is the device's DFU status code (null when it did not say). */
export class DfuError extends Error {
  /** @param {string} message @param {{ status?: number | null, state?: number | null, block?: number | null }} [info] */
  constructor(message, { status = null, state = null, block = null } = {}) {
    super(message);
    this.name = 'DfuError';
    this.status = status;
    this.state = state;
    this.block = block;
  }
  get statusName() { return this.status == null ? null : dfuStatusName(this.status); }
}

// ---- descriptors ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ attributes: number, detachTimeout: number, transferSize: number, bcdDFU: number }} DfuFunctional
 * @typedef {{ number: number, alternate: number, class: number, subclass: number, protocol: number, iInterface: number,
 *   dfu?: DfuFunctional }} DescInterface
 */

/**
 * The interfaces of a configuration descriptor (with a DFU interface's functional descriptor attached).
 * @param {Uint8Array} desc
 * @returns {DescInterface[]}
 */
export function parseConfigDescriptor(desc) {
  /** @type {DescInterface[]} */
  const out = [];
  /** @type {DescInterface | null} */
  let cur = null;
  for (let i = 0; i + 2 <= desc.length;) {
    const len = desc[i];
    const type = desc[i + 1];
    if (len < 2 || i + len > desc.length) break;
    if (type === 0x04 && len >= 9) {
      cur = { number: desc[i + 2], alternate: desc[i + 3], class: desc[i + 5], subclass: desc[i + 6], protocol: desc[i + 7], iInterface: desc[i + 8] };
      out.push(cur);
    } else if (type === 0x21 && cur && cur.class === DFU_CLASS && cur.subclass === DFU_SUBCLASS && len >= 7) {
      cur.dfu = {
        attributes: desc[i + 2],
        detachTimeout: desc[i + 3] | (desc[i + 4] << 8),
        transferSize: desc[i + 5] | (desc[i + 6] << 8),
        bcdDFU: len >= 9 ? desc[i + 7] | (desc[i + 8] << 8) : 0x0100,
      };
    }
    i += len;
  }
  return out;
}

/**
 * The configuration descriptor, read with GET_DESCRIPTOR (WebUSB does not expose class-specific descriptors).
 * @param {UsbControl} ctl @param {number} [index]
 */
export async function readConfigDescriptor(ctl, index = 0) {
  /** @param {number} length */
  const get = async (length) => {
    const r = await ctl.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x0200 | index, index: 0 }, length);
    if (r.status !== 'ok' || !r.data) throw new DfuError(`GET_DESCRIPTOR (configuration): ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice();
  };
  const head = await get(9);
  const total = head.length >= 4 ? head[2] | (head[3] << 8) : 9;
  return total > head.length ? get(total) : head;
}

/**
 * The DFU interface of a WebUSB configuration (class 0xFE subclass 0x01; DFU mode first, then runtime).
 * @param {import('./usbtypes.js').UsbConfiguration | null | undefined} configuration
 * @returns {{ interfaceNumber: number, alternateSetting: number, protocol: number, name: string | null } | null}
 */
export function findDfuInterface(configuration) {
  /** @type {{ interfaceNumber: number, alternateSetting: number, protocol: number, name: string | null }[]} */
  const found = [];
  for (const intf of configuration?.interfaces ?? []) {
    for (const alt of intf.alternates ?? (intf.alternate ? [intf.alternate] : [])) {
      if (alt.interfaceClass === DFU_CLASS && alt.interfaceSubclass === DFU_SUBCLASS) {
        found.push({ interfaceNumber: intf.interfaceNumber, alternateSetting: alt.alternateSetting, protocol: alt.interfaceProtocol, name: alt.interfaceName ?? null });
      }
    }
  }
  return found.find((f) => f.protocol === DFU_PROTOCOL_DFU) ?? found[0] ?? null;
}

// ---- the client ----------------------------------------------------------------------------------------------

/** @typedef {{ status: number, pollTimeout: number, state: number, iString: number }} DfuStatus */

/**
 * @typedef {object} DfuProgress
 * @property {'download' | 'manifest'} phase
 * @property {number} written  bytes the device has taken
 * @property {number} total
 * @property {number} block    the block number just sent
 */

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DfuClient {
  /**
   * @param {UsbControl} ctl
   * @param {{ interfaceNumber: number, transferSize?: number, attributes?: number,
   *   sleep?: (ms: number) => Promise<void>, manifestTimeoutMs?: number, busyTimeoutMs?: number }} opts
   */
  constructor(ctl, { interfaceNumber, transferSize = 1024, attributes = DFU_ATTR.canDnload, sleep = defaultSleep, manifestTimeoutMs = 60000, busyTimeoutMs = 20000 }) {
    this.ctl = ctl;
    this.interfaceNumber = interfaceNumber;
    this.transferSize = transferSize;
    this.attributes = attributes;
    this.sleep = sleep;
    this.manifestTimeoutMs = manifestTimeoutMs;
    this.busyTimeoutMs = busyTimeoutMs;
  }

  get manifestationTolerant() { return (this.attributes & DFU_ATTR.manifestationTolerant) !== 0; }

  /** @param {number} request @param {number} [value] */
  setup(request, value = 0) {
    return /** @type {import('./usbtypes.js').UsbControlSetup} */ ({ requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber });
  }

  /** @returns {Promise<DfuStatus>} */
  async getStatus() {
    const r = await this.ctl.controlTransferIn(this.setup(DFU_REQUEST.GETSTATUS), 6);
    if (r.status !== 'ok' || !r.data || r.data.byteLength < 6) throw new DfuError(`GETSTATUS: ${r.status}`);
    const d = r.data;
    return { status: d.getUint8(0), pollTimeout: d.getUint8(1) | (d.getUint8(2) << 8) | (d.getUint8(3) << 16), state: d.getUint8(4), iString: d.getUint8(5) };
  }

  async getState() {
    const r = await this.ctl.controlTransferIn(this.setup(DFU_REQUEST.GETSTATE), 1);
    if (r.status !== 'ok' || !r.data || r.data.byteLength < 1) throw new DfuError(`GETSTATE: ${r.status}`);
    return r.data.getUint8(0);
  }

  async clearStatus() { await this.out(DFU_REQUEST.CLRSTATUS, 0, new Uint8Array(0), 'CLRSTATUS'); }
  async abort() { await this.out(DFU_REQUEST.ABORT, 0, new Uint8Array(0), 'ABORT'); }

  /** @param {number} request @param {number} value @param {Uint8Array} data @param {string} what */
  async out(request, value, data, what) {
    const r = await this.ctl.controlTransferOut(this.setup(request, value), data);
    if (r.status !== 'ok') throw new DfuError(`${what}: ${r.status}`);
  }

  /**
   * DNLOAD one block; a stall is answered with the device's status (GETSTATUS says why).
   * @param {number} block @param {Uint8Array} data
   */
  async dnload(block, data) {
    const r = await this.ctl.controlTransferOut(this.setup(DFU_REQUEST.DNLOAD, block & 0xffff), data);
    if (r.status === 'ok') return;
    const s = await this.getStatus().catch(() => null);
    const why = s && s.status !== DFU_STATUS.OK ? dfuStatusName(s.status) : r.status;
    throw new DfuError(`DNLOAD block ${block}: ${why}`, { status: s?.status ?? null, state: s?.state ?? null, block });
  }

  /** Bring the device to dfuIDLE: CLRSTATUS from dfuERROR, ABORT from a download or upload left open. */
  async toIdle() {
    let s = await this.getStatus();
    if (s.state === DFU_STATE.appIDLE || s.state === DFU_STATE.appDETACH) {
      throw new DfuError('the device is in DFU runtime mode (DETACH it into DFU mode first)', { state: s.state });
    }
    if (s.state === DFU_STATE.dfuERROR) {
      await this.clearStatus();
      s = await this.getStatus();
    }
    if (s.state !== DFU_STATE.dfuIDLE) {
      await this.abort();
      s = await this.getStatus();
    }
    if (s.state !== DFU_STATE.dfuIDLE) throw new DfuError(`the device does not go idle (${dfuStateName(s.state)})`, { status: s.status, state: s.state });
    return s;
  }

  /** After a failure: leave the device idle for the next try (best effort). */
  async recover() {
    try {
      const s = await this.getStatus();
      if (s.state === DFU_STATE.dfuERROR) await this.clearStatus();
      else if (s.state !== DFU_STATE.dfuIDLE && s.state !== DFU_STATE.dfuMANIFEST_WAIT_RESET) await this.abort();
    } catch { /* the device may be gone */ }
  }

  /**
   * GETSTATUS until the block is taken (dfuDNLOAD_IDLE), waiting bwPollTimeout while the device is busy.
   * @param {number} block
   */
  async waitBlock(block) {
    let waited = 0;
    for (;;) {
      const s = await this.getStatus();
      if (s.status !== DFU_STATUS.OK || s.state === DFU_STATE.dfuERROR) {
        throw new DfuError(`block ${block}: ${dfuStatusName(s.status)}`, { status: s.status, state: s.state, block });
      }
      if (s.state === DFU_STATE.dfuDNLOAD_IDLE) return s;
      if (s.state !== DFU_STATE.dfuDNBUSY && s.state !== DFU_STATE.dfuDNLOAD_SYNC) {
        throw new DfuError(`block ${block}: unexpected ${dfuStateName(s.state)}`, { status: s.status, state: s.state, block });
      }
      if (waited > this.busyTimeoutMs) throw new DfuError(`block ${block}: the device stays busy`, { state: s.state, block });
      const wait = Math.max(s.pollTimeout, 1);
      waited += wait;
      await this.sleep(wait);
    }
  }

  /**
   * After the zero-length DNLOAD: GETSTATUS through dfuMANIFEST-SYNC / dfuMANIFEST until dfuMANIFEST-WAIT-RESET
   * (manifestation-intolerant: the device restarts) or dfuIDLE (tolerant). A device that goes away once it has said
   * dfuMANIFEST (intolerant) is taken as restarted, with `confirmed` false.
   * @param {number} block
   */
  async waitManifest(block) {
    let waited = 0;
    let sawManifest = false;
    for (;;) {
      let s;
      try {
        s = await this.getStatus();
      } catch (e) {
        if (sawManifest && !this.manifestationTolerant) return { state: DFU_STATE.dfuMANIFEST, confirmed: false };
        throw e;
      }
      if (s.status !== DFU_STATUS.OK || s.state === DFU_STATE.dfuERROR) {
        throw new DfuError(`manifestation: ${dfuStatusName(s.status)}`, { status: s.status, state: s.state, block });
      }
      if (s.state === DFU_STATE.dfuMANIFEST_WAIT_RESET || s.state === DFU_STATE.dfuIDLE) return { state: s.state, confirmed: true };
      if (s.state !== DFU_STATE.dfuMANIFEST && s.state !== DFU_STATE.dfuMANIFEST_SYNC) {
        throw new DfuError(`manifestation: unexpected ${dfuStateName(s.state)}`, { status: s.status, state: s.state, block });
      }
      if (s.state === DFU_STATE.dfuMANIFEST) sawManifest = true;
      if (waited > this.manifestTimeoutMs) throw new DfuError('manifestation does not finish', { state: s.state, block });
      const wait = Math.max(s.pollTimeout, 1);
      waited += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Download `image` whole: blocks of transferSize from block 0, the zero-length DNLOAD, the manifestation.
   * On a failure the device is brought back to dfuIDLE (CLRSTATUS / ABORT) and the DfuError thrown.
   * @param {Uint8Array} image
   * @param {{ onProgress?: (p: DfuProgress) => void, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ blocks: number, bytes: number, state: number, confirmed: boolean }>}
   */
  async download(image, { onProgress, signal } = {}) {
    if (!(this.attributes & DFU_ATTR.canDnload)) throw new DfuError('the DFU interface does not take downloads (bitCanDnload 0)');
    if (!image.length) throw new DfuError('the image is empty');
    await this.toIdle();
    const size = this.transferSize;
    let block = 0;
    try {
      for (let at = 0; at < image.length; at += size) {
        signal?.throwIfAborted();
        const chunk = image.subarray(at, Math.min(at + size, image.length));
        await this.dnload(block, chunk);
        await this.waitBlock(block);
        onProgress?.({ phase: 'download', written: at + chunk.length, total: image.length, block });
        block++;
      }
      signal?.throwIfAborted();
      await this.dnload(block, new Uint8Array(0));
      onProgress?.({ phase: 'manifest', written: image.length, total: image.length, block });
      const done = await this.waitManifest(block);
      return { blocks: block, bytes: image.length, ...done };
    } catch (e) {
      await this.recover();
      throw e;
    }
  }
}

/**
 * The DFU interface of a WebUSB-shaped device, opened and claimed, with its functional descriptor read off the
 * configuration descriptor (wTransferSize, bmAttributes). Falls back to 1024 / canDnload when it cannot be read.
 * @param {UsbDevice} device
 * @param {{ sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function openDfu(device, opts = {}) {
  await openDevice(device);
  const intf = findDfuInterface(device.configuration);
  if (!intf) throw new DfuError('no DFU interface (class 0xFE subclass 0x01) on the device');
  let functional = null;
  try {
    const value = device.configuration?.configurationValue;
    const index = Math.max(0, (device.configurations ?? []).findIndex((c) => c.configurationValue === value));
    const desc = parseConfigDescriptor(await readConfigDescriptor(device, index));
    functional = desc.find((d) => d.number === intf.interfaceNumber && d.alternate === intf.alternateSetting && d.dfu)?.dfu
      ?? desc.find((d) => d.dfu)?.dfu ?? null;
  } catch { /* use the defaults */ }
  await device.claimInterface(intf.interfaceNumber);
  if (intf.alternateSetting !== 0) await device.selectAlternateInterface(intf.interfaceNumber, intf.alternateSetting);
  const client = new DfuClient(device, {
    interfaceNumber: intf.interfaceNumber,
    transferSize: functional?.transferSize || 1024,
    attributes: functional?.attributes ?? DFU_ATTR.canDnload,
    sleep: opts.sleep,
  });
  return Object.assign(client, {
    functional,
    name: intf.name,
    async close() {
      try { await device.releaseInterface(intf.interfaceNumber); } catch { /* the device restarted */ }
      try { await device.close(); } catch { /* the device restarted */ }
    },
  });
}

/**
 * Update a device's firmware over DFU: open, download, close.
 * @param {UsbDevice} device @param {Uint8Array} image
 * @param {{ onProgress?: (p: DfuProgress) => void, signal?: AbortSignal }} [opts]
 */
export async function dfuUpdate(device, image, opts = {}) {
  const dfu = await openDfu(device);
  try {
    return await dfu.download(image, opts);
  } finally {
    await dfu.close();
  }
}

export { sha256, parseFirmwareManifest, pickFirmware, fetchFirmwareManifest, fetchFirmware, verifyFirmware, firmwareFileUrl } from './firmware.js';
