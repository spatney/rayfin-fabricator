//! One-shot HTML/CSS generation for the preview "design mode" Insert tool.
//!
//! When the user drops a placeholder and describes it, the renderer calls
//! [`design_generate_html`] to turn that description into a small, self-contained
//! HTML/CSS snippet that renders inside the placeholder's box and seeds the chat
//! hand-off. Like [`crate::commands::suggest`], this runs on a **transient**
//! throwaway Copilot session (defaulting to a fast model) so it never touches the
//! project's chat history; the prompt is constrained to HTML + CSS only (no JS,
//! no external resources) so any model can satisfy it and the output is safe to
//! inject after the renderer's DOM-level sanitize.

use std::collections::HashMap;
use std::time::Duration;

use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::MessageOptions;
use serde_json::Value;
use tauri::State;

use crate::services::store;
use crate::state::AppState;

/// Ceiling for a single generation run (the UI shows a "Generating…" state and
/// falls back gracefully on timeout).
const RUN_TIMEOUT_MS: u64 = 60_000;

/// Build the constrained instruction. Deliberately narrow: one self-contained
/// HTML snippet, inline CSS only, no JavaScript and no external resources — so
/// any model can produce it and the result is safe to drop into the live page.
fn build_prompt(description: &str, width: u32, height: u32) -> String {
    let desc = description.trim();
    format!(
        "Generate ONE small, self-contained HTML snippet for a UI component described as:\n\
\"{desc}\"\n\n\
It will be placed inside a box roughly {width}x{height} px. Requirements:\n\
- HTML + CSS ONLY. Put styles in a single <style> block or inline `style` attributes.\n\
- NO JavaScript, NO <script>, NO event handlers (onclick, onload, ...).\n\
- NO external resources: no external images, fonts, stylesheets, CDNs, or URLs. \
Use CSS gradients/shapes/emoji or inline SVG for any visuals, and placeholder text for content.\n\
- Make it look polished and fill the box responsively (width:100%; height:100%; box-sizing:border-box).\n\
- Keep it compact.\n\n\
Return ONLY a single fenced ```html code block containing the snippet, and nothing else."
    )
}

/// Streaming accumulator (mirrors the suggest command).
#[derive(Default)]
struct GenState {
    assistant: String,
    streamed: HashMap<String, usize>,
}

/// Feed one Copilot server event in. Returns `true` at a terminal state.
fn map_event(event_type: &str, data: &Value, st: &mut GenState) -> bool {
    match event_type {
        "assistant.message_delta" => {
            let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let text = data.get("deltaContent").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return false;
            }
            st.assistant.push_str(text);
            *st.streamed.entry(id).or_insert(0) += text.chars().count();
        }
        "assistant.message" => {
            let id = data.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let total = content.chars().count();
            let have = *st.streamed.get(&id).unwrap_or(&0);
            if total > have {
                let rest: String = content.chars().skip(have).collect();
                st.assistant.push_str(&rest);
                st.streamed.insert(id, total);
            }
        }
        "session.error" | "session.idle" => return true,
        _ => {}
    }
    false
}

/// Pull the body of the last fenced code block (stripping a short language tag
/// like ```html), falling back to the widest plausible HTML slice.
fn extract_html(text: &str) -> String {
    let parts: Vec<&str> = text.split("```").collect();
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 1;
    while i < parts.len() {
        let mut block = parts[i];
        if let Some(nl) = block.find('\n') {
            let first = block[..nl].trim();
            if !first.contains('<') && first.len() <= 12 {
                block = &block[nl + 1..];
            }
        }
        blocks.push(block.trim().to_string());
        i += 2;
    }
    if let Some(last) = blocks.into_iter().rev().find(|b| !b.is_empty()) {
        return last;
    }
    // No fenced block — fall back to the widest tag span.
    if let (Some(start), Some(end)) = (text.find('<'), text.rfind('>')) {
        if end > start {
            return text[start..=end].trim().to_string();
        }
    }
    String::new()
}

/// Generate a self-contained HTML/CSS snippet for a placeholder from a natural
/// description. Runs on a transient session (defaulting to a fast `model`);
/// returns the extracted HTML (the renderer sanitizes before injecting). Returns
/// an error string the renderer surfaces as a soft failure.
#[tauri::command]
pub async fn design_generate_html(
    state: State<'_, AppState>,
    project_id: String,
    description: String,
    width: u32,
    height: u32,
    model: Option<String>,
) -> Result<String, String> {
    if description.trim().is_empty() {
        return Err("Describe the component first.".into());
    }
    let Some(project) = store::find_project(&project_id) else {
        return Err("Project not found.".into());
    };

    // Transient, uncached session (fast model) — never lands in chat history.
    let session = state
        .copilot
        .transient_session(&project.path, model, None)
        .await
        .map_err(|_| "Couldn't reach the model.".to_string())?;

    let mut st = GenState::default();
    let mut sub = session.subscribe();
    let prompt = build_prompt(&description, width, height);
    let sent = session.send(MessageOptions::new(prompt)).await.is_ok();

    if sent {
        let drain = async {
            loop {
                match sub.recv().await {
                    Ok(ev) => {
                        if map_event(&ev.event_type, &ev.data, &mut st) {
                            break;
                        }
                    }
                    Err(err) => match err.kind() {
                        RecvErrorKind::Lagged(_) => {}
                        _ => break,
                    },
                }
            }
        };
        if tokio::time::timeout(Duration::from_millis(RUN_TIMEOUT_MS), drain)
            .await
            .is_err()
        {
            let _ = session.abort().await;
        }
    }
    let _ = session.disconnect().await;

    if !sent {
        return Err("Couldn't send the request to the model.".into());
    }
    let html = extract_html(&st.assistant);
    if html.is_empty() {
        return Err("The model didn't return any HTML.".into());
    }
    Ok(html)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_html_prefers_last_fenced_block() {
        let text = "sure, here you go:\n```html\n<div class=\"card\">Hi</div>\n```\nlet me know!";
        assert_eq!(extract_html(text), "<div class=\"card\">Hi</div>");
    }

    #[test]
    fn extract_html_strips_language_tag_only() {
        let text = "```html\n<p>x</p>\n```";
        assert_eq!(extract_html(text), "<p>x</p>");
    }

    #[test]
    fn extract_html_falls_back_to_tag_span() {
        let text = "no fences but <section>hello</section> here";
        assert_eq!(extract_html(text), "<section>hello</section>");
    }

    #[test]
    fn extract_html_empty_when_no_markup() {
        assert_eq!(extract_html("just prose, no tags"), "");
    }
}
