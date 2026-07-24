# Universal-template dependency artifacts

This directory holds **install-acceleration artifacts** for the `fabricator-universal`
template, generated **per-platform by the release workflow** (see
`scripts/build-universal-deps.mjs` and `.github/workflows/release.yml`):

- **`node_modules.tgz`** — a prebuilt dependency tree (plus `package-lock.json`) for
  the lean base. On create, Fabricator scaffolds with `rayfin init --skip-install`
  and extracts this instead of running a cold `npm install`, so the first project is
  ready almost instantly.
- **`npm-cache.tgz`** — a warm npm cache covering the base **and** every capability
  pack's modules (the analytics kit, `@microsoft/rayfin-data`, etc.). Extracted once
  into the app data dir and wired via `npm_config_cache` + `prefer-offline`, so the
  capability router's on-demand `npm install`s resolve offline and fast.

Both files are **git-ignored** (`*.tgz`) and are **optional**: when they're absent
(dev/source builds, or a platform without them) Fabricator falls back to a normal
network `npm install`. This `README.md` is committed so the directory — and therefore
the Tauri resource path `resources/fabricator-universal-deps/` — always exists.

The artifacts must correspond to the current `fabricator-universal` `package.json`
and the capability packs' module lists; the release workflow regenerates them on
every build, so there's nothing to maintain by hand here.
