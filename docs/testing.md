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
It checks direct routes, resuming a requested screen after connecting, capability forms, GPIO/PWM/UART/I2C/SPI/counter/DAC operations,
target debugging, settings, language switching, mobile width and session cleanup. A simulated ESP ROM verifies initial installation at offset zero, progress, reset, serial cleanup and the post-install connection. The actual bundled loader is also imported in Chromium. Unit tests reject wrong chips, images and P4 revisions, and check cleanup after failures. Real USB permission dialogs, electrical
signals and firmware flashing require hardware verification.
