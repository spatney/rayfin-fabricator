//! Automatic live local preview: run a project's **Vite dev server** while
//! an agent turn is in flight so edits show live (HMR) at `localhost`, then stop
//! it at turn end and let the normal after-turn deploy take over. Team apps keep
//! theirs until the pipeline has deployed the saved change, and run against
//! their pipeline deployment's settings (see [`team::local_preview`]).
//!
//! Unlike a deploy, this does NOT run `rayfin up` — it spawns Vite *directly*
//! (`node …/node_modules/vite/bin/vite.js`) for a fast preview, after a
//! best-effort `rayfin env --framework vite` so the local app's `VITE_*` config
//! is wired from the last recorded deployment. Vite runs in the frontend's
//! folder: rayfin.yml's `services.staticHosting.path` (the Rayfin CLI's Universal
//! App keeps its Vite app in `packages/frontend`), else the project root, which is
//! also where `rayfin env` writes the config. The spawned server is long-lived:
//! [`dev_start`] returns once Vite prints its `Local:` URL but leaves the process
//! running under a per-project handle until [`dev_stop`] (or app exit) tree-kills
//! it. Locally installed Vite is sufficient; no `dev` script is required.
//!
//! Ports: Fabric sign-in only accepts origins listed in rayfin.yml's
//! `services.auth.allowedRedirectUris` and pushed to the backend, so a preview
//! serves on the first listed `http://localhost:N` port that is free (Rayfin's
//! default is 5173). When every listed port is taken, [`dev_port_plan`] reports
//! the conflict and the user chooses: [`dev_register_port`] adds another port and
//! pushes it, or [`dev_free_port`] stops the process they were shown. Nothing
//! untracked is ever stopped or adopted without that explicit choice. Each
//! project's server has its own port, so several can run at once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};
use crate::services::exec::{self, CancelToken, RunOptions, Stream};
use crate::services::project_layout::ProjectLayout;
use crate::services::{emit, local_ports, preview, redirect_uris, store, team};
use crate::types::{DeployResult, DevPortPlan, DevServerResult, DevStateEvent, PortConflict, StudioProject};

/// UI log channel for streamed dev-server output (matches `IpcChannels` `dev:run`).
const DEV_CHANNEL: &str = "dev:run";
/// UI log channel for registering a new port (matches `IpcChannels` `dev:register`).
const REGISTER_CHANNEL: &str = "dev:register";
/// Where the search for an unregistered port starts when every listed one is taken.
const FIRST_ALTERNATE_PORT: u16 = 5174;
/// Max time to wait for Vite to print its `Local:` URL before giving up.
const READY_TIMEOUT_MS: u64 = 60_000;
/// Best-effort timeout for the pre-step that refreshes `.env` (no deploy).
const ENV_TIMEOUT_MS: u64 = 30_000;
/// Cap on the per-stream scan buffer used to spot the `Local:` line even when it
/// straddles two reads.
const SCAN_TAIL: usize = 4096;
/// Tells the renderer a local preview restarted, or stopped, on its own.
const DEV_STATE_EVENT: &str = "dev:state";
/// How often a ready local preview is checked; how many failed checks in a row
/// mean Vite stopped serving (its own restarts close the server only briefly);
/// and how many times it's started again before giving up.
const HEALTH_EVERY: Duration = Duration::from_secs(2);
const HEALTH_MISSES: u32 = 3;
const MAX_RESTARTS: u32 = 3;

/// Vite's ready banner line, e.g. `➜  Local:   http://localhost:5173/`. `NO_COLOR`
/// keeps it plain, but we still stop the capture at whitespace or an ESC just in
/// case a color reset is appended.
static LOCAL_URL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)Local:\s*(https?://[^\s\x1b]+)").unwrap());

/// Extract Vite's `Local:` URL from a chunk of dev-server output (trailing slash
/// trimmed). Returns `None` when the text doesn't contain the ready banner.
pub fn parse_local_url(text: &str) -> Option<String> {
    let raw = LOCAL_URL_RE.captures(text)?.get(1)?.as_str();
    Some(raw.trim_end_matches('/').to_string())
}

fn local_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// The ports a project's preview may use, in preference order.
struct PortChoice {
    /// Listed `http://localhost:N` ports (Rayfin's default when none are).
    registered: Vec<u16>,
    /// Auth is on, so only `registered` ports can sign in.
    needs_registration: bool,
}

fn port_choice(project_dir: &Path) -> PortChoice {
    match redirect_uris::read(project_dir) {
        Ok(origins) => PortChoice {
            registered: if origins.ports.is_empty() { vec![redirect_uris::DEFAULT_PORT] } else { origins.ports },
            needs_registration: origins.auth_enabled,
        },
        // An unreadable rayfin.yml keeps the historical behavior: 5173 only.
        Err(_) => PortChoice { registered: vec![redirect_uris::DEFAULT_PORT], needs_registration: true },
    }
}

/// The first usable port, or `None` when every sign-in-ready port is taken.
/// `taken` holds ports owned by this window's other previews.
fn pick_port(choice: &PortChoice, taken: &[u16], is_free: impl Fn(u16) -> bool) -> Option<u16> {
    let usable = |port: &u16| !taken.contains(port) && is_free(*port);
    if let Some(port) = choice.registered.iter().copied().find(usable) {
        return Some(port);
    }
    // Without sign-in, any free port works.
    (!choice.needs_registration).then(|| (FIRST_ALTERNATE_PORT..=FIRST_ALTERNATE_PORT + 100).find(usable)).flatten()
}

/// The project has a Fabric backend that settings can be pushed to.
fn has_backend(project: &StudioProject) -> bool {
    if project.last_deploy.as_ref().is_some_and(|d| d.api_url.is_some() || d.url.is_some()) {
        return true;
    }
    let file = Path::new(&project.path).join("rayfin").join(".deployments.json");
    let Some(json) = std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    else {
        return false;
    };
    json.get("active")
        .and_then(|active| active.as_str())
        .is_some_and(|active| json.get("deployments").and_then(|all| all.get(active)).is_some())
}

/// Where this project's preview can start, probing ports but starting nothing.
fn plan_for(servers: &DevServers, project: &StudioProject) -> DevPortPlan {
    let dir = Path::new(&project.path);
    if !dev_supported(dir) {
        return DevPortPlan::default();
    }
    if let Some(port) = servers.running_port(&project.id) {
        return DevPortPlan { port: Some(port), conflict: None };
    }
    let choice = port_choice(dir);
    let others = servers.ports_held_by_others(&project.id);
    let taken: Vec<u16> = others.iter().map(|(port, _)| *port).collect();
    if let Some(port) = pick_port(&choice, &taken, local_ports::is_free) {
        return DevPortPlan { port: Some(port), conflict: None };
    }
    let port = choice.registered[0];
    let own_project = others
        .iter()
        .find(|(held, _)| *held == port)
        .map(|(_, id)| store::find_project(id).map(|p| p.name).unwrap_or_else(|| "another project".into()));
    let occupant = if own_project.is_some() { None } else { local_ports::occupant(port) };
    let protected = servers.pids();
    let can_stop = occupant.as_ref().is_some_and(|o| local_ports::stoppable(o.pid, &protected));
    let skip: Vec<u16> = choice.registered.iter().chain(&taken).copied().collect();
    DevPortPlan {
        port: None,
        conflict: Some(PortConflict {
            port,
            occupant,
            own_project,
            can_stop,
            suggested_port: local_ports::next_free(FIRST_ALTERNATE_PORT, &skip),
            needs_push: has_backend(project),
        }),
    }
}

/// The port [`start_server`] should use: an explicit `requested` one must still
/// be free and sign-in-ready (just registered, or just freed by the user).
fn resolve_port(servers: &DevServers, project: &StudioProject, requested: Option<u16>) -> Result<u16, DevServerResult> {
    let Some(port) = requested else {
        let plan = plan_for(servers, project);
        return match plan.port {
            Some(port) => Ok(port),
            None => Err(DevServerResult {
                ok: false,
                outcome: "port-busy".into(),
                url: None,
                error: Some(format!(
                    "localhost:{} is in use, and so is every other port this app's sign-in accepts.",
                    plan.conflict.as_ref().map_or(redirect_uris::DEFAULT_PORT, |c| c.port)
                )),
                conflict: plan.conflict,
                backend: None,
            }),
        };
    };
    let choice = port_choice(Path::new(&project.path));
    if choice.needs_registration && !choice.registered.contains(&port) {
        return Err(failed(&format!(
            "localhost:{port} isn't in rayfin.yml's allowed redirect URIs, so sign-in wouldn't work there."
        )));
    }
    let held = servers.ports_held_by_others(&project.id).iter().any(|(other, _)| *other == port);
    if held || !local_ports::is_free(port) {
        return Err(failed(&format!("localhost:{port} is in use again. Send your message again to pick another port.")));
    }
    Ok(port)
}

/// The folder the project's frontend is served from: rayfin.yml's
/// `services.staticHosting.path` when that folder exists, else the project root.
fn frontend_dir(project_dir: &Path) -> PathBuf {
    let root = ProjectLayout::read(project_dir).frontend_root;
    let dir = root.split('/').filter(|s| !s.is_empty()).fold(project_dir.to_path_buf(), |dir, s| dir.join(s));
    if dir.is_dir() { dir } else { project_dir.to_path_buf() }
}

/// The Vite that serves `frontend`: its own `node_modules` first, then the
/// project root's, where npm workspaces hoist it.
fn find_vite(project_dir: &Path, frontend: &Path) -> Option<PathBuf> {
    [frontend, project_dir]
        .into_iter()
        .map(|dir| dir.join("node_modules").join("vite").join("bin").join("vite.js"))
        .find(|script| script.is_file())
}

/// True when a project has Vite installed locally — the one requirement for the
/// live local preview, since we run Vite directly. We deliberately do NOT require
/// a `dev` script: many real Rayfin apps don't declare one (their `npm run dev`
/// would `rayfin up` first), yet Vite is always present and serves the frontend.
pub fn dev_supported(project_dir: &Path) -> bool {
    find_vite(project_dir, &frontend_dir(project_dir)).is_some()
}

/// Resolve how to run a project's locally-installed Vite: a direct
/// `node <script>` invocation (so we bypass the fragile `.cmd`/`npx` shims on
/// Windows) in the frontend's folder. Returns `(node, script, folder)`, or `None`
/// when Vite isn't installed in the project or `node` isn't on PATH.
fn project_vite(project_dir: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let frontend = frontend_dir(project_dir);
    let script = find_vite(project_dir, &frontend)?;
    let node = which::which("node").ok()?;
    Some((node, script, frontend))
}

/// Tree-kill a process by pid. Vite spawns esbuild workers, so a plain kill of
/// the `node` parent would orphan them — on Windows `taskkill /T` takes the whole
/// tree; elsewhere we best-effort SIGKILL the process.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// One running (or starting) dev server.
struct DevHandle {
    /// OS pid of the spawned `node`/Vite process, for tree-kill.
    pid: Option<u32>,
    /// Cooperative cancel that wakes the monitor task to tree-kill the process.
    cancel: CancelToken,
    /// The `localhost` port this server was started on.
    port: u16,
    /// The resolved `localhost` URL once Vite is ready.
    url: Option<String>,
}

/// Per-project registry of live Vite dev servers (Tauri managed state). Cloneable
/// so the spawn monitor task can update / remove its own entry. `lifecycle`
/// serializes start/stop so a turn-end stop can't race the next turn's start.
#[derive(Default, Clone)]
pub struct DevServers {
    inner: Arc<Mutex<HashMap<String, DevHandle>>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
}

impl DevServers {
    /// Whether `token`'s server is still this project's live server.
    fn is_current(&self, project_id: &str, token: &CancelToken) -> bool {
        self.inner
            .lock()
            .unwrap()
            .get(project_id)
            .is_some_and(|h| h.cancel.same(token) && !h.cancel.is_cancelled())
    }

    /// Wait (up to `limit`) until the project's stopped server has been reaped.
    async fn wait_until_gone(&self, project_id: &str, limit: Duration) {
        let deadline = tokio::time::Instant::now() + limit;
        while self.inner.lock().unwrap().contains_key(project_id) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Whether this project has a live, Fabricator-started server on its port.
    pub fn owns_project(&self, project_id: &str) -> bool {
        self.inner.lock().unwrap().get(project_id).is_some_and(|h| {
            !h.cancel.is_cancelled() && h.url.as_deref() == Some(local_url(h.port).as_str())
        })
    }

    fn running_port(&self, project_id: &str) -> Option<u16> {
        self.owns_project(project_id).then(|| self.inner.lock().unwrap().get(project_id).map(|h| h.port)).flatten()
    }

    /// Ports held by other projects' servers in this window, with their ids.
    fn ports_held_by_others(&self, project_id: &str) -> Vec<(u16, String)> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id.as_str() != project_id)
            .map(|(id, h)| (h.port, id.clone()))
            .collect()
    }

    /// Every tracked server's pid. These are never offered for stopping.
    fn pids(&self) -> Vec<u32> {
        self.inner.lock().unwrap().values().filter_map(|h| h.pid).collect()
    }
}

type ReadySender = oneshot::Sender<Result<String, String>>;
type SharedReady = Arc<Mutex<Option<ReadySender>>>;

/// Read `reader` to EOF, streaming each chunk to the UI log channel and scanning
/// for Vite's `Local:` URL. On the first match it fires `ready` (once) and records
/// the URL on the project's handle. Any URL other than `expected` fails the start.
#[allow(clippy::too_many_arguments)]
async fn pump<R>(
    mut reader: R,
    stream: Stream,
    renderer: exec::OnData,
    ready: SharedReady,
    servers: DevServers,
    project_id: String,
    token: CancelToken,
    expected: String,
) where
    R: AsyncReadExt + Unpin,
{
    let mut tmp = [0u8; 8192];
    let mut acc = String::new();
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&tmp[..n]).to_string();
                renderer(stream, &chunk);
                acc.push_str(&chunk);
                if let Some(url) = parse_local_url(&acc) {
                    if url != expected {
                        if let Some(tx) = ready.lock().unwrap().take() {
                            let _ = tx.send(Err(format!("Vite did not bind to the required {expected} address.")));
                        }
                        continue;
                    }
                    // Record the URL and satisfy the readiness wait, exactly once.
                    if let Some(tx) = ready.lock().unwrap().take() {
                        if let Some(h) = servers.inner.lock().unwrap().get_mut(&project_id).filter(|h| h.cancel.same(&token)) {
                            h.url = Some(url.clone());
                        }
                        let _ = tx.send(Ok(url));
                    }
                    acc.clear();
                } else if acc.len() > SCAN_TAIL {
                    // Keep only the tail so the banner is still detectable across a
                    // read boundary without the buffer growing unbounded.
                    let mut cut = acc.len() - SCAN_TAIL;
                    while !acc.is_char_boundary(cut) { cut += 1; }
                    acc.drain(..cut);
                }
            }
            Err(_) => break,
        }
    }
}

/// Start (or reuse) the project's Vite dev server for the live local preview.
/// Serves on `port` when given (it must be free and sign-in-ready), otherwise on
/// the first free registered port; reports `port-busy` when there is none.
/// Resolves once Vite is serving; the process keeps running until [`dev_stop`].
#[tauri::command]
pub async fn dev_start(
    app: AppHandle,
    state: State<'_, DevServers>,
    project_id: String,
    port: Option<u16>,
) -> AppResult<DevServerResult> {
    // Run in a task that owns the lifecycle, so the server bookkeeping completes
    // even if the invoking renderer stops awaiting this IPC call.
    let servers = state.inner().clone();
    let id = project_id.clone();
    let result = tokio::spawn(async move { start_server(app, servers, project_id, port).await })
        .await.map_err(|e| AppError::Msg(format!("Local preview task failed: {e}")))?;
    record_preview(&id, &result);
    result
}

/// Note whether the local preview came up, in the activity journal.
///
/// "My preview won't start" and "is my preview running?" are both common, and
/// the second can only be answered if the successful starts are recorded too.
fn record_preview(project_id: &str, result: &AppResult<DevServerResult>) {
    use crate::services::journal::{self, Area, Level, Surface};
    let (level, event, message) = match result {
        Ok(r) if r.ok => (
            Level::Info,
            "preview.started",
            match r.url.as_deref() {
                Some(url) => format!("The local preview is running at {url}"),
                None => "The local preview started.".to_string(),
            },
        ),
        Ok(r) => (
            Level::Error,
            "preview.failed",
            r.error.clone().unwrap_or_else(|| "The local preview did not start.".to_string()),
        ),
        Err(e) => (Level::Error, "preview.failed", e.to_string()),
    };
    let mut entry = journal::entry(level, Area::Preview, event, &message)
        .operation("dev_start")
        .project(Some(project_id.to_string()));
    if level != Level::Info {
        entry = entry.surface(Surface::Backend);
    }
    entry.write();
}

async fn start_server(app: AppHandle, state: DevServers, project_id: String, requested: Option<u16>) -> AppResult<DevServerResult> {
    let _lifecycle = state.lifecycle.lock().await;
    // Idempotent: if a server is already up for this project, return its URL.
    {
        let handles = state.inner.lock().unwrap();
        if let Some(h) = handles.get(&project_id) {
            if let Some(url) = h.url.clone().filter(|_| !h.cancel.is_cancelled()) {
                return Ok(DevServerResult { ok: true, outcome: "running".into(), url: Some(url), error: None, conflict: None, backend: None });
            }
            return Ok(failed("The local preview is still starting or stopping. Retry after it finishes."));
        }
    }

    let Some(project) = store::find_project(&project_id) else {
        return Ok(unsupported("Project not found."));
    };
    // Team apps are deployed by their pipeline: the preview runs against your
    // preview's deployment (or the published app's) and never deploys from here.
    let team_backend = project.team.as_ref().map(|binding| team::local_preview::choose(binding).0);
    let project_dir = PathBuf::from(&project.path);

    // The one requirement is that Vite is installed — we run it directly, no `dev`
    // script needed (many real Rayfin apps don't declare one).
    let Some((node, vite_script, serve_dir)) = project_vite(&project_dir) else {
        return Ok(unsupported(
            "Vite isn't installed in this project (run `npm install`), or Node wasn't found on PATH.",
        ));
    };

    let renderer = emit::proc_streamer(&app, DEV_CHANNEL);
    let resolved = {
        let (servers, project) = (state.clone(), project.clone());
        tokio::task::spawn_blocking(move || resolve_port(&servers, &project, requested))
            .await
            .map_err(|e| AppError::Msg(format!("Local preview port check failed: {e}")))?
    };
    let port = match resolved {
        Ok(port) => port,
        Err(result) => {
            if let Some(reason) = &result.error {
                renderer(Stream::System, &format!("{reason}\n"));
            }
            return Ok(result);
        }
    };
    let expected = local_url(port);
    renderer(
        Stream::System,
        &format!("Starting local preview for {} on {expected}…\n", project.name),
    );

    // Refresh `.env` (VITE_* config) in the BACKGROUND so it never delays the swap
    // to localhost. `rayfin env` does no deploy; a deployed project already has a
    // valid `.env` from its last build, and Vite hot-reloads if this rewrites it.
    // (Blocking on it here stalled the swap for tens of seconds when signed out.)
    {
        let dir = project_dir.clone();
        let env_renderer = renderer.clone();
        let binding = project.team.clone();
        tokio::spawn(async move {
            // A team app first gets its pipeline deployment's settings in rayfin/.env.
            if let Some(binding) = binding.as_ref() {
                let log = env_renderer.clone();
                team::local_preview::prepare(&dir, binding, move |text| log(Stream::System, text)).await;
            }
            let result = exec::run_project_rayfin(
                &dir,
                &["env", "--framework", "vite"],
                RunOptions {
                    cwd: Some(dir.clone()),
                    timeout_ms: Some(ENV_TIMEOUT_MS),
                    ..Default::default()
                },
            )
            .await;
            if !result.ok {
                let detail: String = result.stderr.trim().chars().take(600).collect();
                env_renderer(Stream::System, &format!(
                    "\nLocal Vite is independent of deployment, but backend environment refresh failed. The app may need sign-in or a first deployment. {detail}\n"
                ));
            }
        });
    }

    let launch = Launch { project_id: project_id.clone(), serve_dir, node, vite_script, port, renderer: renderer.clone() };
    match spawn_vite(&state, &launch).await {
        Ok((url, token)) => {
            renderer(Stream::System, &format!("\n✅ Local preview at {url}\n"));
            tokio::spawn(watch(app, state.clone(), launch, token));
            Ok(DevServerResult {
                ok: true,
                outcome: "running".into(),
                url: Some(url),
                error: None,
                conflict: None,
                backend: team_backend.map(|b| b.as_str().to_string()),
            })
        }
        Err(reason) => Ok(failed(&reason)),
    }
}

/// What it takes to start (or restart) a project's Vite.
#[derive(Clone)]
struct Launch {
    project_id: String,
    /// The frontend's folder (see [`frontend_dir`]), Vite's working directory.
    serve_dir: PathBuf,
    node: PathBuf,
    vite_script: PathBuf,
    port: u16,
    renderer: exec::OnData,
}

/// Spawn the project's Vite on its port and wait until it serves. Returns its URL
/// and the token that stops it, or why it didn't start (nothing is left running).
async fn spawn_vite(state: &DevServers, launch: &Launch) -> Result<(String, CancelToken), String> {
    let Launch { project_id, serve_dir, node, vite_script, port, renderer } = launch;
    let port = *port;
    let expected = local_url(port);
    let mut cmd = tokio::process::Command::new(node);
    cmd.arg(vite_script)
        // Pin the sign-in-ready port and fail rather than let Vite silently fall
        // back to another one — an unregistered port would load but break sign-in.
        .args(["--host", "localhost", "--port", &port.to_string(), "--strictPort"])
        .current_dir(serve_dir)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // tokio's Command exposes `creation_flags` inherently on Windows.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            renderer(Stream::System, &format!("\nFailed to start Vite: {e}\n"));
            return Err(e.to_string());
        }
    };
    let pid = child.id();
    let cancel = CancelToken::new();
    let token = cancel.clone();

    state.inner.lock().unwrap().insert(
        project_id.clone(),
        DevHandle {
            pid,
            cancel: cancel.clone(),
            port,
            url: None,
        },
    );

    let (ready_tx, ready_rx) = oneshot::channel::<Result<String, String>>();
    let ready: SharedReady = Arc::new(Mutex::new(Some(ready_tx)));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Monitor task owns the child so it isn't dropped when this command returns;
    // it pumps output, watches for cancellation, and cleans up on exit.
    let servers = state.clone();
    {
        let (renderer, ready, servers, project_id) =
            (renderer.clone(), ready.clone(), servers.clone(), project_id.clone());
        let expected = expected.clone();
        tokio::spawn(async move {
            if let Some(s) = stdout {
                tokio::spawn(pump(
                    s,
                    Stream::Stdout,
                    renderer.clone(),
                    ready.clone(),
                    servers.clone(),
                    project_id.clone(),
                    cancel.clone(),
                    expected.clone(),
                ));
            }
            if let Some(s) = stderr {
                tokio::spawn(pump(
                    s,
                    Stream::Stderr,
                    renderer.clone(),
                    ready.clone(),
                    servers.clone(),
                    project_id.clone(),
                    cancel.clone(),
                    expected.clone(),
                ));
            }
            tokio::select! {
                _ = child.wait() => {}
                _ = cancel.wait_cancelled() => {
                    if let Some(pid) = pid { kill_tree(pid); }
                    let _ = child.wait().await;
                }
            }
            // If it never reached "ready", unblock the waiter with a failure.
            if let Some(tx) = ready.lock().unwrap().take() {
                let _ = tx.send(Err(format!("Vite exited before it was ready. Check the local preview log; if {expected} was just taken, send your message again.")));
            }
            let mut handles = servers.inner.lock().unwrap();
            if handles.get(&project_id).is_some_and(|h| h.cancel.same(&cancel)) {
                handles.remove(&project_id);
            }
        });
    }

    match tokio::time::timeout(Duration::from_millis(READY_TIMEOUT_MS), ready_rx).await {
        Ok(Ok(Ok(url))) => {
            let responsive = match reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none()).build() {
                Ok(client) => client.get(&url).send().await.is_ok(),
                Err(_) => false,
            };
            if !responsive || !state.owns_project(project_id) {
                stop_project(state, project_id);
                return Err("Vite printed a URL but the owned server is not responding. Check the local preview log and retry.".into());
            }
            Ok((url, token))
        }
        Ok(Ok(Err(reason))) => {
            stop_project(state, project_id);
            Err(reason)
        }
        // Sender dropped, or timed out: give up and tear the process down.
        Ok(Err(_)) | Err(_) => {
            stop_project(state, project_id);
            renderer(Stream::System, "\nLocal preview didn't become ready in time.\n");
            Err("Timed out waiting for Vite to start.".into())
        }
    }
}

/// Whether something accepts connections on `localhost:port` (Vite binds the
/// address `localhost` resolves to first, IPv4 or IPv6).
fn serving(port: u16) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    ("localhost", port)
        .to_socket_addrs()
        .map(|mut addrs| addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()))
        .unwrap_or(false)
}

/// Tell the renderer a local preview restarted (`running`) or stopped on its own.
fn emit_state(app: &AppHandle, project_id: &str, state: &str, url: Option<String>, error: Option<String>) {
    let _ = app.emit(
        DEV_STATE_EVENT,
        DevStateEvent { project_id: project_id.to_string(), state: state.to_string(), url, error },
    );
}

/// Keep a ready local preview serving. Vite restarts its server when an `.env`
/// file or its config changes, and a restart that fails (say, while a package
/// install rewrites node_modules) leaves Vite running but serving nothing: the
/// preview shows a connection error. When the port stops answering for a few
/// checks in a row, start Vite again on the same port and reload the preview.
async fn watch(app: AppHandle, state: DevServers, launch: Launch, mut token: CancelToken) {
    let mut misses = 0;
    let mut restarts = 0;
    loop {
        tokio::select! {
            _ = token.wait_cancelled() => return,
            _ = tokio::time::sleep(HEALTH_EVERY) => {}
        }
        if !state.is_current(&launch.project_id, &token) {
            return;
        }
        let port = launch.port;
        if tokio::task::spawn_blocking(move || serving(port)).await.unwrap_or(true) {
            misses = 0;
            continue;
        }
        misses += 1;
        if misses < HEALTH_MISSES {
            continue;
        }
        misses = 0;
        let _lifecycle = state.lifecycle.lock().await;
        // Stopped (or replaced) while this waited: there's nothing to recover.
        if !state.is_current(&launch.project_id, &token) {
            return;
        }
        (launch.renderer)(Stream::System, "\nThe local preview stopped answering. Starting it again…\n");
        stop_project(&state, &launch.project_id);
        state.wait_until_gone(&launch.project_id, Duration::from_secs(10)).await;
        restarts += 1;
        let outcome = if restarts > MAX_RESTARTS {
            Err("It kept stopping. Send your message again to start a new one.".to_string())
        } else {
            spawn_vite(&state, &launch).await
        };
        match outcome {
            Ok((url, next)) => {
                token = next;
                (launch.renderer)(Stream::System, &format!("\n✅ Local preview back at {url}\n"));
                preview::reload_if_showing(&app, &url);
                emit_state(&app, &launch.project_id, "running", Some(url), None);
            }
            Err(reason) => {
                (launch.renderer)(Stream::System, &format!("\nThe local preview stopped: {reason}\n"));
                emit_state(&app, &launch.project_id, "stopped", None, Some(reason));
                return;
            }
        }
    }
}

/// Stop the project's Vite dev server (tree-kill) if one is running and wait for
/// it to exit. No-op when none is tracked, so this is safe to call
/// unconditionally at turn end. Never touches an untracked process.
#[tauri::command]
pub async fn dev_stop(state: State<'_, DevServers>, project_id: String) -> AppResult<()> {
    let _lifecycle = state.lifecycle.lock().await;
    if !state.inner.lock().unwrap().contains_key(&project_id) {
        return Ok(());
    }
    stop_project(&state, &project_id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while state.inner.lock().unwrap().contains_key(&project_id) {
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Msg("The local Vite process is still stopping. Retry shortly; no unowned process was killed.".into()));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

/// Where the project's live preview would start: a free, sign-in-ready port, or
/// the conflict to put to the user. Probes ports; starts and stops nothing.
#[tauri::command]
pub async fn dev_port_plan(state: State<'_, DevServers>, project_id: String) -> AppResult<DevPortPlan> {
    let servers = state.inner().clone();
    let Some(project) = store::find_project(&project_id) else {
        return Ok(DevPortPlan::default());
    };
    tokio::task::spawn_blocking(move || plan_for(&servers, &project))
        .await
        .map_err(|e| AppError::Msg(format!("Local preview port check failed: {e}")))
}

/// Stop the process the user chose to stop on `port`, so a preview can use it.
/// Only while `pid` still owns the port, and never one of Fabricator's own
/// servers, this app, or a system process.
#[tauri::command]
pub async fn dev_free_port(app: AppHandle, state: State<'_, DevServers>, port: u16, pid: u32) -> AppResult<()> {
    let protected = state.pids();
    let renderer = emit::proc_streamer(&app, DEV_CHANNEL);
    renderer(Stream::System, &format!("Stopping PID {pid} to free {}…\n", local_url(port)));
    let result = tokio::task::spawn_blocking(move || local_ports::stop(port, pid, &protected))
        .await
        .map_err(|e| AppError::Msg(format!("Stopping the process failed: {e}")))?;
    if let Err(reason) = &result {
        renderer(Stream::System, &format!("{reason}\n"));
    }
    result.map_err(AppError::Msg)
}

/// Let this project's preview sign in on `http://localhost:{port}`: add it to
/// rayfin.yml's `allowedRedirectUris` and, when the app has a Fabric backend,
/// push the settings there without rebuilding the app. A failed push reverts
/// the rayfin.yml edit. Holds the deploy lease, so it never overlaps a chat turn
/// or deployment.
#[tauri::command]
pub async fn dev_register_port(app: AppHandle, project_id: String, port: u16) -> DeployResult {
    match tokio::spawn(async move { register_port(app, project_id, port).await }).await {
        Ok(result) => result,
        Err(error) => register_result(false, "error", Some(format!("Registering the port failed: {error}"))),
    }
}

async fn register_port(app: AppHandle, project_id: String, port: u16) -> DeployResult {
    if port < 1024 {
        return register_result(false, "error", Some(format!("Port {port} is reserved; choose one above 1023.")));
    }
    let Some(project) = store::find_project(&project_id) else {
        return register_result(false, "not-found", Some("Project not found.".into()));
    };
    let app_state = app.state::<crate::state::AppState>();
    if project.team.is_some() {
        return register_team_port(&app, &app_state, &project, port);
    }
    let _lease = match app_state.mutations.deploy(&project_id) {
        Ok(lease) => lease,
        Err(error) => return register_result(false, "error", Some(error)),
    };
    let dir = PathBuf::from(&project.path);
    let renderer = emit::proc_streamer(&app, REGISTER_CHANNEL);
    let origin = redirect_uris::origin(port);
    match redirect_uris::read(&dir) {
        Ok(origins) if !origins.auth_enabled => return register_result(true, "success", None),
        Ok(_) => {}
        Err(error) => return register_result(false, "error", Some(error)),
    }
    let edit = match redirect_uris::add(&dir, port) {
        Ok(edit) => edit,
        Err(error) => {
            renderer(Stream::System, &format!("{error}\n"));
            return register_result(false, "error", Some(error));
        }
    };
    if edit.is_some() {
        renderer(Stream::System, &format!("Added {origin} to rayfin/rayfin.yml.\n"));
    }
    if !has_backend(&project) {
        renderer(Stream::System, "This app isn't deployed yet; its first deploy registers the new port.\n");
        return register_result(true, "success", None);
    }
    renderer(Stream::System, "Pushing sign-in settings to Fabric (the app isn't rebuilt)…\n");
    let result = crate::commands::deploy::push_runtime_settings(&project, renderer.clone()).await;
    if result.ok {
        renderer(Stream::System, &format!("\n✅ Sign-in now accepts {origin}.\n"));
    } else if let Some(edit) = &edit {
        if redirect_uris::revert(&dir, edit) {
            renderer(Stream::System, "\nThe push failed, so the rayfin.yml change was undone.\n");
        }
    }
    result
}

fn register_result(ok: bool, outcome: &str, error: Option<String>) -> DeployResult {
    DeployResult { ok, outcome: outcome.into(), url: None, api_url: None, portal_url: None, error }
}

/// A team app's new port is saved in rayfin.yml only: nothing deploys from this
/// computer, so sign-in accepts the port once the change is saved to GitHub and
/// the pipeline deploys your preview. Holds the team lease so it can't overlap
/// a save.
fn register_team_port(app: &AppHandle, app_state: &crate::state::AppState, project: &StudioProject, port: u16) -> DeployResult {
    let _lease = match app_state.mutations.team(&project.id) {
        Ok(lease) => lease,
        Err(error) => return register_result(false, "error", Some(error)),
    };
    let dir = PathBuf::from(&project.path);
    let renderer = emit::proc_streamer(app, REGISTER_CHANNEL);
    match redirect_uris::read(&dir) {
        Ok(origins) if !origins.auth_enabled => return register_result(true, "success", None),
        Ok(_) => {}
        Err(error) => return register_result(false, "error", Some(error)),
    }
    match redirect_uris::add(&dir, port) {
        Ok(_) => {
            renderer(
                Stream::System,
                &format!(
                    "Added {} to rayfin/rayfin.yml. Sign-in accepts it after your next change is saved and the team pipeline deploys your preview.\n",
                    redirect_uris::origin(port)
                ),
            );
            register_result(true, "success", None)
        }
        Err(error) => {
            renderer(Stream::System, &format!("{error}\n"));
            register_result(false, "error", Some(error))
        }
    }
}

/// Whether the project supports the live local preview (has installed Vite).
#[tauri::command]
pub fn dev_supported_cmd(project_id: String) -> bool {
    store::find_project(&project_id)
        .map(|p| dev_supported(Path::new(&p.path)))
        .unwrap_or(false)
}

/// Remove a project's handle and kill its process (directly, plus cancel so the
/// monitor reaps it). Shared by [`dev_stop`] and the timeout/early-exit paths.
fn stop_project(state: &DevServers, project_id: &str) {
    if let Some(h) = state.inner.lock().unwrap().get(project_id) {
        h.cancel.cancel();
    }
}

/// Kill every tracked dev server. Called on app exit so Vite never orphans.
pub fn kill_all(app: &AppHandle) {
    let Some(state) = app.try_state::<DevServers>() else {
        return;
    };
    let handles: Vec<DevHandle> = state.inner.lock().unwrap().drain().map(|(_, h)| h).collect();
    for h in handles {
        h.cancel.cancel();
        if let Some(pid) = h.pid {
            kill_tree(pid);
        }
    }
}

fn unsupported(msg: &str) -> DevServerResult {
    DevServerResult {
        ok: false,
        outcome: "unsupported".into(),
        url: None,
        error: Some(msg.to_string()),
        conflict: None,
        backend: None,
    }
}

fn failed(msg: &str) -> DevServerResult {
    DevServerResult { ok: false, outcome: "error".into(), url: None, error: Some(msg.to_string()), conflict: None, backend: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serving_sees_a_listener_come_and_go() {
        let listener = std::net::TcpListener::bind("localhost:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(serving(port));
        drop(listener);
        assert!(!serving(port));
    }

    /// The watchdog's recovery: a Vite that lost its server (but kept running) is
    /// stopped, and a new one starts on the same port.
    #[tokio::test]
    async fn a_vite_that_stops_serving_starts_again_on_its_port() {
        let Ok(node) = which::which("node") else { return };
        let dir = std::env::temp_dir().join(format!("fab-vite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-vite.js");
        std::fs::write(
            &script,
            r#"
const fs = require('fs'), http = require('http'), path = require('path')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const counter = path.join(__dirname, 'starts')
const starts = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1
fs.writeFileSync(counter, String(starts))
const server = http.createServer((req, res) => res.end('ok')).listen(port, 'localhost', () => {
  console.log(`  VITE ready\n  ➜  Local:   http://localhost:${port}/`)
  // The first run loses its server, as a failed Vite restart does, but keeps running.
  if (starts === 1) setTimeout(() => server.close(), 400)
})
setInterval(() => {}, 1000)
"#,
        )
        .unwrap();
        let port = std::net::TcpListener::bind("localhost:0").unwrap().local_addr().unwrap().port();
        let launch = Launch {
            project_id: "p".into(),
            serve_dir: dir.clone(),
            node,
            vite_script: script,
            port,
            renderer: Arc::new(|_, _| {}),
        };
        let state = DevServers::default();
        let (url, first) = spawn_vite(&state, &launch).await.unwrap();
        assert_eq!(url, local_url(port));
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!serving(port), "the first run stopped serving");
        assert!(state.is_current("p", &first), "but it's still running");

        stop_project(&state, "p");
        state.wait_until_gone("p", Duration::from_secs(10)).await;
        let (_, second) = spawn_vite(&state, &launch).await.unwrap();
        assert!(serving(port));
        assert!(state.is_current("p", &second) && !state.is_current("p", &first));
        assert_eq!(std::fs::read_to_string(dir.join("starts")).unwrap(), "2");

        stop_project(&state, "p");
        state.wait_until_gone("p", Duration::from_secs(10)).await;
        assert!(!serving(port));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serves_the_frontend_folder_rayfin_yml_names() {
        // The Rayfin CLI's Universal App keeps its Vite app in a workspace package.
        let yml = "services:\n  staticHosting:\n    enabled: true\n    path: packages/frontend\n    folder: dist\n";
        let dir = std::env::temp_dir().join(format!("fab-frontend-{}", uuid::Uuid::new_v4()));
        let frontend = dir.join("packages").join("frontend");
        std::fs::create_dir_all(&frontend).unwrap();
        std::fs::create_dir_all(dir.join("rayfin")).unwrap();
        std::fs::write(dir.join("rayfin").join("rayfin.yml"), yml).unwrap();
        assert_eq!(frontend_dir(&dir), frontend);
        assert_eq!(find_vite(&dir, &frontend), None);
        assert!(!dev_supported(&dir));
        // npm workspaces hoist Vite to the root; a copy in the package wins.
        let hoisted = dir.join("node_modules").join("vite").join("bin").join("vite.js");
        std::fs::create_dir_all(hoisted.parent().unwrap()).unwrap();
        std::fs::write(&hoisted, "").unwrap();
        assert_eq!(find_vite(&dir, &frontend), Some(hoisted));
        assert!(dev_supported(&dir));
        let local = frontend.join("node_modules").join("vite").join("bin").join("vite.js");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, "").unwrap();
        assert_eq!(find_vite(&dir, &frontend), Some(local));
        // A configured folder that doesn't exist falls back to the root, as does
        // one that would leave the project.
        std::fs::remove_dir_all(dir.join("packages")).unwrap();
        assert_eq!(frontend_dir(&dir), dir);
        std::fs::write(dir.join("rayfin").join("rayfin.yml"), "services:\n  staticHosting:\n    path: ..\n").unwrap();
        assert_eq!(frontend_dir(&dir), dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_vite_local_url() {
        let out = "\n  VITE v7.3.6  ready in 320 ms\n\n  \u{2705} Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n";
        assert_eq!(
            parse_local_url(out),
            Some("http://localhost:5173".to_string())
        );
    }

    #[test]
    fn parses_local_url_on_alternate_port() {
        // Vite falls back to another port when 5173 is taken.
        assert_eq!(
            parse_local_url("  ➜  Local:   http://localhost:5174/"),
            Some("http://localhost:5174".to_string())
        );
    }

    #[test]
    fn no_url_when_banner_absent() {
        assert_eq!(parse_local_url("transforming modules..."), None);
    }

    #[test]
    fn owns_project_only_for_a_live_server_on_its_own_port() {
        let servers = DevServers::default();
        let cancel = CancelToken::new();
        servers.inner.lock().unwrap().insert("p".into(), DevHandle {
            pid: Some(11), cancel: cancel.clone(), port: 5174, url: Some(local_url(5174)),
        });
        servers.inner.lock().unwrap().insert("starting".into(), DevHandle {
            pid: Some(12), cancel: CancelToken::new(), port: 5173, url: None,
        });
        servers.inner.lock().unwrap().insert("mismatch".into(), DevHandle {
            pid: None, cancel: CancelToken::new(), port: 5175, url: Some(local_url(5173)),
        });
        assert!(servers.owns_project("p"));
        assert_eq!(servers.running_port("p"), Some(5174));
        assert!(!servers.owns_project("starting"));
        assert!(!servers.owns_project("mismatch"));
        assert!(!servers.owns_project("untracked"));
        let mut others = servers.ports_held_by_others("p");
        others.sort();
        assert_eq!(others, vec![(5173, "starting".to_string()), (5175, "mismatch".to_string())]);
        let mut pids = servers.pids();
        pids.sort();
        assert_eq!(pids, vec![11, 12]);
        stop_project(&servers, "p");
        assert!(cancel.is_cancelled());
        assert!(!servers.owns_project("p"));
        assert_eq!(servers.running_port("p"), None);
    }

    #[test]
    fn picks_the_first_free_registered_port_and_skips_other_previews() {
        let choice = PortChoice { registered: vec![5173, 5174], needs_registration: true };
        assert_eq!(pick_port(&choice, &[], |_| true), Some(5173));
        assert_eq!(pick_port(&choice, &[], |port| port != 5173), Some(5174));
        assert_eq!(pick_port(&choice, &[5173], |_| true), Some(5174));
        // Every registered port is busy: sign-in needs a registration, so no pick.
        assert_eq!(pick_port(&choice, &[5174], |port| port != 5173), None);
    }

    #[test]
    fn apps_without_sign_in_use_any_free_port() {
        let choice = PortChoice { registered: vec![5173], needs_registration: false };
        assert_eq!(pick_port(&choice, &[], |_| true), Some(5173));
        assert_eq!(pick_port(&choice, &[5174], |port| port != 5173), Some(5175));
    }

    fn project_at(dir: &Path) -> StudioProject {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "App", "path": dir.to_string_lossy(), "addedAt": "2026-01-01T00:00:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn registered_ports_come_from_rayfin_yml() {
        let dir = std::env::temp_dir().join(format!("rayfin-ports-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("rayfin")).unwrap();
        // Unreadable config keeps the historical 5173-only behavior.
        let missing = port_choice(&dir);
        assert_eq!((missing.registered, missing.needs_registration), (vec![5173], true));

        std::fs::write(
            dir.join("rayfin").join("rayfin.yml"),
            "services:\n  auth:\n    enabled: true\n    allowedRedirectUris:\n      - https://app.example.net\n      - http://localhost:5180\n",
        )
        .unwrap();
        let listed = port_choice(&dir);
        assert_eq!((listed.registered, listed.needs_registration), (vec![5180], true));

        std::fs::write(dir.join("rayfin").join("rayfin.yml"), "services:\n  auth:\n    allowedRedirectUris:\n      - https://app.example.net\n").unwrap();
        let none_local = port_choice(&dir);
        assert_eq!((none_local.registered, none_local.needs_registration), (vec![5173], false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backend_exists_once_deployed_or_recorded_on_disk() {
        let dir = std::env::temp_dir().join(format!("rayfin-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("rayfin")).unwrap();
        let mut project = project_at(&dir);
        assert!(!has_backend(&project));

        std::fs::write(dir.join("rayfin").join(".deployments.json"), r#"{"active":"ws","deployments":{}}"#).unwrap();
        assert!(!has_backend(&project));
        std::fs::write(dir.join("rayfin").join(".deployments.json"), r#"{"active":"ws","deployments":{"ws":{}}}"#).unwrap();
        assert!(has_backend(&project));

        std::fs::remove_file(dir.join("rayfin").join(".deployments.json")).unwrap();
        project.last_deploy = Some(crate::types::DeployInfo { api_url: Some("https://api".into()), ..Default::default() });
        assert!(has_backend(&project));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_requested_port_must_be_registered_when_the_app_signs_in() {
        let dir = std::env::temp_dir().join(format!("rayfin-request-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("rayfin")).unwrap();
        std::fs::write(
            dir.join("rayfin").join("rayfin.yml"),
            "services:\n  auth:\n    enabled: true\n    allowedRedirectUris:\n      - http://localhost:5173\n",
        )
        .unwrap();
        let servers = DevServers::default();
        let error = resolve_port(&servers, &project_at(&dir), Some(5199)).unwrap_err();
        assert!(error.error.unwrap().contains("isn't in rayfin.yml"));

        servers.inner.lock().unwrap().insert("other".into(), DevHandle {
            pid: None, cancel: CancelToken::new(), port: 5173, url: None,
        });
        let error = resolve_port(&servers, &project_at(&dir), Some(5173)).unwrap_err();
        assert!(error.error.unwrap().contains("in use again"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dev_supported_detects_installed_vite() {
        let dir = std::env::temp_dir().join(format!("rayfin-dev-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // No Vite installed → unsupported.
        assert!(!dev_supported(&dir));

        // Vite installed (node_modules/vite/bin/vite.js) → supported, regardless of
        // whether the project declares a `dev` script (real apps often don't).
        let bin = dir.join("node_modules").join("vite").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("vite.js"), "// stub").unwrap();
        assert!(dev_supported(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
