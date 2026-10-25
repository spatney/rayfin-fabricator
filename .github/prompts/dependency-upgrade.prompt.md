---
agent: 'agent'
description: 'Plan a comprehensive dependency upgrade for rayfin-fabricator (Tauri/wry/Rust backend + React/Vite/TS JS toolchain). Re-discovers current vs latest versions, respects the vendored-wry pinning constraints, and produces a risk-tiered upgrade plan. PLANNING ONLY — does not bump versions or modify code unless explicitly told to implement.'
---

# Dependency upgrade — planning run

You are planning a **comprehensive dependency upgrade** for this repo (`rayfin-fabricator`,
a Tauri v2 desktop app: Rust backend in `src-tauri/`, React + Vite renderer in
`src/renderer/`). This is a **recurring (bi-weekly) review**.

**PLANNING ONLY.** Do not bump any version, edit any manifest, or run any installer
unless I explicitly reply "implement" / "do it". Your single deliverable this run is a
written, risk-tiered upgrade plan saved to your session `plan.md`, plus a short summary.

Always **re-discover live versions** — do not trust the baseline snapshot at the bottom
of this file; it is only a reference point from a previous run.

Dependabot (`.github/dependabot.yml`) opens weekly, grouped PRs for npm, Cargo and GitHub
Actions. It ignores the crates pinned to the vendored `wry`, and its Tauri PRs fail the
vendor guard whenever Tauri moves the `wry` it pins. This review owns what Dependabot can't
do safely: the Tauri → `wry` re-vendor, majors that need code changes, and anything blocked
by a peer range. Check the open Dependabot PRs first so the plan doesn't duplicate them.

---

## The two dependency surfaces

1. **Node / renderer** — `package.json` (root). React, react-dom, Vite,
   `@vitejs/plugin-react`, TypeScript, ESLint + `@eslint/js` + `typescript-eslint`,
   `@tauri-apps/api` + `@tauri-apps/plugin-*`, monaco-editor + `@monaco-editor/react`,
   react-markdown, remark-gfm, highlight.js, yaml, prettier, globals, `@types/*`.
2. **Rust / Tauri backend** — `src-tauri/Cargo.toml` (+ `src-tauri/Cargo.lock` for
   resolved versions). `tauri` + `tauri-build` + `tauri-plugin-*`, `github-copilot-sdk`,
   `wry` (vendored — see below), `webview2-com` / `windows` (Windows), `objc2` /
   `block2` / `objc2-*` (macOS), `reqwest`, `tokio`, `serde`, etc.

---

## Step 1 — Inventory current versions

- Read `package.json` for the declared (caret) JS versions.
- Read `src-tauri/Cargo.toml` for declared crate versions, and extract the **resolved**
  versions from `src-tauri/Cargo.lock` for at least: `tauri`, `tauri-runtime-wry`,
  `wry`, `tao`, `github-copilot-sdk`, `webview2-com`, `windows`, `objc2`,
  `tauri-plugin-updater`, `reqwest`, `tokio`. Example:
  ```powershell
  cd src-tauri
  Select-String -Path Cargo.lock -Pattern '^name = "(tauri|wry|github-copilot-sdk|webview2-com|windows|objc2|tao|tauri-runtime-wry|reqwest|tokio)"' -Context 0,1
  ```

## Step 2 — Discover the latest available versions

- **crates.io** (use `.crate.max_stable_version`, ignore pre-releases unless I ask):
  ```powershell
  Invoke-RestMethod -Uri "https://crates.io/api/v1/crates/<name>" -Headers @{ 'User-Agent' = 'rayfin-dep-check' }
  ```
  Check: `tauri`, `tauri-build`, `wry`, `github-copilot-sdk`, `webview2-com`,
  `windows`, `objc2`, `tauri-plugin-updater`, `tauri-plugin-dialog`,
  `tauri-plugin-opener`, `tauri-plugin-log`, `reqwest`, `tokio`.
- **npm**: `npm view <pkg> version` for each JS dependency/devDependency.
- Note whether a **new Tauri minor/major** exists — that is the trigger for the
  expensive vendored-wry re-vendor path (see Hard Constraints).

## Step 3 — HARD CONSTRAINTS (a plan that violates any of these is wrong)

1. **`wry` is vendored and version-pinned to whatever Tauri pins.** It lives at
   `src-tauri/vendor/wry/` (the upstream crate plus the patch files in
   `src-tauri/vendor/wry-patches/`) and is wired via
   `[patch.crates-io] wry = { path = "vendor/wry" }` in `src-tauri/Cargo.toml`. The
   override only applies because the vendored crate has the **exact same version** Tauri
   pins. Because `tauri = "2"`, a bare `cargo update` can pull in a Tauri that pins a newer
   wry; Cargo then only warns and silently builds the unpatched registry crate.
   `src-tauri/src/vendor_guard.rs` makes `cargo test --lib` fail when that happens.
2. **`webview2-com`, `windows`, `windows-core`, `objc2`, `block2`, `objc2-*` MUST match
   the versions the vendored `wry` requires.** Read `src-tauri/vendor/wry/Cargo.toml`
   for its required versions (e.g. wry 0.57.0 needs `webview2-com = 0.39`,
   `windows`/`windows-core = 0.62`, `objc2 = 0.6.4+`). Bumping these in `src-tauri/Cargo.toml`
   **independently of wry** creates a *second copy* of the crate, breaks Cargo's
   unification, and breaks `src-tauri/src/services/preview.rs` (which shares WebView2 /
   WKWebView types with wry). Only move them as part of a coordinated Tauri→wry bump.
3. **If Tauri's bump changes the pinned `wry` version**, the plan MUST include:
   re-vendoring that exact wry version with `node scripts/wry/vendor-wry.mjs update <version>`,
   which re-applies **both local patches** (`0001` WebView2 device-compliance SSO, `0002`
   macOS child-webview title-bar inset) and stops if one no longer applies. Follow
   `docs/VENDORED-WRY-PATCH.md` step-by-step. Verify the override stays live:
   `cargo test --lib vendor_guard` passes, `npm run vendor:wry -- verify` passes, and the
   `wry` entry in `src-tauri/Cargo.lock` has **no `source = "registry+..."`** line. If both
   patches ever become unnecessary upstream, the plan may instead delete the vendored tree,
   the patches, the guard + verify step, and the `[patch.crates-io]` entry.
4. **`github-copilot-sdk` is an edition-2024 crate → requires Rust ≥ 1.94.** This sets
   `rust-version` in `src-tauri/Cargo.toml`. If a newer SDK raises the floor, bump
   `rust-version` and confirm CI still satisfies it (CI uses
   `dtolnay/rust-toolchain@stable` in both `.github/workflows/ci.yml` and
   `release.yml`). Note the SDK's `bundled-cli` feature downloads a pinned Copilot CLI
   at build time (needs network / `BUNDLED_CLI_CACHE_DIR` in CI).
5. **`@types/node` tracks the Node *runtime*, not "newest".** CI builds on Node 24 LTS
   (`.github/workflows/ci.yml`, `release.yml`, `docs.yml`). Keep `@types/node` on that
   Node major (`^24`) — do not jump to the newest major just because it exists. Moving CI
   to a new Node major is its own change; Vitest 5 and later need Node ≥ 22.12.
6. **monaco offline constraint.** The app runs from `file://`; any renderer component
   using `@monaco-editor/react` must import the `../monaco` side-effect module
   (`loader.config({ monaco })`) or Monaco hangs fetching the CDN
   (`src/renderer/src/monacoOffline.test.ts` enforces this). Keep `monaco-editor`
   and `@monaco-editor/react` compatible, and don't introduce a CDN-loading path.
   Since 0.56, `monaco-editor` only exposes files through its `exports` map
   (`"./*"` → `./esm/vs/*.js`), so `src/renderer/src/monaco.ts` imports workers as
   `monaco-editor/editor/editor.worker?worker` and
   `monaco-editor/languages/features/<lang>/<worker>?worker` (never `monaco-editor/esm/...`),
   and the language services live on top-level namespaces (`monaco.typescript`, not
   `monaco.languages.typescript`). `npm run check:build` fails if a worker stops being
   bundled. `getWorker` routes on the worker `label` (the language id); confirm those
   labels in `esm/vs/languages/features/*/workerManager.js` after a bump.

## Step 4 — Categorize every available update

For each dependency with an update, classify and record:
- **Tier A — safe** (patch/minor, no breaking changes): batch together.
- **Tier B — major / breaking** (for example TypeScript 6 → 7, a new Vite, Vitest or
  ESLint major, or a Rust crate major such as `zip`): each gets its own todo. For each,
  briefly research and list the **known breaking changes** relevant to this codebase
  (for example peer-dependency ranges, Node-floor changes, renamed or removed config
  options, changed test-runner defaults, and new lint rules that flag existing code).
- **Tier C — coordinated/blocked**: anything gated by a Hard Constraint (Tauri↔wry↔
  windows/webview2-com/objc2). Mark blocked-by and the re-vendor work.
- **Skip**: already-latest or intentionally pinned. Say so explicitly so the review is
  complete.

## Step 5 — Validation gates (cite these in the plan; run only when implementing)

- **JS:** `npm run typecheck` && `npm test` && `npm run lint` && `npm run build:renderer`
  && `npm run check:build` (relative asset URLs, the CSP, and every Monaco worker bundled)
- **Rust:** from `src-tauri/`: `cargo check` and `cargo test --lib`
  (e.g. `cargo test --lib commands::git`, `cargo test --lib agent_`). CI runs the Rust
  tests on Windows **and** macOS.
- **Vendored wry:** `npm run vendor:wry -- verify` and `cargo test --lib vendor_guard`.
- On this machine `cargo` may not be on `PATH`; use
  `& "$env:USERPROFILE\.cargo\bin\cargo.exe"` and run from `src-tauri/`.
- After a Tauri/wry bump, also do a real `npm run tauri build` (or `cargo build`) and
  the two manual smoke tests from `docs/VENDORED-WRY-PATCH.md`: (1) sign in inside the
  preview against a device-compliance-gated app (Windows); (2) in a normal (not
  fullscreen) macOS window, confirm the preview sits right below its toolbar.

## Step 6 — Deliverable (this run)

Write `plan.md` containing:
1. **Summary table**: dependency | current | latest | tier | recommendation.
2. **Ordered todos**, grouped by tier, each with: what to bump, why, the breaking
   changes to handle, the exact validation command(s) to gate it, and rollback notes.
   Put the Tauri→wry→windows re-vendor work as one coordinated, clearly-sequenced unit.
3. **Risk & sequencing notes**: do Tier A first (fast win, separate commit), then each
   Tier B major on its own branch/commit with its own validation, then Tier C only if a
   Tauri bump is in scope this cycle.
4. **What was intentionally skipped** and why (already-latest / pinned-to-wry).

Then reflect the todos into the session SQL `todos` table for tracking and give me a
short summary. **Stop there.** Do not implement until I say so.

---

## Reference baseline (after the upgrade stack that started with #43 — re-verify, do not trust)

> Snapshot only; **always re-run Steps 1–2** for live numbers.

- **Rust (resolved):** `tauri` 2.12.3, `tauri-build` 2.7.2, `tauri-runtime-wry` 2.12.1,
  `wry` 0.57.0 (vendored + patches `0001` and `0002`), `tao` 0.37.1, `webview2-com` 0.39.1,
  `windows`/`windows-core` 0.62.2, `objc2` 0.6.5, `block2` 0.6.2, `tauri-plugin-updater`
  2.13.3, `tauri-plugin-dialog` 2.8.2, `tauri-plugin-opener` 2.7.1, `tauri-plugin-log`
  2.10.1, `github-copilot-sdk` 1.0.20 (bundles Copilot CLI 1.0.96), `reqwest` 0.13.5,
  `tokio` 1.53.2, `zip` 9, `dirs` 7, `which` 8, `sha2` 0.11; `rust-version` 1.94.
- **JS:** React 19.3, Vite 8.3 + `@vitejs/plugin-react` 6.1, Vitest 5.0 + jsdom 29.1,
  TypeScript 6.0.3, ESLint 10.12 + `@eslint/js` 10 + `globals` 17, `typescript-eslint`
  8.71, prettier 3.9, monaco-editor 0.57.0 + `@monaco-editor/react` 4.7.0,
  `@tauri-apps/api` 2.12.3 / `@tauri-apps/cli` 2.12.2, `@types/node` 24.
- **CI:** Node 24; `actions/checkout` and `actions/setup-node` v7, `actions/cache` v6,
  `actions/upload-artifact` v7, `actions/download-artifact` v8,
  `softprops/action-gh-release` v3, Pages actions v6 / v5 / v5.
- **Blocked or deliberately held:**
  - TypeScript 7: `typescript-eslint` 8.71.2 accepts only `typescript >=4.8.4 <6.1.0`.
  - Pre-releases: Tauri 3 alphas, `github-copilot-sdk` previews, `@monaco-editor/react`
    4.8 release candidates.
  - `reqwest` uses `native-tls` on purpose: its `rustls` feature adds `aws-lc-rs` next to
    the updater's `ring`, and rustls then has no default crypto provider to pick.
  - `serde_yaml` 0.9.34 is deprecated upstream, with no successor chosen yet.
  - `npm audit` reports 2 low findings for the DOMPurify copy monaco-editor 0.57.0 bundles
    (GHSA-6688-9rhm-gjv2; monaco never uses the affected `IN_PLACE` mode). An npm
    `overrides` entry wouldn't change the bundled copy; wait for a monaco release.
- **Known duplicate crates:** `zip` 4 (from `tauri-plugin-updater`) and 7 (from
  `github-copilot-sdk`) next to our 9; `dirs` 5 (from `github-copilot-sdk`) next to our 7;
  `sha2`/`digest` 0.10 (from `github-copilot-sdk` and `tauri-codegen`) next to our 0.11;
  `base64` 0.21/0.22/0.23; `syn` 1/2/3.
