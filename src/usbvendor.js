// @ts-check
// The vendor bulk transport on a WebUSB-shaped device (oep-core §3.1, §3.3): the bInterfaceClass 0xFF interface's
// bulk IN / OUT pair (chosen by class, not the first bulk pair: a CDC has one too), length(u16) frames. Shared by the
// browser (WebUSB) and Node (the `usb` package's WebUSB class); nothing here touches either environment.

/** @typedef {import('./usbtypes.js').UsbDevice} UsbDevice */

/** The OEP VID:PID (pid.codes, applied for); until it is granted a probe's iProduct starts "OEP" (core §3.3). */
export const OEP_VENDOR_ID = 0x1209;
export const OEP_PRODUCT_ID = 0x4f45;
/** The reference ESP32-P4 probe's VID:PID until the OEP PID is granted. */
export const P4_VENDOR_ID = 0x303a;
export const P4_PRODUCT_ID = 0x0002;
export const VENDOR_CLASS = 0xff;

/**
 * core §3.3: the OEP VID:PID, or an iProduct starting "OEP".
 * @param {number} vendorId @param {number} productId @param {string | null | undefined} productName
 */
export function isOepDevice(vendorId, productId, productName) {
  return (vendorId === OEP_VENDOR_ID && productId === OEP_PRODUCT_ID) || (productName ?? '').startsWith('OEP');
}

/** The probe's unit id: its USB serial number (core §3.3, §7.5). @param {{ serialNumber?: string | null }} device */
export function usbUnitId(device) {
  return device.serialNumber || null;
}

/**
 * @typedef {object} VendorInterface
 * @property {number} interfaceNumber
 * @property {number} alternateSetting
 * @property {number} endpointIn       endpoint number (no direction bit, as WebUSB takes it)
 * @property {number} endpointOut
 * @property {number} packetSizeOut   wMaxPacketSize of OUT (a write of a multiple of it is followed by a ZLP)
 */

/**
 * The vendor interface of a configuration: class 0xFF with one bulk IN and one bulk OUT endpoint.
 * @param {import('./usbtypes.js').UsbConfiguration | null | undefined} configuration
 * @returns {VendorInterface | null}
 */
export function findVendorInterface(configuration) {
  for (const intf of configuration?.interfaces ?? []) {
    for (const alt of intf.alternates ?? (intf.alternate ? [intf.alternate] : [])) {
      if (alt.interfaceClass !== VENDOR_CLASS) continue;
      const bulk = alt.endpoints.filter((e) => e.type === 'bulk');
      const input = bulk.find((e) => e.direction === 'in');
      const output = bulk.find((e) => e.direction === 'out');
      if (input && output) {
        return {
          interfaceNumber: intf.interfaceNumber,
          alternateSetting: alt.alternateSetting,
          endpointIn: input.endpointNumber,
          endpointOut: output.endpointNumber,
          packetSizeOut: output.packetSize || 64,
        };
      }
    }
  }
  return null;
}

/** Open the device and select its first configuration when none is. @param {UsbDevice} device */
export async function openDevice(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) {
    const first = device.configurations?.[0];
    await device.selectConfiguration(first ? first.configurationValue : 1);
  }
}

/**
 * The vendor bulk transport on `device` (opened and claimed here).
 * @param {UsbDevice} device
 * @param {{ readSize?: number, depth?: number }} [opts]  readSize: bytes per IN transfer; depth: IN transfers kept queued
 * @returns {Promise<import('./link.js').Transport>}
 */
export async function vendorTransport(device, { readSize = 16384, depth = 4 } = {}) {
  await openDevice(device);
  const vi = findVendorInterface(device.configuration);
  if (!vi) throw new Error('no vendor-class (0xFF) interface with a bulk IN/OUT pair on the device');
  await device.claimInterface(vi.interfaceNumber);
  if (vi.alternateSetting !== 0) await device.selectAlternateInterface(vi.interfaceNumber, vi.alternateSetting);

  let closing = false;
  let ended = false;
  /** @type {((error?: unknown) => void) | null} */
  let closed = null;
  /** @param {unknown} [error] */
  const end = (error) => {
    if (ended) return;
    ended = true;
    closed?.(closing ? undefined : error);
  };

  return {
    framing: 'length',
    kind: 'vendor',
    async write(data) {
      const r = await device.transferOut(vi.endpointOut, data);
      if (r.status !== 'ok') throw new Error(`USB bulk OUT: ${r.status}`);
      // a write whose length is a whole number of packets is ended with a zero-length packet (core §3.1)
      if (data.length && data.length % vi.packetSizeOut === 0) await device.transferOut(vi.endpointOut, new Uint8Array(0));
    },
    start(onData, onClose) {
      closed = onClose;
      // `depth` IN transfers stay queued; their results are taken in the order they were asked for
      /** @type {Promise<import('./usbtypes.js').UsbInResult>[]} */
      const queue = [];
      const submit = () => queue.push(device.transferIn(vi.endpointIn, readSize));
      (async () => {
        try {
          for (let i = 0; i < depth; i++) submit();
          while (!closing) {
            const r = /** @type {Promise<import('./usbtypes.js').UsbInResult>} */ (queue.shift());
            const result = await r;
            if (closing) break;
            if (result.status === 'stall') await device.clearHalt('in', vi.endpointIn);
            else if (result.status === 'ok' && result.data && result.data.byteLength) {
              onData(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice());
            }
            submit();
          }
          for (const p of queue) p.catch(() => {});
          end();
        } catch (e) {
          for (const p of queue) p.catch(() => {});
          end(e);
        }
      })();
    },
    async close() {
      closing = true;
      try { await device.releaseInterface(vi.interfaceNumber); } catch { /* already gone */ }
      try { await device.close(); } catch { /* already gone */ }
      end();
    },
  };
}
