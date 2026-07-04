//! Embedded preview pane.
//!
//! A single native WebView2 **child webview** (label [`PREVIEW_LABEL`]) overlaid
//! on the main window, rendering the user's *deployed* Rayfin app. It replaces the
//! Electron `<webview>` (see the former `src/main/index.ts`). The child webview is
//! a real OS surface that always paints above the HTML layout, so the renderer
//! reports the host element's bounds and we keep the webview positioned over it;
//! when the preview is covered (other tabs, modals, the deploy log) the renderer
//! calls [`preview_hide`].
//!
//! Fabric/AAD sign-in: the deployed app opens a `window.open(...)` auth-broker
//! popup. We let **WebView2 own that popup** (`NewWindowResponse::Allow`) so its
//! native window lifecycle honors `window.close()` and it shares the parent's
//! session/cookies (proven during the Phase-4 spike: no UA spoof or popup-blocker
//! workaround needed, unlike Electron/Chromium). Plain `target=_blank` links open
//! in the user's real browser instead.

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};
use crate::services::crashlog;
use crate::services::watchdog::{self, Activity};

/// Label of the single reusable preview child webview.
const PREVIEW_LABEL: &str = "preview";
/// Renderer event carrying preview navigation state (matches `IpcChannels.previewNav`).
const PREVIEW_NAV: &str = "preview:nav";
/// Renderer event asking the UI to surface the preview at a URL on the agent's
/// behalf (matches `IpcChannels.previewAgent`). Used by the Fabricator
/// validation tools so a host-driven navigation/screenshot can reveal the
/// preview pane even when another tab is focused. Only used to *surface* the
/// preview on non-Windows; on Windows the agent captures silently off-screen and
/// never asks the UI to change the user's view (see [`agent_capture`]).
#[cfg_attr(windows, allow(dead_code))]
const PREVIEW_AGENT: &str = "preview:agent";

/// Far-off-screen origin (logical px) used to park the preview for a *silent*
/// agent capture: the surface is moved here — well outside any monitor — and made
/// visible *there*, so WebView2 keeps rendering it (and `CapturePreview`
/// completes) while it stays invisible to the user. See [`agent_capture`].
#[cfg(windows)]
const OFFSCREEN_COORD: f64 = 20_000.0;

/// Viewport (logical px) used for a silent off-screen capture.
#[cfg(windows)]
const OFFSCREEN_SIZE: (f64, f64) = (1280.0, 800.0);

/// Document-start script injected into the preview so the agent can later read
/// the page's console output (see [`read_console`]). It mirrors `console.*`,
/// `window.onerror`, and `unhandledrejection` into a small bounded ring buffer on
/// `window.__fabricatorConsole`. Defensive and idempotent: it always forwards to
/// the original console method and never throws, so it cannot perturb the app
/// under test. Runs in the page's main world via
/// [`WebviewBuilder::initialization_script`].
const CONSOLE_INIT_JS: &str = r#";(function () {
  try {
    if (window.__fabricatorConsole) return;
    var MAX = 200;
    var buf = [];
    function fmt(a) {
      try {
        if (a instanceof Error) return String(a.stack || (a.name + ': ' + a.message));
        if (typeof a === 'string') return a;
        if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      } catch (e) { return '<unserializable>'; }
    }
    function push(level, args) {
      try {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(fmt(args[i]));
        var text = parts.join(' ');
        if (text.length > 2000) text = text.slice(0, 2000) + '\u2026';
        buf.push({ level: level, text: text, t: Date.now() });
        if (buf.length > MAX) buf.splice(0, buf.length - MAX);
      } catch (e) {}
    }
    window.__fabricatorConsole = { entries: buf, clear: function () { buf.length = 0; } };
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    for (var k = 0; k < levels.length; k++) {
      (function (m) {
        var orig = (window.console && typeof console[m] === 'function') ? console[m].bind(console) : function () {};
        console[m] = function () { push(m, arguments); return orig.apply(console, arguments); };
      })(levels[k]);
    }
    window.addEventListener('error', function (e) {
      try {
        if (e && e.message) push('error', [e.message + (e.filename ? ' (' + e.filename + ':' + (e.lineno || 0) + ')' : '')]);
        else push('error', ['Uncaught error']);
      } catch (x) {}
    });
    window.addEventListener('unhandledrejection', function (e) {
      try { push('error', ['Unhandled promise rejection: ' + fmt(e && e.reason)]); } catch (x) {}
    });
  } catch (e) {}
})();"#;

/// Logical-pixel rectangle reported by the renderer (its host element's bounds,
/// relative to the window client area — i.e. `getBoundingClientRect()`).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct PreviewBounds {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl PreviewBounds {
  fn position(self) -> LogicalPosition<f64> {
    LogicalPosition::new(self.x, self.y)
  }

  fn size(self) -> LogicalSize<f64> {
    // Guard against zero/negative sizes that some layouts briefly report.
    LogicalSize::new(self.width.max(1.0), self.height.max(1.0))
  }

  fn to_rect(self) -> tauri::Rect {
    tauri::Rect {
      position: self.position().into(),
      size: self.size().into(),
    }
  }
}

/// Navigation state pushed to the renderer toolbar (matches `PreviewNavState`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewNavState {
  url: String,
  loading: bool,
  can_go_back: bool,
  can_go_forward: bool,
}

/// Managed state for the preview webview's back/forward history.
#[derive(Default)]
pub struct PreviewState {
  inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
  /// Whether the child webview has been created yet (created lazily on first show).
  created: bool,
  /// The last URL the renderer explicitly told us to load (the current "root").
  /// Re-shows compare against this — not the webview's drifted live URL — so a
  /// pure re-show (e.g. after an overlay closes) never triggers a reload.
  commanded: Option<String>,
  /// Committed main-frame URLs, oldest first (the back/forward stack).
  stack: Vec<String>,
  /// Index into `stack` of the currently displayed entry.
  cursor: usize,
  /// True while a programmatic back/forward navigation is in flight, so the
  /// resulting `on_navigation` does not push a duplicate history entry.
  programmatic: bool,
  /// One-shot senders awaiting the next `PageLoadEvent::Finished`, used by
  /// [`navigate_and_wait`] so the validation tools can block until the new
  /// document has loaded before capturing a screenshot.
  load_waiters: Vec<oneshot::Sender<()>>,
  /// Whether the child webview is currently shown (`true` after `show()`,
  /// `false` after `hide()`). WebView2's `CapturePreview` never completes on a
  /// hidden surface — it pumps the UI-thread message loop forever and freezes
  /// the whole app — so [`capture_preview_bytes`] refuses to capture unless this
  /// is `true`.
  visible: bool,
}

impl Inner {
  fn can_back(&self) -> bool {
    self.cursor > 0
  }

  fn can_forward(&self) -> bool {
    self.cursor + 1 < self.stack.len()
  }

  /// Reset the history to a single root entry (a fresh URL / project switch).
  fn reset_to(&mut self, url: &str) {
    self.commanded = Some(url.to_string());
    self.stack = vec![url.to_string()];
    self.cursor = 0;
    self.programmatic = false;
  }
}

/// Create the child webview over the main window. Must run off the main thread
/// (`add_child` dispatches to the event loop and blocks on the result), so this
/// is only ever called from the async [`preview_show_url`] command.
fn build(app: &AppHandle, url: Url, bounds: PreviewBounds) -> AppResult<()> {
  let main = app
    .get_webview_window("main")
    .ok_or_else(|| AppError::Msg("main window not found".into()))?;
  let window = main.as_ref().window();

  let nav_app = app.clone();
  let load_app = app.clone();
  let popup_app = app.clone();

  let builder = WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(url))
    .focused(false)
    // Expose the web inspector on the preview so users can open browser devtools
    // for their deployed app (see `preview_open_devtools`). Devtools default to on
    // in debug but off in release wry; the `devtools` cargo feature (Cargo.toml)
    // makes `with_devtools`/`open_devtools` available, and this keeps it on.
    .devtools(true)
    // Capture the deployed app's console output/errors so the agent can read
    // them back later via `fabricator_console`. Must be set before the webview
    // is created so it runs at document start on every page.
    .initialization_script(CONSOLE_INIT_JS)
    .on_navigation(move |u| {
      on_navigation(&nav_app, u);
      true
    })
    .on_page_load(move |_wv, payload| {
      on_page_load(&load_app, payload.event(), payload.url());
    })
    .on_new_window(move |u, features| on_new_window(&popup_app, &u, features));

  // The preview shares the default WebView2 user-data folder with the main window,
  // so it MUST use the same browser arguments. Both inherit them from the vendored
  // wry default (which disables native-window occlusion so the agent can capture the
  // preview off-screen / while minimized — see vendor/wry/src/webview2/mod.rs and
  // `agent_capture`). Do NOT set per-webview `additional_browser_args` here: a
  // mismatch makes WebView2 fail creation with ERROR_INVALID_STATE (0x8007139F).
  window
    .add_child(builder, bounds.position(), bounds.size())
    .map_err(|e| AppError::Msg(format!("failed to create preview webview: {e}")))?;
  Ok(())
}

/// Record a committed navigation and push fresh nav state to the renderer.
fn on_navigation(app: &AppHandle, u: &Url) {
  let url = u.to_string();
  let state = app.state::<PreviewState>();
  let (loading, can_back, can_fwd) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.programmatic {
      inner.programmatic = false;
    } else {
      // Drop any forward history, then append unless it's a no-op re-nav.
      let keep = (inner.cursor + 1).min(inner.stack.len());
      inner.stack.truncate(keep);
      if inner.stack.last().map(String::as_str) != Some(url.as_str()) {
        inner.stack.push(url.clone());
      }
      inner.cursor = inner.stack.len().saturating_sub(1);
    }
    (true, inner.can_back(), inner.can_forward())
  };
  emit_nav(app, &url, loading, can_back, can_fwd);
}

/// Update the loading flag as a document load starts/finishes.
fn on_page_load(app: &AppHandle, event: PageLoadEvent, u: &Url) {
  let loading = matches!(event, PageLoadEvent::Started);
  let state = app.state::<PreviewState>();
  let (can_back, can_fwd) = {
    let mut inner = state.inner.lock().unwrap();
    // A finished load releases anyone blocked in `navigate_and_wait`.
    if !loading {
      for tx in inner.load_waiters.drain(..) {
        let _ = tx.send(());
      }
    }
    (inner.can_back(), inner.can_forward())
  };
  emit_nav(app, &u.to_string(), loading, can_back, can_fwd);
}

/// Decide what to do with a `window.open(...)` from the preview. A sized popup is
/// the Fabric auth broker → let WebView2 own it (`Allow`). A plain link → open in
/// the user's browser and deny the in-app window.
fn on_new_window(
  app: &AppHandle,
  u: &Url,
  features: tauri::webview::NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
  let is_auth_popup = features.size().is_some() || features.position().is_some();
  if is_auth_popup {
    log::info!("[preview] auth popup -> WebView2-managed: {u}");
    NewWindowResponse::Allow
  } else {
    log::info!("[preview] external link -> browser: {u}");
    let _ = app.opener().open_url(u.to_string(), None::<&str>);
    NewWindowResponse::Deny
  }
}

fn emit_nav(app: &AppHandle, url: &str, loading: bool, can_back: bool, can_fwd: bool) {
  let _ = app.emit(
    PREVIEW_NAV,
    PreviewNavState {
      url: url.to_string(),
      loading,
      can_go_back: can_back,
      can_go_forward: can_fwd,
    },
  );
}

/// Show the preview at `url`, positioned over `bounds`. Creates the child webview
/// on first call; afterwards navigates to `url` (if it changed) and repositions.
#[tauri::command]
pub async fn preview_show_url(
  app: AppHandle,
  state: State<'_, PreviewState>,
  url: String,
  bounds: PreviewBounds,
) -> AppResult<()> {
  let parsed: Url = url
    .parse()
    .map_err(|e| AppError::Msg(format!("invalid preview url {url:?}: {e}")))?;

  // Atomically claim the "created" flag so two near-simultaneous calls can't
  // both try to `add_child` the same label (the second would fail). On a build
  // error we roll the flag back.
  let need_build = {
    let mut inner = state.inner.lock().unwrap();
    if inner.created {
      false
    } else {
      inner.created = true;
      true
    }
  };
  if need_build {
    if let Err(e) = build(&app, parsed.clone(), bounds) {
      state.inner.lock().unwrap().created = false;
      return Err(e);
    }
    state.inner.lock().unwrap().reset_to(&url);
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
      let _ = wv.set_bounds(bounds.to_rect());
      let _ = wv.show();
      state.inner.lock().unwrap().visible = true;
    }
    return Ok(());
  }

  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let _ = wv.set_bounds(bounds.to_rect());
    // Navigate only when the *commanded* URL changes — never when the webview's
    // live URL has merely drifted (SPA route, trailing slash, AAD redirect, query
    // params). A re-show after an overlay closes passes the same URL, so it stays
    // a pure show and preserves the app's in-app/auth state (no reload).
    let needs_nav = {
      let inner = state.inner.lock().unwrap();
      inner.commanded.as_deref() != Some(url.as_str())
    };
    if needs_nav {
      wv.navigate(parsed)
        .map_err(|e| AppError::Msg(e.to_string()))?;
      state.inner.lock().unwrap().reset_to(&url);
    }
    let _ = wv.show();
    state.inner.lock().unwrap().visible = true;
  }
  Ok(())
}

/// Navigate the preview to `url` (recording it as the new commanded root and
/// resetting history) and reposition to `bounds`, **without** changing the
/// webview's visibility.
///
/// The renderer uses this to load a switch / redeploy / Fabric-toggle target
/// while the native surface is hidden behind a loading placeholder, so the stale
/// page is never shown; it re-reveals the webview via [`preview_show_url`] once
/// the new document finishes loading. Visibility stays owned by the renderer's
/// positioning loop, avoiding show/hide races. A no-op until the webview exists
/// (the first load goes through [`preview_show_url`]'s build path).
#[tauri::command]
pub fn preview_navigate(
  app: AppHandle,
  state: State<'_, PreviewState>,
  url: String,
  bounds: PreviewBounds,
) -> AppResult<()> {
  let _guard = watchdog::activity(Activity::PreviewNavigate);
  let parsed: Url = url
    .parse()
    .map_err(|e| AppError::Msg(format!("invalid preview url {url:?}: {e}")))?;
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let _ = wv.set_bounds(bounds.to_rect());
    wv.navigate(parsed)
      .map_err(|e| AppError::Msg(e.to_string()))?;
    state.inner.lock().unwrap().reset_to(&url);
  }
  Ok(())
}

/// Reposition/resize the preview to track its host element. Called frequently
/// from the renderer (rAF-throttled), so it stays a lightweight sync command.
#[tauri::command]
pub fn preview_set_bounds(app: AppHandle, bounds: PreviewBounds) -> AppResult<()> {
  let _guard = watchdog::activity(Activity::PreviewSetBounds);
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.set_bounds(bounds.to_rect())
      .map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Hide the preview (it floats above HTML, so it must hide when covered).
///
/// On Windows `Webview::hide()` on a child WebView2 is unreliable — the surface
/// can keep compositing above the page even after a successful `hide()`, which
/// would let the preview occlude another tab's HTML (e.g. the Design canvas). So
/// we ALSO park it far off-screen; that guarantees it can't cover anything even
/// if the OS ignores `hide()`. The next `preview_show_url` resets real bounds.
#[tauri::command]
pub fn preview_hide(app: AppHandle) -> AppResult<()> {
  let _guard = watchdog::activity(Activity::PreviewHide);
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    #[cfg(windows)]
    let _ = wv.set_bounds(offscreen_bounds().to_rect());
    wv.hide().map_err(|e| AppError::Msg(e.to_string()))?;
    app.state::<PreviewState>().inner.lock().unwrap().visible = false;
  }
  Ok(())
}

/// Reload the current page.
#[tauri::command]
pub fn preview_reload(app: AppHandle) -> AppResult<()> {
  let _guard = watchdog::activity(Activity::PreviewReload);
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.reload().map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Open the browser devtools (web inspector) window for the preview webview, so a
/// user can inspect their deployed app's DOM, console, network and storage. On
/// Windows this opens WebView2's `OpenDevToolsWindow` in a separate window. The
/// call is dispatched to the runtime (non-blocking, hidden-safe), so it never
/// pumps/deadlocks the UI thread the way a capture would.
///
/// Requires the `devtools` cargo feature on `tauri` (see Cargo.toml), which also
/// makes `Webview::open_devtools` compile in release builds; without it this API
/// is gated out entirely.
#[tauri::command]
pub fn preview_open_devtools(app: AppHandle) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.open_devtools();
  }
  Ok(())
}

/// Navigate back one entry in the preview's history (no-op if at the start).
#[tauri::command]
pub fn preview_back(app: AppHandle, state: State<'_, PreviewState>) -> AppResult<()> {
  let target = {
    let mut inner = state.inner.lock().unwrap();
    if !inner.can_back() {
      return Ok(());
    }
    inner.cursor -= 1;
    inner.programmatic = true;
    inner.stack.get(inner.cursor).cloned()
  };
  navigate_to(&app, target);
  Ok(())
}

/// Navigate forward one entry in the preview's history (no-op if at the end).
#[tauri::command]
pub fn preview_forward(app: AppHandle, state: State<'_, PreviewState>) -> AppResult<()> {
  let target = {
    let mut inner = state.inner.lock().unwrap();
    if !inner.can_forward() {
      return Ok(());
    }
    inner.cursor += 1;
    inner.programmatic = true;
    inner.stack.get(inner.cursor).cloned()
  };
  navigate_to(&app, target);
  Ok(())
}

fn navigate_to(app: &AppHandle, target: Option<String>) {
  let _guard = watchdog::activity(Activity::PreviewHistory);
  if let (Some(url), Some(wv)) = (target, app.get_webview(PREVIEW_LABEL)) {
    if let Ok(parsed) = url.parse::<Url>() {
      let _ = wv.navigate(parsed);
    }
  }
}

/// Capture the current preview content as a PNG and return it as a `data:` URL.
///
/// Uses WebView2's `ICoreWebView2::CapturePreview`, which captures the actual
/// rendered web content (not screen pixels), so it works regardless of the
/// webview's z-order or whether something overlaps it. The capture must run on the
/// UI thread, so it is dispatched via [`tauri::webview::Webview::with_webview`];
/// the resulting bytes are handed back to this async command over a oneshot
/// channel. The renderer then shows the image in an annotation overlay.
#[tauri::command]
pub async fn preview_capture(app: AppHandle) -> AppResult<String> {
  let bytes = capture_preview_bytes(&app).await?;
  let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
  Ok(format!("data:image/png;base64,{b64}"))
}

/// Capture the current preview content as raw PNG bytes, **without** any
/// visibility check. The caller MUST guarantee the surface is currently rendering
/// (visible — possibly parked off-screen): WebView2's `CapturePreview` pumps the
/// UI-thread message loop until completion, and on a hidden surface that signal
/// never comes, freezing the whole app. The capture runs on the UI thread via
/// [`tauri::webview::Webview::with_webview`]; the bytes come back over a oneshot.
async fn capture_now(app: &AppHandle) -> AppResult<Vec<u8>> {
  let wv = app
    .get_webview(PREVIEW_LABEL)
    .ok_or_else(|| AppError::Msg("preview is not open".into()))?;

  let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
  wv.with_webview(move |platform| {
    // On the UI thread now: label it so a hang here names CapturePreview.
    let _guard = watchdog::activity(Activity::PreviewCapture);
    let _ = tx.send(capture_png(&platform));
  })
  .map_err(|e| AppError::Msg(format!("failed to access preview webview: {e}")))?;

  // Belt-and-suspenders: `capture_png` already bounds its own UI-thread pump, but
  // cap the whole round-trip too so a stalled dispatch can never wedge the caller.
  let out = match tokio::time::timeout(Duration::from_secs(10), rx).await {
    Ok(Ok(res)) => res.map_err(AppError::Msg),
    Ok(Err(_)) => Err(AppError::Msg("preview capture was cancelled".into())),
    Err(_) => Err(AppError::Msg("preview capture timed out".into())),
  };
  // A capture timeout means CapturePreview never signalled and the UI thread was
  // blocked up to ~5s — a near-hang worth a breadcrumb (the watchdog only fires
  // past 10s, so these would otherwise go unrecorded).
  if let Err(ref e) = out {
    let msg = e.to_string();
    if msg.contains("timed out") {
      crashlog::log_error(
        "preview",
        &format!("{msg} — CapturePreview blocked the UI thread up to ~5s (slow/absent GPU signal)"),
      );
    }
  }
  out
}

/// Capture the current preview content as raw PNG bytes for the **renderer's own**
/// annotate/capture flow ([`preview_capture`]). Refuses (soft failure) unless the
/// surface is currently shown to the user, since the renderer only ever captures a
/// visible preview. The Fabricator agent uses [`agent_capture`] instead, which can
/// capture silently while the preview is hidden.
pub(crate) async fn capture_preview_bytes(app: &AppHandle) -> AppResult<Vec<u8>> {
  if app.get_webview(PREVIEW_LABEL).is_none() {
    return Err(AppError::Msg("preview is not open".into()));
  }
  // CapturePreview pumps the UI-thread message loop until WebView2 signals
  // completion — but on a hidden surface that signal never comes, hanging the
  // entire app (you can't even close the window). Refuse to capture unless the
  // webview is currently shown; callers treat this as a soft failure.
  if !is_preview_visible(app) {
    return Err(AppError::Msg("preview is not visible".into()));
  }
  capture_now(app).await
}

/// Bounds used to park the preview far off-screen for a silent capture: a
/// realistic desktop viewport positioned well outside any monitor, so the surface
/// keeps rendering (and `CapturePreview` works) while staying invisible.
#[cfg(windows)]
fn offscreen_bounds() -> PreviewBounds {
  PreviewBounds {
    x: OFFSCREEN_COORD,
    y: OFFSCREEN_COORD,
    width: OFFSCREEN_SIZE.0,
    height: OFFSCREEN_SIZE.1,
  }
}

/// Whether the preview child webview is currently shown (not hidden behind
/// another tab/overlay). Callers that need to reveal it can skip the (route-
/// resetting) re-show when this is already `true`.
pub(crate) fn is_preview_visible(app: &AppHandle) -> bool {
  app.state::<PreviewState>().inner.lock().unwrap().visible
}

/// Hard ceiling on how long the Windows capture may pump the UI-thread message
/// loop. `CapturePreview`'s completion is delivered via the message loop, but on a
/// misbehaving GPU (notably Parallels/VMs) it can never arrive — an unbounded pump
/// (`wait_for_async_operation`) then freezes the entire app. We pump our own
/// bounded loop instead and bail with an error after this deadline, which callers
/// treat as a soft failure (blank/hide) rather than a hang.
#[cfg(windows)]
const CAPTURE_PUMP_DEADLINE: Duration = Duration::from_secs(5);

/// Capture the WebView2 preview to PNG bytes. Runs on the UI thread inside
/// [`preview_capture`]'s `with_webview` closure. `CapturePreview` completes via
/// the UI-thread message loop, so we pump it ourselves — but with a deadline so a
/// completion that never comes (flaky VM GPU) can't hang the app, mirroring the
/// macOS snapshot path's bounded run-loop.
#[cfg(windows)]
fn capture_png(platform: &tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
  use std::sync::mpsc;
  use std::time::Instant;

  use webview2_com::CapturePreviewCompletedHandler;
  use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
  use windows::Win32::Foundation::HGLOBAL;
  use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
  use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
  use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
  };

  let core = unsafe { platform.controller().CoreWebView2() }
    .map_err(|e| format!("CoreWebView2(): {e}"))?;

  // An auto-growing in-memory stream; its HGLOBAL is freed when the last
  // reference (`stream`) drops, after we have copied the bytes out below.
  let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
    .map_err(|e| format!("CreateStreamOnHGlobal: {e}"))?;

  // Kick off the capture and signal completion over a channel, then pump the UI
  // message loop ourselves until it fires — bounded by `CAPTURE_PUMP_DEADLINE` so
  // a never-arriving completion can't block forever.
  let (tx, rx) = mpsc::channel::<windows::core::Result<()>>();
  let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
    let _ = tx.send(result);
    Ok(())
  }));
  unsafe {
    core
      .CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
      .map_err(|e| format!("CapturePreview: {e}"))?;
  }

  let deadline = Instant::now() + CAPTURE_PUMP_DEADLINE;
  loop {
    match rx.try_recv() {
      Ok(result) => {
        result.map_err(|e| format!("CapturePreview: {e}"))?;
        break;
      }
      Err(mpsc::TryRecvError::Disconnected) => {
        return Err("preview capture handler dropped".into());
      }
      Err(mpsc::TryRecvError::Empty) => {}
    }
    if Instant::now() >= deadline {
      return Err("preview capture timed out".into());
    }
    // Drain any pending messages (delivers WebView2's completion), then yield
    // briefly so we don't spin the CPU while waiting.
    unsafe {
      let mut msg = MSG::default();
      while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
    }
    std::thread::sleep(Duration::from_millis(5));
  }

  // The PNG now lives in the stream's backing HGLOBAL — copy it into a Vec.
  unsafe {
    let hglobal =
      GetHGlobalFromStream(&stream).map_err(|e| format!("GetHGlobalFromStream: {e}"))?;
    let size = GlobalSize(hglobal);
    let ptr = GlobalLock(hglobal) as *const u8;
    if ptr.is_null() {
      return Err("GlobalLock returned null".into());
    }
    let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
    let _ = GlobalUnlock(hglobal);
    Ok(bytes)
  }
}

/// Non-Windows stub so the crate still builds on other targets (WebView2-only).
#[cfg(not(any(windows, target_os = "macos")))]
fn capture_png(_platform: &tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
  Err("preview capture is not supported on this platform".into())
}

/// Capture the WKWebView preview to PNG bytes. Runs on the UI thread inside
/// [`preview_capture`]'s `with_webview` closure. Uses
/// `-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`, which captures
/// the rendered web content (the macOS analogue of WebView2's `CapturePreview`),
/// then converts the resulting `NSImage` to PNG via `NSBitmapImageRep`. The
/// snapshot API is asynchronous, so we pump the main run loop until its completion
/// block fires (bounded by a timeout), mirroring the Windows message-pump approach.
#[cfg(target_os = "macos")]
fn capture_png(platform: &tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
  use std::cell::RefCell;
  use std::rc::Rc;

  use block2::RcBlock;
  use objc2_app_kit::NSImage;
  use objc2_foundation::{
    MainThreadMarker, NSDate, NSDefaultRunLoopMode, NSError, NSRunLoop,
  };
  use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

  // We are invoked on the UI thread from `with_webview`.
  let mtm = MainThreadMarker::new()
    .ok_or_else(|| "preview capture must run on the main thread".to_string())?;

  // SAFETY: on macOS, `PlatformWebview::inner()` returns the `WKWebView` pointer.
  let webview: &WKWebView = unsafe {
    (platform.inner() as *const WKWebView)
      .as_ref()
      .ok_or_else(|| "preview WKWebView was null".to_string())?
  };

  type Outcome = Result<Vec<u8>, String>;
  // Shared slot the completion block writes the result into. Everything here runs
  // on the main thread, so the non-Send `Rc`/`RefCell` are safe.
  let slot: Rc<RefCell<Option<Outcome>>> = Rc::new(RefCell::new(None));
  let slot_cb = slot.clone();

  let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
    let outcome = unsafe { snapshot_image_to_png(image, error) };
    *slot_cb.borrow_mut() = Some(outcome);
  });

  let config = unsafe { WKSnapshotConfiguration::new(mtm) };
  unsafe {
    webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
  }

  // Pump the main run loop until the completion block fires (bounded).
  let run_loop = NSRunLoop::currentRunLoop();
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
  while slot.borrow().is_none() {
    if std::time::Instant::now() > deadline {
      return Err("preview snapshot timed out".into());
    }
    let until = NSDate::dateWithTimeIntervalSinceNow(0.02);
    unsafe { run_loop.runMode_beforeDate(NSDefaultRunLoopMode, &until) };
  }

  let result = slot.borrow_mut().take();
  result.unwrap_or_else(|| Err("preview snapshot produced no result".into()))
}

/// Convert the `NSImage` handed back by `takeSnapshot…` into PNG bytes.
///
/// # Safety
/// `image`/`error` must be the (possibly null) pointers passed to the snapshot
/// completion block; this must run on the main thread.
#[cfg(target_os = "macos")]
unsafe fn snapshot_image_to_png(
  image: *mut objc2_app_kit::NSImage,
  error: *mut objc2_foundation::NSError,
) -> Result<Vec<u8>, String> {
  use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
  use objc2_foundation::NSDictionary;

  if image.is_null() {
    if let Some(err) = error.as_ref() {
      return Err(format!("WKWebView snapshot failed: {}", err.localizedDescription()));
    }
    return Err("WKWebView snapshot returned no image".into());
  }
  let image = &*image;

  let tiff = image
    .TIFFRepresentation()
    .ok_or_else(|| "snapshot has no TIFF representation".to_string())?;
  let rep = NSBitmapImageRep::imageRepWithData(&tiff)
    .ok_or_else(|| "could not build a bitmap rep from the snapshot".to_string())?;
  let empty = NSDictionary::new();
  let png = rep
    .representationUsingType_properties(NSBitmapImageFileType::PNG, &empty)
    .ok_or_else(|| "could not encode the snapshot as PNG".to_string())?;
  Ok(png.to_vec())
}
