# Vendored `wry` patches

Fabricator builds a **vendored copy of the `wry` crate** (`src-tauri/vendor/wry`) instead of
the crates.io release, so it can carry two small local patches. The vendored tree is always
the exact upstream release plus the patch files in `src-tauri/vendor/wry-patches`, and
`scripts/wry/vendor-wry.mjs` rebuilds it from them.

> **TL;DR for upgrades:** when a Tauri bump moves the `wry` version Tauri pins, run
> `node scripts/wry/vendor-wry.mjs update <version>` and follow its output. `cargo test`
> fails until you do. See [Upgrading wry with a Tauri bump](#upgrading-wry-with-a-tauri-bump).

## The patches

| Patch | File | What it does |
|---|---|---|
| `0001-webview2-os-primary-account-sso.patch` | `src/webview2/mod.rs` | Device-compliance SSO in the preview (Windows) |
| `0002-macos-child-webview-titlebar-inset.patch` | `src/wkwebview/mod.rs` | Keeps the macOS preview below its toolbar |

Each patched spot carries a `[rayfin-desktop local patch: <id>]` comment.

### 0001: WebView2 device-compliance SSO

**Where:** `InnerWebView::create_environment`, right after
`options.set_are_browser_extensions_enabled(...)`.

**Change:** `options.set_allow_single_sign_on_using_os_primary_account(true);`

**Why:** without it, signing in inside the preview to a deployed app protected by a Microsoft
Entra ID Conditional Access **"require compliant / managed device"** policy fails with
**"You can't get there from here"**, even though the same account signs in fine in Microsoft
Edge on the same device. See [Background](#background-why-0001-is-needed).

### 0002: macOS child webview title-bar inset

**Where:** `InnerWebView::set_bounds`, for macOS child webviews.

**Change:** shifts the child webview down by the title-bar inset: the content view's height
minus the bottom of the window's `contentLayoutRect`. A child webview that fills the whole
window is left where it is.

**Why:** the main window uses a full-size content view, so the main webview lays its web
content out *below* the native title bar (via safe-area insets), while wry positions child
webviews purely by frame against the whole content view. Without the correction the preview
child lands a title bar's height too high and covers the preview toolbar. In fullscreen
there is no title bar, the inset is 0, and the patch changes nothing.

Tauri's multiwebview mode (the `unstable` feature) makes the main webview a child too, and
resizes it to fill the window on every window resize. Shifting it as well would push the
bottom of the app, including the status bar, a title bar's height below the window after
any resize, so a webview that fills the window keeps its frame.

### Retired: disabling native-window occlusion

Earlier releases also added `CalculateNativeWinOcclusion` to wry's default
`--disable-features` list, so the agent could screenshot the preview while it was parked
off-screen or the window was minimized. That capture path was removed in 5333eaa (it could
freeze the app on VMs), occlusion detection was turned back on to save CPU, and the patch
is gone. If you ever bring back something like it, keep
[the matching-options rule](#webview2-environment-options-must-match) in mind.

## How it's wired

- **`src-tauri/Cargo.toml`** overrides crates.io with the vendored copy:

  ```toml
  [patch.crates-io]
  wry = { path = "vendor/wry" }
  ```

  Cargo applies this only while the vendored crate has **exactly** the version Tauri asks
  for. Otherwise it builds the registry crate and merely warns that the patch "was not used
  in the crate graph", silently dropping the patches.
- **`src-tauri/src/vendor_guard.rs`** (runs with `cargo test --lib`, in CI on Windows and
  macOS) fails when that happens: when `Cargo.lock` builds `wry` from a registry, lists the
  vendored copy under `[[patch.unused]]`, or pins a different version than `vendor/wry`. It
  also fails when a patch's code is missing from the vendored sources.
- **`node scripts/wry/vendor-wry.mjs verify`** (CI, Node job) fails when `vendor/wry` differs
  in any way from the upstream crate plus the patches, so every local change goes through a
  patch file.
- **`.gitattributes`** keeps `src-tauri/vendor/**` byte-identical to upstream (no CRLF
  conversion on Windows), so patches apply and verify the same way on every OS.
- **`webview2-com`, `windows` and the `objc2` crates** in `src-tauri/Cargo.toml` must match
  the versions the vendored wry requires (see `src-tauri/vendor/wry/Cargo.toml`), so Cargo
  builds a single copy that `src-tauri/src/services/preview.rs` shares with wry. Move them
  together with wry, never on their own.

## Versions

| Crate | Version | Notes |
|---|---|---|
| `tauri` | 2.12.3 | Pins the `wry` version (through `tauri-runtime-wry` 2.12.1) |
| `wry` | 0.57.0 | The crate we vendor |
| `webview2-com` | 0.39.1 | Provides `set_allow_single_sign_on_using_os_primary_account` (`options.rs`) |
| `windows` / `windows-core` | 0.62.2 | Must match what the vendored wry requires |

## Upgrading wry with a Tauri bump

1. **Bump Tauri** (`tauri`, `tauri-build`, the plugins) with `cargo update -p <crate>` from
   `src-tauri`. Never run a bare `cargo update` without checking which wry it picks.
   `cargo test --lib vendor_guard` now fails and names the wry version Tauri wants.
2. **Re-vendor that version:**

   ```powershell
   node scripts/wry/vendor-wry.mjs update <version>
   ```

   It downloads the crate from crates.io, checks it against the crates.io checksum, applies
   each patch in order and replaces `src-tauri/vendor/wry`. If a patch no longer applies, it
   changes nothing and shows which patch failed. Then re-run it with `--allow-rejects`,
   resolve the `*.rej` files by hand (and delete them), and run
   `node scripts/wry/vendor-wry.mjs refresh-patches` to rewrite the patch files from the
   resolved tree.
3. **Point Cargo at it:** `cargo update -p wry` in `src-tauri`. Move `webview2-com`,
   `windows` and the `objc2` crates in `src-tauri/Cargo.toml` to the versions
   `vendor/wry/Cargo.toml` requires, and confirm the new `webview2-com` still has
   `set_allow_single_sign_on_using_os_primary_account` (`src/options.rs`).
4. **Check:** `cargo test --lib` (including `vendor_guard`),
   `node scripts/wry/vendor-wry.mjs verify`, and `cargo tree -i wry`, which should show the
   `vendor/wry` path.
5. **Update the [version table](#versions).**
6. **Smoke-test on real machines:**
   - Windows: sign in inside the preview to an app behind a device-compliance Conditional
     Access policy.
   - macOS: in a normal (not fullscreen) window, the preview sits right below the preview
     toolbar instead of covering it, and after resizing the window the status bar is still
     visible at the bottom.

### Changing or adding a patch

Edit the file in `src-tauri/vendor/wry`, then run
`node scripts/wry/vendor-wry.mjs refresh-patches`.

To add a patch:

1. Create `src-tauri/vendor/wry-patches/NNNN-<name>.patch` with a short description, followed
   by a `diff --git a/<file> b/<file>` line for each file it covers.
2. Mark the change in the code with a `[rayfin-desktop local patch: <name>]` comment.
3. Run `refresh-patches`.
4. Add the patch to `PATCHES` in `src-tauri/src/vendor_guard.rs`.

### If upstream adopts a patch

- **0001:** if wry or Tauri exposes `AllowSingleSignOnUsingOSPrimaryAccount` (for example on
  `WebViewBuilder`), set it through that API and delete the patch.
- **0002:** if wry positions child webviews below the title bar itself, `refresh-patches`
  reports that the patch has no changes left. Delete it.

When no patches are left, delete `src-tauri/vendor/wry`, `src-tauri/vendor/wry-patches` and
`src-tauri/src/vendor_guard.rs`, and remove the `[patch.crates-io]` entry and the CI verify
step.

## Background: why 0001 is needed

- The native preview is a WebView2 surface. Microsoft Edge satisfies device-compliance
  Conditional Access because it presents the device's **Primary Refresh Token (PRT) / device
  certificate** through the OS account broker (Web Account Manager, WAM).
- WebView2 only does this when its **environment** is created with
  `AllowSingleSignOnUsingOSPrimaryAccount = true`. The default is `false`.
- This is an **environment-level** option set **once at app startup**, when wry creates the
  shared `CoreWebView2Environment`. It is **not** a per-webview setting and **not** a Chromium
  command-line flag, so it can't be supplied through Tauri's `additionalBrowserArgs` /
  `additional_browser_args`.
- Upstream `wry` builds `CoreWebView2EnvironmentOptions` but never calls the setter and
  exposes no knob for it. Tauri / `tauri-runtime-wry` only forward `additional_browser_args`.
  So the patch is the only way to turn it on.

### Scope / safety

The option applies to the **whole app's** WebView2 environment, which the main window, the
preview child webview and any sign-in popups share. The main window loads
`tauri://localhost` and never authenticates to Microsoft Entra ID, so the option is a no-op
there; only the preview and its sign-in popups gain device SSO.

### WebView2 environment options must match

WebView2 requires every webview that shares a **user-data folder** to use **identical**
environment options (`additionalBrowserArgs`, `scrollBarStyle`,
`AllowSingleSignOnUsingOSPrimaryAccount`, …). The main window and the preview share the
default folder, so set these only in the shared wry defaults or environment, never per
webview, or `CreateCoreWebView2EnvironmentWithOptions` fails with **ERROR_INVALID_STATE
(0x8007139F)**.

## Notes

- `cargo` may not be on `PATH` in a fresh shell on Windows; use
  `& "$env:USERPROFILE\.cargo\bin\cargo.exe"`, and run it from `src-tauri/`.
- The Conditional Access outcome can only be verified interactively, on a compliant device
  in the target tenant, and the macOS layout only on a Mac. There's no offline test for
  either.
