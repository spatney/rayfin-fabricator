//! Skills catalog (list/toggle/source) and the per-project agent operating
//! contract. Faithful port of `src/main/services/skills.ts`.
//!
//! Add-on skills live on disk as `.agents/skills/<id>/SKILL.md`. CLI-managed
//! (locked) skills carry a `rayfin-managed: true` frontmatter sigil and cannot
//! be removed. Toggling a skill writes/deletes its folder and commits just that
//! folder so the change shows up in History.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use crate::services::{exec, store};
use crate::types::{SkillActionResult, SkillInfo, SkillSource};

/// A curated add-on skill the user can toggle on/off.
struct SkillDef {
  id: &'static str,
  title: &'static str,
  description: &'static str,
  icon: &'static str,
  category: &'static str,
  trigger: &'static str,
  body: &'static str,
}

/// The curated catalog of optional skills, grouped by category in the UI.
static CATALOG: &[SkillDef] = &[
  SkillDef {
    id: "polished-ui",
    title: "Polished, modern UI",
    description: "Clean layouts, consistent spacing, tasteful color and type.",
    icon: "✨",
    category: "Look & feel",
    trigger: r#"Use when building or restyling UI to make it look modern and polished. Triggers: UI, design, styling, layout, theme, colors, spacing, typography, components, look and feel, redesign, polish, make it pretty, modern"#,
    body: r#"Give the app a clean, modern, consistent look:
- Use a consistent spacing scale (4/8px rhythm), a clear type hierarchy and generous whitespace.
- Establish reusable design tokens (colors, radius, shadows) instead of one-off values; keep a
  single accent color and use it sparingly for primary actions.
- Flat and modern: subtle borders and soft shadows over heavy gradients; align elements to a grid.
- Support both light and dark themes with accessible contrast in each.
- Keep components visually consistent — buttons, inputs and cards should share sizing and shape."#,
  },
  SkillDef {
    id: "buttery-animations",
    title: "Buttery animations",
    description: "Smooth, tasteful motion and micro-interactions.",
    icon: "🎬",
    category: "Look & feel",
    trigger: r#"Use when adding motion, transitions or micro-interactions. Triggers: animation, transition, motion, animate, hover effect, fade, slide, spring, easing, micro-interaction, smooth, 60fps, framer"#,
    body: r#"Make the app feel alive with smooth, tasteful motion:
- Animate state changes (mount/unmount, list add/remove, route changes) instead of snapping.
- Prefer GPU-friendly `transform` and `opacity`; avoid animating layout properties (width,
  height, top/left) that cause reflow. Target a steady 60fps.
- Use natural easing — ease-out for entrances, spring-like curves for interactive elements.
  Keep durations short (120–300ms); never block the user waiting on an animation.
- Add subtle micro-interactions: hover/press feedback on buttons, gentle focus rings.
- Always respect `prefers-reduced-motion`: drop to instant/opacity-only when the user asks."#,
  },
  SkillDef {
    id: "responsive-layout",
    title: "Responsive on every screen",
    description: "Looks great on phones, tablets and desktops.",
    icon: "📱",
    category: "Look & feel",
    trigger: r#"Use when the layout must adapt across screen sizes. Triggers: responsive, mobile, tablet, desktop, breakpoint, media query, fluid, grid, flexbox, viewport, small screen, adapt, mobile-first"#,
    body: r#"Make the UI work on any screen size:
- Design mobile-first, then enhance for larger viewports with sensible breakpoints.
- Use fluid layouts (flexbox/grid, %/fr, min/max, clamp()) rather than fixed pixel widths.
- Ensure tap targets are at least 44px and content never overflows or requires horizontal scroll.
- Collapse multi-column layouts into a single column on small screens; keep key actions reachable.
- Test the important flows at narrow (~375px) and wide (~1440px) widths."#,
  },
  SkillDef {
    id: "accessibility",
    title: "Accessible to everyone",
    description: "Keyboard, screen-reader and contrast friendly.",
    icon: "♿",
    category: "Quality",
    trigger: r#"Use when making the app usable for everyone. Triggers: accessibility, a11y, screen reader, keyboard, focus, aria, contrast, WCAG, semantic HTML, alt text, tab order, accessible"#,
    body: r#"Build the app to be usable by everyone:
- Use semantic HTML (button, nav, main, label, headings in order) before reaching for ARIA.
- Every interactive element must be keyboard reachable and operable, with a visible focus state.
- Label all form controls; associate errors with their inputs via aria-describedby.
- Provide alt text for meaningful images and aria-labels for icon-only buttons.
- Meet WCAG AA color contrast (4.5:1 for text); never rely on color alone to convey meaning."#,
  },
  SkillDef {
    id: "loading-empty-states",
    title: "Loading & empty states",
    description: "Graceful spinners, skeletons, empty and error states.",
    icon: "⏳",
    category: "Quality",
    trigger: r#"Use when handling async data, loading, empty or error states. Triggers: loading, spinner, skeleton, empty state, error state, retry, placeholder, no data, fetching, async, optimistic update"#,
    body: r#"Handle every async state gracefully:
- Show a loading indicator (skeleton placeholders preferred over spinners) while data fetches.
- Design friendly empty states with a short explanation and a clear primary action ("Add your
  first item") instead of a blank screen.
- Show concise, recoverable error states with a retry option; never leave the user stuck.
- Use optimistic updates for quick actions where safe, reconciling once the server responds.
- Disable buttons and show progress while a submit is in flight to prevent double submits."#,
  },
  SkillDef {
    id: "data-modeling",
    title: "Solid data modeling",
    description: "Well-structured tables, fields and relationships.",
    icon: "🗃️",
    category: "Data & forms",
    trigger: r#"Use when designing or changing the app's data — tables, fields, relationships, queries. Triggers: data model, schema, table, entity, relationship, field, query, dataset, Rayfin data, migration, primary key, normalization"#,
    body: r#"Design the app's data well (it lives in Rayfin's data service):
- Model entities and relationships explicitly; give each table a clear primary key and meaningful,
  well-typed field names.
- Prefer normalized tables with relationships over one giant denormalized blob; avoid stuffing data
  into JSON columns you'll later need to query or filter on.
- Add only the fields the app needs now, but name them so the schema can grow without churn.
- Read and write through the Rayfin data SDK; filter, sort and page on the server rather than
  pulling whole tables to the client.
- Shape queries around how the UI actually uses the data, and keep reads cheap."#,
  },
  SkillDef {
    id: "data-viz",
    title: "Beautiful charts & dashboards",
    description: "Turn your Rayfin data into clear, attractive charts and summaries.",
    icon: "📊",
    category: "Data & forms",
    trigger: r#"Use when presenting data, metrics or dashboards. Triggers: chart, graph, dashboard, visualization, KPI, metric, line chart, bar chart, donut, analytics, summary card, data viz, trends"#,
    body: r#"Visualize the app's data well (it lives in Rayfin's data service):
- Pick the right chart for the question: trends over time → line, comparisons → bar,
  parts of a whole → donut (sparingly). Avoid 3D and chart junk.
- Lead with the headline numbers (KPIs/summary cards), then the supporting charts.
- Use clear axis labels, readable tick counts, accessible colors and tooltips on hover.
- Keep charts responsive and show a tidy empty state when there's no data yet.
- Aggregate/query data through Rayfin rather than pulling everything to the client."#,
  },
  SkillDef {
    id: "friendly-forms",
    title: "Friendly forms & validation",
    description: "Clear inputs, inline validation and helpful, human error messages.",
    icon: "📝",
    category: "Data & forms",
    trigger: r#"Use when building forms or data entry to make them clear and forgiving. Triggers: form, input, validation, error message, required field, submit, field, placeholder, autofocus, helper text, data entry"#,
    body: r#"Make data entry painless:
- Validate inline as the user goes and on submit; show errors next to the field, in plain language.
- Write helpful messages ("Enter a date in the future") rather than codes; suggest how to fix it.
- Use the right input types/keyboards, sensible defaults, placeholders and autofocus on the first field.
- Keep forms short; group related fields and explain anything non-obvious with helper text.
- Preserve the user's input on error and confirm success clearly after submit."#,
  },
  SkillDef {
    id: "performance",
    title: "Fast & snappy",
    description: "Keep the app quick to load and smooth to use as it grows.",
    icon: "⚡",
    category: "Performance",
    trigger: r#"Use when the app feels slow or to keep it fast as it grows. Triggers: performance, speed, fast, slow, bundle size, lazy load, code splitting, memoization, re-render, cache, debounce, throttle, virtualization, optimize"#,
    body: r#"Keep the app fast and responsive:
- Load less up front: code-split heavy routes/components and lazy-load rarely-used or below-the-fold UI.
- Avoid unnecessary work: memoize expensive computations, debounce/throttle high-frequency events,
  and don't refetch data you already have.
- Keep long lists snappy with pagination or virtualization instead of rendering thousands of rows.
- Cache server responses where safe and revalidate in the background rather than blocking the UI.
- Measure before optimizing, then fix the biggest bottleneck first (usually network or large renders)."#,
  },
];

/// Friendly presentation for known CLI-managed (locked) skills found on disk.
fn managed_presentation(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
  match id {
    "rayfin" => Some((
      "Rayfin essentials",
      "Core Rayfin knowledge, conventions and CLI usage. Managed by Rayfin — always on.",
      "◆",
    )),
    "rayfin-functions" => Some((
      "Rayfin Functions",
      "Guidance for building Rayfin serverless functions. Managed by Rayfin.",
      "λ",
    )),
    _ => None,
  }
}

/// The Fabricator operating contract written to `.github/copilot-instructions.md`.
const AGENT_INSTRUCTIONS: &str = r#"# Fabricator — agent guidance

This is a **Rayfin app** (a Microsoft Fabric Backend-as-a-Service app). You are the
coding agent running inside **Fabricator**, a desktop app that drives you plus the
Rayfin CLI to build and deploy this app.

## Rules
- **Make the requested code changes only.** Edit files to implement what the user asks.
- **Do NOT run `rayfin up` or otherwise deploy.** Fabricator runs the full
  `rayfin up` automatically after your changes and shows the deployed app in its preview.
- Do **not** start dev servers or run the app locally — it is only ever run via deploy.
- Keep the project building; prefer small, correct changes.
- Only use what Rayfin natively provides (data, auth, file storage, functions, static
  hosting). Do **not** add external services like payment processors or email senders.
- Detailed Rayfin SDK/CLI guidance lives in the `rayfin` skill (`.agents/skills/rayfin`);
  additional enabled skills live alongside it under `.agents/skills/`.

When you finish editing, briefly summarize what you changed — Fabricator handles the deploy.
"#;

const GENERATED_MARKER: &str = "Generated by Rayfin Fabricator";

fn skills_root(dir: &str) -> PathBuf {
  Path::new(dir).join(".agents").join("skills")
}

fn skill_dir(dir: &str, id: &str) -> PathBuf {
  skills_root(dir).join(id)
}

fn catalog_by_id(id: &str) -> Option<&'static SkillDef> {
  CATALOG.iter().find(|s| s.id == id)
}

/// Extract the YAML block between the leading `---` fences.
fn frontmatter(raw: &str) -> Option<&str> {
  static FM_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").unwrap());
  let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
  FM_RE.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str())
}

/// True when a SKILL.md is CLI-managed (`rayfin-managed: true` sigil).
fn is_managed(raw: &str) -> bool {
  static MANAGED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*rayfin-managed:\s*true\s*$").unwrap());
  frontmatter(raw)
    .map(|fm| MANAGED_RE.is_match(fm))
    .unwrap_or(false)
}

/// Build a SKILL.md file body for one of our add-on skills.
fn render_skill_file(def: &SkillDef) -> String {
  let description = def.trigger.replace('"', "'");
  format!(
    "---\nname: {id}\ndescription: \"{description}\"\nmetadata:\n  author: Fabricator\n  version: 1.0.0\n---\n# {title}\n\n{body}\n",
    id = def.id,
    description = description,
    title = def.title,
    body = def.body.trim(),
  )
}

#[derive(Clone, Copy)]
struct OnDisk {
  managed: bool,
}

/// Read installed skills: id → { managed } for every `.agents/skills/<id>/SKILL.md`.
fn read_installed(dir: &str) -> BTreeMap<String, OnDisk> {
  let mut out = BTreeMap::new();
  let root = skills_root(dir);
  let entries = match std::fs::read_dir(&root) {
    Ok(e) => e,
    Err(_) => return out,
  };
  for entry in entries.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    let file = root.join(&name).join("SKILL.md");
    if let Ok(raw) = std::fs::read_to_string(&file) {
      out.insert(name, OnDisk { managed: is_managed(&raw) });
    }
  }
  out
}

/// Title-case a bare skill id for an unknown custom skill (`my_skill` → `My Skill`).
fn title_case(id: &str) -> String {
  let spaced: String = id
    .chars()
    .map(|c| if c == '-' || c == '_' { ' ' } else { c })
    .collect();
  spaced
    .split(' ')
    .map(|word| {
      let mut chars = word.chars();
      match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

/// Resolve a skill id to display (title, description, icon).
fn presentation_for(id: &str) -> (String, String, String) {
  if let Some((t, d, i)) = managed_presentation(id) {
    return (t.to_string(), d.to_string(), i.to_string());
  }
  if let Some(def) = catalog_by_id(id) {
    return (
      def.title.to_string(),
      def.description.to_string(),
      def.icon.to_string(),
    );
  }
  (
    title_case(id),
    "A custom skill in this project.".to_string(),
    "🧩".to_string(),
  )
}

/// Compose the project's skill list: locked managed skills, catalog add-ons, then extras.
fn build_list(dir: &str) -> Vec<SkillInfo> {
  let installed = read_installed(dir);
  let mut list: Vec<SkillInfo> = Vec::new();
  let mut used: HashSet<String> = HashSet::new();

  // 1) CLI-managed (locked) skills first, in a stable, friendly order.
  let managed_order = ["rayfin", "rayfin-functions"];
  let mut managed_ids: Vec<String> = managed_order
    .iter()
    .filter(|id| installed.get(**id).map(|d| d.managed).unwrap_or(false))
    .map(|s| s.to_string())
    .collect();
  let extra_managed: Vec<String> = installed
    .iter()
    .filter(|(id, d)| d.managed && !managed_order.contains(&id.as_str()))
    .map(|(id, _)| id.clone())
    .collect();
  managed_ids.extend(extra_managed);
  for id in &managed_ids {
    let (title, description, icon) = presentation_for(id);
    list.push(SkillInfo {
      id: id.clone(),
      title,
      description,
      icon,
      base: true,
      active: true,
      category: None,
      custom: None,
    });
    used.insert(id.clone());
  }

  // 2) Our curated add-on catalog (active when installed and unmanaged).
  for def in CATALOG {
    if used.contains(def.id) {
      continue;
    }
    let on_disk = installed.get(def.id);
    list.push(SkillInfo {
      id: def.id.to_string(),
      title: def.title.to_string(),
      description: def.description.to_string(),
      icon: def.icon.to_string(),
      category: Some(def.category.to_string()),
      base: false,
      active: on_disk.map(|d| !d.managed).unwrap_or(false),
      custom: None,
    });
    used.insert(def.id.to_string());
  }

  // 3) Any other installed unmanaged skills (e.g. agent-authored).
  for (id, d) in &installed {
    if used.contains(id) || d.managed {
      continue;
    }
    let (title, description, icon) = presentation_for(id);
    list.push(SkillInfo {
      id: id.clone(),
      title,
      description,
      icon,
      base: false,
      active: true,
      category: None,
      custom: Some(true),
    });
  }

  list
}

fn write_skill_file(dir: &str, def: &SkillDef) -> std::io::Result<()> {
  let target = skill_dir(dir, def.id);
  std::fs::create_dir_all(&target)?;
  std::fs::write(target.join("SKILL.md"), render_skill_file(def))
}

#[derive(Deserialize)]
struct LegacyManifest {
  #[serde(default)]
  active: Option<Vec<String>>,
}

/// Ensure the Fabricator operating contract exists and clean up artifacts from the
/// earlier (manifest-based) skills implementation. Best-effort; called on scaffold/open.
pub fn ensure_project_skills(dir: &str) {
  let _ = ensure_agent_instructions(dir);
  let _ = migrate_legacy_manifest(dir);
}

/// Write `.github/copilot-instructions.md`, healing the old generated variant.
fn ensure_agent_instructions(dir: &str) -> std::io::Result<()> {
  let file = Path::new(dir).join(".github").join("copilot-instructions.md");
  if let Ok(existing) = std::fs::read_to_string(&file) {
    // Keep a user-authored or new-style file; only overwrite the old generated one.
    if !existing.contains(GENERATED_MARKER) {
      return Ok(());
    }
  }
  let gh_dir = Path::new(dir).join(".github");
  std::fs::create_dir_all(&gh_dir)?;
  std::fs::write(&file, AGENT_INSTRUCTIONS)
}

/// Migrate the earlier `.github/rayfin-skills.json` manifest into on-disk skills,
/// then remove the stray manifest.
fn migrate_legacy_manifest(dir: &str) -> std::io::Result<()> {
  let manifest = Path::new(dir).join(".github").join("rayfin-skills.json");
  let raw = match std::fs::read_to_string(&manifest) {
    Ok(r) => r,
    Err(_) => return Ok(()),
  };
  if let Ok(parsed) = serde_json::from_str::<LegacyManifest>(&raw) {
    let installed = read_installed(dir);
    for id in parsed.active.unwrap_or_default() {
      if let Some(def) = catalog_by_id(&id) {
        if !installed.contains_key(&id) {
          let _ = write_skill_file(dir, def);
        }
      }
    }
  }
  let _ = std::fs::remove_file(&manifest);
  Ok(())
}

fn git_opts(dir: &str, ms: u64) -> exec::RunOptions {
  exec::RunOptions {
    cwd: Some(PathBuf::from(dir)),
    timeout_ms: Some(ms),
    ..Default::default()
  }
}

/// Ensure a local git identity exists so commits don't fail on a fresh machine.
async fn ensure_git_identity(dir: &str) {
  let email = exec::run("git", &["config", "user.email"], git_opts(dir, 15_000)).await;
  if email.stdout.trim().is_empty() {
    let _ = exec::run(
      "git",
      &["config", "user.email", "fabricator@rayfin.local"],
      git_opts(dir, 15_000),
    )
    .await;
    let _ = exec::run(
      "git",
      &["config", "user.name", "Fabricator"],
      git_opts(dir, 15_000),
    )
    .await;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The project's skill list (locked managed skills + add-on catalog + extras).
#[tauri::command]
pub fn skills_list(id: String) -> Vec<SkillInfo> {
  match store::find_project(&id) {
    Some(project) => build_list(&project.path),
    None => vec![],
  }
}

/// Read the raw SKILL.md behind a skill for the read-only preview.
#[tauri::command]
pub fn skills_source(id: String, skill_id: String) -> SkillSource {
  let project = match store::find_project(&id) {
    Some(p) => p,
    None => {
      return SkillSource {
        ok: false,
        installed: false,
        content: None,
        error: Some("Project not found.".to_string()),
      }
    }
  };
  let file = skill_dir(&project.path, &skill_id).join("SKILL.md");
  match std::fs::read_to_string(&file) {
    Ok(content) => SkillSource {
      ok: true,
      installed: true,
      content: Some(content),
      error: None,
    },
    Err(_) => match catalog_by_id(&skill_id) {
      Some(def) => SkillSource {
        ok: true,
        installed: false,
        content: Some(render_skill_file(def)),
        error: None,
      },
      None => SkillSource {
        ok: false,
        installed: false,
        content: None,
        error: Some("This skill has no preview.".to_string()),
      },
    },
  }
}

/// Turn a skill on or off for a project: create or delete its
/// `.agents/skills/<id>/SKILL.md` and commit just that folder.
#[tauri::command]
pub async fn skills_set(id: String, skill_id: String, active: bool) -> SkillActionResult {
  let project = match store::find_project(&id) {
    Some(p) => p,
    None => {
      return SkillActionResult {
        ok: false,
        skills: vec![],
        error: Some("Project not found.".to_string()),
      }
    }
  };
  let dir = project.path;
  let installed = read_installed(&dir);
  let on_disk = installed.get(&skill_id).copied();
  let def = catalog_by_id(&skill_id);

  if active {
    if def.is_none() {
      return SkillActionResult {
        ok: false,
        skills: build_list(&dir),
        error: Some("Unknown skill.".to_string()),
      };
    }
    if on_disk.map(|d| d.managed).unwrap_or(false) {
      return SkillActionResult {
        ok: false,
        skills: build_list(&dir),
        error: Some("That skill is managed by Rayfin.".to_string()),
      };
    }
  } else {
    if on_disk.map(|d| d.managed).unwrap_or(false) {
      return SkillActionResult {
        ok: false,
        skills: build_list(&dir),
        error: Some("That skill is managed by Rayfin and can't be removed.".to_string()),
      };
    }
    if on_disk.is_none() {
      return SkillActionResult {
        ok: true,
        skills: build_list(&dir),
        error: None,
      };
    }
  }

  let mut title = skill_id.clone();
  let io_result: std::io::Result<()> = if active {
    match def {
      Some(def) => {
        title = def.title.to_string();
        write_skill_file(&dir, def)
      }
      None => Ok(()),
    }
  } else {
    title = presentation_for(&skill_id).0;
    let target = skill_dir(&dir, &skill_id);
    if target.exists() {
      std::fs::remove_dir_all(&target)
    } else {
      Ok(())
    }
  };

  if let Err(err) = io_result {
    return SkillActionResult {
      ok: false,
      skills: build_list(&dir),
      error: Some(format!("Could not update skills: {err}")),
    };
  }

  // Commit just the skill folder (best-effort) so the change shows in History.
  let rel = format!(".agents/skills/{skill_id}");
  ensure_git_identity(&dir).await;
  let _ = exec::run("git", &["add", "-A", "--", &rel], git_opts(&dir, 30_000)).await;
  let message = format!("{} skill: {}", if active { "Add" } else { "Remove" }, title);
  let _ = exec::run(
    "git",
    &["commit", "-m", &message, "--", &rel],
    git_opts(&dir, 30_000),
  )
  .await;

  SkillActionResult {
    ok: true,
    skills: build_list(&dir),
    error: None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frontmatter_extracts_block() {
    let raw = "---\nname: x\nrayfin-managed: true\n---\n# Title\nbody";
    let fm = frontmatter(raw).unwrap();
    assert!(fm.contains("name: x"));
    assert!(fm.contains("rayfin-managed: true"));
  }

  #[test]
  fn frontmatter_strips_bom() {
    let raw = "\u{feff}---\nname: x\n---\nbody";
    assert_eq!(frontmatter(raw), Some("name: x"));
  }

  #[test]
  fn frontmatter_absent_returns_none() {
    assert_eq!(frontmatter("no frontmatter here"), None);
  }

  #[test]
  fn is_managed_detects_sigil() {
    assert!(is_managed("---\nname: rayfin\nrayfin-managed: true\n---\nx"));
    assert!(is_managed("---\nrayfin-managed:   true  \nname: y\n---\nx"));
    assert!(!is_managed("---\nname: polished-ui\n---\nx"));
    assert!(!is_managed("---\nrayfin-managed: false\n---\nx"));
  }

  #[test]
  fn render_skill_file_has_frontmatter_and_title() {
    let def = catalog_by_id("polished-ui").unwrap();
    let out = render_skill_file(def);
    assert!(out.starts_with("---\nname: polished-ui\n"));
    assert!(out.contains("author: Fabricator"));
    assert!(out.contains("# Polished, modern UI"));
    // The rendered file must not itself look managed.
    assert!(!is_managed(&out));
  }

  #[test]
  fn render_skill_file_downgrades_quotes() {
    // friendly-forms body has double quotes, but trigger does not; craft a check on
    // the description line: it must be wrapped in double quotes with no inner ones.
    let def = catalog_by_id("friendly-forms").unwrap();
    let out = render_skill_file(def);
    let desc_line = out.lines().find(|l| l.starts_with("description:")).unwrap();
    let inner = desc_line
      .trim_start_matches("description: \"")
      .trim_end_matches('"');
    assert!(!inner.contains('"'));
  }

  #[test]
  fn title_case_humanizes_ids() {
    assert_eq!(title_case("my_custom-skill"), "My Custom Skill");
    assert_eq!(title_case("rayfin"), "Rayfin");
  }

  #[test]
  fn catalog_ids_are_unique_and_unmanaged_rendered() {
    let mut seen = HashSet::new();
    for def in CATALOG {
      assert!(seen.insert(def.id), "duplicate id {}", def.id);
      // Every catalog skill renders a non-managed SKILL.md.
      assert!(!is_managed(&render_skill_file(def)));
    }
  }
}
