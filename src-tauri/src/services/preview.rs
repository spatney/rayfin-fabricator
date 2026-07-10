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

use std::collections::VecDeque;
#[cfg(windows)]
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
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
/// Renderer event emitted when the live page reports an actionable runtime
/// diagnostic (matches `IpcChannels.previewDiagnostic`).
const PREVIEW_DIAGNOSTIC: &str = "preview:diagnostic";
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
#[cfg(windows)]
const OFFSCREEN_BUILD_SETTLE: Duration = Duration::from_millis(600);
#[cfg(windows)]
const OFFSCREEN_PAINT_SETTLE: Duration = Duration::from_millis(180);

/// Document-start diagnostics bridge. It records bounded console and network
/// telemetry and exposes safe DOM inspection/interaction helpers without request
/// bodies, headers, browser storage, or input values.
const DIAGNOSTICS_INIT_JS: &str = include_str!("preview_diagnostics.js");
const DIAGNOSTIC_POLL_INTERVAL: Duration = Duration::from_millis(1200);
const DIAGNOSTIC_DEDUPE_TTL: Duration = Duration::from_secs(30 * 60);
const DIAGNOSTIC_NOTIFY_COOLDOWN: Duration = Duration::from_secs(5);
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REPORTED_DIAGNOSTICS: usize = 200;

/// The in-page "design mode" controller (see `services/design_agent.js`).
/// Injected at document-start into **all frames**
/// ([`WebviewBuilder::initialization_script_for_all_frames`]) so it is present in
/// the deployed app even when the app is embedded in a *cross-origin* iframe inside
/// the Fabric portal — the top-frame `wv.eval` used for the direct view can't reach
/// a cross-origin iframe. The controller stays dormant (defines
/// `window.__rayfinDesign` + a passive `postMessage` listener) until
/// [`preview_design_set`] enables it. In the Fabric-embedded view the top (Fabric
/// shell) frame runs as a *relay* that bridges host calls to the app iframe over
/// `postMessage`; in the direct view the app is the top frame and runs the full
/// controller locally. Idempotent: defines `window.__rayfinDesign` once.
const DESIGN_AGENT_JS: &str = include_str!("design_agent.js");

/// JS that reads the design controller's lightweight status (returns an object or
/// `null`). WebView2 serializes the completion value to JSON for the callback.
const DESIGN_POLL_JS: &str =
  "(function(){try{return window.__rayfinDesign?window.__rayfinDesign.peek():null}catch(e){return null}})()";

/// JS that drains a pending "Send to chat" handoff (returns an object once, then
/// clears the change-set), or `null` when nothing is pending.
const DESIGN_DRAIN_JS: &str =
  "(function(){try{return window.__rayfinDesign?window.__rayfinDesign.drain():null}catch(e){return null}})()";

/// JS that drains a pending "Generate with AI" request from a placeholder (returns
/// `{id, description, width, height}` once, then clears it), or `null`.
const DESIGN_DRAIN_AI_JS: &str =
  "(function(){try{return window.__rayfinDesign?window.__rayfinDesign.drainAi():null}catch(e){return null}})()";

/// JS that drains a pending "Edit with AI" restyle request for a selected element
/// (returns `{id, description, model, context}` once, then clears it), or `null`.
const DESIGN_DRAIN_AI_EDIT_JS: &str =
  "(function(){try{return window.__rayfinDesign?window.__rayfinDesign.drainAiEdit():null}catch(e){return null}})()";

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
  /// Project whose deployed app currently owns this preview.
  project_id: Option<String>,
  /// Whether a top-level document load is currently in progress.
  loading: bool,
  /// Starts the single background diagnostics monitor once.
  monitor_started: bool,
  /// Runtime-error fingerprints already reported recently. Bounded and TTL-pruned
  /// so a fix/deploy/error cycle cannot wake the agent forever.
  reported_diagnostics: VecDeque<(String, Instant)>,
  /// Coalesces bursts; the first alert tells the agent to inspect the full buffers.
  last_diagnostic_notification: Option<Instant>,
  /// Whether an in-preview "design mode" session is active. Drives re-injection
  /// of the design controller on every finished page load (so it survives SPA
  /// navigations / reloads) — see [`preview_design_set`] and [`on_page_load`].
  design_active: bool,
  /// When the active design session targets the Fabric-embedded view, the origin
  /// of the deployed app (the cross-origin iframe inside the Fabric portal). The
  /// top frame is then re-enabled as a `relay` for that origin on every finished
  /// page load; `None` means the direct view (top frame is the app itself).
  design_relay: Option<String>,
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
    self.loading = true;
    // A genuinely new root URL (project switch, redeploy-navigate, Fabric
    // toggle) is a different app — end any active design session so the
    // controller isn't re-injected into it (see `on_page_load`).
    self.design_active = false;
    self.design_relay = None;
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
    // Expose the web inspector on the preview so users can right-click → Inspect
    // to open browser devtools for their deployed app. Devtools default to on in
    // debug but off in release wry; the `devtools` cargo feature (Cargo.toml)
    // enables `with_devtools` + the context-menu inspector, and this keeps it on.
    .devtools(true)
    // Install the safe diagnostics bridge before any app code runs. Keep it in
    // the top-level direct preview so Fabric portal shell failures are not
    // mistaken for repairable application failures.
    .initialization_script(DIAGNOSTICS_INIT_JS)
    // The design-mode controller is baked in at document-start into ALL frames
    // (dormant until `preview_design_set` enables it). This is the only way to
    // reach the app when it is embedded in a cross-origin iframe inside the
    // Fabric portal, since `wv.eval` only runs in the top frame. See
    // [`DESIGN_AGENT_JS`].
    .initialization_script_for_all_frames(DESIGN_AGENT_JS)
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
  start_diagnostic_monitor(app);
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
  let (can_back, can_fwd, design_active, design_relay) = {
    let mut inner = state.inner.lock().unwrap();
    inner.loading = loading;
    // A finished load releases anyone blocked in `navigate_and_wait`.
    if !loading {
      for tx in inner.load_waiters.drain(..) {
        let _ = tx.send(());
      }
    }
    (
      inner.can_back(),
      inner.can_forward(),
      inner.design_active,
      inner.design_relay.clone(),
    )
  };
  // Re-enable the design controller after a finished load so an active design
  // session survives SPA navigations and reloads. The controller itself is a
  // document-start init script (present in every frame after each load); this
  // only re-arms the top frame — in relay mode it re-adopts the app iframe via
  // the postMessage handshake.
  if !loading && design_active {
    if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
      let _ = wv.eval(design_enable_js(design_relay.as_deref()));
    }
  }
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
    inner.project_id = crate::services::store::get_state().active_project_id;
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
      state.inner.lock().unwrap().project_id = crate::services::store::get_state().active_project_id;
      let _ = wv.set_bounds(bounds.to_rect());
      let _ = wv.show();
      state.inner.lock().unwrap().visible = true;
    }
    return Ok(());
  }

  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    state.inner.lock().unwrap().project_id = crate::services::store::get_state().active_project_id;
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
    state.inner.lock().unwrap().project_id = crate::services::store::get_state().active_project_id;
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
/// would let the preview occlude another tab's HTML (e.g. the Code / Model /
/// Advisor tab). So we ALSO park it far off-screen; that guarantees it can't
/// cover anything even if the OS ignores `hide()`. The next `preview_show_url`
/// resets real bounds.
///
/// Used for a *durable* hide — a tab switch, the pane collapsing to 0×0, or the
/// pane unmounting. A transient HTML overlay (dropdown / menu / modal) instead
/// uses [`preview_suppress`], which keeps the surface rendering so the reveal is
/// flash-free.
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

/// Suppress the preview for a *transient* HTML overlay (dropdown / menu / modal)
/// covering the build view, **without** stopping the surface from rendering.
///
/// Unlike [`preview_hide`], this does not toggle WebView2 visibility off. On
/// Windows it parks the surface far off-screen — **at the same size as its host**
/// — while keeping it shown, so it keeps compositing live content (the same trick
/// the silent agent capture uses; see [`offscreen_bounds`]). Keeping the size
/// unchanged means the reveal (a [`preview_show_url`] `set_bounds` back to the
/// host rect) is a pure *move*, not a resize: WebView2 doesn't relayout/repaint,
/// so the composited frame reappears instantly with no blank repaint-on-show
/// flash. Parked far outside any monitor it also can't occlude the overlay; if
/// the off-screen move fails we fall back to a hard `hide()` so it can never
/// cover the overlay. Elsewhere (macOS) there is no off-screen park, so this is a
/// plain hide.
#[tauri::command]
pub fn preview_suppress(app: AppHandle, bounds: PreviewBounds) -> AppResult<()> {
  let _guard = watchdog::activity(Activity::PreviewSuppress);
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    #[cfg(windows)]
    {
      // Park it off-screen at the host's CURRENT size, keeping it shown. Same
      // size ⇒ the reveal is a pure move (no viewport resize, no repaint), so the
      // live frame reappears instantly. If parking fails, fall back to a hard
      // hide so it can't occlude the overlay.
      let parked = PreviewBounds {
        x: OFFSCREEN_COORD,
        y: OFFSCREEN_COORD,
        width: bounds.width.max(1.0),
        height: bounds.height.max(1.0),
      };
      if wv.set_bounds(parked.to_rect()).is_ok() {
        wv.show().map_err(|e| AppError::Msg(e.to_string()))?;
        app.state::<PreviewState>().inner.lock().unwrap().visible = true;
      } else {
        wv.hide().map_err(|e| AppError::Msg(e.to_string()))?;
        app.state::<PreviewState>().inner.lock().unwrap().visible = false;
      }
    }
    #[cfg(not(windows))]
    {
      let _ = bounds;
      wv.hide().map_err(|e| AppError::Msg(e.to_string()))?;
      app.state::<PreviewState>().inner.lock().unwrap().visible = false;
    }
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnostic {
  kind: String,
  message: String,
  url: Option<String>,
  status: Option<u16>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDiagnosticEvent {
  pub id: String,
  pub fingerprint: String,
  pub project_id: String,
  pub kind: String,
  pub summary: String,
  pub details: String,
  pub url: Option<String>,
  pub occurred_at: String,
}

pub(crate) fn redact_diagnostic_text(input: &str) -> String {
  static BEARER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-=]+").unwrap());
  static JWT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b").unwrap()
  });
  static QUERY_SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
      r"(?i)([?&](?:access[_-]?token|account[_-]?key|api[_-]?key|authorization|code|client[_-]?secret|id[_-]?token|key|password|passwd|pwd|refresh[_-]?token|sas|secret|shared[_-]?access[_-]?signature|sig|signature|subscription[_-]?key|token)=)[^&#\s]+",
    )
    .unwrap()
  });
  static JSON_SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
      r#"(?i)("(?:access[_-]?token|account[_-]?key|api[_-]?key|authorization|client[_-]?secret|cookie|id[_-]?token|password|passwd|pwd|refresh[_-]?token|sas|secret|set-cookie|shared[_-]?access[_-]?signature|subscription[_-]?key|token)"\s*:\s*")[^"]*""#,
    )
    .unwrap()
  });
  static PLAIN_SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
      r#"(?i)\b(access[_-]?token|account[_-]?key|api[_-]?key|authorization|client[_-]?secret|cookie|id[_-]?token|password|passwd|pwd|refresh[_-]?token|sas|secret|set-cookie|shared[_-]?access[_-]?signature|subscription[_-]?key|token)\s*[:=]\s*["']?[^\s"',;&]+"#,
    )
    .unwrap()
  });

  let redacted = BEARER_RE.replace_all(input, "Bearer <redacted>");
  let redacted = JWT_RE.replace_all(&redacted, "<redacted-jwt>");
  let redacted = QUERY_SECRET_RE.replace_all(&redacted, "${1}<redacted>");
  let redacted = JSON_SECRET_RE.replace_all(&redacted, "${1}<redacted>\"");
  let redacted = PLAIN_SECRET_RE.replace_all(&redacted, "${1}=<redacted>");
  truncate_text(&redacted, 16_000)
}

fn truncate_text(input: &str, max_chars: usize) -> String {
  if input.chars().count() <= max_chars {
    return input.to_string();
  }
  let mut output = input.chars().take(max_chars).collect::<String>();
  output.push_str("\n... truncated ...");
  output
}

pub(crate) fn project_live_url(project: &crate::types::StudioProject) -> Option<String> {
  let deploy = project.last_deploy.as_ref()?;
  deploy.url.clone().or_else(|| deploy.api_url.clone())
}

fn is_direct_project_preview(project_id: &str, commanded: Option<&str>) -> bool {
  let Some(commanded) = commanded else {
    return false;
  };
  let Some(project) = crate::services::store::find_project(project_id) else {
    return false;
  };
  let Some(live_url) = project_live_url(&project) else {
    return false;
  };
  url_is_within_app_base(commanded, &live_url)
}

pub(crate) fn url_is_within_app_base(current: &str, live: &str) -> bool {
  let (Ok(current), Ok(live)) = (tauri::Url::parse(current), tauri::Url::parse(live)) else {
    return false;
  };
  if current.scheme() != live.scheme()
    || current.host_str() != live.host_str()
    || current.port_or_known_default() != live.port_or_known_default()
  {
    return false;
  }

  let live_path = live.path().trim_end_matches('/');
  live_path.is_empty()
    || current.path() == live_path
    || current
      .path()
      .strip_prefix(live_path)
      .is_some_and(|suffix| suffix.starts_with('/'))
}

fn start_diagnostic_monitor(app: &AppHandle) {
  {
    let state = app.state::<PreviewState>();
    let mut inner = state.inner.lock().unwrap();
    if inner.monitor_started {
      return;
    }
    inner.monitor_started = true;
  }

  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(DIAGNOSTIC_POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
      interval.tick().await;
      if app.get_webview(PREVIEW_LABEL).is_none() {
        continue;
      }

      let (project_id, current_url, loading) = {
        let state = app.state::<PreviewState>();
        let inner = state.inner.lock().unwrap();
        (
          inner.project_id.clone(),
          inner.stack.get(inner.cursor).cloned().or_else(|| inner.commanded.clone()),
          inner.loading,
        )
      };
      let Some(project_id) = project_id else {
        continue;
      };
      if loading || !is_direct_project_preview(&project_id, current_url.as_deref()) {
        continue;
      }

      let diagnostics = match runtime_diagnostics(&app).await {
        Ok(value) => value,
        Err(_) => continue,
      };
      for diagnostic in diagnostics {
        emit_runtime_diagnostic(&app, &project_id, diagnostic);
      }
    }
  });
}

fn emit_runtime_diagnostic(app: &AppHandle, project_id: &str, diagnostic: RuntimeDiagnostic) {
  let message = redact_diagnostic_text(&diagnostic.message);
  let url = diagnostic.url.map(|value| redact_diagnostic_text(&value));
  let fingerprint = format!(
    "{}|{}|{}|{}",
    project_id,
    diagnostic.kind,
    diagnostic.status.unwrap_or_default(),
    message
  );
  let now = Instant::now();

  {
    let state = app.state::<PreviewState>();
    let mut inner = state.inner.lock().unwrap();
    while inner
      .reported_diagnostics
      .front()
      .is_some_and(|(_, reported_at)| now.duration_since(*reported_at) > DIAGNOSTIC_DEDUPE_TTL)
    {
      inner.reported_diagnostics.pop_front();
    }
    if inner
      .reported_diagnostics
      .iter()
      .any(|(existing, _)| existing == &fingerprint)
    {
      return;
    }
    inner.reported_diagnostics.push_back((fingerprint.clone(), now));
    while inner.reported_diagnostics.len() > MAX_REPORTED_DIAGNOSTICS {
      inner.reported_diagnostics.pop_front();
    }
    if inner
      .last_diagnostic_notification
      .is_some_and(|last| now.duration_since(last) < DIAGNOSTIC_NOTIFY_COOLDOWN)
    {
      return;
    }
    inner.last_diagnostic_notification = Some(now);
  }

  let summary = match diagnostic.kind.as_str() {
    "network" => "The live app reported a failed network request",
    _ => "The live app reported a runtime error",
  };
  let event = PreviewDiagnosticEvent {
    id: uuid::Uuid::new_v4().to_string(),
    fingerprint,
    project_id: project_id.to_string(),
    kind: diagnostic.kind,
    summary: summary.to_string(),
    details: truncate_text(&message, 2_000),
    url,
    occurred_at: chrono::Utc::now().to_rfc3339(),
  };
  if let Err(error) = app.emit(PREVIEW_DIAGNOSTIC, event) {
    log::warn!("failed to emit preview diagnostic: {error}");
  }
}

async fn runtime_diagnostics(app: &AppHandle) -> AppResult<Vec<RuntimeDiagnostic>> {
  let script =
    "window.__fabricatorDiagnostics ? window.__fabricatorDiagnostics.drainErrors() : []";
  Ok(
    eval_json::<Vec<RuntimeDiagnostic>>(app, script, EVAL_TIMEOUT)
      .await?
      .unwrap_or_default(),
  )
}

pub(crate) async fn read_console(
  app: &AppHandle,
  level: Option<&str>,
  query: Option<&str>,
  since: Option<u64>,
  limit: usize,
  clear: bool,
) -> AppResult<serde_json::Value> {
  let options = serde_json::json!({
    "level": level,
    "query": query,
    "since": since,
    "limit": limit.clamp(1, 200),
    "clear": clear,
  });
  let script = format!(
    "window.__fabricatorDiagnostics ? window.__fabricatorDiagnostics.readConsole({}) : []",
    serde_json::to_string(&options).unwrap_or_else(|_| "{}".into())
  );
  Ok(
    eval_json::<serde_json::Value>(app, &script, EVAL_TIMEOUT)
      .await?
      .unwrap_or_else(|| serde_json::json!([])),
  )
}

pub(crate) async fn read_network(
  app: &AppHandle,
  errors_only: bool,
  query: Option<&str>,
  url_includes: Option<&str>,
  method: Option<&str>,
  resource_type: Option<&str>,
  status_min: Option<u16>,
  status_max: Option<u16>,
  since: Option<u64>,
  limit: usize,
  clear: bool,
) -> AppResult<serde_json::Value> {
  let options = serde_json::json!({
    "errorsOnly": errors_only,
    "query": query,
    "urlIncludes": url_includes,
    "method": method,
    "resourceType": resource_type,
    "statusMin": status_min,
    "statusMax": status_max,
    "since": since,
    "limit": limit.clamp(1, 300),
    "clear": clear,
  });
  let script = format!(
    "window.__fabricatorDiagnostics ? window.__fabricatorDiagnostics.readNetwork({}) : []",
    serde_json::to_string(&options).unwrap_or_else(|_| "{}".into())
  );
  Ok(
    eval_json::<serde_json::Value>(app, &script, EVAL_TIMEOUT)
      .await?
      .unwrap_or_else(|| serde_json::json!([])),
  )
}

pub(crate) async fn inspect_page(
  app: &AppHandle,
  selector: Option<&str>,
  query: Option<&str>,
  limit: usize,
  include_body_text: bool,
) -> AppResult<serde_json::Value> {
  let options = serde_json::json!({
    "selector": selector,
    "query": query,
    "limit": limit.clamp(1, 200),
    "includeBodyText": include_body_text,
  });
  let script = format!(
    "window.__fabricatorDiagnostics ? window.__fabricatorDiagnostics.snapshot({}) : {{ok:false,error:'Diagnostics bridge is unavailable'}}",
    serde_json::to_string(&options).unwrap_or_else(|_| "{}".into())
  );
  Ok(
    eval_json::<serde_json::Value>(app, &script, EVAL_TIMEOUT)
      .await?
      .unwrap_or_else(|| serde_json::json!({"ok": false, "error": "No page snapshot returned"})),
  )
}

pub(crate) async fn interact(
  app: &AppHandle,
  action: &str,
  selector: Option<&str>,
  value: Option<serde_json::Value>,
  allowed_base: &str,
) -> AppResult<serde_json::Value> {
  let options = serde_json::json!({
    "action": action,
    "selector": selector,
    "value": value,
    "allowedBase": allowed_base,
  });
  let script = format!(
    "window.__fabricatorDiagnostics ? window.__fabricatorDiagnostics.interact({}) : {{ok:false,error:'Diagnostics bridge is unavailable'}}",
    serde_json::to_string(&options).unwrap_or_else(|_| "{}".into())
  );
  Ok(
    eval_json::<serde_json::Value>(app, &script, EVAL_TIMEOUT)
      .await?
      .unwrap_or_else(|| serde_json::json!({"ok": false, "error": "No interaction result returned"})),
  )
}

/// Lightweight status of the in-preview design session, read by the renderer's
/// poll while design mode is active. Mirrors `window.__rayfinDesign.peek()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignStatus {
  pub enabled: bool,
  pub version: u64,
  pub change_count: u32,
  /// True once the user hit "Send to chat" — the renderer then captures a
  /// (highlighted) screenshot and drains the handoff.
  pub handoff_ready: bool,
  /// True once the user asked to "Generate with AI" on a placeholder — the
  /// renderer then drains the request, generates the HTML, and applies it.
  #[serde(default)]
  pub ai_pending: bool,
  /// Whether the controller currently has the AI model list (it's re-injected
  /// empty on page reloads, so the renderer re-pushes when this is false).
  #[serde(default)]
  pub has_models: bool,
  /// The placeholder AI picker's currently selected model id (the renderer
  /// persists this so the choice survives across sessions). `None` when unset.
  #[serde(default)]
  pub ai_model: Option<String>,
  /// True once the user hit "Apply" on an element's "Edit with AI" card — the
  /// renderer then drains the request, restyles via the model, and applies it.
  #[serde(default)]
  pub ai_edit_pending: bool,
}

/// A drained "Send to chat" handoff: the composed instruction + change count.
/// Mirrors `window.__rayfinDesign.drain()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignHandoff {
  pub instruction: String,
  pub change_count: u32,
}

/// A drained "Generate with AI" request from a placeholder. Mirrors
/// `window.__rayfinDesign.drainAi()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignAiRequest {
  /// Stable placeholder id (`data-rayfin-ph-id`) to target with the result.
  pub id: String,
  pub description: String,
  pub width: u32,
  pub height: u32,
  /// Model id chosen in the picker (`None` → the fast model resolved by the host).
  #[serde(default)]
  pub model: Option<String>,
}

/// A drained "Edit with AI" restyle request for a selected element. Mirrors
/// `window.__rayfinDesign.drainAiEdit()`. `context` is opaque here — the renderer
/// forwards it straight to `design_restyle_element` (which decodes it into a
/// `RestyleContext`); the resulting patch is applied back via
/// [`preview_design_apply_restyle`] targeting `id`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignAiEditRequest {
  /// Stable element id (`data-rayfin-edit-id`) to target with the patch.
  pub id: String,
  /// All target element ids for a multi-selection — the one patch applies to each
  /// (empty/absent for a single selection, which falls back to `id`).
  #[serde(default)]
  pub ids: Vec<String>,
  pub description: String,
  /// Model id chosen in the picker (`None` → the fast model resolved by the host).
  #[serde(default)]
  pub model: Option<String>,
  /// Compact element context (tag/text/classes/component/styles/chart spec).
  #[serde(default)]
  pub context: serde_json::Value,
}

/// Build the JS that enables the (already document-start-injected) design
/// controller in the top frame. In the direct view the top frame *is* the app and
/// runs the controller locally (`enable('direct')`); in the Fabric-embedded view
/// the top frame becomes a relay for the app iframe at `relay_origin`
/// (`enable('relay', "<origin>")`), which bridges host calls over `postMessage`.
fn design_enable_js(relay_origin: Option<&str>) -> String {
  match relay_origin {
    Some(origin) => format!(
      "try{{window.__rayfinDesign&&window.__rayfinDesign.enable('relay',{})}}catch(e){{}}",
      serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".into())
    ),
    None => {
      "try{window.__rayfinDesign&&window.__rayfinDesign.enable('direct')}catch(e){}".to_string()
    }
  }
}

/// The scheme://host:port origin of `url` (e.g. `https://app.example.com`), or
/// `None` if it can't be parsed / has an opaque origin. Used to tell the design
/// relay which cross-origin iframe (the deployed app) to drive inside the Fabric
/// portal shell.
fn url_origin(url: &str) -> Option<String> {
  match Url::parse(url).map(|u| u.origin()) {
    Ok(origin) if origin.is_tuple() => Some(origin.ascii_serialization()),
    _ => None,
  }
}

/// Evaluate `js` on the preview webview and return its JSON completion value
/// parsed into `T` (or `None` when the webview is gone / the value is `null`).
/// WebView2 serializes the result to JSON for the callback; the whole round-trip
/// is time-bounded so a stalled dispatch can never wedge the caller.
async fn eval_json<T: serde::de::DeserializeOwned>(
  app: &AppHandle,
  js: &str,
  timeout: Duration,
) -> AppResult<Option<T>> {
  let Some(wv) = app.get_webview(PREVIEW_LABEL) else {
    return Ok(None);
  };
  let (tx, rx) = oneshot::channel::<String>();
  let tx = Mutex::new(Some(tx));
  wv.eval_with_callback(js.to_string(), move |res| {
    if let Ok(mut guard) = tx.lock() {
      if let Some(tx) = guard.take() {
        let _ = tx.send(res);
      }
    }
  })
  .map_err(|e| AppError::Msg(format!("failed to eval on preview: {e}")))?;
  let res = match tokio::time::timeout(timeout, rx).await {
    Ok(Ok(s)) => s,
    _ => return Ok(None),
  };
  let trimmed = res.trim();
  if trimmed.is_empty() || trimmed == "null" {
    return Ok(None);
  }
  match serde_json::from_str::<T>(trimmed) {
    Ok(v) => Ok(Some(v)),
    Err(_) => Ok(None),
  }
}

/// Invoke one Chrome DevTools Protocol method against the live WebView2 page.
/// This is the unrestricted escape hatch behind the agent's raw CDP and page
/// evaluation tools.
#[cfg(windows)]
pub(crate) async fn call_cdp(
  app: &AppHandle,
  method: &str,
  params: &serde_json::Value,
  timeout: Duration,
) -> AppResult<serde_json::Value> {
  use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
  use windows::core::HSTRING;

  let wv = app
    .get_webview(PREVIEW_LABEL)
    .ok_or_else(|| AppError::Msg("preview is not open".into()))?;
  let method_name = method.to_string();
  let method = HSTRING::from(&method_name);
  let params = HSTRING::from(
    serde_json::to_string(params)
      .map_err(|error| AppError::Msg(format!("failed to serialize CDP parameters: {error}")))?,
  );
  let (tx, rx) = oneshot::channel::<Result<String, String>>();
  let tx = Arc::new(Mutex::new(Some(tx)));
  let tx_for_dispatch = tx.clone();

  wv.with_webview(move |platform| {
    let core = match unsafe { platform.controller().CoreWebView2() } {
      Ok(core) => core,
      Err(error) => {
        if let Some(tx) = tx_for_dispatch.lock().unwrap().take() {
          let _ = tx.send(Err(format!("CoreWebView2(): {error}")));
        }
        return;
      }
    };
    let tx_for_callback = tx_for_dispatch.clone();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
      move |result, response_json| {
        if let Some(tx) = tx_for_callback.lock().unwrap().take() {
          let response = result
            .map(|_| response_json)
            .map_err(|error| format!("CDP call failed: {error}"));
          let _ = tx.send(response);
        }
        Ok(())
      },
    ));
    if let Err(error) =
      unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) }
    {
      if let Some(tx) = tx_for_dispatch.lock().unwrap().take() {
        let _ = tx.send(Err(format!("CDP dispatch failed: {error}")));
      }
    }
  })
  .map_err(|error| AppError::Msg(format!("failed to access preview webview: {error}")))?;

  let response = tokio::time::timeout(timeout, rx)
    .await
    .map_err(|_| AppError::Msg(format!("CDP method {method_name} timed out")))?
    .map_err(|_| AppError::Msg(format!("CDP method {method_name} was cancelled")))?
    .map_err(AppError::Msg)?;
  serde_json::from_str(&response)
    .map_err(|error| AppError::Msg(format!("CDP returned invalid JSON: {error}")))
}

#[cfg(not(windows))]
pub(crate) async fn call_cdp(
  _app: &AppHandle,
  _method: &str,
  _params: &serde_json::Value,
  _timeout: Duration,
) -> AppResult<serde_json::Value> {
  Err(AppError::Msg(
    "Raw Chrome DevTools Protocol access is currently available on Windows only.".into(),
  ))
}

pub(crate) async fn evaluate_page(
  app: &AppHandle,
  expression: &str,
  await_promise: bool,
  return_by_value: bool,
  timeout: Duration,
) -> AppResult<serde_json::Value> {
  #[cfg(windows)]
  {
    let params = serde_json::json!({
      "expression": expression,
      "awaitPromise": await_promise,
      "returnByValue": return_by_value,
      "includeCommandLineAPI": true,
      "userGesture": true,
      "replMode": true,
      "timeout": timeout.as_millis().min(u64::MAX as u128) as u64,
    });
    return call_cdp(app, "Runtime.evaluate", &params, timeout + Duration::from_secs(2)).await;
  }

  #[cfg(not(windows))]
  {
    let _ = (await_promise, return_by_value);
    let value = eval_json::<serde_json::Value>(app, expression, timeout).await?;
    Ok(serde_json::json!({
      "result": {
        "type": value.as_ref().map(|value| match value {
          serde_json::Value::Null => "object",
          serde_json::Value::Bool(_) => "boolean",
          serde_json::Value::Number(_) => "number",
          serde_json::Value::String(_) => "string",
          serde_json::Value::Array(_) | serde_json::Value::Object(_) => "object",
        }).unwrap_or("undefined"),
        "value": value,
      },
      "transport": "webview-eval"
    }))
  }
}

async fn design_eval<T: serde::de::DeserializeOwned>(app: &AppHandle, js: &str) -> AppResult<Option<T>> {
  eval_json(app, js, Duration::from_secs(4)).await
}

/// Turn the in-preview "design mode" on/off. Enables (or disables) the design
/// controller — which is already injected at document-start into every frame — and
/// records the session so it is re-armed on subsequent page loads. `embedded` +
/// `app_url` select the mode: when the app is shown embedded in the Fabric portal
/// (`embedded == true`), the top (Fabric shell) frame runs as a relay for the app
/// iframe at `app_url`'s origin; otherwise the top frame is the app and runs the
/// controller directly.
#[tauri::command]
pub fn preview_design_set(
  app: AppHandle,
  state: State<'_, PreviewState>,
  enabled: bool,
  embedded: Option<bool>,
  app_url: Option<String>,
) -> AppResult<()> {
  // Relay mode only when enabling an embedded (Fabric) view for which we can
  // resolve the app's origin; anything else is the direct (top-frame) view.
  let relay_origin = if enabled && embedded.unwrap_or(false) {
    app_url.as_deref().and_then(url_origin)
  } else {
    None
  };
  {
    let mut inner = state.inner.lock().unwrap();
    inner.design_active = enabled;
    inner.design_relay = relay_origin.clone();
  }
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let js = if enabled {
      design_enable_js(relay_origin.as_deref())
    } else {
      "try{window.__rayfinDesign&&window.__rayfinDesign.disable()}catch(e){}".to_string()
    };
    wv.eval(js).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Read the design controller's current status (changes count + whether a
/// "Send to chat" handoff is ready). Polled by the renderer while design mode is
/// on. Returns `None` if design mode isn't installed/active.
#[tauri::command]
pub async fn preview_design_poll(app: AppHandle) -> AppResult<Option<DesignStatus>> {
  design_eval(&app, DESIGN_POLL_JS).await
}

/// Drain a pending "Send to chat" handoff (the composed instruction), clearing
/// the in-preview change-set. The renderer captures the highlighted screenshot
/// *before* calling this. Returns `None` when nothing is pending.
#[tauri::command]
pub async fn preview_design_drain(app: AppHandle) -> AppResult<Option<DesignHandoff>> {
  design_eval(&app, DESIGN_DRAIN_JS).await
}

/// Drain a pending "Generate with AI" request from a placeholder (clearing it).
/// The renderer then generates HTML and applies it via [`preview_design_apply_generated`].
#[tauri::command]
pub async fn preview_design_drain_ai(app: AppHandle) -> AppResult<Option<DesignAiRequest>> {
  design_eval(&app, DESIGN_DRAIN_AI_JS).await
}

/// Drain a pending "Edit with AI" restyle request for a selected element (clearing
/// it). The renderer forwards `context` to `design_restyle_element` and applies the
/// resulting patch via [`preview_design_apply_restyle`].
#[tauri::command]
pub async fn preview_design_drain_ai_edit(app: AppHandle) -> AppResult<Option<DesignAiEditRequest>> {
  design_eval(&app, DESIGN_DRAIN_AI_EDIT_JS).await
}

/// Inject AI-generated HTML into the placeholder `id` (the controller sanitizes
/// it before rendering and records it on the placeholder's `insert` change). Both
/// arguments are JSON-encoded so arbitrary markup rides safely into the eval.
#[tauri::command]
pub fn preview_design_apply_generated(app: AppHandle, id: String, html: String) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let js = format!(
      "try{{window.__rayfinDesign&&window.__rayfinDesign.applyGenerated({},{})}}catch(e){{}}",
      serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".into()),
      serde_json::to_string(&html).unwrap_or_else(|_| "\"\"".into()),
    );
    wv.eval(js).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Apply an AI restyle `patch` to the element tagged `id` (`data-rayfin-edit-id`).
/// `patch` is the JSON `RestylePatch` from `design_restyle_element`; the controller
/// applies each whitelisted style prop (and any Graphein spec patch) as revertable
/// change-set entries. Both arguments are JSON-encoded into the eval.
#[tauri::command]
pub fn preview_design_apply_restyle(
  app: AppHandle,
  id: String,
  patch: serde_json::Value,
) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let js = format!(
      "try{{window.__rayfinDesign&&window.__rayfinDesign.applyRestyle({},{})}}catch(e){{}}",
      serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".into()),
      serde_json::to_string(&patch).unwrap_or_else(|_| "null".into()),
    );
    wv.eval(js).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignModel {
  pub id: String,
  pub name: String,
  pub fast: bool,
}

/// Supply the design controller's placeholder AI model picker with the available
/// models (the renderer resolves + fast-flags them) plus the user's `preferred`
/// (persisted) model id to preselect. Pushed on session start and re-pushed if a
/// preview reload re-injects the controller empty.
#[tauri::command]
pub fn preview_design_set_models(
  app: AppHandle,
  models: Vec<DesignModel>,
  preferred: Option<String>,
) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let json = serde_json::to_string(&models).unwrap_or_else(|_| "[]".into());
    let pref = serde_json::to_string(&preferred).unwrap_or_else(|_| "null".into());
    let js = format!(
      "try{{window.__rayfinDesign&&window.__rayfinDesign.setModels({json},{pref})}}catch(e){{}}"
    );
    wv.eval(js).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Push Fabricator's own theme into the design controller so the tools match the
/// host app's look + zoom (the tools are Fabricator UI, not the previewed app's).
/// `theme` is an opaque JSON object the renderer builds from its CSS tokens
/// (`--accent` / `--bg-elev` / `--text` / `--border` …) plus the UI scale.
#[tauri::command]
pub fn preview_design_set_theme(app: AppHandle, theme: serde_json::Value) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let json = serde_json::to_string(&theme).unwrap_or_else(|_| "null".into());
    let js =
      format!("try{{window.__rayfinDesign&&window.__rayfinDesign.setTheme({json})}}catch(e){{}}");
    wv.eval(js).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

#[cfg_attr(windows, allow(dead_code))]
fn request_preview_show(app: &AppHandle, url: &str) {
  let _ = app.emit(PREVIEW_AGENT, serde_json::json!({ "action": "show", "url": url }));
}

#[cfg(windows)]
async fn ensure_offscreen(app: &AppHandle, project_id: &str, url: &str) {
  {
    let state = app.state::<PreviewState>();
    state.inner.lock().unwrap().project_id = Some(project_id.to_string());
  }
  if is_preview_open(app) {
    return;
  }
  let parsed: Url = match url.parse() {
    Ok(url) => url,
    Err(_) => return,
  };
  let state = app.state::<PreviewState>();
  let need_build = {
    let mut inner = state.inner.lock().unwrap();
    if inner.created {
      false
    } else {
      inner.created = true;
      true
    }
  };
  if !need_build {
    return;
  }
  if build(app, parsed, offscreen_bounds()).is_err() {
    state.inner.lock().unwrap().created = false;
    return;
  }
  state.inner.lock().unwrap().reset_to(url);
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let _ = wv.hide();
  }
  tokio::time::sleep(OFFSCREEN_BUILD_SETTLE).await;
}

/// Ensure a preview webview exists for an agent debugging turn. Windows creates
/// and paints it silently off-screen; other platforms ask the renderer to surface
/// the existing preview pane.
pub(crate) async fn agent_ensure_preview(
  app: &AppHandle,
  project_id: &str,
  url: &str,
  show_timeout: Duration,
) {
  {
    let state = app.state::<PreviewState>();
    state.inner.lock().unwrap().project_id = Some(project_id.to_string());
  }

  #[cfg(windows)]
  {
    let _ = show_timeout;
    ensure_offscreen(app, project_id, url).await;
  }
  #[cfg(not(windows))]
  {
    request_preview_show(app, url);
    if is_preview_open(app) {
      tokio::time::sleep(Duration::from_millis(300)).await;
      return;
    }
    let start = Instant::now();
    while start.elapsed() < show_timeout {
      tokio::time::sleep(Duration::from_millis(150)).await;
      if is_preview_open(app) {
        tokio::time::sleep(Duration::from_millis(400)).await;
        return;
      }
    }
  }
}

/// Navigate the existing preview to a live app URL and wait best-effort for the
/// top-level document to finish loading.
pub(crate) async fn navigate_and_wait(
  app: &AppHandle,
  project_id: &str,
  url: &str,
  timeout: Duration,
) -> AppResult<()> {
  let parsed: Url = url
    .parse()
    .map_err(|e| AppError::Msg(format!("invalid preview url {url:?}: {e}")))?;
  let wv = app
    .get_webview(PREVIEW_LABEL)
    .ok_or_else(|| AppError::Msg("preview is not open".into()))?;

  let rx = {
    let state = app.state::<PreviewState>();
    let mut inner = state.inner.lock().unwrap();
    inner.project_id = Some(project_id.to_string());
    let (tx, rx) = oneshot::channel::<()>();
    inner.load_waiters.push(tx);
    inner.reset_to(url);
    rx
  };

  wv.navigate(parsed).map_err(|e| AppError::Msg(e.to_string()))?;
  let _ = tokio::time::timeout(timeout, rx).await;
  Ok(())
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

/// Capture for an agent without disturbing the user. A hidden WebView2 surface is
/// temporarily shown at an off-screen location so `CapturePreview` can paint.
pub(crate) async fn agent_capture(app: &AppHandle) -> AppResult<Vec<u8>> {
  if !is_preview_open(app) {
    return Err(AppError::Msg("preview is not open".into()));
  }
  if is_preview_visible(app) {
    return capture_now(app).await;
  }

  #[cfg(windows)]
  {
    let wv = app
      .get_webview(PREVIEW_LABEL)
      .ok_or_else(|| AppError::Msg("preview is not open".into()))?;
    wv
      .set_bounds(offscreen_bounds().to_rect())
      .map_err(|e| AppError::Msg(e.to_string()))?;
    wv.show().map_err(|e| AppError::Msg(e.to_string()))?;
    tokio::time::sleep(OFFSCREEN_PAINT_SETTLE).await;
    let result = capture_now(app).await;
    if !is_preview_visible(app) {
      let _ = wv.hide();
    }
    result
  }
  #[cfg(not(windows))]
  {
    Err(AppError::Msg("preview is not visible".into()))
  }
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

pub(crate) fn is_preview_open(app: &AppHandle) -> bool {
  app.get_webview(PREVIEW_LABEL).is_some()
}

pub(crate) fn agent_target_matches(app: &AppHandle, project_id: &str, url: &str) -> bool {
  let state = app.state::<PreviewState>();
  let inner = state.inner.lock().unwrap();
  let current = inner.stack.get(inner.cursor).or(inner.commanded.as_ref());
  inner.project_id.as_deref() == Some(project_id)
    && current.is_some_and(|current| url_is_within_app_base(current, url))
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

#[cfg(test)]
mod tests {
  use super::{url_is_within_app_base, DesignAiEditRequest};

  // Guards the multi-select bug: the controller's drained request carries `ids`
  // (all selected element ids); it must survive deserialization so the renderer
  // applies the one patch to every element (not just the primary).
  #[test]
  fn design_ai_edit_request_roundtrips_ids() {
    let json = r#"{"id":"a","ids":["a","b","c"],"description":"x","context":{}}"#;
    let req: DesignAiEditRequest = serde_json::from_str(json).expect("parse");
    assert_eq!(req.id, "a");
    assert_eq!(req.ids, vec!["a", "b", "c"]);
  }

  #[test]
  fn design_ai_edit_request_ids_default_empty() {
    let req: DesignAiEditRequest =
      serde_json::from_str(r#"{"id":"a","description":"x"}"#).expect("parse");
    assert!(req.ids.is_empty());
  }

  #[test]
  fn direct_preview_url_accepts_routes_but_not_portal_or_sibling_paths() {
    let live = "https://example.net/appbackends/abc";
    assert!(url_is_within_app_base(
      "https://example.net/appbackends/abc/dashboard?mode=live",
      live
    ));
    assert!(!url_is_within_app_base(
      "https://app.fabric.microsoft.com/groups/1/items/2",
      live
    ));
    assert!(!url_is_within_app_base(
      "https://example.net/appbackends/abcd",
      live
    ));
  }
}
