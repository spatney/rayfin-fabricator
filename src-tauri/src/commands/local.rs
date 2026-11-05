//! IPC for each project's local backend (`window.api.local`): its lifecycle and
//! output, and, while it runs, its data, users, sign-in identity and local
//! secret values. The work is in [`crate::services::local_backend`]. Commands
//! fail with a [`LocalCommandError`] (`{code, message, hint}`).

use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::services::journal::{self, Area, Level};
use crate::services::local_backend::{self, error, project_dir, sign_in_flag, valid_sign_in, DEFAULT_LOG_LINES};
use crate::services::{exec, git, telemetry};
use crate::types::{
  LocalCommandError, LocalEntity, LocalFiles, LocalIdentity, LocalIdentityRequest, LocalLogEvent, LocalReloadResult,
  LocalRows, LocalSecret, LocalSeed, LocalSeedLoad, LocalSeedSaved, LocalStartOptions, LocalStatus, LocalStorageFolder,
  LocalUser,
};

type LocalResult<T> = Result<T, LocalCommandError>;

fn checked(options: Option<LocalStartOptions>) -> LocalResult<LocalStartOptions> {
  let options = options.unwrap_or_default();
  match options.sign_in_as.as_deref() {
    Some(who) if !valid_sign_in(who) => Err(error(
      "invalid",
      format!("{who:?} isn't a sign-in identity."),
      Some("Use developer, none or user:<username>."),
    )),
    _ => Ok(options),
  }
}

/// Start the project's local backend unless it runs. Resolves at once with its
/// status (`starting`); `local:state` follows its progress.
#[tauri::command]
pub async fn local_start(app: AppHandle, project_id: String, options: Option<LocalStartOptions>) -> LocalResult<LocalStatus> {
  let options = checked(options)?;
  let dir = project_dir(&project_id)?;
  Ok(local_backend::state(&app).start(&project_id, dir, options).await)
}

/// Stop the project's local backend and wait until it has.
#[tauri::command]
pub async fn local_stop(app: AppHandle, project_id: String) -> LocalResult<LocalStatus> {
  Ok(local_backend::state(&app).stop(&project_id).await)
}

/// Stop the project's local backend if it runs, and start it with `options`.
#[tauri::command]
pub async fn local_restart(app: AppHandle, project_id: String, options: Option<LocalStartOptions>) -> LocalResult<LocalStatus> {
  let options = checked(options)?;
  let dir = project_dir(&project_id)?;
  Ok(local_backend::state(&app).restart(&project_id, dir, options).await)
}

/// A backend that never ran is `stopped`.
#[tauri::command]
pub fn local_status(app: AppHandle, project_id: String) -> LocalStatus {
  local_backend::snapshot(&app, &project_id)
}

/// The project's last `limit` lines of output (default 500, at most 2000), oldest first.
#[tauri::command]
pub fn local_logs(app: AppHandle, project_id: String, limit: Option<usize>) -> Vec<LocalLogEvent> {
  local_backend::recent_logs(&app, &project_id, limit.unwrap_or(DEFAULT_LOG_LINES))
}

/// Read `rayfin.yml`, the entities and the secrets again and apply them;
/// `force_schema` applies a schema change that loses data.
#[tauri::command]
pub async fn local_reload(app: AppHandle, project_id: String, force_schema: bool) -> LocalResult<LocalReloadResult> {
  local_backend::control(&app, &project_id)?.reload(force_schema).await
}

/// Delete every entity's rows, the local users and the stored files, without a restart.
#[tauri::command]
pub async fn local_reset_data(app: AppHandle, project_id: String) -> LocalResult<()> {
  local_backend::control(&app, &project_id)?.reset_data().await
}

#[tauri::command]
pub async fn local_users(app: AppHandle, project_id: String) -> LocalResult<Vec<LocalUser>> {
  local_backend::control(&app, &project_id)?.users().await
}

/// Add a local user. Without a password it can only be signed in by Fabricator (Preview as).
#[tauri::command]
pub async fn local_add_user(app: AppHandle, project_id: String, username: String, password: Option<String>) -> LocalResult<LocalUser> {
  let username = username.trim();
  if username.is_empty() {
    return Err(error("invalid", "Enter a username, such as an email address.", None));
  }
  let password = password.as_deref().filter(|p| !p.is_empty());
  local_backend::control(&app, &project_id)?.add_user(username, password).await
}

/// Delete a local user (by username or id) and sign out its sessions.
#[tauri::command]
pub async fn local_delete_user(app: AppHandle, project_id: String, user: String) -> LocalResult<()> {
  local_backend::control(&app, &project_id)?.delete_user(&user).await
}

/// Who the app signs in as automatically.
#[tauri::command]
pub async fn local_identity(app: AppHandle, project_id: String) -> LocalResult<LocalIdentity> {
  local_backend::control(&app, &project_id)?.identity().await
}

/// Change who the app signs in as (revokes every local session). Restarts keep it.
#[tauri::command]
pub async fn local_set_identity(app: AppHandle, project_id: String, identity: LocalIdentityRequest) -> LocalResult<LocalIdentity> {
  let user = identity.user.as_deref().map(str::trim).filter(|u| !u.is_empty());
  match identity.kind.as_str() {
    "developer" | "none" => {}
    "user" if user.is_some() => {}
    "user" => return Err(error("invalid", "Choose the user to sign in as.", None)),
    other => return Err(error("invalid", format!("{other:?} isn't a sign-in identity."), Some("Use developer, user or none."))),
  }
  let backends = local_backend::state(&app);
  let result = backends.control(&project_id)?.set_identity(&identity).await?;
  backends.remember_sign_in(&project_id, sign_in_flag(&result, user));
  Ok(result)
}

/// Every entity with its number of rows.
#[tauri::command]
pub async fn local_entities(app: AppHandle, project_id: String) -> LocalResult<Vec<LocalEntity>> {
  local_backend::control(&app, &project_id)?.entities().await
}

/// A page of an entity's rows, regardless of permissions (`limit` at most 500).
#[tauri::command]
pub async fn local_rows(
  app: AppHandle,
  project_id: String,
  entity: String,
  offset: u64,
  limit: u64,
  order_by: Option<String>,
  desc: Option<bool>,
) -> LocalResult<LocalRows> {
  local_backend::control(&app, &project_id)?.rows(&entity, offset, limit, order_by.as_deref(), desc.unwrap_or(false)).await
}

/// Delete every row of an entity; returns how many.
#[tauri::command]
pub async fn local_clear_rows(app: AppHandle, project_id: String, entity: String) -> LocalResult<u64> {
  local_backend::control(&app, &project_id)?.clear_rows(&entity).await
}

/// The storage folders, each with its number of files and their size.
#[tauri::command]
pub async fn local_storage(app: AppHandle, project_id: String) -> LocalResult<Vec<LocalStorageFolder>> {
  local_backend::control(&app, &project_id)?.storage().await
}

/// A page of a storage folder's files, regardless of its rules (`limit` at most 500).
#[tauri::command]
pub async fn local_files(app: AppHandle, project_id: String, folder: String, offset: u64, limit: u64) -> LocalResult<LocalFiles> {
  local_backend::control(&app, &project_id)?.files(&folder, offset, limit).await
}

/// A stored file's bytes, as base64, for a preview: the first `max_bytes` of
/// them when given. Base64 because the renderer's IPC runs over postMessage
/// (its CSP keeps Tauri's IPC protocol out), which sends raw bytes as a JSON
/// array of numbers: about five times slower for a 20 MB file.
#[tauri::command]
pub async fn local_file(
  app: AppHandle,
  project_id: String,
  folder: String,
  path: String,
  max_bytes: Option<u64>,
) -> LocalResult<String> {
  use base64::Engine as _;
  let mut bytes = local_backend::control(&app, &project_id)?.file(&folder, &path).await?;
  if let Some(max) = max_bytes {
    bytes.truncate(usize::try_from(max).unwrap_or(usize::MAX));
  }
  Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Save a copy of a stored file where the user chooses in the OS's Save As
/// dialog. Resolves with where it went, or `None` when they cancel.
#[tauri::command]
pub async fn local_save_file(app: AppHandle, project_id: String, folder: String, path: String) -> LocalResult<Option<String>> {
  let control = local_backend::control(&app, &project_id)?;
  let name = path.rsplit('/').next().unwrap_or(&path).to_string();
  let (tx, rx) = tokio::sync::oneshot::channel();
  app.dialog().file().set_file_name(name).save_file(move |picked| {
    let _ = tx.send(picked);
  });
  let Some(target) = rx.await.ok().flatten().and_then(|picked| picked.into_path().ok()) else {
    return Ok(None);
  };
  let bytes = control.file(&folder, &path).await?;
  tokio::fs::write(&target, bytes)
    .await
    .map_err(|e| error("save-failed", format!("Couldn't save the file: {e}"), Some("Choose another folder.")))?;
  Ok(Some(target.display().to_string()))
}

/// Delete a stored file.
#[tauri::command]
pub async fn local_delete_file(app: AppHandle, project_id: String, folder: String, path: String) -> LocalResult<()> {
  local_backend::control(&app, &project_id)?.delete_file(&folder, &path).await
}

/// Delete every file in a storage folder; returns how many.
#[tauri::command]
pub async fn local_clear_files(app: AppHandle, project_id: String, folder: String) -> LocalResult<u64> {
  local_backend::control(&app, &project_id)?.clear_files(&folder).await
}

/// The project's seed data (`rayfin/seed`), checked without loading it.
#[tauri::command]
pub async fn local_seed(app: AppHandle, project_id: String) -> LocalResult<LocalSeed> {
  local_backend::control(&app, &project_id)?.seed().await
}

/// Replace the local data with the project's seed data: every entity's rows and
/// every stored file (the local users stay). `dry_run` only finds what loading
/// would refuse, changing nothing. The seed data's problems come back as
/// `ok: false` with `problems`.
#[tauri::command]
pub async fn local_load_seed(app: AppHandle, project_id: String, dry_run: Option<bool>) -> LocalResult<LocalSeedLoad> {
  local_backend::control(&app, &project_id)?.load_seed(dry_run.unwrap_or(false)).await
}

/// Save the local data as the project's seed data, in place of the rows and
/// files in `rayfin/seed`, and save the change as a version in History.
#[tauri::command]
pub async fn local_save_seed(app: AppHandle, project_id: String) -> LocalResult<LocalSeedSaved> {
  let dir = project_dir(&project_id)?;
  let control = local_backend::control(&app, &project_id)?;
  let saved = local_backend::seed::save(&control, &dir).await?;
  commit_seed(&dir).await;
  Ok(saved)
}

/// The History message of a save of the seed data.
const SEED_COMMIT: &str = "Save the local data as seed data";

/// Commit what a save changed in `rayfin/seed`, best-effort, as Fabricator does
/// for the changes it makes outside chat turns. Only the folders a save
/// replaces, and only those git sees changes in, so the commit's paths all
/// match and nothing else is swept in.
async fn commit_seed(dir: &Path) {
  let mut changed = Vec::new();
  for part in local_backend::seed::PARTS {
    let path = format!("rayfin/seed/{part}");
    let options = exec::RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(30_000), ..Default::default() };
    let status = git::run(&["status", "--porcelain", "--untracked-files=all", "--", &path], options).await;
    if status.ok && !status.stdout.trim().is_empty() {
      changed.push(path);
    }
  }
  let paths: Vec<&str> = changed.iter().map(String::as_str).collect();
  crate::commands::skills::commit_paths(&dir.to_string_lossy(), &paths, SEED_COMMIT).await;
}

/// The secrets and where their local values come from (never the values).
#[tauri::command]
pub async fn local_secrets(app: AppHandle, project_id: String) -> LocalResult<Vec<LocalSecret>> {
  let dir = project_dir(&project_id)?;
  local_backend::state(&app).secrets(&dir).await
}

/// Store a secret's local value. It goes to rayfin-local through stdin, never as
/// an argument; a running backend applies it by itself.
#[tauri::command]
pub async fn local_set_secret(app: AppHandle, project_id: String, name: String, value: String) -> LocalResult<()> {
  crate::commands::secrets::validate_name(&name).map_err(|message| error("invalid", message, None))?;
  if value.is_empty() {
    return Err(error("invalid", "Enter a value for the secret.", None));
  }
  let dir = project_dir(&project_id)?;
  local_backend::state(&app).set_secret(&dir, &name, &value).await
}

/// Delete a secret's local value.
#[tauri::command]
pub async fn local_delete_secret(app: AppHandle, project_id: String, name: String) -> LocalResult<()> {
  crate::commands::secrets::validate_name(&name).map_err(|message| error("invalid", message, None))?;
  let dir = project_dir(&project_id)?;
  local_backend::state(&app).delete_secret(&dir, &name).await
}

/// Stop the rayfin-local another program runs on this project (the
/// `already-serving` error's `details.pid`), once it's checked to be one.
#[tauri::command]
pub async fn local_stop_external(app: AppHandle, project_id: String, pid: u32) -> LocalResult<()> {
  local_backend::state(&app).stop_external(&project_id, pid).await
}

/// Install the npm packages the project's backend reported missing
/// (`packages-missing`), with npm's output in the project's output. It doesn't
/// start the backend: the caller starts it again once this succeeds.
#[tauri::command]
pub async fn local_install_packages(app: AppHandle, project_id: String) -> LocalResult<()> {
  let dir = project_dir(&project_id)?;
  local_backend::state(&app).install_packages(&project_id, &dir).await
}

/// Install the app's npm packages again after git changed its `package.json`
/// or lockfile, with npm's output in the project's output. A backend that runs
/// stops for it and starts again after.
#[tauri::command]
pub async fn local_reinstall_packages(app: AppHandle, project_id: String) -> LocalResult<()> {
  let dir = project_dir(&project_id)?;
  local_backend::state(&app).reinstall_packages(&project_id, &dir).await
}

/// The preview of a published app uses its published backend, because this
/// computer can't run the app (`code`: `sdk-unsupported` or
/// `connector-unsupported`; `reason` is what the preview says). Journals it as
/// `local.fallback` for Help, and counts it.
#[tauri::command]
pub fn local_report_fallback(project_id: String, code: String, reason: String) -> LocalResult<()> {
  if !matches!(code.as_str(), "sdk-unsupported" | "connector-unsupported") {
    return Err(error("invalid", format!("{code:?} isn't a reason to use the published backend."), None));
  }
  journal::entry(Level::Warn, Area::Preview, "local.fallback", reason.trim())
    .operation("local_backend")
    .surface(journal::Surface::Inline)
    .detail(Some(format!("code: {code}")))
    .project(Some(project_id))
    .write();
  telemetry::track_local(crate::commands::auth::get_cached_identity().as_ref(), "fallback", Some(&code));
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn saved_seed_data_is_committed_and_nothing_else() {
    if which::which("git").is_err() {
      return;
    }
    let dir = std::env::temp_dir().join(format!("fab-seed-git-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("rayfin/seed/data")).unwrap();
    let git = |args: &[&str]| {
      let out = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
      String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "core.autocrlf", "false"]);
    git(&["config", "user.name", "Test"]);
    git(&["config", "user.email", "test@example.invalid"]);
    std::fs::write(dir.join("rayfin/seed/data/Old.json"), "[]\n").unwrap();
    std::fs::write(dir.join("rayfin/seed/README.md"), "v1\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "First"]);

    // What a save of rows without files does, next to unrelated unsaved edits.
    std::fs::remove_file(dir.join("rayfin/seed/data/Old.json")).unwrap();
    std::fs::write(dir.join("rayfin/seed/data/Note.json"), "[]\n").unwrap();
    std::fs::write(dir.join("rayfin/seed/README.md"), "v2\n").unwrap();
    commit_seed(&dir).await;

    assert_eq!(git(&["log", "-1", "--pretty=%s"]), SEED_COMMIT);
    let committed = git(&["show", "--name-status", "--no-renames", "--pretty=format:", "HEAD"]);
    assert_eq!(committed, "A\trayfin/seed/data/Note.json\nD\trayfin/seed/data/Old.json");
    assert_eq!(git(&["status", "--porcelain"]), "M rayfin/seed/README.md");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn only_known_sign_in_identities_start() {
    for ok in ["developer", "none", "user:ana@example.com"] {
      let options = LocalStartOptions { sign_in_as: Some(ok.into()), ..Default::default() };
      assert!(checked(Some(options)).is_ok(), "{ok}");
    }
    assert!(checked(None).unwrap().sign_in_as.is_none());
    for bad in ["", "admin", "user:", "user:  ", "Developer"] {
      let options = LocalStartOptions { sign_in_as: Some(bad.into()), ..Default::default() };
      assert_eq!(checked(Some(options)).unwrap_err().code, "invalid", "{bad:?}");
    }
  }
}
