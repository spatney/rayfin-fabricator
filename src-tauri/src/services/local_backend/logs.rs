//! A project's recent local backend output: a ring of lines in memory for the
//! UI, Help and agents, and a rolling file under Fabricator's logs folder for
//! diagnostics. Lines never carry the control token (see [`redact`]).

use std::borrow::Cow;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::types::LocalLogEvent;

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

/// `<dir>/<project id>.log`, rolled over at [`FILE_LIMIT`].
pub struct LogFile {
  path: PathBuf,
  file: Option<std::fs::File>,
  size: u64,
}

impl LogFile {
  pub fn new(dir: &Path, project_id: &str) -> Self {
    Self { path: dir.join(format!("{}.log", safe_name(project_id))), file: None, size: 0 }
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
      let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
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
}
