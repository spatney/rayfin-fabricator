//! Helpers for emitting the two renderer-facing streaming events (`proc:log`,
//! `chat:event`) and for building streaming callbacks from an `AppHandle`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::exec::{OnData, Stream};
use crate::types::{ChatEvent, ChatEventEnvelope, ProcLogEvent};
use crate::types::{AdvisorEvent, AdvisorEventEnvelope};

/// Event name for streamed process output (matches `IpcChannels.procLog`).
pub const PROC_LOG: &str = "proc:log";
/// Event name for streamed chat events (matches `IpcChannels.chatEvent`).
pub const CHAT_EVENT: &str = "chat:event";
/// Event name for streamed advisor events (matches `IpcChannels.advisorEvent`).
pub const ADVISOR_EVENT: &str = "advisor:event";
/// Event name for update download progress (matches `IpcChannels.updateProgress`).
pub const UPDATE_PROGRESS: &str = "update:progress";
/// Event name for project-delete file-count progress (matches `IpcChannels.deleteProgress`).
pub const DELETE_PROGRESS: &str = "delete:progress";

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

/// Emit one chat event, wrapped in its routing envelope.
pub fn emit_chat_event(app: &AppHandle, project_id: &str, turn_id: &str, event: ChatEvent) {
  let _ = app.emit(
    CHAT_EVENT,
    ChatEventEnvelope {
      project_id: project_id.to_string(),
      turn_id: turn_id.to_string(),
      event,
    },
  );
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
}
