# Fabricator deployment

`deploy.ps1` provisions the Azure telemetry infrastructure for the app and wires the Application Insights GitHub Actions secret. Binary distribution is handled by GitHub Releases via CI.

## Prerequisites

- PowerShell 7 (`pwsh`)
- Azure CLI (`az`) signed in to the Azure subscription that should host the telemetry resources (pass `-SubscriptionId` to override; otherwise the current `az` subscription is used)
- GitHub CLI (`gh`) authenticated to `spatney/rayfin-fabricator` for automatic `APPINSIGHTS_CONNECTION_STRING` secret wiring
- Node.js/npm for local builds
- Rust toolchain (stable, MSVC) and the WebView2 runtime for `-BuildLocal` Tauri builds

## What it provisions

- Resource group `rayfin-fabricator`
- Log Analytics workspace `rayfin-fabricator-logs`
- Workspace-based Application Insights `rayfin-fabricator-insights`
- Resource-group monthly Azure budget alerts at 80% and 100%

## Cost posture

The intended steady-state cost is near $0 for light usage: Application Insights has a 5 GB/month free grant and the script sets a strict 0.1 GB/day ingestion cap; the default $5 monthly budget sends alert emails.

## Run

From the repo root:

```powershell
pwsh -NoProfile -File .\deploy.ps1
```

To provision and wire endpoints and build a local Windows installer:

```powershell
pwsh -NoProfile -File .\deploy.ps1 -BuildLocal
```

The script writes `resources/telemetry.json` and `.deploy.state.json`. If `gh` is unavailable or not authenticated, it prints the Actions secret to add manually.

## Cut a release

Push a version tag to trigger the GitHub Actions release workflow that builds the Windows installer (Tauri/NSIS) and publishes it to a GitHub Release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## Warm npm cache (fast first-run installs)

Creating a Universal App and deploying it triggers a first dependency install. To keep that fast, the app ships a **warm npm cache** — a prebuilt cacache of the Universal App's dependencies (base template + every capability pack) — bundled under `resources/npm-cache/` and seeded into the user's app-data on first launch. Every npm Fabricator spawns uses this cache. Lockfile-backed `npm ci` uses `--prefer-offline`; `npm install` keeps normal registry freshness checks while reusing cached tarballs.

- **Fresh scaffold metadata.** `npm create @microsoft/rayfin@latest` explicitly disables `prefer-offline` and enables `prefer-online` for itself and its children. npm gives `prefer-offline` precedence: enabling both can resolve the latest scaffolder against an older cached CLI manifest and fail with `ETARGET` even though that CLI version is published (issue #28). The fix retains the cache and the selected package versions; it does not clear caches or silently substitute an older CLI.
- **Generated in CI, per platform.** `.github/workflows/release.yml` runs `node scripts/warm-npm-cache.mjs` on both the Windows and macOS jobs before the Tauri build, so each installer carries the native optional deps (esbuild / SWC / tailwind-oxide / rollup) for its own OS+arch. The cache is **never committed** (see `.gitignore`); a `.gitkeep` keeps the bundled-resource directory present.
- **Regenerate locally** with `npm run warm-cache` (writes `resources/npm-cache/_cacache`).
- **Determinism.** The base is warmed from the template's committed `package-lock.json`, so the cached tarballs match what the runtime `npm ci` installs. When you change the template's or a pack's dependencies, regenerate the template lockfile (`npm install --package-lock-only` in `resources/fabricator-templates/fabricator-universal`) so the two stay in sync.
- **Regression coverage.** `cargo test --manifest-path src-tauri\Cargo.toml --lib npm` (PowerShell, from the repo root) checks the cache policy and reproduces stale-metadata `ETARGET` against a loopback registry. Requires Node.js/npm; no packages are installed, and the user's npm configuration and cache are not used.

## Auto-update

The app ships with Tauri's updater plugin. On startup (and via **Settings → Check for updates**) it fetches `latest.json` from the latest GitHub Release, downloads the new installer in the background, and prompts the user to restart and install.

### How the release workflow supports it

`.github/workflows/release.yml` signs the installer with a minisign key and publishes three assets per release: `*-setup.exe`, `*-setup.exe.sig`, and a generated `latest.json` (version, notes, `pub_date`, and the `windows-x86_64` signature + download URL). The updater endpoint is `releases/latest/download/latest.json`, which always resolves to the most recent non-prerelease release — so keep releases non-prerelease.

### Updater signing key (custody)

Update packages are verified against the public key baked into `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The matching private key lives **only** in two GitHub Actions secrets and must be backed up offline:

- `TAURI_SIGNING_PRIVATE_KEY` — the minisign private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

If the private key is lost, you cannot sign updates that existing clients will accept; recovery requires shipping a new public key in a build that users install manually. Generate a key with `npx @tauri-apps/cli signer generate -w <keyfile>` and set the secrets with `gh secret set`.

### First-rollout caveat

Auto-update only works for installs built **with** the updater (the first updater-enabled release onward). Users on an earlier build must install that first release manually; subsequent updates are automatic.
