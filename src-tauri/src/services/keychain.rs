//! Secrets Fabricator keeps in the operating system's credential store: Windows
//! Credential Manager or the macOS Keychain. Never in Fabricator's settings
//! file, and never sent back to the renderer. They are the API keys of the
//! user's own model providers, and the values of the environment variables and
//! headers of the MCP servers they add.

use sha2::{Digest, Sha256};

const SERVICE: &str = "rayfin-fabricator";
/// The most a generic Windows credential can hold (`CRED_MAX_CREDENTIAL_BLOB_SIZE`).
const MAX_SECRET_BYTES: usize = 5 * 512;

/// Something kept in the credential store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item<'a> {
  /// A model provider's API key, by provider id.
  ApiKey(&'a str),
  /// The values of an MCP server's environment variables or headers, by server id.
  McpServer(&'a str),
}

impl Item<'_> {
  /// Its account in the credential store: the provider for an API key (as it
  /// always was), `mcp/<id>` for an MCP server.
  #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
  fn account(self) -> String {
    match self {
      Item::ApiKey(provider) => provider.to_string(),
      Item::McpServer(id) => format!("mcp/{id}"),
    }
  }

  /// Its Windows Credential Manager entry, e.g. `rayfin-fabricator/api-key/anthropic`.
  #[cfg_attr(not(windows), allow(dead_code))]
  fn target(self, service: &str) -> String {
    match self {
      Item::ApiKey(provider) => format!("{service}/api-key/{provider}"),
      Item::McpServer(id) => format!("{service}/mcp/{id}"),
    }
  }

  /// What it is, in messages.
  fn what(self) -> &'static str {
    match self {
      Item::ApiKey(_) => "the key",
      Item::McpServer(_) => "the server's values",
    }
  }

  /// What it's for, in the credential's comment.
  #[cfg_attr(not(windows), allow(dead_code))]
  fn comment(self) -> &'static str {
    match self {
      Item::ApiKey(_) => "API key Fabricator uses for this provider's models",
      Item::McpServer(_) => "Values Fabricator gives this MCP server",
    }
  }

  /// What to do when it can't be read.
  fn unreadable(self) -> &'static str {
    match self {
      Item::ApiKey(_) => "The saved key couldn't be read. Add it again.",
      Item::McpServer(_) => "The server's saved values couldn't be read. Enter them again.",
    }
  }
}

/// Where secrets are kept, as people know it.
pub fn store_name() -> &'static str {
  if cfg!(windows) {
    "Windows Credential Manager"
  } else if cfg!(target_os = "macos") {
    "your Keychain"
  } else {
    "your system's credential store"
  }
}

/// Secrets can be stored on this operating system.
pub fn supported() -> bool {
  cfg!(any(windows, target_os = "macos"))
}

/// Debug builds isolated with `FABRICATOR_DEV_DATA_DIR` keep their own secrets,
/// so a test instance never reads or replaces the installed app's.
fn dev_data_dir() -> Option<String> {
  #[cfg(debug_assertions)]
  {
    std::env::var("FABRICATOR_DEV_DATA_DIR").ok().filter(|v| !v.trim().is_empty())
  }
  #[cfg(not(debug_assertions))]
  {
    None
  }
}

/// The credential store's service name for `dev_dir` (see [`dev_data_dir`]).
fn service_for(dev_dir: Option<&str>) -> String {
  match dev_dir {
    Some(dir) => {
      let hash = Sha256::digest(dir.as_bytes());
      format!("{SERVICE}-dev-{}", hex::encode(&hash[..4]))
    }
    None => SERVICE.to_string(),
  }
}

fn service() -> String {
  service_for(dev_data_dir().as_deref())
}

/// The saved key for `provider`, if there is one.
pub fn get(provider: &str) -> Result<Option<String>, String> {
  read(Item::ApiKey(provider))
}

/// Save `key` for `provider`, replacing any saved one.
pub fn set(provider: &str, key: &str) -> Result<(), String> {
  write(Item::ApiKey(provider), key)
}

/// Delete the saved key for `provider` (nothing to do when there is none).
pub fn delete(provider: &str) -> Result<(), String> {
  remove(Item::ApiKey(provider))
}

/// What's saved for `item`, if anything.
pub fn read(item: Item<'_>) -> Result<Option<String>, String> {
  platform::get(&service(), item)
}

/// Save `secret` for `item`, replacing anything saved.
pub fn write(item: Item<'_>, secret: &str) -> Result<(), String> {
  if secret.len() > MAX_SECRET_BYTES {
    return Err(match item {
      Item::ApiKey(_) => "That key is too long to save.".into(),
      Item::McpServer(_) => "Those values are too long to save. Shorten them, or give the server fewer of them.".into(),
    });
  }
  platform::set(&service(), item, secret)
}

/// Delete what's saved for `item` (nothing to do when there is nothing).
pub fn remove(item: Item<'_>) -> Result<(), String> {
  platform::delete(&service(), item)
}

#[cfg(windows)]
mod platform {
  use windows::core::{PCWSTR, PWSTR};
  use windows::Win32::Foundation::ERROR_NOT_FOUND;
  use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
  };

  use super::Item;

  fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
  }

  fn not_found(e: &windows::core::Error) -> bool {
    e.code() == ERROR_NOT_FOUND.to_hresult()
  }

  pub fn get(service: &str, item: Item<'_>) -> Result<Option<String>, String> {
    let target = wide(&item.target(service));
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    match unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred) } {
      Ok(()) => {
        // SAFETY: CredReadW succeeded, so `cred` points at a CREDENTIALW the
        // system allocated; it is read once, then released with CredFree.
        let bytes = unsafe {
          let c = &*cred;
          let blob = if c.CredentialBlob.is_null() {
            Vec::new()
          } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
          };
          CredFree(cred as *const core::ffi::c_void);
          blob
        };
        String::from_utf8(bytes).map(Some).map_err(|_| item.unreadable().to_string())
      }
      Err(e) if not_found(&e) => Ok(None),
      Err(e) => Err(format!("Couldn't read {} from Windows Credential Manager: {}", item.what(), e.message())),
    }
  }

  pub fn set(service: &str, item: Item<'_>, secret: &str) -> Result<(), String> {
    let mut target = wide(&item.target(service));
    let mut user = wide(match item {
      Item::ApiKey(provider) | Item::McpServer(provider) => provider,
    });
    let mut comment = wide(item.comment());
    let mut blob = secret.as_bytes().to_vec();
    let cred = CREDENTIALW {
      Type: CRED_TYPE_GENERIC,
      TargetName: PWSTR(target.as_mut_ptr()),
      Comment: PWSTR(comment.as_mut_ptr()),
      CredentialBlobSize: blob.len() as u32,
      CredentialBlob: blob.as_mut_ptr(),
      Persist: CRED_PERSIST_LOCAL_MACHINE,
      UserName: PWSTR(user.as_mut_ptr()),
      ..Default::default()
    };
    // SAFETY: every pointer in `cred` refers to a buffer that outlives the call.
    let result = unsafe { CredWriteW(&cred, 0) };
    blob.fill(0);
    result.map_err(|e| format!("Couldn't save {} in Windows Credential Manager: {}", item.what(), e.message()))
  }

  pub fn delete(service: &str, item: Item<'_>) -> Result<(), String> {
    let target = wide(&item.target(service));
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
      Ok(()) => Ok(()),
      Err(e) if not_found(&e) => Ok(()),
      Err(e) => Err(format!("Couldn't delete {} from Windows Credential Manager: {}", item.what(), e.message())),
    }
  }
}

#[cfg(target_os = "macos")]
mod platform {
  use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

  use super::Item;

  /// `errSecItemNotFound`.
  const NOT_FOUND: i32 = -25300;

  pub fn get(service: &str, item: Item<'_>) -> Result<Option<String>, String> {
    match get_generic_password(service, &item.account()) {
      Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| item.unreadable().to_string()),
      Err(e) if e.code() == NOT_FOUND => Ok(None),
      Err(e) => Err(format!("Couldn't read {} from your Keychain: {e}", item.what())),
    }
  }

  pub fn set(service: &str, item: Item<'_>, secret: &str) -> Result<(), String> {
    set_generic_password(service, &item.account(), secret.as_bytes())
      .map_err(|e| format!("Couldn't save {} in your Keychain: {e}", item.what()))
  }

  pub fn delete(service: &str, item: Item<'_>) -> Result<(), String> {
    match delete_generic_password(service, &item.account()) {
      Ok(()) => Ok(()),
      Err(e) if e.code() == NOT_FOUND => Ok(()),
      Err(e) => Err(format!("Couldn't delete {} from your Keychain: {e}", item.what())),
    }
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
  use super::Item;

  pub fn get(_service: &str, _item: Item<'_>) -> Result<Option<String>, String> {
    Ok(None)
  }

  pub fn set(_service: &str, item: Item<'_>, _secret: &str) -> Result<(), String> {
    Err(match item {
      Item::ApiKey(_) => "Saving API keys isn't supported on this operating system.".into(),
      Item::McpServer(_) => "Saving an MCP server's values isn't supported on this operating system.".into(),
    })
  }

  pub fn delete(_service: &str, _item: Item<'_>) -> Result<(), String> {
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn isolated_dev_instances_keep_their_own_secrets() {
    assert_eq!(service_for(None), "rayfin-fabricator");
    let a = service_for(Some(r"C:\Temp\fab-a\data"));
    let b = service_for(Some(r"C:\Temp\fab-b\data"));
    assert!(a.starts_with("rayfin-fabricator-dev-") && a.len() == "rayfin-fabricator-dev-".len() + 8, "{a}");
    assert_ne!(a, b);
    assert_eq!(a, service_for(Some(r"C:\Temp\fab-a\data")));
  }

  #[test]
  fn api_keys_keep_their_entries_and_mcp_servers_get_their_own() {
    assert_eq!(Item::ApiKey("anthropic").target("rayfin-fabricator"), "rayfin-fabricator/api-key/anthropic");
    assert_eq!(Item::ApiKey("anthropic").account(), "anthropic");
    assert_eq!(Item::McpServer("chart").target("rayfin-fabricator"), "rayfin-fabricator/mcp/chart");
    assert_eq!(Item::McpServer("chart").account(), "mcp/chart");
  }

  /// Round-trips secrets through the real credential store. Run by hand:
  /// `cargo test --lib keychain -- --ignored`.
  #[test]
  #[ignore]
  fn round_trips_through_the_os_credential_store() {
    let service = service_for(Some("byok-keychain-self-test"));
    for item in [Item::ApiKey("selftest"), Item::McpServer("selftest")] {
      let _ = platform::delete(&service, item);
      assert_eq!(platform::get(&service, item).unwrap(), None);
      platform::set(&service, item, "sk-test-123").unwrap();
      assert_eq!(platform::get(&service, item).unwrap().as_deref(), Some("sk-test-123"));
      platform::set(&service, item, "sk-test-456").unwrap();
      assert_eq!(platform::get(&service, item).unwrap().as_deref(), Some("sk-test-456"));
    }
    // An API key and an MCP server with the same name are separate entries.
    platform::delete(&service, Item::ApiKey("selftest")).unwrap();
    assert_eq!(platform::get(&service, Item::McpServer("selftest")).unwrap().as_deref(), Some("sk-test-456"));
    platform::delete(&service, Item::McpServer("selftest")).unwrap();
    platform::delete(&service, Item::McpServer("selftest")).unwrap();
    assert_eq!(platform::get(&service, Item::McpServer("selftest")).unwrap(), None);
  }
}
