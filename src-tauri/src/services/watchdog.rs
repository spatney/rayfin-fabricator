//! Main-thread hang watchdog.
//!
//! Some users (notably under Parallels/VMs) report the app freezing. To make
//! such hangs observable in the field, a background monitor thread *actively
//! probes* the main thread: every [`POLL_INTERVAL`] it posts a trivial task to
//! the event loop via [`tauri::AppHandle::run_on_main_thread`] and notes when
//! that task actually runs. If the main thread hasn't been confirmed alive for
//! longer than [`STALL_THRESHOLD`] it is genuinely wedged, so we record a single
//! "main thread stalled" entry to the crash log (local-only, no network) and log
//! again when responsiveness returns — so the log isn't flooded.
//!
//! Why an active probe instead of a passive heartbeat: Tauri's event loop parks
//! in `GetMessage` (`ControlFlow::Wait`) whenever the app is idle, so a heartbeat
//! bumped only on event-loop iterations can't tell an *idle* loop from a *hung*
//! one — an unfocused, event-starved window would look frozen and spam the log
//! with phantom stalls. Posting a task instead *wakes* an idle loop (the task
//! runs within milliseconds), while a truly blocked loop can't dispatch it — so
//! only real hangs are reported. [`beat`] is kept as a supplementary freshness
//! signal during activity but is no longer required to prove liveness.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, Ordering};
use std::time::Duration;

use tauri::AppHandle;

use super::crashlog;

/// Epoch-millis the main thread was last confirmed alive (a probe ran or a beat
/// landed); 0 until the first signal.
static LAST_ALIVE_MS: AtomicI64 = AtomicI64::new(0);
/// Whether a liveness probe is already queued on the main thread. Keeps at most
/// one outstanding: during a real hang the queued probe simply waits to run
/// (marking recovery) rather than piling up a burst behind the block.
static PROBE_PENDING: AtomicBool = AtomicBool::new(false);
/// Whether we're currently inside a logged stall (so we log start/end once each).
static STALLED: AtomicBool = AtomicBool::new(false);
/// Epoch-millis the current stall began (the last confirmed liveness before it
/// went quiet), so recovery can report the *total* hang duration, not the tiny
/// sampling lag. Meaningful only while [`STALLED`] is true.
static STALL_STARTED_MS: AtomicI64 = AtomicI64::new(0);
/// Epoch-millis we last logged a line for the ongoing stall, so a long freeze
/// leaves periodic breadcrumbs (handy if it ends in a force-quit).
static STALL_LAST_LOG_MS: AtomicI64 = AtomicI64::new(0);
/// Epoch-millis the watchdog was armed, for an uptime figure in the logs.
static STARTED_AT_MS: AtomicI64 = AtomicI64::new(0);

/// Longest the main thread may go unconfirmed before we treat it as hung. The
/// bounded preview capture caps a legitimate UI-thread block at ~5s, so 10s only
/// fires on a genuine freeze.
const STALL_THRESHOLD: Duration = Duration::from_secs(10);
/// How often the monitor thread wakes to probe the main thread and check liveness.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// While a stall persists, re-log a progress breadcrumb at most this often.
const STALL_PROGRESS_INTERVAL: Duration = Duration::from_secs(15);

/// Coarse label for what the main (UI) thread is doing, so a detected stall can
/// name the likely culprit. Set via [`activity`] around the known UI-thread
/// WebView2 preview operations — the calls most likely to block on a misbehaving
/// VM GPU/driver. Held in a lock-free atomic so the watchdog can sample it even
/// while the main thread is wedged.
#[derive(Clone, Copy)]
#[repr(u8)]
pub enum Activity {
  Idle = 0,
  PreviewCapture = 1,
  PreviewSetBounds = 2,
  PreviewNavigate = 3,
  PreviewReload = 4,
  PreviewHide = 5,
  PreviewHistory = 6,
}

impl Activity {
  fn label(self) -> &'static str {
    match self {
      Activity::Idle => "idle/unknown",
      Activity::PreviewCapture => "preview capture (WebView2 CapturePreview)",
      Activity::PreviewSetBounds => "preview set_bounds",
      Activity::PreviewNavigate => "preview navigate",
      Activity::PreviewReload => "preview reload",
      Activity::PreviewHide => "preview hide",
      Activity::PreviewHistory => "preview back/forward",
    }
  }

  fn from_u8(v: u8) -> Activity {
    match v {
      1 => Activity::PreviewCapture,
      2 => Activity::PreviewSetBounds,
      3 => Activity::PreviewNavigate,
      4 => Activity::PreviewReload,
      5 => Activity::PreviewHide,
      6 => Activity::PreviewHistory,
      _ => Activity::Idle,
    }
  }
}

/// Code of the activity the main thread is currently executing (see [`Activity`]).
static CURRENT_ACTIVITY: AtomicU8 = AtomicU8::new(0);
/// Epoch-millis the current activity began.
static ACTIVITY_SINCE_MS: AtomicI64 = AtomicI64::new(0);

/// RAII marker for a main-thread operation. Restores the previous activity on
/// drop, so guards nest like a stack. Cheap: two relaxed atomic stores.
#[must_use = "the activity is only marked while the returned guard is alive"]
pub struct ActivityGuard(u8);

/// Mark the main thread as executing `next` until the returned guard drops. Call
/// this from code that runs *on the main thread* (sync commands, `with_webview`
/// closures) so a hang is attributed correctly.
pub fn activity(next: Activity) -> ActivityGuard {
  ACTIVITY_SINCE_MS.store(now_ms(), Ordering::Relaxed);
  ActivityGuard(CURRENT_ACTIVITY.swap(next as u8, Ordering::Relaxed))
}

impl Drop for ActivityGuard {
  fn drop(&mut self) {
    CURRENT_ACTIVITY.store(self.0, Ordering::Relaxed);
    ACTIVITY_SINCE_MS.store(now_ms(), Ordering::Relaxed);
  }
}

fn now_ms() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

/// Record that the main thread is alive as of now.
fn mark_alive() {
  LAST_ALIVE_MS.store(now_ms(), Ordering::Relaxed);
}

/// Record a main-thread tick from the event loop. Cheap enough to call on every
/// iteration; a supplementary freshness signal on top of the active probe.
pub fn beat() {
  mark_alive();
}

/// The bracketed context appended to hang log lines: what the main thread was
/// doing and for how long, the process working set (Windows), and uptime. All
/// reads are lock-free syscalls/atomics, safe to sample while the UI thread is
/// wedged.
fn stall_context() -> String {
  let act = Activity::from_u8(CURRENT_ACTIVITY.load(Ordering::Relaxed));
  let act_ms = {
    let since = ACTIVITY_SINCE_MS.load(Ordering::Relaxed);
    if since > 0 { (now_ms() - since).max(0) } else { 0 }
  };
  let uptime_s = {
    let start = STARTED_AT_MS.load(Ordering::Relaxed);
    if start > 0 { (now_ms() - start).max(0) / 1000 } else { 0 }
  };
  let mem = match current_rss_mb() {
    Some(mb) => format!(", rss={mb}MB"),
    None => String::new(),
  };
  format!(" [doing={} for ~{act_ms}ms{mem}, uptime={uptime_s}s]", act.label())
}

/// Current process working-set size in MiB, if cheaply available. Windows-only
/// (the target of the VM hangs); `None` elsewhere.
#[cfg(windows)]
fn current_rss_mb() -> Option<u64> {
  use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
  use windows::Win32::System::Threading::GetCurrentProcess;
  let mut counters = PROCESS_MEMORY_COUNTERS::default();
  let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
  let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, cb) };
  ok.as_bool().then(|| counters.WorkingSetSize as u64 / (1024 * 1024))
}

#[cfg(not(windows))]
fn current_rss_mb() -> Option<u64> {
  None
}

/// Spawn the monitor thread once. The thread is detached and lives for the app's
/// lifetime; it never touches the UI directly — it only posts a trivial liveness
/// task to the main thread and reads/writes atomics.
pub fn start(app: AppHandle) {
  STARTED_AT_MS.store(now_ms(), Ordering::Relaxed);
  mark_alive();
  std::thread::Builder::new()
    .name("hang-watchdog".into())
    .spawn(move || loop {
      std::thread::sleep(POLL_INTERVAL);

      // Actively probe the main thread. Posting a task *wakes* an idle event
      // loop (so an event-starved window is not mistaken for a hang), while a
      // genuinely blocked loop can't run it — leaving `LAST_ALIVE_MS` stale.
      // Hold at most one probe outstanding so a real hang doesn't queue a burst.
      if !PROBE_PENDING.swap(true, Ordering::SeqCst) {
        let posted = app.run_on_main_thread(|| {
          mark_alive();
          PROBE_PENDING.store(false, Ordering::SeqCst);
        });
        if posted.is_err() {
          // Event loop is gone (app shutting down) — nothing left to monitor.
          PROBE_PENDING.store(false, Ordering::SeqCst);
        }
      }

      let last = LAST_ALIVE_MS.load(Ordering::Relaxed);
      if last == 0 {
        continue; // no liveness signal yet
      }
      let now = now_ms();
      let lag = now - last;
      if lag >= STALL_THRESHOLD.as_millis() as i64 {
        if !STALLED.swap(true, Ordering::SeqCst) {
          // Newly stalled: remember when it began (the last confirmed liveness)
          // and log what the main thread was doing plus process context.
          STALL_STARTED_MS.store(last, Ordering::Relaxed);
          STALL_LAST_LOG_MS.store(now, Ordering::Relaxed);
          crashlog::log_error(
            "hang",
            &format!("main thread stalled for ~{lag}ms{}", stall_context()),
          );
        } else {
          // Still stalled: drop a breadcrumb periodically so we can see how long
          // a freeze lasts even if it ends in a force-quit (no recovery line).
          let last_log = STALL_LAST_LOG_MS.load(Ordering::Relaxed);
          if now - last_log >= STALL_PROGRESS_INTERVAL.as_millis() as i64 {
            STALL_LAST_LOG_MS.store(now, Ordering::Relaxed);
            let total = now - STALL_STARTED_MS.load(Ordering::Relaxed);
            crashlog::log_error(
              "hang",
              &format!("main thread STILL stalled ~{total}ms{}", stall_context()),
            );
          }
        }
      } else if STALLED.swap(false, Ordering::SeqCst) {
        // Recovered: report the *total* time the thread was wedged.
        let total = now - STALL_STARTED_MS.load(Ordering::Relaxed);
        crashlog::log_error(
          "hang",
          &format!("main thread recovered after being stalled ~{total}ms"),
        );
      }
    })
    .ok();
}
