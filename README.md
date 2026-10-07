# oep-client-js

[日本語](README.ja.md)

npm: `oep-client-js`, as the repository (and as oep-client-python on PyPI).

The JavaScript host side of [Open Embedded Probe (OEP)](https://github.com/Open-Embedded-Probe/oep-spec): talk to OEP
probes from a browser or Node, set them up and update their firmware. A web page built on it, **OEP Probe Tool**, runs on
GitHub Pages: <https://open-embedded-probe.github.io/oep-client-js/>.

## Status

**A first full port, ahead of the v1 freeze: expect it to be redone as the spec settles.**

**The spec this implements: oep-spec commit `2c6d18d`** (no `v0.x` tag yet; oep-spec versioning §6 - before the freeze,
revision 1 alone does not fix the forms, so an implementation names the spec it implements). That is the interface
re-check of 0991759 (0098b56 .. 2c6d18d: marks and capture segments page by serial from from_serial inclusive, console
streams' first is u16, capture's configure contract, generations that wrap past 0xFFFFFFFF to 1 and ride on every event,
the capture-group start answer's fixed part, step / run / transfer details, spi-target bit packing), the 2026-10-06
simplification (one 10-byte request header, TLV len u16, closed fixed forms, the `ops` describe tag, no resume), the
console's send queue and the reset settle wait (f0c68bf), a longer probe.config item (d34dafa), an attach joining a
connection (59dd028) and the 2026-10-06 structure (2e5dc4c .. 9c837a9, 0304f37): the core has no name (fn 0, never
listed), the plan, restart and link test are the interfaces `oep.probe.plan`, `oep.probe.restart` and `oep.probe.link`,
subscribe / unsubscribe are ops 0x30 / 0x32 of the interface that sends the notifications (no heartbeat), fn 0's `clock`
gives the probe's time (read while it handles the request; e0d9dc6, 498ae95) - and the rule review of 2026-10-07
(7688c49 .. 0f455a0, `docs/v1-rule-review-2026-10-07.ja.md` §2 / §7) with the external review re-check and the fixes
after it (283e5b5 .. f8bb2de): no ignored TLV (an unknown non-critical TLV is ignored without a trace, an implemented one
is checked the same with or without bit 7), the resend table is (corr, answer), list takes `first` alone, the probe's
internal times leave the text (attach, scan and riscv-dm's reset answer within max_op_ms), port_speed is the handshake
(baud, step, verify_ms), probe.config without slot lock / boot_reset and one stream a bind, gpio drive a u8 level,
interface names 1 to 48 bytes, and a host that may run again ends the session its previous run left (host guide §5) -
and after it (c2b8007 .. 30b2b36) probe.config's wifi item with its write-only passphrase, unset's len counting the key
alone, and TCP discovery (DNS-SD `_oep._tcp` over mDNS, transports §3), and (29902a6 .. 9118dc0) a probe with the wifi
item answering max_frame 112 or more on every transport (`wifi_min_max_frame`) and TCP advertising as the probe's choice.
Until the freeze the Japanese text (`.ja.md`) is the specification's working text.

What is there:

- the core: the registry (generated from oep-spec), frames (COBS + CRC, length), messages, the link (corr matching, one
  resend after a wait, up to 3 at once after a broken frame on a held serial port (host guide §8), pipelining, pushes
  and events; every answer waited at least core §4.4's floor - argument time + 1000 ms + a
  serial port's transfer time, `Link.waitFloorMs` -; the transports §5 resync on length frames, its confirm 250 ms after the
  host's last write, none for a pause inside a TCP frame; an unanswered resend fails the transport, `TransportFailed`,
  and the next request first recovers with a confirm, COBS included; a frame shorter than its header is broken), the host
  (confirm - `limits.transport`, the index this host came in on; later confirms ask for the revision in use; one outside
  core §7.1's bounds, a max_op_ms outside 1..600000 or an fn 0 ops outside core §7.4's form makes the probe
  `NotUsable`, an fn's ops outside it that fn `FnNotUsable` -, `clock()` - fn 0's clock against this host's
  `performance.now()`: `{ hostBeforeMs, hostAfterMs, roundTripMs, uptimeNs, bootId }`, the probe's time matching the
  midpoint within half the round trip -, session - every open a new one under a new random id in the request header; end, a lapsed lease
  or force release everything the session made, and a request of an ended session is `NoSession` (no resume); a
  closed transport does not end it, so `connect` (`keepSession`, default on) keeps the open session's id per probe -
  Node: `<unit_id>.session` under `$OEP_SESSION_DIR`, `$XDG_RUNTIME_DIR/oep-client` or the user's cache directory, the
  same file as oep-client-python's; a browser: localStorage with a Web Lock - and the next run's first open opens that
  id and ends it at once (`Host.endPrevious`, `keptsession.KeptSession`, host guide §5) -, lock,
  subscribe - `subscribe(fn, minBytes, maxDelayMs)` / `unsubscribe(fn)`: fn's own ops 0x30 / 0x32 (core §11.3) -,
  restart - `requestRestart()`, and `restartProbe({ reopen, waitMs })`: oep.probe.restart's restart (found by name), then
  wait a moment (about 100 ms, host guide §5.2), open again through `reopen` when given (or keep the link) and confirm,
  retried until the probe's restart_max_ms (`core.restartMaxMs`, that interface's describe, read before the restart; a
  longer `waitMs` is cut to it; 10 s when it declares none; past it the probe is gone and the last error is thrown), and return the new boot_id, `NotRestarted` when it
  stayed the same), list / describe (list pages by `first` alone and the host keeps the names under a prefix on label
  boundaries; each fn's `ops`: `core.ops` / `offers`, `Interface.ops()` / `.offers(op)`;
  `core.require` throws, without sending, the same `Rejected` with detail unknown_operation the probe answers) / plan
  (`core.planApply` / `planRelease` / `planRoles` on oep.probe.plan, found by name);
- the interfaces: the debug wires (rvswd, swio, swd) and riscv-dm, ARM ADI / MEM-AP / Cortex-M, the target console, the
  fixtures (gpio, uart, i2c-target, spi-target), the captures (logic, analog, capture-group, sigrok .sr), probe.config and
  the `oep dump` view;
- the transports: WebSerial, WebUSB (vendor bulk), WebHID in the browser; TCP, serial ports (`serialport`) and USB (`usb`)
  in Node (the native packages optional); serial ports open 8N1 without flow control, DTR and RTS asserted (transports §4);
  a USB probe is found by the project's USB VID:PID `1209:4F45` alone (transports §3: the WebUSB / WebHID choosers' default
  filter, Node's `findUsbProbes` / `findSerialProbes` / `findProbes`, `openUsb()` - exactly one probe on it is opened, by
  vendor bulk, else its CDC port; several: `SeveralProbesError` lists them, name one); the
  WebSerial chooser has no default filter, so a UART bridge or a built-in USB serial stays selectable; a probe on TCP
  (Node only - a browser can neither open TCP nor send mDNS, so the page has no TCP) is opened by `openTcp({ host, port
  })`, and no port is fixed (transports §3): `openTcp({ host })` takes the port its DNS-SD `_oep._tcp` record announces,
  `openTcp({ unitId })` opens the probe whose TXT `unit_id` it is (describe's unit_id checked after opening, as for any
  named probe), and `browse()` / `findUnit()` / `portOf()` (`oep-client-js/node`, src/node/discovery.js) are the
  dependency-free mDNS query behind them (sent out of every IPv4 interface, `interfaceAddresses()`, the answers merged; IPv4, the local link only: behind a NAT or across subnets nothing is found -
  give host and port; the address is also the wifi state's `ipv4` over another transport). The service name `oep` is
  not registered, so another service may advertise `_oep._tcp` (host guide §4.1): `verifyFound(found)` checks every
  instance at once - a TCP connection, confirm (an `OEP!` answer) and fn 0's describe, whose unit_id must be the TXT
  unit_id, 1 s per answer, no session opened - and `browse({ verify: true, onDropped })` keeps only those; `findUnit()`
  (and so `openTcp({ unitId })`) verifies by default and passes over an instance it cannot verify (`verify: false`: the
  first announced one);
- the firmware update: USB DFU (the ESP32-P4) and the Release's firmware-<version>.json;
- the page: connect, read what the probe declares, edit and save its settings, GPIO and UART, port_speed, a DFU update;
- port_speed (oep-if-link §3 is the handshake, an op of the optional interface `oep.probe.link` that the probe offers when its
  ops set it; the procedure is the oep-spec host guide §17, opt-in):
  `raiseSpeed(host, candidates = [500000], { flows, verify, baseline, frames, verifyMs, record })` (or
  `portSpeed: true | [candidates]` with `flows` / `verify` / `record` on `connect` / `openWebSerial` / `openSerial`) runs
  a UART bridge faster for the session; the request is baud, step and verify_ms, on the port it comes in on (`speed.speedRequest`).
  **The default ceiling is 500000** (host guide §17): the default
  candidate is 500000 alone, and a rate above `speed.DEFAULT_CEILING` goes in the candidates only when the user named it
  (the page's rates field, a setting). Such a rate, in the minimal and the full form alike, is committed only after its
  **1 s verify** (host guide §17.3.3): in the try state, full frames (source max_frame - 7, sink max_frame - 12) of oep.probe.link source (in) and
  sink (out), and duplex too when the full form verifies it, each for at least 1 s (`speed.FAST_VERIFY_MS`) at its n,
  judged as a flow is, no second run at n = 1; its try asks verify_ms 4000 (6000 with duplex), so it needs a lease of
  5000 (7000) ms or more (`speed.leaseFor(candidates, { flows, verify })`; `connect` takes at least that, a shorter
  lease skips the candidate). Committed, it has the probation and in-use judging of any rate (why: on a bridge, 921600
  passed 16 full frames each way and still broke answers in every 9 KiB upload; 500000 was clean on every bridge
  measured). The **minimal form** (the default, about 50 ms, no measurement): each candidate
  in order - `try` (answered at the speed now, then the probe switches) -> the host switches to the requested baud (the
  probe's answered baud only when the platform refuses it) -> 20 ms -> a `confirm` (100 ms, up to 3) -> `commit`. The
  **full form** (`verify: true`, or `flows` given): a baseline at the boot speed per flow (this session's frames, or 60
  measured), then for each candidate every flow the session will use - `flows` of `'in' | 'out' | 'duplex'` or
  `[flow, n]` (in = oep.probe.link source probe -> host, out = oep.probe.link sink host -> probe, duplex = both interleaved; `n` in flight,
  0 = the most the link keeps) - 16 full frames (oep-if-link §2), counting broken and lost and measuring KB/s; a flow fails
  on broken + lost >= 3 over max(2 x baseline, 5 %), runs once more at n = 1 first (then n = 1 is the link's cap,
  `inflightCap`), and one failed flow fails the candidate. A failed candidate reverts (step 2) and goes back to the boot
  speed, confirmed there. The first candidate that passes is kept; a rate the probe's UART cannot make is skipped. The
  report (`host.link.speed`: `base`, `rate`, `chosen`, `baseline`, `trials` with `flows`, `inKBs` / `outKBs` /
  `duplexKBs`, `stepDowns`, `skipped`; `speedText(report)`) is there to budget a capture or a write. WebSerial changes
  the rate by closing and opening the same port again (DTR / RTS asserted again together at once), Node's
  `serialport` by `update`. An `end`, a revert or a restart takes the link back to the boot speed at once; while raised the link
  sends a keepalive when quiet for 1 s (under half of port_speed_idle_ms, 3 s), and `host.link.keepAlive()` does the
  same for a caller that sits idle. A request unanswered at a raised rate goes again at that rate first - its first
  wait at most `RAISED_FIRST_WAIT_MS` (a third of port_speed_idle_ms) and a quarter of the lease, never under core
  §4.4's floor (host guide §17.3.2 item 4) - and only when that gets no answer either falls back to the boot speed,
  confirmed within port_speed_idle_ms + host_wait_add_ms (an Error when no confirm comes, never the raised rate
  again), and goes once more there. In use, a committed rate's first 32 KiB and 1 s (`probationBytes`,
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
- the console (oep-if-console): a write goes into the stream's send queue (the probe's own size, not declared) and is
  answered with what fitted; `ConsoleIO` writes at most a frame at a time and goes on from each `accepted`. A stream is the probe's per connection and mechanism: a closed one stays readable until the next open,
  which gives the same number back.
- the debug waits (oep-if-debug §1, §4.3): attach, scan and riscv-dm's reset answer within max_op_ms, the argument time
  of the host's wait (`Wire.attachMs()`, `scanMs()`, `RiscvDm.resetMs()`; `core.FALLBACK_MAX_OP_MS` for a probe that
  declares none). riscv-dm's reset answers status flags pc (`reset({ confirm })` -> `{ flags, pc }`, no method); a run
  whose preparation failed is stopped 3 (`RunResult.notRun`); `readRegister` keeps DATA0 (`dataSaved`) and `resume` /
  `step` / `run` write it back first (`restoreData`, debug §4); target_id scheme `dmi_7f` (`Wire.SCHEME_DMI_7F`).
- block operations: riscv-dm / arm-adi `readBlock` / `writeBlock` are bounded by the probe's declared `max_length`
  (`RiscvDm` / `ArmAdi` `.maxLength` bytes, `.maxWords`; oep-if-debug §4.5 / §6) - `MemAp` chunks by it, and a probe
  with block ops that declares none throws `riscv.NoMaxLength`; nothing is derived from max_frame.
- gpio output strength (oep-if-fixture §1.1): `Gpio.set([[ch, mode, Drive.level(1)]])` (a drive per output element,
  a u8 level - 0xFF `Drive.default()` - sent critical; a level past drive_levels, or any drive on a probe without them,
  is refused `Unsupported`); `driveLevels()` -> `DriveLevels` (`defaultLevel`, `ma`, `pick(drive)`, `atMost(ma)`: a
  strength carried between probes); read gives the levels alone; the settings' `Idle({ ..., drive })` (4 bytes);
  `config.findLine(config, slotName, 'nrst')` is probe.config §1.3's line lookup, the firmware's fixed labels as its
  step (c) (`lineFromLabels` the same on bare data).
- the fixtures: i2c-target has one form (`configure(address)`, every write with data one frame, reads from
  `preloadTx` slots or 0xFF, `status()` -> `{ state, queued, rxFrames, txSlots, errors }`, `internalPullups()`;
  stretch an optional op), spi-target has no reset, uart's `status()` is `{ baud, format }`.
- probe.config: a slot has no lock or boot_reset (the host checks the target with connections' tid), `SlotState` is
  `{ slot, state: connected | absent, connection, lastTryAtNs }`, a bind carries one stream (`Bind({ port, stream:
  ['slot', n] | ['uart', fn] })`, `BindState` `{ port, flow }`), the idle item is 4 bytes; the hash is the probe's own -
  a host compares items (`config.sameItems`), `ProbeConfig.needsSave()` and `apply(wanted, { save })` (host guide §15);
  an unset element's len counts the key's bytes alone (`config.remove(kind, key)`).
- Wi-Fi (probe.config §1.4, §3.3; host guide §15.1): `config.Wifi({ index, ssid, passphrase })` - passphrase null (an
  open network), `config.KEEP` (keep the entry's: get's form, pass_len 0xFF) or 8-63 printable ASCII characters / 64
  hex digits. The passphrase is write-only: get never returns it (decoded as `KEEP`), it is a private field (not in
  `console.log`, `util.inspect` or `JSON.stringify`; `toString()` / `shown()` say set / none), a refused one's error does
  not carry it; `sameItems` and `apply` compare a wifi item without it and send it only for an entry that changes.
  `describe()` gives `wifiMax`, `state()` gives `wifi` (`WifiState`: state, entry, reason, rssi, ipv4; `text()`). The
  page's Wi-Fi form takes the passphrase in a password field that is cleared once read and never filled back (empty:
  keep; "open": none).
- capture: configure's TLVs follow core §2.3 alone (a value the probe does not handle is `Unsupported` with the tag as
  received); the answer has no timing or rate_accuracy; describe's mode is mode max_samples max_segments.
- the rule changes of 2026-10-02 (oep-spec `docs/v1-rule-change-proposal-2026-10-02.md`), host side: attach and scan
  wait their budgets (`attachMs`, `scanMs`); `Unsupported.supported` (confirm's range); an `x-` unit_id names no USB
  device; text from an answer is shown without control characters (`message.shown`), open's owner is cut on a
  character (`ownerText`), a label the probe would refuse is not sent; `dump` names what core §1.2 requires and the probe did not give (`missing`); capture's mode / rate / trigger /
  pretrigger / frontend go critical (this host's choice), a start's blocking_ms is waited out with nothing sent (then a resync on
  length frames); `Wire.searchRetries`, `riscv.StepError` (`stepLeft`).

The wire is oep-spec's 2026-10-06 simplification of the zero-base rewrite of 2026-10-01 (one request header with
session_id, one TLV form, sequences without element lengths, closed fixed forms, the `ops` tag, no resume; see the
changelog), with the 2026-10-06 structure (the nameless core, the oep.probe interfaces, notifications per interface).
Tested against oep-client-python's virtual bench (a probe, the targets behind it and the fixture wiring, modelled after
the real jigs: `python -m oep_client.virtual_bench_serve`) and scripted devices (331 tests, oep-spec's test
vectors among them, sessions.json, ops.json and ops_encoding.json included); the browser transports, DFU and the page are not yet checked on
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
| `test/` | - | `node:test`, against oep-client-python's virtual bench over TCP |

JavaScript with JSDoc types (`// @ts-check`, checked with `tsc`), ES modules, no runtime dependencies. WebUSB, WebSerial
and WebHID need a Chromium browser (Chrome, Edge) and HTTPS.

## Development

```sh
npm install
npm test            # needs python -m pip install oep-client-python (the virtual bench); test/vectors are oep-spec's
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
