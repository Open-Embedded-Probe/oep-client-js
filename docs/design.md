# Design

English | [日本語](design.ja.md)

How oep-client-js is laid out, what goes where and what it does not do. Nothing is implemented yet; this document is
the map for the scaffold.

## 1. What it is for

- The JavaScript host side of OEP, for browsers and Node. It follows [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)
  v1 (`docs/oep-core.ja.md` and `docs/oep-if-*.ja.md`).
- A web page built on the same library ("OEP Probe Tool") on GitHub Pages: set a probe up and update its firmware from
  the browser alone.
- The counterpart of the Python [oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python). It is one
  of the tools that follow the spec; when the spec breaks, it is fixed together with the others.

## 2. Layout

```text
src/            the library (the core, no environment)   -> npm "oep-client-js" (bundled to dist/oep-client.js)
  index.js        the entry: VERSION and the core's public API
  (to come)       frame, message, session, core, describe, config, the interfaces, registry (generated)
src/browser/    the browser's transports                 -> npm "./browser"
  index.js        WebSerial, WebUSB (vendor bulk, DFU), WebHID
src/node/       Node's transports                        -> npm "./node"
  index.js        serial ports (serialport), USB (usb), TCP (node:net)
web/            the web page's sources                    -> site/ (scripts/build-site.js) -> GitHub Pages
test/           tests (node:test), against the Python fake over TCP
scripts/        build, site, tests, release tools
docs/           this document, the release steps
```

- The core uses neither the DOM nor Node's APIs (only `crypto.getRandomValues` and `TextEncoder` on `globalThis`).
  Transports plug in through a small "send bytes, receive bytes" shape.
- `site/` is not in the npm package (the page is served from Pages); `src/node/` is not in `site/`.
- Types are JSDoc, checked with `// @ts-check` and `tsc --noEmit`; the code is not TypeScript. `tsc` writes the
  declarations (`types/`) from the JSDoc.
- No dependencies are added. Node's `serialport` and `usb` are native modules: optional, installed by whoever talks to
  probes from Node (a browser-only user never gets them).

## 3. Transports

| Transport | Browser (`./browser`) | Node (`./node`) | Frames (core §3.1) |
|---|---|---|---|
| USB CDC, USB-Serial/JTAG, USB-UART bridge | WebSerial | serialport | COBS + CRC |
| vendor bulk (class 0xFF) | WebUSB | usb (WebUSB-shaped) | length(u16) message |
| vendor HID | WebHID | node-hid (optional) | length messages in reports |
| TCP (a local broker, the tests' fake) | - | node:net | length(u16) message |

- WebUSB, WebSerial and WebHID are Chromium only (Chrome, Edge), and the page must be served over HTTPS (or localhost).
- Probes are recognised as core §3.3 says: an iProduct starting `OEP` (the VID:PID tells nothing, so WebSerial's
  chooser gets no built-in VID:PID filter; a caller may pass its own), the vendor interface is class 0xFF / subclass 0x4F /
  protocol 0x45, the HID collection usage page 0xFF4F / usage 0x45 (registry `usb`); the USB serial is the unit_id.

## 4. What the page does (in this order)

1. **Update a probe's firmware** (outside OEP: untouched by spec changes)
   - ESP32-P4: DFU over WebUSB (`OepProbe-esp32p4-<version>.bin`).
   - ESP32 (USB-Serial/JTAG, UART bridge): esptool-js, the merged image at 0x0.
   - RP2040 / RP2350: the steps to copy the UF2 to the BOOTSEL drive (a browser cannot write the drive).
   - Every image is checked against `firmware-<version>.json`'s sha256.
2. **Connect and look**: pick a transport, connect, show everything describe declares (as `oep dump` does).
3. **Settings** (`oep.probe.config`): show and edit slots, binds, plans, labels and idle states, save and erase. The
   screens are built from describe (how many slots, which bind modes, which items).
4. **Simple operations**: GPIO read / write, a UART terminal, attach / halt / resume / reset a target, its console.

Not done here: showing captures ([WireSkein](https://github.com/Open-Embedded-Probe/wireskein)'s), writing a target's
flash (ch32rv and the like).

## 5. Things to mind

- **Release files and CORS**: a browser cannot fetch GitHub Release files (no CORS headers). Firmware is put on Pages
  too, or the user picks the file.
- **The lock**: the page takes the lock before it changes anything, like any host (core §6), shows who holds it and ends
  the session when it closes.
- **VS Code**: an extension (Node) can use `./node`, but the native modules need builds for VS Code's Electron. A webview
  has no WebSerial / WebUSB.

## 6. Tests

- `node:test`, run by `npm test`.
- The probe is oep-client-python's fake (`python -m oep_client.fake_serve` over TCP): the same fake the Python tests use,
  so the same behaviour is checked. CI installs oep-client-python from PyPI.
- The browser transports are checked on hardware (steps in [Releasing](release.md)).

## 7. Numbers (the registry)

The one definition of the numbers is oep-spec's `registry/oep-v1.toml`. As for Python and C++, oep-spec's generator
writes the JS constants (`generated/oep-v1/oep_v1_registry.js`), copied to `src/registry.js` (never written by hand).

## 8. Versions and the spec

- Until the v1 freeze every tool follows a breaking spec change at once. This package counts its own versions; each
  release's changelog names the probe firmware (OpenEmbeddedProbe) it talks to and the oep-client-python its tests used.
- Whether to publish to npm before the freeze depends on whether someone needs it; the API changes without notice
  until then.
