//! One system dialog that picks files and folders together, for adding them to
//! a chat message. The dialogs Tauri offers pick one kind or the other.
//!
//! On Windows it's the system's file dialog: **Add** adds the selected files,
//! and **Add folder** adds the selected folders, or the folder that's open when
//! none is selected. On macOS the open panel picks either. Elsewhere it picks
//! files only.

use std::path::PathBuf;

use tauri::AppHandle;

/// What the user picked, or nothing when they closed the dialog.
pub async fn pick_files_and_folders(app: &AppHandle, title: &str) -> Vec<PathBuf> {
  imp::pick(app, title).await
}

#[cfg(windows)]
mod imp {
  use std::path::PathBuf;
  use std::sync::{Arc, Mutex};

  use tauri::{AppHandle, Manager};
  use windows::core::{implement, w, Interface, Ref, Result, BOOL, HRESULT, HSTRING};
  use windows::Win32::Foundation::{E_NOTIMPL, ERROR_CANCELLED, HWND, S_OK};
  use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
  };
  use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileDialog, IFileDialogControlEvents, IFileDialogControlEvents_Impl, IFileDialogCustomize,
    IFileDialogEvents, IFileDialogEvents_Impl, IFileOpenDialog, IShellItem, IShellItemArray, FDE_OVERWRITE_RESPONSE,
    FDE_SHAREVIOLATION_RESPONSE, FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST,
    SIGDN_FILESYSPATH,
  };

  /// The **Add folder** button.
  const ADD_FOLDER: u32 = 1;

  type Folders = Arc<Mutex<Option<Vec<PathBuf>>>>;

  pub async fn pick(app: &AppHandle, title: &str) -> Vec<PathBuf> {
    let owner = app.get_webview_window("main").and_then(|window| window.hwnd().ok()).map(|hwnd| hwnd.0 as isize);
    let title = title.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // The dialog runs on a thread of its own, in a single-threaded COM apartment.
    std::thread::spawn(move || {
      let owner = owner.map(|hwnd| HWND(hwnd as *mut core::ffi::c_void));
      let picked = show(owner, &title).unwrap_or_else(|error| {
        log::warn!("Couldn't show the dialog for adding files and folders: {error}");
        Vec::new()
      });
      let _ = tx.send(picked);
    });
    rx.await.unwrap_or_default()
  }

  fn show(owner: Option<HWND>, title: &str) -> Result<Vec<PathBuf>> {
    unsafe {
      CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
      let picked = run(owner, title);
      CoUninitialize();
      picked
    }
  }

  fn run(owner: Option<HWND>, title: &str) -> Result<Vec<PathBuf>> {
    unsafe {
      let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
      dialog.SetOptions(
        dialog.GetOptions()? | FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST,
      )?;
      dialog.SetTitle(&HSTRING::from(title))?;
      dialog.SetOkButtonLabel(w!("Add"))?;
      dialog.cast::<IFileDialogCustomize>()?.AddPushButton(ADD_FOLDER, w!("Add folder"))?;

      let folders: Folders = Arc::default();
      let events: IFileDialogEvents = Events { folders: folders.clone() }.into();
      let cookie = dialog.Advise(&events)?;
      let shown = dialog.Show(owner);
      let _ = dialog.Unadvise(cookie);

      if let Some(folders) = folders.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        return Ok(folders);
      }
      match shown {
        Ok(()) => Ok(paths(&dialog.GetResults()?)),
        Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(Vec::new()),
        Err(error) => Err(error),
      }
    }
  }

  /// The file-system paths of `items`; any without one are left out.
  fn paths(items: &IShellItemArray) -> Vec<PathBuf> {
    let count = unsafe { items.GetCount() }.unwrap_or(0);
    (0..count).filter_map(|i| unsafe { items.GetItemAt(i) }.ok()).filter_map(|item| path(&item)).collect()
  }

  fn path(item: &IShellItem) -> Option<PathBuf> {
    unsafe {
      let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
      let text = String::from_utf16_lossy(name.as_wide());
      CoTaskMemFree(Some(name.0 as *const core::ffi::c_void));
      Some(PathBuf::from(text))
    }
  }

  /// Listens for **Add folder**: it picks the selected folders, or the open one.
  #[implement(IFileDialogEvents, IFileDialogControlEvents)]
  struct Events {
    folders: Folders,
  }

  impl IFileDialogEvents_Impl for Events_Impl {
    fn OnFileOk(&self, _: Ref<IFileDialog>) -> Result<()> {
      Ok(())
    }

    fn OnFolderChanging(&self, _: Ref<IFileDialog>, _: Ref<IShellItem>) -> Result<()> {
      Ok(())
    }

    fn OnFolderChange(&self, _: Ref<IFileDialog>) -> Result<()> {
      Ok(())
    }

    fn OnSelectionChange(&self, _: Ref<IFileDialog>) -> Result<()> {
      Ok(())
    }

    fn OnShareViolation(&self, _: Ref<IFileDialog>, _: Ref<IShellItem>) -> Result<FDE_SHAREVIOLATION_RESPONSE> {
      Err(E_NOTIMPL.into())
    }

    fn OnTypeChange(&self, _: Ref<IFileDialog>) -> Result<()> {
      Ok(())
    }

    fn OnOverwrite(&self, _: Ref<IFileDialog>, _: Ref<IShellItem>) -> Result<FDE_OVERWRITE_RESPONSE> {
      Err(E_NOTIMPL.into())
    }
  }

  impl IFileDialogControlEvents_Impl for Events_Impl {
    fn OnItemSelected(&self, _: Ref<IFileDialogCustomize>, _: u32, _: u32) -> Result<()> {
      Ok(())
    }

    fn OnButtonClicked(&self, customize: Ref<IFileDialogCustomize>, control: u32) -> Result<()> {
      if control != ADD_FOLDER {
        return Ok(());
      }
      let dialog: IFileOpenDialog = customize.ok()?.cast()?;
      let selected = unsafe { dialog.GetSelectedItems() }.map(|items| paths(&items)).unwrap_or_default();
      let mut folders: Vec<PathBuf> = selected.into_iter().filter(|path| path.is_dir()).collect();
      if folders.is_empty() {
        folders.extend(unsafe { dialog.GetFolder() }.ok().and_then(|folder| path(&folder)));
      }
      // A place that isn't a folder on disk, such as This PC: nothing to add yet.
      if folders.is_empty() {
        return Ok(());
      }
      *self.folders.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(folders);
      unsafe { dialog.Close(S_OK) }
    }

    fn OnCheckButtonToggled(&self, _: Ref<IFileDialogCustomize>, _: u32, _: BOOL) -> Result<()> {
      Ok(())
    }

    fn OnControlActivating(&self, _: Ref<IFileDialogCustomize>, _: u32) -> Result<()> {
      Ok(())
    }
  }
}

#[cfg(target_os = "macos")]
mod imp {
  use std::path::PathBuf;

  use objc2::MainThreadMarker;
  use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
  use objc2_foundation::NSString;
  use tauri::AppHandle;

  pub async fn pick(app: &AppHandle, title: &str) -> Vec<PathBuf> {
    let title = title.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let shown = app.run_on_main_thread(move || {
      let _ = tx.send(MainThreadMarker::new().map(|mtm| show(mtm, &title)).unwrap_or_default());
    });
    if shown.is_err() {
      return Vec::new();
    }
    rx.await.unwrap_or_default()
  }

  fn show(mtm: MainThreadMarker, title: &str) -> Vec<PathBuf> {
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(true);
    panel.setMessage(Some(&NSString::from_str(title)));
    panel.setPrompt(Some(&NSString::from_str("Add")));
    if panel.runModal() != NSModalResponseOK {
      return Vec::new();
    }
    panel.URLs().iter().filter_map(|url| url.path()).map(|path| PathBuf::from(path.to_string())).collect()
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
  use std::path::PathBuf;

  use tauri::AppHandle;
  use tauri_plugin_dialog::DialogExt;

  pub async fn pick(app: &AppHandle, title: &str) -> Vec<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_files(move |picked| {
      let _ = tx.send(picked);
    });
    rx.await.ok().flatten().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
  }
}
