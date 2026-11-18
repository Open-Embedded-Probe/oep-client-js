# Publishing the page

English | [日本語](publish.ja.md)

For maintainers. Nothing here goes to npm (`package.json` is `private`): what reaches users is OEP Probe Tool on GitHub
Pages. A push to `main` makes `pages.yml` build and publish the site; it is also rebuilt once a day to take the latest
oep-probe-arduino Release's firmware.

## Before pushing

1. No change you did not mean (`git status --short`, `git diff --check`).
2. The tests, against the pinned virtual bench ([testing](testing.md)):

   ```sh
   OEP_PYTHON="$PWD/test/virtual-bench/.venv/bin/python" OEP_REQUIRE_VIRTUAL_BENCH=1 npm run check
   npm run test:browser
   npm run build:site
   ```

3. When screens or transports changed, open `npm run serve` in a Chromium browser (Chrome or Edge) with a real probe:
   - one connection per way in (USB serial, USB (OEP device), USB HID), and the overview shown
   - wiring registered and its connection check, probe settings applied and saved (put back afterwards), the settings
     exported and imported
   - making and updating a probe (ESP32 over serial, P4/P4X by DFU, RP2040/RP2350 by PICOBOOT); writing the same version
     again is the safe test
   - HID also with `node scripts/check-hid.mjs /dev/hidrawN` ([testing](testing.md))
4. `CHANGELOG.md`'s `## Unreleased` has the change, as an `(EN)` / `(JA)` pair.

## After publishing

- Open <https://open-embedded-probe.github.io/oep-client-js/> directly: the device APIs work over HTTPS and no old cache
  is left. Repeat 3 as far as you can.

## Marking a point

To mark a point, move the entries under `## Unreleased` in `CHANGELOG.md` under a version heading (for example
`## 0.1.0 — 2026-11-20`), set `VERSION` in `src/index.js` and `version` in `package.json` to it, and tag the commit. The
page's footer shows `VERSION`. It is not an npm version.

## GitHub Actions

- `ci.yml`: on pushes to `main` and pull requests, with the pinned virtual bench: the tests and type checks, the browser
  test, the site build.
- `pages.yml`: on pushes to `main`, by hand and daily: the site built with the latest Release's firmware and published to
  GitHub Pages.
