// @ts-check
// oep-client-js: the host side of Open Embedded Probe (OEP) in JavaScript, for browsers and Node.
//
// This entry is the core, the part that depends on no environment: the frame and message shapes, the session and
// the lock, describe, probe.config and the standard interfaces (oep-spec docs/oep-core.ja.md, docs/oep-if-*.ja.md).
// The ways to reach a probe are separate entries: "oep-client-js/browser" (WebSerial, WebUSB, WebHID) and
// "oep-client-js/node" (serial ports, USB, TCP). See docs/design.md.
//
// Each module is also a namespace here (its names would clash flat: capture.MODE, config.MODE):
//   import { connect, core, riscv } from 'oep-client-js';
//   const host = await connect(transport);
//   const wire = await riscv.Wire.open(host);

/** The package version (kept in step with package.json by `npm version`). */
export const VERSION = '0.0.1';

export { connect } from './open.js';
export { Host } from './host.js';
export { Link } from './link.js';
export { raiseSpeed, speedText } from './speed.js';
export {
  OepError, ProtocolError, ShortPayload, BadTlv, Rejected, Failed, NotV1, Timeout, InUse, NotOepProbe, UnitIdMismatch,
  Locked, NoSession, Expired,
  Busy, NoConnection, Unsupported, Unavailable,
} from './errors.js';

export * as registry from './registry.js';
export * as bytes from './bytes.js';
export * as cobs from './cobs.js';
export * as message from './message.js';
export * as catalog from './catalog.js';
export * as core from './core.js';
export * as names from './names.js';
export * as interfaces from './interfaces.js';
export * as dump from './dump.js';
export * as config from './config.js';
export * as riscv from './riscv.js';
export * as arm from './arm.js';
export * as targetConsole from './console.js';   // oep.target.console (not the global console)
export * as fixture from './fixture.js';
export * as capture from './capture.js';
export * as decode from './decode.js';
export * as dfu from './dfu.js';
export * as speed from './speed.js';
export * as speedrecord from './speedrecord.js';
export * as firmware from './firmware.js';
