# oep-client-js

[日本語](README.ja.md)

npm: `oep-client-js`, as the repository (and as oep-client-python on PyPI).

The JavaScript host side of [Open Embedded Probe (OEP)](https://github.com/Open-Embedded-Probe/oep-spec): talk to OEP
probes from a browser or Node, set them up and update their firmware. A web page built on it, **OEP Probe Tool**, runs on
GitHub Pages: <https://open-embedded-probe.github.io/oep-client-js/>.

## Status

**A first full port, ahead of the v1 freeze: expect it to be redone as the spec settles.**

**The spec this implements: the oep-spec commit `test/vectors` was copied from** (no `v0.x` tag yet; oep-spec versioning §6 -
before the freeze, revision 1 alone does not fix the forms, so an implementation names the spec it implements). With an
oep-spec checkout beside it, the tests compare the copy with it. The history is in [CHANGELOG.md](CHANGELOG.md).
Until the freeze the Japanese text (`.ja.md`) is the specification's working text.

Its scope is setting up and keeping probes. The use cases it serves:

1. **Make a probe and update its firmware**: an ESP32 / P4 / P4X over its USB serial (the page's esptool-js), a Pico /
   Pico 2 by BOOTSEL and PICOBOOT over WebUSB (`rp2ResetToBoot`, `rp2Write`), a P4 / P4X's update by USB DFU, the image
   chosen from the Release's firmware-<version>.json (`fetchFirmwareManifest`, `pickFirmware`, `verifyFirmware`).
2. **Check that it connects and what it declares**: the transports, confirm, list and describe, `dump` (each
   interface's declarations as text or JSON, and what core §1.2 requires and the probe did not give).
3. **Set it up, back it up and put it back**: the settings (core §13: labels, idle and disabled pins, the log
   pass-through, Wi-Fi, `usb.transports` with save and restart), the settings file, the memo area (`oep.probe.memo`, the
   port record `oep.probe.memo/port/<port>`).
4. **Register the wiring to a target and check it**: the labels and the port records; a debug wire's connection check
   (`wire.Wire.check`: attach on the pins, the id that answered - DMSTATUS on rvswd / swio, DPIDR on swd, an RP2040's
   multidrop core 0 tried when SWD gets no answer - and detach).
5. **Hand the probe over to the tool that does the work**: debugging (the IDEs, oep-client-python), logs (a serial
   monitor through the pass-through, oep-client-python), captures (WireSkein), buses, signals and peers
   (oep-client-python). This package does none of that work.

The parts:

- the core: the registry (generated from oep-spec), frames (COBS + CRC, length), messages, the link (corr matching, one
  resend after a wait, up to 3 at once after a broken frame on a held serial port (host guide §8), pipelining, pushes
  and events; every answer waited at least core §4.4's floor - argument time + 1000 ms + a serial port's transfer time,
  `Link.waitFloorMs` -; the transports §5 resync on length frames, its confirm 250 ms after the host's last write,
  vendor bulk waiting for quiet up to the longest lease and HID not at all (its reports' first finds the frames again,
  transports §1), none for a pause inside a frame; an unanswered resend fails the transport, `TransportFailed`, and the
  next request first recovers with a confirm, COBS included; a frame shorter than its header is broken; a serial port's
  first confirm is retried for port_speed_idle_ms + host_wait_add_ms, as a rate another host raised goes back by then),
  the host (confirm - `limits.transport`; later confirms ask for the revision in use; one outside core §7.1's bounds, a
  max_op_ms outside 1..600000 or an fn 0 ops outside core §7.4's form makes the probe `NotUsable`, an fn's ops outside
  it that fn `FnNotUsable` -, `clock()`, the session - every open a new one under a new random id; a closed transport
  does not end it, so `connect` (`keepSession`, default on) keeps the open session's id per probe - Node: `<unit_id>.session`
  under `$OEP_SESSION_DIR`, `$XDG_RUNTIME_DIR/oep-client` or the user's cache directory, the same file as
  oep-client-python's; a browser: localStorage with a Web Lock - and the next run's first open ends it at once
  (`Host.endPrevious`, `keptsession.KeptSession`, host guide §5) -, the lock, restart - `requestRestart()` and
  `restartProbe({ reopen, waitMs })`, retried until the probe's restart_max_ms -, list / describe, plan);
- the settings (settings.js): `new Settings(host)`: `catalog()` = the names of this boot, `show()` = every value as
  `{ category, name, value }`, `setNamed(category, { flat: value })` / `unsetNamed` / `unsetAll`, raw `set` / `unset`,
  `save()`, `state()`, `needsSave()`, `network()`; `export()` / `exportAll()` / `planImport(doc)` / `applyImport(plan)` = the settings
  file (oep-spec docs/oep-settings-file.ja.md), the memo area's objects in its `memo` (§2.4: written and deleted to match on import); `findLine(source, name, { port })` is host guide §5.3's line
  lookup (port S's line N is the label `S.N`). A secret (the Wi-Fi passphrase) is never read: get gives no data, `show()`
  and the file `{ secret: true }`; 0 bytes in a set keep it;
- the transports: WebSerial, WebUSB (vendor bulk), WebHID in the browser (`oep-client-js/browser`); serial ports open 8N1
  without flow control, DTR and RTS asserted (transports §4); a USB probe is found by the project's USB VID:PID
  `1209:4F45` alone (transports §3: the WebUSB / WebHID choosers' default filter); the WebSerial chooser has no default
  filter, so a UART bridge or a built-in USB serial stays selectable. Node (`oep-client-js/node`) has TCP only,
  `openTcp({ host, port })`: the tests' virtual bench, a local broker or a probe on the network given by host and port;
- besides: `Unsupported.supported` (confirm's range); an `x-` unit_id names no USB device; text from an answer is shown
  without control characters (`message.shown`), open's owner is cut on a character (`ownerText`), a label the probe
  would refuse is not sent.

Tested against oep-client-python's virtual bench (a probe, the targets behind it and the fixture wiring, modelled after
the real jigs: `python -m oep_client.virtual_bench_serve`) and scripted devices (oep-spec's test vectors among them: hid_reports.json, sessions.json, ops.json and
ops_encoding.json included); the browser transports, DFU and the page are not yet checked on hardware.

Until the v1 freeze the spec may break and this package follows it at once, with the probe firmware
([OpenEmbeddedProbe](https://github.com/Open-Embedded-Probe/oep-probe-arduino)) and
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python).

## Layout

| Path | npm entry | Contents |
|---|---|---|
| `src/` | `oep-client-js` | the core, no environment (bundled to `dist/oep-client.js`) |
| `src/browser/` | `oep-client-js/browser` | WebSerial, WebUSB, WebHID |
| `src/node/` | `oep-client-js/node` | TCP |
| `web/` | - | the web page (built to `site/` for GitHub Pages; not in the npm package) |
| `test/` | - | `node:test`, against oep-client-python's virtual bench over TCP |

JavaScript with JSDoc types (`// @ts-check`, checked with `tsc`), ES modules, no runtime dependencies. WebUSB, WebSerial
and WebHID need a Chromium browser (Chrome, Edge) and HTTPS.

## Development

```sh
npm install
npm test            # explicit virtual backend setup: docs/testing.md
npm run typecheck
npm run serve       # the page at http://localhost:4173/
npm run test:browser # Chromium UI verification against the Python virtual probe
```

The browser page follows the [screen specification](docs/page.ja.md), [connection handoff](docs/page-connection.ja.md) and [acceptance criteria](docs/page-acceptance.ja.md) (Japanese).
It has a start page (what the page does, what OEP is used for and in which tool, the documents), making a probe (ESP32 / P4 / P4X over USB serial, Pico / Pico 2 over BOOTSEL), connecting, and one screen per probe with the tabs Overview, Wiring (fixed targets and connectors, with a debug wire's connection check), Probe settings (idle and disabled pins, log pass-through, Wi-Fi, USB transports; one Save for all), Hand over to tools (IDE, serial monitor, WireSkein, Python) and Maintenance (update, backup and restore, diagnostics).
The page is in English and Japanese: the browser's languages choose by default (English for any other), and the selector in the header overrides it for this browser. S3 / C3 / C6 take a compatible merged image; CH32 initial installation is not offered. Hardware verification is listed in the acceptance criteria §3.2.
The site bundles a pinned `esptool-js`; the npm library gains no runtime dependency.
`npm run serve` fetches release images on first use and caches them in `.cache/firmware`. Refresh with `node scripts/fetch-firmware.js`.

## Documents

- Specification: [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec) (in Japanese until the freeze) - start
  with its [README](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/README.md) and [review guide](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/review-guide.md);
  [getting started](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/getting-started.md) builds the smallest probe and host,
  [docs/oep-core.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/oep-core.md) is the protocol core, and
  [docs/conformance.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/conformance.md) says what a host must do to conform
- [Design](docs/design.md): layers, transports, what the page does, tests, the registry, versions
- [Releasing](docs/release.md)
- [Changelog](CHANGELOG.md)

## License

MIT
