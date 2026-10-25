//! API keys for the user's own model providers, kept in the operating system's
//! credential store: Windows Credential Manager or the macOS Keychain. Never in
//! Fabricator's settings file, and never sent back to the renderer.

use sha2::{Digest, Sha256};

const SERVICE: &str = "rayfin-fabricator";
/// The most a generic Windows credential can hold (`CRED_MAX_CREDENTIAL_BLOB_SIZE`).
const MAX_KEY_BYTES: usize = 5 * 512;

/// Where keys are kept, as people know it.
pub fn store_name() -> &'static str {
  if cfg!(windows) {
    "Windows Credential Manager"
  } else if cfg!(target_os = "macos") {
    "your Keychain"
  } else {
    "your system's credential store"
  }
}

/// Keys can be stored on this operating system.
pub fn supported() -> bool {
  cfg!(any(windows, target_os = "macos"))
}

/// Debug builds isolated with `FABRICATOR_DEV_DATA_DIR` keep their own keys, so
/// a test instance never reads or replaces the installed app's.
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

/// The Windows Credential Manager entry for a provider, e.g.
/// `rayfin-fabricator/api-key/anthropic`.
#[cfg_attr(not(windows), allow(dead_code))]
fn target_for(service: &str, provider: &str) -> String {
  format!("{service}/api-key/{provider}")
}

/// The saved key for `provider`, if there is one.
pub fn get(provider: &str) -> Result<Option<String>, String> {
  platform::get(&service(), provider)
}

/// Save `key` for `provider`, replacing any saved one.
pub fn set(provider: &str, key: &str) -> Result<(), String> {
  if key.len() > MAX_KEY_BYTES {
    return Err("That key is too long to save.".into());
  }
  platform::set(&service(), provider, key)
}

/// Delete the saved key for `provider` (nothing to do when there is none).
pub fn delete(provider: &str) -> Result<(), String> {
  platform::delete(&service(), provider)
}

#[cfg(windows)]
mod platform {
  use windows::core::{PCWSTR, PWSTR};
  use windows::Win32::Foundation::ERROR_NOT_FOUND;
  use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
  };

  fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
  }

  fn not_found(e: &windows::core::Error) -> bool {
    e.code() == ERROR_NOT_FOUND.to_hresult()
  }

  pub fn get(service: &str, provider: &str) -> Result<Option<String>, String> {
    let target = wide(&super::target_for(service, provider));
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
        String::from_utf8(bytes)
          .map(Some)
          .map_err(|_| "The saved key couldn't be read. Add it again.".to_string())
      }
      Err(e) if not_found(&e) => Ok(None),
      Err(e) => Err(format!("Couldn't read the key from Windows Credential Manager: {}", e.message())),
    }
  }

  pub fn set(service: &str, provider: &str, key: &str) -> Result<(), String> {
    let mut target = wide(&super::target_for(service, provider));
    let mut user = wide(provider);
    let mut comment = wide("API key Fabricator uses for this provider's models");
    let mut blob = key.as_bytes().to_vec();
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
    result.map_err(|e| format!("Couldn't save the key in Windows Credential Manager: {}", e.message()))
  }

  pub fn delete(service: &str, provider: &str) -> Result<(), String> {
    let target = wide(&super::target_for(service, provider));
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
      Ok(()) => Ok(()),
      Err(e) if not_found(&e) => Ok(()),
      Err(e) => Err(format!("Couldn't delete the key from Windows Credential Manager: {}", e.message())),
    }
  }
}

#[cfg(target_os = "macos")]
mod platform {
  use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

  /// `errSecItemNotFound`.
  const NOT_FOUND: i32 = -25300;

  pub fn get(service: &str, provider: &str) -> Result<Option<String>, String> {
    match get_generic_password(service, provider) {
      Ok(bytes) => String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "The saved key couldn't be read. Add it again.".to_string()),
      Err(e) if e.code() == NOT_FOUND => Ok(None),
      Err(e) => Err(format!("Couldn't read the key from your Keychain: {e}")),
    }
  }

  pub fn set(service: &str, provider: &str, key: &str) -> Result<(), String> {
    set_generic_password(service, provider, key.as_bytes())
      .map_err(|e| format!("Couldn't save the key in your Keychain: {e}"))
  }

  pub fn delete(service: &str, provider: &str) -> Result<(), String> {
    match delete_generic_password(service, provider) {
      Ok(()) => Ok(()),
      Err(e) if e.code() == NOT_FOUND => Ok(()),
      Err(e) => Err(format!("Couldn't delete the key from your Keychain: {e}")),
    }
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
  pub fn get(_service: &str, _provider: &str) -> Result<Option<String>, String> {
    Ok(None)
  }

  pub fn set(_service: &str, _provider: &str, _key: &str) -> Result<(), String> {
    Err("Saving API keys isn't supported on this operating system.".into())
  }

  pub fn delete(_service: &str, _provider: &str) -> Result<(), String> {
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn isolated_dev_instances_keep_their_own_keys() {
    assert_eq!(service_for(None), "rayfin-fabricator");
    let a = service_for(Some(r"C:\Temp\fab-a\data"));
    let b = service_for(Some(r"C:\Temp\fab-b\data"));
    assert!(a.starts_with("rayfin-fabricator-dev-") && a.len() == "rayfin-fabricator-dev-".len() + 8, "{a}");
    assert_ne!(a, b);
    assert_eq!(a, service_for(Some(r"C:\Temp\fab-a\data")));
    assert_eq!(target_for("rayfin-fabricator", "anthropic"), "rayfin-fabricator/api-key/anthropic");
  }

  /// Round-trips a key through the real credential store. Run by hand:
  /// `cargo test --lib keychain -- --ignored`.
  #[test]
  #[ignore]
  fn round_trips_through_the_os_credential_store() {
    let service = service_for(Some("byok-keychain-self-test"));
    let provider = "selftest";
    let _ = platform::delete(&service, provider);
    assert_eq!(platform::get(&service, provider).unwrap(), None);
    platform::set(&service, provider, "sk-test-123").unwrap();
    assert_eq!(platform::get(&service, provider).unwrap().as_deref(), Some("sk-test-123"));
    platform::set(&service, provider, "sk-test-456").unwrap();
    assert_eq!(platform::get(&service, provider).unwrap().as_deref(), Some("sk-test-456"));
    platform::delete(&service, provider).unwrap();
    platform::delete(&service, provider).unwrap();
    assert_eq!(platform::get(&service, provider).unwrap(), None);
  }
}
