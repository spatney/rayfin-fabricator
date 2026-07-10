//! Live local preview (experimental): run a project's **Vite dev server** while
//! an agent turn is in flight so edits show live (HMR) at `localhost`, then stop
//! it at turn end and let the normal after-turn deploy take over.
//!
//! Unlike a deploy, this does NOT run `rayfin up` — it spawns Vite *directly*
//! (`node <project>/node_modules/vite/bin/vite.js`) for a fast preview, after a
//! best-effort `rayfin env --framework vite` so the local app's `VITE_*` config
//! is wired from the last recorded deployment. The spawned server is long-lived:
//! [`dev_start`] returns once Vite prints its `Local:` URL but leaves the process
//! running under a per-project handle until [`dev_stop`] (or app exit) tree-kills
//! it. Only projects that declare a `dev` script are supported (blankapp /
//! todoapp); dataapp and others are reported `unsupported`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

use crate::error::AppResult;
use crate::services::exec::{self, CancelToken, RunOptions, Stream};
use crate::services::{emit, store};
use crate::types::DevServerResult;

/// UI log channel for streamed dev-server output (matches `IpcChannels` `dev:run`).
const DEV_CHANNEL: &str = "dev:run";
/// The canonical local dev port for Rayfin apps: their auth redirect URI and
/// backend CORS are pinned to `localhost:5173`, so the preview must serve there
/// (Fabricator's own renderer dev server is moved off 5173 to keep it free).
const LOCAL_PORT: &str = "5173";
/// Max time to wait for Vite to print its `Local:` URL before giving up.
const READY_TIMEOUT_MS: u64 = 60_000;
/// Best-effort timeout for the pre-step that refreshes `.env` (no deploy).
const ENV_TIMEOUT_MS: u64 = 30_000;
/// Cap on the per-stream scan buffer used to spot the `Local:` line even when it
/// straddles two reads.
const SCAN_TAIL: usize = 4096;

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

/// True when a project has Vite installed locally — the one requirement for the
/// live local preview, since we run Vite directly. We deliberately do NOT require
/// a `dev` script: many real Rayfin apps don't declare one (their `npm run dev`
/// would `rayfin up` first), yet Vite is always present and serves the frontend.
pub fn dev_supported(project_dir: &Path) -> bool {
    project_dir
        .join("node_modules")
        .join("vite")
        .join("bin")
        .join("vite.js")
        .exists()
}

/// Resolve a project's locally-installed Vite to a direct `node <script>`
/// invocation (so we bypass the fragile `.cmd`/`npx` shims on Windows). Returns
/// `None` when Vite isn't installed in the project or `node` isn't on PATH.
fn project_vite(project_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let script = project_dir
        .join("node_modules")
        .join("vite")
        .join("bin")
        .join("vite.js");
    if !script.exists() {
        return None;
    }
    let node = which::which("node").ok()?;
    Some((node, script))
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
    /// The resolved `localhost` URL once Vite is ready.
    url: Option<String>,
}

/// Per-project registry of live Vite dev servers (Tauri managed state). Cloneable
/// so the spawn monitor task can update / remove its own entry.
#[derive(Default, Clone)]
pub struct DevServers {
    inner: Arc<Mutex<HashMap<String, DevHandle>>>,
}

type ReadySender = oneshot::Sender<Result<String, String>>;
type SharedReady = Arc<Mutex<Option<ReadySender>>>;

/// Read `reader` to EOF, streaming each chunk to the UI log channel and scanning
/// for Vite's `Local:` URL. On the first match it fires `ready` (once) and records
/// the URL on the project's handle.
async fn pump<R>(
    mut reader: R,
    stream: Stream,
    renderer: exec::OnData,
    ready: SharedReady,
    servers: DevServers,
    project_id: String,
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
                    // Record the URL and satisfy the readiness wait, exactly once.
                    let mut fired = false;
                    if let Some(tx) = ready.lock().unwrap().take() {
                        let _ = tx.send(Ok(url.clone()));
                        fired = true;
                    }
                    if fired {
                        if let Some(h) = servers.inner.lock().unwrap().get_mut(&project_id) {
                            h.url = Some(url);
                        }
                    }
                    acc.clear();
                } else if acc.len() > SCAN_TAIL {
                    // Keep only the tail so the banner is still detectable across a
                    // read boundary without the buffer growing unbounded.
                    let cut = acc.len() - SCAN_TAIL;
                    acc.drain(..cut);
                }
            }
            Err(_) => break,
        }
    }
}

/// Start (or reuse) the project's Vite dev server for the live local preview.
/// Resolves once Vite is serving; the process keeps running until [`dev_stop`].
#[tauri::command]
pub async fn dev_start(
    app: AppHandle,
    state: State<'_, DevServers>,
    project_id: String,
) -> AppResult<DevServerResult> {
    // Idempotent: if a server is already up for this project, return its URL.
    if let Some(url) = state
        .inner
        .lock()
        .unwrap()
        .get(&project_id)
        .and_then(|h| h.url.clone())
    {
        return Ok(DevServerResult {
            ok: true,
            outcome: "running".into(),
            url: Some(url),
            error: None,
        });
    }

    let Some(project) = store::find_project(&project_id) else {
        return Ok(unsupported("Project not found."));
    };
    let project_dir = PathBuf::from(&project.path);

    // The one requirement is that Vite is installed — we run it directly, no `dev`
    // script needed (many real Rayfin apps don't declare one).
    let Some((node, vite_script)) = project_vite(&project_dir) else {
        return Ok(unsupported(
            "Vite isn't installed in this project (run `npm install`), or Node wasn't found on PATH.",
        ));
    };

    let renderer = emit::proc_streamer(&app, DEV_CHANNEL);
    renderer(
        Stream::System,
        &format!("Starting local preview for {}…\n", project.name),
    );

    // Refresh `.env` (VITE_* config) in the BACKGROUND so it never delays the swap
    // to localhost. `rayfin env` does no deploy; a deployed project already has a
    // valid `.env` from its last build, and Vite hot-reloads if this rewrites it.
    // (Blocking on it here stalled the swap for tens of seconds when signed out.)
    {
        let dir = project_dir.clone();
        tokio::spawn(async move {
            let _ = exec::run_project_rayfin(
                &dir,
                &["env", "--framework", "vite"],
                RunOptions {
                    cwd: Some(dir.clone()),
                    timeout_ms: Some(ENV_TIMEOUT_MS),
                    ..Default::default()
                },
            )
            .await;
        });
    }

    let mut cmd = tokio::process::Command::new(&node);
    cmd.arg(&vite_script)
        // Pin to 5173 (the app's auth-redirect / CORS port) and fail rather than
        // silently fall back to 5174 — a fallback port would load but break sign-in.
        .args(["--port", LOCAL_PORT, "--strictPort"])
        .current_dir(&project_dir)
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
            return Ok(DevServerResult {
                ok: false,
                outcome: "error".into(),
                url: None,
                error: Some(e.to_string()),
            });
        }
    };
    let pid = child.id();
    let cancel = CancelToken::new();

    state.inner.lock().unwrap().insert(
        project_id.clone(),
        DevHandle {
            pid,
            cancel: cancel.clone(),
            url: None,
        },
    );

    let (ready_tx, ready_rx) = oneshot::channel::<Result<String, String>>();
    let ready: SharedReady = Arc::new(Mutex::new(Some(ready_tx)));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Monitor task owns the child so it isn't dropped when this command returns;
    // it pumps output, watches for cancellation, and cleans up on exit.
    let servers = DevServers {
        inner: state.inner.clone(),
    };
    {
        let (renderer, ready, servers, project_id) =
            (renderer.clone(), ready.clone(), servers.clone(), project_id.clone());
        tokio::spawn(async move {
            if let Some(s) = stdout {
                tokio::spawn(pump(
                    s,
                    Stream::Stdout,
                    renderer.clone(),
                    ready.clone(),
                    servers.clone(),
                    project_id.clone(),
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
                let _ = tx.send(Err("Vite exited before it was ready.".into()));
            }
            servers.inner.lock().unwrap().remove(&project_id);
        });
    }

    match tokio::time::timeout(Duration::from_millis(READY_TIMEOUT_MS), ready_rx).await {
        Ok(Ok(Ok(url))) => {
            renderer(Stream::System, &format!("\n✅ Local preview at {url}\n"));
            Ok(DevServerResult {
                ok: true,
                outcome: "running".into(),
                url: Some(url),
                error: None,
            })
        }
        Ok(Ok(Err(reason))) => {
            stop_project(&state, &project_id);
            Ok(DevServerResult {
                ok: false,
                outcome: "error".into(),
                url: None,
                error: Some(reason),
            })
        }
        // Sender dropped, or timed out: give up and tear the process down.
        Ok(Err(_)) | Err(_) => {
            stop_project(&state, &project_id);
            renderer(Stream::System, "\nLocal preview didn't become ready in time.\n");
            Ok(DevServerResult {
                ok: false,
                outcome: "error".into(),
                url: None,
                error: Some("Timed out waiting for Vite to start.".into()),
            })
        }
    }
}

/// Stop the project's Vite dev server (tree-kill) if one is running. No-op when
/// none is tracked, so this is safe to call unconditionally at turn end.
#[tauri::command]
pub async fn dev_stop(state: State<'_, DevServers>, project_id: String) -> AppResult<()> {
    stop_project(&state, &project_id);
    Ok(())
}

/// Whether the project supports the live local preview (has a `dev` script).
#[tauri::command]
pub fn dev_supported_cmd(project_id: String) -> bool {
    store::find_project(&project_id)
        .map(|p| dev_supported(Path::new(&p.path)))
        .unwrap_or(false)
}

/// Remove a project's handle and kill its process (directly, plus cancel so the
/// monitor reaps it). Shared by [`dev_stop`] and the timeout/early-exit paths.
fn stop_project(state: &DevServers, project_id: &str) {
    let handle = state.inner.lock().unwrap().remove(project_id);
    if let Some(h) = handle {
        h.cancel.cancel();
        if let Some(pid) = h.pid {
            kill_tree(pid);
        }
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
