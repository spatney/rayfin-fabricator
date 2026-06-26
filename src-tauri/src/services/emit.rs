//! Helpers for emitting the two renderer-facing streaming events (`proc:log`,
//! `chat:event`) and for building streaming callbacks from an `AppHandle`.

use std::sync::Arc;

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
