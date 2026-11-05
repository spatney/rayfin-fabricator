//! `GOALS.md`, at the project's root: what the app is for, and the checks it
//! must keep passing, in plain words. It lives with the code, so git keeps its
//! history, exports carry it, and the chat's Copilot reads it.
//!
//! `## Purpose` is free text. `## Checks` is one check per bullet (`-`, `*`,
//! `+`, `1.` or `1)`, with or without a `[ ]` box); lines under a bullet,
//! indented ones and sub-bullets add to it, and a plain paragraph is a check
//! of its own. Text above the first section and other `##` sections are kept
//! as written. HTML comments are notes, never goals.

use sha2::{Digest, Sha256};

use crate::types::GoalCheck;

pub(super) const FILE_NAME: &str = "GOALS.md";
pub(super) const MAX_PURPOSE: usize = 4000;
pub(super) const MAX_CHECK: usize = 500;
pub(super) const MAX_CHECKS: usize = 40;

const PREAMBLE: &str = "# Goals\n\n<!-- What this app is for, and the checks it must keep passing, in plain words. \
Fabricator's Goals tab runs the checks against a fresh copy of the app, as its users, before you publish. \
One check per bullet. -->";

/// `GOALS.md` read.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Goals {
  /// Text above the first section, under the title.
  pub intro: String,
  pub purpose: String,
  pub checks: Vec<GoalCheck>,
  /// Other sections, as written.
  pub rest: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
  Preamble,
  Purpose,
  Checks,
  Other,
}

fn section_of(title: &str) -> Section {
  let title = title.trim().trim_end_matches(':').to_lowercase().replace('’', "'");
  match title.as_str() {
    "purpose" | "what it's for" | "what this app is for" => Section::Purpose,
    "checks" | "goals" => Section::Checks,
    _ => Section::Other,
  }
}

/// A level-two heading's title.
fn heading(line: &str) -> Option<&str> {
  let rest = line.strip_prefix("## ")?;
  Some(rest.trim().trim_end_matches('#').trim())
}

/// `text` without its HTML comments (an unclosed one runs to the end).
fn strip_comments(text: &str) -> String {
  let mut out = String::new();
  let mut rest = text;
  while let Some(start) = rest.find("<!--") {
    out.push_str(&rest[..start]);
    match rest[start + 4..].find("-->") {
      Some(end) => rest = &rest[start + 4 + end + 3..],
      None => return out,
    }
  }
  out.push_str(rest);
  out
}

/// A list item's text, without its bullet and box.
fn bullet(line: &str) -> Option<&str> {
  let line = line.trim_start();
  let item = if matches!(line, "-" | "*" | "+") {
    ""
  } else if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).or_else(|| line.strip_prefix("+ ")) {
    rest
  } else {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 3 {
      return None;
    }
    let rest = &line[digits..];
    if matches!(rest, "." | ")") {
      ""
    } else {
      rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?
    }
  };
  let item = item.trim_start();
  for boxed in ["[ ]", "[x]", "[X]"] {
    if let Some(rest) = item.strip_prefix(boxed) {
      return Some(rest.trim_start());
    }
  }
  Some(item)
}

/// `---`, `***` and the like.
fn is_rule(line: &str) -> bool {
  let marks: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
  marks.len() >= 3 && ['-', '*', '_', '='].iter().any(|m| marks.iter().all(|c| c == m))
}

fn indent(raw: &str) -> usize {
  raw.chars().take_while(|c| c.is_whitespace()).map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

/// One check as one line, its spacing tidied.
pub(super) fn tidy(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn add_to(check: &mut String, sub_item: bool, text: &str) {
  if check.trim().is_empty() {
    *check = text.to_string();
  } else if !text.is_empty() {
    let joined = !sub_item || check.trim_end().ends_with([':', ',', ';']);
    check.push_str(if joined { " " } else { "; " });
    check.push_str(text);
  }
}

/// The checks in `text`, and its lines that aren't, kept when
/// `paragraphs_are_checks` is false (a file without sections).
fn read_items(text: &str, paragraphs_are_checks: bool) -> (Vec<String>, Vec<String>) {
  let mut checks: Vec<String> = Vec::new();
  let mut other: Vec<String> = Vec::new();
  // The indent of the check being read, while lines can still add to it.
  let mut item: Option<usize> = None;
  // The last line was part of it.
  let mut open = false;
  for raw in text.lines() {
    let line = raw.trim();
    let nested = item.is_some_and(|base| indent(raw) >= base + 2);
    if line.is_empty() {
      open = false;
      other.push(String::new());
    } else if line.starts_with('#') || is_rule(line) {
      item = None;
      open = false;
    } else if let Some(text) = bullet(line) {
      match (nested, checks.last_mut()) {
        (true, Some(last)) => add_to(last, true, text),
        _ => {
          checks.push(text.to_string());
          item = Some(indent(raw));
        }
      }
      open = true;
    } else if let (true, Some(last)) = (open || nested, checks.last_mut()) {
      add_to(last, false, line);
      open = true;
    } else if paragraphs_are_checks {
      checks.push(line.to_string());
      item = Some(indent(raw));
      open = true;
    } else {
      item = None;
      other.push(line.to_string());
    }
  }
  (checks.iter().map(|c| tidy(c)).filter(|c| !c.is_empty()).collect(), other)
}

/// The purpose's paragraphs, without blank runs or a `## ` line that would
/// start a section of its own.
pub(super) fn tidy_purpose(text: &str) -> String {
  let mut out: Vec<String> = Vec::new();
  for line in text.replace("\r\n", "\n").lines() {
    let line = line.trim_end();
    if line.is_empty() && out.last().is_none_or(|l| l.is_empty()) {
      continue;
    }
    out.push(if line.starts_with("## ") { format!("#{line}") } else { line.to_string() });
  }
  while out.last().is_some_and(|l| l.is_empty()) {
    out.pop();
  }
  out.join("\n")
}

/// A check's id: the same for the same words, whatever their case, spacing or final stop.
pub(super) fn check_id(text: &str) -> String {
  let normal = tidy(text).to_lowercase();
  let normal = normal.trim_end_matches(['.', '!', ' ']);
  hex::encode(Sha256::digest(normal.as_bytes()))[..12].to_string()
}

/// Checks with their ids; a check written twice gets `-2`, `-3`.
pub(super) fn with_ids(texts: Vec<String>) -> Vec<GoalCheck> {
  let mut out: Vec<GoalCheck> = Vec::new();
  for text in texts {
    let base = check_id(&text);
    let mut id = base.clone();
    let mut n = 1;
    while out.iter().any(|c| c.id == id) {
      n += 1;
      id = format!("{base}-{n}");
    }
    out.push(GoalCheck { id, text });
  }
  out
}

pub(super) fn parse(text: &str) -> Goals {
  let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
  let mut section = Section::Preamble;
  let (mut preamble, mut purpose, mut checks, mut rest) = (String::new(), String::new(), String::new(), String::new());
  let mut sectioned = false;
  for line in text.split('\n') {
    if let Some(title) = heading(line) {
      section = section_of(title);
      sectioned |= section != Section::Other;
      if section != Section::Other {
        continue;
      }
    }
    let into = match section {
      Section::Preamble => &mut preamble,
      Section::Purpose => &mut purpose,
      Section::Checks => &mut checks,
      Section::Other => &mut rest,
    };
    into.push_str(line);
    into.push('\n');
  }
  let rest = rest.trim().to_string();
  if !sectioned {
    let (checks, other) = read_items(&strip_comments(&preamble), false);
    return Goals { intro: String::new(), purpose: tidy_purpose(&other.join("\n")), checks: with_ids(checks), rest };
  }
  let intro: Vec<&str> = preamble.lines().filter(|l| !l.starts_with("# ") && l.trim() != "#").collect();
  Goals {
    intro: strip_comments(&intro.join("\n")).trim().to_string(),
    purpose: tidy_purpose(&strip_comments(&purpose)),
    checks: with_ids(read_items(&strip_comments(&checks), true).0),
    rest,
  }
}

/// `GOALS.md` with this purpose and these checks, and the rest kept.
pub(super) fn render(intro: &str, purpose: &str, checks: &[String], rest: &str) -> String {
  let mut out = format!("{PREAMBLE}\n\n");
  let intro = intro.trim();
  if !intro.is_empty() {
    out.push_str(intro);
    out.push_str("\n\n");
  }
  out.push_str("## Purpose\n\n");
  let purpose = tidy_purpose(purpose);
  if !purpose.is_empty() {
    out.push_str(&purpose);
    out.push_str("\n\n");
  }
  out.push_str("## Checks\n\n");
  for check in checks {
    out.push_str("- ");
    out.push_str(&tidy(check));
    out.push('\n');
  }
  let rest = rest.trim();
  if !rest.is_empty() {
    out.push('\n');
    out.push_str(rest);
    out.push('\n');
  }
  out
}

/// The purpose and checks to save, tidied, or why they can't be.
pub(super) fn validate(purpose: &str, checks: &[String]) -> Result<(String, Vec<String>), String> {
  let purpose = tidy_purpose(&strip_comments(purpose));
  if purpose.chars().count() > MAX_PURPOSE {
    return Err(format!("The purpose is too long. Keep it under {MAX_PURPOSE} characters."));
  }
  let checks: Vec<String> = checks.iter().map(|c| tidy(&strip_comments(c))).filter(|c| !c.is_empty()).collect();
  if checks.len() > MAX_CHECKS {
    return Err(format!("That's more than {MAX_CHECKS} checks. Keep the ones that matter most."));
  }
  if let Some(long) = checks.iter().find(|c| c.chars().count() > MAX_CHECK) {
    let start: String = long.chars().take(40).collect();
    return Err(format!("“{start}…” is too long for one check. Keep each under {MAX_CHECK} characters, or split it."));
  }
  Ok((purpose, checks))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn texts(goals: &Goals) -> Vec<&str> {
    goals.checks.iter().map(|c| c.text.as_str()).collect()
  }

  #[test]
  fn what_it_writes_reads_back_the_same() {
    let checks = vec!["A rep can log a deal and see it in their pipeline.".to_string(), "A rep can't see another rep's deals.".into()];
    let purpose = "Sales reps track their deals.\n\nManagers see every rep's pipeline.";
    let text = render("Kept above.", purpose, &checks, "## Notes\n\nWhatever.");
    let goals = parse(&text);
    assert_eq!(goals.intro, "Kept above.");
    assert_eq!(goals.purpose, purpose);
    assert_eq!(texts(&goals), checks.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(goals.rest, "## Notes\n\nWhatever.");
    assert_eq!(render(&goals.intro, &goals.purpose, &checks, &goals.rest), text);
    assert_eq!(parse(&text.replace('\n', "\r\n")), goals);
  }

  #[test]
  fn checks_read_the_way_people_write_them() {
    let text = "# Goals\n\n<!-- a note -->\n\n## Purpose\n\nFor the team.\n<!-- hidden -->\n\n## Checks\n\n\
      - [ ] Anyone signed in can add a task\n  and it shows on their board.\n* [x] Signed-out visitors see nothing.\n\
      1. Tasks keep their order.\n2) Admins can delete any task.\n- A rep can log a deal\n  - with an amount\n  - and a close date\n\n\
      A plain paragraph is a check too.\n---\n### Later\n<!-- - not a check -->\n";
    let goals = parse(text);
    assert_eq!(goals.intro, "");
    assert_eq!(goals.purpose, "For the team.");
    assert_eq!(
      texts(&goals),
      [
        "Anyone signed in can add a task and it shows on their board.",
        "Signed-out visitors see nothing.",
        "Tasks keep their order.",
        "Admins can delete any task.",
        "A rep can log a deal; with an amount; and a close date",
        "A plain paragraph is a check too.",
      ]
    );
  }

  #[test]
  fn an_indented_list_is_still_one_check_per_bullet() {
    let goals = parse("## Checks\n\n  - Notes save.\n  - Notes sync.\n    across devices.\n");
    assert_eq!(texts(&goals), ["Notes save.", "Notes sync. across devices."]);
  }

  #[test]
  fn other_sections_are_kept_as_written() {
    let text = "## Purpose\nNotes app.\n\n## Out of scope\n\n- Offline use\n\n## Checks\n- Notes save.\n";
    let goals = parse(text);
    assert_eq!(texts(&goals), ["Notes save."]);
    assert_eq!(goals.rest, "## Out of scope\n\n- Offline use");
    let saved = render(&goals.intro, &goals.purpose, &["Notes save.".into()], &goals.rest);
    assert!(saved.ends_with("- Notes save.\n\n## Out of scope\n\n- Offline use\n"));
  }

  #[test]
  fn a_file_without_sections_still_reads() {
    let goals = parse("# Goals\nA trip planner for families.\n\n- Parents can plan a trip.\n- Kids can only view trips.\n");
    assert_eq!(goals.purpose, "A trip planner for families.");
    assert_eq!(texts(&goals), ["Parents can plan a trip.", "Kids can only view trips."]);
    assert_eq!(parse(""), Goals::default());
  }

  #[test]
  fn a_check_keeps_its_id_through_case_spacing_and_a_final_stop() {
    assert_eq!(check_id("A rep can log a deal."), check_id("a  rep can LOG a deal"));
    assert_ne!(check_id("A rep can log a deal."), check_id("A rep can delete a deal."));
    let ids: Vec<String> = with_ids(vec!["Same.".into(), "same".into(), "Other".into()]).into_iter().map(|c| c.id).collect();
    assert_eq!(ids[1], format!("{}-2", ids[0]));
    assert_eq!(ids[0].len(), 12);
  }

  #[test]
  fn saving_tidies_and_refuses_what_is_too_long() {
    let (purpose, checks) =
      validate("## For reps\n\n\n\nand managers.  ", &[" a  check ".into(), "  ".into(), "x <!-- y --> z".into()]).unwrap();
    assert_eq!(purpose, "### For reps\n\nand managers.");
    assert_eq!(checks, ["a check", "x z"]);
    assert!(validate("", &vec!["x".to_string(); MAX_CHECKS + 1]).is_err());
    assert!(validate("", &["y".repeat(MAX_CHECK + 1)]).is_err());
  }
}
