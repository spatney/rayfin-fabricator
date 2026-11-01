//! Embedded preview pane.
//!
//! A single native WebView2 **child webview** (label [`PREVIEW_LABEL`]) overlaid
//! on the main window, rendering the user's Rayfin app: by default the one running
//! on this computer (its local backend's Vite, or the local Fabric host that
//! embeds it), else the published app on Fabric. It replaces the
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
/// behalf (matches `IpcChannels.previewAgent`). Nothing emits it at the moment:
/// the agent only captures a preview that is already visible.
#[cfg_attr(windows, allow(dead_code))]
const PREVIEW_AGENT: &str = "preview:agent";

/// Far-off-screen origin (logical px) where the preview is parked while it is
/// hidden ([`preview_hide`]) or suppressed under an HTML overlay
/// ([`preview_suppress`]): well outside any monitor, so it can't cover anything
/// even while WebView2 keeps it shown.
#[cfg(windows)]
const OFFSCREEN_COORD: f64 = 20_000.0;

/// Viewport (logical px) of the preview while it is parked for a durable hide.
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

/// Largest controller response the host relays. Snapshots carry the queued
/// items (including chart specs before/after), so the cap is generous.
const DESIGN_MAX_WIRE_BYTES: usize = 4 * 1024 * 1024;

/// JS that reads the design controller's lightweight status (`peek()`), or
/// `null`. WebView2 serializes the completion value to JSON for the callback.
const DESIGN_POLL_JS: &str =
  "(function(){try{return window.__rayfinDesign?window.__rayfinDesign.peek():null}catch(e){return null}})()";

/// JS that reads the queued design items (`snapshot()`), or `null`.
const DESIGN_SNAPSHOT_JS: &str =
  "(function(){try{return window.__rayfinDesign?window.__rayfinDesign.snapshot():null}catch(e){return null}})()";

/// JS that switches the design controller off.
const DESIGN_DISABLE_JS: &str =
  "try{window.__rayfinDesign&&window.__rayfinDesign.disable()}catch(e){}";

/// Renderer visual-viewport CSS bounds plus its physical-pixel ratio. Legacy
/// callers without a ratio use native logical coordinates.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct PreviewBounds {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  #[serde(default, rename = "pixelRatio")]
  pub pixel_ratio: Option<f64>,
}

impl PreviewBounds {
  fn to_rect(self) -> AppResult<tauri::Rect> {
    let ratio = self.pixel_ratio.unwrap_or(1.0);
    if !ratio.is_finite() || ratio <= 0.0
      || !self.width.is_finite() || !self.height.is_finite()
      || self.width < 0.0 || self.height < 0.0
      || [self.x, self.y, self.width.max(1.0), self.height.max(1.0)].iter().any(|n| {
        !n.is_finite() || !(i32::MIN as f64..=i32::MAX as f64).contains(&(n * ratio).round())
      })
    {
      return Err(AppError::Msg("Invalid native preview bounds or pixel ratio.".into()));
    }
    let position = LogicalPosition::new(self.x, self.y);
    let size = LogicalSize::new(self.width.max(1.0), self.height.max(1.0));
    Ok(match self.pixel_ratio {
      Some(ratio) => {
        let physical_size = size.to_physical::<u32>(ratio);
        tauri::Rect {
          position: position.to_physical::<i32>(ratio).into(),
          size: tauri::PhysicalSize::new(physical_size.width.max(1), physical_size.height.max(1)).into(),
        }
      }
      None => tauri::Rect { position: position.into(), size: size.into() },
    })
  }

  #[cfg(windows)]
  fn parked(self) -> Self {
    Self { x: OFFSCREEN_COORD, y: OFFSCREEN_COORD, ..self }
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
  /// The latest stills captured for overlays ([`preview_still`]), newest last,
  /// kept apart from `inner` so serving one never waits on navigation bookkeeping.
  stills: Mutex<VecDeque<Still>>,
}

/// How many recent stills are kept, so one the renderer is about to show isn't
/// gone because another was taken meanwhile (the warm-up, a second press).
const STILLS_KEPT: usize = 3;

/// A still of the preview, served to the main webview at
/// `http://preview-still.localhost/<key>` until newer stills push it out.
struct Still {
  key: String,
  bytes: Vec<u8>,
}

impl PreviewState {
  /// Keep `bytes` as the newest still, letting the oldest go, and return its key.
  #[cfg_attr(not(windows), allow(dead_code))]
  fn keep_still(&self, bytes: Vec<u8>) -> String {
    let key = next_still_key();
    let mut stills = self.stills.lock().unwrap();
    if stills.len() == STILLS_KEPT {
      stills.pop_front();
    }
    stills.push_back(Still { key: key.clone(), bytes });
    key
  }

  /// The still kept under `key`, while it's kept.
  fn still_bytes(&self, key: &str) -> Option<Vec<u8>> {
    let stills = self.stills.lock().unwrap();
    stills.iter().find(|s| s.key == key).map(|s| s.bytes.clone())
  }
}

/// A key no earlier still had, in this run or another, so a still can't be mixed
/// up with one the webview remembers from before.
fn next_still_key() -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static COUNT: AtomicU64 = AtomicU64::new(0);
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or_default();
  format!("{now:x}-{}", COUNT.fetch_add(1, Ordering::Relaxed))
}

#[derive(Default)]
struct Inner {
  /// Whether the child webview has been created yet (created lazily on first show).
  created: bool,
  /// The last URL the renderer explicitly told us to load (the current "root").
  /// Re-shows compare against this — not the webview's drifted live URL — so a
  /// pure re-show (e.g. after an overlay closes) never triggers a reload.
  commanded: Option<String>,
  nav_state: Option<PreviewNavState>,
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
  /// hidden surface, so a capture there could only run out its timeout;
  /// [`capture_visible`] refuses to capture unless this is `true`.
  visible: bool,
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
  let rect = bounds.to_rect()?;
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
    // Capture the deployed app's console output/errors so the agent can read
    // them back later via `fabricator_console`. Must be set before the webview
    // is created so it runs at document start on every page.
    .initialization_script(CONSOLE_INIT_JS)
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
  // so it MUST use the same environment options. Both take wry's default browser
  // arguments, and the device-SSO option comes from the vendored wry
  // (docs/VENDORED-WRY-PATCH.md), so they match. Do NOT set per-webview
  // `additional_browser_args` here: a mismatch makes WebView2 fail creation with
  // ERROR_INVALID_STATE (0x8007139F).
  window
    .add_child(builder, rect.position, rect.size)
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
  let (can_back, can_fwd, design_active, design_relay) = {
    let mut inner = state.inner.lock().unwrap();
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
      let _ = wv.eval(design_enable_js(design_relay.as_deref(), None));
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
  let nav = PreviewNavState {
    url: url.to_string(),
    loading,
    can_go_back: can_back,
    can_go_forward: can_fwd,
  };
  app.state::<PreviewState>().inner.lock().unwrap().nav_state = Some(nav.clone());
  let _ = app.emit(PREVIEW_NAV, nav);
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
      wv.set_bounds(bounds.to_rect()?).map_err(|e| AppError::Msg(e.to_string()))?;
      wv.show().map_err(|e| AppError::Msg(e.to_string()))?;
      state.inner.lock().unwrap().visible = true;
    }
    return Ok(());
  }

  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.set_bounds(bounds.to_rect()?).map_err(|e| AppError::Msg(e.to_string()))?;
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
    wv.show().map_err(|e| AppError::Msg(e.to_string()))?;
    state.inner.lock().unwrap().visible = true;
    if !needs_nav {
      // A remounted pane has not seen this retained document's navigation events.
      let nav = state.inner.lock().unwrap().nav_state.clone();
      if let Some(nav) = nav {
        app.emit(PREVIEW_NAV, nav).map_err(|e| AppError::Msg(e.to_string()))?;
      }
    }
  }
  Ok(())
}

/// Load `url` into the preview without putting it on screen, so the page has
/// painted by the time the renderer reveals it with [`preview_show_url`] (then a
/// pure move). The renderer uses this for a first load that starts while
/// something covers the preview, such as the launch screen. Creates the child
/// webview when there is none yet, and otherwise navigates it when `url` changed.
///
/// On Windows the surface is parked off-screen at `bounds`' size and stays shown,
/// so it keeps rendering (as in [`preview_suppress`]). Elsewhere there is no
/// off-screen park, so it is hidden instead.
#[tauri::command]
pub async fn preview_preload(
  app: AppHandle,
  state: State<'_, PreviewState>,
  url: String,
  bounds: PreviewBounds,
) -> AppResult<()> {
  let parsed: Url = url
    .parse()
    .map_err(|e| AppError::Msg(format!("invalid preview url {url:?}: {e}")))?;
  #[cfg(windows)]
  let parked = bounds.parked();
  #[cfg(not(windows))]
  let parked = bounds;

  // Claim creation atomically, as in `preview_show_url`.
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
    if let Err(e) = build(&app, parsed, parked) {
      state.inner.lock().unwrap().created = false;
      return Err(e);
    }
    state.inner.lock().unwrap().reset_to(&url);
  } else if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let needs_nav = {
      let inner = state.inner.lock().unwrap();
      inner.commanded.as_deref() != Some(url.as_str())
    };
    if needs_nav {
      wv.navigate(parsed).map_err(|e| AppError::Msg(e.to_string()))?;
      state.inner.lock().unwrap().reset_to(&url);
    }
  }

  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.set_bounds(parked.to_rect()?).map_err(|e| AppError::Msg(e.to_string()))?;
    #[cfg(windows)]
    {
      wv.show().map_err(|e| AppError::Msg(e.to_string()))?;
      state.inner.lock().unwrap().visible = true;
    }
    #[cfg(not(windows))]
    {
      wv.hide().map_err(|e| AppError::Msg(e.to_string()))?;
      state.inner.lock().unwrap().visible = false;
    }
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
    wv.set_bounds(bounds.to_rect()?).map_err(|e| AppError::Msg(e.to_string()))?;
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
    wv.set_bounds(bounds.to_rect()?)
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
    if let Err(error) = wv.set_bounds(offscreen_bounds().to_rect()?) {
      log::warn!("Could not park the native preview before hiding: {error}");
    }
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
/// — while keeping it shown, so it keeps compositing live content (see
/// [`OFFSCREEN_COORD`]). Keeping the size
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
      let parked = bounds.parked().to_rect().and_then(|rect| {
        wv.set_bounds(rect).map_err(|e| AppError::Msg(e.to_string()))
      });
      match parked {
        Ok(()) => {
          wv.show().map_err(|e| AppError::Msg(e.to_string()))?;
          app.state::<PreviewState>().inner.lock().unwrap().visible = true;
        }
        Err(error) => {
          log::warn!("Could not park the native preview; falling back to hiding: {error}");
          wv.hide().map_err(|e| AppError::Msg(e.to_string()))?;
          app.state::<PreviewState>().inner.lock().unwrap().visible = false;
        }
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

/// Clear the `localStorage` and `sessionStorage` of the page the preview shows,
/// then reload it. Preview as calls this once it has changed who the app signs in
/// as on its local backend, so the app forgets its old session and signs in
/// again. Only for a page served from this computer ([`loopback_origin`]): it
/// resolves `false`, changing nothing, while the preview shows another site or
/// nothing at all, and fails when the page doesn't answer in time.
#[tauri::command]
pub async fn preview_reset_site_data(app: AppHandle) -> AppResult<bool> {
  let Some(wv) = app.get_webview(PREVIEW_LABEL) else {
    return Ok(false);
  };
  let url = wv.url().map_err(|e| AppError::Msg(e.to_string()))?;
  let Some(origin) = loopback_origin(&url) else {
    return Ok(false);
  };
  match design_eval::<bool>(&app, &reset_site_data_js(&origin)).await? {
    Some(true) => {
      wv.reload().map_err(|e| AppError::Msg(e.to_string()))?;
      Ok(true)
    }
    // It went to another page in the meantime, which isn't this one's to clear.
    Some(false) => Ok(false),
    None => Err(AppError::Msg("The preview didn’t answer, so it wasn’t reloaded.".into())),
  }
}

/// The origin (`scheme://host:port`) of a page served from this computer: `http`
/// or `https` on `localhost` or a loopback address. `None` for anything else, so
/// [`preview_reset_site_data`] never clears a site on the web.
fn loopback_origin(url: &Url) -> Option<String> {
  if !matches!(url.scheme(), "http" | "https") {
    return None;
  }
  let host = url.host_str()?;
  let loopback = host.eq_ignore_ascii_case("localhost")
    || host
      .trim_start_matches('[')
      .trim_end_matches(']')
      .parse::<std::net::IpAddr>()
      .is_ok_and(|ip| ip.is_loopback());
  loopback.then(|| url.origin().ascii_serialization())
}

/// JS that clears the page's `localStorage` and `sessionStorage` when it is still
/// on `origin` (it may have navigated since its URL was read), and answers
/// whether it was. Storage the page can't use holds nothing to clear.
fn reset_site_data_js(origin: &str) -> String {
  let origin = serde_json::to_string(origin).unwrap_or_else(|_| "null".into());
  format!(
    "(function(){{try{{if(location.origin!=={origin})return false;\
     try{{localStorage.clear()}}catch(e){{}}\
     try{{sessionStorage.clear()}}catch(e){{}}\
     return true}}catch(e){{return false}}}})()"
  )
}

/// Reload the preview when it shows a page from `origin` (e.g. a local preview
/// that was just started again), leaving any other page alone.
pub fn reload_if_showing(app: &AppHandle, origin: &str) {
  let Some(wv) = app.get_webview(PREVIEW_LABEL) else { return };
  let prefix = format!("{}/", origin.trim_end_matches('/'));
  if wv.url().is_ok_and(|url| url.as_str().starts_with(&prefix)) {
    let _ = wv.reload();
  }
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

/// Build the JS that enables the (already document-start-injected) design
/// controller in the top frame. In the direct view the top frame *is* the app and
/// runs the controller locally (`enable('direct', null, options)`); in the
/// Fabric-embedded view the top frame becomes a relay for the app iframe at
/// `relay_origin` (`enable('relay', "<origin>", options)`), which bridges host
/// calls over `postMessage`. `options` seeds the session (id, queued items, host
/// theme). Without it — the re-arm after a page load — the controller comes back
/// unseeded, reports `sessionId: null`, and the renderer re-seeds it from its own
/// copy of the queue.
fn design_enable_js(relay_origin: Option<&str>, options: Option<&serde_json::Value>) -> String {
  let mode = if relay_origin.is_some() { "relay" } else { "direct" };
  let origin = serde_json::to_string(&relay_origin).unwrap_or_else(|_| "null".into());
  let opts = options
    .and_then(|o| serde_json::to_string(o).ok())
    .unwrap_or_else(|| "null".into());
  format!("try{{window.__rayfinDesign&&window.__rayfinDesign.enable('{mode}',{origin},{opts})}}catch(e){{}}")
}

/// Build the JS that hands one JSON command to the design controller. Results of
/// data-returning commands come back through `peek().results`, so this never
/// needs a return value (and works the same through the Fabric relay).
fn design_command_js(command: &serde_json::Value) -> String {
  let json = serde_json::to_string(command).unwrap_or_else(|_| "null".into());
  format!("try{{window.__rayfinDesign&&window.__rayfinDesign.command({json})}}catch(e){{}}")
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
/// parsed into `T` (or `None` when the webview is gone, the value is `null`, or
/// it exceeds [`DESIGN_MAX_WIRE_BYTES`]). WebView2 serializes the result to JSON
/// for the callback; the whole round-trip is time-bounded so a stalled dispatch
/// can never wedge the caller.
async fn design_eval<T: serde::de::DeserializeOwned>(app: &AppHandle, js: &str) -> AppResult<Option<T>> {
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
  let res = match tokio::time::timeout(Duration::from_secs(4), rx).await {
    Ok(Ok(s)) => s,
    _ => return Ok(None),
  };
  if res.len() > DESIGN_MAX_WIRE_BYTES {
    log::warn!("design controller response exceeded {DESIGN_MAX_WIRE_BYTES} bytes; ignored");
    return Ok(None);
  }
  let trimmed = res.trim();
  if trimmed.is_empty() || trimmed == "null" {
    return Ok(None);
  }
  match serde_json::from_str::<T>(trimmed) {
    Ok(v) => Ok(Some(v)),
    Err(_) => Ok(None),
  }
}

/// Turn the in-preview Design mode on/off. Enables (or disables) the design
/// controller — which is already injected at document-start into every frame — and
/// records the session so it is re-armed on subsequent page loads. `embedded` +
/// `app_url` select the mode: when the app is shown embedded in the Fabric portal
/// (`embedded == true`), the top (Fabric shell) frame runs as a relay for the app
/// iframe at `app_url`'s origin; otherwise the top frame is the app and runs the
/// controller directly. `options` (see `DesignEnableOptions` in
/// `src/shared/design.ts`) seeds the session.
#[tauri::command]
pub fn preview_design_set(
  app: AppHandle,
  state: State<'_, PreviewState>,
  enabled: bool,
  embedded: Option<bool>,
  app_url: Option<String>,
  options: Option<serde_json::Value>,
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
      design_enable_js(relay_origin.as_deref(), options.as_ref())
    } else {
      DESIGN_DISABLE_JS.to_string()
    };
    wv.eval(js).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Read the design controller's lightweight status (`DesignStatus`). Polled by
/// the renderer while Design is on. Returns `None` when the controller isn't
/// installed/active or didn't answer in time.
#[tauri::command]
pub async fn preview_design_poll(app: AppHandle) -> AppResult<Option<serde_json::Value>> {
  design_eval(&app, DESIGN_POLL_JS).await
}

/// Read the queued design items (`DesignSnapshot`). Fetched by the renderer when
/// the polled `version` changes.
#[tauri::command]
pub async fn preview_design_snapshot(app: AppHandle) -> AppResult<Option<serde_json::Value>> {
  design_eval(&app, DESIGN_SNAPSHOT_JS).await
}

/// Hand one `DesignCommand` to the controller (seed, remove/focus an item, show
/// variations or suggestions, prepare a capture, …).
#[tauri::command]
pub fn preview_design_command(app: AppHandle, command: serde_json::Value) -> AppResult<()> {
  if !command.get("op").is_some_and(|op| op.is_string()) {
    return Err(AppError::Msg("A design command needs an `op`.".into()));
  }
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.eval(design_command_js(&command)).map_err(|e| AppError::Msg(e.to_string()))?;
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

/// URI scheme the main webview loads overlay stills from ([`preview_still`]):
/// `http://preview-still.localhost/<key>` on Windows. The renderer's CSP allows it
/// as an image source (src/renderer/index.html).
pub const STILL_SCHEME: &str = "preview-still";

/// How long the still for an overlay may take. The overlay waits on it, behind the
/// live surface, so this is short: a healthy capture takes tens of milliseconds,
/// and past this the renderer moves the preview away without a still.
#[cfg(windows)]
const STILL_TIMEOUT: Duration = Duration::from_millis(1500);

/// How long a capture for an attachment may take.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// What a capture is encoded as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum CaptureFormat {
  /// Lossless, for what's attached to a chat turn or read by a model.
  Png,
  /// For the still shown in the preview's place while an overlay covers it: a few
  /// times faster to encode than PNG on pages with texture or photos, and smaller.
  Jpeg,
}

/// Where a capture's image bytes, or why it failed, are sent.
type CaptureDone = oneshot::Sender<Result<Vec<u8>, String>>;

/// Capture the current preview content as a PNG and return it as a `data:` URL.
///
/// Uses WebView2's `ICoreWebView2::CapturePreview`, which captures the actual
/// rendered web content (not screen pixels), so it works regardless of the
/// webview's z-order or whether something overlaps it. The capture must start on
/// the UI thread, so it is dispatched via [`tauri::webview::Webview::with_webview`];
/// the resulting bytes are handed back to this async command over a oneshot
/// channel. Design attaches the image to a chat turn.
#[tauri::command]
pub async fn preview_capture(app: AppHandle) -> AppResult<String> {
  let bytes = capture_preview_bytes(&app).await?;
  let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
  Ok(format!("data:image/png;base64,{b64}"))
}

/// Capture the preview's current frame for the still the renderer paints in its
/// place while an HTML overlay covers it, and return a URL to load it from.
///
/// The overlay can't show over the live surface until the still is up, so this is
/// built for speed. On Windows it's a JPEG, a few times faster to encode than a
/// PNG on pages with texture or photos, kept here and served from
/// [`STILL_SCHEME`] ([`serve_still`]), so the image never travels through IPC as
/// base64. Elsewhere it's the PNG `data:` URL [`preview_capture`] returns.
#[tauri::command]
pub async fn preview_still(app: AppHandle, state: State<'_, PreviewState>) -> AppResult<String> {
  #[cfg(windows)]
  {
    let bytes = capture_visible(&app, CaptureFormat::Jpeg, STILL_TIMEOUT).await?;
    let key = state.keep_still(bytes);
    Ok(format!("http://{STILL_SCHEME}.localhost/{key}"))
  }
  #[cfg(not(windows))]
  {
    let _ = state;
    preview_capture(app).await
  }
}

/// Serve a still [`preview_still`] kept, to the main webview only. A key no longer
/// kept, or another webview (the previewed app itself), gets a 404.
pub fn serve_still<R: tauri::Runtime>(
  ctx: tauri::UriSchemeContext<'_, R>,
  request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
  use tauri::http::{header, Response, StatusCode};

  let key = request.uri().path().trim_start_matches('/');
  let bytes = (ctx.webview_label() == "main")
    .then(|| ctx.app_handle().state::<PreviewState>().still_bytes(key))
    .flatten();
  // Never cached: the webview keeps what it has loaded for as long as the page
  // shows it anyway.
  let response = Response::builder().header(header::CACHE_CONTROL, "no-store");
  match bytes {
    Some(bytes) => response.header(header::CONTENT_TYPE, "image/jpeg").body(bytes),
    None => response.status(StatusCode::NOT_FOUND).body(Vec::new()),
  }
  .unwrap_or_default()
}

/// Capture the current preview content, **without** any visibility check: on a
/// hidden surface WebView2's `CapturePreview` never completes, so the caller MUST
/// make sure the surface is rendering (shown, possibly parked off-screen) or the
/// capture only runs out `timeout`. The capture starts on the UI thread via
/// [`tauri::webview::Webview::with_webview`]; the bytes come back over a oneshot.
async fn capture_now(app: &AppHandle, format: CaptureFormat, timeout: Duration) -> AppResult<Vec<u8>> {
  let wv = app
    .get_webview(PREVIEW_LABEL)
    .ok_or_else(|| AppError::Msg("preview is not open".into()))?;

  let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
  wv.with_webview(move |platform| {
    // On the UI thread now: label it so a hang here names CapturePreview.
    let _guard = watchdog::activity(Activity::PreviewCapture);
    start_capture(&platform, format, tx);
  })
  .map_err(|e| AppError::Msg(format!("failed to access preview webview: {e}")))?;

  let out = match tokio::time::timeout(timeout, rx).await {
    Ok(Ok(res)) => res.map_err(AppError::Msg),
    Ok(Err(_)) => Err(AppError::Msg("preview capture was cancelled".into())),
    Err(_) => Err(AppError::Msg("preview capture timed out".into())),
  };
  // A capture that times out means CapturePreview never signalled (a slow or
  // absent GPU signal, as on some VMs) — worth a breadcrumb.
  if let Err(ref e) = out {
    let msg = e.to_string();
    if msg.contains("timed out") {
      crashlog::log_error(
        "preview",
        &format!("{msg} — CapturePreview didn't finish within {timeout:?} (slow/absent GPU signal)"),
      );
    }
  }
  out
}

/// Capture the current preview content as raw PNG bytes for the renderer's
/// capture flow ([`preview_capture`]). Refuses (soft failure) unless the surface
/// is currently shown to the user.
pub(crate) async fn capture_preview_bytes(app: &AppHandle) -> AppResult<Vec<u8>> {
  capture_visible(app, CaptureFormat::Png, CAPTURE_TIMEOUT).await
}

/// Capture the current preview content as `format`, refusing (soft failure) unless
/// the surface is shown: on a hidden one the capture never completes, so it would
/// only run out `timeout`.
async fn capture_visible(app: &AppHandle, format: CaptureFormat, timeout: Duration) -> AppResult<Vec<u8>> {
  if app.get_webview(PREVIEW_LABEL).is_none() {
    return Err(AppError::Msg("preview is not open".into()));
  }
  if !is_preview_visible(app) {
    return Err(AppError::Msg("preview is not visible".into()));
  }
  capture_now(app, format, timeout).await
}

/// Bounds used to park the preview far off-screen before a durable hide
/// ([`preview_hide`]), so it can't cover anything even if the OS ignores `hide()`.
#[cfg(windows)]
fn offscreen_bounds() -> PreviewBounds {
  PreviewBounds {
    x: OFFSCREEN_COORD,
    y: OFFSCREEN_COORD,
    width: OFFSCREEN_SIZE.0,
    height: OFFSCREEN_SIZE.1,
    pixel_ratio: None,
  }
}

/// Whether the preview child webview is currently shown (not hidden behind
/// another tab/overlay). Callers that need to reveal it can skip the (route-
/// resetting) re-show when this is already `true`.
pub(crate) fn is_preview_visible(app: &AppHandle) -> bool {
  app.state::<PreviewState>().inner.lock().unwrap().visible
}

/// Start capturing the WebView2 preview as `format`. Runs on the UI thread inside
/// [`capture_now`]'s `with_webview` closure and returns at once: `CapturePreview`
/// completes later, through the UI thread's own message loop, and its handler
/// sends the image to `done`. Nothing waits on the UI thread meanwhile, so the app
/// stays responsive however long the capture takes, and a completion that never
/// comes (a flaky VM GPU) can't freeze it; [`capture_now`] stops waiting at its
/// timeout.
#[cfg(windows)]
fn start_capture(platform: &tauri::webview::PlatformWebview, format: CaptureFormat, done: CaptureDone) {
  use std::cell::Cell;
  use std::rc::Rc;

  use webview2_com::CapturePreviewCompletedHandler;
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
  };

  fn report(done: &Cell<Option<CaptureDone>>, out: Result<Vec<u8>, String>) {
    if let Some(tx) = done.take() {
      let _ = tx.send(out);
    }
  }

  // Shared with the completion handler; whichever reports first, reports.
  let done = Rc::new(Cell::new(Some(done)));
  let started = (|| -> Result<(), String> {
    let core = unsafe { platform.controller().CoreWebView2() }
      .map_err(|e| format!("CoreWebView2(): {e}"))?;
    let stream = win_capture::memory_stream()?;
    let image_format = match format {
      CaptureFormat::Png => COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
      CaptureFormat::Jpeg => COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
    };
    let finished = done.clone();
    let written = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
      // The image now lives in the stream's backing HGLOBAL — copy it into a Vec.
      let out = result
        .map_err(|e| format!("CapturePreview: {e}"))
        .and_then(|()| win_capture::stream_bytes(&written));
      report(&finished, out);
      Ok(())
    }));
    unsafe { core.CapturePreview(image_format, &stream, &handler) }
      .map_err(|e| format!("CapturePreview: {e}"))
  })();
  if let Err(e) = started {
    report(&done, Err(e));
  }
}

/// The Win32 plumbing around `CapturePreview`, kept apart from the WebView2 call so
/// it can be tested without a live webview.
#[cfg(windows)]
mod win_capture {
  use windows::Win32::Foundation::HGLOBAL;
  use windows::Win32::System::Com::IStream;
  use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
  use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

  /// An auto-growing in-memory stream; its HGLOBAL is freed when the last
  /// reference drops, after the bytes have been copied out.
  pub(super) fn memory_stream() -> Result<IStream, String> {
    unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
      .map_err(|e| format!("CreateStreamOnHGlobal: {e}"))
  }

  /// Copy out the bytes held in `stream`'s backing HGLOBAL. The block can be a few
  /// bytes larger than what was written, which PNG and JPEG decoders ignore.
  pub(super) fn stream_bytes(stream: &IStream) -> Result<Vec<u8>, String> {
    unsafe {
      let hglobal = GetHGlobalFromStream(stream).map_err(|e| format!("GetHGlobalFromStream: {e}"))?;
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

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn copies_what_was_written_to_the_memory_stream() {
      let stream = memory_stream().unwrap();
      let png = b"\x89PNG\r\n\x1a\nfabricator";
      let mut written = 0u32;
      unsafe { stream.Write(png.as_ptr().cast(), png.len() as u32, Some(&mut written)) }
        .ok()
        .unwrap();
      assert_eq!(written as usize, png.len());
      assert!(stream_bytes(&stream).unwrap().starts_with(png));
    }
  }
}

/// Non-Windows, non-macOS stub so the crate still builds on other targets.
#[cfg(not(any(windows, target_os = "macos")))]
fn start_capture(_platform: &tauri::webview::PlatformWebview, _format: CaptureFormat, done: CaptureDone) {
  let _ = done.send(Err("preview capture is not supported on this platform".into()));
}

/// Capture the WKWebView preview as PNG (whatever `format` asks for) and send it
/// to `done` before returning. See [`capture_png`].
#[cfg(target_os = "macos")]
fn start_capture(platform: &tauri::webview::PlatformWebview, _format: CaptureFormat, done: CaptureDone) {
  let _ = done.send(capture_png(platform));
}

/// Capture the WKWebView preview to PNG bytes. Runs on the UI thread inside
/// [`capture_now`]'s `with_webview` closure. Uses
/// `-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`, which captures
/// the rendered web content (the macOS analogue of WebView2's `CapturePreview`),
/// then converts the resulting `NSImage` to PNG via `NSBitmapImageRep`. The
/// snapshot API is asynchronous, so we pump the main run loop until its completion
/// block fires (bounded by a timeout).
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
  use super::{design_command_js, design_enable_js, loopback_origin, reset_site_data_js, PreviewBounds, PreviewState};
  use tauri::Url;

  #[test]
  fn stills_are_served_by_key_until_newer_ones_push_them_out() {
    let state = PreviewState::default();
    let keys: Vec<String> = (0..4u8).map(|n| state.keep_still(vec![n])).collect();
    assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), keys.len());
    assert_eq!(state.still_bytes(&keys[0]), None, "the oldest still was let go");
    for (n, key) in keys.iter().enumerate().skip(1) {
      assert_eq!(state.still_bytes(key), Some(vec![n as u8]), "{key}");
    }
    assert_eq!(state.still_bytes(""), None);
  }

  fn bounds(pixel_ratio: Option<f64>) -> PreviewBounds {
    PreviewBounds { x: 100.0, y: 80.0, width: 900.0, height: 600.0, pixel_ratio }
  }

  #[test]
  fn renderer_pixels_are_not_rescaled_by_native_window_dpi() {
    for (ratio, native_dpi, x, y, width, height) in [
      (1.0, 1.0, 100, 80, 900, 600),
      (1.25, 1.0, 125, 100, 1125, 750),
      (1.5, 1.0, 150, 120, 1350, 900),
      (2.0, 1.0, 200, 160, 1800, 1200),
      (1.5625, 1.25, 156, 125, 1406, 938),
      (2.5, 2.0, 250, 200, 2250, 1500),
    ] {
      let rect = bounds(Some(ratio)).to_rect().unwrap();
      assert!(matches!(rect.position, tauri::Position::Physical(_)));
      assert_eq!(rect.position.to_physical::<i32>(native_dpi), tauri::PhysicalPosition::new(x, y));
      assert_eq!(rect.size.to_physical::<u32>(native_dpi), tauri::PhysicalSize::new(width, height));
    }
  }

  #[test]
  fn legacy_bounds_without_pixel_ratio_still_use_native_logical_units() {
    let bounds: PreviewBounds = serde_json::from_str(
      r#"{"x":100,"y":80,"width":900,"height":600}"#,
    ).unwrap();
    let rect = bounds.to_rect().unwrap();
    assert!(matches!(rect.position, tauri::Position::Logical(_)));
    assert_eq!(rect.position.to_physical::<i32>(1.5), tauri::PhysicalPosition::new(150, 120));
    assert_eq!(rect.size.to_physical::<u32>(1.5), tauri::PhysicalSize::new(1350, 900));
  }

  #[test]
  fn renderer_pixel_ratio_round_trips_from_ipc() {
    let bounds: PreviewBounds = serde_json::from_str(
      r#"{"x":100,"y":80,"width":900,"height":600,"pixelRatio":1.25}"#,
    ).unwrap();
    assert_eq!(bounds.pixel_ratio, Some(1.25));
    assert_eq!(bounds.to_rect().unwrap().position.to_physical::<i32>(2.0), tauri::PhysicalPosition::new(125, 100));
  }

  #[test]
  fn invalid_bounds_are_rejected_and_tiny_sizes_remain_nonzero() {
    for invalid in [
      PreviewBounds { x: f64::NAN, ..bounds(Some(1.0)) },
      PreviewBounds { width: f64::NAN, ..bounds(Some(1.0)) },
      PreviewBounds { height: f64::INFINITY, ..bounds(Some(1.0)) },
      PreviewBounds { width: -1.0, ..bounds(Some(1.0)) },
      PreviewBounds { x: f64::MAX, ..bounds(Some(1.0)) },
      bounds(Some(0.0)), bounds(Some(-1.0)), bounds(Some(f64::INFINITY)),
    ] {
      assert!(invalid.to_rect().is_err(), "{invalid:?}");
    }
    let tiny = PreviewBounds { width: 1.0, height: 1.0, ..bounds(Some(0.25)) };
    assert_eq!(tiny.to_rect().unwrap().size.to_physical::<u32>(2.0), tauri::PhysicalSize::new(1, 1));
  }

  #[cfg(windows)]
  #[test]
  fn parking_preserves_the_actual_physical_viewport_size() {
    let current = bounds(Some(1.875));
    let parked = current.parked();
    assert_eq!(parked.pixel_ratio, current.pixel_ratio);
    assert_eq!(
      parked.to_rect().unwrap().size.to_physical::<u32>(1.25),
      current.to_rect().unwrap().size.to_physical::<u32>(1.25),
    );
    assert!(parked.to_rect().unwrap().position.to_physical::<i32>(1.25).x > 20_000);
  }

  #[test]
  fn design_enable_js_selects_direct_or_relay_and_embeds_options() {
    assert_eq!(
      design_enable_js(None, None),
      "try{window.__rayfinDesign&&window.__rayfinDesign.enable('direct',null,null)}catch(e){}"
    );
    let opts = serde_json::json!({ "sessionId": "s1", "items": [] });
    let relay = design_enable_js(Some("https://p1.example.app"), Some(&opts));
    assert!(relay.contains("enable('relay',\"https://p1.example.app\",{"));
    assert!(relay.contains("\"sessionId\":\"s1\""));
  }

  #[test]
  fn design_command_js_embeds_the_command_as_a_json_literal() {
    // Quotes, backslashes and script-ish text stay inside a JSON string literal.
    let cmd = serde_json::json!({ "op": "failRequest", "requestId": "r1", "message": "a \"quoted\" \\ </script>" });
    let js = design_command_js(&cmd);
    assert!(js.starts_with("try{window.__rayfinDesign&&window.__rayfinDesign.command({"));
    let json = js
      .trim_start_matches("try{window.__rayfinDesign&&window.__rayfinDesign.command(")
      .trim_end_matches(")}catch(e){}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(json).unwrap(), cmd);
  }

  #[test]
  fn site_data_is_reset_only_for_pages_served_from_this_computer() {
    for (url, origin) in [
      ("http://localhost:5173/", "http://localhost:5173"),
      ("http://localhost:5173/notes?id=1#top", "http://localhost:5173"),
      ("http://LOCALHOST:5173/", "http://localhost:5173"),
      ("https://localhost:7171/.rayfin-local/portal/embed", "https://localhost:7171"),
      ("http://127.0.0.1:5173/", "http://127.0.0.1:5173"),
      ("http://127.4.5.6/", "http://127.4.5.6"),
      ("http://[::1]:5173/", "http://[::1]:5173"),
    ] {
      assert_eq!(loopback_origin(&Url::parse(url).unwrap()).as_deref(), Some(origin), "{url}");
    }
    for url in [
      "https://app.fabric.microsoft.com/groups/1/appbackends/2",
      "https://notes.example.app/",
      "http://localhost.example.com:5173/",
      "http://192.168.1.4:5173/",
      "http://0.0.0.0:5173/",
      "ws://localhost:5173/",
      "tauri://localhost/",
      "file:///C:/apps/notes/index.html",
      "about:blank",
    ] {
      assert_eq!(loopback_origin(&Url::parse(url).unwrap()), None, "{url}");
    }
  }

  #[test]
  fn the_site_data_reset_runs_only_on_the_origin_it_was_asked_for() {
    let js = reset_site_data_js("http://localhost:5173");
    assert!(js.starts_with("(function(){"), "{js}");
    assert!(js.contains(r#"if(location.origin!=="http://localhost:5173")return false;"#), "{js}");
    assert!(js.contains("try{localStorage.clear()}catch(e){}"), "{js}");
    assert!(js.contains("try{sessionStorage.clear()}catch(e){}"), "{js}");
    assert!(js.ends_with("return true}catch(e){return false}})()"), "{js}");
    // Whatever the origin holds, it stays inside a JSON string literal.
    let odd = reset_site_data_js(r#"http://localhost:1")||alert(1)//"#);
    assert!(odd.contains(r#"location.origin!=="http://localhost:1\")||alert(1)//")return false;"#), "{odd}");
  }
}
