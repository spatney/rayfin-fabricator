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

/// CSS properties the "Edit with AI" restyle path is allowed to set on a live
/// element. Deliberately a safe, layout/typography/appearance-only subset — the
/// model can only return values for these (anything else is dropped), and the
/// in-page controller applies them as ordinary inline-style change-set entries.
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
    "align-items",
    "justify-content",
    "flex-direction",
];

/// Compact element context the renderer sends with a restyle request: enough for
/// the model to make a good local edit without shipping the whole DOM.
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
}

/// The structured patch returned to the renderer: whitelisted CSS property→value
/// pairs applied inline, plus an optional Graphein spec patch (for charts) merged
/// over the current spec. The controller applies each as a revertable change-set
/// entry (see `applyRestyle` in `design_agent.js`).
#[derive(serde::Serialize, Default, PartialEq, Debug)]
pub struct RestylePatch {
    pub styles: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graphein: Option<Value>,
    /// Descendant rules: each applies whitelisted CSS to elements matching
    /// `selector` inside the selected element (so an edit can reach children).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RestyleRule>,
}

/// A restyle rule targeting descendants of the selected element.
#[derive(serde::Serialize, Default, PartialEq, Debug)]
pub struct RestyleRule {
    pub selector: String,
    pub styles: HashMap<String, String>,
}

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

/// Pull the last fenced code block (or widest `{…}` span) and parse it as JSON.
/// Mirrors [`extract_html`] but for the restyle path's JSON object output.
fn extract_json(text: &str) -> Option<Value> {
    // Prefer the body of the last non-empty fenced block (strip a short language
    // tag like ```json).
    let parts: Vec<&str> = text.split("```").collect();
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 1;
    while i < parts.len() {
        let mut block = parts[i];
        if let Some(nl) = block.find('\n') {
            let first = block[..nl].trim();
            if !first.contains('{') && first.len() <= 12 {
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
    // No usable fenced block — fall back to the widest `{ … }` span.
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
        if end > start {
            if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                return Some(v);
            }
        }
    }
    None
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
        if val.is_empty() {
            continue;
        }
        let low = val.to_lowercase();
        if low.contains("url(")
            || low.contains("expression(")
            || low.contains("javascript:")
            || low.contains("@import")
        {
            continue;
        }
        out.insert(key, val);
    }
}

/// Turn the model's JSON into a [`RestylePatch`]. Accepts either a flat object of
/// CSS props, a `{ "styles": {…} }` wrapper, and/or a `{ "graphein"/"spec": {…} }`
/// chart patch. `allow_chart` gates the Graphein patch.
fn to_patch(val: Value, allow_chart: bool) -> RestylePatch {
    let mut patch = RestylePatch::default();
    let Value::Object(map) = val else {
        return patch;
    };
    if let Some(Value::Object(styles)) = map.get("styles") {
        collect_styles(styles, &mut patch.styles);
    }
    if allow_chart {
        let g = map
            .get("graphein")
            .or_else(|| map.get("spec"))
            .cloned()
            .unwrap_or_else(|| {
                // A bare object with no wrapper keys is treated as the spec patch
                // itself (minus a `styles` sibling / a forbidden `data` key).
                let mut m = map.clone();
                m.remove("styles");
                m.remove("data");
                Value::Object(m)
            });
        if let Value::Object(obj) = &g {
            if !obj.is_empty() {
                patch.graphein = Some(g);
            }
        }
    } else if patch.styles.is_empty() && !map.contains_key("styles") {
        // Flat object of CSS props (no wrapper).
        collect_styles(&map, &mut patch.styles);
    }
    // Descendant rules (non-chart): [{ selector, styles }]. The selector is a
    // plain CSS selector; reject anything that could break out of a selector.
    if !allow_chart {
        if let Some(Value::Array(arr)) = map.get("rules") {
            for r in arr {
                let Value::Object(ro) = r else { continue };
                let sel = ro.get("selector").and_then(|v| v.as_str()).unwrap_or("").trim();
                if sel.is_empty()
                    || sel.len() > 100
                    || sel.contains(['{', '}', '<', '@', '"'])
                {
                    continue;
                }
                let mut styles = HashMap::new();
                if let Some(Value::Object(s)) = ro.get("styles") {
                    collect_styles(s, &mut styles);
                }
                if !styles.is_empty() {
                    patch.rules.push(RestyleRule { selector: sel.to_string(), styles });
                }
            }
        }
    }
    patch
}

/// Chart-type-specific display fields the model may set, appended to the shared
/// capability menu in the chart restyle prompt. Empty for types whose editable
/// surface is fully covered by the shared (BaseSpec) fields.
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

/// Build the restyle instruction. For charts we ask for a partial Graphein spec
/// patch; otherwise a flat JSON object of whitelisted CSS props.
fn build_restyle_prompt(description: &str, ctx: &RestyleContext) -> String {
    let desc = description.trim();
    let comp = ctx
        .component
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(" (React component <{s}>)"))
        .unwrap_or_default();

    if ctx.is_chart {
        let spec = ctx
            .spec
            .as_ref()
            .and_then(|s| serde_json::to_string_pretty(s).ok())
            .unwrap_or_else(|| "{}".to_string());
        let kind = ctx
            .chart_type
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| format!("{s} "))
            .unwrap_or_default();
        let type_hint = chart_type_hint(ctx.chart_type.as_deref());
        let menu = r##"You change the chart by returning a PARTIAL Graphein spec patch (only the keys you change), which is deep-merged over the current spec. Use these EXACT field names:
- TITLE: `title` — a string, or { "text": "…", "subtitle": "…", "align": "left"|"center"|"right" }.
- THEME: `theme` — "light" or "dark".
- COLORS: `palette` — a named scheme "graphein"|"colorblind"|"bright"|"muted", OR an array of hex colors (one per series). `background` — the plot background color.
- AXES: `axes` = { "x": {…}, "y": {…} }. Each axis takes `show` (bool), `title` (string), `grid` (bool), `ticks` (approx count), `tickValues` (array), `labels` (bool), `labelAngle` (x only: 0|45|90), and `format`.
    `format` is a number-format string: [$][,][.precision][type] — type f=fixed (".2f"→3.14), %=percent (".0%"→42%), s=SI (".1s"→1.2k), d=integer (",d"→1,234), e=exponential, g=significant. Examples: "$,.0f"→$1,234 · ".1%"→12.3% · ".2s"→3.4M.
- LEGEND: `legend` — { "show": true, "position": "top"|"right"|"bottom"|"left", "title": "…", "interactive": true }, or a boolean.
- TOOLTIP: `tooltip` — { "show": true }, or a boolean.
- ANNOTATIONS: `annotations` — an array of reference overlays. Each: { "type": "line"|"band"|"zone"|"point", "axis": "x"|"y", "value": <for a line>, "from"/"to": <for a band/zone>, "x"/"y": <for a point>, "label": "…", "color": "#hex", "strokeWidth": 1.5, "strokeDash": [4,4], "fillOpacity": 0.12, "labelPosition": "start"|"middle"|"end" }. Examples — target line: { "type":"line","axis":"y","value":100,"label":"Target" } · danger band: { "type":"band","axis":"y","from":0,"to":50,"color":"#f43f5e","label":"Low" } · point callout: { "type":"point","x":"Q4","y":120,"label":"Peak" }.
- INSIGHTS: `insights` — true (auto-mark the max + min points), or { "max":true, "min":true, "outliers":true }.
- TRENDLINE: `trendline` — true, or { "method":"linear", "groupBy":true, "label":true, "color":"#hex" } (needs a continuous or temporal x-axis).
- SKETCH: `sketch` — true for a hand-drawn look, or { "roughness":1, "font":true }.
- PADDING: `padding` — { "top":8, "right":8, "bottom":8, "left":8 }."##;
        let rules_note = r##"
MERGING: nested OBJECTS are deep-merged, so send only the sub-keys you change (e.g. { "axes": { "y": { "format": "$,.0f" } } } keeps the existing x axis). But ARRAYS are REPLACED, not appended — to ADD to `annotations`, include the EXISTING annotations from the current spec above PLUS your new one(s).

Return ONLY a single fenced ```json code block containing the partial patch — include ONLY the keys you are changing, use ONLY the real field names listed above, and NEVER include a `data` key. Return nothing else."##;
        let mut p = format!(
            "You are editing a Graphein {kind}chart{comp} in a live app. Current spec (data omitted):\n\
```json\n{spec}\n```\n\n\
Apply this change: \"{desc}\"\n\n{menu}"
        );
        if !type_hint.is_empty() {
            p.push('\n');
            p.push_str(type_hint);
        }
        p.push_str(rules_note);
        p
    } else {
        let mut el = format!("<{}", ctx.tag);
        if let Some(c) = ctx.classes.as_deref().filter(|s| !s.trim().is_empty()) {
            el.push_str(&format!(" class=\"{}\"", c.trim()));
        }
        el.push('>');
        let text = ctx
            .text
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("\nIts visible text: \"{}\".", s.trim()))
            .unwrap_or_default();
        let mut styles = String::new();
        let mut keys: Vec<&String> = ctx.styles.keys().collect();
        keys.sort();
        for k in keys {
            styles.push_str(&format!("  {}: {};\n", k, ctx.styles[k]));
        }
        if styles.is_empty() {
            styles.push_str("  (none provided)\n");
        }
        // Compact list of descendants the model may target via `rules`.
        let mut kids = String::new();
        if let Some(Value::Array(arr)) = &ctx.children {
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
                kids.push_str(&format!("  <{tag}{cls}>{txt}\n"));
            }
        }
        let children_section = if kids.is_empty() {
            String::new()
        } else {
            format!("Elements INSIDE it you can also target via `rules`:\n{kids}\n")
        };
        let allowed = ALLOWED_RESTYLE_PROPS.join(", ");
        format!(
            "You are restyling a component{comp} in a live web app.\n\
Element: {el}{text}\n\
Current (relevant) computed styles:\n{styles}\n\
{children_section}\
Apply this visual change: \"{desc}\"\n\n\
Return ONLY a single fenced ```json code block with this exact shape:\n\
{{ \"styles\": {{ /* CSS prop -> value for THIS element */ }}, \"rules\": [ {{ \"selector\": \"h1\", \"styles\": {{ /* CSS prop -> value */ }} }} ] }}\n\
- `styles` restyles the selected element itself; `rules` restyle its DESCENDANTS — \
each `selector` is a simple CSS selector relative to the element (e.g. \"h1\", \".btn\", \"p button\"). \
Use `rules` whenever the change should reach children (e.g. \"make the headings bigger\").\n\
- IMPORTANT: to change MANY inner elements (e.g. \"make all the numbers green\", \"recolor every \
button\"), you MUST target them with `rules` — setting a property like `color` on the parent will \
NOT affect descendants that define their own value. Match them by the classes/tags listed above.\n\
- Allowed properties ONLY (for both `styles` and each rule's `styles`): {allowed}.\n\
- Concrete CSS values only. NO url(), external resources, @import, or JavaScript.\n\
- Include ONLY what you are changing; omit `rules` (or `styles`) if not needed.\n\
Return nothing else."
        )
    }
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

/// Restyle an existing element from a natural-language instruction ("Edit with
/// AI"). Runs on a transient session (defaulting to a fast `model`) and returns a
/// structured [`RestylePatch`] — whitelisted inline CSS props (+ an optional
/// Graphein spec patch for charts) — which the in-page controller applies as
/// revertable change-set entries. Returns an error string surfaced as a soft
/// failure.
#[tauri::command]
pub async fn design_restyle_element(
    state: State<'_, AppState>,
    project_id: String,
    description: String,
    context: RestyleContext,
    model: Option<String>,
) -> Result<RestylePatch, String> {
    if description.trim().is_empty() {
        return Err("Describe the change first.".into());
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
    let prompt = build_restyle_prompt(&description, &context);
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
    let Some(val) = extract_json(&st.assistant) else {
        return Err("The model didn't return a usable change.".into());
    };
    let patch = to_patch(val, context.is_chart);
    if patch.styles.is_empty() && patch.graphein.is_none() && patch.rules.is_empty() {
        return Err("The model didn't suggest any applicable changes.".into());
    }
    Ok(patch)
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

    #[test]
    fn extract_json_prefers_last_fenced_block() {
        let text = "first:\n```json\n{\"color\":\"red\"}\n```\nbut actually:\n```json\n{\"color\":\"blue\"}\n```";
        let v = extract_json(text).expect("json");
        assert_eq!(v["color"], "blue");
    }

    #[test]
    fn extract_json_falls_back_to_brace_span() {
        let text = "no fences but {\"border-radius\":\"8px\"} here";
        let v = extract_json(text).expect("json");
        assert_eq!(v["border-radius"], "8px");
    }

    #[test]
    fn extract_json_none_when_no_object() {
        assert!(extract_json("just prose, no json").is_none());
    }

    #[test]
    fn collect_styles_keeps_only_whitelisted_props() {
        let map = serde_json::json!({
            "color": "#fff",
            "background-color": "#0f766e",
            "position": "absolute",
            "onclick": "evil()"
        });
        let mut out = HashMap::new();
        collect_styles(map.as_object().unwrap(), &mut out);
        assert_eq!(out.get("color").map(String::as_str), Some("#fff"));
        assert_eq!(out.get("background-color").map(String::as_str), Some("#0f766e"));
        assert!(!out.contains_key("position"));
        assert!(!out.contains_key("onclick"));
    }

    #[test]
    fn collect_styles_rejects_external_and_script_values() {
        let map = serde_json::json!({
            "background-image": "url(https://evil.example/x.png)",
            "background": "expression(alert(1))",
            "color": "javascript:alert(1)",
            "border-radius": "9999px"
        });
        let mut out = HashMap::new();
        collect_styles(map.as_object().unwrap(), &mut out);
        assert!(!out.contains_key("background-image"));
        assert!(!out.contains_key("background"));
        assert!(!out.contains_key("color"));
        assert_eq!(out.get("border-radius").map(String::as_str), Some("9999px"));
    }

    #[test]
    fn to_patch_flat_styles_object() {
        let v = serde_json::json!({ "color": "#fff", "font-size": "18px" });
        let patch = to_patch(v, false);
        assert_eq!(patch.styles.len(), 2);
        assert!(patch.graphein.is_none());
    }

    #[test]
    fn to_patch_styles_wrapper() {
        let v = serde_json::json!({ "styles": { "opacity": "0.5" } });
        let patch = to_patch(v, false);
        assert_eq!(patch.styles.get("opacity").map(String::as_str), Some("0.5"));
    }

    #[test]
    fn to_patch_chart_bare_object_is_spec_patch() {
        let v = serde_json::json!({ "type": "line", "title": "Revenue" });
        let patch = to_patch(v, true);
        assert!(patch.styles.is_empty());
        let g = patch.graphein.expect("graphein");
        assert_eq!(g["type"], "line");
        assert_eq!(g["title"], "Revenue");
    }

    #[test]
    fn to_patch_chart_wrapper_and_strips_data() {
        let v = serde_json::json!({ "graphein": { "palette": "bright" }, "data": [1, 2, 3] });
        let patch = to_patch(v, true);
        let g = patch.graphein.expect("graphein");
        assert_eq!(g["palette"], "bright");
    }

    #[test]
    fn to_patch_chart_bare_object_drops_data_key() {
        let v = serde_json::json!({ "type": "bar", "data": [1, 2] });
        let patch = to_patch(v, true);
        let g = patch.graphein.expect("graphein");
        assert_eq!(g["type"], "bar");
        assert!(g.get("data").is_none());
    }

    #[test]
    fn to_patch_parses_descendant_rules() {
        let v = serde_json::json!({
            "styles": { "border-radius": "16px" },
            "rules": [
                { "selector": "h1", "styles": { "font-size": "32px", "position": "absolute" } },
                { "selector": ".btn", "styles": { "background-color": "#0f766e" } }
            ]
        });
        let patch = to_patch(v, false);
        assert_eq!(patch.styles.get("border-radius").map(String::as_str), Some("16px"));
        assert_eq!(patch.rules.len(), 2);
        assert_eq!(patch.rules[0].selector, "h1");
        assert_eq!(patch.rules[0].styles.get("font-size").map(String::as_str), Some("32px"));
        assert!(!patch.rules[0].styles.contains_key("position")); // whitelist applies to rules too
    }

    #[test]
    fn to_patch_rejects_dangerous_rule_selectors() {
        let v = serde_json::json!({
            "rules": [
                { "selector": "h1 { } body", "styles": { "color": "#fff" } },
                { "selector": "p", "styles": {} }
            ]
        });
        let patch = to_patch(v, false);
        assert!(patch.rules.is_empty()); // bad selector dropped, empty-styles rule dropped
    }

    #[test]
    fn chart_type_hint_covers_common_types() {
        assert!(chart_type_hint(Some("bar")).contains("orientation"));
        assert!(chart_type_hint(Some("pie")).contains("donut"));
        assert!(chart_type_hint(Some("line")).contains("curve"));
        assert!(chart_type_hint(Some("combo")).contains("layers"));
        assert_eq!(chart_type_hint(Some("gauge")), ""); // no distinctive hint → shared menu only
        assert_eq!(chart_type_hint(None), "");
    }

    #[test]
    fn chart_prompt_includes_capability_menu_and_type_hint() {
        let ctx = RestyleContext {
            is_chart: true,
            chart_type: Some("line".into()),
            spec: Some(serde_json::json!({
                "type": "line",
                "encoding": { "x": { "field": "month" }, "y": { "field": "revenue" } }
            })),
            ..Default::default()
        };
        let p = build_restyle_prompt("add a target line at 100 and format the axis as currency", &ctx);
        // The request + current spec are present.
        assert!(p.contains("add a target line at 100"));
        assert!(p.contains("\"field\": \"revenue\"")); // spec dumped
        // Shared capability menu: annotations, palette, axis format, legend, insights.
        assert!(p.contains("annotations"));
        assert!(p.contains("palette"));
        assert!(p.contains("format"));
        assert!(p.contains("legend"));
        assert!(p.contains("insights"));
        // Number-format cheatsheet + a concrete example.
        assert!(p.contains("$,.0f"));
        // Line-specific hint appended.
        assert!(p.contains("curve"));
        // Merge/array-replacement guidance + the never-data contract.
        assert!(p.contains("ARRAYS are REPLACED"));
        assert!(p.contains("deep-merged"));
        assert!(p.contains("NEVER include a `data` key"));
    }

    #[test]
    fn chart_prompt_pie_includes_donut_and_labels() {
        let ctx = RestyleContext {
            is_chart: true,
            chart_type: Some("pie".into()),
            spec: Some(serde_json::json!({ "type": "pie" })),
            ..Default::default()
        };
        let p = build_restyle_prompt("turn it into a donut with outside labels", &ctx);
        assert!(p.contains("donut"));
        assert!(p.contains("labels"));
        assert!(p.contains("annotations")); // shared menu still present
    }

    #[test]
    fn non_chart_prompt_still_asks_for_whitelisted_css() {
        let ctx = RestyleContext { tag: "div".into(), ..Default::default() };
        let p = build_restyle_prompt("make it teal with rounded corners", &ctx);
        assert!(p.contains("Allowed properties"));
        assert!(p.contains("rules")); // descendant-targeting guidance
        assert!(!p.contains("Graphein")); // not the chart branch
    }
}
