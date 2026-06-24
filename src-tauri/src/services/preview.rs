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

/// Label of the single reusable preview child webview.
const PREVIEW_LABEL: &str = "preview";
/// Renderer event carrying preview navigation state (matches `IpcChannels.previewNav`).
const PREVIEW_NAV: &str = "preview:nav";
/// Renderer event asking the UI to surface the preview at a URL on the agent's
/// behalf (matches `IpcChannels.previewAgent`). Used by the Fabricator
/// validation tools so a host-driven navigation/screenshot can reveal the
/// preview pane even when another tab is focused.
const PREVIEW_AGENT: &str = "preview:agent";

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
    .on_navigation(move |u| {
      on_navigation(&nav_app, u);
      true
    })
    .on_page_load(move |_wv, payload| {
      on_page_load(&load_app, payload.event(), payload.url());
    })
    .on_new_window(move |u, features| on_new_window(&popup_app, &u, features));

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
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.set_bounds(bounds.to_rect())
      .map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Hide the preview (it floats above HTML, so it must hide when covered).
#[tauri::command]
pub fn preview_hide(app: AppHandle) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.hide().map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Reload the current page.
#[tauri::command]
pub fn preview_reload(app: AppHandle) -> AppResult<()> {
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    wv.reload().map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Clear the preview webview's WebView2 profile — cookies, cached tokens and
/// site storage — then reload, so the deployed app starts a brand-new session.
/// Useful when a previous Entra/AAD identity was cached and you want to sign in
/// as a different tenant or account. The auth-broker popup shares this same
/// profile, so clearing it here drops the cached identity everywhere.
#[tauri::command]
pub async fn preview_clear_data(app: AppHandle) -> AppResult<()> {
  match app.get_webview(PREVIEW_LABEL) {
    Some(wv) => wv
      .clear_all_browsing_data()
      .map_err(|e| AppError::Msg(e.to_string()))?,
    None => return Ok(()),
  }
  // `ClearBrowsingDataAll` runs on WebView2's own queue and WRY does not await
  // its completion handler, so the call returns before the data is actually
  // gone. Pause briefly (re-fetching the webview afterwards so nothing
  // non-`Send` is held across the await) before reloading, or the fresh request
  // could still carry the old cookies.
  tokio::time::sleep(std::time::Duration::from_millis(400)).await;
  if let Some(wv) = app.get_webview(PREVIEW_LABEL) {
    let _ = wv.reload();
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

/// Capture the current preview content as raw PNG bytes. Shared by the
/// [`preview_capture`] command (which base64-encodes for the renderer) and the
/// Fabricator `fabricator_screenshot`/`fabricator_navigate` tools (which return
/// the bytes to the agent as an `image/png` tool result). Errors if the preview
/// webview has not been created yet (the user has not opened a deployed app).
pub(crate) async fn capture_preview_bytes(app: &AppHandle) -> AppResult<Vec<u8>> {
  let wv = app
    .get_webview(PREVIEW_LABEL)
    .ok_or_else(|| AppError::Msg("preview is not open".into()))?;

  let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
  wv.with_webview(move |platform| {
    let _ = tx.send(capture_png(&platform));
  })
  .map_err(|e| AppError::Msg(format!("failed to access preview webview: {e}")))?;

  rx.await
    .map_err(|_| AppError::Msg("preview capture was cancelled".into()))?
    .map_err(AppError::Msg)
}

/// Whether the preview child webview currently exists (i.e. a deployed app has
/// been shown at least once this session).
pub(crate) fn is_preview_open(app: &AppHandle) -> bool {
  app.get_webview(PREVIEW_LABEL).is_some()
}

/// Ask the renderer to surface the preview pane and load `url` on the agent's
/// behalf. Used when a validation tool needs the preview visible but another
/// tab is focused (or the webview has not been created yet). The renderer owns
/// positioning, so it calls back into [`preview_show_url`] with real bounds.
pub(crate) fn request_preview_show(app: &AppHandle, url: &str) {
  let _ = app.emit(PREVIEW_AGENT, serde_json::json!({ "action": "show", "url": url }));
}

/// Navigate the existing preview webview to `url` (without touching bounds or
/// visibility) and wait for the document to finish loading, up to `timeout`.
/// Resets the back/forward history to the new URL. Returns `Ok` even if the
/// load times out (the page may still be usable for a screenshot).
pub(crate) async fn navigate_and_wait(app: &AppHandle, url: &str, timeout: Duration) -> AppResult<()> {
  let parsed: Url = url
    .parse()
    .map_err(|e| AppError::Msg(format!("invalid preview url {url:?}: {e}")))?;
  let wv = app
    .get_webview(PREVIEW_LABEL)
    .ok_or_else(|| AppError::Msg("preview is not open".into()))?;

  let rx = {
    let state = app.state::<PreviewState>();
    let mut inner = state.inner.lock().unwrap();
    let (tx, rx) = oneshot::channel::<()>();
    inner.load_waiters.push(tx);
    inner.reset_to(url);
    rx
  };

  wv.navigate(parsed).map_err(|e| AppError::Msg(e.to_string()))?;

  // Best-effort: a finished load resolves `rx`; otherwise fall through on timeout.
  let _ = tokio::time::timeout(timeout, rx).await;
  Ok(())
}

/// Capture the WebView2 preview to PNG bytes. Runs on the UI thread inside
/// [`preview_capture`]'s `with_webview` closure, where pumping the message loop
/// (via `wait_for_async_operation`) to await the COM completion is safe.
#[cfg(windows)]
fn capture_png(platform: &tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
  use webview2_com::CapturePreviewCompletedHandler;
  use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
  use windows::Win32::Foundation::HGLOBAL;
  use windows::Win32::System::Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream};
  use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

  let core = unsafe { platform.controller().CoreWebView2() }
    .map_err(|e| format!("CoreWebView2(): {e}"))?;

  // An auto-growing in-memory stream; its HGLOBAL is freed when the last
  // reference (`stream`) drops, after we have copied the bytes out below.
  let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
    .map_err(|e| format!("CreateStreamOnHGlobal: {e}"))?;

  let capture_stream = stream.clone();
  CapturePreviewCompletedHandler::wait_for_async_operation(
    Box::new(move |handler| unsafe {
      core
        .CapturePreview(
          COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
          &capture_stream,
          &handler,
        )
        .map_err(webview2_com::Error::WindowsError)
    }),
    Box::new(|result: windows::core::Result<()>| result),
  )
  .map_err(|e| format!("CapturePreview: {e}"))?;

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
