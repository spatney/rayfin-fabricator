//! What the Help assistant can see for one conversation.
//!
//! A Copilot session is scoped to a single working directory, but the assistant
//! needs to read from several unrelated places: the logs, Fabricator's source,
//! the mirrored docs, the user's project, and anything the user attaches. The
//! session therefore runs rooted at the assistant's own cache directory, and
//! every readable location is declared here so the permission policy can allow
//! exactly those roots and nothing else.

use std::path::PathBuf;

use super::tools::Surface;
use crate::services::{diagnostics, grounding, journal, paths, store};
use crate::types::{LocalStatus, StudioProject};

/// How many journal records to put in front of the model each turn.
///
/// Successes are in here too, so the window has to be wide enough that a
/// failure and the success that resolved it both fit — otherwise the fix falls
/// off the end and the problem looks live again.
const RECENT_ACTIVITY: usize = 60;

/// The user's active project, when the Help overlay was opened with one.
#[derive(Clone, Debug)]
pub struct ProjectContext {
  pub name: String,
  pub path: String,
  /// Set when the project belongs to a team workspace. Team apps work
  /// differently enough (publishing, who may grant access, and no local
  /// backend) that the assistant must not offer the personal-project controls
  /// for them.
  pub team: Option<String>,
  /// Published to Microsoft Fabric at least once, so its preview has a
  /// published backend to fall back to.
  pub published: bool,
}

/// One of the user's projects, so the assistant can answer "open my expenses
/// app" by offering a button rather than describing where to click.
#[derive(Clone, Debug)]
pub struct ProjectSummary {
  pub id: String,
  pub name: String,
  /// Whether the project has ever been published, which decides whether sharing
  /// it is possible yet.
  pub published: bool,
}

/// The mirrored release notes.
#[derive(Clone, Debug)]
pub struct ReleaseNotes {
  pub path: String,
  /// Whether they have a section for the running version. A mirror fetched
  /// before an update, or for a build that hasn't been released, doesn't.
  pub has_this_version: bool,
}

/// Everything one Help conversation is allowed to read, plus the facts worth
/// telling the model up front.
#[derive(Clone, Debug)]
pub struct HelpContext {
  pub app_version: String,
  /// This copy of Fabricator is a development build run from source, so the
  /// journal records it writes are marked `dev: true`.
  pub dev_build: bool,
  pub os: String,
  /// Fabricator's own source checkout, when the grounding cache is populated.
  pub source_dir: Option<String>,
  /// The git ref that checkout came from.
  pub source_ref: Option<String>,
  /// The mirrored documentation.
  pub docs_dir: Option<String>,
  /// The mirrored release notes, when there are any.
  pub release_notes: Option<ReleaseNotes>,
  /// The app's logs directory, which holds the activity journal.
  pub logs_dir: String,
  pub project: Option<ProjectContext>,
  /// Every project the user has, so the assistant can offer to open one by name.
  pub projects: Vec<ProjectSummary>,
  /// Recent activity-journal lines — successes and failures both — inlined into
  /// the turn so the model never has to go looking for the obvious.
  pub recent_activity: String,
  /// What is true right now, from the screen that opened Help.
  pub facts: Vec<String>,
  /// The open personal project's local backend, as the supervisor last
  /// reported it. `None` without one open: team apps don't run on one.
  pub local: Option<LocalStatus>,
  /// Which screen the user is on, so an action that can't work from there is
  /// never offered as a button.
  pub surface: Surface,
  /// Extra files and folders the user attached.
  pub extra_roots: Vec<String>,
}

impl HelpContext {
  /// Assemble the context for a conversation.
  pub fn build(
    app_version: &str,
    project_id: Option<&str>,
    attachments: &[String],
    facts: &[String],
    surface: Surface,
  ) -> Self {
    let status = grounding::status(app_version);
    let project = project_id.and_then(project_context);
    let notes_file = grounding::release_notes_file();

    Self {
      app_version: app_version.to_string(),
      dev_build: cfg!(debug_assertions),
      os: std::env::consts::OS.to_string(),
      source_dir: status.source_ready.then(|| grounding::source_dir().to_string_lossy().into_owned()),
      source_ref: status.reference,
      docs_dir: status.docs_ready.then(|| grounding::docs_dir().to_string_lossy().into_owned()),
      release_notes: notes_file.is_file().then(|| ReleaseNotes {
        path: notes_file.to_string_lossy().into_owned(),
        has_this_version: grounding::notes_cover(app_version),
      }),
      logs_dir: paths::logs_dir().to_string_lossy().into_owned(),
      project,
      projects: all_projects(),
      recent_activity: journal::recent(RECENT_ACTIVITY),
      facts: facts.to_vec(),
      local: None,
      surface,
      extra_roots: attachments.to_vec(),
    }
  }

  /// Whether the open project is a personal one.
  pub fn personal_project(&self) -> bool {
    self.project.as_ref().is_some_and(|p| p.team.is_none())
  }

  /// Whether Help describes and reads the open project's local backend: a
  /// personal one.
  pub fn reads_local_backend(&self) -> bool {
    self.personal_project()
  }

  /// Places inside the roots the session must not read directly: the local
  /// backend's raw output, which Help reads redacted through
  /// `help_local_output` instead.
  pub fn denied(&self) -> Vec<PathBuf> {
    vec![PathBuf::from(&self.logs_dir).join(diagnostics::LOCAL_LOG_DIR)]
  }

  /// Every directory or file the session may read. The permission policy allows
  /// reads under these and denies everything else.
  pub fn roots(&self) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(&self.logs_dir)];
    if let Some(d) = &self.source_dir {
      roots.push(PathBuf::from(d));
    }
    if let Some(d) = &self.docs_dir {
      roots.push(PathBuf::from(d));
    }
    if let Some(notes) = &self.release_notes {
      roots.push(PathBuf::from(&notes.path));
    }
    if let Some(p) = &self.project {
      roots.push(PathBuf::from(&p.path));
    }
    roots.extend(self.extra_roots.iter().map(PathBuf::from));
    roots
  }

  /// The working directory the session runs in. The grounding cache is a
  /// neutral root that always exists and contains nothing the user owns.
  pub fn cwd(&self) -> PathBuf {
    grounding::root()
  }

  /// The orientation paragraph appended to the system frame: where things are,
  /// and what state the app is in.
  pub fn describe(&self) -> String {
    let mut s = String::new();
    s.push_str(&format!("- Fabricator version: {}\n", self.app_version));
    if self.dev_build {
      s.push_str(
        "- This is a development build of Fabricator, run from source. The journal records it \
writes are marked `dev: true`.\n",
      );
    }
    s.push_str(&format!("- Operating system: {}\n", self.os));

    match &self.project {
      Some(p) => {
        s.push_str(&format!("- The user's open project: \"{}\" at `{}`\n", p.name, p.path));
        if p.team.is_some() {
          s.push_str(
            "  It is a **team app**, which works differently from a personal one. It doesn't run on \
a local backend: its preview uses a backend the team's pipeline publishes. It is published by the \
team's pipeline, not from this computer, and access to it is granted to the whole team workspace \
rather than per app. So there is no **Share** control for it: an owner grants access under **App \
access** in the workspace overview. Offer `open-team-access` instead of `share-app`, and say that \
only a workspace owner can grant it.\n",
          );
        } else if p.published {
          s.push_str("  It has been published to Microsoft Fabric.\n");
        } else {
          s.push_str(
            "  It has never been published to Microsoft Fabric. That's fine: it runs on this \
computer, and publishing is optional.\n",
          );
        }
      }
      None => s.push_str("- The user has no project open right now.\n"),
    }

    if self.projects.is_empty() {
      s.push_str("- The user has no projects yet.\n");
    } else {
      s.push_str(
        "- Their projects, with the id to pass as `target` when you offer `open-project`:\n",
      );
      for p in &self.projects {
        let published = if p.published { "published" } else { "never published" };
        s.push_str(&format!("  - \"{}\" — id `{}` ({published})\n", p.name, p.id));
      }
      s.push_str(
        "  Match the user's wording loosely against these names. If exactly one is a plausible \
match, offer `open-project` for it. If several could match, offer `open-home` and name the \
candidates. Never invent an id.\n",
      );
    }

    s.push_str(&format!(
      "- Logs and the activity journal: `{}` (files named `activity-*.jsonl`, `diagnostics-*.jsonl`, \
`main-*.log`). The local backend's output is read with `help_local_output`; its own log files \
there are not readable directly.\n",
      self.logs_dir
    ));

    match &self.docs_dir {
      Some(d) => s.push_str(&format!(
        "- The published documentation, mirrored for offline reading: `{d}`. `llms-full.txt` is \
every page in one file; `llms.txt` is the index with each page's URL. Search these before \
answering a \"how do I\" question.\n"
      )),
      None => s.push_str(
        "- The documentation is not cached on this machine. Answer from the logs and the source, \
and point the user at https://spatney.github.io/rayfin-fabricator/docs.\n",
      ),
    }

    let this_release = grounding::release_page(&self.app_version);
    match &self.release_notes {
      Some(notes) => {
        s.push_str(&format!(
          "- Fabricator's release notes, newest first: `{}`. Each release starts with a \
`# v<version>` heading, then its date and its page. Answer \"what's new\" and \"what changed\" \
questions from these, not from the source or your own knowledge.\n",
          notes.path
        ));
        if notes.has_this_version {
          s.push_str(&format!("  The running version's notes are under `# v{}`.\n", self.app_version));
        } else {
          s.push_str(&format!(
            "  They don't include v{}, the version running now. If it has been released, its \
notes are at {this_release}; fetch that page.\n",
            self.app_version
          ));
        }
      }
      None => s.push_str(&format!(
        "- Fabricator's release notes are not cached on this machine. For \"what's new\" and \
\"what changed\" questions, fetch {this_release} for this version's notes, or {} for every \
release.\n",
        grounding::RELEASES_URL
      )),
    }

    match (&self.source_dir, &self.source_ref) {
      (Some(d), Some(r)) => s.push_str(&format!(
        "- Fabricator's own source code: `{d}` (checked out at `{r}`, matching the running build). \
Use it only to trace a symptom to its cause, and never show it to the user.\n"
      )),
      (Some(d), None) => s.push_str(&format!("- Fabricator's own source code: `{d}`.\n")),
      _ => s.push_str(
        "- Fabricator's source is not cached on this machine, so you can't look up internal \
causes. Work from the logs and the documentation.\n",
      ),
    }

    if !self.extra_roots.is_empty() {
      s.push_str("- The user attached:\n");
      for root in &self.extra_roots {
        s.push_str(&format!("  - `{root}`\n"));
      }
    }

    s
  }
}

/// Look up a project's name and folder from the app's store.
fn project_context(project_id: &str) -> Option<ProjectContext> {
  store::find_project(project_id).map(|p| ProjectContext {
    published: published(&p),
    name: p.name,
    path: p.path,
    team: p.team.map(|t| t.workspace_id),
  })
}

/// Every project the user has, newest-used first as the store holds them.
fn all_projects() -> Vec<ProjectSummary> {
  store::get_state()
    .projects
    .into_iter()
    .map(|p| ProjectSummary { published: published(&p), id: p.id, name: p.name })
    .collect()
}

/// Whether a project has a published app: a publish that never succeeded
/// leaves a record without an address.
fn published(project: &StudioProject) -> bool {
  project.last_deploy.as_ref().and_then(|d| d.url.as_deref()).is_some_and(|url| !url.trim().is_empty())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ctx() -> HelpContext {
    HelpContext {
      app_version: "1.10.0".into(),
      dev_build: false,
      os: "windows".into(),
      source_dir: Some("C:\\cache\\source".into()),
      source_ref: Some("v1.10.0".into()),
      docs_dir: Some("C:\\cache\\docs".into()),
      release_notes: Some(ReleaseNotes {
        path: "C:\\cache\\docs\\release-notes.md".into(),
        has_this_version: true,
      }),
      logs_dir: "C:\\data\\logs".into(),
      project: Some(ProjectContext {
        name: "Contoso Expenses".into(),
        path: "C:\\projects\\contoso".into(),
        team: None,
        published: false,
      }),
      projects: Vec::new(),
      recent_activity: String::new(),
      facts: Vec::new(),
      local: None,
      surface: Surface::Project,
      extra_roots: vec!["C:\\Users\\me\\Desktop\\shot.png".into()],
    }
  }

  #[test]
  fn a_team_app_is_called_out_with_how_its_access_works() {
    let mut c = ctx();
    c.project = Some(ProjectContext {
      name: "Contoso Expenses".into(),
      path: "C:\\projects\\contoso".into(),
      team: Some("ws-1".into()),
      published: false,
    });
    let text = c.describe();
    assert!(text.contains("team app"));
    assert!(text.contains("no **Share** control"), "the missing control is explained, not ignored");
    assert!(text.contains("open-team-access"));
    assert!(text.contains("doesn't run on a local backend"));
    assert!(!c.personal_project(), "Help never describes a team app's local backend");
    assert!(!c.reads_local_backend());
  }

  #[test]
  fn a_personal_project_says_nothing_about_team_access() {
    assert!(!ctx().describe().contains("team app"));
    assert!(ctx().personal_project());
    assert!(ctx().reads_local_backend());
  }

  #[test]
  fn publishing_is_described_as_optional() {
    let mut c = ctx();
    assert!(c.describe().contains("never been published to Microsoft Fabric. That's fine"));
    c.project.as_mut().unwrap().published = true;
    c.projects = vec![
      ProjectSummary { id: "p1".into(), name: "Expenses".into(), published: true },
      ProjectSummary { id: "p2".into(), name: "Notes".into(), published: false },
    ];
    let text = c.describe();
    assert!(text.contains("It has been published to Microsoft Fabric."));
    assert!(text.contains("\"Expenses\" — id `p1` (published)"));
    assert!(text.contains("\"Notes\" — id `p2` (never published)"));
    assert!(!text.contains("deployed"), "the old word is gone: {text}");
  }

  #[test]
  fn a_publish_that_never_succeeded_is_not_a_published_app() {
    let project = |last_deploy: serde_json::Value| -> StudioProject {
      serde_json::from_value(serde_json::json!({
        "id": "p", "name": "Notes", "path": "C:\\apps\\notes", "addedAt": "2026-01-01T00:00:00.000Z",
        "lastDeploy": last_deploy
      }))
      .unwrap()
    };
    assert!(!published(&project(serde_json::Value::Null)));
    assert!(!published(&project(serde_json::json!({ "status": "error", "error": "Tenant not authorized" }))));
    assert!(published(&project(serde_json::json!({ "status": "success", "url": "https://app.fabric.example" }))));
  }

  #[test]
  fn the_local_backend_output_is_read_through_its_tool_only() {
    let c = ctx();
    let denied: Vec<String> = c.denied().iter().map(|p| p.to_string_lossy().into_owned()).collect();
    assert_eq!(denied, [format!("C:\\data\\logs{}local-backend", std::path::MAIN_SEPARATOR)]);
    let text = c.describe();
    assert!(text.contains("`activity-*.jsonl`"));
    assert!(text.contains("read with `help_local_output`"));
  }

  #[test]
  fn a_development_build_says_so() {
    let mut c = ctx();
    assert!(!c.describe().contains("development build"));
    c.dev_build = true;
    assert!(c.describe().contains("This is a development build of Fabricator"));
  }

  #[test]
  fn roots_cover_every_readable_location() {
    let roots = ctx().roots();
    let shown: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    assert!(shown.contains(&"C:\\data\\logs".to_string()));
    assert!(shown.contains(&"C:\\cache\\source".to_string()));
    assert!(shown.contains(&"C:\\cache\\docs".to_string()));
    assert!(shown.contains(&"C:\\cache\\docs\\release-notes.md".to_string()));
    assert!(shown.contains(&"C:\\projects\\contoso".to_string()));
    assert!(shown.contains(&"C:\\Users\\me\\Desktop\\shot.png".to_string()));
  }

  #[test]
  fn the_description_names_the_project_and_the_pinned_source() {
    let text = ctx().describe();
    assert!(text.contains("Contoso Expenses"));
    assert!(text.contains("v1.10.0"));
    assert!(text.contains("never show it to the user"));
  }

  #[test]
  fn a_missing_grounding_is_called_out() {
    let mut c = ctx();
    c.source_dir = None;
    c.source_ref = None;
    c.docs_dir = None;
    c.release_notes = None;
    c.project = None;
    let text = c.describe();
    assert!(text.contains("no project open"));
    assert!(text.contains("documentation is not cached"));
    assert!(text.contains("source is not cached"));
    assert!(text.contains("release notes are not cached"));
    assert!(
      text.contains(&grounding::release_page("1.10.0")),
      "without a mirror, the running version's page is the place to look"
    );
  }

  #[test]
  fn whats_new_is_answered_from_the_release_notes() {
    let text = ctx().describe();
    assert!(text.contains("C:\\cache\\docs\\release-notes.md"));
    assert!(text.contains("\"what's new\""));
    assert!(text.contains("under `# v1.10.0`"), "the running version's section is named");
  }

  #[test]
  fn release_notes_without_this_version_point_at_its_page() {
    // Fetched before the update, and the refresh hasn't reached GitHub yet.
    let mut c = ctx();
    c.release_notes = Some(ReleaseNotes {
      path: "C:\\cache\\docs\\release-notes.md".into(),
      has_this_version: false,
    });
    let text = c.describe();
    assert!(text.contains("don't include v1.10.0"));
    assert!(text.contains(&grounding::release_page("1.10.0")));
    assert!(!text.contains("under `# v1.10.0`"));
  }

  #[test]
  fn roots_shrink_when_grounding_is_missing() {
    let mut c = ctx();
    c.source_dir = None;
    c.docs_dir = None;
    c.release_notes = None;
    c.extra_roots.clear();
    let roots = c.roots();
    assert_eq!(roots.len(), 2, "only the logs and the project remain");
  }
}
