//! The app gallery's quick look: a published app's live page in a native child
//! webview of its own, over a panel in the gallery, for a look without leaving
//! Fabricator. Like the project preview (a separate webview, which the gallery
//! keeps hidden and untouched), it paints above all HTML, so the renderer keeps
//! it placed over its panel ([`quicklook_set_bounds`]) and closes it with the
//! panel ([`quicklook_close`]).
//!
//! It shares the main window's WebView2 profile, so an app's Fabric sign-in
//! works as it does in the preview: its sign-in popup is let through, and plain
//! links open in the user's browser.

use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Manager, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::services::preview::PreviewBounds;

const LABEL: &str = "quicklook";

/// The address last asked for, so showing it again doesn't reload the page.
static SHOWN: Lazy<Mutex<Option<String>>> = Lazy::new(Default::default);

/// Only `https` pages get a quick look: published apps and Fabric.
fn https(url: &str) -> AppResult<Url> {
  let parsed: Url = url.parse().map_err(|_| AppError::Msg("That isn't an address.".into()))?;
  if parsed.scheme() != "https" || parsed.host_str().is_none_or(str::is_empty) {
    return Err(AppError::Msg("Quick look opens https addresses only.".into()));
  }
  Ok(parsed)
}

/// Show `url` over `bounds`: the quick look's webview is made the first time,
/// and moved (and navigated, when the address changed) after that.
#[tauri::command]
pub async fn quicklook_show(app: AppHandle, url: String, bounds: PreviewBounds) -> AppResult<()> {
  let parsed = https(&url)?;
  let rect = bounds.to_rect()?;
  if let Some(webview) = app.get_webview(LABEL) {
    webview.set_bounds(rect).map_err(|e| AppError::Msg(e.to_string()))?;
    let changed = SHOWN.lock().unwrap().as_deref() != Some(url.as_str());
    if changed {
      webview.navigate(parsed).map_err(|e| AppError::Msg(e.to_string()))?;
      *SHOWN.lock().unwrap() = Some(url);
    }
    webview.show().map_err(|e| AppError::Msg(e.to_string()))?;
    return Ok(());
  }
  let main = app
    .get_webview_window("main")
    .ok_or_else(|| AppError::Msg("main window not found".into()))?;
  let popup_app = app.clone();
  // Not focused: the gallery keeps the keyboard (Space and Escape close it)
  // until the user clicks into the app.
  let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(parsed))
    .focused(false)
    .on_new_window(move |target, features| {
      // A sized popup is the Fabric sign-in broker; a plain link goes to the browser.
      if features.size().is_some() || features.position().is_some() {
        NewWindowResponse::Allow
      } else {
        let _ = popup_app.opener().open_url(target.to_string(), None::<&str>);
        NewWindowResponse::Deny
      }
    });
  // Same WebView2 environment as the main window and the preview: no
  // per-webview browser arguments (see `preview::build`).
  main
    .as_ref()
    .window()
    .add_child(builder, rect.position, rect.size)
    .map_err(|e| AppError::Msg(format!("Couldn't open the quick look: {e}")))?;
  *SHOWN.lock().unwrap() = Some(url);
  Ok(())
}

/// Keep the quick look over its panel as the window or the panel moves.
#[tauri::command]
pub fn quicklook_set_bounds(app: AppHandle, bounds: PreviewBounds) -> AppResult<()> {
  if let Some(webview) = app.get_webview(LABEL) {
    webview.set_bounds(bounds.to_rect()?).map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

/// Close the quick look, page and all.
#[tauri::command]
pub fn quicklook_close(app: AppHandle) -> AppResult<()> {
  *SHOWN.lock().unwrap() = None;
  if let Some(webview) = app.get_webview(LABEL) {
    webview.close().map_err(|e| AppError::Msg(e.to_string()))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_https_pages_get_a_quick_look() {
    assert!(https("https://flat-oak-1a2b-westus.webapp.fabricapps.net").is_ok());
    assert!(https("https://app.fabric.microsoft.com/groups/x/appbackends/y").is_ok());
    for url in ["http://localhost:5173", "javascript:alert(1)", "file:///C:/x.html", "not a url", "https://"] {
      assert!(https(url).is_err(), "{url}");
    }
  }
}
