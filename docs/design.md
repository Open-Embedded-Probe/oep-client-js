# Design

English | [日本語](design.ja.md)

How oep-client-js is laid out, what goes where and what it does not do.

## 1. What it is for

- The JavaScript host side of OEP, for browsers and Node. It follows [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec)
  v1 (`docs/oep-core.ja.md` and `interfaces/*.ja.md`).
- A web page built on the same library ("OEP Probe Tool") on GitHub Pages: set a probe up and update its firmware from
  the browser alone.
- Its scope is setting up and keeping probes: making one and updating its firmware, checking that it connects and what
  it declares, its settings and memo backed up and put back, the wiring to a target registered and checked (a debug
  wire's attach and detach), and the probe handed over to the tool for the work. The work itself - debugging, captures,
  buses and signals, peers, automated tests - is oep-client-python's, WireSkein's and the IDEs'; this package does none
  of it.
- The counterpart of the Python [oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python). It is one
  of the tools that follow the spec; when the spec breaks, it is fixed together with the others.

## 2. Layout

```text
src/            the library (the core, no environment)   -> npm "oep-client-js" (bundled to dist/oep-client.js)
  index.js        the entry: VERSION and the core's public API
  the rest        frames (cobs.js), messages, the link, the host, core, settings, memo, dump, the debug wire's connection
                  check (wire.js), the firmware (firmware.js, picoboot.js, dfu.js), registry.js (generated)
src/browser/    the browser's transports                 -> npm "./browser"
  index.js        WebSerial, WebUSB (vendor bulk, DFU), WebHID
src/node/       Node's transports                        -> npm "./node"
  index.js        TCP (node:net): the tests' virtual bench, a probe given by host and port
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
- The OEP library has no runtime dependencies. Only the site bundles a pinned esptool-js for ESP ROM programming.

## 3. Transports

| Transport | Browser (`./browser`) | Node (`./node`) | Frames (transports §1) |
|---|---|---|---|
| USB CDC, USB-Serial/JTAG, USB-UART bridge | WebSerial | - | COBS + CRC |
| vendor bulk (class 0xFF) | WebUSB | - | length(u16) message |
| vendor HID | WebHID | - | length messages in reports with count and first |
| TCP (the tests' virtual bench, a local broker, a probe on Wi-Fi given by host and port) | - | node:net | length(u16) message |

- TCP is Node's alone: a browser can neither open a TCP connection nor send mDNS, so the page offers no TCP. Node opens
  it by host and port (`openTcp({ host, port })`; `unitId` checks describe's unit_id after opening). Finding probes on
  the network (DNS-SD) and Node's serial ports and USB are oep-client-python's.

- WebUSB, WebSerial and WebHID are Chromium only (Chrome, Edge), and the page must be served over HTTPS (or localhost).
- Probes are recognised as transports §3 says: automatically only by the project's own USB VID:PID, `1209:4F45`
  (`PROJECT_VID_PIDS`, from the registry's `usb`); a probe named by its unit_id is the device whose USB serial it is, and
  describe must then say that unit_id (`connect({ unitId })`, else `UnitIdMismatch`); every transport opened is probed
  with a confirm only first, closed with `NotOepProbe` when no valid answer comes. The WebUSB / WebHID choosers' default
  filters are that VID:PID (`PROJECT_USB_FILTERS`; WebHID with the OEP collection, usage page 0xFF4F / usage 0x45).
  WebSerial's chooser gets no built-in filter (a UART bridge or a built-in USB serial is never on that VID:PID);
  `PROJECT_SERIAL_FILTERS` narrows it to probes. Nothing looks at iProduct. Inside a probe the ports are chosen by the interface values
  (registry `usb`).

## 4. Browser workspace

The page's purpose, scope and flows are in the [requirements and screen specification](page.ja.md), [connection handoff](page-connection.ja.md) and [acceptance criteria](page-acceptance.ja.md) (Japanese).

`web/` is split into `app.js` (public pages, probe creation, connecting, routing), `work.js` (initial setup by purpose, home, wiring list and
editor with the connection check), `passthrough.js` (the log pass-through setting), `manage.js` (probe settings, maintenance, the hand-over to
tools) and `device.js` (everything done to the connected probe). Screens reach the probe only through `device.js`; saving, loading and moving
between screens never attach, assign pins or drive outputs - the connection check attaches only when asked. `npm run test:browser` runs
installation through handover against the Python virtual probe in Chromium.

- `web/data.js`: the boards, the purposes (what the page prepares for each, and the tool that does the work) and the documents.
- `web/model.js`: connection names and firmware versions. `web/boards.js`: board guidance.
- `web/oep-client.js`: the source's public API entry, replaced by the site build with an entry that refers to `site/src/`.
- `tsconfig.web.json` checks the browser code too, and `npm run test:browser` exercises it in Chromium with the Python
  virtual probe.

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
