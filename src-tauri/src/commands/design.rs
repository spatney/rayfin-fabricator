//! Model-backed and source-aware helpers for Design mode ("visual chat").
//!
//! * [`design_variations`] asks a fast model for a few named alternative looks
//!   for one element — whitelisted inline-CSS patches (or Graphein spec patches
//!   for charts) that the in-page controller previews live.
//! * [`design_polish`] reviews a compact outline of the page (plus a screenshot)
//!   and proposes a handful of concrete, previewable improvements.
//! * [`design_locate`] finds the likely source lines behind picked elements.
//!
//! The model calls run on **transient, read-only** Copilot sessions: they never
//! land in the project's chat history, can't write files or run commands, and
//! must answer with JSON only. Nothing here edits the project — Copilot applies
//! the chosen changes later, in one ordinary chat turn.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;

use github_copilot_sdk::subscription::RecvErrorKind;
use github_copilot_sdk::{Attachment, MessageOptions};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::commands::screenshot;
use crate::services::byok;
use crate::services::copilot::ModelChoice;
use crate::services::design_locate::{self, LocateResult, LocateTarget};
use crate::services::emit::DESIGN_VARIATION;
use crate::services::store;
use crate::state::AppState;

/// Ceiling for a single model run (the UI shows a busy state and recovers on
/// timeout).
const RUN_TIMEOUT_MS: u64 = 60_000;
/// Variations offered per request (and the most a caller may ask for).
const DEFAULT_VARIATIONS: usize = 3;
const MAX_VARIATIONS: usize = 4;
/// A run that failed with the element's screenshot is retried without it only
/// when it failed this fast, so both runs fit inside the page's 90 s wait.
const IMAGE_RETRY_WITHIN: Duration = Duration::from_secs(25);
/// Polish suggestions returned at most.
const MAX_SUGGESTIONS: usize = 6;
/// Outline elements and findings a Polish prompt includes at most.
const MAX_OUTLINE_ELEMENTS: usize = 80;
const MAX_FINDINGS: usize = 24;

/// CSS properties a model-proposed preview may set on a live element.
/// Deliberately a safe, layout/typography/appearance-only subset — anything else
/// is dropped, and the in-page controller re-checks the same list.
const ALLOWED_RESTYLE_PROPS: &[&str] = &[
    "color",
    "background",
    "background-color",
    "background-image",
    "border",
    "border-color",
    "border-width",
    "border-style",
    "border-radius",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-transform",
    "text-decoration",
    "opacity",
    "box-shadow",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "display",
    "gap",
    "row-gap",
    "column-gap",
    "align-items",
    "justify-content",
    "flex-direction",
    "flex-wrap",
    "grid-template-columns",
    "font-family",
    "border-top",
    "border-bottom",
];

/// Compact element context the renderer sends with a variations request:
/// enough for the model to make a good local proposal without the whole DOM.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestyleContext {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub classes: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    /// Current (relevant) computed styles, keyed by CSS property.
    #[serde(default)]
    pub styles: HashMap<String, String>,
    #[serde(default)]
    pub is_chart: bool,
    #[serde(default)]
    pub chart_type: Option<String>,
    /// Current Graphein spec (data omitted by the renderer) for charts.
    #[serde(default)]
    pub spec: Option<Value>,
    /// Compact summary of notable descendants ({tag, classes, text}) so the model
    /// can target children via `rules`.
    #[serde(default)]
    pub children: Option<Value>,
    /// The app's design system (see `DesignSystemSummary` in `src/shared/design.ts`).
    #[serde(default)]
    pub system: Option<DesignSystem>,
}

/// The app's theme tokens in brief, as the page read them: pairs keep the page's
/// order (most-used colors first, scales smallest first).
#[derive(serde::Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DesignSystem {
    pub colors: Vec<(String, String)>,
    pub palettes: Vec<String>,
    pub text: Vec<(String, String)>,
    pub spacing: Vec<(String, String)>,
    pub spacing_base: Option<String>,
    pub radius: Vec<(String, String)>,
    pub fonts: Vec<(String, String)>,
    pub dark: bool,
}

impl DesignSystem {
    /// Whether the app has its own tokens to build options from.
    fn has_tokens(&self) -> bool {
        !self.colors.is_empty() || !self.text.is_empty() || !self.spacing.is_empty()
    }
}

/// Whitelisted CSS for the element, descendant rules, and an optional Graphein
/// spec patch (charts).
#[derive(Default, PartialEq, Debug)]
struct RestylePatch {
    styles: HashMap<String, String>,
    graphein: Option<Value>,
    rules: Vec<RestyleRule>,
}

impl RestylePatch {
    fn is_empty(&self) -> bool {
        self.styles.is_empty() && self.graphein.is_none() && self.rules.is_empty()
    }
}

/// A restyle rule targeting descendants of the element.
#[derive(serde::Serialize, Default, PartialEq, Debug, Clone)]
pub struct RestyleRule {
    pub selector: String,
    pub styles: HashMap<String, String>,
}

/// One proposed alternative look (see `DesignVariation` in `src/shared/design.ts`).
#[derive(serde::Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Variation {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub styles: HashMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RestyleRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graphein: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classes: Option<String>,
}

/// One proposed page improvement (see `DesignSuggestion` in `src/shared/design.ts`).
#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub why: String,
    pub instruction: String,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub styles: HashMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RestyleRule>,
}

/// The page outline the renderer collects for a Polish pass.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageOutline {
    pub route: String,
    pub title: String,
    pub viewport: Value,
    pub elements: Vec<OutlineElement>,
    pub findings: Vec<Finding>,
    pub system: Option<DesignSystem>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OutlineElement {
    #[serde(rename = "ref")]
    pub reference: String,
    pub label: String,
    pub role: String,
    pub tag: String,
    pub text: Option<String>,
    pub classes: Option<String>,
    pub styles: HashMap<String, String>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Finding {
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub kind: String,
    pub message: String,
}

/* ----------------------------- model plumbing ----------------------------- */

/// Design's one-shot calls answer from the prompt (and an optional screenshot)
/// alone, so their sessions carry no built-in tools: tool schemas would only add
/// prompt size and latency. The read-only policy stays as a backstop.
fn design_session_options(cwd: &str) -> crate::services::copilot::SessionOptions {
    crate::services::copilot::SessionOptions {
        available_tools: Some(Vec::new()),
        ..crate::commands::advisor::read_only_options(cwd)
    }
}

/// Streaming accumulator for one transient run.
#[derive(Default)]
struct GenState {
    assistant: String,
    streamed: HashMap<String, usize>,
    /// The session's error message, when it reported one.
    error: Option<String>,
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
        "session.error" => {
            st.error = data.get("message").and_then(|v| v.as_str()).map(str::to_string);
            return true;
        }
        "session.idle" => return true,
        _ => {}
    }
    false
}

/// Run `prompt` once on a transient, read-only session rooted at `cwd` and
/// return the assistant's full reply. Never touches the project's chat.
/// `on_text` sees the reply so far each time it grows. A model on the user's
/// own key must be able to run first, and its errors come back in plain language.
async fn run_transient(
    state: &AppState,
    cwd: &str,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
    attachments: &[PathBuf],
    mut on_text: Option<&mut (dyn FnMut(&str) + Send)>,
) -> Result<String, String> {
    let mut options = design_session_options(cwd);
    let provider_model = model.clone().filter(|m| byok::is_provider_selection(m));
    if let Some(m) = &provider_model {
        state.byok.ensure_ready(m)?;
        options.byok = state.byok.session_registry();
    }
    let session = state
        .copilot
        .transient_session_with(cwd, ModelChoice::of(model, effort), options)
        .await
        .map_err(|_| "Couldn't reach the model.".to_string())?;

    let mut st = GenState::default();
    let mut sub = session.subscribe();
    let mut opts = MessageOptions::new(prompt);
    if !attachments.is_empty() {
        opts = opts.with_attachments(
            attachments
                .iter()
                .map(|p| Attachment::File { path: p.clone(), display_name: None, line_range: None })
                .collect(),
        );
    }
    let sent = session.send(opts).await.is_ok();
    if sent {
        let drain = async {
            loop {
                match sub.recv().await {
                    Ok(ev) => {
                        let before = st.assistant.len();
                        let done = map_event(&ev.event_type, &ev.data, &mut st);
                        if st.assistant.len() != before {
                            if let Some(f) = on_text.as_mut() {
                                f(&st.assistant);
                            }
                        }
                        if done {
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
        if tokio::time::timeout(Duration::from_millis(RUN_TIMEOUT_MS), drain).await.is_err() {
            let _ = session.abort().await;
        }
    }
    let _ = session.disconnect().await;
    if !sent {
        return Err("Couldn't send the request to the model.".into());
    }
    if st.assistant.trim().is_empty() {
        if let (Some(model), Some(raw)) = (&provider_model, &st.error) {
            return Err(byok::explain_for(model, raw).unwrap_or_else(|| raw.clone()));
        }
    }
    Ok(st.assistant)
}

/* ----------------------------- JSON extraction ----------------------------- */

/// Parse the model's JSON answer: the last fenced block that parses, else the
/// widest `[…]` or `{…}` span.
fn extract_json(text: &str) -> Option<Value> {
    let parts: Vec<&str> = text.split("```").collect();
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 1;
    while i < parts.len() {
        let mut block = parts[i];
        if let Some(nl) = block.find('\n') {
            let first = block[..nl].trim();
            if !first.contains(['{', '[']) && first.len() <= 12 {
                block = &block[nl + 1..];
            }
        }
        blocks.push(block.trim().to_string());
        i += 2;
    }
    for block in blocks.into_iter().rev() {
        if block.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&block) {
            return Some(v);
        }
    }
    for (open, close) in [('[', ']'), ('{', '}')] {
        if let (Some(start), Some(end)) = (text.find(open), text.rfind(close)) {
            if end > start {
                if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// The list of entries in a model answer: a bare array, or the first array
/// under one of `keys` in an object.
fn entries(val: Value, keys: &[&str]) -> Vec<Value> {
    match val {
        Value::Array(items) => items,
        Value::Object(mut map) => keys
            .iter()
            .find_map(|k| match map.remove(*k) {
                Some(Value::Array(items)) => Some(items),
                _ => None,
            })
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Collect whitelisted CSS property→value pairs from a JSON object, dropping any
/// property not in [`ALLOWED_RESTYLE_PROPS`] and any value carrying an external
/// resource / script vector (defense-in-depth; the controller also sanitizes).
fn collect_styles(map: &serde_json::Map<String, Value>, out: &mut HashMap<String, String>) {
    for (k, v) in map {
        let key = k.trim().to_lowercase();
        if !ALLOWED_RESTYLE_PROPS.contains(&key.as_str()) {
            continue;
        }
        let val = match v {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) => n.to_string(),
            _ => continue,
        };
        if val.is_empty() || val.len() > 200 {
            continue;
        }
        let low = val.to_lowercase();
        if low.contains("url(")
            || low.contains("expression(")
            || low.contains("javascript:")
            || low.contains("@import")
            || low.contains(['<', '>', '{', '}', ';'])
        {
            continue;
        }
        out.insert(key, val);
    }
}

/// Descendant rules (`[{ selector, styles }]`) with plain, element-relative
/// selectors only.
fn collect_rules(map: &serde_json::Map<String, Value>) -> Vec<RestyleRule> {
    let Some(Value::Array(arr)) = map.get("rules") else {
        return vec![];
    };
    arr.iter()
        .filter_map(|r| {
            let Value::Object(ro) = r else { return None };
            let sel = ro.get("selector").and_then(|v| v.as_str()).unwrap_or("").trim();
            if sel.is_empty() || sel.len() > 100 || sel.contains(['{', '}', '<', '@', '"', ';']) {
                return None;
            }
            let mut styles = HashMap::new();
            if let Some(Value::Object(s)) = ro.get("styles") {
                collect_styles(s, &mut styles);
            }
            (!styles.is_empty()).then(|| RestyleRule { selector: sel.to_string(), styles })
        })
        .take(12)
        .collect()
}

/// Keys of a variation/suggestion entry that describe it rather than style it.
const META_KEYS: &[&str] = &["name", "description", "classes", "title", "why", "instruction", "ref", "id"];

/// Turn one model entry into a patch. Accepts `{ "styles": {…}, "rules": […] }`,
/// a flat object of CSS props, and — for charts — a `graphein`/`spec` object or
/// the bare object itself (minus descriptive keys and any `data`).
fn to_patch(val: &Value, allow_chart: bool) -> RestylePatch {
    let mut patch = RestylePatch::default();
    let Value::Object(map) = val else {
        return patch;
    };
    if let Some(Value::Object(styles)) = map.get("styles") {
        collect_styles(styles, &mut patch.styles);
    }
    if allow_chart {
        let g = map.get("graphein").or_else(|| map.get("spec")).cloned().unwrap_or_else(|| {
            let mut m = map.clone();
            for k in META_KEYS.iter().chain(["styles", "rules"].iter()) {
                m.remove(*k);
            }
            Value::Object(m)
        });
        if let Value::Object(mut obj) = g {
            obj.remove("data");
            if !obj.is_empty() {
                patch.graphein = Some(Value::Object(obj));
            }
        }
    } else {
        if patch.styles.is_empty() && !map.contains_key("styles") {
            collect_styles(map, &mut patch.styles);
        }
        patch.rules = collect_rules(map);
    }
    patch
}

fn clipped(val: Option<&Value>, max: usize) -> Option<String> {
    let s = val?.as_str()?.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return None;
    }
    Some(if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s })
}

/// Tailwind utilities are plain tokens: keep only those, capped.
fn class_hint(val: Option<&Value>) -> Option<String> {
    let s = val?.as_str()?;
    let tokens: Vec<&str> = s
        .split_whitespace()
        .filter(|t| {
            t.len() <= 60
                && t.chars().all(|c| c.is_ascii_alphanumeric() || "-_:/[]().%#!".contains(c))
        })
        .take(24)
        .collect();
    (!tokens.is_empty()).then(|| tokens.join(" "))
}

/// One model entry as a variation, unless it previews nothing or repeats a name.
fn variation_from(entry: &Value, index: usize, is_chart: bool, seen: &mut HashSet<String>) -> Option<Variation> {
    let patch = to_patch(entry, is_chart);
    if patch.is_empty() {
        return None;
    }
    let name = clipped(entry.get("name"), 32).unwrap_or_else(|| format!("Option {}", index + 1));
    if !seen.insert(name.to_lowercase()) {
        return None;
    }
    Some(Variation {
        name,
        description: clipped(entry.get("description"), 140),
        styles: patch.styles,
        rules: patch.rules,
        graphein: patch.graphein,
        classes: if is_chart { None } else { class_hint(entry.get("classes")) },
    })
}

/// Parse up to `count` distinct, non-empty variations from a model answer.
fn parse_variations(text: &str, is_chart: bool, count: usize) -> Vec<Variation> {
    let Some(val) = extract_json(text) else { return vec![] };
    let mut seen: HashSet<String> = HashSet::new();
    entries(val, &["variations", "options"])
        .iter()
        .enumerate()
        .filter_map(|(i, entry)| variation_from(entry, i, is_chart, &mut seen))
        .take(count)
        .collect()
}

/// What a run produced: the parsed reply, else the options that streamed in
/// before it ended early (a timeout or an error mid-reply). Those are already
/// on screen, so they stand rather than turn into an error.
fn settled(parsed: Vec<Variation>, streamed: Vec<Variation>) -> Vec<Variation> {
    if parsed.is_empty() {
        streamed
    } else {
        parsed
    }
}

/// Pulls each complete top-level object out of a JSON array while the reply
/// streams in, so an option can show before the model writes the rest. Scans
/// bytes: every JSON delimiter is ASCII, so slices stay on char boundaries.
#[derive(Default)]
struct EntryStream {
    /// Where scanning resumes in the reply so far.
    pos: usize,
    in_array: bool,
    depth: usize,
    in_string: bool,
    escaped: bool,
    /// Start of the object being read.
    start: Option<usize>,
}

impl EntryStream {
    /// The entries completed since the last call; `text` is the whole reply so far.
    fn feed(&mut self, text: &str) -> Vec<Value> {
        let bytes = text.as_bytes();
        let mut done = Vec::new();
        while self.pos < bytes.len() {
            let b = bytes[self.pos];
            if !self.in_array {
                self.in_array = b == b'[';
            } else if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'"' {
                    self.in_string = false;
                }
            } else {
                match b {
                    b'"' if self.depth > 0 => self.in_string = true,
                    b'{' => {
                        if self.depth == 0 {
                            self.start = Some(self.pos);
                        }
                        self.depth += 1;
                    }
                    b'}' if self.depth > 0 => {
                        self.depth -= 1;
                        if self.depth == 0 {
                            if let Some(v) = self.start.take().and_then(|s| serde_json::from_str::<Value>(&text[s..=self.pos]).ok()) {
                                done.push(v);
                            }
                        }
                    }
                    b']' if self.depth == 0 => self.in_array = false,
                    _ => {}
                }
            }
            self.pos += 1;
        }
        done
    }
}

/// Parse up to [`MAX_SUGGESTIONS`] suggestions that target known outline refs.
fn parse_suggestions(text: &str, refs: &HashSet<String>) -> Vec<Suggestion> {
    let Some(val) = extract_json(text) else { return vec![] };
    let mut out: Vec<Suggestion> = Vec::new();
    for entry in entries(val, &["suggestions", "improvements"]) {
        let Some(reference) = entry.get("ref").and_then(|v| v.as_str()).map(str::trim) else { continue };
        if !refs.contains(reference) {
            continue;
        }
        let (Some(title), Some(instruction)) = (clipped(entry.get("title"), 80), clipped(entry.get("instruction"), 400))
        else {
            continue;
        };
        let patch = to_patch(&entry, false);
        out.push(Suggestion {
            id: format!("s{}", out.len() + 1),
            reference: reference.to_string(),
            title,
            why: clipped(entry.get("why"), 220).unwrap_or_default(),
            instruction,
            styles: patch.styles,
            rules: patch.rules,
        });
        if out.len() >= MAX_SUGGESTIONS {
            break;
        }
    }
    out
}

/* ----------------------------- prompts ----------------------------- */

/// Chart-type-specific display fields the model may set, appended to the shared
/// capability menu. Empty for types whose editable surface is fully covered by
/// the shared (BaseSpec) fields.
fn chart_type_hint(chart_type: Option<&str>) -> &'static str {
    match chart_type.unwrap_or("").trim() {
        "line" => "This line chart also supports: `curve` (\"linear\"|\"monotone\"|\"step\"|\"stepBefore\"|\"stepAfter\"|\"catmullRom\"), `points` (bool — show markers), `area` (bool — fill under the line).",
        "area" => "This area chart also supports: `curve` (\"linear\"|\"monotone\"|\"step\"|\"stepBefore\"|\"stepAfter\"|\"catmullRom\"), `stack` (bool).",
        "bar" => "This bar chart also supports: `orientation` (\"vertical\"|\"horizontal\"), `stack` (bool), `group` (bool — side-by-side series), `cornerRadius` (px).",
        "scatter" => "This scatter chart also supports: `trendline` (see below).",
        "histogram" => "This histogram also supports: `bin` ({ \"maxbins\": N } or { \"step\": N }), `density` (bool), `color` (bar color), `cornerRadius` (px).",
        "pie" => "This pie/donut chart also supports: `donut` (true, or a 0..1 inner-radius ratio), `labels` (true|false, or { \"placement\": \"inside\"|\"outside\"|\"auto\" }).",
        "combo" => "This combo (dual-axis) chart is composed of `layers`: [{ \"mark\": \"line\"|\"bar\"|\"area\"|\"scatter\", \"encoding\": { \"y\": … }, \"axis\": \"left\"|\"right\", \"curve\", \"points\", \"color\", \"name\" }].",
        _ => "",
    }
}

const CHART_MENU: &str = r##"Each option changes the chart through a PARTIAL Graphein spec patch (only the keys it changes), deep-merged over the current spec. Use these EXACT field names:
- TITLE: `title` — a string, or { "text": "…", "subtitle": "…", "align": "left"|"center"|"right" }.
- THEME: `theme` — "light" or "dark".
- COLORS: `palette` — "graphein"|"colorblind"|"bright"|"muted", OR an array of hex colors (one per series). `background` — the plot background color.
- AXES: `axes` = { "x": {…}, "y": {…} }. Each axis takes `show` (bool), `title` (string), `grid` (bool), `ticks` (approx count), `labels` (bool), `labelAngle` (x only: 0|45|90), and `format`.
    `format` is a number-format string: [$][,][.precision][type] — f=fixed, %=percent, s=SI, d=integer. Examples: "$,.0f"→$1,234 · ".1%"→12.3% · ".2s"→3.4M.
- LEGEND: `legend` — { "show": true, "position": "top"|"right"|"bottom"|"left" }, or a boolean.
- TOOLTIP: `tooltip` — { "show": true }, or a boolean.
- ANNOTATIONS: `annotations` — reference overlays: { "type": "line"|"band"|"point", "axis": "x"|"y", "value": …, "from"/"to": …, "label": "…", "color": "#hex" }.
- INSIGHTS: `insights` — true (mark max + min), or { "max": true, "min": true, "outliers": true }.
- SKETCH: `sketch` — true for a hand-drawn look.
Nested OBJECTS are deep-merged; ARRAYS are REPLACED (to add an annotation, include the existing ones). NEVER include a `data` key."##;

fn component_note(ctx: &RestyleContext) -> String {
    ctx.component
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(" (React component <{s}>)"))
        .unwrap_or_default()
}

/// `name value · name value`, for token names the page reported (plain
/// `[a-z0-9-]` names only; values on one line and clipped).
fn token_list(pairs: &[(String, String)], max: usize) -> String {
    pairs
        .iter()
        .filter(|(name, _)| {
            !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
        .take(max)
        .map(|(name, value)| {
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ").replace('`', "");
            let value: String = value.chars().take(48).collect();
            if value.is_empty() { name.clone() } else { format!("{name} {value}") }
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// The app's design system as prompt lines, or "" when the page reported none.
fn system_brief(system: Option<&DesignSystem>) -> String {
    let Some(s) = system else { return String::new() };
    let mut lines: Vec<String> = Vec::new();
    let colors = token_list(&s.colors, 20);
    if !colors.is_empty() {
        lines.push(format!("- Colors (bg-/text-/border-<name>, or var(--color-<name>) in CSS): {colors}"));
    }
    let palettes: Vec<&str> = s
        .palettes
        .iter()
        .map(String::as_str)
        .filter(|p| !p.is_empty() && p.len() <= 24 && p.chars().all(|c| c.is_ascii_lowercase()))
        .take(4)
        .collect();
    if !palettes.is_empty() {
        lines.push(format!("- Tailwind palettes in use, accent first: {}", palettes.join(", ")));
    }
    let text = token_list(&s.text, 16);
    if !text.is_empty() {
        lines.push(format!("- Font sizes (text-<name>, or var(--text-<name>)): {text}"));
    }
    let spacing = token_list(&s.spacing, 16);
    if !spacing.is_empty() {
        lines.push(format!("- Spacing (p-/m-/gap-<name>, or var(--spacing-<name>)): {spacing}"));
    } else if let Some(base) = s.spacing_base.as_deref().filter(|b| b.len() <= 16 && !b.contains(['\n', '`'])) {
        lines.push(format!("- Spacing: Tailwind's numeric scale (p-4 is 4 × {base})"));
    }
    let radius = token_list(&s.radius, 12);
    if !radius.is_empty() {
        lines.push(format!("- Corner radii (rounded-<name>, or var(--radius-<name>)): {radius}"));
    }
    let fonts = token_list(&s.fonts, 6);
    if !fonts.is_empty() {
        lines.push(format!("- Fonts (font-<name>): {fonts}"));
    }
    if s.dark {
        lines.push("- It has a dark mode (`.dark`): tokens switch with it, raw colors don't.".to_string());
    }
    if lines.is_empty() {
        return String::new();
    }
    format!("The app's design system (its Tailwind v4 theme tokens):\n{}\n\n", lines.join("\n"))
}

/// How options and suggestions stay on brand.
fn brand_rules(system: Option<&DesignSystem>) -> &'static str {
    if system.is_some_and(DesignSystem::has_tokens) {
        "Stay on brand: build every option from the design system above. In `styles`, use its CSS variables \
(var(--color-…), var(--spacing-…), var(--radius-…)) rather than raw colors or sizes; in `classes`, use the matching utilities.\n\
Keep the app's look: no gradients, glows or decorative shadows unless the user asks for them or the element already has them. \
Keep text readable (WCAG AA contrast)."
    } else {
        "Stay consistent with the app: reuse the palettes and sizes it already uses. No gradients, glows or decorative shadows \
unless the user asks for them or the element already has them. Keep text readable (WCAG AA contrast)."
    }
}

/// Describe the element (tag, classes, text, computed styles, notable children).
fn element_brief(ctx: &RestyleContext) -> String {
    let mut el = format!("<{}", if ctx.tag.is_empty() { "div" } else { ctx.tag.as_str() });
    if let Some(c) = ctx.classes.as_deref().filter(|s| !s.trim().is_empty()) {
        el.push_str(&format!(" class=\"{}\"", c.trim()));
    }
    el.push('>');
    let mut out = format!("Element: {el}");
    if let Some(t) = ctx.text.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("\nIts visible text: \"{}\".", t.trim()));
    }
    let mut keys: Vec<&String> = ctx.styles.keys().collect();
    keys.sort();
    if !keys.is_empty() {
        out.push_str("\nCurrent computed styles:");
        for k in keys {
            out.push_str(&format!("\n  {}: {};", k, ctx.styles[k]));
        }
    }
    if let Some(Value::Array(arr)) = &ctx.children {
        let mut kids = String::new();
        for c in arr.iter().take(40) {
            let Value::Object(o) = c else { continue };
            let tag = o.get("tag").and_then(|v| v.as_str()).unwrap_or("");
            if tag.is_empty() {
                continue;
            }
            let cls = o
                .get("classes")
                .and_then(|v| v.as_str())
                .and_then(|s| s.split_whitespace().next())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            let txt = o
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| format!(" \"{s}\""))
                .unwrap_or_default();
            kids.push_str(&format!("\n  <{tag}{cls}>{txt}"));
        }
        if !kids.is_empty() {
            out.push_str("\nElements inside it (targetable via `rules`):");
            out.push_str(&kids);
        }
    }
    out
}

/// Ask for `count` distinct, named alternatives for one element. `image` says a
/// screenshot of the element rides along.
fn build_variations_prompt(hint: Option<&str>, ctx: &RestyleContext, count: usize, image: bool) -> String {
    let hint = hint.map(str::trim).filter(|h| !h.is_empty());
    let goal = match hint {
        Some(h) => format!("The user wants: \"{h}\". Propose {count} DISTINCT ways to do that."),
        None => format!("Propose {count} DISTINCT, tasteful alternative looks that would improve it."),
    };
    let comp = component_note(ctx);
    let system = system_brief(ctx.system.as_ref());
    let seen = if image { "The attached image shows it as it looks now.\n" } else { "" };
    if ctx.is_chart {
        let spec = ctx.spec.as_ref().and_then(|s| serde_json::to_string_pretty(s).ok()).unwrap_or_else(|| "{}".into());
        let kind = ctx.chart_type.as_deref().filter(|s| !s.is_empty()).map(|s| format!("{s} ")).unwrap_or_default();
        let colors = if ctx.system.as_ref().is_some_and(|s| !s.colors.is_empty()) {
            " Prefer the app's colors above, as hex values, for palettes and highlights."
        } else {
            ""
        };
        let mut p = format!(
            "You are a data-visualization designer improving a Graphein {kind}chart{comp} in a live app. {seen}Current spec (data omitted):\n```json\n{spec}\n```\n\n{system}{goal}{colors}\n\n{CHART_MENU}"
        );
        let type_hint = chart_type_hint(ctx.chart_type.as_deref());
        if !type_hint.is_empty() {
            p.push('\n');
            p.push_str(type_hint);
        }
        p.push_str(&format!(
            "\n\nReturn ONLY a single fenced ```json block holding a minified array of {count} objects: \
[{{\"name\":\"2-3 word label\",\"description\":\"one short sentence\",\"graphein\":{{/* partial spec patch */}}}}]. Return nothing else."
        ));
        return p;
    }
    let allowed = ALLOWED_RESTYLE_PROPS.join(", ");
    format!(
        "You are a senior product designer restyling one element{comp} in a live web app.\n{brief}\n{seen}\n{system}{goal} \
Make the {count} options genuinely different directions (for example emphasis, density or tone), each a small, coherent change.\n\
{rules}\n\n\
Return ONLY a single fenced ```json block holding a minified array of {count} objects with this exact shape:\n\
[{{\"name\":\"2-3 word label\",\"description\":\"one short sentence\",\"styles\":{{/* CSS for THIS element */}},\
\"rules\":[{{\"selector\":\"h2\",\"styles\":{{}}}}],\"classes\":\"the Tailwind v4 utilities that produce this look\"}}]\n\
- `styles` restyle the element itself; `rules` restyle its DESCENDANTS (simple selectors relative to the element, \
e.g. \"h2\", \".badge\", \"p span\"), at most 4 per option. Inner elements with their own colors need `rules`.\n\
- Allowed properties ONLY: {allowed}.\n\
- Values are concrete CSS or the app's var(--…) tokens. NO url(), external resources, @import, or JavaScript.\n\
- `classes` uses Tailwind v4 names (bg-linear-to-r, not bg-gradient-to-r).\n\
Return nothing else.",
        brief = element_brief(ctx),
        rules = brand_rules(ctx.system.as_ref()),
    )
}

/// Ask for concrete, high-impact improvements to the page in the outline.
fn build_polish_prompt(page: &PageOutline) -> String {
    let mut outline = String::new();
    for el in page.elements.iter().take(MAX_OUTLINE_ELEMENTS) {
        let mut line = format!("- [{}] {} <{}>", el.reference, el.label, el.tag);
        if let Some(t) = el.text.as_deref().filter(|t| !t.is_empty()) {
            line.push_str(&format!(" \"{t}\""));
        }
        if let Some(c) = el.classes.as_deref().filter(|c| !c.is_empty()) {
            line.push_str(&format!(" class=\"{}\"", c.chars().take(160).collect::<String>()));
        }
        let mut keys: Vec<&String> = el.styles.keys().collect();
        keys.sort();
        let styles: Vec<String> = keys.iter().map(|k| format!("{k}: {}", el.styles[*k])).collect();
        if !styles.is_empty() {
            line.push_str(&format!(" {{{}}}", styles.join("; ")));
        }
        outline.push_str(&line);
        outline.push('\n');
    }
    let mut findings = String::new();
    for f in page.findings.iter().take(MAX_FINDINGS) {
        let at = f.reference.as_deref().map(|r| format!(" [{r}]")).unwrap_or_default();
        findings.push_str(&format!("- {}{at}: {}\n", f.kind, f.message));
    }
    if findings.is_empty() {
        findings.push_str("- none\n");
    }
    let title = if page.title.trim().is_empty() { "(untitled)" } else { page.title.trim() };
    let allowed = ALLOWED_RESTYLE_PROPS.join(", ");
    let system = system_brief(page.system.as_ref());
    let brand = if page.system.as_ref().is_some_and(DesignSystem::has_tokens) {
        "Stay inside the design system above: CSS previews use its var(--…) tokens and instructions name its utilities. "
    } else {
        ""
    };
    format!(
        "You are a senior product designer doing a quick polish review of one page of a live web app \
(title \"{title}\", route {route}, viewport {viewport}). The attached screenshot (when present) shows it as rendered.\n\n\
Notable elements, each with a ref in brackets:\n{outline}\n\
Automated checks found:\n{findings}\n\
{system}\
Suggest up to {MAX_SUGGESTIONS} concrete, high-impact visual improvements — hierarchy, spacing rhythm, alignment, contrast, \
consistency, emphasis of the primary action. Prefer fixing the automated findings. Each suggestion targets ONE element by its ref, \
and includes a small CSS preview of the change for that element (and optional descendant `rules`). \
{brand}No gradients, glows or decorative shadows unless the page already uses them.\n\n\
Return ONLY a single fenced ```json block holding a minified array:\n\
[{{\"ref\":\"r3\",\"title\":\"short imperative title\",\"why\":\"one sentence on the benefit\",\
\"instruction\":\"what to change in the source, specifically\",\"styles\":{{}},\"rules\":[{{\"selector\":\"h2\",\"styles\":{{}}}}]}}]\n\
- Allowed CSS properties ONLY: {allowed}. Concrete values or the app's var(--…) tokens; NO url(), @import, or JavaScript.\n\
- Only refs from the list above. Skip anything you can't preview with CSS unless the instruction is still clearly valuable.\n\
Return nothing else.",
        route = if page.route.is_empty() { "/" } else { page.route.as_str() },
        viewport = page.viewport,
    )
}

/* ----------------------------- commands ----------------------------- */

fn project_path(project_id: &str) -> Result<String, String> {
    store::find_project(project_id).map(|p| p.path).ok_or_else(|| "Project not found.".to_string())
}

/// One option the moment the model finishes writing it (see
/// `DesignVariationEvent` in `src/shared/design.ts`).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VariationEvent {
    request_id: String,
    index: usize,
    variation: Variation,
}

/// Propose `count` (default 3) named alternative looks for one element, as
/// previewable patches, on a transient, tool-less session. With a `request_id`,
/// each option is also emitted as a `design:variation` event as soon as it's
/// complete. `screenshot_path` (one of Fabricator's own temp captures of the
/// element) rides along for vision models; a run that yields nothing with it is
/// retried once without it, and the capture is deleted afterwards. Returns a
/// soft error string the UI shows in place.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn design_variations(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    context: RestyleContext,
    hint: Option<String>,
    count: Option<usize>,
    model: Option<String>,
    effort: Option<String>,
    request_id: Option<String>,
    screenshot_path: Option<String>,
) -> Result<Vec<Variation>, String> {
    let shot = screenshot_path.as_deref().and_then(screenshot::owned_capture_path);
    let result: Result<Vec<Variation>, String> = async {
        let cwd = project_path(&project_id)?;
        let count = count.unwrap_or(DEFAULT_VARIATIONS).clamp(1, MAX_VARIATIONS);
        let attachments: Vec<PathBuf> = shot.iter().cloned().collect();
        let started = std::time::Instant::now();
        let mut failure: Option<String> = None;
        for with_image in [true, false] {
            if with_image && attachments.is_empty() {
                continue;
            }
            if !with_image && !attachments.is_empty() && started.elapsed() > IMAGE_RETRY_WITHIN {
                break;
            }
            let prompt = build_variations_prompt(hint.as_deref(), &context, count, with_image);
            let mut stream = EntryStream::default();
            let mut seen: HashSet<String> = HashSet::new();
            let mut streamed: Vec<Variation> = Vec::new();
            let mut entries_seen = 0usize;
            let mut emit_options = |text: &str| {
                for entry in stream.feed(text) {
                    let index = entries_seen;
                    entries_seen += 1;
                    if streamed.len() >= count {
                        continue;
                    }
                    if let Some(variation) = variation_from(&entry, index, context.is_chart, &mut seen) {
                        if let Some(id) = request_id.as_deref() {
                            let event = VariationEvent { request_id: id.to_string(), index: streamed.len(), variation: variation.clone() };
                            let _ = app.emit(DESIGN_VARIATION, event);
                        }
                        streamed.push(variation);
                    }
                }
            };
            let files: &[PathBuf] = if with_image { &attachments } else { &[] };
            let parsed = match run_transient(&state, &cwd, model.clone(), effort.clone(), prompt, files, Some(&mut emit_options)).await {
                Ok(reply) => parse_variations(&reply, context.is_chart, count),
                Err(error) => {
                    failure = Some(error);
                    Vec::new()
                }
            };
            let options = settled(parsed, streamed);
            if !options.is_empty() {
                return Ok(options);
            }
        }
        Err(failure.unwrap_or_else(|| "Couldn't come up with options — try describing what you want.".into()))
    }
    .await;
    if let Some(path) = screenshot_path {
        screenshot::cleanup(&[path]);
    }
    result
}

/// Review a page outline (and an optional screenshot, one of Fabricator's own
/// temp captures) and suggest up to six previewable improvements. Retries
/// without the screenshot when the model can't use it. The capture is deleted
/// afterwards.
#[tauri::command]
pub async fn design_polish(
    state: State<'_, AppState>,
    project_id: String,
    page: PageOutline,
    screenshot_path: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<Vec<Suggestion>, String> {
    let shot = screenshot_path.as_deref().and_then(screenshot::owned_capture_path);
    let result: Result<Vec<Suggestion>, String> = async {
        let cwd = project_path(&project_id)?;
        if page.elements.is_empty() {
            return Err("There's nothing on this page to review yet.".to_string());
        }
        let refs: HashSet<String> = page.elements.iter().map(|e| e.reference.clone()).collect();
        let prompt = build_polish_prompt(&page);
        let attachments: Vec<PathBuf> = shot.iter().cloned().collect();
        let first = run_transient(&state, &cwd, model.clone(), effort.clone(), prompt.clone(), &attachments, None).await;
        let mut suggestions = first.as_deref().map(|reply| parse_suggestions(reply, &refs)).unwrap_or_default();
        if suggestions.is_empty() && !attachments.is_empty() {
            let reply = run_transient(&state, &cwd, model, effort, prompt, &[], None).await?;
            suggestions = parse_suggestions(&reply, &refs);
        } else if let Err(error) = first {
            return Err(error);
        }
        if suggestions.is_empty() {
            return Err("No clear improvements found for this page.".to_string());
        }
        Ok(suggestions)
    }
    .await;
    if let Some(path) = screenshot_path {
        screenshot::cleanup(&[path]);
    }
    result
}

/// Find the likely source lines behind picked elements (heuristic hints) and the
/// project's Tailwind entry stylesheet.
#[tauri::command]
pub async fn design_locate(project_id: String, targets: Vec<LocateTarget>) -> Result<LocateResult, String> {
    let root = PathBuf::from(project_path(&project_id)?);
    let targets: Vec<LocateTarget> = targets.into_iter().take(40).collect();
    tokio::task::spawn_blocking(move || design_locate::locate(&root, &targets))
        .await
        .map_err(|e| format!("Source lookup failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_prefers_last_fenced_block() {
        let text = "first:\n```json\n{\"color\":\"red\"}\n```\nbut actually:\n```json\n{\"color\":\"blue\"}\n```";
        let v = extract_json(text).expect("json");
        assert_eq!(v["color"], "blue");
    }

    #[test]
    fn extract_json_falls_back_to_array_then_brace_span() {
        let arr = extract_json("here: [{\"name\":\"A\"}] done").expect("array");
        assert!(arr.is_array());
        let obj = extract_json("no fences but {\"border-radius\":\"8px\"} here").expect("object");
        assert_eq!(obj["border-radius"], "8px");
        assert!(extract_json("just prose, no json").is_none());
    }

    #[test]
    fn collect_styles_keeps_only_whitelisted_safe_values() {
        let map = serde_json::json!({
            "color": "#fff",
            "background-color": "#0f766e",
            "position": "absolute",
            "onclick": "evil()",
            "background-image": "url(https://evil.example/x.png)",
            "background": "expression(alert(1))",
            "border": "1px solid red; position: fixed",
            "border-radius": "9999px",
            "border-top": "1px solid var(--color-border)",
            "grid-template-columns": "repeat(3, minmax(0, 1fr))"
        });
        let mut out = HashMap::new();
        collect_styles(map.as_object().unwrap(), &mut out);
        assert_eq!(out.get("color").map(String::as_str), Some("#fff"));
        assert_eq!(out.get("background-color").map(String::as_str), Some("#0f766e"));
        assert_eq!(out.get("border-radius").map(String::as_str), Some("9999px"));
        assert_eq!(out.get("border-top").map(String::as_str), Some("1px solid var(--color-border)"));
        assert_eq!(out.get("grid-template-columns").map(String::as_str), Some("repeat(3, minmax(0, 1fr))"));
        for dropped in ["position", "onclick", "background-image", "background", "border"] {
            assert!(!out.contains_key(dropped), "{dropped}");
        }
    }

    #[test]
    fn in_page_controller_rechecks_the_same_property_list() {
        let js = include_str!("../services/design_agent.js");
        let start = js.find("var SAFE_PROPS = [").expect("SAFE_PROPS in design_agent.js");
        let list = &js[start..start + js[start..].find("];").expect("end of SAFE_PROPS")];
        for prop in ALLOWED_RESTYLE_PROPS {
            assert!(list.contains(&format!("'{prop}'")), "design_agent.js SAFE_PROPS is missing {prop}");
        }
        assert_eq!(list.matches('\'').count() / 2, ALLOWED_RESTYLE_PROPS.len(), "SAFE_PROPS has extra properties");
    }

    #[test]
    fn to_patch_reads_styles_rules_and_flat_objects() {
        let v = serde_json::json!({
            "name": "Pill",
            "styles": { "border-radius": "16px" },
            "rules": [
                { "selector": "h1", "styles": { "font-size": "32px", "position": "absolute" } },
                { "selector": "h1 { } body", "styles": { "color": "#fff" } },
                { "selector": "p", "styles": {} }
            ]
        });
        let patch = to_patch(&v, false);
        assert_eq!(patch.styles.get("border-radius").map(String::as_str), Some("16px"));
        assert_eq!(patch.rules.len(), 1);
        assert!(!patch.rules[0].styles.contains_key("position"));
        let flat = to_patch(&serde_json::json!({ "name": "x", "color": "#111" }), false);
        assert_eq!(flat.styles.get("color").map(String::as_str), Some("#111"));
    }

    #[test]
    fn chart_patches_drop_data_and_descriptive_keys() {
        let bare = to_patch(&serde_json::json!({ "name": "Bars", "description": "x", "type": "bar", "data": [1] }), true);
        let g = bare.graphein.expect("graphein");
        assert_eq!(g["type"], "bar");
        assert!(g.get("data").is_none() && g.get("name").is_none() && g.get("description").is_none());
        let wrapped = to_patch(&serde_json::json!({ "graphein": { "palette": "bright", "data": [1] } }), true);
        assert_eq!(wrapped.graphein.expect("graphein"), serde_json::json!({ "palette": "bright" }));
    }

    #[test]
    fn parse_variations_names_dedupes_and_caps() {
        let reply = r##"```json
[
  { "name": "Pill", "description": "Fully rounded", "styles": { "border-radius": "9999px" }, "classes": "rounded-full px-5 <script>" },
  { "name": "pill", "styles": { "border-radius": "20px" } },
  { "name": "Nothing", "styles": { "position": "fixed" } },
  { "styles": { "box-shadow": "0 8px 24px rgba(0,0,0,.2)" } },
  { "name": "Outline", "styles": { "background-color": "transparent", "border": "1px solid #4f46e5" } }
]
```"##;
        let got = parse_variations(reply, false, 2);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "Pill");
        assert_eq!(got[0].classes.as_deref(), Some("rounded-full px-5"));
        assert_eq!(got[1].name, "Option 4"); // unnamed entry gets a positional name
        let wrapped = parse_variations(r##"{"variations":[{"name":"A","styles":{"color":"#222"}}]}"##, false, 3);
        assert_eq!(wrapped.len(), 1);
    }

    #[test]
    fn parse_suggestions_requires_known_refs_and_instructions() {
        let refs: HashSet<String> = ["r1".to_string(), "r2".to_string()].into_iter().collect();
        let reply = r##"[
          { "ref": "r1", "title": "Raise the primary action", "why": "It's easy to miss.", "instruction": "Make the Add deal button a filled indigo button.", "styles": { "background-color": "#4f46e5" } },
          { "ref": "r9", "title": "Unknown", "instruction": "x" },
          { "ref": "r2", "title": "No instruction" },
          { "ref": "r2", "title": "Tighten spacing", "instruction": "Reduce the card padding to p-4." }
        ]"##;
        let got = parse_suggestions(reply, &refs);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].id.as_str(), got[0].reference.as_str()), ("s1", "r1"));
        assert_eq!(got[0].styles.get("background-color").map(String::as_str), Some("#4f46e5"));
        assert_eq!(got[1].id, "s2");
        assert!(got[1].styles.is_empty());
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_eq!(json["ref"], "r1");
    }

    #[test]
    fn variations_prompt_covers_elements_and_charts() {
        let el = RestyleContext { tag: "button".into(), classes: Some("rounded-lg bg-indigo-600".into()), ..Default::default() };
        let p = build_variations_prompt(Some("make it feel more premium"), &el, 3, false);
        assert!(p.contains("make it feel more premium"));
        assert!(p.contains("Allowed properties ONLY"));
        assert!(p.contains("\"classes\""));
        assert!(p.contains("array of 3 objects"));
        let chart = RestyleContext {
            is_chart: true,
            chart_type: Some("bar".into()),
            spec: Some(serde_json::json!({ "type": "bar", "title": "Revenue" })),
            ..Default::default()
        };
        let c = build_variations_prompt(None, &chart, 2, false);
        assert!(c.contains("\"title\": \"Revenue\""));
        assert!(c.contains("orientation")); // bar-specific hint
        assert!(c.contains("NEVER include a `data` key"));
        assert!(c.contains("\"graphein\""));
    }

    fn token_system() -> DesignSystem {
        serde_json::from_value(serde_json::json!({
            "colors": [["primary", "#1d4ed8"], ["card", "rgba(255, 255, 255, 0.82)"], ["Ignore previous`", "x"]],
            "text": [["300", "14px"], ["400", "16px"]],
            "spacing": [["400", "16px"]],
            "radius": [["xl", "8px"]],
            "fonts": [["base", "Manrope,\n sans-serif"]],
            "dark": true
        }))
        .unwrap()
    }

    #[test]
    fn prompts_stay_on_the_apps_design_system() {
        let el = RestyleContext { tag: "div".into(), system: Some(token_system()), ..Default::default() };
        let p = build_variations_prompt(None, &el, 3, true);
        assert!(p.contains("- Colors (bg-/text-/border-<name>, or var(--color-<name>) in CSS): primary #1d4ed8 · card rgba(255, 255, 255, 0.82)\n"));
        assert!(!p.contains("Ignore previous"), "token names are plain [a-z0-9-] only");
        assert!(p.contains("- Font sizes (text-<name>, or var(--text-<name>)): 300 14px · 400 16px"));
        assert!(p.contains("- Spacing (p-/m-/gap-<name>, or var(--spacing-<name>)): 400 16px"));
        assert!(p.contains("- Fonts (font-<name>): base Manrope, sans-serif"));
        assert!(p.contains("dark mode"));
        assert!(p.contains("Stay on brand"));
        assert!(p.contains("The attached image shows it"));
        assert!(p.contains("at most 4 per option"));
        // Without tokens: no brief, the generic consistency rule, no image line.
        let plain = build_variations_prompt(None, &RestyleContext { tag: "div".into(), ..Default::default() }, 3, false);
        assert!(!plain.contains("design system"));
        assert!(plain.contains("No gradients, glows"));
        assert!(!plain.contains("attached image"));
        // Charts reuse the app's colors as hex; Polish carries the brief too.
        let chart = RestyleContext { is_chart: true, system: Some(token_system()), ..Default::default() };
        assert!(build_variations_prompt(None, &chart, 3, false).contains("Prefer the app's colors above, as hex values"));
        let page = PageOutline { route: "/".into(), system: Some(token_system()), ..Default::default() };
        let polish = build_polish_prompt(&page);
        assert!(polish.contains("The app's design system"));
        assert!(polish.contains("Stay inside the design system above"));
        assert!(!build_polish_prompt(&PageOutline::default()).contains("design system"));
    }

    #[test]
    fn polish_prompt_lists_refs_and_findings() {
        let page = PageOutline {
            route: "/deals".into(),
            title: "Deals".into(),
            viewport: serde_json::json!({ "w": 1280, "h": 800 }),
            elements: vec![OutlineElement {
                reference: "r1".into(),
                label: "Button · Add deal".into(),
                tag: "button".into(),
                text: Some("Add deal".into()),
                styles: HashMap::from([("color".into(), "rgb(255, 255, 255)".into())]),
                ..Default::default()
            }],
            findings: vec![Finding { reference: Some("r1".into()), kind: "contrast".into(), message: "2.1:1 text contrast".into() }],
            system: None,
        };
        let p = build_polish_prompt(&page);
        assert!(p.contains("[r1] Button · Add deal <button> \"Add deal\""));
        assert!(p.contains("contrast [r1]: 2.1:1 text contrast"));
        assert!(p.contains("route /deals"));
    }

    #[test]
    fn entry_stream_yields_each_option_as_soon_as_it_closes() {
        let reply = "Here you go:\n```json\n[{\"name\":\"Pill\",\"styles\":{\"border-radius\":\"9999px\"},\"rules\":[{\"selector\":\"h2\",\"styles\":{\"color\":\"#111\"}}]},\
{\"name\":\"Brace } \\\" in text\",\"description\":\"a [tricky] {one}\",\"styles\":{\"color\":\"#222\"}},{\"name\":\"Third\",\"styles\":{\"gap\":\"8px\"}}]\n```";
        let mut stream = EntryStream::default();
        let mut so_far = String::new();
        let mut got: Vec<Value> = Vec::new();
        let mut first_at = None;
        // Deltas arrive a few characters at a time.
        for ch in reply.chars() {
            so_far.push(ch);
            got.extend(stream.feed(&so_far));
            if first_at.is_none() && !got.is_empty() {
                first_at = Some(so_far.len());
            }
        }
        assert_eq!(got.len(), 3);
        assert!(first_at.unwrap() < reply.find("Third").unwrap(), "the first option is out before the last is written");
        assert_eq!(got[1]["name"], "Brace } \" in text");
        // Streamed entries become exactly the options the final parse returns.
        let mut seen = HashSet::new();
        let streamed: Vec<Variation> = got.iter().enumerate().filter_map(|(i, e)| variation_from(e, i, false, &mut seen)).collect();
        assert_eq!(streamed, parse_variations(reply, false, 3));
    }

    #[test]
    fn entry_stream_waits_for_whole_objects_inside_a_wrapper() {
        let mut stream = EntryStream::default();
        assert!(stream.feed("{\"variations\":[{\"name\":\"A\",\"styles\":{\"col").is_empty());
        let done = stream.feed("{\"variations\":[{\"name\":\"A\",\"styles\":{\"color\":\"#fff\"}},{\"name\":");
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["name"], "A");
    }

    #[test]
    fn a_reply_cut_off_mid_answer_keeps_the_options_that_streamed() {
        // A timeout or an error mid-reply leaves an unfinished array.
        let reply = "```json\n[{\"name\":\"Soft\",\"styles\":{\"border-radius\":\"12px\"}},{\"name\":\"Bo";
        let mut seen = HashSet::new();
        let streamed: Vec<Variation> =
            EntryStream::default().feed(reply).iter().enumerate().filter_map(|(i, e)| variation_from(e, i, false, &mut seen)).collect();
        let parsed = parse_variations(reply, false, 3);
        assert!(parsed.is_empty());
        let options = settled(parsed, streamed);
        assert_eq!(options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Soft"]);
        // A complete reply wins over what streamed.
        let full = parse_variations("[{\"name\":\"Full\",\"styles\":{\"color\":\"#111\"}}]", false, 3);
        assert_eq!(settled(full, options)[0].name, "Full");
    }

    #[test]
    fn design_sessions_carry_no_built_in_tools() {
        let opts = design_session_options("C:/project");
        assert_eq!(opts.available_tools, Some(Vec::new()));
        assert!(opts.permission.is_some(), "the read-only policy stays as a backstop");
    }

    #[test]
    fn chart_type_hint_covers_common_types() {
        assert!(chart_type_hint(Some("bar")).contains("orientation"));
        assert!(chart_type_hint(Some("pie")).contains("donut"));
        assert!(chart_type_hint(Some("line")).contains("curve"));
        assert!(chart_type_hint(Some("combo")).contains("layers"));
        assert_eq!(chart_type_hint(Some("gauge")), "");
        assert_eq!(chart_type_hint(None), "");
    }
}
