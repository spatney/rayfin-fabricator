//! In-app auto-update built on `tauri-plugin-updater`. The renderer drives this
//! through `window.api.updates` (`check` / `download` / `install`); download
//! progress streams to the renderer on the `update:progress` event.
//!
//! Flow: `check` looks for a newer release (no download); `download` fetches the
//! installer in the background and retains its bytes; `install` applies those
//! bytes and restarts. Endpoints + the signing public key come from
//! `tauri.conf.json` (`plugins.updater`).

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult};
use crate::services::emit::UPDATE_PROGRESS;
use crate::types::{UpdateInfo, UpdateProgress};

/// Holds the update found by a check and, once fetched, its installer bytes, so a
/// later `install` can apply them without downloading again.
#[derive(Default)]
pub struct UpdaterState {
  update: Mutex<Option<Update>>,
  bytes: Mutex<Option<Vec<u8>>>,
}

fn info_from(update: &Update) -> UpdateInfo {
  UpdateInfo {
    version: update.version.clone(),
    current_version: update.current_version.clone(),
    notes: update.body.clone(),
    date: update.date.map(|d| d.to_string()),
  }
}

async fn run_check(app: &AppHandle) -> AppResult<Option<Update>> {
  let updater = app.updater().map_err(|e| AppError::Msg(e.to_string()))?;
  updater
    .check()
    .await
    .map_err(|e| AppError::Msg(e.to_string()))
}

/// Check for a newer release without downloading. Caches the result for `download`.
pub async fn check(app: &AppHandle, state: &UpdaterState) -> AppResult<Option<UpdateInfo>> {
  let found = run_check(app).await?;
  let info = found.as_ref().map(info_from);
  *state.bytes.lock().unwrap() = None;
  *state.update.lock().unwrap() = found;
  Ok(info)
}

/// Download the pending update (checking first if needed) in the background,
/// emitting `update:progress`. Retains the installer bytes for `install`.
pub async fn download(app: &AppHandle, state: &UpdaterState) -> AppResult<Option<UpdateInfo>> {
  let mut update = state.update.lock().unwrap().clone();
  if update.is_none() {
    update = run_check(app).await?;
    *state.update.lock().unwrap() = update.clone();
  }
  let Some(update) = update else {
    return Ok(None);
  };
  let info = info_from(&update);

  let app_dl = app.clone();
  let mut downloaded: u64 = 0;
  let bytes = update
    .download(
      move |chunk_len, content_len| {
        downloaded += chunk_len as u64;
        let _ = app_dl.emit(
          UPDATE_PROGRESS,
          UpdateProgress {
            downloaded,
            total: content_len,
          },
        );
      },
      || {},
    )
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?;

  *state.bytes.lock().unwrap() = Some(bytes);
  Ok(Some(info))
}

/// Install the previously downloaded update, then restart the app.
pub async fn install(app: &AppHandle, state: &UpdaterState) -> AppResult<()> {
  let update = state.update.lock().unwrap().clone();
  let bytes = state.bytes.lock().unwrap().take();
  let (Some(update), Some(bytes)) = (update, bytes) else {
    return Err(AppError::Msg(
      "No downloaded update to install. Check for updates first.".into(),
    ));
  };
  update
    .install(bytes)
    .map_err(|e| AppError::Msg(e.to_string()))?;
  app.restart();
  #[allow(unreachable_code)]
  Ok(())
}

#[cfg(test)]
mod tests {
  use tauri_plugin_updater::{Config, RemoteRelease};

  /// The manifest `release.yml` publishes as `latest.json` (step "Generate and upload
  /// updater manifest"), copied from v1.16.1 with shorter notes and placeholder
  /// signatures. Installed apps parse it with whatever updater plugin they shipped, so
  /// its shape must keep working across plugin upgrades.
  const LATEST_JSON: &str = r###"{
  "version": "1.16.1",
  "notes": "## Half-finished installs repair themselves\r\n\r\nFabricator now checks that all of a project's packages are installed.\r",
  "pub_date": "2026-10-12T06:55:33Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "windows-signature",
      "url": "https://github.com/spatney/rayfin-fabricator/releases/download/v1.16.1/Rayfin.Fabricator_1.16.1_x64-setup.exe"
    },
    "darwin-aarch64": {
      "signature": "macos-signature",
      "url": "https://github.com/spatney/rayfin-fabricator/releases/download/v1.16.1/Rayfin.Fabricator.app.tar.gz"
    }
  }
}"###;

  #[test]
  fn the_published_update_manifest_resolves_both_platforms() {
    let release: RemoteRelease = serde_json::from_str(LATEST_JSON).unwrap();
    assert_eq!(release.version.to_string(), "1.16.1");
    assert!(release.notes.as_deref().unwrap().starts_with("## Half-finished"));
    assert!(release.pub_date.is_some());

    let windows = release.download_url("windows-x86_64").unwrap();
    assert!(windows.as_str().ends_with("_x64-setup.exe"));
    assert_eq!(release.signature("windows-x86_64").unwrap(), "windows-signature");
    let macos = release.download_url("darwin-aarch64").unwrap();
    assert!(macos.as_str().ends_with(".app.tar.gz"));
    assert_eq!(release.signature("darwin-aarch64").unwrap(), "macos-signature");
    assert!(release.download_url("linux-x86_64").is_err());
  }

  #[test]
  fn the_app_updater_config_parses() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let config: Config = serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();
    let endpoints: Vec<&str> = config.endpoints.iter().map(|url| url.as_str()).collect();
    assert_eq!(
      endpoints,
      ["https://github.com/spatney/rayfin-fabricator/releases/latest/download/latest.json"]
    );
    assert!(!config.pubkey.is_empty());
  }
}
