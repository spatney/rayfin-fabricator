//! Helpers for emitting the two renderer-facing streaming events (`proc:log`,
//! `chat:event`) and for building streaming callbacks from an `AppHandle`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use super::exec::{OnData, Stream};
use crate::types::{ChatEvent, ChatEventEnvelope, ProcLogEvent};
use crate::types::{AdvisorEvent, AdvisorEventEnvelope};
use crate::types::{HelpEvent, HelpEventEnvelope};
use crate::types::{SecurityEvent, SecurityEventEnvelope};

/// Event name for streamed process output (matches `IpcChannels.procLog`).
pub const PROC_LOG: &str = "proc:log";
/// Event name for streamed chat events (matches `IpcChannels.chatEvent`).
pub const CHAT_EVENT: &str = "chat:event";
/// Event name for streamed advisor events (matches `IpcChannels.advisorEvent`).
pub const ADVISOR_EVENT: &str = "advisor:event";
/// Event name for streamed Help assistant events (matches `IpcChannels.helpEvent`).
pub const HELP_EVENT: &str = "help:event";
/// Event name for a package's security check as it goes (matches `IpcChannels.securityEvent`).
pub const SECURITY_EVENT: &str = "security:event";
/// Event name for update download progress (matches `IpcChannels.updateProgress`).
pub const UPDATE_PROGRESS: &str = "update:progress";
/// Event name for project-delete file-count progress (matches `IpcChannels.deleteProgress`).
pub const DELETE_PROGRESS: &str = "delete:progress";
/// Event name for exporting or importing a project's file (matches `IpcChannels.zipProgress`).
pub const ZIP_PROGRESS: &str = "zip:progress";
/// Event name for an exported project the system asked Fabricator to open (matches
/// `IpcChannels.exportOpened`).
pub const EXPORT_OPENED: &str = "export:opened";

/// How long buffered output is held before a batched `proc:log` is emitted. A
/// couple of frames: long enough to collapse a burst of small reads into one
/// event, short enough that logs still feel live.
const PROC_FLUSH: Duration = Duration::from_millis(25);

/// Ordered, stream-tagged output segments awaiting emission. Consecutive chunks
/// from the same stream are merged so a burst of small reads becomes one segment;
/// interleaving between stdout/stderr is preserved. Split out from [`Batcher`]
/// (no `AppHandle`) so the coalescing logic is unit-testable on its own.
#[derive(Default)]
struct SegBuf {
  segs: Mutex<Vec<(Stream, String)>>,
}

impl SegBuf {
  fn push(&self, stream: Stream, data: &str) {
    let mut segs = self.segs.lock().unwrap();
    match segs.last_mut() {
      Some(last) if last.0 == stream => last.1.push_str(data),
      _ => segs.push((stream, data.to_string())),
    }
  }

  /// Take and clear everything buffered so far.
  fn drain(&self) -> Vec<(Stream, String)> {
    std::mem::take(&mut *self.segs.lock().unwrap())
  }
}

/// Coalesces high-frequency process output into batched `proc:log` events. A
/// verbose command (e.g. `npm install`) can emit thousands of tiny reads; sending
/// one IPC event each floods the channel and the renderer. Instead we accumulate
/// and flush at most once per [`PROC_FLUSH`].
struct Batcher {
  app: AppHandle,
  channel: String,
  buf: SegBuf,
  /// True while a flush is already scheduled — keeps a burst to one timer.
  scheduled: AtomicBool,
}

impl Batcher {
  fn push(self: &Arc<Self>, stream: Stream, data: &str) {
    self.buf.push(stream, data);
    // Schedule a single flush per interval. `swap` ensures exactly one bursting
    // writer wins the race to spawn the timer.
    if !self.scheduled.swap(true, Ordering::AcqRel) {
      let me = Arc::clone(self);
      tokio::spawn(async move {
        tokio::time::sleep(PROC_FLUSH).await;
        // Clear *before* draining so a chunk that lands during this flush
        // schedules a follow-up rather than being stranded in the buffer.
        me.scheduled.store(false, Ordering::Release);
        me.flush();
      });
    }
  }

  fn flush(&self) {
    for (stream, data) in self.buf.drain() {
      if data.is_empty() {
        continue;
      }
      let _ = self.app.emit(
        PROC_LOG,
        ProcLogEvent {
          channel: self.channel.clone(),
          stream: stream.as_str().to_string(),
          data,
        },
      );
    }
  }
}

/// Build an [`OnData`] callback that forwards process output to the renderer on
/// the given logical channel, coalescing bursts into batched `proc:log` events.
pub fn proc_streamer(app: &AppHandle, channel: &str) -> OnData {
  let batcher = Arc::new(Batcher {
    app: app.clone(),
    channel: channel.to_string(),
    buf: SegBuf::default(),
    scheduled: AtomicBool::new(false),
  });
  Arc::new(move |stream: Stream, data: &str| {
    batcher.push(stream, data);
  })
}

/// Streamed events of one chat turn waiting to go to the renderer, merged as
/// its `ChatEventBuffer` merges them: consecutive reply text, consecutive text
/// of one reasoning block, and only the newest output of a running step (each
/// carries all of it so far). Split out from [`emit_chat_event`] (no
/// `AppHandle`) so the batching is unit-testable on its own.
#[derive(Default)]
struct ChatStream {
  queue: Vec<ChatEvent>,
  /// When the last batch went out.
  flushed: Option<Instant>,
  /// A flush is already scheduled.
  scheduled: bool,
}

/// How often a chat turn's streamed events go to the renderer at most. Copilot
/// reports every few tokens, and each event is a script the webview runs; the
/// renderer redraws a streaming reply only every 90 ms, so batching under that
/// adds no delay anyone sees.
const CHAT_FLUSH: Duration = Duration::from_millis(50);

/// Most chat turns whose streams are kept: a turn's is dropped when it ends.
const MAX_CHAT_STREAMS: usize = 64;

/// The chat events that stream (reply text, reasoning, a running step's output).
fn is_streamed(event: &ChatEvent) -> bool {
  matches!(event, ChatEvent::Delta { .. } | ChatEvent::Reasoning { .. } | ChatEvent::ToolOutput { .. })
}

impl ChatStream {
  fn push(&mut self, event: ChatEvent) {
    match event {
      ChatEvent::Delta { text: more } => {
        if let Some(ChatEvent::Delta { text }) = self.queue.last_mut() {
          text.push_str(&more);
          return;
        }
        self.queue.push(ChatEvent::Delta { text: more });
      }
      ChatEvent::Reasoning { id: block, text: more } => {
        if let Some(ChatEvent::Reasoning { id, text }) = self.queue.last_mut() {
          if *id == block {
            text.push_str(&more);
            return;
          }
        }
        self.queue.push(ChatEvent::Reasoning { id: block, text: more });
      }
      ChatEvent::ToolOutput { id, text } => {
        self.queue.retain(|queued| !matches!(queued, ChatEvent::ToolOutput { id: step, .. } if *step == id));
        self.queue.push(ChatEvent::ToolOutput { id, text });
      }
      other => self.queue.push(other),
    }
  }

  /// How long until the next batch may go: nothing after a quiet spell.
  fn wait(&self, now: Instant) -> Duration {
    self.flushed.map(|at| CHAT_FLUSH.saturating_sub(now.saturating_duration_since(at))).unwrap_or_default()
  }

  /// Take what's waiting to go out.
  fn take(&mut self, now: Instant) -> Vec<ChatEvent> {
    if !self.queue.is_empty() {
      self.flushed = Some(now);
    }
    std::mem::take(&mut self.queue)
  }
}

/// The chat turns' streams, by project and turn.
type ChatStreams = Mutex<HashMap<(String, String), ChatStream>>;

/// The app's chat streams. Held while a batch is emitted, so every emitter's
/// events (the turn's own, a plan card, a tool's question) reach the renderer
/// in the order they were sent.
static CHAT_STREAMS: Lazy<ChatStreams> = Lazy::new(Default::default);

/// Where chat events go: the renderer, or in tests, a record of them.
trait ChatSink: Clone + Send + 'static {
  fn send(&self, project_id: &str, turn_id: &str, event: ChatEvent);
}

impl ChatSink for AppHandle {
  fn send(&self, project_id: &str, turn_id: &str, event: ChatEvent) {
    let _ = self.emit(
      CHAT_EVENT,
      ChatEventEnvelope {
        project_id: project_id.to_string(),
        turn_id: turn_id.to_string(),
        event,
      },
    );
  }
}

/// Emit one chat event, wrapped in its routing envelope. Streamed events go out
/// in batches, at most once per [`CHAT_FLUSH`] (the first after a quiet spell
/// at once); any other event first sends what its turn streamed before it.
pub fn emit_chat_event(app: &AppHandle, project_id: &str, turn_id: &str, event: ChatEvent) {
  stream_chat_event(&CHAT_STREAMS, app, project_id, turn_id, event);
}

fn stream_chat_event<S: ChatSink>(
  all: &'static ChatStreams,
  sink: &S,
  project_id: &str,
  turn_id: &str,
  event: ChatEvent,
) {
  let key = (project_id.to_string(), turn_id.to_string());
  let now = Instant::now();
  let mut streams = all.lock().unwrap_or_else(|e| e.into_inner());
  if !is_streamed(&event) {
    let pending = streams.get_mut(&key).map(|stream| stream.take(now)).unwrap_or_default();
    // The turn is over.
    if matches!(event, ChatEvent::Result { .. }) {
      streams.remove(&key);
    }
    for queued in pending {
      sink.send(project_id, turn_id, queued);
    }
    sink.send(project_id, turn_id, event);
    return;
  }
  if streams.len() >= MAX_CHAT_STREAMS && !streams.contains_key(&key) {
    streams.retain(|_, stream| stream.scheduled || !stream.queue.is_empty());
  }
  let stream = streams.entry(key.clone()).or_default();
  stream.push(event);
  if stream.scheduled {
    return;
  }
  let wait = stream.wait(now);
  if wait.is_zero() {
    for queued in stream.take(now) {
      sink.send(project_id, turn_id, queued);
    }
    return;
  }
  stream.scheduled = true;
  drop(streams);
  let sink = sink.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(wait).await;
    let mut streams = all.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(stream) = streams.get_mut(&key) {
      stream.scheduled = false;
      for queued in stream.take(Instant::now()) {
        sink.send(&key.0, &key.1, queued);
      }
    }
  });
}

/// Emit one advisor event, wrapped in its routing envelope.
pub fn emit_advisor_event(app: &AppHandle, project_id: &str, event: AdvisorEvent) {
  let _ = app.emit(
    ADVISOR_EVENT,
    AdvisorEventEnvelope {
      project_id: project_id.to_string(),
      event,
    },
  );
}

/// Emit one Help assistant event, routed to the question that produced it.
pub fn emit_help_event(app: &AppHandle, ask_id: &str, event: HelpEvent) {
  let _ = app.emit(HELP_EVENT, HelpEventEnvelope { ask_id: ask_id.to_string(), event });
}

/// Emit one security check event, routed to the check that produced it.
pub fn emit_security_event(app: &AppHandle, check_id: &str, event: SecurityEvent) {
  let _ = app.emit(SECURITY_EVENT, SecurityEventEnvelope { check_id: check_id.to_string(), event });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn segbuf_merges_consecutive_same_stream_chunks() {
    let buf = SegBuf::default();
    // A burst of small stdout reads with one stderr line in the middle.
    buf.push(Stream::Stdout, "npm ");
    buf.push(Stream::Stdout, "install");
    buf.push(Stream::Stdout, "ing…\n");
    buf.push(Stream::Stderr, "warn: deprecated\n");
    buf.push(Stream::Stdout, "done\n");

    let out = buf.drain();
    // The three consecutive stdout reads collapse to one segment; the stderr line
    // stays separate and interleaving order is preserved.
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].0, Stream::Stdout);
    assert_eq!(out[0].1, "npm installing…\n");
    assert_eq!(out[1].0, Stream::Stderr);
    assert_eq!(out[1].1, "warn: deprecated\n");
    assert_eq!(out[2].0, Stream::Stdout);
    assert_eq!(out[2].1, "done\n");

    // draining empties the buffer.
    assert!(buf.drain().is_empty());
  }

  #[test]
  fn segbuf_concatenation_is_byte_identical_to_the_raw_chunks() {
    let buf = SegBuf::default();
    let chunks = ["a", "b", "c\n", "d"];
    for c in chunks {
      buf.push(Stream::Stdout, c);
    }
    let joined: String = buf.drain().into_iter().map(|(_, d)| d).collect();
    assert_eq!(joined, chunks.concat());
  }

  #[test]
  fn a_chat_stream_merges_text_and_keeps_only_a_running_steps_newest_output() {
    let mut stream = ChatStream::default();
    let delta = |text: &str| ChatEvent::Delta { text: text.into() };
    let reasoning = |id: &str, text: &str| ChatEvent::Reasoning { id: id.into(), text: text.into() };
    let output = |id: &str, text: &str| ChatEvent::ToolOutput { id: id.into(), text: text.into() };
    for event in [
      reasoning("r1", "Look"),
      reasoning("r1", " first."),
      reasoning("r2", "Then"),
      delta("Here"),
      delta(" it is."),
      output("t1", "1"),
      output("t2", "a"),
      delta("\n\n"),
      output("t1", "1\n2"),
    ] {
      stream.push(event);
    }
    let batch = serde_json::to_value(stream.take(Instant::now())).unwrap();
    assert_eq!(
      batch,
      serde_json::json!([
        { "type": "reasoning", "id": "r1", "text": "Look first." },
        { "type": "reasoning", "id": "r2", "text": "Then" },
        { "type": "delta", "text": "Here it is." },
        { "type": "tool-output", "id": "t2", "text": "a" },
        { "type": "delta", "text": "\n\n" },
        { "type": "tool-output", "id": "t1", "text": "1\n2" },
      ])
    );
    assert!(stream.take(Instant::now()).is_empty());
  }

  /// What a turn's events reach the renderer as.
  #[derive(Clone, Default)]
  struct Recorder(Arc<Mutex<Vec<serde_json::Value>>>);

  impl ChatSink for Recorder {
    fn send(&self, _project_id: &str, _turn_id: &str, event: ChatEvent) {
      self.0.lock().unwrap().push(serde_json::to_value(event).unwrap());
    }
  }

  #[tokio::test]
  async fn a_turns_stream_goes_out_in_order_and_in_batches_and_ends_with_the_turn() {
    use serde_json::json;
    static STREAMS: Lazy<ChatStreams> = Lazy::new(Default::default);
    let sink = Recorder::default();
    let emit = |event: ChatEvent| stream_chat_event(&STREAMS, &sink, "p", "t", event);
    let delta = |text: &str| ChatEvent::Delta { text: text.into() };
    let sent = || sink.0.lock().unwrap().clone();

    // The first text goes at once; what follows within the interval waits.
    emit(delta("Here"));
    emit(delta(" it"));
    emit(delta(" is."));
    assert_eq!(sent(), [json!({ "type": "delta", "text": "Here" })]);
    // Anything else goes after what streamed before it.
    emit(ChatEvent::Notice { text: "Reconnecting".into() });
    assert_eq!(
      sent()[1..],
      [json!({ "type": "delta", "text": " it is." }), json!({ "type": "notice", "text": "Reconnecting" })]
    );
    // Text that waits goes out once the interval is up.
    emit(delta("\n\nDone."));
    assert_eq!(sent().len(), 3);
    let deadline = Instant::now() + Duration::from_secs(5);
    while sent().len() < 4 && Instant::now() < deadline {
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(sent()[3], json!({ "type": "delta", "text": "\n\nDone." }));
    // The turn's end drops its stream.
    emit(ChatEvent::Result { ok: true, files_modified: vec![], ran_deploy: false });
    assert_eq!(sent().len(), 5);
    assert!(STREAMS.lock().unwrap().is_empty());
  }
}
