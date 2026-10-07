# Design

English | [日本語](design.ja.md)

How oep-client-js is laid out, what goes where and what it does not do. Nothing is implemented yet; this document is
the map for the scaffold.

## 1. What it is for

- The JavaScript host side of OEP, for browsers and Node. It follows [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)
  v1 (`docs/oep-core.ja.md` and `interfaces/*.ja.md`).
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
  index.js        serial ports (serialport), USB (usb), TCP (node:net; found by DNS-SD over mDNS: discovery.js, node:dgram)
web/            the web page's sources                    -> site/ (scripts/build-site.js) -> GitHub Pages
test/           tests (node:test), against the Python virtual bench over TCP
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

| Transport | Browser (`./browser`) | Node (`./node`) | Frames (transports §1) |
|---|---|---|---|
| USB CDC, USB-Serial/JTAG, USB-UART bridge | WebSerial | serialport | COBS + CRC |
| vendor bulk (class 0xFF) | WebUSB | usb (WebUSB-shaped) | length(u16) message |
| vendor HID | WebHID | node-hid (optional) | length messages in reports |
| TCP (a probe on Wi-Fi, a local broker, the tests' virtual bench) | - | node:net | length(u16) message |

- TCP is Node's alone: a browser can neither open a TCP connection nor send mDNS, so the page offers no TCP. A probe on
  TCP is found as transports §3 says - DNS-SD `_oep._tcp` over mDNS, the port the SRV record's (none is fixed), TXT
  `unit_id` - by `browse()` / `findUnit()` / `portOf()` (src/node/discovery.js, no dependency; the query goes out of every IPv4 interface) or given as host and port
  (`openTcp({ host, port })`); `openTcp({ unitId })` checks describe's unit_id after opening.

- WebUSB, WebSerial and WebHID are Chromium only (Chrome, Edge), and the page must be served over HTTPS (or localhost).
- Probes are recognised as transports §3 says: automatically only by the project's own USB VID:PID, `1209:4F45`
  (`PROJECT_VID_PIDS`, from the registry's `usb`); a probe named by its unit_id is the device whose USB serial it is, and
  describe must then say that unit_id (`connect({ unitId })`, else `UnitIdMismatch`); every transport opened is probed
  with a confirm only first, closed with `NotOepProbe` when no valid answer comes. The WebUSB / WebHID choosers' default
  filters are that VID:PID (`PROJECT_USB_FILTERS`; WebHID with the OEP collection, usage page 0xFF4F / usage 0x45).
  WebSerial's chooser gets no built-in filter (a UART bridge or a built-in USB serial is never on that VID:PID);
  `PROJECT_SERIAL_FILTERS` narrows it to probes. In Node, `findUsbProbes` and `findSerialProbes` list the devices and the
  CDC ports on that VID:PID, `findProbes` lists each device once whatever ways in it has, and `openUsb()` with nothing
  given opens the one probe there (vendor bulk, else its CDC port); with several it opens none and `SeveralProbesError`
  lists them (unit id, ways in) - name one. Nothing looks at iProduct. Inside a probe the ports are chosen by the interface values
  (registry `usb`).

## 4. What the page does (in this order)

1. **Update a probe's firmware** (outside OEP: untouched by spec changes)
   - ESP32-P4: DFU over WebUSB (`OepProbe-esp32p4-<version>.bin`).
   - ESP32 (USB-Serial/JTAG, UART bridge): esptool-js, the merged image at 0x0.
   - RP2040 / RP2350: the steps to copy the UF2 to the BOOTSEL drive (a browser cannot write the drive).
   - Every image is checked against `firmware-<version>.json`'s sha256.
2. **Connect and look**: pick a transport, connect, show everything describe declares (as `oep dump` does).
3. **Settings** (`oep.probe.config`): show and edit slots, binds, plans, labels and idle states, save and erase. The
   screens are built from describe (how many slots, which items); a bind carries one stream.
4. **Simple operations**: GPIO read / write, a UART terminal, attach / halt / resume / reset a target, its console.

Not done here: showing captures ([WireSkein](https://github.com/Open-Embedded-Probe/wireskein)'s), writing a target's
flash (ch32rv and the like).

## 5. Things to mind

- **Release files and CORS**: a browser cannot fetch GitHub Release files (no CORS headers). Firmware is put on Pages
  too, or the user picks the file.
- **The lock**: the page takes the lock before it changes anything, like any host (core §6), shows who holds it and ends
  the session when it closes. A page reloaded or closed without end leaves its session to the lease (transports §3):
  `connect` keeps the session id in localStorage by unit_id and the next page's first open ends it first (host guide §5).
- **A failed transport** (core §5.2, host guide §8): a request whose resend also goes unanswered throws `TransportFailed`; its
  outcome (and that of every request outstanding with it) is unknown. The link recovers with a confirm before the next
  request goes out, and a changed boot_id then shows as a reboot (`host.epoch`). A page reads the state again before it
  repeats anything that changes it.
- **A probe not used**: a confirm outside core §7.1's bounds, or a max_op_ms outside 1..600000, throws `NotUsable` and
  the host sends nothing more to that probe (C-20, C-47). The page says why, with the values.
- **VS Code**: an extension (Node) can use `./node`, but the native modules need builds for VS Code's Electron. A webview
  has no WebSerial / WebUSB.

## 6. Tests

- `node:test`, run by `npm test`.
- The probe is oep-client-python's virtual bench (`python -m oep_client.virtual_bench_serve` over TCP: a probe, the
  targets behind it and the fixture wiring, modelled after the real jigs): the same virtual bench the Python tests use,
  so the same behaviour is checked. The tests keep session ids (keptsession.js) in a temporary `$OEP_SESSION_DIR`. CI installs oep-client-python from its main branch (git).
- The browser transports are checked on hardware (steps in [Releasing](release.md)).

## 7. Numbers (the registry)

The one definition of the numbers is oep-spec's `registry/oep-v1.toml`. As for Python and C++, oep-spec's generator
writes the JS constants (`generated/oep-v1/oep_v1_registry.js`), copied to `src/registry.js` (never written by hand).
oep-spec's test vectors (`tests/vectors/*.json`) are copied the same way to `test/vectors/` and checked by
`test/vectors.test.js` (which also compares the copy with a sibling oep-spec checkout when there is one).

## 8. Versions and the spec

- Until the v1 freeze every tool follows a breaking spec change at once. This package counts its own versions; each
  release's changelog names the probe firmware (OpenEmbeddedProbe) it talks to and the oep-client-python its tests used.
- Whether to publish to npm before the freeze depends on whether someone needs it; the API changes without notice
  until then.
