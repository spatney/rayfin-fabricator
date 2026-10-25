//! Guards the vendored, patched `wry` crate (see docs/VENDORED-WRY-PATCH.md).
//!
//! `[patch.crates-io] wry = { path = "vendor/wry" }` only takes effect while the vendored
//! crate has exactly the version Tauri asks for. When a Tauri bump moves that version,
//! Cargo merely warns that the patch was unused and builds the registry crate, silently
//! dropping Fabricator's changes. These tests fail instead.

const CARGO_LOCK: &str = include_str!("../Cargo.lock");
const VENDORED_MANIFEST: &str = include_str!("../vendor/wry/Cargo.toml");

/// Each local patch, the vendored source it changes, and code that must be there.
const PATCHES: &[(&str, &str, &[&str])] = &[
  (
    "0001-webview2-os-primary-account-sso.patch",
    include_str!("../vendor/wry/src/webview2/mod.rs"),
    &[
      "[rayfin-desktop local patch: webview2-sso]",
      "options.set_allow_single_sign_on_using_os_primary_account(true);",
    ],
  ),
  (
    "0002-macos-child-webview-titlebar-inset.patch",
    include_str!("../vendor/wry/src/wkwebview/mod.rs"),
    &[
      "[rayfin-desktop local patch: macos-titlebar-inset]",
      "let cl = win.contentLayoutRect();",
      "origin.y -= title_bar_inset;",
      "self.webview.window().filter(|_| !fills_window)",
    ],
  ),
];

const FIX: &str = "Re-vendor the wry version Tauri now asks for with \
  `node scripts/wry/vendor-wry.mjs update <version>` (docs/VENDORED-WRY-PATCH.md).";

/// The lines of each `[[table]]` entry in a Cargo.lock whose `name` is `name`.
fn lock_entries<'a>(lock: &'a str, table: &str, name: &str) -> Vec<Vec<&'a str>> {
  let header = format!("[[{table}]]");
  let mut entries: Vec<(bool, Vec<&str>)> = Vec::new();
  for line in lock.lines() {
    if line.starts_with('[') {
      entries.push((line.trim() == header, Vec::new()));
    } else if let Some((_, lines)) = entries.last_mut() {
      lines.push(line);
    }
  }
  entries
    .into_iter()
    .filter(|(in_table, lines)| *in_table && field(lines, "name") == Some(name))
    .map(|(_, lines)| lines)
    .collect()
}

fn field<'a>(lines: &[&'a str], key: &str) -> Option<&'a str> {
  lines.iter().find_map(|line| {
    let (k, v) = line.split_once('=')?;
    (k.trim() == key).then(|| v.trim().trim_matches('"'))
  })
}

fn manifest_version(manifest: &str) -> Option<&str> {
  let mut in_package = false;
  for line in manifest.lines() {
    if line.starts_with('[') {
      in_package = line.trim() == "[package]";
    } else if in_package {
      if let Some(version) = field(&[line], "version") {
        return Some(version);
      }
    }
  }
  None
}

/// `Err` explains why `lock` doesn't build the vendored wry described by `manifest`.
fn check_vendored_wry_is_built(lock: &str, manifest: &str) -> Result<(), String> {
  let vendored = manifest_version(manifest).ok_or("vendor/wry/Cargo.toml has no version")?;
  if !lock_entries(lock, "patch.unused", "wry").is_empty() {
    return Err(format!(
      "Cargo.lock lists the vendored wry {vendored} under [[patch.unused]], so the build uses \
       the unpatched registry wry. {FIX}"
    ));
  }
  let packages = lock_entries(lock, "package", "wry");
  let [wry] = packages.as_slice() else {
    return Err(format!("Cargo.lock has {} wry packages instead of one. {FIX}", packages.len()));
  };
  let version = field(wry, "version").unwrap_or("?");
  if let Some(source) = field(wry, "source") {
    return Err(format!(
      "Cargo.lock builds wry {version} from {source}, not src-tauri/vendor/wry. {FIX}"
    ));
  }
  if version != vendored {
    return Err(format!(
      "Cargo.lock has wry {version} but src-tauri/vendor/wry is {vendored}; run \
       `cargo update -p wry` in src-tauri."
    ));
  }
  Ok(())
}

#[test]
fn vendor_guard_cargo_builds_the_vendored_wry() {
  if let Err(problem) = check_vendored_wry_is_built(CARGO_LOCK, VENDORED_MANIFEST) {
    panic!("{problem}");
  }
}

#[test]
fn vendor_guard_catches_a_tauri_bump_that_outgrows_the_vendored_wry() {
  // Cargo.lock after a Tauri bump asks for a newer wry than the vendored copy: Cargo
  // builds the registry crate and records the path patch as unused.
  let lock = r#"
version = 4

[[package]]
name = "wry"
version = "0.57.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[patch.unused]]
name = "wry"
version = "0.55.1"
"#;
  let manifest = "[package]\nname = \"wry\"\nversion = \"0.55.1\"\n";
  let problem = check_vendored_wry_is_built(lock, manifest).unwrap_err();
  assert!(problem.contains("[[patch.unused]]"), "{problem}");

  let registry_only = lock.split("[[patch.unused]]").next().unwrap();
  let problem = check_vendored_wry_is_built(registry_only, manifest).unwrap_err();
  assert!(problem.contains("from registry+"), "{problem}");
}

#[test]
fn vendor_guard_every_local_patch_is_in_the_vendored_sources() {
  for (patch, source, required) in PATCHES {
    for code in *required {
      assert!(
        source.contains(code),
        "{patch} is not applied to src-tauri/vendor/wry (missing `{code}`). {FIX}"
      );
    }
  }
}
