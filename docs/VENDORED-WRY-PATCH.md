# Vendored `wry` patch — WebView2 device-compliance SSO

This repo ships a **vendored copy of the `wry` crate** with a **single one-line
change** so that the embedded preview can sign in to apps protected by an Azure AD
(Entra) **Conditional Access "require compliant / managed device" policy**.

Without the patch, signing in inside the preview fails with
**"You can't get there from here"**, even though the same account signs in fine in
Microsoft Edge on the same (compliant) device.

> **TL;DR for upgrades:** when you bump Tauri (which pins `wry`), re-vendor the
> matching `wry` version and re-apply the one line described below, or drop the
> whole patch if upstream wry ever exposes the option. See
> [Re-applying on upgrade](#re-applying-the-patch-on-upgrade).

---

## The change

**File:** `src-tauri/vendor/wry/src/webview2/mod.rs`
**Where:** inside the `unsafe` block that builds `CoreWebView2EnvironmentOptions`
just before `CreateCoreWebView2EnvironmentWithOptions`, immediately after the
`options.set_are_browser_extensions_enabled(...)` call.

**Added line:**

```rust
options.set_allow_single_sign_on_using_os_primary_account(true);
```

In context (the comment block is part of the patch):

```rust
unsafe {
  options.set_additional_browser_arguments(additional_browser_args);
  options.set_are_browser_extensions_enabled(pl_attrs.browser_extensions_enabled);

  // [rayfin-desktop local patch] Share the OS primary (Entra-joined) account
  // with this WebView2 environment. This surfaces the device-bound Primary
  // Refresh Token / device certificate to Azure AD, so deployed apps gated by
  // a Conditional Access "require compliant/managed device" policy can sign in
  // inside the embedded preview instead of failing with "You can't get there
  // from here". Upstream wry leaves this `false` and exposes no setter, hence
  // the vendored patch (see src-tauri/vendor/wry and the [patch.crates-io]
  // entry in src-tauri/Cargo.toml).
  options.set_allow_single_sign_on_using_os_primary_account(true);

  // Get user's system language
  // ... (unchanged upstream code continues)
}
```

That is the **only** source change in the entire vendored tree. Everything else
under `src-tauri/vendor/wry/` is a verbatim copy of the upstream crate.

## How it's wired

`src-tauri/Cargo.toml` overrides the crates.io `wry` with the local copy:

```toml
[patch.crates-io]
wry = { path = "vendor/wry" }
```

Cargo applies this because the vendored crate has the **same version** Tauri pins
(see below). When patched, `src-tauri/Cargo.lock` has **no `source = "registry+..."`
line** for the `wry` entry — that absence is how you confirm the override is live.

## Versions this patch was made against

| Crate | Version | Notes |
|---|---|---|
| `tauri` | 2.11.3 | Pins the `wry` version |
| `wry` | 0.55.1 | The crate we vendored/patched |
| `webview2-com` | 0.38.2 | Provides `set_allow_single_sign_on_using_os_primary_account` (`options.rs`) |

## Why this is needed (background)

- The native preview is a WebView2 surface. Microsoft Edge satisfies
  device-compliance Conditional Access because it presents the device's
  **Primary Refresh Token (PRT) / device certificate** via the OS account broker
  (Web Account Manager, WAM).
- WebView2 only does this when its **environment** is created with
  `AllowSingleSignOnUsingOSPrimaryAccount = true`. The default is `false`.
- This is an **environment-level** option set **once at app startup**, when wry
  creates the shared `CoreWebView2Environment`. It is **not** a per-webview
  setting and **not** a Chromium command-line flag, so it cannot be supplied via
  Tauri's `additionalBrowserArgs` / `additional_browser_args`.
- Upstream `wry` 0.55.1 builds `CoreWebView2EnvironmentOptions` but never calls
  the setter, and exposes no public knob for it. Tauri / `tauri-runtime-wry`
  likewise only forward `additional_browser_args`. Hence the one-line vendored
  patch is currently the only way to flip it.

### Scope / safety

The option applies to the **whole app's** WebView2 environment, which is shared by
the main window, the preview child webview, and any auth popups. The main window
loads `tauri://localhost` and never authenticates to Entra, so the option is a
no-op there; only the preview and its sign-in popups gain device SSO. There is no
downside for the rest of the app.

---

## Re-applying the patch on upgrade

When you upgrade Tauri (or otherwise change the pinned `wry` version), redo this:

1. **Find the new `wry` version Tauri pins.** After updating `Cargo.toml` /
   running `cargo update`, check it:
   ```powershell
   cd src-tauri
   & "$env:USERPROFILE\.cargo\bin\cargo.exe" tree -p wry --depth 0
   # or: Select-String -Path Cargo.lock -Pattern 'name = "wry"' -Context 0,1
   ```

2. **Re-vendor that exact version.** Replace `src-tauri/vendor/wry/` with a clean
   copy of the new version. The simplest source is the local cargo registry cache
   after a build (`$env:USERPROFILE\.cargo\registry\src\index.crates.io-*\wry-<version>\`),
   or `cargo vendor`, or the crates.io download. After copying:
   - clear read-only attributes on the copied files, and
   - delete the cache marker `.cargo-ok` if present.

3. **Re-apply the one line.** In `src-tauri/vendor/wry/src/webview2/mod.rs`, find
   the `unsafe` block that builds `CoreWebView2EnvironmentOptions` (search for
   `set_are_browser_extensions_enabled`) and add, right after it:
   ```rust
   options.set_allow_single_sign_on_using_os_primary_account(true);
   ```
   (Keep the explanatory comment block above it.)

4. **Confirm the setter still exists** on the `webview2-com` version now in the
   lockfile. If `webview2-com` renamed/removed it, adjust the call accordingly.

5. **Confirm the `[patch.crates-io]` path** in `src-tauri/Cargo.toml` still points
   at `vendor/wry` (it shouldn't need changes), then build:
   ```powershell
   cd src-tauri
   & "$env:USERPROFILE\.cargo\bin\cargo.exe" build
   ```

6. **Verify the override is live:** `src-tauri/Cargo.lock`'s `wry` entry should
   have **no `source = "registry+..."` line**.

7. **Smoke-test sign-in** in the preview against a device-compliance–gated app.

### If upstream fixes this

If a future `wry` (or Tauri) exposes `AllowSingleSignOnUsingOSPrimaryAccount`
directly (e.g. via a `WebViewBuilder` / attributes option), **delete the vendored
tree, remove the `[patch.crates-io]` entry**, and set the option through the
supported API instead.

## Notes

- `cargo` may not be on `PATH` in a fresh shell here; use
  `& "$env:USERPROFILE\.cargo\bin\cargo.exe"`. Run it from `src-tauri/` (the build
  root) so `[patch.crates-io]` takes effect.
- The CA outcome can only be verified interactively on a compliant device with the
  target tenant — there's no offline test for it.
