# oep-client-js

[日本語](README.ja.md)

npm: `oep-client-js`, as the repository (and as oep-client-python on PyPI).

The JavaScript host side of [Open Embedded Probe (OEP)](https://github.com/Open-Embedded-Probe/oep-spec): talk to OEP
probes from a browser or Node, set them up and update their firmware. A web page built on it, **OEP Probe Tool**, runs on
GitHub Pages: <https://open-embedded-probe.github.io/oep-client-js/>.

## Status

**A first full port, ahead of the v1 freeze: expect it to be redone as the spec settles.**

**The spec this implements: oep-spec commit `59dd028`** (no `v0.x` tag yet; oep-spec versioning §6 - before the freeze,
revision 1 alone does not fix the forms, so an implementation names the spec it implements). That is the 2026-10-06
simplification (one 10-byte request header, TLV len u16, closed fixed forms, the `ops` describe tag, no resume,
`oep.link`), the console's send queue and the reset settle wait (f0c68bf), a longer probe.config item (d34dafa),
oep.link source's len (4bd3a87) and an attach joining a connection (59dd028); the same spec as oep-client-python. Until the freeze the Japanese text (`.ja.md`) is
the specification's working text.

What is there:

- the core: the registry (generated from oep-spec), frames (COBS + CRC, length), messages, the link (corr matching, one
  resend, pipelining, pushes and events; every answer waited at least core §4.4's floor - argument time + 1000 ms + a
  serial port's transfer time, `Link.waitFloorMs` -; the transports §5 resync on length frames, its confirm 250 ms after the
  host's last write, none for a pause inside a TCP frame; an unanswered resend fails the transport, `TransportFailed`,
  and the next request first recovers with a confirm, COBS included; a frame shorter than its header is broken; fn 0's
  heartbeats read and their boot_id watched), the host (confirm - `limits.transport`, the index this host came in on;
  later confirms ask for the revision in use; one outside core §7.1's bounds, or a max_op_ms outside 1..600000, makes the
  probe `NotUsable` -, session - every open a new one under a new random id in the request header; end, a lapsed lease
  or force release everything the session made, and a request of an ended session is `NoSession` (no resume) -, lock,
  subscribe), list / describe (each fn's `ops`: `core.ops` / `offers`, `Interface.ops()` / `.offers(op)`; `core.require`
  throws, without sending, the same `Rejected` with detail unknown_operation the probe answers) / plan;
- the interfaces: the debug wires (rvswd, swio, swd) and riscv-dm, ARM ADI / MEM-AP / Cortex-M, the target console, the
  fixtures (gpio, uart, i2c-target, spi-target), the captures (logic, analog, capture-group, sigrok .sr), probe.config and
  the `oep dump` view;
- the transports: WebSerial, WebUSB (vendor bulk), WebHID in the browser; TCP, serial ports (`serialport`) and USB (`usb`)
  in Node (the native packages optional); serial ports open 8N1 without flow control, DTR and RTS asserted (transports §4);
  a USB probe is found by the project's USB VID:PID `1209:4F45` alone (transports §3: the WebUSB / WebHID choosers' default
  filter, Node's `findUsbProbes` / `findSerialProbes` / `findProbes`, `openUsb()` - exactly one probe on it is opened, by
  vendor bulk, else its CDC port; several: `SeveralProbesError` lists them, name one); the
  WebSerial chooser has no default filter, so a UART bridge or a built-in USB serial stays selectable;
- the firmware update: USB DFU (the ESP32-P4) and the Release's firmware-<version>.json;
- the page: connect, read what the probe declares, edit and save its settings, GPIO and UART, port_speed, a DFU update;
- port_speed (oep-if-link §3 is the handshake, an op of the optional interface `oep.link` that the probe offers when its
  ops set it; the procedure is the oep-spec host guide §17, opt-in):
  `raiseSpeed(host, candidates = [500000], { flows, verify, baseline, frames, verifyMs, idleMs, port, record })` (or
  `portSpeed: true | [candidates]` with `flows` / `verify` / `record` on `connect` / `openWebSerial` / `openSerial`) runs
  a UART bridge faster for the session. The **minimal form** (the default, about 50 ms, no measurement): each candidate
  in order - `try` (answered at the speed now, then the probe switches) -> the host switches to the requested baud (the
  probe's answered baud only when the platform refuses it) -> 20 ms -> a `confirm` (100 ms, up to 3) -> `commit`. The
  **full form** (`verify: true`, or `flows` given): a baseline at the boot speed per flow (this session's frames, or 60
  measured), then for each candidate every flow the session will use - `flows` of `'in' | 'out' | 'duplex'` or
  `[flow, n]` (in = oep.link source probe -> host, out = oep.link sink host -> probe, duplex = both interleaved; `n` in flight,
  0 = the most the link keeps) - 16 frames at max_frame - 26 (oep-if-link §2), counting broken and lost and measuring KB/s; a flow fails
  on broken + lost >= 3 over max(2 x baseline, 5 %), runs once more at n = 1 first (then n = 1 is the link's cap,
  `inflightCap`), and one failed flow fails the candidate. A failed candidate reverts (step 2) and goes back to the boot
  speed, confirmed there. The first candidate that passes is kept; a rate the probe's UART cannot make is skipped. The
  report (`host.link.speed`: `base`, `rate`, `chosen`, `baseline`, `trials` with `flows`, `inKBs` / `outKBs` /
  `duplexKBs`, `stepDowns`, `skipped`; `speedText(report)`) is there to budget a capture or a write. WebSerial changes
  the rate by closing and opening the same port again (DTR / RTS asserted again together at once), Node's
  `serialport` by `update`. An `end` or a revert takes the link back to the boot speed at once; while raised the link
  sends a keepalive when quiet for less than half of `idleMs` (1 s), and `host.link.keepAlive()` does the same for a
  caller that sits idle. A request unanswered at a raised rate falls back to the boot speed, confirmed within
  port_speed_idle_max_ms + 1 s (an Error when no confirm comes, never the raised rate again), and goes once more there;
  each wait is at most a quarter of the lease. In use, a committed rate's first 32 KiB and 1 s (`probationBytes`,
  `probationMs`) are its probation: 3 or more broken or lost frames over max(2 x baseline, 5 %), or a missed answer,
  count as a verify failure and step down at once (the 16-frame verify stays the quick gate). After it the link judges
  the frames of the last 3 s (none under 50): over max(2 x baseline, 10 %) broken or lost steps down. A step down is
  port_speed revert, the boot speed, a confirm, then the next lower candidate of that call that has not failed in the
  session (a fresh try -> confirm -> verify -> commit; none left: the boot speed); a rate that broke stays unused for
  the session, and so does every rate above it (`speed.steppedDown`, `downWhy`, `stepDowns` with `to` and
  `probation`). `maxTries` bounds the candidates one call tries (a capture host wants 2). `record: true` (off by
  default; or a file path, or a `speedrecord.SpeedRecord`) keeps passed / failed rates - a pass for 30 days, a failure
  for 1 day, a failure measured within 2 s (`settleMs`) of a breakdown at another rate as unknown - in Node per (port
  path, unit_id) in `~/.cache/oep-client/link-speed.json` (`$XDG_CACHE_HOME`; the same file as oep-client-python's),
  in a browser in localStorage by unit_id - and puts a passed rate first, failed ones out (`report.skipped`; every
  candidate failed: the slowest is tried once, `report.retried`); an `x-` unit_id (core §7.5) keys nothing. The port
  raised is the one this host came in on (confirm's transport TLV) when that is a UART bridge. The same procedure as
  oep-client-python.
- the console (oep-if-console): a write goes into the stream's send queue (describe 0x41, `Console.sendQueue()`, at least
  64 bytes) and is answered with what fitted; `ConsoleIO` writes a send queue at a time and goes on from each
  `accepted`. A stream is the probe's per connection and mechanism: a closed one stays readable until the next open,
  which gives the same number back.
- resets that settle (oep-if-debug §3, §4.3): `Wire.attachMs(reset)` adds hold_ms + reset_settle_ms (700) to
  attach_budget_ms when the attach carries the reset TLV, `RiscvDm.resetMs()` is reset_settle_ms - the argument time of
  the host's wait.
- block operations: riscv-dm / arm-adi `readBlock` / `writeBlock` are bounded by the probe's declared `max_length`
  (`RiscvDm` / `ArmAdi` `.maxLength` bytes, `.maxWords`; oep-if-debug §4.5 / §6) - `MemAp` chunks by it, and a probe
  with block ops that declares none throws `riscv.NoMaxLength`; nothing is derived from max_frame.
- gpio output strength (oep-if-fixture §1.1): `Gpio.set([[ch, mode, Drive.maxMa(10)]])` (a drive per output element,
  `Drive.level(n)` or a number for a level) returns the answer's ignored list; `driveLevels()` -> `DriveLevels`
  (`defaultLevel`, `ma`, `pick(drive)`), `readState(channels)` -> `{ levels, drive }` (the level in force); the
  settings' `Idle({ ..., drive })`, `Slot({ ..., bootReset: true })` (the at-boot retry with reset) and
  `SlotState.resetAtNs`; `config.findLine(config, slotName, 'nrst')` is probe.config §1.3's line lookup, the
  firmware's fixed labels as its step (c) (`lineFromLabels` the same on bare data).
- the rule changes of 2026-10-02 (oep-spec `docs/v1-rule-change-proposal-2026-10-02.md`), host side: attach and scan
  wait their budgets (`attachMs`, `scanMs`); `Unsupported.supported` (confirm's range); an `x-` unit_id names no USB
  device; text from an answer is shown without control characters (`message.shown`), open's owner is cut on a
  character (`ownerText`), a label the probe would refuse is not sent; `Tail.moreIgnored` (an ignored list ending in
  0x00); `dump` names what core §1.2 requires and the probe did not give (`missing`); capture's mode / rate / trigger /
  pretrigger / frontend always go critical, a start's blocking_ms is waited out with nothing sent (then a resync on
  length frames); `Wire.searchRetries`, `riscv.StepError` (`stepLeft`), `I2cTarget.pullupOhms()`, the capture mode with
  its background in describe.

The wire is oep-spec's 2026-10-06 simplification of the zero-base rewrite of 2026-10-01 (one request header with
session_id, one TLV form, sequences without element lengths, closed fixed forms, the `ops` tag, no resume, `oep.link`;
see the changelog). Tested against oep-client-python's fake probe and scripted devices (281 tests, oep-spec's test
vectors among them, sessions.json and ops.json included); the browser transports, DFU and the page are not yet checked on
hardware.

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
npm test            # needs python -m pip install oep-client-python (the fake probe); test/vectors are oep-spec's
npm run typecheck
npm run serve       # the page at http://localhost:4173/
```

## Documents

- Specification: [oep-spec](https://github.com/Open-Embedded-Probe/oep-spec) (the English text is authoritative) - start
  with its [README](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/README.md) and [review guide](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/review-guide.md);
  [getting started](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/getting-started.md) builds the smallest probe and host,
  [docs/oep-core.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/oep-core.md) is the protocol core, and
  [docs/conformance.md](https://github.com/Open-Embedded-Probe/oep-spec/blob/main/docs/conformance.md) says what a host must do to conform
- [Design](docs/design.md): layers, transports, what the page does, tests, the registry, versions
- [Releasing](docs/release.md)
- [Changelog](CHANGELOG.md)

## License

MIT
