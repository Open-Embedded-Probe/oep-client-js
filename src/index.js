// @ts-check
// oep-client-js: the host side of Open Embedded Probe (OEP) in JavaScript, for browsers and Node.
//
// This entry is the core, the part that depends on no environment: the frame and message shapes, the session and
// the lock, describe, probe.config and the standard interfaces (oep-spec docs/oep-core.ja.md, docs/oep-if-*.ja.md).
// The ways to reach a probe are separate entries: "oep-client-js/browser" (WebSerial, WebUSB,
// WebHID) and "oep-client-js/node" (serial ports, USB, TCP). See docs/design.md.
//
// Not implemented yet: see README.md "Status".

/** The package version (kept in step with package.json by `npm version`). */
export const VERSION = '0.0.1';
