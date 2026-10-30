//! A project's recent local backend output: a ring of lines in memory for the
//! UI, Help and agents, and a rolling file under Fabricator's logs folder for
//! diagnostics. Lines are masked as they're recorded: the run's control token
//! (see [`redact`]), and credentials such as bearer tokens, JWTs, `pk-local-…`
//! keys and 64-character hex secrets (see [`sanitize`]).

use std::borrow::Cow;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::services::diagnostics::redact_secrets;
use crate::types::LocalLogEvent;

/// The folder under Fabricator's logs folder that keeps each project's output.
pub const LOG_DIR: &str = "local-backend";
/// Lines kept in memory per project.
pub const RING_CAPACITY: usize = 2000;
/// Size at which a project's log file rolls over to `<id>.log.1`, so each
/// project keeps at most twice this on disk.
pub const FILE_LIMIT: u64 = 1024 * 1024;
/// Longest line kept; longer ones are cut.
pub const MAX_LINE_CHARS: usize = 8000;

pub struct LogRing {
  lines: VecDeque<LocalLogEvent>,
  capacity: usize,
}

impl LogRing {
  pub fn new(capacity: usize) -> Self {
    Self { lines: VecDeque::with_capacity(capacity.min(256)), capacity: capacity.max(1) }
  }

  pub fn push(&mut self, line: LocalLogEvent) {
    if self.lines.len() == self.capacity {
      self.lines.pop_front();
    }
    self.lines.push_back(line);
  }

  /// The last `n` lines, oldest first.
  pub fn recent(&self, n: usize) -> Vec<LocalLogEvent> {
    self.lines.iter().skip(self.lines.len().saturating_sub(n)).cloned().collect()
  }

  /// The text of the last `n` lines, oldest first.
  pub fn tail(&self, n: usize) -> Vec<String> {
    self.lines.iter().skip(self.lines.len().saturating_sub(n)).map(|l| l.line.clone()).collect()
  }
}

/// `<dir>/<project id>.log`, rolled over to `<project id>.log.1` at [`FILE_LIMIT`].
pub struct LogFile {
  path: PathBuf,
  rolled: PathBuf,
  file: Option<std::fs::File>,
  size: u64,
}

impl LogFile {
  pub fn new(dir: &Path, project_id: &str) -> Self {
    let [rolled, path] = log_files(dir, project_id);
    Self { path, rolled, file: None, size: 0 }
  }

  #[cfg(test)]
  pub fn path(&self) -> &Path {
    &self.path
  }

  /// Append one line. Best-effort: a log that can't be written never stops the backend.
  pub fn append(&mut self, line: &LocalLogEvent) {
    let text = format!("{} {} {} {}\n", line.time, line.source, line.level, line.line);
    if self.file.is_some() && self.size + text.len() as u64 > FILE_LIMIT {
      self.file = None;
      let _ = std::fs::rename(&self.path, &self.rolled);
    }
    if self.file.is_none() {
      if let Some(dir) = self.path.parent() {
        let _ = std::fs::create_dir_all(dir);
      }
      let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) else {
        return;
      };
      self.size = file.metadata().map(|m| m.len()).unwrap_or(0);
      self.file = Some(file);
    }
    if let Some(file) = self.file.as_mut() {
      if file.write_all(text.as_bytes()).is_ok() {
        self.size += text.len() as u64;
      }
    }
  }
}

/// A project's log files in `dir` (the logs folder's [`LOG_DIR`]), oldest
/// first: the rolled over `<id>.log.1`, then the current `<id>.log`.
pub fn log_files(dir: &Path, project_id: &str) -> [PathBuf; 2] {
  let name = safe_name(project_id);
  [dir.join(format!("{name}.log.1")), dir.join(format!("{name}.log"))]
}

/// A project id as a file name: ids are UUIDs, but never trust a path segment.
fn safe_name(id: &str) -> String {
  let name: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
  if name.is_empty() { "_".into() } else { name }
}

/// `line` with every occurrence of `secret` masked.
pub fn redact<'a>(line: &'a str, secret: &str) -> Cow<'a, str> {
  if secret.is_empty() || !line.contains(secret) {
    Cow::Borrowed(line)
  } else {
    Cow::Owned(line.replace(secret, "***"))
  }
}

/// `line` as the ring and the file keep it: credentials masked, then cut to
/// [`MAX_LINE_CHARS`] without its line break.
pub fn sanitize(line: &str) -> String {
  clip(&redact_secrets(line))
}

/// `line` cut to [`MAX_LINE_CHARS`], without its line break.
pub fn clip(line: &str) -> String {
  let line = line.trim_end_matches(['\r', '\n']);
  match line.char_indices().nth(MAX_LINE_CHARS) {
    Some((cut, _)) => format!("{}…", &line[..cut]),
    None => line.to_string(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn line(seq: u64, text: &str) -> LocalLogEvent {
    LocalLogEvent {
      project_id: "p".into(),
      seq,
      source: "vite".into(),
      level: "info".into(),
      line: text.into(),
      time: "2026-10-30T03:12:09.512Z".into(),
    }
  }

  #[test]
  fn the_ring_keeps_the_newest_lines() {
    let mut ring = LogRing::new(3);
    for seq in 1..=5 {
      ring.push(line(seq, &format!("line {seq}")));
    }
    let seqs: Vec<u64> = ring.recent(10).iter().map(|l| l.seq).collect();
    assert_eq!(seqs, [3, 4, 5]);
    assert_eq!(ring.recent(2).iter().map(|l| l.seq).collect::<Vec<_>>(), [4, 5]);
    assert_eq!(ring.tail(1), ["line 5"]);
    assert!(ring.recent(0).is_empty());
  }

  #[test]
  fn the_file_rolls_over_and_stays_capped() {
    let dir = std::env::temp_dir().join(format!("fab-local-log-{}", uuid::Uuid::new_v4()));
    let mut file = LogFile::new(&dir, "../escape");
    assert!(file.path().starts_with(&dir));
    let text = "x".repeat(1000);
    for seq in 0..2500 {
      file.append(&line(seq, &text));
    }
    let current = std::fs::metadata(file.path()).unwrap().len();
    let rolled = std::fs::metadata(file.path().with_extension("log.1")).unwrap().len();
    assert!(current <= FILE_LIMIT && rolled <= FILE_LIMIT, "{current} {rolled}");
    assert!(rolled > FILE_LIMIT / 2);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn masks_the_secret_and_clips_long_lines() {
    let token = "f".repeat(64);
    assert_eq!(redact(&format!("token={token}!"), &token), "token=***!");
    assert!(matches!(redact("nothing here", &token), Cow::Borrowed(_)));
    assert_eq!(redact("anything", ""), "anything");
    assert_eq!(clip("short\r\n"), "short");
    let long = "é".repeat(MAX_LINE_CHARS + 10);
    assert_eq!(clip(&long).chars().count(), MAX_LINE_CHARS + 1);
  }

  #[test]
  fn credentials_never_reach_the_ring_or_the_file() {
    let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZXZlbG9wZXIifQ.c2lnbmF0dXJl";
    let hex = "0123456789abcdef".repeat(4);
    let key = "pk-local-AbC123dEf456GhI789jKl012";
    let line = format!("[fn] GET /me Authorization: Bearer {jwt} key={key} control={hex}\r\n");
    let kept = sanitize(&line);
    for secret in [jwt, hex.as_str(), key] {
      assert!(!kept.contains(secret), "{kept}");
    }
    assert!(kept.starts_with("[fn] GET /me Authorization: ") && kept.contains("pk-local-***"), "{kept}");
    assert_eq!(sanitize("  ➜  Local:   http://localhost:5173/\n"), "  ➜  Local:   http://localhost:5173/");
    assert_eq!(sanitize(&"x".repeat(MAX_LINE_CHARS + 5)).chars().count(), MAX_LINE_CHARS + 1);
  }

  #[test]
  fn names_the_files_oldest_first_inside_the_folder() {
    let dir = Path::new("logs").join(LOG_DIR);
    assert_eq!(log_files(&dir, "p-1"), [dir.join("p-1.log.1"), dir.join("p-1.log")]);
    let [_, escape] = log_files(&dir, "../escape");
    assert_eq!(escape, dir.join("___escape.log"), "a project id can't leave the folder");
  }
}
