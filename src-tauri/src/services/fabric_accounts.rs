//! Several Microsoft Fabric sign-ins side by side.
//!
//! The Rayfin CLI keeps one signed-in identity per config folder
//! (`RAYFIN_CONFIG_DIR`, `~/.rayfin` by default): `auth.json` names the account
//! and `cache.bin` holds its tokens. The CLI's own folder is the "shared"
//! account (`rayfin` in a terminal uses it too); each account added after it
//! gets a folder of its own under Fabricator's data folder. The active
//! account's folder is exported as `RAYFIN_CONFIG_DIR` to every process
//! Fabricator starts from then on, so deploys, workspace lists, sharing and
//! secrets — and the project CLIs and auth helpers behind them — act as it.
//!
//! On Windows each folder's tokens are a DPAPI-protected file inside it. On
//! macOS the CLI keeps every folder's tokens in one Keychain entry: each folder
//! still picks its own account from it, but `rayfin logout` clears the entry,
//! so signing out of one account there signs every account out.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};

use crate::services::paths;
use crate::types::FabricAccount;

/// The id of the Rayfin CLI's own folder.
pub const SHARED: &str = "shared";
pub const CONFIG_DIR_ENV: &str = "RAYFIN_CONFIG_DIR";
/// Every account's tokens share one OS keychain entry (see the module docs).
pub const SHARED_TOKEN_STORE: bool = cfg!(not(windows));

/// `RAYFIN_CONFIG_DIR` as Fabricator was launched: where the shared folder is.
static INHERITED: OnceCell<Option<OsString>> = OnceCell::new();
/// Serializes registry reads and writes.
static LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Registry {
  /// A managed account's id; absent for the shared folder.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  active: Option<String>,
  #[serde(default)]
  accounts: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Entry {
  id: String,
  added_at: String,
}

impl Registry {
  fn has(&self, id: &str) -> bool {
    is_managed_id(id) && self.accounts.iter().any(|e| e.id == id)
  }

  /// The active account's id: the shared folder unless a known account is chosen.
  fn active_id(&self) -> String {
    self.active.clone().filter(|id| self.has(id)).unwrap_or_else(|| SHARED.to_string())
  }
}

/// Ids Fabricator generates (a UUID's 32 hex digits) — never a path.
fn is_managed_id(id: &str) -> bool {
  id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn registry_path() -> PathBuf {
  paths::data_dir().join("fabric-accounts.json")
}

fn accounts_root() -> PathBuf {
  paths::data_dir().join("fabric-accounts")
}

fn load() -> Registry {
  std::fs::read_to_string(registry_path())
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

fn save(registry: &Registry) -> Result<(), String> {
  let fail = |e: String| t!("services.fabricAccounts.saveFailed", error = e);
  let dir = paths::ensure_data_dir().map_err(|e| fail(e.to_string()))?;
  let body = serde_json::to_string_pretty(registry).map_err(|e| fail(e.to_string()))?;
  let tmp = dir.join("fabric-accounts.json.tmp");
  std::fs::write(&tmp, body).map_err(|e| fail(e.to_string()))?;
  std::fs::rename(&tmp, registry_path()).map_err(|e| fail(e.to_string()))
}

/// The shared folder: the `RAYFIN_CONFIG_DIR` Fabricator was launched with, else `~/.rayfin`.
pub fn shared_dir() -> PathBuf {
  match INHERITED.get().cloned().flatten() {
    Some(dir) if !dir.is_empty() => PathBuf::from(dir),
    _ => paths::home_dir().join(".rayfin"),
  }
}

/// Account `id`'s folder, when it's on this computer.
pub fn dir_of(id: &str) -> Option<PathBuf> {
  if id == SHARED {
    return Some(shared_dir());
  }
  let _guard = LOCK.lock().unwrap();
  load().has(id).then(|| accounts_root().join(id))
}

pub fn active_id() -> String {
  let _guard = LOCK.lock().unwrap();
  load().active_id()
}

/// Point every process started from now on at account `id`'s folder.
fn export(id: &str) {
  if id == SHARED {
    match INHERITED.get().cloned().flatten() {
      Some(dir) => std::env::set_var(CONFIG_DIR_ENV, dir),
      None => std::env::remove_var(CONFIG_DIR_ENV),
    }
  } else {
    std::env::set_var(CONFIG_DIR_ENV, accounts_root().join(id));
  }
}

/// Once at startup, before anything starts the Rayfin CLI or its helpers.
pub fn init() {
  let _ = INHERITED.set(std::env::var_os(CONFIG_DIR_ENV));
  export(&active_id());
}

/// Make account `id` the one Fabricator uses. Callers hold the Fabric auth
/// write lock, so no deploy or check is running with the old account.
pub fn activate(id: &str) -> Result<(), String> {
  let _guard = LOCK.lock().unwrap();
  let mut registry = load();
  if id != SHARED && !registry.has(id) {
    return Err(t!("services.fabricAccounts.gone"));
  }
  registry.active = (id != SHARED).then(|| id.to_string());
  save(&registry)?;
  export(id);
  Ok(())
}

/// A new, empty account folder (not active yet).
pub fn create() -> Result<String, String> {
  let id = uuid::Uuid::new_v4().simple().to_string();
  std::fs::create_dir_all(accounts_root().join(&id))
    .map_err(|e| t!("services.fabricAccounts.folderFailed", error = e))?;
  let _guard = LOCK.lock().unwrap();
  let mut registry = load();
  registry.accounts.push(Entry { id: id.clone(), added_at: chrono::Utc::now().to_rfc3339() });
  save(&registry)?;
  Ok(id)
}

/// Forget account `id` and delete its folder; when it was active, the shared
/// folder takes over. The shared folder itself is never deleted.
pub fn remove(id: &str) -> Result<(), String> {
  if !is_managed_id(id) {
    return Ok(());
  }
  {
    let _guard = LOCK.lock().unwrap();
    let mut registry = load();
    let was_active = registry.active_id() == id;
    registry.accounts.retain(|e| e.id != id);
    if was_active {
      registry.active = None;
    }
    save(&registry)?;
    if was_active {
      export(SHARED);
    }
  }
  let dir = accounts_root().join(id);
  if dir.exists() {
    std::fs::remove_dir_all(&dir).map_err(|e| t!("services.fabricAccounts.deleteFailed", error = e))?;
  }
  Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthState {
  identity_type: Option<String>,
  tenant_id: Option<String>,
  user_principal_name: Option<String>,
  user_name: Option<String>,
  client_id: Option<String>,
}

/// Who a folder is signed in as — `(user, tenant)` from the CLI's `auth.json` —
/// when it also holds tokens. `None` for a signed-out or empty folder.
pub fn identity(dir: &Path) -> Option<(String, Option<String>)> {
  let raw = std::fs::read_to_string(dir.join("auth.json")).ok()?;
  let state: AuthState = serde_json::from_str(&raw).ok()?;
  let service_principal = state.identity_type.as_deref() == Some("service_principal");
  let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
  let user = if service_principal {
    clean(state.client_id)
  } else {
    clean(state.user_principal_name).or_else(|| clean(state.user_name))
  }?;
  // A service principal signs in with the stored client credentials; a user
  // needs the token cache the CLI writes next to `auth.json`.
  let has_tokens = service_principal
    || std::fs::metadata(dir.join("cache.bin")).map(|m| m.len() > 0).unwrap_or(false);
  has_tokens.then(|| (user, clean(state.tenant_id)))
}

fn same_identity(a: &(String, Option<String>), b: &(String, Option<String>)) -> bool {
  let lower = |t: &Option<String>| t.as_deref().map(str::to_ascii_lowercase);
  a.0.eq_ignore_ascii_case(&b.0) && lower(&a.1) == lower(&b.1)
}

/// Every signed-in account, active first.
pub fn list() -> Vec<FabricAccount> {
  let (active, ids) = {
    let _guard = LOCK.lock().unwrap();
    let registry = load();
    let ids: Vec<String> = registry.accounts.iter().filter(|e| is_managed_id(&e.id)).map(|e| e.id.clone()).collect();
    (registry.active_id(), ids)
  };
  let folders = std::iter::once((SHARED.to_string(), shared_dir()))
    .chain(ids.into_iter().map(|id| { let dir = accounts_root().join(&id); (id, dir) }));
  let mut accounts: Vec<FabricAccount> = folders
    .filter_map(|(id, dir)| {
      let (user, tenant) = identity(&dir)?;
      Some(FabricAccount { active: id == active, shared: id == SHARED, id, user, tenant })
    })
    .collect();
  accounts.sort_by_key(|a| !a.active);
  accounts
}

/// Another folder signed in to the same account as `id`, if any.
pub fn duplicate_of(id: &str) -> Option<String> {
  let me = identity(&dir_of(id)?)?;
  list().into_iter().find(|a| a.id != id && same_identity(&me, &(a.user.clone(), a.tenant.clone()))).map(|a| a.id)
}

/// The account to use after `leaving` signs out: another signed-in account,
/// preferring the shared folder, else the (signed-out) shared folder.
pub fn successor(leaving: &str) -> String {
  let others: Vec<FabricAccount> = list().into_iter().filter(|a| a.id != leaving).collect();
  others
    .iter()
    .find(|a| a.shared)
    .or_else(|| others.first())
    .map(|a| a.id.clone())
    .unwrap_or_else(|| SHARED.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fabricator-fabric-accounts-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn only_generated_ids_name_account_folders() {
    assert!(is_managed_id(&uuid::Uuid::new_v4().simple().to_string()));
    for bad in ["", SHARED, "..", "../../etc", "0123456789abcdef0123456789abcde/", "g123456789abcdef0123456789abcdef"] {
      assert!(!is_managed_id(bad), "{bad:?}");
    }
  }

  #[test]
  fn the_active_account_falls_back_to_the_shared_folder() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut registry = Registry { active: Some(id.clone()), accounts: vec![] };
    assert_eq!(registry.active_id(), SHARED, "an unknown account is never active");
    registry.accounts.push(Entry { id: id.clone(), added_at: String::new() });
    assert_eq!(registry.active_id(), id);
    registry.active = Some("../escape".into());
    assert_eq!(registry.active_id(), SHARED);
  }

  #[test]
  fn a_folder_is_signed_in_only_with_an_identity_and_tokens() {
    let dir = temp_dir();
    assert_eq!(identity(&dir), None, "empty folder");

    let auth = r#"{"identityType":"user","tenantId":" contoso-tenant ","userPrincipalName":"alice@contoso.com","userName":"Alice"}"#;
    std::fs::write(dir.join("auth.json"), auth).unwrap();
    assert_eq!(identity(&dir), None, "no token cache: signed out");
    std::fs::write(dir.join("cache.bin"), "").unwrap();
    assert_eq!(identity(&dir), None, "an empty token cache is signed out too");
    std::fs::write(dir.join("cache.bin"), "{}").unwrap();
    assert_eq!(identity(&dir), Some(("alice@contoso.com".into(), Some("contoso-tenant".into()))));

    std::fs::write(dir.join("auth.json"), r#"{"identityType":"service_principal","tenantId":"t","clientId":"app-id"}"#).unwrap();
    std::fs::remove_file(dir.join("cache.bin")).unwrap();
    assert_eq!(identity(&dir), Some(("app-id".into(), Some("t".into()))), "service principals use stored credentials");

    std::fs::write(dir.join("auth.json"), "not json").unwrap();
    assert_eq!(identity(&dir), None);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn identities_match_regardless_of_case() {
    let a = ("Alice@Contoso.com".to_string(), Some("ABC".to_string()));
    assert!(same_identity(&a, &("alice@contoso.com".into(), Some("abc".into()))));
    assert!(!same_identity(&a, &("alice@contoso.com".into(), Some("other".into()))));
    assert!(!same_identity(&a, &("alice@contoso.com".into(), None)));
  }
}
