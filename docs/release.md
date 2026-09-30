# Release procedure

English | [日本語](release.ja.md)

This document is for maintainers. As with the sibling tools (wireskein-web and others), the normal npm publication path
runs from a maintainer workstation.

## Pre-release review

1. Confirm that `main` is current and contains no unintended changes.
2. Review the [README](../README.md), the [design](design.md) and the changelog.
3. Confirm `npm test` passes against oep-client-python's fake (`python -m oep_client.fake_serve`), as CI does.
4. Run `npm run serve`, open the page in a Chromium browser (Chrome or Edge) and connect to a real probe. Check what you
   can:
   - one connection per transport (WebSerial, WebUSB, WebHID), and describe shown
   - settings shown, changed, saved and erased (put them back afterwards)
   - a firmware update (the P4's DFU, the ESP32's esptool-js); writing the same version again is the safe way
5. After pushing `main`, open <https://open-embedded-probe.github.io/oep-client-js/> directly and repeat step 4 (WebUSB
   and the others work over HTTPS, no stale cache).

Automated checks:

```sh
npm run check
npm run build
npm run types
npm run smoke:dist
npm run build:site
npm pack --dry-run
git diff --check
git status --short
```

The package dry run should contain `dist`, `src`, `types`, the READMEs, changelog and license, and not `web`, `site` or
the tests. The web page is served from GitHub Pages, not from the npm tarball.

## Changelog and version

Record each change under `## Unreleased` in `CHANGELOG.md` as an `(EN)` and `(JA)` pair. Check that the section is not
empty and covers the whole release. Until the v1 freeze, also name the probe firmware (OpenEmbeddedProbe) it talks to
and the oep-client-python version its tests used.

`npm version` runs:

- `preversion`: the tests, the type check, and the releasability check
- `version`: aligns the package version, the source `VERSION` (`src/index.js`) and the changelog heading
- the version commit and the Git tag

```sh
npm version patch              # or minor / major
```

The first release keeps the version already in `package.json` (`0.0.1`):

```sh
npm version 0.0.1 --allow-same-version
```

## Publish and push

Log in to npm and check the account (once per machine; the login stays in `~/.npmrc`):

```sh
npm login                      # opens a browser (or asks for user name, password and one-time code)
npm whoami                     # the account that will publish
npm owner ls oep-client-js  # after the first release: the accounts that may publish
```

Then publish and push:

```sh
npm publish --access public    # asks for a one-time code when two-factor auth is on
git push --follow-tags
```

`prepack` rebuilds the bundle and the declarations. Never keep an npm token or credentials in the repository.

## GitHub Actions

- `ci.yml`: on pushes to `main` and pull requests, installs the Python fake and runs the checks, build, declarations,
  dist smoke test, site build and package dry run.
- `pages.yml`: deploys the web page to GitHub Pages on pushes to `main` or by hand.
- `release.yml`: optional manual publication once npm Trusted Publishing is set up.

## Post-release checks

- The npm package page shows the intended version.
- In an empty directory, `npm install oep-client-js@<version>` and
  `node -e "import('oep-client-js').then(m => console.log(m.VERSION))"` print that version.
- The Git tag points at the intended commit.
- The [web page](https://open-embedded-probe.github.io/oep-client-js/) shows the new version.

Never overwrite a broken version. Fix it and publish a new patch version.
