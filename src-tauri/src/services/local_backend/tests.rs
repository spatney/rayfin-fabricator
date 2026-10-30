//! The supervisor end to end, against a stand-in rayfin-local
//! (`fake_rayfin_local.cjs`, run with the `node` on `PATH`; skipped without one).

use std::sync::Mutex as StdMutex;

use super::*;
use crate::types::LocalIdentityRequest;

pub(super) const FAKE_RAYFIN_LOCAL: &str = include_str!("fake_rayfin_local.cjs");

struct Harness {
  backends: LocalBackends,
  root: PathBuf,
  emitted: Arc<StdMutex<Vec<Emit>>>,
}

impl Drop for Harness {
  fn drop(&mut self) {
    self.backends.kill_all();
    let _ = std::fs::remove_dir_all(&self.root);
  }
}

fn fast() -> Policy {
  Policy {
    stop_grace: Duration::from_millis(1500),
    fatal_grace: Duration::from_millis(1500),
    exit_grace: Duration::from_secs(3),
    crash: CrashPolicy { backoff: vec![Duration::from_millis(50); 3], window: Duration::from_secs(60) },
    max_running: 2,
  }
}

fn harness(policy: Policy) -> Option<Harness> {
  let node = which::which("node").ok()?;
  let root = std::env::temp_dir().join(format!("fab-local-backend-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&root).unwrap();
  let script = root.join("fake-rayfin-local.cjs");
  std::fs::write(&script, FAKE_RAYFIN_LOCAL).unwrap();
  let backends = LocalBackends::new(Settings {
    binary: Some(Binary { program: node, prefix: vec![script.into_os_string()] }),
    log_dir: Some(root.join("logs")),
    policy,
    host_env: false,
  });
  let emitted = Arc::new(StdMutex::new(Vec::new()));
  let sink = emitted.clone();
  backends.set_sink(Arc::new(move |emit| sink.lock().unwrap().push(emit)));
  Some(Harness { backends, root, emitted })
}

impl Harness {
  fn project(&self, name: &str, mode: &str) -> PathBuf {
    let dir = self.root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("fake-mode"), mode).unwrap();
    dir
  }

  async fn until(&self, id: &str, what: &str, done: impl Fn(&LocalStatus) -> bool) -> LocalStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
      let status = self.backends.status(id);
      if done(&status) {
        return status;
      }
      assert!(Instant::now() < deadline, "timed out waiting for {what}: {status:#?}");
      tokio::time::sleep(Duration::from_millis(20)).await;
    }
  }

  async fn running(&self, id: &str) -> LocalStatus {
    self.until(id, "running", |s| s.state == State::Running).await
  }

  /// The states the renderer was told about, without repeats.
  fn states(&self, id: &str) -> Vec<State> {
    let mut states: Vec<State> = Vec::new();
    for emit in self.emitted.lock().unwrap().iter() {
      if let Emit::State(status) = emit {
        if status.project_id == id && states.last() != Some(&status.state) {
          states.push(status.state);
        }
      }
    }
    states
  }

  fn lines(&self, id: &str) -> Vec<LocalLogEvent> {
    self.emitted.lock().unwrap().iter().filter_map(|e| match e {
      Emit::Log(line) if line.project_id == id => Some(line.clone()),
      _ => None,
    }).collect()
  }

  /// The journal entries, as `(event, code)`.
  fn milestones(&self, id: &str) -> Vec<(&'static str, Option<String>)> {
    self.emitted.lock().unwrap().iter().filter_map(|e| match e {
      Emit::Milestone { event, project_id, code, .. } if project_id == id => Some((*event, code.clone())),
      _ => None,
    }).collect()
  }
}

fn starts(dir: &Path) -> u32 {
  std::fs::read_to_string(dir.join("starts")).map(|s| s.trim().parse().unwrap()).unwrap_or(0)
}

fn args_of(dir: &Path, start: u32) -> Vec<String> {
  serde_json::from_str(&std::fs::read_to_string(dir.join(format!("args-{start}.json"))).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_project_answers_its_control_api_and_stops_it_by_closing_stdin() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("notes", "ok");
  let status = h.backends.start("p", dir.clone(), LocalStartOptions::default()).await;
  assert_eq!(status.state, State::Starting);
  let status = h.running("p").await;
  let ready = status.ready.clone().unwrap();
  assert!(ready.api_url.starts_with("http://127.0.0.1:"));
  assert_eq!(ready.features.data.entities, ["Note"]);
  assert_eq!(status.version.as_deref(), Some("9.9.9-fake"));
  assert_eq!(status.schema.unwrap().result, "applied");
  assert!(status.pid.is_some());
  // Starting again is a no-op.
  assert_eq!(h.backends.start("p", dir.clone(), LocalStartOptions::default()).await.state, State::Running);

  // The token reached it: it refuses short ones.
  let token = h.backends.existing("p").unwrap().token().unwrap();
  assert!(token.expose().len() >= 32);
  assert_eq!(h.backends.logs("p", 3).len(), 3);

  let control = h.backends.control("p").unwrap();
  assert!(control.users().await.unwrap().is_empty());
  let ana = control.add_user("ana@example.com", Some("pw")).await.unwrap();
  assert_eq!((ana.id.as_str(), ana.email.as_deref(), ana.sign_in.clone()), ("1", Some("ana@example.com"), vec!["password".to_string()]));
  let conflict = control.add_user("ana@example.com", None).await.unwrap_err();
  assert_eq!((conflict.code.as_str(), conflict.status), ("user-exists", Some(409)));
  let identity = control
    .set_identity(&LocalIdentityRequest { kind: "user".into(), user: Some("ana@example.com".into()), create: None })
    .await
    .unwrap();
  assert_eq!(identity.user.unwrap().username, "ana@example.com");
  assert_eq!(control.identity().await.unwrap().kind, "user");
  assert_eq!(control.entities().await.unwrap()[0].rows, 2);
  let rows = control.rows("Note", 10, 9999, Some("title"), true).await.unwrap();
  assert_eq!(rows.total, 2);
  assert_eq!(rows.columns[0].kind, "int");
  let query = rows.rows[0]["query"].as_str().unwrap();
  assert!(query.contains("offset=10") && query.contains("limit=500") && query.contains("orderBy=title") && query.contains("desc=true"), "{query}");
  assert_eq!(control.clear_rows("Note").await.unwrap(), 2);
  control.reset_data().await.unwrap();
  assert_eq!(control.reload(true).await.unwrap().schema.unwrap().result, "applied");
  control.delete_user("ana@example.com").await.unwrap();
  assert_eq!(control.delete_user("ana@example.com").await.unwrap_err().code, "user-not-found");
  assert_eq!(control.publishable_key().await.unwrap(), "pk_fake");
  let call = |call_as| AppCall { method: reqwest::Method::POST, path: "/graphql".into(), body: Some(serde_json::json!({"query": "{ x }"})), call_as };
  let as_developer: serde_json::Value = serde_json::from_str(&control.call_app(call(CallAs::Developer)).await.unwrap().body).unwrap();
  assert_eq!(as_developer, serde_json::json!({ "auth": "Bearer access-developer", "key": "pk_fake" }));
  let as_user = control.call_app(call(CallAs::User { user: "ana@example.com".into(), create: true })).await.unwrap();
  assert!(as_user.body.contains("Bearer access-ana@example.com"));
  let anonymous = control.call_app(call(CallAs::Anonymous)).await.unwrap();
  assert_eq!((anonymous.status, anonymous.body.contains("\"auth\":null")), (200, true));
  let wrong = ControlClient::new(&ready.api_url, ControlToken::generate()).unwrap();
  assert_eq!(wrong.users().await.unwrap_err().code, "unauthorized");

  let pid = status.pid.unwrap();
  let stopped = h.backends.stop("p").await;
  assert_eq!(stopped.state, State::Stopped);
  assert_eq!(stopped.stopped.as_ref().map(|s| s.reason.as_str()), Some("stdin-closed"), "a graceful stop");
  assert!(stopped.ready.is_none() && stopped.pid.is_none());
  assert!(!h.backends.existing("p").unwrap().is_live());
  assert!(process::wait_for_exit(&[pid], Duration::from_secs(5)).is_empty());
  assert_eq!(h.backends.control("p").unwrap_err().code, "not-running");
  assert_eq!(h.states("p"), [State::Starting, State::Running, State::Stopped]);

  // The token never shows in the output, nor in the log file.
  let lines = h.lines("p");
  assert!(lines.iter().any(|l| l.source == "vite" && l.line == "token check ***"), "{lines:#?}");
  assert!(lines.iter().any(|l| l.source == "stderr" && l.line == "fake stderr with ***"));
  assert!(lines.iter().all(|l| !l.line.contains(token.expose())));
  assert!(lines.windows(2).all(|w| w[0].seq < w[1].seq));
  let file = std::fs::read_to_string(h.root.join("logs").join("p.log")).unwrap();
  assert!(file.contains("token check ***") && !file.contains(token.expose()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fatal_error_waits_for_the_user() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("refused", "fatal");
  h.backends.start("p", dir.clone(), LocalStartOptions::default()).await;
  let status = h.until("p", "the fatal error", |s| s.state == State::Error && !h.backends.existing("p").unwrap().is_live()).await;
  let error = status.error.unwrap();
  assert_eq!(error.code, "schema-refused");
  assert!(error.fatal);
  assert_eq!(error.details.unwrap()["losses"][0], "Note.title (3 values)");
  assert_eq!(status.schema.unwrap().losses, ["Note.title (3 values)"]);
  assert!(h.milestones("p").contains(&("local.failed", Some("schema-refused".into()))), "the journal has the code");
  tokio::time::sleep(Duration::from_millis(300)).await;
  assert_eq!(starts(&dir), 1, "no automatic restart");

  // The user applies the change: a fresh start with --force-schema.
  std::fs::write(dir.join("fake-mode"), "ok").unwrap();
  let options = LocalStartOptions { force_schema: true, ..Default::default() };
  h.backends.restart("p", dir.clone(), options).await;
  let status = h.running("p").await;
  assert_eq!(status.error, None);
  assert!(args_of(&dir, 2).contains(&"--force-schema".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn already_serving_explains_who_and_only_rayfin_local_is_stopped() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("locked", "already-serving");
  h.backends.start("p", dir, LocalStartOptions::default()).await;
  let status = h.until("p", "already-serving", |s| s.state == State::Error).await;
  let error = status.error.unwrap();
  assert_eq!(error.code, "already-serving");
  assert_eq!(error.details.unwrap()["pid"], 999_999);

  let mut other = std::process::Command::new(which::which("node").unwrap())
    .args(["-e", "setTimeout(() => {}, 20000)"])
    .spawn()
    .unwrap();
  let refused = h.backends.stop_external("p", other.id()).await.unwrap_err();
  assert_eq!(refused.code, "not-rayfin-local");
  assert!(process::is_alive(other.id()));
  let _ = other.kill();
  let _ = other.wait();
  assert_eq!(h.backends.stop_external("p", std::process::id()).await.unwrap_err().code, "invalid");
}

#[tokio::test(flavor = "multi_thread")]
async fn crashes_restart_with_backoff_then_give_up() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("crashy", "crash");
  h.backends.start("p", dir.clone(), LocalStartOptions::default()).await;
  let status = h.until("p", "giving up", |s| s.state == State::Error).await;
  let error = status.error.unwrap();
  assert_eq!(error.code, "crashed");
  assert_eq!(error.details.unwrap()["exitCode"], 3);
  assert_eq!(status.crashes, 4);
  assert_eq!(starts(&dir), 4, "the first run and three restarts");
  assert!(h.states("p").contains(&State::Restarting));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_restarts_and_keeps_the_sign_in_but_not_one_time_options() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("once", "crash-once");
  let options = LocalStartOptions { force_schema: true, reset: true, sign_in_as: Some("user:ana@example.com".into()) };
  h.backends.start("p", dir.clone(), options).await;
  let status = h.until("p", "the restart", |s| s.state == State::Running && starts(&dir) == 2).await;
  assert_eq!(status.crashes, 1);
  assert_eq!(status.error, None);
  let first = args_of(&dir, 1);
  assert!(first.contains(&"--reset".to_string()) && first.contains(&"--force-schema".to_string()));
  let second = args_of(&dir, 2);
  assert!(!second.contains(&"--reset".to_string()) && !second.contains(&"--force-schema".to_string()), "{second:?}");
  assert!(second.windows(2).any(|w| w == ["--sign-in-as", "user:ana@example.com"]));

  // An identity set through the control API is what a restart signs in as.
  let identity = LocalIdentity { kind: "none".into(), user: None };
  h.backends.remember_sign_in("p", sign_in_flag(&identity, None));
  h.backends.restart("p", dir.clone(), LocalStartOptions::default()).await;
  h.until("p", "the third start", |s| s.state == State::Running && starts(&dir) == 3).await;
  assert!(args_of(&dir, 3).windows(2).any(|w| w == ["--sign-in-as", "none"]));
  assert_eq!(h.backends.status("p").sign_in_as.as_deref(), Some("none"));
}

#[test]
fn identities_map_to_sign_in_flags() {
  let user = crate::types::LocalUser { username: "ana@example.com".into(), ..Default::default() };
  let identity = |kind: &str, user: Option<crate::types::LocalUser>| LocalIdentity { kind: kind.into(), user };
  assert_eq!(sign_in_flag(&identity("user", Some(user)), None).as_deref(), Some("user:ana@example.com"));
  assert_eq!(sign_in_flag(&identity("user", None), Some("bo")).as_deref(), Some("user:bo"));
  assert_eq!(sign_in_flag(&identity("developer", None), None).as_deref(), Some("developer"));
  assert_eq!(sign_in_flag(&identity("none", None), None).as_deref(), Some("none"));
  assert_eq!(sign_in_flag(&identity("future", None), None), None);
  assert!(valid_sign_in("user:ana") && !valid_sign_in("user:") && !valid_sign_in("everyone"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_config_change_that_needs_a_restart_gets_one() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("moved", "config-restart");
  h.backends.start("p", dir.clone(), LocalStartOptions::default()).await;
  let status = h.until("p", "the restart", |s| s.state == State::Running && starts(&dir) == 2).await;
  assert_eq!(status.crashes, 0);
  let states = h.states("p");
  assert_eq!(states, [State::Starting, State::Running, State::Restarting, State::Starting, State::Running]);
}

#[tokio::test(flavor = "multi_thread")]
async fn other_projects_keep_off_a_running_backends_ports_until_it_is_forgotten() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("notes", "ok");
  h.backends.start("a", dir, LocalStartOptions::default()).await;
  let status = h.running("a").await;
  assert_eq!(h.milestones("a"), [("local.started", None)]);
  let api_port = tauri::Url::parse(&status.ready.unwrap().api_url).unwrap().port().unwrap();
  assert!(h.backends.held_ports("b").contains(&(api_port, "a".to_string())));
  assert!(h.backends.held_ports("a").is_empty(), "its own ports are its own");

  // Removing the project stops its backend and forgets it.
  let pid = status.pid.unwrap();
  h.backends.forget("a").await;
  assert!(process::wait_for_exit(&[pid], Duration::from_secs(5)).is_empty());
  assert!(h.backends.existing("a").is_none());
  assert_eq!(h.backends.status("a").state, State::Stopped);
  assert!(h.backends.held_ports("b").is_empty());
  h.backends.forget("never-started").await;
}

#[test]
fn packages_install_only_in_folders_of_the_project() {
  let root = std::env::temp_dir().join(format!("fab-local-install-{}", uuid::Uuid::new_v4()));
  let project = root.join("app");
  std::fs::create_dir_all(project.join("rayfin").join("functions")).unwrap();
  std::fs::create_dir_all(root.join("elsewhere")).unwrap();
  std::fs::write(project.join("rayfin").join("functions").join("package.json"), "{}").unwrap();
  std::fs::write(root.join("elsewhere").join("package.json"), "{}").unwrap();
  let functions = project.join("rayfin").join("functions");
  assert_eq!(folder_within(&project, &functions), Some(functions.clone()));
  assert_eq!(folder_within(&project, Path::new("rayfin/functions")), Some(functions));
  assert_eq!(folder_within(&project, &root.join("elsewhere")), None, "outside the project");
  assert_eq!(folder_within(&project, &project.join("..").join("elsewhere")), None);
  assert_eq!(folder_within(&project, &project.join("rayfin")), None, "no package.json");
  let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_backend_that_ignores_stdin_is_killed_after_the_grace_period() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("stubborn", "ignore-stdin");
  h.backends.start("p", dir, LocalStartOptions::default()).await;
  let pid = h.running("p").await.pid.unwrap();
  let began = Instant::now();
  let status = h.backends.stop("p").await;
  assert!(began.elapsed() >= Duration::from_millis(1400), "it waited for the grace period");
  assert_eq!(status.state, State::Stopped);
  assert!(process::wait_for_exit(&[pid], Duration::from_secs(5)).is_empty());
  assert!(h.lines("p").iter().any(|l| l.line.contains("didn't stop in time")));
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_two_most_recently_used_running_and_kills_all_on_exit() {
  let Some(h) = harness(fast()) else { return };
  for id in ["a", "b"] {
    let dir = h.project(id, "ok");
    h.backends.start(id, dir, LocalStartOptions::default()).await;
    h.running(id).await;
  }
  let dir = h.project("c", "ok");
  h.backends.start("c", dir, LocalStartOptions::default()).await;
  h.running("c").await;
  h.until("a", "eviction", |s| s.state == State::Stopped).await;
  assert_eq!(h.backends.status("b").state, State::Running);

  let pids = h.backends.owned_pids();
  assert_eq!(pids.len(), 2);
  h.backends.kill_all();
  assert!(process::wait_for_exit(&pids, Duration::from_secs(5)).is_empty());
  for id in ["b", "c"] {
    h.until(id, "the exit stop", |s| s.state == State::Stopped).await;
  }
  // Nothing starts while Fabricator exits.
  assert_eq!(h.backends.start("a", h.root.join("a"), LocalStartOptions::default()).await.state, State::Stopped);
}

#[tokio::test(flavor = "multi_thread")]
async fn local_secret_values_go_through_stdin_only() {
  let Some(h) = harness(fast()) else { return };
  let dir = h.project("secrets", "ok");
  assert_eq!(h.backends.secrets(&dir).await.unwrap()[0].source, "none");
  h.backends.set_secret(&dir, "API_KEY", "s3cr3t-value").await.unwrap();
  let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("secrets.json")).unwrap()).unwrap();
  assert_eq!(saved["API_KEY"], "s3cr3t-value");
  let args = std::fs::read_to_string(dir.join("secret-args.json")).unwrap();
  assert!(!args.contains("s3cr3t-value"), "{args}");
  assert_eq!(h.backends.secrets(&dir).await.unwrap()[0].source, "local");
  let empty = h.backends.set_secret(&dir, "API_KEY", "").await.unwrap_err();
  assert_eq!(empty.code, "cli-failed");
  assert!(empty.message.contains("is empty"), "{}", empty.message);
  h.backends.delete_secret(&dir, "API_KEY").await.unwrap();
  assert_eq!(h.backends.secrets(&dir).await.unwrap()[0].source, "none");
}

#[test]
fn output_is_masked_before_the_ring_and_the_file_keep_it() {
  let dir = std::env::temp_dir().join(format!("fab-local-backend-{}", uuid::Uuid::new_v4()));
  let rt = Runtime::new("p", Some(&dir), Arc::new(RwLock::new(None)));
  let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
  rt.log("functions", "info", &format!("calling Fabric with Bearer {jwt}"), None);
  rt.log("rayfin-local", "info", "publishable key pk-local-AbC123dEf456GhI789jKl012", None);
  rt.log("vite", "info", "ready in 412 ms", None);
  let kept: Vec<String> = rt.recent(10).into_iter().map(|l| l.line).collect();
  assert_eq!(kept, ["calling Fabric with Bearer [redacted]", "publishable key pk-local-***", "ready in 412 ms"]);
  let [_, current] = log_files(&dir, "p");
  let file = std::fs::read_to_string(current).unwrap();
  assert!(file.contains("calling Fabric with Bearer [redacted]") && file.contains("pk-local-***"), "{file}");
  assert!(!file.contains(jwt) && !file.contains("AbC123"), "{file}");
  let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_or_incompatible_binary_is_an_error_state() {
  let root = std::env::temp_dir().join(format!("fab-local-backend-{}", uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&root).unwrap();
  let backends = LocalBackends::new(Settings {
    binary: Some(Binary::executable(root.join("missing-rayfin-local.exe"))),
    log_dir: Some(root.join("logs")),
    policy: fast(),
    host_env: false,
  });
  let status = backends.start("p", root.clone(), LocalStartOptions::default()).await;
  assert_eq!(status.state, State::Error);
  assert_eq!(status.error.unwrap().code, "binary-missing");
  assert!(!backends.existing("p").unwrap().is_live());

  if let Ok(node) = which::which("node") {
    // A release before the contract: `version` is an unknown command.
    let old = root.join("old.cjs");
    std::fs::write(&old, "if (process.argv.includes('--version')) console.log('rayfin-local 0.1.0'); else { console.error(\"error: unrecognized subcommand 'version'\"); process.exitCode = 2 }").unwrap();
    let backends = LocalBackends::new(Settings {
      binary: Some(Binary { program: node, prefix: vec![old.into_os_string()] }),
      log_dir: Some(root.join("logs")),
      policy: fast(),
      host_env: false,
    });
    let error = backends.start("p", root.clone(), LocalStartOptions::default()).await.error.unwrap();
    assert_eq!(error.code, "binary-too-old");
    assert!(error.message.contains("too old (0.1.0)"), "{}", error.message);
    assert_eq!(backends.secrets(&root).await.unwrap_err().code, "binary-too-old");
  }
  let _ = std::fs::remove_dir_all(&root);
}

/// The bundled (or [`binary::BIN_ENV`]) rayfin-local on a real project, through
/// the same supervisor and control client the app uses. Opt in:
/// `FABRICATOR_RAYFIN_LOCAL_BIN=<rayfin-local> FABRICATOR_LOCAL_SMOKE_PROJECT=<a copy of a Rayfin project>
/// cargo test --lib live_smoke -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a rayfin-local and a Rayfin project"]
async fn live_smoke_against_a_real_rayfin_local() {
  let Some(project) = std::env::var_os("FABRICATOR_LOCAL_SMOKE_PROJECT") else {
    eprintln!("Set FABRICATOR_LOCAL_SMOKE_PROJECT (and {}) to run this.", binary::BIN_ENV);
    return;
  };
  let dir = PathBuf::from(project);
  let logs = std::env::temp_dir().join(format!("fab-local-smoke-{}", uuid::Uuid::new_v4()));
  let backends = LocalBackends::new(Settings { binary: None, log_dir: Some(logs.clone()), policy: Policy::default(), host_env: true });
  backends.set_sink(Arc::new(|emit| match emit {
    Emit::State(s) => eprintln!("[state] {:?} phase={:?} error={:?}", s.state, s.phase, s.error.map(|e| e.code)),
    Emit::Log(l) => eprintln!("[{}/{}] {}", l.source, l.level, l.line),
    Emit::Milestone { event, message, .. } => eprintln!("[journal] {event}: {message}"),
  }));

  let began = Instant::now();
  backends.start("smoke", dir.clone(), LocalStartOptions::default()).await;
  let status = loop {
    let status = backends.status("smoke");
    if matches!(status.state, State::Running | State::Error) || began.elapsed() > Duration::from_secs(300) {
      break status;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
  };
  eprintln!("[smoke] {:?} after {:.1} s", status.state, began.elapsed().as_secs_f32());
  assert_eq!(status.state, State::Running, "{status:#?}");
  let ready = status.ready.clone().unwrap();
  eprintln!("[smoke] ready: {}", serde_json::to_string_pretty(&ready).unwrap());
  let token = backends.existing("smoke").unwrap().token().unwrap();

  let control = backends.control("smoke").unwrap();
  eprintln!("[smoke] identity: {:?}", control.identity().await);
  eprintln!("[smoke] users: {:?}", control.users().await.map(|u| u.len()));
  let name = format!("smoke-{}@example.com", &uuid::Uuid::new_v4().simple().to_string()[..8]);
  eprintln!("[smoke] add user: {:?}", control.add_user(&name, None).await.map(|u| u.username));
  let request = crate::types::LocalIdentityRequest { kind: "user".into(), user: Some(name.clone()), create: Some(true) };
  eprintln!("[smoke] set identity: {:?}", control.set_identity(&request).await.map(|i| i.kind));
  let developer = crate::types::LocalIdentityRequest { kind: "developer".into(), ..Default::default() };
  eprintln!("[smoke] back to developer: {:?}", control.set_identity(&developer).await.map(|i| i.kind));
  eprintln!("[smoke] delete user: {:?}", control.delete_user(&name).await);
  eprintln!("[smoke] entities: {:?}", control.entities().await);
  eprintln!("[smoke] reload: {:?}", control.reload(false).await.map(|r| r.schema.map(|s| s.result)));
  eprintln!("[smoke] publishable key present: {:?}", control.publishable_key().await.map(|k| !k.is_empty()));
  let call = AppCall {
    method: reqwest::Method::POST,
    path: "/graphql".into(),
    body: Some(serde_json::json!({ "query": "{ __typename }" })),
    call_as: CallAs::Developer,
  };
  eprintln!("[smoke] graphql as developer: {:?}", control.call_app(call).await.map(|r| (r.status, r.body.chars().take(200).collect::<String>())));
  eprintln!("[smoke] secrets: {:?}", backends.secrets(&dir).await);

  let stopped = backends.stop("smoke").await;
  eprintln!("[smoke] stopped: {:?}", stopped.stopped);
  assert_eq!(stopped.state, State::Stopped);
  assert_eq!(stopped.stopped.map(|s| s.reason).as_deref(), Some("stdin-closed"));
  let file = std::fs::read_to_string(logs.join("smoke.log")).unwrap();
  assert!(!file.contains(token.expose()));
  let _ = std::fs::remove_dir_all(&logs);
}
