// @ts-check
// The OEP host OEP Probe Tool runs on (Open Embedded Probe, oep-spec docs/oep-core.ja.md): the part that depends on no
// environment - frames and messages, the session and the lock, describe, the settings and the settings file, the memo,
// firmware updates and a debug wire's connection check. Using a probe - debugging, captures, fixtures - is
// oep-client-python's and the tools the page hands over to. The transports are src/browser/ (Web Serial, WebUSB,
// WebHID; the page's) and src/node/ (TCP; the tests'). See docs/design.md.
//
// Each module is also a namespace here:
//   import { connect, settings } from './index.js';
//   const host = await connect(transport);
//   const items = await new settings.Settings(host).show();

/** The package version (kept in step with package.json by `npm version`). */
export const VERSION = '0.0.1';

export { connect } from './open.js';
export { Host } from './host.js';
export { Link } from './link.js';
export {
  OepError, ProtocolError, ShortPayload, Rejected, Failed, NotV1, Timeout, TransportFailed, NotUsable, FnNotUsable, NotRestarted, FramingLost, InUse,
  NotOepProbe, UnitIdMismatch,
  Locked, NoSession,
  NoResource, Unsupported, Unavailable,
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
export * as settings from './settings.js';
export * as memo from './memo.js';
export * as wire from './wire.js';
export * as dfu from './dfu.js';
export * as keptsession from './keptsession.js';
export * as firmware from './firmware.js';
export * as picoboot from './picoboot.js';
