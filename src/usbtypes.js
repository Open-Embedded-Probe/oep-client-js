// @ts-check
// The part of WebUSB this client uses, as JSDoc types: lib.dom does not carry WebUSB, and the `usb` package's
// WebUSB class (Node) has the same shape. Types only.

/**
 * @typedef {{ requestType: 'standard' | 'class' | 'vendor', recipient: 'device' | 'interface' | 'endpoint' | 'other',
 *   request: number, value: number, index: number }} UsbControlSetup
 * @typedef {{ status: 'ok' | 'stall' | 'babble' | string, data?: DataView | null }} UsbInResult
 * @typedef {{ status: 'ok' | 'stall' | string, bytesWritten?: number }} UsbOutResult
 */

/**
 * What a DFU client needs: control transfers on EP0 (WebUSB's USBDevice has them).
 * @typedef {object} UsbControl
 * @property {(setup: UsbControlSetup, data?: Uint8Array) => Promise<UsbOutResult>} controlTransferOut
 * @property {(setup: UsbControlSetup, length: number) => Promise<UsbInResult>} controlTransferIn
 */

/**
 * @typedef {{ endpointNumber: number, direction: 'in' | 'out', type: 'bulk' | 'interrupt' | 'isochronous', packetSize: number }} UsbEndpoint
 * @typedef {{ alternateSetting: number, interfaceClass: number, interfaceSubclass: number, interfaceProtocol: number,
 *   interfaceName?: string | null, endpoints: UsbEndpoint[] }} UsbAlternate
 * @typedef {{ interfaceNumber: number, alternate?: UsbAlternate | null, alternates: UsbAlternate[], claimed?: boolean }} UsbInterface
 * @typedef {{ configurationValue: number, configurationName?: string | null, interfaces: UsbInterface[] }} UsbConfiguration
 */

/**
 * A WebUSB USBDevice (browser), or the `usb` package's WebUSBDevice (Node).
 * @typedef {UsbControl & {
 *   vendorId: number, productId: number, productName?: string | null, manufacturerName?: string | null,
 *   serialNumber?: string | null, opened?: boolean,
 *   configuration?: UsbConfiguration | null, configurations?: UsbConfiguration[],
 *   open(): Promise<void>, close(): Promise<void>,
 *   selectConfiguration(value: number): Promise<void>,
 *   claimInterface(n: number): Promise<void>, releaseInterface(n: number): Promise<void>,
 *   selectAlternateInterface(n: number, alt: number): Promise<void>,
 *   transferIn(endpoint: number, length: number): Promise<UsbInResult>,
 *   transferOut(endpoint: number, data: Uint8Array): Promise<UsbOutResult>,
 *   clearHalt(direction: 'in' | 'out', endpoint: number): Promise<void>,
 * }} UsbDevice
 */

export {};
