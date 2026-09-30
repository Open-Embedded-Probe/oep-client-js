# oep-client-js

[日本語](README.ja.md)

The JavaScript host side of [Open Embedded Probe (OEP)](https://github.com/Open-Embedded-Probe/oep-spec): talk to OEP
probes from a browser or Node, set them up and update their firmware. A web page built on it, **OEP Probe Tool**, runs on
GitHub Pages: <https://open-embedded-probe.github.io/oep-client-js/>.

## Status

**Scaffold only: nothing is implemented yet.** The layout, the release tooling and the design are in place; the code
comes in this order ([design](docs/design.md) §4):

1. the numbers generated from oep-spec's registry;
2. updating a probe's firmware from the page (the ESP32-P4's DFU over WebUSB, esptool-js for the ESP32, the RP2's UF2 steps);
3. the core (frames, the session and the lock, describe) and the probe's settings (`oep.probe.config`);
4. the standard interfaces, once the v1 spec is frozen.

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
