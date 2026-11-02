//! An installed app's place on Windows: its own taskbar button and a Start menu
//! shortcut (in the Start menu's "Rayfin apps" folder, which uninstalling
//! Fabricator removes). Both carry the app's AppUserModelID, so the taskbar
//! groups its window apart from Fabricator's, under the app's icon, and pinning
//! either one opens the app (`Fabricator --app <key>`). Other systems have neither.

use std::path::{Path, PathBuf};

use super::Record;
#[cfg(windows)]
use super::{APP_FLAG, ICON_ICO};

/// The Start menu folder of installed apps' shortcuts. Keep in step with
/// `windows/installer-hooks.nsh`, which removes it with Fabricator.
#[cfg(any(windows, test))]
const START_MENU_FOLDER: &str = "Rayfin apps";

/// The app's AppUserModelID.
#[cfg(any(windows, test))]
fn app_id(key: &str) -> String {
  format!("RayfinFabricator.App.{key}")
}

/// The app's name as a file name: without what Windows doesn't allow in one.
#[cfg(any(windows, test))]
fn shortcut_name(name: &str) -> String {
  let allowed: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c }).collect();
  let words = allowed.split_whitespace().collect::<Vec<_>>().join(" ");
  let trimmed: String = words.trim_matches(|c: char| c == '.' || c == ' ').chars().take(80).collect();
  let trimmed = trimmed.trim_end_matches(['.', ' ']).to_string();
  if trimmed.is_empty() { "Rayfin app".into() } else { trimmed }
}

/// The file names an app's shortcut can have, best first: its name, then with
/// who it's from, then numbered, for two apps of the same name.
#[cfg(any(windows, test))]
fn shortcut_files(name: &str, from: Option<&str>) -> Vec<String> {
  let name = shortcut_name(name);
  let mut files = vec![format!("{name}.lnk")];
  if let Some(who) = from.and_then(|f| f.split('@').next()).map(shortcut_name).filter(|w| w != "Rayfin app") {
    files.push(format!("{name} ({who}).lnk"));
  }
  files.extend((2..10).map(|n| format!("{name} ({n}).lnk")));
  files
}

/// The current user's Start menu folder of installed apps.
fn start_menu_folder() -> Option<PathBuf> {
  #[cfg(windows)]
  {
    dirs::data_dir()
      .map(|dir| dir.join("Microsoft").join("Windows").join("Start Menu").join("Programs").join(START_MENU_FOLDER))
  }
  #[cfg(not(windows))]
  {
    None
  }
}

/// Whether to add apps to the Start menu: an installed Fabricator, whose
/// shortcuts stay valid; a development build only with `FABRICATOR_DEV_SHORTCUTS`.
#[cfg(windows)]
fn makes_shortcuts() -> bool {
  !cfg!(debug_assertions) || std::env::var_os("FABRICATOR_DEV_SHORTCUTS").is_some()
}

/// Give the app its Start menu shortcut, or bring it up to date, and record where it is.
pub(super) async fn ensure_shortcut(record: Record) -> Record {
  #[cfg(windows)]
  {
    if !makes_shortcuts() {
      return record;
    }
    let fallback = record.clone();
    tokio::task::spawn_blocking(move || shortcut_for(record)).await.unwrap_or(fallback)
  }
  #[cfg(not(windows))]
  {
    record
  }
}

/// Remove an app's shortcut: only a `.lnk` in the installed apps' Start menu
/// folder, which goes too once it's empty.
pub(super) fn remove_shortcut(path: &Path) {
  let link = path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"));
  let Some(folder) = start_menu_folder().filter(|folder| link && path.parent() == Some(folder.as_path())) else {
    return;
  };
  let _ = std::fs::remove_file(path);
  let _ = std::fs::remove_dir(folder);
}

#[cfg(windows)]
fn shortcut_for(mut record: Record) -> Record {
  let (Some(folder), Ok(exe)) = (start_menu_folder(), std::env::current_exe()) else {
    return record;
  };
  if let Err(error) = std::fs::create_dir_all(&folder) {
    log::warn!("[apps] couldn't create {}: {error}", folder.display());
    return record;
  }
  let mine = record.shortcut.as_ref().map(PathBuf::from);
  // Its own name, unless another app has it.
  let Some(path) = shortcut_files(&record.name, record.from.as_deref())
    .into_iter()
    .map(|file| folder.join(file))
    .find(|path| !path.exists() || mine.as_deref() == Some(path.as_path()))
  else {
    return record;
  };
  if let Some(old) = mine.filter(|old| *old != path) {
    remove_shortcut(&old);
  }
  let icon = super::app_dir(&record.key).join(ICON_ICO);
  let description = match &record.from {
    Some(from) => format!("A Rayfin app from {from}"),
    None => "A Rayfin app".to_string(),
  };
  let args = format!("{APP_FLAG} {}", record.key);
  match imp::create_shortcut(&path, &exe, &args, icon.is_file().then_some(icon.as_path()), &description, &app_id(&record.key)) {
    Ok(()) => record.shortcut = Some(path.to_string_lossy().to_string()),
    Err(error) => log::warn!("[apps] couldn't add {} to the Start menu: {error}", record.name),
  }
  record
}

/// Give the app's window its own taskbar button, under the app's icon, which
/// opens the app again when it's pinned. On the window's own thread, before it shows.
#[cfg(windows)]
pub(super) fn identify(window: &tauri::WebviewWindow, key: &str, name: &str) {
  let Ok(exe) = std::env::current_exe() else { return };
  let icon = super::app_dir(key).join(ICON_ICO);
  let icon = icon.is_file().then_some(icon);
  let relaunch = format!("\"{}\" {APP_FLAG} {key}", exe.display());
  let (id, name, target) = (app_id(key), name.to_string(), window.clone());
  let _ = window.run_on_main_thread(move || {
    let Ok(hwnd) = target.hwnd() else { return };
    if let Err(error) = imp::set_window_identity(hwnd, &id, &relaunch, &name, icon.as_deref()) {
      log::warn!("[apps] couldn't give {name}'s window its own taskbar button: {error}");
    }
  });
}

#[cfg(windows)]
mod imp {
  use std::path::Path;

  use windows::core::{Interface, Result, HSTRING, PCWSTR};
  use windows::Win32::Foundation::{HWND, PROPERTYKEY};
  use windows::Win32::Storage::EnhancedStorage::{
    PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand, PKEY_AppUserModel_RelaunchDisplayNameResource,
    PKEY_AppUserModel_RelaunchIconResource,
  };
  use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
  use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
  };
  use windows::Win32::System::Variant::VT_LPWSTR;
  use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
  use windows::Win32::UI::Shell::{IShellLinkW, SHStrDupW, ShellLink};

  /// Set a string property: a `VT_LPWSTR`, which the store copies.
  fn set_text(store: &IPropertyStore, key: &PROPERTYKEY, text: &str) -> Result<()> {
    unsafe {
      let copy = SHStrDupW(&HSTRING::from(text))?;
      let mut value = PROPVARIANT::default();
      (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
      (*value.Anonymous.Anonymous).Anonymous.pwszVal = copy;
      let set = store.SetValue(key, &value);
      let _ = PropVariantClear(&mut value);
      set
    }
  }

  pub fn set_window_identity(hwnd: HWND, id: &str, relaunch: &str, name: &str, icon: Option<&Path>) -> Result<()> {
    unsafe {
      let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd)?;
      set_text(&store, &PKEY_AppUserModel_ID, id)?;
      set_text(&store, &PKEY_AppUserModel_RelaunchCommand, relaunch)?;
      set_text(&store, &PKEY_AppUserModel_RelaunchDisplayNameResource, name)?;
      if let Some(icon) = icon {
        set_text(&store, &PKEY_AppUserModel_RelaunchIconResource, &format!("{},0", icon.display()))?;
      }
      store.Commit()
    }
  }

  pub fn create_shortcut(at: &Path, exe: &Path, args: &str, icon: Option<&Path>, description: &str, id: &str) -> Result<()> {
    unsafe {
      let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
      let made = (|| {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(exe))?;
        link.SetArguments(&HSTRING::from(args))?;
        link.SetDescription(&HSTRING::from(description))?;
        if let Some(icon) = icon {
          link.SetIconLocation(&HSTRING::from(icon), 0)?;
        }
        let store: IPropertyStore = link.cast()?;
        set_text(&store, &PKEY_AppUserModel_ID, id)?;
        store.Commit()?;
        let file: IPersistFile = link.cast()?;
        file.Save(PCWSTR(HSTRING::from(at).as_ptr()), true)
      })();
      if init.is_ok() {
        CoUninitialize();
      }
      made
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn shortcuts_are_named_after_the_app() {
    assert_eq!(shortcut_name("Recipe Book"), "Recipe Book");
    assert_eq!(shortcut_name("Sales: Q3/Q4 <draft>?"), "Sales Q3 Q4 draft");
    assert_eq!(shortcut_name("  ..Notes..  "), "Notes");
    assert_eq!(shortcut_name("***"), "Rayfin app");
    assert_eq!(shortcut_name(&"x".repeat(200)).len(), 80);
    assert_eq!(app_id("notes-1a2b3c4d"), "RayfinFabricator.App.notes-1a2b3c4d");
    let files = shortcut_files("Notes", Some("amy@contoso.com"));
    assert_eq!(&files[..3], ["Notes.lnk", "Notes (amy).lnk", "Notes (2).lnk"]);
    assert_eq!(shortcut_files("Notes", None)[1], "Notes (2).lnk");
    assert_eq!(START_MENU_FOLDER, "Rayfin apps");
  }

  /// A shortcut Fabricator makes opens the app, under its AppUserModelID.
  #[cfg(windows)]
  #[test]
  fn a_shortcut_carries_the_apps_identity() {
    use windows::core::Interface;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let dir = std::env::temp_dir().join(format!("fab-apps-lnk-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let at = dir.join("Notes.lnk");
    let exe = std::env::current_exe().unwrap();
    imp::create_shortcut(&at, &exe, "--app notes-1a2b3c4d", None, "A Rayfin app", "RayfinFabricator.App.notes-1a2b3c4d").unwrap();
    assert!(at.is_file());
    unsafe {
      let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
      let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
      link.cast::<IPersistFile>().unwrap().Load(&windows::core::HSTRING::from(at.as_path()), STGM_READ).unwrap();
      let mut args = [0u16; 260];
      link.GetArguments(&mut args).unwrap();
      let args = String::from_utf16_lossy(&args[..args.iter().position(|c| *c == 0).unwrap()]);
      assert_eq!(args, "--app notes-1a2b3c4d");
      let value = link.cast::<IPropertyStore>().unwrap().GetValue(&PKEY_AppUserModel_ID).unwrap();
      let id = value.Anonymous.Anonymous.Anonymous.pwszVal.to_string().unwrap();
      assert_eq!(id, "RayfinFabricator.App.notes-1a2b3c4d");
    }
    let _ = std::fs::remove_dir_all(&dir);
  }
}
