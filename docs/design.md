# Design

English | [日本語](design.ja.md)

How OEP Probe Tool and its code are laid out, what goes where and what they do not do.

## 1. What it is for

- A web page on GitHub Pages that makes a board an OEP probe, sets it up and keeps it, and hands it to the tools that do
  the work. The screens are in the [screen specification](page.ja.md) (Japanese).
- The JavaScript OEP host it runs on, following [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec) v1
  (`docs/oep-core.ja.md`, `docs/oep-transports.ja.md`, `docs/oep-settings-file.ja.md` and the interfaces it uses).
- Not a library for others: nothing is published to npm. Using a probe from code - debugging, captures, buses and
  signals, peers, automated tests - is [oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python)'s,
  with WireSkein and the IDEs. When the spec breaks, this is fixed together with them.

## 2. Layout

```text
src/            the OEP host, no environment
  index.js        VERSION and the modules as namespaces
  the rest        frames (cobs.js), messages, the link, the host, core (list, describe, plan, restart), settings and the
                  settings file, memo, dump, the debug wire's connection check (wire.js), firmware (firmware.js,
                  picoboot.js, dfu.js), registry.js (generated)
src/browser/    Web Serial, WebUSB (vendor bulk, DFU, PICOBOOT), WebHID
src/node/       TCP (node:net): how the tests reach the Python virtual bench
web/            the page                                   -> site/ (scripts/build-site.js) -> GitHub Pages
test/           node:test, against the Python virtual bench and oep-spec's test vectors
scripts/        the test runner, the browser test, the site build, the firmware fetch, the hardware HID check
docs/           this document, the screens, testing, publishing
```

- The core uses neither the DOM nor Node's APIs (only `crypto.getRandomValues` and `TextEncoder` on `globalThis`).
  Transports plug in through a small "send bytes, receive bytes" shape (`Link`'s `Transport`).
- `src/node/` is not in `site/`.
- Types are JSDoc, checked with `// @ts-check` and `tsc --noEmit` (`tsconfig.web.json` for the page); the code is not
  TypeScript.
- No runtime dependencies. The site alone bundles a pinned esptool-js for ESP ROM programming.

## 3. Transports

| Transport | Page (`src/browser/`) | Tests (`src/node/`) | Frames (transports §1) |
|---|---|---|---|
| USB CDC, USB-Serial/JTAG, USB-UART bridge | Web Serial | - | COBS + CRC |
| vendor bulk (class 0xFF) | WebUSB | - | length(u16) message |
| vendor HID | WebHID | - | the length stream in reports with count(u16) and first(u16) |
| TCP | - | node:net | length(u16) message |

- Web Serial, WebUSB and WebHID are Chromium only (Chrome, Edge), over HTTPS (or localhost). A browser can open no TCP,
  so the page offers none.
- Probes are recognised as transports §3 says: automatically only by the project's own USB VID:PID `1209:4F45`
  (`PROJECT_VID_PIDS`, from the registry's `usb`); every transport opened is probed with a confirm first and closed with
  `NotOepProbe` when no valid answer comes; a probe named by its unit_id must say that unit_id in describe
  (`UnitIdMismatch`). The WebUSB / WebHID choosers' default filters are that VID:PID (WebHID with the OEP collection,
  usage page 0xFF4F / usage 0x45). Web Serial's chooser gets none: a UART bridge or a built-in USB serial is never on
  that VID:PID. Nothing looks at iProduct.
- HID: the reader keeps whole frames only, finding them again by each report's first after a lost one, so the link's
  resync on HID reads nothing past and waits for no quiet (transports §5). Vendor bulk waits for quiet up to the longest
  lease. `node scripts/check-hid.mjs` drives the page's WebHID code through a real probe's Linux hidraw node.

## 4. The page

`web/` is split into `app.js` (the start, making a probe, connecting, routing), `common.js` (the probe's band, tabs and
next step), `wiring.js` (the wiring list and its editor with the live checks and the connection check), `probe.js` (the
overview, probe settings with the pass-through, using the probe in other tools, maintenance) and `device.js` (everything
done to the connected probe). Screens reach the probe only through `device.js`; opening, saving and moving between
screens never attach, assign pins or drive outputs - the connection check attaches only when asked, and detaches at once.

- `web/data.js`: the boards, the uses (what the page prepares for each, and the tool that does the work), the documents.
- `web/boards.js`: the boards' features. `web/model.js`: connection names, firmware versions.
- `web/esp-flash.js`: ESP ROM programming through esptool-js, with the chip reset into its firmware afterwards.
- `web/oep-client.js`: the code's entry for the page, replaced by the site build with one that refers to `site/src/`.

## 5. Things to mind

- **Release files and CORS**: a browser cannot fetch GitHub Release files (no CORS headers), so the Pages build copies
  the latest Release's images beside the page (`scripts/fetch-firmware.js`).
- **The lock**: the page takes the lock inside the action that changes something (core §6), with a 10 s lease kept
  alive while connected, and ends the session when it disconnects. A page reloaded or closed without ending leaves the
  session to its lease (transports §3), so the probe is free again within 10 s. A transport that ends by itself (the
  cable pulled) is noticed at once; connecting again ends the session it left first.
- **A failed transport** (core §5.2, host guide §8): a request whose resend also goes unanswered throws
  `TransportFailed`; its outcome (and that of every request outstanding with it) is unknown. The link recovers with a
  confirm before the next request, and a changed boot_id shows as a reboot (`host.epoch`). The page reads the state
  again rather than repeat anything that changes it.
- **A probe not used**: a confirm outside core §7.1's bounds, or a max_op_ms outside 1..600000, throws `NotUsable` and
  nothing more is sent to that probe (C-20, C-47).

## 6. Tests

- `node:test`, run by `npm test`; the page in Chromium by `npm run test:browser`. See [testing](testing.md).
- The probe is oep-client-python's virtual bench (`python -m oep_client.virtual_bench_serve` over TCP), pinned in
  `test/virtual-bench/`: the same virtual bench the Python tests use.
- Hardware: the steps before the page is published are in [publishing](publish.md).

## 7. Numbers (the registry)

The one definition of the numbers is oep-spec's `registry/oep-v1.toml`. oep-spec's generator writes the JS constants
(`generated/oep-v1/oep_v1_registry.js`), copied to `src/registry.js` (never written by hand). oep-spec's test vectors
(`tests/vectors/*.json`) are copied the same way to `test/vectors/` and checked by `test/vectors.test.js`, which also
compares the copy with a sibling oep-spec checkout when there is one.

## 8. Versions and the spec

- Until the v1 freeze every tool follows a breaking spec change at once. The changelog names the oep-spec commit, the
  probe firmware and the oep-client-python the tests used when they change.
- `VERSION` (shown in the page's footer) marks a point when one is wanted ([publishing](publish.md)); there is no npm
  version.
