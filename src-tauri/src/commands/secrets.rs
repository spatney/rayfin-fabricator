//! Function secrets (API keys, connection strings, tokens) for a project's
//! published Rayfin app, managed through the project's own Rayfin CLI:
//! `rayfin secret list|set|delete --json`.
//!
//! Values are write-only. Fabricator hands a value to `rayfin secret set --stdin`
//! (never in the arguments, which other processes on the machine can read) and
//! keeps no copy; neither the CLI nor the published app ever returns one. Names and
//! descriptions live in `rayfin/rayfin.yml`, which the CLI updates together with
//! the generated `secrets.generated.ts` that types `ctx.Secrets` in functions.
//! Fabricator commits just those files when the CLI changes them, so History
//! records "Add secret: NAME" the way it records skills.
//!
//! Every personal app also runs on this computer, where rayfin-local gives the
//! functions each declared secret's local value (`commands::local`). An app that
//! hasn't been published has no published values, but secrets can still be
//! added: [`secrets_declare`] records a name in `rayfin.yml` with the code the CLI's
//! `secret set` runs, and its value goes to rayfin-local.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::commands::rayfin_version::parse_core;
use crate::services::exec::{self, RunOptions};
use crate::services::{fabric_auth, git, store};
use crate::state::AppState;
use crate::types::{SecretActionResult, SecretEnvironment, SecretInfo, SecretsState, StudioProject, TeamDeployRecord};

/// The oldest Rayfin CLI whose secret commands Fabricator drives: `secret set`
/// reads the value from stdin, `secret delete` also updates `rayfin.yml`, and
/// functions (generally available from this release) read typed `ctx.Secrets`.
pub const MIN_RAYFIN: &str = "1.36.0";
const MIN_RAYFIN_LABEL: &str = "1.36";

/// The description the CLI records when none is given. Not worth showing.
const PLACEHOLDER: &str = "TODO: Add description for this secret";

/// Where the functions package lives unless `services.functions.path` says otherwise.
const DEFAULT_FUNCTIONS_PATH: &str = "rayfin/functions";

/// Each command signs in and calls Fabric, with the CLI's own retries.
const CLI_TIMEOUT_MS: u64 = 120_000;

const TIMED_OUT: &str = "The Rayfin CLI didn't finish in time. Check your connection, then try again.";

const NOT_DEPLOYED: &str = "Publish your app first. Published values are stored with the published app.";

const MAX_DESCRIPTION: usize = 200;

/// Adding a name to `rayfin.yml` is local: Node starts, and the CLI's helpers run.
const DECLARE_TIMEOUT_MS: u64 = 30_000;

/// Adds a secret to `rayfin.yml` with the app's own Rayfin CLI, as its `secret
/// set` does once the published app has stored the value: `upsertSecretMetadata`,
/// then `generateSecretsTypes` for `ctx.Secrets`. Its arguments are the CLI's
/// folder, the project's, the name and the description (empty for none). Prints
/// one JSON line.
const DECLARE_SCRIPT: &str = r#"
const [cli, root, name, description] = process.argv.slice(1);
const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
const load = (file) => import(pathToFileURL(join(cli, 'dist', 'utils', file)).href);
const say = (result) => console.log(JSON.stringify(result));
try {
  const { upsertSecretMetadata } = await load('config-utils.js');
  const added = upsertSecretMetadata(name, root, description || undefined);
  if (added.status === 'added' || added.status === 'exists') {
    let types = 'skipped';
    try {
      types = (await load('secrets-types-generator.js')).generateSecretsTypes(root).status;
    } catch {
      types = 'failed';
    }
    say({ status: 'success', declared: added.status, types });
  } else {
    say({ status: 'error', reason: added.reason ?? added.status });
    process.exitCode = 1;
  }
} catch (error) {
  say({ status: 'error', error: String(error?.message ?? error) });
  process.exitCode = 1;
}
"#;

/// Check a secret name: it becomes a property of `ctx.Secrets` and of the
/// generated TypeScript, so it has to be a plain identifier.
pub fn validate_name(name: &str) -> Result<(), String> {
  static NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_]*$").unwrap());
  if name.is_empty() {
    return Err("Enter a name for the secret.".into());
  }
  if name.len() > 128 {
    return Err("Use a name of 128 characters or fewer.".into());
  }
  if !NAME.is_match(name) {
    return Err("Start the name with a letter, then use only letters, numbers and underscores.".into());
  }
  Ok(())
}

/// What `rayfin/rayfin.yml` says about secrets and functions.
#[derive(Debug, Default, PartialEq)]
struct Config {
  /// Declared secrets in file order: (name, description).
  declared: Vec<(String, Option<String>)>,
  functions_enabled: bool,
  /// `services.functions.path`, when set.
  functions_path: Option<String>,
}

fn parse_config(text: &str) -> Config {
  let value: serde_yaml::Value = serde_yaml::from_str(text).unwrap_or(serde_yaml::Value::Null);
  let mut declared: Vec<(String, Option<String>)> = Vec::new();
  for entry in value.get("secrets").and_then(|s| s.as_sequence()).into_iter().flatten() {
    let Some(name) = entry.get("name").and_then(|n| n.as_str()).map(str::trim).filter(|n| !n.is_empty()) else {
      continue;
    };
    if declared.iter().any(|(known, _)| known == name) {
      continue;
    }
    let description = entry
      .get("description")
      .and_then(|d| d.as_str())
      .map(str::trim)
      .filter(|d| !d.is_empty() && *d != PLACEHOLDER)
      .map(String::from);
    declared.push((name.to_string(), description));
  }
  let functions = value.get("services").and_then(|s| s.get("functions"));
  Config {
    declared,
    functions_enabled: functions.and_then(|f| f.get("enabled")).and_then(|e| e.as_bool()).unwrap_or(false),
    functions_path: functions
      .and_then(|f| f.get("path"))
      .and_then(|p| p.as_str())
      .map(|p| p.trim().replace('\\', "/").trim_end_matches('/').to_string())
      .filter(|p| !p.is_empty()),
  }
}

fn read_config(dir: &Path) -> Config {
  std::fs::read_to_string(dir.join("rayfin").join("rayfin.yml"))
    .map(|text| parse_config(&text))
    .unwrap_or_default()
}

/// The names of the secrets the app in `dir` declares, in file order.
pub(crate) fn declared_names(dir: &Path) -> Vec<String> {
  read_config(dir).declared.into_iter().map(|(name, _)| name).collect()
}

/// The names of the secrets a `rayfin.yml` declares, in file order.
pub(crate) fn declared_names_in(rayfin_yml: &str) -> Vec<String> {
  parse_config(rayfin_yml).declared.into_iter().map(|(name, _)| name).collect()
}

/// The version of the app's own Rayfin CLI, the one Fabricator runs.
fn installed_version(dir: &Path) -> Option<String> {
  let text = std::fs::read_to_string(dir.join("node_modules/@microsoft/rayfin-cli/package.json")).ok()?;
  let package: Value = serde_json::from_str(&text).ok()?;
  package.get("version")?.as_str().map(String::from)
}

fn supported(version: &str) -> bool {
  parse_core(Some(version)).is_some_and(|v| Some(v) >= parse_core(Some(MIN_RAYFIN)))
}

/// Why this app's secrets can't be managed from here: `(status, message)`.
fn unavailable(project: &StudioProject, version: Option<&str>) -> Option<(&'static str, String)> {
  if project.team.is_some() {
    return Some((
      "team",
      "Fabricator can’t change a team app’s secrets yet. Change them in the Fabric portal.".into(),
    ));
  }
  if !version.is_some_and(supported) {
    return Some((
      "update-rayfin",
      format!(
        "Secrets need Rayfin {MIN_RAYFIN_LABEL} or newer. Select Rayfin in the status bar and choose Update with Copilot."
      ),
    ));
  }
  None
}

/// A description the CLI can store in `rayfin.yml`: one line, never empty.
fn description_arg(description: Option<&str>) -> Option<String> {
  let flat = description?.split_whitespace().collect::<Vec<_>>().join(" ");
  let clipped: String = flat.chars().take(MAX_DESCRIPTION).collect();
  (!clipped.is_empty()).then_some(clipped)
}

/// The project files `secret set`/`delete` rewrite: `rayfin.yml` and the
/// generated types. A functions path outside the project is left alone.
fn tracked_paths(config: &Config) -> Vec<String> {
  let mut paths = vec!["rayfin/rayfin.yml".to_string()];
  let functions = config.functions_path.as_deref().unwrap_or(DEFAULT_FUNCTIONS_PATH);
  let inside = !Path::new(functions).is_absolute()
    && !functions.starts_with('/')
    && !functions.contains(':')
    && !functions.split('/').any(|part| part == "..");
  if inside {
    paths.push(format!("{functions}/src/secrets.generated.ts"));
  }
  paths
}

/// The last stdout line that parses as a JSON object: the CLI's `--json` result.
fn json_result(stdout: &str) -> Option<Value> {
  stdout
    .lines()
    .rev()
    .map(str::trim)
    .filter(|line| line.starts_with('{'))
    .find_map(|line| serde_json::from_str::<Value>(line).ok().filter(Value::is_object))
}

/// Why a CLI call failed.
#[derive(Debug, PartialEq)]
struct Failure {
  message: String,
  /// The app has no deployment for secrets to live on.
  not_deployed: bool,
  /// The Fabric sign-in needs refreshing.
  sign_in: bool,
}

/// The last useful stderr line (Node's own warnings aren't the error).
fn stderr_error(stderr: &str) -> Option<String> {
  stderr
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty() && !line.starts_with("(node:") && !line.starts_with("(Use `node"))
    .next_back()
    .map(|line| line.chars().take(400).collect())
}

/// The CLI's JSON result on success, or why it failed.
fn outcome(res: &exec::RunResult) -> Result<Value, Failure> {
  static NOT_DEPLOYED: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)no remote endpoint configured|construct secrets endpoint").unwrap());
  let json = json_result(&res.stdout);
  if res.ok {
    if let Some(value) = json.as_ref().filter(|v| v.get("status").and_then(Value::as_str) == Some("success")) {
      return Ok(value.clone());
    }
  }
  let message = json
    .as_ref()
    .and_then(|v| v.get("error"))
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|m| !m.is_empty())
    .map(String::from)
    .or_else(|| stderr_error(&res.stderr))
    .unwrap_or_else(|| {
      if res.not_found {
        "Node.js was not found on PATH.".into()
      } else if res.ok {
        "The Rayfin CLI didn't confirm the change.".into()
      } else if let Some(code) = res.exit_code {
        format!("The Rayfin CLI failed (exit code {code}).")
      } else {
        TIMED_OUT.into()
      }
    });
  let message = fabric_auth::redact(&message);
  let not_deployed = NOT_DEPLOYED.is_match(&message);
  let sign_in = !not_deployed && needs_sign_in(&message);
  Err(Failure { message, not_deployed, sign_in })
}

/// Whether an error means the Fabric sign-in needs refreshing.
fn needs_sign_in(message: &str) -> bool {
  fabric_auth::failure_flags(message).0
    || message.contains("rayfin login")
    || message.contains("Sign in to Fabric again")
}

struct Stored {
  name: String,
  description: Option<String>,
  created_at: Option<String>,
  updated_at: Option<String>,
}

/// Secrets from `rayfin secret list --json` (`secrets`) or the Fabric API (a
/// bare array, or `value`).
fn parse_stored(result: &Value) -> Vec<Stored> {
  let text = |entry: &Value, key: &str| {
    entry.get(key).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(String::from)
  };
  let entries = result
    .as_array()
    .or_else(|| result.get("secrets").and_then(Value::as_array))
    .or_else(|| result.get("value").and_then(Value::as_array));
  entries
    .into_iter()
    .flatten()
    .filter_map(|entry| {
      Some(Stored {
        name: text(entry, "name")?,
        description: text(entry, "description").filter(|d| d != PLACEHOLDER),
        created_at: text(entry, "createdAt"),
        updated_at: text(entry, "updatedAt"),
      })
    })
    .collect()
}

/// Every secret the app knows about: declared in `rayfin.yml`, stored on the
/// published app, or both. Sorted by name.
fn merge(declared: &[(String, Option<String>)], stored: &[Stored]) -> Vec<SecretInfo> {
  let mut list: Vec<SecretInfo> = declared
    .iter()
    .map(|(name, description)| {
      let remote = stored.iter().find(|s| &s.name == name);
      SecretInfo {
        name: name.clone(),
        description: description.clone().or_else(|| remote.and_then(|s| s.description.clone())),
        declared: true,
        stored: remote.is_some(),
        created_at: remote.and_then(|s| s.created_at.clone()),
        updated_at: remote.and_then(|s| s.updated_at.clone()),
      }
    })
    .collect();
  for remote in stored {
    if !list.iter().any(|s| s.name == remote.name) {
      list.push(SecretInfo {
        name: remote.name.clone(),
        description: remote.description.clone(),
        declared: false,
        stored: true,
        created_at: remote.created_at.clone(),
        updated_at: remote.updated_at.clone(),
      });
    }
  }
  list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
  list
}

fn is_guid(text: &str) -> bool {
  static GUID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").unwrap());
  GUID.is_match(text)
}

/// The (workspace, item) a team deployment record points at. The pipeline
/// records them; anything that isn't a plain id is ignored.
fn team_target(record: Option<&TeamDeployRecord>) -> Option<(&str, &str)> {
  let record = record?;
  let workspace = record.workspace_id.as_deref().filter(|id| is_guid(id))?;
  let item = record.item_id.as_deref().filter(|id| is_guid(id))?;
  Some((workspace, item))
}

/// A team app's deployment and its secrets, read as the signed-in Azure user.
/// Team apps are deployed by their pipeline, so this only reads. `record` is
/// the latest deployment; `repo` (`owner/name`) finds the live app when that
/// deployment failed.
async fn team_environment(
  kind: &str,
  record: Option<&TeamDeployRecord>,
  repo: Option<&str>,
  declared: &[(String, Option<String>)],
) -> SecretEnvironment {
  // A failed run records no app, but the one an earlier run deployed is still live.
  let earlier = match (record, repo) {
    (Some(latest), Some(repo)) if team_target(Some(latest)).is_none() && !latest.environment.is_empty() => {
      crate::services::team::gh::last_deployed(repo, &latest.environment).await.ok().flatten()
    }
    _ => None,
  };
  let record = earlier.as_ref().or(record);
  let mut environment = SecretEnvironment {
    kind: kind.into(),
    portal_url: record.and_then(|r| r.portal_url.clone()).filter(|url| url.starts_with("https://")),
    ..Default::default()
  };
  let Some((workspace, item)) = team_target(record) else {
    return environment;
  };
  environment.deployed = true;
  match crate::services::team::fabric::app_secrets(workspace, item).await {
    Ok(result) => environment.secrets = merge(declared, &parse_stored(&result)),
    Err(error) => environment.error = Some(fabric_auth::redact(&error.describe("Couldn't read the secrets"))),
  }
  environment
}

/// Whether the app has been published, so its secrets have published values, by
/// the CLI's own rule: an entry in `rayfin/.deployments.json` with a workspace
/// and an item (`rayfin init` can record a workspace before anything is deployed).
fn has_deployment(dir: &Path) -> bool {
  let registry = std::fs::read_to_string(dir.join("rayfin").join(".deployments.json"))
    .ok()
    .and_then(|text| serde_json::from_str::<Value>(&text).ok());
  let set = |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).is_some_and(|v| !v.is_empty());
  registry
    .as_ref()
    .and_then(|r| r.get("deployments"))
    .and_then(Value::as_object)
    .is_some_and(|all| all.values().any(|entry| set(entry, "fabricWorkspaceId") && set(entry, "fabricItemId")))
}

/// Run `cli`, a `rayfin secret` call, once the CLI's Fabric sign-in is known to
/// work, and keep the sign-in from changing until it finishes, as deploys do.
/// When its sign-in has expired, the CLI's secret commands open a browser to
/// sign in again and wait for it; the list runs as soon as the tab opens. So
/// Fabricator checks first, without a browser, and reports an expired sign-in.
async fn with_sign_in<T>(dir: &Path, cli: impl Future<Output = Result<T, Failure>>) -> Result<T, Failure> {
  // Without a published app, the CLI stops before it signs in: that's the
  // problem to report, and Fabric (and its sign-in) isn't needed to find it.
  if !has_deployment(dir) {
    return Err(Failure { message: NOT_DEPLOYED.into(), not_deployed: true, sign_in: false });
  }
  let _auth = crate::commands::auth::rayfin_auth_read().await;
  if let Err(error) = crate::commands::fabric::probe_rayfin_auth(Some(dir)).await {
    let message = fabric_auth::redact(&error);
    return Err(Failure { sign_in: needs_sign_in(&message), message, not_deployed: false });
  }
  // `cli` doesn't start until it's awaited here.
  cli.await
}

async fn run_cli(dir: &Path, args: &[&str], stdin: Option<String>) -> Result<Value, Failure> {
  let started = Instant::now();
  let res = exec::run_project_rayfin(
    dir,
    args,
    RunOptions { stdin, timeout_ms: Some(CLI_TIMEOUT_MS), ..Default::default() },
  )
  .await;
  // A process stopped at the timeout can still report an exit code (1 on Windows).
  if !res.ok && started.elapsed() >= Duration::from_millis(CLI_TIMEOUT_MS) {
    return Err(Failure { message: TIMED_OUT.into(), not_deployed: false, sign_in: false });
  }
  outcome(&res)
}

async fn cli_list(dir: &Path) -> Result<Vec<Stored>, Failure> {
  run_cli(dir, &["secret", "list", "--json"], None).await.map(|result| parse_stored(&result))
}

async fn cli_set(dir: &Path, name: &str, value: String, description: Option<&str>) -> Result<Value, Failure> {
  let describe = description_arg(description).map(|d| format!("--describe={d}"));
  let mut args = vec!["secret", "set", name, "--stdin", "--json"];
  // The CLI only accepts `--describe=<text>`, as one argument.
  if let Some(describe) = describe.as_deref() {
    args.push(describe);
  }
  run_cli(dir, &args, Some(value)).await
}

async fn cli_delete(dir: &Path, name: &str) -> Result<Value, Failure> {
  run_cli(dir, &["secret", "delete", name, "--yes", "--json"], None).await
}

/// What a failed [`DECLARE_SCRIPT`] run means for someone adding `name`.
fn declare_error(name: &str, res: &exec::RunResult) -> String {
  let reason = json_result(&res.stdout).and_then(|v| v.get("reason").and_then(Value::as_str).map(String::from));
  match reason.as_deref() {
    Some("invalid-shape") => {
      format!("Fabricator can’t add {name}: the secrets: entry in rayfin/rayfin.yml isn’t a list. Fix the file, then try again.")
    }
    Some("config-not-found" | "project-root-not-found") => "Fabricator can’t find rayfin/rayfin.yml in this project.".into(),
    _ => {
      let detail = match outcome(res) {
        Err(failure) => failure.message,
        Ok(_) => "The Rayfin CLI didn't confirm the change.".into(),
      };
      format!("Couldn’t add {name} to rayfin.yml: {detail}")
    }
  }
}

/// Add `name` to `rayfin.yml`'s secrets (with `description`) and to the
/// generated `ctx.Secrets` types, through the app's own Rayfin CLI. A name that's
/// already there stays as it is.
async fn declare(dir: &Path, name: &str, description: Option<&str>) -> Result<(), String> {
  let cli = dir.join("node_modules").join("@microsoft").join("rayfin-cli");
  let (cli, root) = (cli.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned());
  let description = description_arg(description).unwrap_or_default();
  let args = ["--input-type=module", "-e", DECLARE_SCRIPT, "--", &cli, &root, name, &description];
  let options = RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(DECLARE_TIMEOUT_MS), ..Default::default() };
  let res = exec::run("node", &args, options).await;
  let confirmed = json_result(&res.stdout).is_some_and(|v| v.get("status").and_then(Value::as_str) == Some("success"));
  if res.ok && confirmed {
    Ok(())
  } else {
    Err(declare_error(name, &res))
  }
}

fn git_opts(dir: &Path) -> RunOptions {
  RunOptions { cwd: Some(dir.to_path_buf()), timeout_ms: Some(30_000), ..Default::default() }
}

/// Whether git sees changes to `path`, or `None` when git can't tell (no repository).
async fn dirty(dir: &Path, path: &str) -> Option<bool> {
  let res = git::run(&["status", "--porcelain", "--", path], git_opts(dir)).await;
  res.ok.then(|| !res.stdout.trim().is_empty())
}

async fn dirty_all(dir: &Path, paths: &[String]) -> Vec<Option<bool>> {
  let mut states = Vec::with_capacity(paths.len());
  for path in paths {
    states.push(dirty(dir, path).await);
  }
  states
}

/// Commit the tracked files the CLI just changed. A file that already had
/// unsaved edits stays as it is, so nobody else's work is swept into the commit.
async fn commit_changes(dir: &Path, paths: &[String], before: &[Option<bool>], message: &str) {
  let mut changed: Vec<&str> = Vec::new();
  for (path, was) in paths.iter().zip(before) {
    if *was == Some(false) && dirty(dir, path).await == Some(true) {
      changed.push(path);
    }
  }
  crate::commands::skills::commit_paths(&dir.to_string_lossy(), &changed, message).await;
}

fn failed(error: impl Into<String>) -> SecretActionResult {
  SecretActionResult { ok: false, error: Some(error.into()), sign_in: None }
}

fn from_failure(failure: Failure) -> SecretActionResult {
  SecretActionResult {
    ok: false,
    error: Some(if failure.not_deployed { NOT_DEPLOYED.to_string() } else { failure.message }),
    sign_in: failure.sign_in.then_some(true),
  }
}

/// The project's folder, when its secrets can be changed from here.
fn writable(project_id: &str) -> Result<PathBuf, String> {
  let project = store::find_project(project_id).ok_or("Project not found.")?;
  let dir = PathBuf::from(&project.path);
  if let Some((_, message)) = unavailable(&project, installed_version(&dir).as_deref()) {
    return Err(message);
  }
  Ok(dir)
}

/// The app's secrets: names, descriptions and when each published value last
/// changed. An app that hasn't been published is `not-deployed`: its declared
/// secrets, read without the CLI or a Fabric sign-in.
#[tauri::command]
pub async fn secrets_list(project_id: String) -> SecretsState {
  let Some(project) = store::find_project(&project_id) else {
    return SecretsState { status: "error".into(), error: Some("Project not found.".into()), ..Default::default() };
  };
  list(&project).await
}

async fn list(project: &StudioProject) -> SecretsState {
  let dir = PathBuf::from(&project.path);
  let config = read_config(&dir);
  let version = installed_version(&dir);
  let mut state = SecretsState {
    status: "ready".into(),
    secrets: merge(&config.declared, &[]),
    functions_enabled: config.functions_enabled,
    rayfin_version: version.clone(),
    ..Default::default()
  };
  // A team app's pipeline deploys it twice (the published app and each person's
  // preview), so show both, read-only.
  if let Some(binding) = &project.team {
    state.status = "team".into();
    let workspace = store::find_team_workspace(&binding.workspace_id);
    let repo = workspace.as_ref().map(|w| w.repo.clone());
    let both = async {
      tokio::join!(
        team_environment("published", binding.production.as_ref(), repo.as_deref(), &config.declared),
        team_environment("preview", binding.preview.as_ref(), repo.as_deref(), &config.declared),
      )
    };
    let (published, preview) =
      crate::services::team::gh::as_account(workspace.and_then(|w| w.account), both).await;
    state.environments = vec![published, preview];
    return state;
  }
  if let Some((status, _)) = unavailable(project, version.as_deref()) {
    state.status = status.into();
    return state;
  }
  match with_sign_in(&dir, cli_list(&dir)).await {
    Ok(stored) => state.secrets = merge(&config.declared, &stored),
    Err(failure) if failure.not_deployed => state.status = "not-deployed".into(),
    Err(failure) => {
      state.status = "error".into();
      state.sign_in = failure.sign_in.then_some(true);
      state.error = Some(failure.message);
    }
  }
  state
}

/// Add a secret, or replace its value, on the published app. The value goes to
/// the CLI on stdin; a new name is also recorded in `rayfin.yml` (with
/// `description`) and committed.
#[tauri::command]
pub async fn secrets_set(
  app: AppHandle,
  project_id: String,
  name: String,
  value: String,
  description: Option<String>,
) -> SecretActionResult {
  let name = name.trim().to_string();
  if let Err(error) = validate_name(&name) {
    return failed(error);
  }
  if value.trim().is_empty() {
    return failed("Enter a value for the secret.");
  }
  let dir = match writable(&project_id) {
    Ok(dir) => dir,
    Err(error) => return failed(error),
  };
  let state = app.state::<AppState>();
  let _lease = match state.mutations.secrets(&project_id) {
    Ok(lease) => lease,
    Err(error) => return failed(error),
  };
  let config = read_config(&dir);
  let paths = tracked_paths(&config);
  let before = dirty_all(&dir, &paths).await;
  match with_sign_in(&dir, cli_set(&dir, &name, value, description.as_deref())).await {
    Ok(_) => {
      let verb = if config.declared.iter().any(|(known, _)| known == &name) { "Update" } else { "Add" };
      commit_changes(&dir, &paths, &before, &format!("{verb} secret: {name}")).await;
      SecretActionResult { ok: true, error: None, sign_in: None }
    }
    Err(failure) => from_failure(failure),
  }
}

/// Delete a secret from the published app (and from `rayfin.yml`).
#[tauri::command]
pub async fn secrets_delete(app: AppHandle, project_id: String, name: String) -> SecretActionResult {
  let name = name.trim().to_string();
  if let Err(error) = validate_name(&name) {
    return failed(error);
  }
  let dir = match writable(&project_id) {
    Ok(dir) => dir,
    Err(error) => return failed(error),
  };
  let state = app.state::<AppState>();
  let _lease = match state.mutations.secrets(&project_id) {
    Ok(lease) => lease,
    Err(error) => return failed(error),
  };
  let paths = tracked_paths(&read_config(&dir));
  let before = dirty_all(&dir, &paths).await;
  match with_sign_in(&dir, cli_delete(&dir, &name)).await {
    Ok(_) => {
      commit_changes(&dir, &paths, &before, &format!("Remove secret: {name}")).await;
      SecretActionResult { ok: true, error: None, sign_in: None }
    }
    Err(failure) => from_failure(failure),
  }
}

/// Add a secret to `rayfin.yml` (with `description`) without a published app,
/// and commit it as "Add secret: NAME". Its value goes to this computer's
/// local backend separately (`local_set_secret`); its published value, once the
/// app is published, through [`secrets_set`]. A declared name stays as it is.
#[tauri::command]
pub async fn secrets_declare(
  app: AppHandle,
  project_id: String,
  name: String,
  description: Option<String>,
) -> SecretActionResult {
  let name = name.trim().to_string();
  if let Err(error) = validate_name(&name) {
    return failed(error);
  }
  let dir = match writable(&project_id) {
    Ok(dir) => dir,
    Err(error) => return failed(error),
  };
  let state = app.state::<AppState>();
  let _lease = match state.mutations.secrets(&project_id) {
    Ok(lease) => lease,
    Err(error) => return failed(error),
  };
  let config = read_config(&dir);
  if config.declared.iter().any(|(known, _)| known == &name) {
    return SecretActionResult { ok: true, error: None, sign_in: None };
  }
  let paths = tracked_paths(&config);
  let before = dirty_all(&dir, &paths).await;
  match declare(&dir, &name, description.as_deref()).await {
    Ok(()) => {
      commit_changes(&dir, &paths, &before, &format!("Add secret: {name}")).await;
      SecretActionResult { ok: true, error: None, sign_in: None }
    }
    Err(error) => failed(error),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run_result(ok: bool, exit: Option<i32>, stdout: &str, stderr: &str) -> exec::RunResult {
    exec::RunResult { ok, exit_code: exit, stdout: stdout.into(), stderr: stderr.into(), not_found: false }
  }

  #[test]
  fn names_must_be_identifiers() {
    for good in ["OPENAI_KEY", "stripeKey", "A", "KEY_2"] {
      assert!(validate_name(good).is_ok(), "{good}");
    }
    for bad in ["", "2FA_KEY", "_HIDDEN", "MY-KEY", "MY KEY", "KEY.NAME", "--yes", "ключ"] {
      assert!(validate_name(bad).is_err(), "{bad}");
    }
    assert!(validate_name(&"K".repeat(129)).is_err());
  }

  #[test]
  fn config_lists_declared_secrets_and_the_functions_service() {
    let config = parse_config(
      "services:\n  functions:\n    enabled: true\n    path: packages\\functions/\nsecrets:\n  - name: OPENAI_KEY\n    description: Key for the chat function\n  - name: STRIPE_KEY\n    description: 'TODO: Add description for this secret'\n  - name: OPENAI_KEY\n  - description: no name\n  - name: '  '\n",
    );
    assert_eq!(
      config.declared,
      vec![
        ("OPENAI_KEY".to_string(), Some("Key for the chat function".to_string())),
        ("STRIPE_KEY".to_string(), None)
      ]
    );
    assert!(config.functions_enabled);
    assert_eq!(config.functions_path.as_deref(), Some("packages/functions"));
    assert_eq!(parse_config("services:\n  functions:\n    enabled: false\n"), Config::default());
    assert_eq!(parse_config("not: [valid"), Config::default());
  }

  #[test]
  fn only_project_files_are_tracked() {
    assert_eq!(
      tracked_paths(&Config::default()),
      ["rayfin/rayfin.yml", "rayfin/functions/src/secrets.generated.ts"]
    );
    let custom = Config { functions_path: Some("packages/functions".into()), ..Default::default() };
    assert_eq!(tracked_paths(&custom)[1], "packages/functions/src/secrets.generated.ts");
    for outside in ["../shared/functions", "C:/functions", "/abs/functions"] {
      let config = Config { functions_path: Some(outside.into()), ..Default::default() };
      assert_eq!(tracked_paths(&config), ["rayfin/rayfin.yml"], "{outside}");
    }
  }

  #[test]
  fn descriptions_become_one_short_line() {
    assert_eq!(description_arg(Some("  Key for\n the   chat function ")).as_deref(), Some("Key for the chat function"));
    assert_eq!(description_arg(Some("   ")), None);
    assert_eq!(description_arg(None), None);
    assert_eq!(description_arg(Some(&"x".repeat(500))).unwrap().len(), MAX_DESCRIPTION);
  }

  #[test]
  fn versions_before_1_36_cant_manage_secrets() {
    assert!(supported("1.36.0"));
    assert!(supported("1.36.2"));
    assert!(supported("1.37.0-alpha.3"));
    assert!(!supported("1.35.1"));
    assert!(!supported("unknown"));
  }

  #[test]
  fn results_come_from_the_last_json_line() {
    let ok = outcome(&run_result(
      true,
      Some(0),
      "Warning: something\n{\"status\":\"success\",\"count\":1,\"secrets\":[{\"name\":\"OPENAI_KEY\",\"createdAt\":\"2026-10-01T00:00:00Z\",\"updatedAt\":\"2026-10-02T00:00:00Z\"},{\"name\":\"\"}]}\n",
      "",
    ))
    .unwrap();
    let stored = parse_stored(&ok);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].name, "OPENAI_KEY");
    assert_eq!(stored[0].updated_at.as_deref(), Some("2026-10-02T00:00:00Z"));
  }

  #[test]
  fn failures_explain_themselves() {
    let not_deployed = outcome(&run_result(
      false,
      Some(1),
      "{\"status\":\"error\",\"error\":\"No remote endpoint configured. Run \\\"rayfin up\\\" first.\"}",
      "",
    ))
    .unwrap_err();
    assert!(not_deployed.not_deployed);
    assert!(!not_deployed.sign_in);

    let sign_in = outcome(&run_result(
      false,
      Some(1),
      "{\"status\":\"error\",\"error\":\"Failed to acquire Fabric authentication token. Sign in with 'rayfin login'.\"}",
      "",
    ))
    .unwrap_err();
    assert!(sign_in.sign_in);

    // Node's own warnings aren't the error, and tokens never reach the screen.
    let crashed = outcome(&run_result(
      false,
      Some(1),
      "",
      "(node:42) [DEP0040] DeprecationWarning: punycode\nRequest failed with header Bearer abc.def.ghi\n(Use `node --trace-deprecation ...`)\n",
    ))
    .unwrap_err();
    assert!(crashed.message.starts_with("Request failed with header"), "{}", crashed.message);
    assert!(!crashed.message.contains("abc.def.ghi"));

    let unconfirmed = outcome(&run_result(true, Some(0), "{\"status\":\"cancelled\"}", "")).unwrap_err();
    assert_eq!(unconfirmed.message, "The Rayfin CLI didn't confirm the change.");
    let timed_out = outcome(&run_result(false, None, "", "")).unwrap_err();
    assert!(timed_out.message.contains("didn't finish in time"));
  }

  #[test]
  fn expired_sign_ins_are_recognized() {
    // What Fabricator's silent check reports, before the CLI runs.
    assert!(needs_sign_in("Silent token acquisition failed and interactive login was not allowed"));
    assert!(needs_sign_in("Fabric authentication was rejected (HTTP 401). Sign in to Fabric again."));
    assert!(needs_sign_in("Rayfin returned no usable access token. Sign in to Fabric again."));
    // What the CLI reports.
    assert!(needs_sign_in("Failed to acquire Fabric authentication token. Sign in with 'rayfin login'."));
    // Not sign-in problems.
    assert!(!needs_sign_in("fetch failed"));
    assert!(!needs_sign_in("Fabric authentication check failed (HTTP 500)"));
    assert!(!needs_sign_in(
      "Could not locate the Rayfin CLI authentication module. Open a Rayfin project to reach Fabric."
    ));
  }

  #[test]
  fn the_list_merges_declared_and_stored_secrets() {
    let declared = vec![("STRIPE_KEY".to_string(), None), ("openai_key".to_string(), Some("Chat".to_string()))];
    let stored = vec![
      Stored { name: "openai_key".into(), description: Some("Portal text".into()), created_at: Some("c".into()), updated_at: Some("u".into()) },
      Stored { name: "LEGACY".into(), description: Some("Old key".into()), created_at: None, updated_at: None },
    ];
    let list = merge(&declared, &stored);
    let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["LEGACY", "openai_key", "STRIPE_KEY"]);
    assert!(list[0].stored && !list[0].declared);
    assert_eq!(list[0].description.as_deref(), Some("Old key"));
    assert!(list[1].stored && list[1].declared);
    // rayfin.yml's description wins over the one stored with the app.
    assert_eq!(list[1].description.as_deref(), Some("Chat"));
    assert_eq!(list[1].updated_at.as_deref(), Some("u"));
    assert!(!list[2].stored && list[2].declared);
  }

  #[test]
  fn the_fabric_api_lists_secrets_as_a_bare_array() {
    let bare: Value = serde_json::from_str(
      r#"[{"name":"HELLO_WORLD","description":null,"createdAt":"2026-10-05T05:14:53Z","updatedAt":"2026-10-05T05:14:53Z"},{"name":"WITH_TEXT","description":"Set in the portal"}]"#,
    )
    .unwrap();
    let stored = parse_stored(&bare);
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[0].name, "HELLO_WORLD");
    assert_eq!(stored[0].description, None);
    assert_eq!(stored[1].description.as_deref(), Some("Set in the portal"));
    let paged: Value = serde_json::from_str(r#"{"value":[{"name":"A"}]}"#).unwrap();
    assert_eq!(parse_stored(&paged)[0].name, "A");
    assert!(parse_stored(&Value::Null).is_empty());
  }

  #[tokio::test]
  async fn team_deployments_are_read_only_by_their_recorded_ids() {
    let record = |workspace: &str, item: &str| TeamDeployRecord {
      workspace_id: Some(workspace.into()),
      item_id: Some(item.into()),
      portal_url: Some("https://app.fabric.microsoft.com/groups/x".into()),
      ..Default::default()
    };
    let good = record("7b3c8083-aafd-49ee-b5b7-bd82d9cc80be", "a75e6b86-a117-44ff-b5d2-9dfe2b22cd41");
    assert_eq!(
      team_target(Some(&good)),
      Some(("7b3c8083-aafd-49ee-b5b7-bd82d9cc80be", "a75e6b86-a117-44ff-b5d2-9dfe2b22cd41"))
    );
    // Only plain ids reach the Fabric path.
    assert_eq!(team_target(Some(&record("../../admin", "a75e6b86-a117-44ff-b5d2-9dfe2b22cd41"))), None);
    assert_eq!(team_target(Some(&record("7b3c8083-aafd-49ee-b5b7-bd82d9cc80be", ""))), None);
    assert_eq!(team_target(None), None);

    // Nothing deployed yet: no call to Fabric, and nothing to list.
    let preview = team_environment("preview", None, Some("o/r"), &[("KEY".into(), None)]).await;
    assert_eq!(preview, SecretEnvironment { kind: "preview".into(), ..Default::default() });
    let unsafe_link = TeamDeployRecord { portal_url: Some("javascript:alert(1)".into()), ..Default::default() };
    assert_eq!(team_environment("published", Some(&unsafe_link), None, &[]).await.portal_url, None);
  }

  #[test]
  fn a_deployment_needs_a_workspace_and_an_item() {
    let dir = std::env::temp_dir().join(format!("fab-secrets-registry-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("rayfin")).unwrap();
    let registry = |text: &str| {
      std::fs::write(dir.join("rayfin/.deployments.json"), text).unwrap();
      has_deployment(&dir)
    };
    assert!(!has_deployment(&dir));
    assert!(!registry("not json"));
    assert!(!registry(r#"{"active":"ws","deployments":{}}"#));
    // What `rayfin init --workspace-id` records before the first deploy.
    assert!(!registry(r#"{"active":"ws","deployments":{"ws":{"fabricWorkspaceId":"w","fabricItemId":""}}}"#));
    assert!(registry(r#"{"active":"ws","deployments":{"ws":{"fabricWorkspaceId":"w","fabricItemId":"i"}}}"#));
    // The CLI uses another deployment when the active one isn't complete.
    assert!(registry(r#"{"active":"a","deployments":{"a":{},"b":{"fabricWorkspaceId":"w","fabricItemId":"i"}}}"#));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A project folder with a stand-in Rayfin CLI that reports what it was given.
  struct FakeProject(PathBuf);

  impl FakeProject {
    fn new() -> Option<Self> {
      which::which("node").ok()?;
      let dir = std::env::temp_dir().join(format!("fab-secrets-{}", uuid::Uuid::new_v4()));
      let cli = dir.join("node_modules/@microsoft/rayfin-cli");
      std::fs::create_dir_all(cli.join("scripts")).unwrap();
      std::fs::write(cli.join("package.json"), r#"{"version":"1.36.2"}"#).unwrap();
      std::fs::write(
        cli.join("scripts/main.js"),
        "let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{process.stdout.write('Working…\\n'+JSON.stringify({status:'success',args:process.argv.slice(2),input,secrets:[{name:'OPENAI_KEY',updatedAt:'u'}]})+'\\n')})",
      )
      .unwrap();
      Some(Self(dir))
    }
  }

  impl Drop for FakeProject {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[tokio::test]
  async fn values_reach_the_cli_on_stdin_only() {
    let Some(project) = FakeProject::new() else { return };
    assert_eq!(installed_version(&project.0).as_deref(), Some("1.36.2"));
    let result = cli_set(&project.0, "OPENAI_KEY", "sk-test & more".into(), Some("Key for\nchat")).await.unwrap();
    assert_eq!(result["input"], "sk-test & more");
    let args: Vec<&str> = result["args"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(args, ["secret", "set", "OPENAI_KEY", "--stdin", "--json", "--describe=Key for chat"]);

    let deleted = cli_delete(&project.0, "OPENAI_KEY").await.unwrap();
    let args: Vec<&str> = deleted["args"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(args, ["secret", "delete", "OPENAI_KEY", "--yes", "--json"]);
    assert_eq!(deleted["input"], "");

    let stored = cli_list(&project.0).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].name, "OPENAI_KEY");
  }

  #[tokio::test]
  async fn an_unpublished_app_lists_its_declared_secrets_without_fabric() {
    let Some(project) = FakeProject::new() else { return };
    let dir = &project.0;
    // Fabric's sign-in check loads the CLI's auth module, and the list runs the CLI.
    let touched = dir.join("touched");
    let touch = format!("require('fs').writeFileSync({}, 'yes')", serde_json::to_string(&touched).unwrap());
    let cli = dir.join("node_modules/@microsoft/rayfin-cli");
    std::fs::create_dir_all(cli.join("dist/auth")).unwrap();
    std::fs::write(cli.join("dist/auth/index.js"), &touch).unwrap();
    std::fs::write(cli.join("scripts/main.js"), &touch).unwrap();
    std::fs::create_dir_all(dir.join("rayfin")).unwrap();
    std::fs::write(
      dir.join("rayfin/rayfin.yml"),
      "services:\n  functions:\n    enabled: true\nsecrets:\n  - name: OPENAI_KEY\n    description: Key for chat\n",
    )
    .unwrap();
    let app: StudioProject =
      serde_json::from_value(serde_json::json!({"id": "p1", "name": "App", "path": dir, "addedAt": "2026-10-01T00:00:00Z"}))
        .unwrap();

    let state = list(&app).await;
    assert_eq!(state.status, "not-deployed");
    assert_eq!(state.secrets.len(), 1);
    assert_eq!(state.secrets[0].name, "OPENAI_KEY");
    assert_eq!(state.secrets[0].description.as_deref(), Some("Key for chat"));
    assert!(state.secrets[0].declared && !state.secrets[0].stored);
    assert!(state.functions_enabled);
    assert_eq!(state.rayfin_version.as_deref(), Some("1.36.2"));
    assert_eq!(state.error, None);
    assert!(!touched.exists(), "the list reached for Fabric");
  }

  #[tokio::test]
  async fn declaring_runs_the_clis_own_rayfin_yml_code() {
    let Some(project) = FakeProject::new() else { return };
    let dir = &project.0;
    // Stand-ins for the CLI's helpers that record what they're given.
    let utils = dir.join("node_modules/@microsoft/rayfin-cli/dist/utils");
    std::fs::create_dir_all(&utils).unwrap();
    std::fs::write(utils.join("../package.json"), r#"{"type":"module"}"#).unwrap();
    std::fs::write(
      utils.join("config-utils.js"),
      "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const upsertSecretMetadata = (name, root, description) => {\n  writeFileSync(join(root, 'declared.json'), JSON.stringify({ name, root, description: description ?? null }));\n  return name === 'BROKEN' ? { status: 'skipped', reason: 'invalid-shape' } : { status: 'added' };\n};\n",
    )
    .unwrap();
    std::fs::write(
      utils.join("secrets-types-generator.js"),
      "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const generateSecretsTypes = (root) => {\n  writeFileSync(join(root, 'types.txt'), 'written');\n  return { status: 'written' };\n};\n",
    )
    .unwrap();
    let recorded = || -> Value { serde_json::from_str(&std::fs::read_to_string(dir.join("declared.json")).unwrap()).unwrap() };

    declare(dir, "OPENAI_KEY", Some("Key for\n the chat")).await.unwrap();
    let call = recorded();
    assert_eq!(call["name"], "OPENAI_KEY");
    assert_eq!(call["description"], "Key for the chat");
    assert_eq!(Path::new(call["root"].as_str().unwrap()), dir.as_path());
    assert!(dir.join("types.txt").is_file());

    // Without a description, the CLI writes its own placeholder.
    declare(dir, "NO_TEXT", Some("  ")).await.unwrap();
    assert_eq!(recorded()["description"], Value::Null);

    let broken = declare(dir, "BROKEN", None).await.unwrap_err();
    assert!(broken.contains("isn’t a list"), "{broken}");

    // A CLI without these helpers says so.
    std::fs::remove_file(utils.join("config-utils.js")).unwrap();
    let missing = declare(dir, "OTHER", None).await.unwrap_err();
    assert!(missing.starts_with("Couldn’t add OTHER to rayfin.yml: "), "{missing}");
    assert!(missing.contains("config-utils.js"), "{missing}");
  }

  #[tokio::test]
  async fn only_files_the_cli_changed_are_committed() {
    if which::which("git").is_err() {
      return;
    }
    let dir = std::env::temp_dir().join(format!("fab-secrets-git-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("rayfin/functions/src")).unwrap();
    let git = |args: &[&str]| {
      let out = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
      assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
      String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "core.autocrlf", "false"]);
    git(&["config", "user.name", "Test"]);
    git(&["config", "user.email", "test@example.invalid"]);
    std::fs::write(dir.join("rayfin/rayfin.yml"), "id: app\n").unwrap();
    std::fs::write(dir.join("notes.md"), "v1\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "First"]);

    let paths = tracked_paths(&Config::default());
    let before = dirty_all(&dir, &paths).await;
    assert_eq!(before, [Some(false), Some(false)]);
    // What `secret set` does, next to an unrelated unsaved edit.
    std::fs::write(dir.join("rayfin/rayfin.yml"), "id: app\nsecrets:\n  - name: OPENAI_KEY\n").unwrap();
    std::fs::write(dir.join("rayfin/functions/src/secrets.generated.ts"), "export {};\n").unwrap();
    std::fs::write(dir.join("notes.md"), "v2\n").unwrap();
    commit_changes(&dir, &paths, &before, "Add secret: OPENAI_KEY").await;

    assert_eq!(git(&["log", "-1", "--pretty=%s"]), "Add secret: OPENAI_KEY");
    let committed = git(&["show", "--name-only", "--pretty=format:", "HEAD"]);
    assert_eq!(committed, "rayfin/functions/src/secrets.generated.ts\nrayfin/rayfin.yml");
    assert_eq!(git(&["status", "--porcelain"]), "M notes.md");

    // A file that already had unsaved edits isn't committed.
    std::fs::write(dir.join("rayfin/rayfin.yml"), "id: app\n# mine\n").unwrap();
    let before = dirty_all(&dir, &paths).await;
    std::fs::write(dir.join("rayfin/rayfin.yml"), "id: app\n# mine\nsecrets: []\n").unwrap();
    commit_changes(&dir, &paths, &before, "Remove secret: OPENAI_KEY").await;
    assert_eq!(git(&["log", "-1", "--pretty=%s"]), "Add secret: OPENAI_KEY");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
