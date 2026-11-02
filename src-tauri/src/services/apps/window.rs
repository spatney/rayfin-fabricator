//! An installed app's window. It opens on Fabricator's own page (the
//! renderer's `AppWindow`), which asks before installing and shows the app
//! getting ready, then shows the app itself. Fabricator's commands can't be
//! reached from the app: Tauri treats its origin as remote, and no capability
//! names it. The window stays on the app: Fabricator's page loads in it only
//! when Fabricator puts it there, and links to other sites open in the browser.

use std::path::PathBuf;
use std::time::Duration;

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_opener::OpenerExt;

use super::{Apps, APPS_CHANGED};

/// The labels of app windows: `app-<key>`, or `app-error-<id>` for a file that
/// can't be opened.
const PREFIX: &str = "app-";
/// Tauri event asking an app window's page to look again at what it's for
/// (its label is the payload).
pub const APPS_WINDOW: &str = "apps:window";

/// What an app window is for, and what it may show.
pub(super) struct WindowState {
  key: String,
  /// The app file to install, after asking.
  file: Option<PathBuf>,
  /// Why there's nothing to run.
  error: Option<String>,
  /// Fabricator's own page may load: Fabricator put it there.
  page_allowed: bool,
  /// The app, once it's shown.
  app_url: Option<Url>,
}

/// One of the windows of installed apps, by its label.
pub fn is_app_window(label: &str) -> bool {
  label.starts_with(PREFIX)
}

fn label_of(key: &str) -> String {
  format!("{PREFIX}{key}")
}

/// Where Fabricator's own pages load from: its dev server, or its own protocol.
fn own_origin(app: &AppHandle) -> Option<Url> {
  if tauri::is_dev() {
    if let Some(url) = app.config().build.dev_url.clone() {
      return Some(url);
    }
  }
  Url::parse(if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" }).ok()
}

/// What to do with a navigation of an app window.
#[derive(Debug, PartialEq, Eq)]
enum Nav {
  Allow,
  Deny,
  /// Open it in the browser instead.
  Browser,
}

/// The same app: its port on a loopback host (the app and its sign-in page
/// may name it `localhost` or `127.0.0.1`).
fn same_app(app: &Url, url: &Url) -> bool {
  let loopback = |u: &Url| matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
  app.scheme() == url.scheme() && app.port_or_known_default() == url.port_or_known_default() && loopback(app) && loopback(url)
}

/// Whether an app window may go to `url`. Fabricator's page only when
/// Fabricator put it there; the app's own pages always; other sites in the
/// browser, where `whole_page` (Windows asks only about the page itself; macOS
/// asks about its frames too, which stay where the app puts them).
fn decide(url: &Url, own: Option<&Url>, page_allowed: bool, app: Option<&Url>, whole_page: bool) -> Nav {
  if own.is_some_and(|own| own.origin() == url.origin()) {
    return if page_allowed { Nav::Allow } else { Nav::Deny };
  }
  match url.scheme() {
    "http" | "https" if app.is_some_and(|app| same_app(app, url)) => Nav::Allow,
    "http" | "https" if whole_page => Nav::Browser,
    "http" | "https" | "about" | "blob" | "data" => Nav::Allow,
    _ => Nav::Deny,
  }
}

fn on_navigation(app: &AppHandle, label: &str, url: &Url) -> bool {
  let own = own_origin(app);
  let decision = match app.state::<Apps>().windows.lock().unwrap().get(label) {
    Some(state) => decide(url, own.as_ref(), state.page_allowed, state.app_url.as_ref(), !cfg!(target_os = "macos")),
    None => Nav::Deny,
  };
  match decision {
    Nav::Allow => true,
    Nav::Deny => {
      log::warn!("[apps] {label} may not go to {url}");
      false
    }
    Nav::Browser => {
      let _ = app.opener().open_url(url.as_str(), None::<&str>);
      false
    }
  }
}

/// A sized `window.open` is the app's sign-in popup, which the web view owns
/// (as the preview's); anything else opens in the browser.
fn on_new_window(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
  if features.size().is_some() || features.position().is_some() {
    return NewWindowResponse::Allow;
  }
  if matches!(url.scheme(), "http" | "https") {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
  }
  NewWindowResponse::Deny
}

fn build(app: &AppHandle, label: &str, title: &str, icon: Option<&[u8]>) -> tauri::Result<WebviewWindow> {
  let (nav_app, nav_label, popup_app) = (app.clone(), label.to_string(), app.clone());
  let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
    .title(title)
    .inner_size(1180.0, 800.0)
    .min_inner_size(420.0, 320.0)
    .center()
    // Shown once Fabricator's page has painted, as the main window is.
    .visible(false)
    .background_color(Color(0x0b, 0x0e, 0x14, 255))
    // An app, not a page to inspect (debug builds keep the inspector).
    .devtools(cfg!(debug_assertions))
    // Files dropped on the app reach the app.
    .disable_drag_drop_handler()
    .on_navigation(move |url| on_navigation(&nav_app, &nav_label, url))
    .on_new_window(move |url, features| on_new_window(&popup_app, url, features));
  if let Some(image) = icon.and_then(super::window_icon) {
    builder = builder.icon(image)?;
  }
  let window = builder.build()?;
  let (closed_app, closed_label) = (app.clone(), label.to_string());
  window.on_window_event(move |event| {
    if let WindowEvent::Destroyed = event {
      closed(&closed_app, &closed_label);
    }
  });
  Ok(window)
}

fn bring_forward(window: &WebviewWindow) {
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();
}

/// Open the app's window, or bring it forward. `file`: an app file to install,
/// after asking; `error`: why there's nothing to open. An empty `key` opens a
/// window that only says `error`.
pub(super) fn open(
  app: &AppHandle,
  key: &str,
  title: &str,
  icon: Option<Vec<u8>>,
  file: Option<PathBuf>,
  error: Option<String>,
) {
  let label = if key.is_empty() { format!("{PREFIX}error-{}", super::short_id()) } else { label_of(key) };
  let apps = app.state::<Apps>();
  if let Some(window) = app.get_webview_window(&label) {
    if file.is_some() || error.is_some() {
      if let Some(state) = apps.windows.lock().unwrap().get_mut(&label) {
        state.file = file;
        state.error = error;
      }
      show_page(app, &label);
    }
    bring_forward(&window);
    return;
  }
  let state = WindowState { key: key.to_string(), file, error, page_allowed: true, app_url: None };
  apps.windows.lock().unwrap().insert(label.clone(), state);
  match build(app, &label, title, icon.as_deref()) {
    Ok(window) => {
      #[cfg(windows)]
      if !key.is_empty() {
        super::shell::identify(&window, key, title);
      }
      // Show it anyway should its page never paint.
      std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        if window.is_visible().is_ok_and(|visible| !visible) {
          bring_forward(&window);
        }
      });
      let _ = app.emit(APPS_CHANGED, ());
    }
    Err(error) => {
      log::error!("[apps] couldn't open the window of {key}: {error}");
      apps.windows.lock().unwrap().remove(&label);
      // Started only for this app: don't stay running with nothing to show.
      if app.webview_windows().is_empty() {
        app.exit(1);
      }
    }
  }
}

/// The window closed: stop its app.
fn closed(app: &AppHandle, label: &str) {
  let state = app.state::<Apps>().windows.lock().unwrap().remove(label);
  if let Some(key) = state.map(|s| s.key).filter(|key| !key.is_empty()) {
    super::stop(app, &key);
  }
  let _ = app.emit(APPS_CHANGED, ());
}

/// What the window `label` is for: its app's key, the file to install, why there's nothing to open.
pub(super) fn purpose(app: &AppHandle, label: &str) -> Option<(String, Option<PathBuf>, Option<String>)> {
  let apps = app.state::<Apps>();
  let windows = apps.windows.lock().unwrap();
  let state = windows.get(label)?;
  Some((state.key.clone(), state.file.clone(), state.error.clone()))
}

pub(super) fn is_open(app: &AppHandle, key: &str) -> bool {
  app.get_webview_window(&label_of(key)).is_some()
}

/// The window runs the installed version, not the file it was opened with.
pub(super) fn forget_file(app: &AppHandle, label: &str) {
  if let Some(state) = app.state::<Apps>().windows.lock().unwrap().get_mut(label) {
    state.file = None;
  }
}

/// The window's file is installed: it runs the app now, under the app's name and icon.
pub(super) fn installed(app: &AppHandle, label: &str, name: &str, icon: Option<Vec<u8>>) {
  let key = {
    let apps = app.state::<Apps>();
    let mut windows = apps.windows.lock().unwrap();
    let Some(state) = windows.get_mut(label) else { return };
    state.file = None;
    state.key.clone()
  };
  let Some(window) = app.get_webview_window(label) else { return };
  let _ = window.set_title(name);
  if let Some(image) = icon.as_deref().and_then(super::window_icon) {
    let _ = window.set_icon(image);
  }
  #[cfg(windows)]
  super::shell::identify(&window, &key, name);
  #[cfg(not(windows))]
  let _ = key;
}

/// Show the app in its window, unless Fabricator's page there is asking
/// something first, or the window shows it already.
pub(super) fn show_app(app: &AppHandle, key: &str, url: Url) {
  let label = label_of(key);
  let Some(window) = app.get_webview_window(&label) else { return };
  {
    let apps = app.state::<Apps>();
    let mut windows = apps.windows.lock().unwrap();
    let Some(state) = windows.get_mut(&label) else { return };
    if state.file.is_some() || state.error.is_some() || (!state.page_allowed && state.app_url.as_ref() == Some(&url)) {
      return;
    }
    state.app_url = Some(url.clone());
    state.page_allowed = false;
  }
  if let Err(error) = window.navigate(url) {
    log::warn!("[apps] couldn't show {key}: {error}");
  }
}

/// Show Fabricator's page in the app's window again, say to tell why it stopped.
pub(super) fn show_launcher(app: &AppHandle, key: &str) {
  show_page(app, &label_of(key));
}

fn show_page(app: &AppHandle, label: &str) {
  let Some(window) = app.get_webview_window(label) else { return };
  let Some(page) = own_origin(app).and_then(|origin| origin.join("index.html").ok()) else { return };
  let already = {
    let apps = app.state::<Apps>();
    let mut windows = apps.windows.lock().unwrap();
    let Some(state) = windows.get_mut(label) else { return };
    let already = state.page_allowed;
    state.page_allowed = true;
    state.app_url = None;
    already
  };
  if already {
    let _ = window.emit(APPS_WINDOW, label);
  } else if let Err(error) = window.navigate(page) {
    log::warn!("[apps] couldn't show Fabricator's page in {label}: {error}");
  }
}

/// Close the app's window.
pub(super) fn close(app: &AppHandle, key: &str) {
  if let Some(window) = app.get_webview_window(&label_of(key)) {
    let _ = window.destroy();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn url(text: &str) -> Url {
    Url::parse(text).unwrap()
  }

  #[test]
  fn an_app_window_stays_on_its_app() {
    let own = url("http://tauri.localhost/");
    let app = url("http://localhost:47100/");
    let decide = |to: &str, page_allowed: bool, whole_page: bool| decide(&url(to), Some(&own), page_allowed, Some(&app), whole_page);

    // Fabricator's page only when Fabricator puts it there.
    assert_eq!(decide("http://tauri.localhost/index.html", true, true), Nav::Allow);
    assert_eq!(decide("http://tauri.localhost/index.html", false, true), Nav::Deny);
    assert_eq!(decide("http://tauri.localhost/index.html", false, false), Nav::Deny, "nor in a frame");
    // The app and its sign-in page, by either loopback name.
    assert_eq!(decide("http://localhost:47100/notes?id=1", false, true), Nav::Allow);
    assert_eq!(decide("http://127.0.0.1:47100/.rayfin-local/portal", false, true), Nav::Allow);
    // Other apps and sites: the browser, unless it may be a frame.
    assert_eq!(decide("http://localhost:47101/", false, true), Nav::Browser);
    assert_eq!(decide("https://contoso.com/help", false, true), Nav::Browser);
    assert_eq!(decide("https://www.youtube.com/embed/x", false, false), Nav::Allow);
    // Never files or other schemes.
    assert_eq!(decide("file:///C:/Windows/win.ini", false, true), Nav::Deny);
    assert_eq!(decide("about:blank", false, true), Nav::Allow);
  }

  #[test]
  fn in_development_fabricators_page_is_its_dev_server() {
    let own = url("http://localhost:1420/");
    let app = url("http://localhost:47100/");
    assert_eq!(decide(&url("http://localhost:1420/index.html"), Some(&own), false, Some(&app), true), Nav::Deny);
    assert_eq!(decide(&url("http://localhost:47100/"), Some(&own), false, Some(&app), true), Nav::Allow);
  }
}
