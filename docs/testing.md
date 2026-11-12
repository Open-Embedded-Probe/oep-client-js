# Isolated JavaScript test environment

Use Node 22 or newer, npm and uv. The virtual OEP backend is pinned by commit in `test/virtual-bench/pyproject.toml` and by `uv.lock`, installed into this repository's own environment. Tests do not search sibling checkouts or equipment inventories.

```sh
npm ci
uv sync --project test/virtual-bench --locked
OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
```

An explicitly selected Python missing the virtual module is a preparation error. `OEP_REQUIRE_VIRTUAL_BENCH=1` also makes the dependency mandatory. With neither setting, tests use `python3` and may skip optional virtual integration cases if the backend is absent; this does not complete release verification.

CI, Pages and Release use the same setup action and require the pinned backend. Update its commit and lock together, then verify integration, types and distribution artifacts. This test dependency does not impose a minimum physical probe firmware version. Virtual success does not certify physical USB operation or firmware transfers.

## Browser workspace

```sh
npm run test:browser
# An alternative browser / prepared virtual backend:
OEP_CHROME=chromium OEP_PYTHON=/path/to/python npm run test:browser
```

The test starts its own headless Chromium, static HTTP server and Python virtual probe. A test-only HTTP byte transport
connects the real browser host library to the virtual probe; it is never included in the published page.
It checks the public pages and old addresses; the ESP32 install (a simulated ROM: offset zero, the same serial port reused, a
retry that does not write again); the Pico install by BOOTSEL (the one new device opened without another chooser); the
Pico and P4 (DFU) updates; connecting with the purpose kept; wiring registered with the target absent (no scan, attach or
pin assignment; the part and note go to the memo area), editing and the connection check; debug operations and the
debug-wire console; UART, GPIO, I2C, SPI, PWM, counter, DAC and the I2C / SPI peers; debug and UART at once;
passthrough, idle pins and Wi-Fi; settings and memo backups restored after their difference is shown; capture
preparation; hand-over; a 390 px wide screen. DAC and Wi-Fi run on a second virtual probe (the classic ESP32 profile). CI
runs it after `npm run check`. Flashing, DFU, the boot ROM, USB permission dialogs and electrical signals are stand-ins
or out of scope here and are checked on hardware.
