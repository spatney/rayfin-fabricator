//! Fabricator's core in the user's language. The text the core shows (errors,
//! progress, the titles of the dialogs it opens) comes from catalogs in
//! `locales/<language>/<area>.json`, as the renderer's comes from its own:
//! English is the source, and a text a translation hasn't got reads in English.
//!
//! Write `t!("area.key")` for a text, with a value for each placeholder:
//! `t!("area.key", name = value)`. Catalog text names a value as `{{name}}`, as
//! in the renderer's catalogs. A `count` picks the plural form: `t!("area.files",
//! count = n)` reads `area.files_one` or `area.files_other`. A key starts with
//! its catalog's area: `team`, `commands`, `assist` or `services`.
//!
//! Only what people read is translated: never text for Copilot, logs,
//! telemetry, or what goes into projects, repositories and commits.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::RwLock;

use once_cell::sync::Lazy;
use serde_json::Value;

/// The languages Fabricator comes in, English (the source) first. The renderer
/// lists the same ones (`LANGUAGES` in src/renderer/src/i18n/languages.ts).
pub const LANGUAGES: [&str; 4] = ["en", "es", "de", "ja"];

/// The parts of the core with a catalog of their own (`locales/<language>/<area>.json`):
/// Team, the other commands, the ones where Copilot assists (Help, the security review,
/// the Advisor's deep review), and the services. A key starts with its area.
const AREAS: [&str; 4] = ["team", "commands", "assist", "services"];

/// An area's catalog in each language, in the order of `LANGUAGES`.
macro_rules! area {
  ($area:literal) => {
    [
      ("en", $area, include_str!(concat!("../locales/en/", $area, ".json"))),
      ("es", $area, include_str!(concat!("../locales/es/", $area, ".json"))),
      ("de", $area, include_str!(concat!("../locales/de/", $area, ".json"))),
      ("ja", $area, include_str!(concat!("../locales/ja/", $area, ".json"))),
    ]
  };
}

/// Each catalog: its language, its area, and its JSON. One row for each of `AREAS`.
const SOURCES: [[(&str, &str, &str); LANGUAGES.len()]; AREAS.len()] =
  [area!("team"), area!("commands"), area!("assist"), area!("services")];

type Texts = HashMap<String, String>;

/// Each language's texts, by key (`area.dotted.path`).
static CATALOGS: Lazy<HashMap<&'static str, Texts>> = Lazy::new(|| {
  let mut catalogs: HashMap<&'static str, Texts> = HashMap::new();
  for (language, area, source) in SOURCES.iter().flatten() {
    let texts = catalogs.entry(*language).or_default();
    match serde_json::from_str::<Value>(source) {
      Ok(catalog) => flatten(area, &catalog, texts),
      Err(e) => log::error!("couldn't read the {language} {area} catalog: {e}"),
    }
  }
  catalogs
});

fn flatten(prefix: &str, value: &Value, out: &mut Texts) {
  match value {
    Value::Object(entries) => {
      for (key, value) in entries {
        flatten(&format!("{prefix}.{key}"), value, out);
      }
    }
    Value::String(text) => {
      out.insert(prefix.to_string(), text.clone());
    }
    _ => {}
  }
}

static LANGUAGE: RwLock<&'static str> = RwLock::new("en");

/// The language the core's text is in.
pub fn language() -> &'static str {
  *LANGUAGE.read().unwrap_or_else(|e| e.into_inner())
}

/// Show the core's text in the language a preference asks for: one Fabricator
/// comes in, or the computer's for "system" or none.
pub fn set_preference(preference: Option<&str>) {
  let language = preference.and_then(supported).unwrap_or_else(system_language);
  *LANGUAGE.write().unwrap_or_else(|e| e.into_inner()) = language;
}

fn supported(language: &str) -> Option<&'static str> {
  LANGUAGES.iter().copied().find(|l| *l == language)
}

/// The first of `tags` (BCP 47, most preferred first) in a language Fabricator
/// comes in. A tag matches by its language alone, so es-MX and de-CH match es
/// and de.
pub fn match_language<S: AsRef<str>>(tags: impl IntoIterator<Item = S>) -> Option<&'static str> {
  tags.into_iter().find_map(|tag| {
    let primary = tag.as_ref().trim().split(['-', '_']).next()?.to_ascii_lowercase();
    supported(&primary)
  })
}

/// The language the computer's settings ask for, of the ones Fabricator comes
/// in, and English when it's none of them.
pub fn system_language() -> &'static str {
  match_language(os::preferred_languages()).unwrap_or("en")
}

#[cfg(windows)]
mod os {
  use windows::core::PWSTR;
  use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};

  /// The user's display languages, most preferred first.
  pub fn preferred_languages() -> Vec<String> {
    let mut count = 0u32;
    let mut len = 0u32;
    // SAFETY: the first call only measures the list; the second fills a buffer of that many
    // UTF-16 units, and `len` holds the buffer's size for it.
    unsafe {
      if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut len).is_err() || len == 0 {
        return Vec::new();
      }
      let mut buffer = vec![0u16; len as usize];
      if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, Some(PWSTR(buffer.as_mut_ptr())), &mut len)
        .is_err()
      {
        return Vec::new();
      }
      buffer.truncate(len as usize);
      // A list of null-terminated names, ended by an empty one.
      buffer.split(|unit| *unit == 0).filter(|name| !name.is_empty()).map(String::from_utf16_lossy).collect()
    }
  }
}

#[cfg(target_os = "macos")]
mod os {
  use objc2_foundation::NSLocale;

  /// The user's languages, most preferred first (System Settings → Language & Region).
  pub fn preferred_languages() -> Vec<String> {
    NSLocale::preferredLanguages().iter().map(|tag| tag.to_string()).collect()
  }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod os {
  /// The POSIX locale's languages: LANGUAGE's list, else LC_ALL, LC_MESSAGES or LANG.
  pub fn preferred_languages() -> Vec<String> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    if let Some(list) = var("LANGUAGE") {
      return list.split(':').map(str::to_string).collect();
    }
    ["LC_ALL", "LC_MESSAGES", "LANG"].into_iter().find_map(var).into_iter().collect()
  }
}

/// The text for `key` in the language the core's text is in, with `args` in its
/// placeholders. Use `t!`, which checks the shape of the call.
pub fn text(key: &str, args: &[(&str, &dyn Display)]) -> String {
  text_in(&CATALOGS, language(), key, args)
}

/// The text for `key` in `language`: else in English, else the key itself.
fn text_in(catalogs: &HashMap<&str, Texts>, language: &str, key: &str, args: &[(&str, &dyn Display)]) -> String {
  let args: Vec<(&str, String)> = args.iter().map(|(name, value)| (*name, value.to_string())).collect();
  let count = args.iter().find(|(name, _)| *name == "count").and_then(|(_, value)| value.parse::<f64>().ok());
  let template = lookup(catalogs, language, key, count)
    .or_else(|| lookup(catalogs, "en", key, count))
    .unwrap_or(key);
  interpolate(template, &args)
}

fn lookup<'a>(catalogs: &'a HashMap<&str, Texts>, language: &str, key: &str, count: Option<f64>) -> Option<&'a str> {
  let texts = catalogs.get(language)?;
  let get = |key: &str| texts.get(key).map(String::as_str);
  let Some(n) = count else { return get(key) };
  // As in i18next: a zero form is used for 0 when there is one, whatever the language.
  (if n == 0.0 { get(&format!("{key}_zero")) } else { None })
    .or_else(|| get(&format!("{key}_{}", plural_form(language, n))))
    .or_else(|| get(&format!("{key}_other")))
    .or_else(|| get(key))
}

/// The CLDR plural form `n` takes in `language`, of the forms Fabricator's
/// languages have: Japanese has one form; English and German, one and other;
/// Spanish also has many, for whole millions.
fn plural_form(language: &str, n: f64) -> &'static str {
  let whole = n.fract() == 0.0;
  match language {
    "ja" => "other",
    _ if whole && n.abs() == 1.0 => "one",
    "es" if whole && n != 0.0 && n % 1_000_000.0 == 0.0 => "many",
    _ => "other",
  }
}

/// `template` with each `{{name}}` replaced by its value. A placeholder without
/// a value stays as it is.
fn interpolate(template: &str, args: &[(&str, String)]) -> String {
  let mut out = String::with_capacity(template.len());
  let mut rest = template;
  while let Some(start) = rest.find("{{") {
    out.push_str(&rest[..start]);
    let inner = &rest[start + 2..];
    let Some(end) = inner.find("}}") else {
      out.push_str(&rest[start..]);
      return out;
    };
    let name = inner[..end].trim();
    match args.iter().find(|(n, _)| *n == name) {
      Some((_, value)) => out.push_str(value),
      None => out.push_str(&rest[start..start + 2 + end + 2]),
    }
    rest = &inner[end + 2..];
  }
  out.push_str(rest);
  out
}

/// The text for a catalog key, in the language the core's text is in:
/// `t!("area.key")`, or `t!("area.key", name = value, count = n)` with a value
/// for each of its placeholders. Each value is anything `Display`.
macro_rules! t {
  ($key:literal $(,)?) => {
    $crate::i18n::text($key, &[])
  };
  ($key:literal, $($name:ident = $value:expr),+ $(,)?) => {
    $crate::i18n::text($key, &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),+])
  };
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::{BTreeMap, BTreeSet};
  use std::path::{Path, PathBuf};

  fn catalogs(entries: &[(&'static str, &[(&str, &str)])]) -> HashMap<&'static str, Texts> {
    entries
      .iter()
      .map(|(language, texts)| (*language, texts.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()))
      .collect()
  }

  #[test]
  fn reads_a_text_in_the_language_asked_for_else_english_else_the_key() {
    let catalogs = catalogs(&[
      ("en", &[("commands.a", "Open {{name}}"), ("commands.b", "Only in English")]),
      ("de", &[("commands.a", "{{name}} öffnen")]),
    ]);
    assert_eq!(text_in(&catalogs, "de", "commands.a", &[("name", &"Sales")]), "Sales öffnen");
    assert_eq!(text_in(&catalogs, "de", "commands.b", &[]), "Only in English");
    assert_eq!(text_in(&catalogs, "ja", "commands.a", &[("name", &"Sales")]), "Open Sales");
    assert_eq!(text_in(&catalogs, "de", "commands.missing", &[]), "commands.missing");
  }

  #[test]
  fn picks_each_languages_plural_form() {
    let catalogs = catalogs(&[
      ("en", &[("t.files_zero", "No files"), ("t.files_one", "{{count}} file"), ("t.files_other", "{{count}} files")]),
      ("es", &[("t.files_one", "{{count}} archivo"), ("t.files_other", "{{count}} archivos")]),
      ("ja", &[("t.files_other", "{{count}} 個のファイル")]),
    ]);
    let files = |language: &str, n: &dyn Display| text_in(&catalogs, language, "t.files", &[("count", n)]);
    assert_eq!(files("en", &1), "1 file");
    assert_eq!(files("en", &2), "2 files");
    assert_eq!(files("en", &0), "No files");
    assert_eq!(files("es", &1), "1 archivo");
    // Spanish's many reads as its other form, which the catalog has.
    assert_eq!(files("es", &1_000_000), "1000000 archivos");
    assert_eq!(files("ja", &1), "1 個のファイル");
  }

  #[test]
  fn leaves_a_placeholder_without_a_value() {
    assert_eq!(interpolate("{{a}} and {{ b }} and {{c}}", &[("a", "1".into()), ("b", "2".into())]), "1 and 2 and {{c}}");
    assert_eq!(interpolate("unclosed {{a", &[("a", "1".into())]), "unclosed {{a");
  }

  #[test]
  fn matches_a_language_by_its_tags() {
    assert_eq!(match_language(["es-MX"]), Some("es"));
    assert_eq!(match_language(["fr-FR", "de-CH", "ja"]), Some("de"));
    assert_eq!(match_language(["ja_JP"]), Some("ja"));
    assert_eq!(match_language(["fr", "it"]), None);
    assert!(LANGUAGES.contains(&system_language()));
  }

  fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
  }

  fn folders(dir: &Path) -> BTreeSet<String> {
    std::fs::read_dir(dir)
      .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
      .filter_map(|entry| {
        let entry = entry.ok()?;
        entry.file_type().ok()?.is_dir().then(|| entry.file_name().to_string_lossy().into_owned())
      })
      .collect()
  }

  #[test]
  fn comes_in_the_languages_the_renderer_does() {
    let languages: BTreeSet<String> = LANGUAGES.iter().map(|l| l.to_string()).collect();
    assert_eq!(folders(&manifest_dir().join("../src/renderer/src/i18n/locales")), languages);
    assert_eq!(folders(&manifest_dir().join("locales")), languages);
    for (row, area) in SOURCES.iter().zip(AREAS) {
      assert!(row.iter().all(|(_, a, _)| *a == area), "{area}");
      assert_eq!(row.map(|(language, ..)| language), LANGUAGES, "{area}");
    }
    // Every catalog file is one the core reads.
    let areas: BTreeSet<String> = AREAS.iter().map(|area| format!("{area}.json")).collect();
    for language in LANGUAGES {
      let files: BTreeSet<String> = std::fs::read_dir(manifest_dir().join("locales").join(language))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
      assert_eq!(files, areas, "locales/{language}");
    }
  }

  /// A catalog's texts by base key: a plural's forms under its base, any other text under
  /// itself (with no form).
  fn by_base(texts: &Texts) -> BTreeMap<String, BTreeMap<Option<String>, String>> {
    let mut bases: BTreeMap<String, BTreeMap<Option<String>, String>> = BTreeMap::new();
    for (key, text) in texts {
      let form = ["zero", "one", "two", "few", "many", "other"].into_iter().find(|f| key.ends_with(&format!("_{f}")));
      let (base, form) = match form {
        Some(f) => (key[..key.len() - f.len() - 1].to_string(), Some(f.to_string())),
        None => (key.clone(), None),
      };
      bases.entry(base).or_default().insert(form, text.clone());
    }
    bases
  }

  fn placeholders<'a>(texts: impl Iterator<Item = &'a String>, with_count: bool) -> BTreeSet<String> {
    let re = regex::Regex::new(r"\{\{\s*([\w.]+)\s*\}\}").unwrap();
    texts
      .flat_map(|text| re.captures_iter(text).map(|c| c[1].to_string()).collect::<Vec<_>>())
      .filter(|name| with_count || name != "count")
      .collect()
  }

  #[test]
  fn catalogs_hold_only_text() {
    fn check(path: &str, value: &Value) {
      match value {
        Value::Object(entries) => entries.iter().for_each(|(k, v)| check(&format!("{path}.{k}"), v)),
        Value::String(text) => assert!(!text.trim().is_empty(), "{path} is empty"),
        _ => panic!("{path} isn't text"),
      }
    }
    for (language, area, source) in SOURCES.iter().flatten() {
      let catalog: Value = serde_json::from_str(source).unwrap_or_else(|e| panic!("{language}/{area}.json: {e}"));
      assert!(catalog.is_object(), "{language}/{area}.json isn't an object");
      check(&format!("{language}/{area}"), &catalog);
    }
  }

  #[test]
  fn translations_have_the_english_texts_and_placeholders() {
    let english = by_base(&CATALOGS["en"]);
    for (base, forms) in &english {
      if !forms.contains_key(&None) {
        assert!(forms.contains_key(&Some("one".into())) && forms.contains_key(&Some("other".into())), "en {base}");
      }
    }
    for language in LANGUAGES.into_iter().filter(|l| *l != "en") {
      let translated = by_base(&CATALOGS[language]);
      assert_eq!(translated.keys().collect::<Vec<_>>(), english.keys().collect::<Vec<_>>(), "{language} keys");
      for (base, source) in &english {
        let target = &translated[base];
        let plural = !source.contains_key(&None);
        assert_eq!(!target.contains_key(&None), plural, "{language} {base}: plural or not");
        if plural {
          assert!(target.contains_key(&Some("other".into())), "{language} {base}_other");
          if language != "ja" {
            assert!(target.contains_key(&Some("one".into())), "{language} {base}_one");
          }
          if source.contains_key(&Some("zero".into())) {
            assert!(target.contains_key(&Some("zero".into())), "{language} {base}_zero");
          }
        }
        assert_eq!(
          placeholders(target.values(), !plural),
          placeholders(source.values(), !plural),
          "{language} {base} placeholders"
        );
      }
    }
  }

  fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
      let path = entry.path();
      if path.is_dir() {
        rust_files(&path, out);
      } else if path.extension().is_some_and(|e| e == "rs") {
        out.push(path);
      }
    }
  }

  /// The arguments of the macro call whose `(` ends at `start`: the text up to its closing `)`.
  fn call_args(source: &str, start: usize) -> &str {
    let mut depth = 1;
    for (i, c) in source[start..].char_indices() {
      match c {
        '(' => depth += 1,
        ')' => {
          depth -= 1;
          if depth == 0 {
            return &source[start..start + i];
          }
        }
        _ => {}
      }
    }
    &source[start..]
  }

  #[test]
  fn every_key_the_code_reads_is_in_the_english_catalog() {
    let english = &CATALOGS["en"];
    let call = regex::Regex::new(r#"\bt!\(\s*"([^"]+)""#).unwrap();
    let count = regex::Regex::new(r"\bcount\s*=").unwrap();
    let mut files = Vec::new();
    rust_files(&manifest_dir().join("src"), &mut files);
    let mut missing = Vec::new();
    for file in files.iter().filter(|f| !f.ends_with("i18n.rs")) {
      let source = std::fs::read_to_string(file).unwrap();
      for found in call.captures_iter(&source) {
        let key = &found[1];
        let open = found.get(0).unwrap().start() + found[0].find('(').unwrap() + 1;
        // A count may pick a plural form (`key_one`, `key_other`) or fill a plain text's {{count}}.
        let known = english.contains_key(key)
          || (count.is_match(call_args(&source, open)) && english.contains_key(&format!("{key}_other")));
        if !known {
          missing.push(format!("{}: {key}", file.strip_prefix(manifest_dir()).unwrap_or(file).display()));
        }
      }
    }
    assert!(missing.is_empty(), "keys missing from locales/en:\n{}", missing.join("\n"));
  }
}
