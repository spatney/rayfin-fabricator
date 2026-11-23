//! The events `rayfin-local serve --json` prints on stdout, one JSON object per
//! line (host contract 1, rayfin-local's `docs/embedding.md`). Unknown event
//! types and fields are ignored, as the contract asks of hosts.

use serde::Deserialize;

use crate::types::{
  LocalAnalysis, LocalConfigChanged, LocalFunctions, LocalProblem, LocalReady, LocalSchema, LocalStopped, LocalVite,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
  Starting(Starting),
  Analysis(LocalAnalysis),
  Schema(LocalSchema),
  Functions(LocalFunctions),
  Vite(LocalVite),
  Ready(LocalReady),
  ConfigChanged(LocalConfigChanged),
  Log(Log),
  Warning(LocalProblem),
  Error(LocalProblem),
  Stopped(LocalStopped),
  #[serde(other)]
  Unknown,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Starting {
  pub pid: Option<u32>,
  pub version: Option<String>,
  pub project: Option<ProjectInfo>,
  pub time: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProjectInfo {
  pub root: String,
  pub name: String,
}

/// Output of rayfin-local or one of its children (Vite, the function host, builds).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Log {
  pub source: String,
  pub level: String,
  pub line: String,
  pub time: Option<String>,
}

pub fn parse(line: &str) -> Result<Event, serde_json::Error> {
  serde_json::from_str(line)
}

/// A line for the output log that says what an event reported, as
/// `(level, text)`. `None` for events that are output themselves.
pub fn describe(event: &Event) -> Option<(&'static str, String)> {
  Some(match event {
    Event::Starting(e) => {
      let name = e.project.as_ref().map(|p| p.name.as_str()).filter(|n| !n.is_empty());
      let text = match (e.version.as_deref(), name) {
        (Some(version), Some(name)) => t!("services.localEvents.startingVersion", version = version, name = name),
        (Some(version), None) => t!("services.localEvents.startingAppVersion", version = version),
        (None, Some(name)) => t!("services.localEvents.starting", name = name),
        (None, None) => t!("services.localEvents.startingApp"),
      };
      ("info", text)
    }
    Event::Analysis(a) if a.ok => {
      let count = a.entities.len();
      let text = match a.sdk.as_ref().and_then(|s| s.version.as_deref()) {
        Some(version) => t!("services.localEvents.analyzedSdk", version = version, count = count),
        None => t!("services.localEvents.analyzed", count = count),
      };
      ("info", text)
    }
    Event::Analysis(a) => (
      "error",
      with(
        &a.message,
        || t!("services.localEvents.analysisFailed"),
        |detail| t!("services.localEvents.analysisFailedWhy", detail = detail),
      ),
    ),
    Event::Schema(s) => match s.result.as_str() {
      "applied" if s.losses.is_empty() => ("info", t!("services.localEvents.schemaApplied", changes = s.changes.join(", "))),
      "applied" => (
        "warn",
        t!("services.localEvents.schemaAppliedLost", changes = s.changes.join(", "), losses = s.losses.join(", ")),
      ),
      "refused" => ("warn", t!("services.localEvents.schemaRefused", losses = s.losses.join(", "))),
      "failed" => (
        "error",
        with(
          &s.message,
          || t!("services.localEvents.schemaFailed"),
          |detail| t!("services.localEvents.schemaFailedWhy", detail = detail),
        ),
      ),
      _ => ("info", t!("services.localEvents.schemaCurrent")),
    },
    Event::Functions(f) => match f.state.as_str() {
      "building" => ("info", t!("services.localEvents.functionsBuilding")),
      "ready" if f.names.is_empty() => ("info", t!("services.localEvents.functionsReadyNone")),
      "ready" => ("info", t!("services.localEvents.functionsReady", names = f.names.join(", "))),
      "failed" => ("error", t!("services.localEvents.functionsFailed", errors = f.errors.join(" | "))),
      _ => (
        "info",
        with(
          &f.message,
          || t!("services.localEvents.functionsOff"),
          |detail| t!("services.localEvents.functionsOffWhy", detail = detail),
        ),
      ),
    },
    Event::Vite(v) => match v.state.as_str() {
      "ready" => (
        "info",
        match v.url.as_deref() {
          Some(url) => t!("services.localEvents.viteServing", url = url),
          None => t!("services.localEvents.viteServingApp"),
        },
      ),
      "restarting" => (
        "warn",
        with(
          &v.message,
          || t!("services.localEvents.viteRestarting"),
          |detail| t!("services.localEvents.viteRestartingWhy", detail = detail),
        ),
      ),
      "exited" => (
        "warn",
        with(
          &v.message,
          || t!("services.localEvents.viteStopped"),
          |detail| t!("services.localEvents.viteStoppedWhy", detail = detail),
        ),
      ),
      _ => (
        "error",
        with(
          &v.message,
          || t!("services.localEvents.viteFailed"),
          |detail| t!("services.localEvents.viteFailedWhy", detail = detail),
        ),
      ),
    },
    Event::Ready(r) => (
      "info",
      match r.app_url.as_deref() {
        Some(app) => t!("services.localEvents.readyApp", app = app, api = r.api_url),
        None => t!("services.localEvents.ready", api = r.api_url),
      },
    ),
    Event::ConfigChanged(c) if c.restart_required => (
      "info",
      with(
        &c.message,
        || t!("services.localEvents.configRestart"),
        |detail| t!("services.localEvents.configRestartWhy", detail = detail),
      ),
    ),
    Event::ConfigChanged(c) => ("info", t!("services.localEvents.configApplied", what = c.what.join(", "))),
    Event::Warning(p) => ("warn", problem_line(p)),
    Event::Error(p) => ("error", problem_line(p)),
    Event::Stopped(s) => (
      "info",
      match s.exit_code {
        Some(code) => t!("services.localEvents.stoppedCode", reason = s.reason, code = code),
        None => t!("services.localEvents.stopped", reason = s.reason),
      },
    ),
    Event::Log(_) | Event::Unknown => return None,
  })
}

/// `plain()` without a detail, else `why(detail)`.
fn with(detail: &Option<String>, plain: impl FnOnce() -> String, why: impl FnOnce(&str) -> String) -> String {
  match detail.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
    Some(detail) => why(detail),
    None => plain(),
  }
}

fn problem_line(problem: &LocalProblem) -> String {
  match problem.hint.as_deref().filter(|h| !h.trim().is_empty()) {
    Some(hint) => format!("{} {hint}", problem.message),
    None => problem.message.clone(),
  }
}

#[cfg(test)]
pub(super) mod tests {
  use super::*;

  // The examples in rayfin-local's docs/embedding.md.
  const STARTING: &str = r#"{"v":1,"type":"starting","time":"2026-10-30T03:12:01.000Z","pid":4242,"version":"0.2.0","project":{"root":"C:\\apps\\notes","name":"notes"}}"#;
  const ANALYSIS: &str = r#"{"v":1,"type":"analysis","time":"…","ok":true,"sdk":{"version":"1.36.2","supported":true},"entities":["Note","Tag"],"storageFolders":[],"message":null}"#;
  const SCHEMA: &str = r#"{"v":1,"type":"schema","time":"…","result":"applied","changes":["added Tag","changed Note"],"losses":[],"message":null,"live":false}"#;
  const FUNCTIONS: &str = r#"{"v":1,"type":"functions","time":"…","state":"ready","names":["getBacklog","askAnalyst"],"errors":[],"message":null}"#;
  const VITE: &str = r#"{"v":1,"type":"vite","time":"…","state":"ready","url":"http://localhost:5173/","version":"8.0.16","message":null}"#;
  const READY: &str = r#"{
    "v": 1, "type": "ready", "time": "2026-10-30T03:12:09.512Z",
    "appUrl": "http://localhost:5173/",
    "apiUrl": "http://localhost:7171",
    "embedUrl": "http://localhost:7171/.rayfin-local/portal/embed",
    "portalUrl": "http://localhost:7171/.rayfin-local/portal",
    "dataDir": "C:\\apps\\notes\\.rayfin-local",
    "signInAs": {"kind": "developer"},
    "sdk": {"version": "1.36.2", "supported": true},
    "features": {
      "data": {"enabled": true, "entities": ["Note", "Tag"]},
      "functions": {"enabled": true, "names": ["getBacklog"]},
      "storage": {"enabled": false, "folders": []},
      "auth": {"enabled": true, "fabric": true, "password": false},
      "connectors": [
        {"name": "sales", "type": "fabric-semanticmodel", "supported": true},
        {"name": "logs", "type": "kusto", "supported": false}
      ]
    }
  }"#;
  const CONFIG_CHANGED: &str = r#"{"v":1,"type":"config-changed","time":"…","applied":true,"restartRequired":false,"what":["services","connectors"],"message":null}"#;
  const LOG: &str = r#"{"v":1,"type":"log","time":"…","source":"vite","level":"info","line":"page reload src/App.tsx"}"#;
  pub const FATAL: &str = r#"{"v":1,"type":"error","time":"…","code":"schema-refused","message":"The change would delete data: …","hint":"Restart with --force-schema to apply it, or --reset to start over.","fatal":true,"details":{"losses":["…"]}}"#;
  const STOPPED: &str = r#"{"v":1,"type":"stopped","time":"…","reason":"stdin-closed","exitCode":0}"#;

  #[test]
  fn reads_every_event_of_the_contract() {
    let Event::Starting(starting) = parse(STARTING).unwrap() else { panic!("starting") };
    assert_eq!(starting.pid, Some(4242));
    assert_eq!(starting.version.as_deref(), Some("0.2.0"));
    assert_eq!(starting.project.unwrap().root, r"C:\apps\notes");

    let Event::Analysis(analysis) = parse(ANALYSIS).unwrap() else { panic!("analysis") };
    assert!(analysis.ok);
    assert_eq!(analysis.entities, ["Note", "Tag"]);
    assert_eq!(analysis.sdk.unwrap().version.as_deref(), Some("1.36.2"));

    let Event::Schema(schema) = parse(SCHEMA).unwrap() else { panic!("schema") };
    assert_eq!((schema.result.as_str(), schema.changes.len(), schema.live), ("applied", 2, false));

    let Event::Functions(functions) = parse(FUNCTIONS).unwrap() else { panic!("functions") };
    assert_eq!(functions.names, ["getBacklog", "askAnalyst"]);

    let Event::Vite(vite) = parse(VITE).unwrap() else { panic!("vite") };
    assert_eq!(vite.url.as_deref(), Some("http://localhost:5173/"));

    let Event::Ready(ready) = parse(READY).unwrap() else { panic!("ready") };
    assert_eq!(ready.api_url, "http://localhost:7171");
    assert_eq!(ready.app_url.as_deref(), Some("http://localhost:5173/"));
    assert_eq!(ready.embed_url.as_deref(), Some("http://localhost:7171/.rayfin-local/portal/embed"));
    assert_eq!(ready.sign_in_as.unwrap()["kind"], "developer");
    assert_eq!(ready.features.data.entities, ["Note", "Tag"]);
    assert!(ready.features.auth.fabric && !ready.features.auth.password);
    let kusto = &ready.features.connectors[1];
    assert_eq!((kusto.kind.as_str(), kusto.supported), ("kusto", false));
    assert_eq!(ready.time.as_deref(), Some("2026-10-30T03:12:09.512Z"));

    let Event::ConfigChanged(config) = parse(CONFIG_CHANGED).unwrap() else { panic!("config-changed") };
    assert!(config.applied && !config.restart_required);

    let Event::Log(log) = parse(LOG).unwrap() else { panic!("log") };
    assert_eq!((log.source.as_str(), log.level.as_str(), log.line.as_str()), ("vite", "info", "page reload src/App.tsx"));

    let Event::Error(error) = parse(FATAL).unwrap() else { panic!("error") };
    assert_eq!(error.code, "schema-refused");
    assert!(error.fatal);
    assert_eq!(error.details.unwrap()["losses"][0], "…");

    let Event::Stopped(stopped) = parse(STOPPED).unwrap() else { panic!("stopped") };
    assert_eq!((stopped.reason.as_str(), stopped.exit_code), ("stdin-closed", Some(0)));
  }

  #[test]
  fn ignores_what_it_does_not_know() {
    assert!(matches!(parse(r#"{"v":1,"type":"telemetry","time":"…","x":1}"#).unwrap(), Event::Unknown));
    let Event::Vite(vite) = parse(r#"{"v":1,"type":"vite","state":"ready","hmr":{"port":24678}}"#).unwrap() else {
      panic!("vite")
    };
    assert_eq!((vite.state.as_str(), vite.url), ("ready", None));
    let Event::Ready(ready) = parse(r#"{"v":1,"type":"ready","apiUrl":"http://localhost:7171","appUrl":null}"#).unwrap() else {
      panic!("ready")
    };
    assert_eq!(ready.app_url, None);
    assert!(ready.features.connectors.is_empty());
    assert!(parse("[vite] page reload").is_err());
    assert!(parse(r#"{"v":1}"#).is_err());
  }

  #[test]
  fn describes_events_for_the_output_log() {
    assert_eq!(describe(&parse(SCHEMA).unwrap()).unwrap(), ("info", "Updated the database: added Tag, changed Note.".into()));
    let (level, text) = describe(&parse(FATAL).unwrap()).unwrap();
    assert_eq!(level, "error");
    assert!(text.starts_with("The change would delete data") && text.ends_with("--reset to start over."));
    assert!(describe(&parse(LOG).unwrap()).is_none());
    assert_eq!(describe(&parse(STOPPED).unwrap()).unwrap().1, "Stopped (stdin-closed, exit code 0).");
  }
}
