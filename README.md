# oep-client-js

[日本語](README.ja.md)

npm: `oep-client-js`, as the repository (and as oep-client-python on PyPI).

The JavaScript host side of [Open Embedded Probe (OEP)](https://github.com/Open-Embedded-Probe/oep-spec): talk to OEP
probes from a browser or Node, set them up and update their firmware. A web page built on it, **OEP Probe Tool**, runs on
GitHub Pages: <https://open-embedded-probe.github.io/oep-client-js/>.

## Status

**A first full port, ahead of the v1 freeze: expect it to be redone as the spec settles.** What is there:

- the core: the registry (generated from oep-spec), frames (COBS + CRC, length), messages, the link (corr matching, one
  resend, pipelining, pushes and events), the host (confirm, session, lock, subscribe), list / describe / plan;
- the interfaces: the debug wires (rvswd, swio, swd) and riscv-dm, ARM ADI / MEM-AP / Cortex-M, the target console, the
  fixtures (gpio, uart, i2c-target, spi-target), the captures (logic, analog, capture-group, sigrok .sr), probe.config and
  the `oep dump` view;
- the transports: WebSerial, WebUSB (vendor bulk), WebHID in the browser; TCP, serial ports (`serialport`) and USB (`usb`)
  in Node (the native packages optional);
- the firmware update: USB DFU (the ESP32-P4) and the Release's firmware-<version>.json;
- the page: connect, read what the probe declares, edit and save its settings, GPIO and UART, port_speed, a DFU update;
- port_speed (oep-core §3.5, opt-in): `raiseSpeed(host, rates, opts)` (or `portSpeed: [rates]` on `connect` /
  `openWebSerial` / `openSerial`) runs a UART bridge faster for the session - each rate tried, verified both ways with
  max_frame-sized link_source / link_sink frames (broken frames counted, KB/s measured each way), then both ways at once
  (the two interleaved, about 1 s, `duplexKBs`), committed or reverted
  and confirmed again at the boot speed; the report stays as `host.link.speed`. WebSerial changes the rate by closing and
  opening the same port again (DTR / RTS released at once, as esptool-js does), Node's `serialport` by `update`. An
  `end` takes the link back to the boot speed, and a request unanswered at a raised rate falls back to it and goes once
  more, each wait at most a quarter of the lease; 3 broken frames or resends within 5 s step down (port_speed revert,
  the boot speed, a confirm); a rate left either way stays unused for the session (`speed.steppedDown`, `downWhy`) (the
  same procedure as oep-client-python).

The wire is oep-spec's zero-base rewrite of 2026-10-01 (every answer carries its lengths, TLVs have a long form, confirm
answers the boot_id, `expired`, probe.config's `state` / `unset` / `uart`, the attach reset TLV, capture generations; see
the changelog). Tested against oep-client-python's fake probe (131 tests) and scripted devices; the browser transports,
DFU and the page are not yet checked on hardware.

Until the v1 freeze the spec may break and this package follows it at once, with the probe firmware
([OpenEmbeddedProbe](https://github.com/Open-Embedded-Probe/oep-probe-arduino)) and
[oep-client-python](https://github.com/Open-Embedded-Probe/oep-client-python).

## Layout

| Path | npm entry | Contents |
|---|---|---|
| `src/` | `oep-client-js` | the core, no environment (bundled to `dist/oep-client.js`) |
| `src/browser/` | `oep-client-js/browser` | WebSerial, WebUSB, WebHID |
| `src/node/` | `oep-client-js/node` | serial ports, USB, TCP |
| `web/` | - | the web page (built to `site/` for GitHub Pages; not in the npm package) |
| `test/` | - | `node:test`, against oep-client-python's fake probe over TCP |

JavaScript with JSDoc types (`// @ts-check`, checked with `tsc`), ES modules, no runtime dependencies. WebUSB, WebSerial
and WebHID need a Chromium browser (Chrome, Edge) and HTTPS.

## Development

```sh
npm install
npm test            # needs python -m pip install oep-client-python (the fake probe)
npm run typecheck
npm run serve       # the page at http://localhost:4173/
```

## Documents

- [Design](docs/design.md): layers, transports, what the page does, tests, the registry, versions
- [Releasing](docs/release.md)
- [Changelog](CHANGELOG.md)

## License

MIT
