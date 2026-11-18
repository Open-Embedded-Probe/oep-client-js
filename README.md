# OEP Probe Tool (oep-client-js)

[日本語](README.ja.md)

A web page that makes a board an [Open Embedded Probe (OEP)](https://github.com/Open-Embedded-Probe/oep-spec) probe,
sets it up and keeps it, and hands it to the tools that do the work. It runs on GitHub Pages:
<https://open-embedded-probe.github.io/oep-client-js/>. This repository is the page and the JavaScript OEP host code it
runs on; nothing is published to npm.

## What the page does

1. **Make a probe and update its firmware**: an ESP32 / P4 / P4X over its USB serial, a Pico / Pico 2 by BOOTSEL, a
   P4 / P4X's update by USB DFU; the image is the latest oep-probe-arduino Release's.
2. **Connect and see what it is**: USB serial (Web Serial), USB (the OEP device, WebUSB) or USB HID (WebHID); the unit,
   its firmware, its path and the functions it declares.
3. **Set it up**: idle pins and pins kept off, the log pass-through to a serial monitor, Wi-Fi, the USB paths; one Save
   for all. Export and import the settings and the memo area in one OEP settings file.
4. **Register the wiring to a target**: names for the probe's pins, the target's part number, and a debug wire's
   connection check (the ID that answers on those pins).
5. **Use it in other tools**: the IDE (CH32, RP2040 through the Python broker), a serial monitor, WireSkein, Python - with
   this probe's addresses and the commands to use.

The work itself - debugging, reading logs, capturing waveforms, buses, signals, automated tests - is
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python)'s, WireSkein's and the IDEs'; the page does
none of it. Device access needs Chrome or Edge on the desktop, over HTTPS (or localhost). The page is in English and
Japanese (the browser's languages by default, the header's selector to change it).

The screens are specified in [docs/page.ja.md](docs/page.ja.md), with the [connection handoff](docs/page-connection.ja.md)
and the [acceptance criteria](docs/page-acceptance.ja.md) (Japanese).

## Status

**Ahead of the OEP v1 freeze: the spec may still break, and this follows it at once**, with the probe firmware
([oep-probe-arduino](https://github.com/Open-Embedded-Probe/oep-probe-arduino)) and oep-client-python. The spec this
implements is the oep-spec commit `test/vectors` was copied from (no `v0.x` tag yet, oep-spec versioning §6); with an
oep-spec checkout beside it, the tests compare the copy with it. The history is in [CHANGELOG.md](CHANGELOG.md).

## The code

| Path | Contents |
|---|---|
| `src/` | the OEP host, no environment: the registry (generated from oep-spec), frames (COBS + CRC, length), messages, the link (resends, the transports §5 resync, HID's whole frames), the host (confirm, sessions, lock, restart), describe, settings and the settings file, the memo area, `dump`, a debug wire's connection check (`wire.js`), firmware (release manifest, PICOBOOT, DFU) |
| `src/browser/` | Web Serial, WebUSB (vendor bulk), WebHID (reports with count and first, transports §1) |
| `src/node/` | TCP only: how the tests reach oep-client-python's virtual bench |
| `web/` | the page, built to `site/` for GitHub Pages |
| `test/` | `node:test`, against oep-client-python's virtual bench and oep-spec's test vectors |
| `scripts/` | the test runner, the browser test, the site build, the firmware fetch, the hardware HID check |

JavaScript with JSDoc types (`// @ts-check`, checked with `tsc`), ES modules, no runtime dependencies; the site alone
bundles a pinned esptool-js for ESP ROM programming.

## Development

```sh
npm install
uv sync --project test/virtual-bench --locked            # the pinned virtual bench (docs/testing.md)
OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
npm run test:browser   # the page in Chromium against the Python virtual probe
npm run serve          # the page at http://localhost:4173/
```

`npm run serve` fetches the release images on first use into `.cache/firmware` (`node scripts/fetch-firmware.js`
refreshes them).

## Documents

- [Design](docs/design.md): layers, transports, the page's code, tests, the registry
- [Testing](docs/testing.md)
- [Publishing the page](docs/publish.md)
- The OEP specification: [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec) (in Japanese until the freeze) -
  its [README](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/README.md),
  [the core](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/oep-core.md) and
  [conformance](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/conformance.md)

## License

MIT
