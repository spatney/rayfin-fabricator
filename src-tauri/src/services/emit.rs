//! Helpers for emitting the two renderer-facing streaming events (`proc:log`,
//! `chat:event`) and for building streaming callbacks from an `AppHandle`.

use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::exec::{OnData, Stream};
use crate::types::{ChatEvent, ChatEventEnvelope, ProcLogEvent};

/// Event name for streamed process output (matches `IpcChannels.procLog`).
pub const PROC_LOG: &str = "proc:log";
/// Event name for streamed chat events (matches `IpcChannels.chatEvent`).
pub const CHAT_EVENT: &str = "chat:event";

/// Build an [`OnData`] callback that forwards process output to the renderer on
/// the given logical channel.
pub fn proc_streamer(app: &AppHandle, channel: &str) -> OnData {
  let app = app.clone();
  let channel = channel.to_string();
  Arc::new(move |stream: Stream, data: &str| {
    let _ = app.emit(
      PROC_LOG,
      ProcLogEvent {
        channel: channel.clone(),
        stream: stream.as_str().to_string(),
        data: data.to_string(),
      },
    );
  })
}

/// Emit one chat event, wrapped in its routing envelope.
pub fn emit_chat_event(
  app: &AppHandle,
  project_id: &str,
  thread_id: &str,
  turn_id: &str,
  event: ChatEvent,
) {
  let _ = app.emit(
    CHAT_EVENT,
    ChatEventEnvelope {
      project_id: project_id.to_string(),
      thread_id: thread_id.to_string(),
      turn_id: turn_id.to_string(),
      event,
    },
  );
}
