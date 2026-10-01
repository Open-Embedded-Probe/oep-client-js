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
- port_speed (oep-core §3.5 is the handshake; the procedure is the oep-spec host guide §7, opt-in):
  `raiseSpeed(host, candidates = [500000], { flows, verify, baseline, frames, verifyMs, idleMs, port, record })` (or
  `portSpeed: true | [candidates]` with `flows` / `verify` / `record` on `connect` / `openWebSerial` / `openSerial`) runs
  a UART bridge faster for the session. The **minimal form** (the default, about 50 ms, no measurement): each candidate
  in order - `try` (answered at the speed now, then the probe switches) -> the host switches to the requested baud (the
  probe's answered baud only when the platform refuses it) -> 20 ms -> a `confirm` (100 ms, up to 3) -> `commit`. The
  **full form** (`verify: true`, or `flows` given): a baseline at the boot speed per flow (this session's frames, or 60
  measured), then for each candidate every flow the session will use - `flows` of `'in' | 'out' | 'duplex'` or
  `[flow, n]` (in = link_source probe -> host, out = link_sink host -> probe, duplex = both interleaved; `n` in flight,
  0 = the most the link keeps) - 16 frames at max_frame - 16, counting broken and lost and measuring KB/s; a flow fails
  on broken + lost >= 3 over max(2 x baseline, 5 %), runs once more at n = 1 first (then n = 1 is the link's cap,
  `inflightCap`), and one failed flow fails the candidate. A failed candidate reverts (step 2) and goes back to the boot
  speed, confirmed there. The first candidate that passes is kept; a rate the probe's UART cannot make is skipped. The
  report (`host.link.speed`: `base`, `rate`, `chosen`, `baseline`, `trials` with `flows`, `inKBs` / `outKBs` /
  `duplexKBs`, `stepDowns`, `skipped`; `speedText(report)`) is there to budget a capture or a write. WebSerial changes
  the rate by closing and opening the same port again (DTR / RTS released at once, as esptool-js does), Node's
  `serialport` by `update`. An `end` or a revert takes the link back to the boot speed at once; while raised the link
  sends a keepalive when quiet for less than half of `idleMs` (1 s), and `host.link.keepAlive()` does the same for a
  caller that sits idle. A request unanswered at a raised rate falls back to the boot speed, confirmed within
  port_speed_idle_max_ms + 1 s (an Error when no confirm comes, never the raised rate again), and goes once more there;
  each wait is at most a quarter of the lease. In use the link judges the frames of the last 3 s (none under 50): over
  max(2 x baseline, 10 %) broken or lost steps down (port_speed revert, the boot speed, a confirm) and the rate stays
  unused for the session (`speed.steppedDown`, `downWhy`, `stepDowns`). `record: true` (off by default; or a file path,
  or a `speedrecord.SpeedRecord`) keeps passed / failed rates for 30 days - in Node per (port path, unit_id) in
  `~/.cache/oep-client/link-speed.json` (`$XDG_CACHE_HOME`; the same file as oep-client-python's), in a browser in
  localStorage by unit_id - and puts a passed rate first, failed ones out (`report.skipped`). The same procedure as
  oep-client-python.
- block operations: riscv-dm / arm-adi `readBlock` / `writeBlock` are bounded by the probe's declared `max_length`
  (`RiscvDm` / `ArmAdi` `.maxLength` bytes, `.maxWords`; oep-if-debug §4.5 / §6) - `MemAp` chunks by it, and a probe
  with block ops that declares none throws `riscv.NoMaxLength`; nothing is derived from max_frame.

The wire is oep-spec's zero-base rewrite of 2026-10-01 (every answer carries its lengths, TLVs have a long form, confirm
answers the boot_id, `expired`, probe.config's `state` / `unset` / `uart`, the attach reset TLV, capture generations; see
the changelog). Tested against oep-client-python's fake probe (148 tests) and scripted devices; the browser transports,
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
