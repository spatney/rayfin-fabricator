//! The model providers people can bring their own API key for, and how to turn
//! each one's model list into models a Copilot session can use.
//!
//! What a model can do comes from, in order: the provider's own model list
//! (Anthropic's lists limits, effort levels, image input and thinking types;
//! xAI's lists context sizes, effort levels and image input; Google's lists
//! limits), the same model in Copilot's catalog (matched by id, which also gives
//! the session Copilot's agent configuration for it), then family defaults.

use serde_json::Value;

use crate::types::ByokModelInfo;

/// How a provider's API expects its key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Auth {
  /// `x-api-key` + `anthropic-version` headers.
  Anthropic,
  /// `Authorization: Bearer <key>`.
  Bearer,
  /// `x-goog-api-key` (Google's own API; its OpenAI-compatible one takes a bearer key).
  Google,
}

pub struct ProviderSpec {
  /// Stable id, also the registry provider name: `provider/model` selection ids.
  pub id: &'static str,
  pub name: &'static str,
  /// What its models are, for Accounts.
  pub description: &'static str,
  /// The Copilot runtime's provider type: `"anthropic"` or `"openai"`.
  pub kind: &'static str,
  /// The base URL the Copilot runtime calls.
  pub base_url: &'static str,
  /// `"responses"` or `"completions"` (OpenAI-compatible providers only).
  pub wire_api: Option<&'static str>,
  /// The runtime's telemetry tag, when it has one for this provider.
  pub telemetry: Option<&'static str>,
  /// Lists the models a key can use.
  pub models_url: &'static str,
  /// A second list that fills in what the first leaves out: xAI lists image
  /// input under `/language-models`, but context sizes only under `/models`.
  pub details_url: Option<&'static str>,
  pub auth: Auth,
  /// Where people create a key.
  pub key_url: &'static str,
  /// How keys start (the input's placeholder).
  pub key_prefix: &'static str,
  /// Sessions reach it through Fabricator's relay, which adapts requests (and,
  /// for Google, replies) to what its API takes (see `relay`).
  pub relay: bool,
}

pub const PROVIDERS: [ProviderSpec; 4] = [
  ProviderSpec {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models",
    kind: "anthropic",
    base_url: "https://api.anthropic.com",
    wire_api: None,
    telemetry: Some("anthropic"),
    models_url: "https://api.anthropic.com/v1/models?limit=1000",
    details_url: None,
    auth: Auth::Anthropic,
    key_url: "https://platform.claude.com/settings/keys",
    key_prefix: "sk-ant-",
    relay: false,
  },
  ProviderSpec {
    id: "openai",
    name: "OpenAI",
    description: "GPT models",
    kind: "openai",
    base_url: "https://api.openai.com/v1",
    wire_api: Some("responses"),
    telemetry: Some("openai"),
    models_url: "https://api.openai.com/v1/models",
    details_url: None,
    auth: Auth::Bearer,
    key_url: "https://platform.openai.com/settings/organization/api-keys",
    key_prefix: "sk-",
    relay: true,
  },
  ProviderSpec {
    id: "xai",
    name: "xAI",
    description: "Grok models",
    kind: "openai",
    base_url: "https://api.x.ai/v1",
    wire_api: Some("responses"),
    telemetry: None,
    models_url: "https://api.x.ai/v1/language-models",
    details_url: Some("https://api.x.ai/v1/models"),
    auth: Auth::Bearer,
    key_url: "https://console.x.ai/team/default/api-keys",
    key_prefix: "xai-",
    relay: true,
  },
  ProviderSpec {
    id: "google",
    name: "Google",
    description: "Gemini and Gemma models",
    kind: "openai",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    wire_api: Some("completions"),
    telemetry: None,
    models_url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    details_url: None,
    auth: Auth::Google,
    key_url: "https://aistudio.google.com/apikey",
    key_prefix: "AIza",
    relay: true,
  },
];

pub fn find(id: &str) -> Option<&'static ProviderSpec> {
  PROVIDERS.iter().find(|p| p.id == id)
}

/// Fabricator's reasoning-effort vocabulary (what the model picker can show).
const EFFORTS: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];

/// Models whose context window is smaller than this can't hold Fabricator's
/// agent prompt (system prompt, skills and tool definitions) plus a task.
const MIN_CONTEXT: u32 = 32_768;

/// A model as a provider lists it, before it's matched with Copilot's catalog.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listed {
  pub id: String,
  pub name: Option<String>,
  pub created: i64,
  pub context: Option<u32>,
  pub max_output: Option<u32>,
  pub vision: Option<bool>,
  pub efforts: Option<Vec<String>>,
  /// The effort the provider uses when a request names none.
  pub default_effort: Option<String>,
  pub adaptive_thinking: Option<String>,
  pub deprecated: bool,
  /// Anthropic's model line (`"opus"`, `"sonnet"`, `"haiku"`…).
  pub line: Option<String>,
  /// False: the model can't be called (Anthropic's retired models, Google's
  /// models that can't hold a conversation).
  pub active: bool,
}

/// What Copilot's catalog knows about a model (its "twin").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CopilotTwin {
  pub id: String,
  pub name: String,
  pub vision: bool,
  pub efforts: Vec<String>,
  pub default_effort: Option<String>,
  pub context: Option<u32>,
  pub max_prompt: Option<u32>,
  pub max_output: Option<u32>,
  pub adaptive_thinking: Option<String>,
}

fn as_u32(v: &Value) -> Option<u32> {
  v.as_u64().filter(|n| *n > 0).map(|n| n.min(u32::MAX as u64) as u32)
}

/// A capability flag that is either `true`/`false` or `{ "supported": bool }`.
fn flag(v: &Value) -> Option<bool> {
  v.as_bool().or_else(|| v.get("supported").and_then(Value::as_bool))
}

fn rfc3339_secs(v: &Value) -> i64 {
  v.as_str()
    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    .map(|d| d.timestamp())
    .unwrap_or(0)
}

/// Read a provider's model list (`data` in OpenAI's shape; `models` in xAI's
/// `/language-models` and Google's list, which names a model `models/<id>`).
pub fn parse_models(provider: &str, body: &Value) -> Vec<Listed> {
  let Some(items) = body.get("data").or_else(|| body.get("models")).and_then(Value::as_array) else {
    return Vec::new();
  };
  items
    .iter()
    .filter_map(|m| {
      let id = m.get("id").or_else(|| m.get("name"))?.as_str()?.trim();
      let id = id.strip_prefix("models/").unwrap_or(id).to_string();
      if id.is_empty() {
        return None;
      }
      Some(match provider {
        "anthropic" => parse_anthropic(id, m),
        "xai" => parse_xai(id, m),
        "google" => parse_google(id, m),
        _ => Listed {
          created: m.get("created").and_then(Value::as_i64).unwrap_or(0),
          deprecated: m.get("shutdown_date").is_some_and(|d| d.is_string()),
          active: true,
          id,
          ..Default::default()
        },
      })
    })
    .collect()
}

/// Fill in what `listed` doesn't say from a second list of the same models.
pub fn fill_in(listed: &mut [Listed], details: Vec<Listed>) {
  for m in listed.iter_mut() {
    let Some(d) = details.iter().find(|d| d.id == m.id) else {
      continue;
    };
    m.name = m.name.take().or_else(|| d.name.clone());
    m.created = if m.created > 0 { m.created } else { d.created };
    m.context = m.context.or(d.context);
    m.max_output = m.max_output.or(d.max_output);
    m.vision = m.vision.or(d.vision);
    m.efforts = m.efforts.take().or_else(|| d.efforts.clone());
    m.default_effort = m.default_effort.take().or_else(|| d.default_effort.clone());
  }
}

/// xAI lists the efforts a model takes and its default; a model it lists none
/// for rejects the parameter altogether.
fn parse_xai(id: String, m: &Value) -> Listed {
  let caps = m.get("capabilities");
  let strings = |v: &Value| v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>());
  Listed {
    created: m.get("created").and_then(Value::as_i64).unwrap_or(0),
    context: m.get("context_length").and_then(as_u32),
    vision: m.get("input_modalities").and_then(strings).map(|kinds| kinds.iter().any(|k| k == "image")),
    efforts: Some(caps.and_then(|c| c.get("reasoning_effort")).and_then(strings).unwrap_or_default()),
    default_effort: caps
      .and_then(|c| c.get("default_reasoning_effort"))
      .and_then(Value::as_str)
      .map(str::to_string),
    active: true,
    id,
    ..Default::default()
  }
}

/// Google lists limits and whether a model thinks, but not its effort levels.
/// Every Gemini model since 3 takes low, medium and high (only some take none);
/// Gemma takes neither.
fn parse_google(id: String, m: &Value) -> Listed {
  let thinks = m.get("thinking").and_then(Value::as_bool).unwrap_or(false);
  let chats = m
    .get("supportedGenerationMethods")
    .and_then(Value::as_array)
    .is_some_and(|methods| methods.iter().any(|v| v == "generateContent"));
  Listed {
    name: m.get("displayName").and_then(Value::as_str).map(str::to_string),
    context: m.get("inputTokenLimit").and_then(as_u32),
    max_output: m.get("outputTokenLimit").and_then(as_u32),
    efforts: Some(if thinks && !id.starts_with("gemma") {
      ["low", "medium", "high"].map(String::from).to_vec()
    } else {
      Vec::new()
    }),
    active: chats,
    id,
    ..Default::default()
  }
}

fn parse_anthropic(id: String, m: &Value) -> Listed {
  let caps = m.get("capabilities").cloned().unwrap_or(Value::Null);
  let efforts = caps.get("effort").filter(|e| flag(e) == Some(true)).map(|e| {
    EFFORTS
      .iter()
      .filter(|level| e.get(**level).and_then(flag) == Some(true))
      .map(|level| level.to_string())
      .collect::<Vec<_>>()
  });
  let adaptive_thinking = caps.get("thinking").filter(|t| flag(t) == Some(true)).map(|t| {
    let types = t.get("types").cloned().unwrap_or(Value::Null);
    let has = |name: &str| types.get(name).and_then(flag).unwrap_or(false);
    match (has("adaptive"), has("enabled"), has("disabled")) {
      (false, _, _) => "unsupported",
      (true, true, _) => "optional",
      (true, false, true) => "required",
      (true, false, false) => "adaptive_only",
    }
    .to_string()
  });
  Listed {
    name: m.get("display_name").and_then(Value::as_str).map(str::to_string),
    created: m.get("created_at").map(rfc3339_secs).unwrap_or(0),
    context: m.get("max_input_tokens").and_then(as_u32),
    max_output: m.get("max_tokens").and_then(as_u32),
    vision: caps.get("image_input").and_then(flag),
    efforts,
    default_effort: None,
    adaptive_thinking,
    deprecated: m.get("lifecycle").and_then(Value::as_str) == Some("deprecated"),
    line: m.get("line").and_then(Value::as_str).map(str::to_string),
    active: m.get("lifecycle").and_then(Value::as_str) != Some("retired"),
    id,
  }
}

/// Whether a listed model is a chat model Fabricator's agent can use.
pub fn is_chat_model(provider: &str, m: &Listed) -> bool {
  if !m.active || m.context.is_some_and(|c| c < MIN_CONTEXT) {
    return false;
  }
  let id = m.id.to_ascii_lowercase();
  match provider {
    "anthropic" => id.starts_with("claude"),
    "openai" => {
      const NOT_CHAT: [&str; 16] = [
        "audio", "realtime", "live", "tts", "transcribe", "image", "search", "embedding", "moderation", "instruct",
        "davinci", "babbage", "dall-e", "whisper", "computer-use", "deep-research",
      ];
      let family = id.starts_with("gpt-") || id.starts_with("chatgpt-") || id.starts_with("codex") || is_o_series(&id);
      family
        && !NOT_CHAT.iter().any(|t| id.contains(t))
        && strip_date(&id).len() == id.len()
        && !id.starts_with("gpt-3.5")
        && !matches!(id.as_str(), "gpt-4" | "gpt-4-0613" | "gpt-4-0314")
        && !id.starts_with("gpt-4-32k")
    }
    "xai" => {
      const NOT_CHAT: [&str; 6] = ["imagine", "multi-agent", "embed", "tts", "voice", "realtime"];
      id.starts_with("grok") && !NOT_CHAT.iter().any(|t| id.contains(t))
    }
    "google" => {
      // Media, speech, live, research and agent models, and the `-latest`
      // aliases of models the list has under their own names. Gemini before 3
      // isn't offered to new keys, and Gemma before 4 can't call tools.
      const NOT_CHAT: [&str; 14] = [
        "tts", "image", "audio", "embedding", "transcribe", "live", "lyria", "robotics", "computer-use", "deep-research",
        "antigravity", "nano-banana", "omni", "aqa",
      ];
      let since = if id.starts_with("gemini-") {
        3
      } else if id.starts_with("gemma-") {
        4
      } else {
        return false;
      };
      version_of(&id).0 >= since && !id.ends_with("-latest") && !NOT_CHAT.iter().any(|t| id.contains(t))
    }
    _ => false,
  }
}

/// The version number in a model id (`gemini-3.8-flash` → (3, 8)), for
/// ordering models a provider lists without dates.
fn version_of(id: &str) -> (u32, u32) {
  id.split(['-', '/'])
    .find(|t| t.starts_with(|c: char| c.is_ascii_digit()))
    .map(|t| {
      let mut parts = t.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
      (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
    })
    .unwrap_or((0, 0))
}

fn is_o_series(id: &str) -> bool {
  let mut chars = id.chars();
  chars.next() == Some('o') && chars.next().is_some_and(|c| c.is_ascii_digit())
}

/// Drop a dated snapshot suffix: `-20250929` or `-2024-08-06`.
fn strip_date(id: &str) -> &str {
  let bytes = id.as_bytes();
  let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
  if bytes.len() > 9 && bytes[bytes.len() - 9] == b'-' && digits(&bytes[bytes.len() - 8..]) {
    return &id[..id.len() - 9];
  }
  if bytes.len() > 11 {
    let tail = &bytes[bytes.len() - 11..];
    if tail[0] == b'-' && digits(&tail[1..5]) && tail[5] == b'-' && digits(&tail[6..8]) && tail[8] == b'-' && digits(&tail[9..]) {
      return &id[..id.len() - 11];
    }
  }
  id
}

/// The id Copilot would use for the same model: no owner prefix, no date, no
/// `-latest`, and dots between version numbers (`claude-opus-5-5` →
/// `claude-opus-5.5`).
pub fn normalize_id(id: &str) -> String {
  let id = id.rsplit('/').next().unwrap_or(id).to_ascii_lowercase();
  let id = id.strip_suffix("-latest").unwrap_or(&id).to_string();
  let id = strip_date(&id);
  let chars: Vec<char> = id.chars().collect();
  chars
    .iter()
    .enumerate()
    .map(|(i, c)| {
      let between_digits = *c == '-'
        && i > 0
        && chars[i - 1].is_ascii_digit()
        && chars.get(i + 1).is_some_and(char::is_ascii_digit);
      if between_digits { '.' } else { *c }
    })
    .collect()
}

/// Family defaults for what the provider didn't say and Copilot doesn't know.
struct Defaults {
  context: u32,
  max_output: u32,
  vision: bool,
  efforts: &'static [&'static str],
}

fn defaults(provider: &str, id: &str) -> Defaults {
  let id = id.to_ascii_lowercase();
  let d = |context, max_output, vision, efforts| Defaults { context, max_output, vision, efforts };
  match provider {
    "anthropic" => d(200_000, 32_000, true, &[]),
    "openai" if id.starts_with("gpt-6") => d(1_050_000, 128_000, true, &["low", "medium", "high", "xhigh", "max"]),
    "openai" if id.starts_with("gpt-5") || id.starts_with("codex") => d(400_000, 128_000, true, &["low", "medium", "high"]),
    "openai" if is_o_series(&id) => d(200_000, 100_000, !id.starts_with("o3-mini"), &["low", "medium", "high"]),
    "openai" if id.starts_with("gpt-4.1") => d(1_047_576, 32_768, true, &[]),
    "openai" if id.starts_with("gpt-4o") || id.starts_with("chatgpt-") => d(128_000, 16_384, true, &[]),
    "openai" => d(128_000, 16_384, false, &[]),
    "xai" => d(256_000, 32_768, true, &[]),
    "google" if id.starts_with("gemma") => d(262_144, 32_768, true, &[]),
    "google" => d(1_048_576, 65_536, true, &["low", "medium", "high"]),
    _ => d(128_000, 16_384, false, &[]),
  }
}

/// A readable name for a model the provider didn't name.
pub fn pretty_name(provider: &str, id: &str) -> String {
  let bare = id.rsplit('/').next().unwrap_or(id);
  match provider {
    "openai" => openai_name(bare),
    "xai" => grok_name(bare),
    _ => bare.to_string(),
  }
}

fn capitalized(word: &str) -> String {
  let mut c = word.chars();
  c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// `grok-4.20-0309-non-reasoning` → `Grok 4.20 Non-reasoning` (the snapshot
/// date left out).
fn grok_name(id: &str) -> String {
  let mut words: Vec<String> = Vec::new();
  let mut parts = id.split('-');
  while let Some(part) = parts.next() {
    if part.len() == 4 && part.chars().all(|c| c.is_ascii_digit()) {
      continue;
    }
    words.push(match (part, parts.clone().next()) {
      ("non", Some(next)) => {
        parts.next();
        format!("Non-{next}")
      }
      _ => capitalized(part),
    });
  }
  words.join(" ")
}

fn openai_name(bare: &str) -> String {
  let mut parts = bare.split('-').peekable();
  let mut words: Vec<String> = Vec::new();
  if parts.peek() == Some(&"gpt") {
    parts.next();
    words.push(format!("GPT-{}", parts.next().unwrap_or("")));
  } else if parts.peek() == Some(&"chatgpt") {
    parts.next();
    words.push("ChatGPT".into());
  }
  for p in parts {
    words.push(match p {
      "mini" | "nano" => p.to_string(),
      _ if p.starts_with('o') && p[1..].chars().all(|c| c.is_ascii_digit()) && p.len() > 1 => p.to_string(),
      _ => capitalized(p),
    });
  }
  words.join(" ")
}

/// The family a model belongs to, for recommending the newest of each.
fn family(provider: &str, m: &Listed) -> String {
  if let Some(line) = &m.line {
    return line.clone();
  }
  let id = m.id.to_ascii_lowercase();
  match provider {
    "anthropic" => ["fable", "opus", "sonnet", "haiku", "mythos"]
      .into_iter()
      .find(|f| id.contains(f))
      .unwrap_or("claude")
      .to_string(),
    _ => normalize_id(&id)
      .split('-')
      .filter(|t| !t.chars().next().is_some_and(|c| c.is_ascii_digit()))
      .collect::<Vec<_>>()
      .join("-"),
  }
}

/// Turn a provider's list into the models Fabricator offers: chat models only,
/// matched with Copilot's catalog, newest first (models being retired last),
/// with a few recommended.
pub fn resolve(provider: &str, listed: Vec<Listed>, copilot: &[CopilotTwin]) -> Vec<ByokModelInfo> {
  let mut models: Vec<(String, ByokModelInfo)> = listed
    .into_iter()
    .filter(|m| is_chat_model(provider, m))
    .map(|m| {
      let twin = copilot.iter().find(|t| normalize_id(&t.id) == normalize_id(&m.id));
      let d = defaults(provider, &m.id);
      let context = m.context.or(twin.and_then(|t| t.context)).unwrap_or(d.context);
      let max_output = m.max_output.or(twin.and_then(|t| t.max_output)).unwrap_or(d.max_output);
      let efforts = m
        .efforts
        .clone()
        .or(twin.map(|t| t.efforts.clone()))
        .unwrap_or_else(|| d.efforts.iter().map(|e| e.to_string()).collect())
        .into_iter()
        .filter(|e| EFFORTS.contains(&e.as_str()))
        .collect::<Vec<_>>();
      let default_effort = m
        .default_effort
        .clone()
        .or_else(|| twin.and_then(|t| t.default_effort.clone()))
        .filter(|e| efforts.contains(e));
      let info = ByokModelInfo {
        name: m
          .name
          .clone()
          .or(twin.map(|t| t.name.clone()))
          .unwrap_or_else(|| pretty_name(provider, &m.id)),
        context_window: context,
        max_prompt: if m.context.is_some() { None } else { twin.and_then(|t| t.max_prompt) },
        max_output,
        vision: m.vision.or(twin.map(|t| t.vision)).unwrap_or(d.vision),
        efforts,
        default_effort,
        copilot_id: twin.map(|t| t.id.clone()),
        adaptive_thinking: m.adaptive_thinking.clone().or(twin.and_then(|t| t.adaptive_thinking.clone())),
        deprecated: m.deprecated,
        recommended: false,
        created: m.created,
        id: m.id.clone(),
      };
      (family(provider, &m), info)
    })
    .collect();
  // Newest first (by date, else by the version in the id, Gemma after Gemini),
  // models being retired last.
  models.sort_by(|(_, a), (_, b)| {
    a.deprecated
      .cmp(&b.deprecated)
      .then(b.created.cmp(&a.created))
      .then(a.id.starts_with("gemma").cmp(&b.id.starts_with("gemma")))
      .then(version_of(&b.id).cmp(&version_of(&a.id)))
      .then(a.id.cmp(&b.id))
  });
  recommend(provider, &mut models);
  models.into_iter().map(|(_, m)| m).collect()
}

/// Suggest a few models when a key is added: Anthropic's newest Opus, Sonnet
/// and Haiku; for the others, the newest models Copilot also offers (it has
/// tuned its agent for them), else the provider's newest main models.
fn recommend(provider: &str, models: &mut [(String, ByokModelInfo)]) {
  let mut picked: Vec<usize> = Vec::new();
  let active = |m: &ByokModelInfo| !m.deprecated;
  if provider == "anthropic" {
    for line in ["opus", "sonnet", "haiku"] {
      if let Some(i) = models.iter().position(|(f, m)| f == line && active(m)) {
        picked.push(i);
      }
    }
  } else {
    let limit = if provider == "openai" { 3 } else { 2 };
    let main = |family: &str, m: &ByokModelInfo| match provider {
      "openai" => m.id.starts_with("gpt-"),
      "xai" => family == "grok",
      "google" => m.id.starts_with("gemini-") && !m.id.contains("lite"),
      _ => true,
    };
    picked = models
      .iter()
      .enumerate()
      .filter(|(_, (_, m))| active(m) && m.copilot_id.is_some())
      .map(|(i, _)| i)
      .take(limit)
      .collect();
    if picked.is_empty() {
      picked = models
        .iter()
        .enumerate()
        .filter(|(_, (family, m))| active(m) && main(family, m))
        .map(|(i, _)| i)
        .take(limit)
        .collect();
    }
  }
  if picked.is_empty() {
    picked = (0..models.len().min(2)).filter(|i| active(&models[*i].1)).collect();
  }
  for i in picked {
    models[i].1.recommended = true;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn twin(id: &str, name: &str) -> CopilotTwin {
    CopilotTwin {
      id: id.into(),
      name: name.into(),
      vision: true,
      efforts: vec!["low".into(), "medium".into(), "high".into()],
      default_effort: Some("medium".into()),
      context: Some(400_000),
      max_prompt: Some(272_000),
      max_output: Some(128_000),
      adaptive_thinking: None,
    }
  }

  #[test]
  fn provider_ids_map_to_copilot_ids() {
    assert_eq!(normalize_id("claude-opus-5-5"), "claude-opus-5.5");
    assert_eq!(normalize_id("claude-sonnet-4-5-20250929"), "claude-sonnet-4.5");
    assert_eq!(normalize_id("claude-3-7-sonnet-latest"), "claude-3.7-sonnet");
    assert_eq!(normalize_id("gpt-6.1-sol"), "gpt-6.1-sol");
    assert_eq!(normalize_id("gpt-4o-2024-08-06"), "gpt-4o");
    assert_eq!(normalize_id("openai/gpt-oss-120b"), "gpt-oss-120b");
  }

  #[test]
  fn anthropic_lists_limits_efforts_vision_and_thinking() {
    let body = json!({ "data": [
      {
        "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "created_at": "2026-09-03T00:00:00Z",
        "lifecycle": "active", "line": "opus", "max_input_tokens": 1_000_000, "max_tokens": 128_000,
        "capabilities": {
          "image_input": { "supported": true },
          "effort": { "supported": true, "low": { "supported": true }, "medium": { "supported": true },
                      "high": { "supported": true }, "xhigh": { "supported": true }, "max": { "supported": true } },
          "thinking": { "supported": true, "types": { "adaptive": { "supported": true }, "enabled": { "supported": false },
                                                       "disabled": { "supported": true } } }
        }
      },
      { "id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "lifecycle": "active",
        "capabilities": { "thinking": { "supported": true, "types": { "adaptive": true } } } },
      { "id": "claude-opus-5", "display_name": "Claude Opus 5", "lifecycle": "deprecated" },
      { "id": "claude-2", "lifecycle": "retired" }
    ]});
    let listed = parse_models("anthropic", &body);
    assert_eq!(listed.len(), 4);
    let opus = &listed[0];
    assert_eq!((opus.context, opus.max_output, opus.vision), (Some(1_000_000), Some(128_000), Some(true)));
    assert_eq!(opus.efforts.as_deref().unwrap(), ["low", "medium", "high", "xhigh", "max"]);
    assert_eq!(opus.adaptive_thinking.as_deref(), Some("required"));
    assert_eq!(listed[1].adaptive_thinking.as_deref(), Some("adaptive_only"));
    assert!(listed[2].deprecated && !listed[3].active);

    let models = resolve("anthropic", listed, &[twin("claude-opus-5.5", "Claude Opus 5.5")]);
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    // Newest first, retiring models last, retired ones gone.
    assert_eq!(ids, ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5"]);
    let opus = &models[0];
    assert_eq!(opus.copilot_id.as_deref(), Some("claude-opus-5.5"));
    // The provider's own figures win over Copilot's.
    assert_eq!((opus.context_window, opus.max_output, opus.max_prompt), (1_000_000, 128_000, None));
    assert_eq!(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert!(opus.recommended && !models[2].recommended);
  }

  #[test]
  fn openai_keeps_chat_models_and_learns_the_rest_from_copilot() {
    let body = json!({ "object": "list", "data": [
      { "id": "gpt-6-astra", "created": 1_790_000_000, "owned_by": "openai", "shutdown_date": null },
      { "id": "gpt-6.1-sol", "created": 1_791_000_000, "owned_by": "openai" },
      { "id": "gpt-6.1-sol-2026-08-01", "created": 1_791_000_000 },
      { "id": "gpt-5", "created": 1_750_000_000, "shutdown_date": "2026-12-11" },
      { "id": "gpt-realtime-2.1", "created": 1_792_000_000 },
      { "id": "gpt-live-1", "created": 1_788_889_407 },
      { "id": "text-embedding-3-large", "created": 1 },
      { "id": "gpt-3.5-turbo", "created": 1 },
      { "id": "o3", "created": 1_740_000_000, "shutdown_date": "2026-12-11" },
      { "id": "dall-e-3", "created": 1 }
    ]});
    let models = resolve("openai", parse_models("openai", &body), &[twin("gpt-6.1-sol", "GPT-6.1 Sol")]);
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["gpt-6.1-sol", "gpt-6-astra", "gpt-5", "o3"]);
    let sol = &models[0];
    assert_eq!((sol.name.as_str(), sol.copilot_id.as_deref()), ("GPT-6.1 Sol", Some("gpt-6.1-sol")));
    assert_eq!((sol.context_window, sol.max_prompt, sol.default_effort.as_deref()), (400_000, Some(272_000), Some("medium")));
    let astra = &models[1];
    assert_eq!((astra.name.as_str(), astra.context_window), ("GPT-6 Astra", 1_050_000));
    assert_eq!(astra.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert!(models[2].deprecated);
    // Copilot offers Sol, so it's the suggestion.
    assert!(sol.recommended && !astra.recommended);
  }

  #[test]
  fn xai_takes_efforts_and_images_from_one_list_and_context_from_the_other() {
    let language = json!({ "models": [
      { "id": "grok-4.7", "created": 1_788_307_200, "input_modalities": ["text", "image"], "output_modalities": ["text"],
        "capabilities": { "reasoning_effort": ["low", "medium", "high", "xhigh"], "default_reasoning_effort": "high" } },
      { "id": "grok-4.3", "created": 1_776_384_000, "input_modalities": ["text", "image"],
        "capabilities": { "reasoning_effort": ["none", "low", "medium", "high", "xhigh"], "default_reasoning_effort": "low" } },
      { "id": "grok-build-0.1", "created": 1_776_297_600, "input_modalities": ["text"] },
      { "id": "grok-4.20-0309-non-reasoning", "created": 1_773_014_400, "input_modalities": ["text", "image"] },
      { "id": "grok-4.20-multi-agent-0309", "created": 1_773_014_400, "input_modalities": ["text", "image"] }
    ]});
    let details = json!({ "data": [
      { "id": "grok-4.7", "context_length": 500_000, "created": 1_788_307_200 },
      { "id": "grok-4.3", "context_length": 1_000_000 },
      { "id": "grok-build-0.1", "context_length": 256_000 },
      { "id": "grok-4.20-0309-non-reasoning", "context_length": 1_000_000 },
      { "id": "grok-imagine-image", "context_length": 16_000 }
    ]});
    let mut listed = parse_models("xai", &language);
    fill_in(&mut listed, parse_models("xai", &details));
    let models = resolve("xai", listed, &[twin("grok-4.7", "Grok 4.7")]);
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["grok-4.7", "grok-4.3", "grok-build-0.1", "grok-4.20-0309-non-reasoning"]);
    let grok = &models[0];
    assert_eq!((grok.context_window, grok.vision, grok.default_effort.as_deref()), (500_000, true, Some("high")));
    // xAI's own effort list wins over Copilot's.
    assert_eq!(grok.efforts, ["low", "medium", "high", "xhigh"]);
    assert_eq!(models[1].efforts, ["none", "low", "medium", "high", "xhigh"]);
    // A model xAI lists no efforts for rejects the parameter, so it gets none.
    assert!(models[2].efforts.is_empty() && !models[2].vision);
    assert_eq!((models[2].name.as_str(), models[3].name.as_str()), ("Grok Build 0.1", "Grok 4.20 Non-reasoning"));
    assert!(grok.recommended && !models[2].recommended);
  }

  #[test]
  fn google_keeps_gemini_3_and_gemma_4_chat_models_newest_first() {
    let body = json!({ "models": [
      { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro", "inputTokenLimit": 1_048_576,
        "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent"], "thinking": true },
      { "name": "models/gemini-3.1-pro-preview", "displayName": "Gemini 3.1 Pro Preview", "inputTokenLimit": 1_048_576,
        "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent", "countTokens"], "thinking": true },
      { "name": "models/gemma-4-31b-it", "displayName": "Gemma 4 31B IT", "inputTokenLimit": 262_144,
        "outputTokenLimit": 32_768, "supportedGenerationMethods": ["generateContent"], "thinking": true },
      { "name": "models/gemini-4-argon", "displayName": "Gemini 4 Argon", "inputTokenLimit": 1_048_576,
        "outputTokenLimit": 32_768, "supportedGenerationMethods": ["generateContent"], "thinking": true },
      { "name": "models/gemini-3.8-flash", "displayName": "Gemini 3.8 Flash", "inputTokenLimit": 1_048_576,
        "outputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent"], "thinking": true },
      { "name": "models/gemini-flash-latest", "displayName": "Gemini Flash Latest", "inputTokenLimit": 1_048_576,
        "supportedGenerationMethods": ["generateContent"], "thinking": true },
      { "name": "models/gemini-3.8-flash-tts", "inputTokenLimit": 8_192, "supportedGenerationMethods": ["generateContent"] },
      { "name": "models/gemini-3.1-flash-image", "inputTokenLimit": 65_536, "supportedGenerationMethods": ["generateContent"] },
      { "name": "models/gemini-omni-1.1-flash", "inputTokenLimit": 131_072, "supportedGenerationMethods": ["generateContent"] },
      { "name": "models/gemini-3.8-live", "inputTokenLimit": 131_072, "supportedGenerationMethods": ["bidiGenerateContent"] },
      { "name": "models/gemini-embedding-2", "inputTokenLimit": 8_192, "supportedGenerationMethods": ["embedContent"] }
    ]});
    let models = resolve("google", parse_models("google", &body), &[twin("gemini-3.8-flash", "Gemini 3.8 Flash")]);
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemma-4-31b-it"]);
    let flash = &models[1];
    assert_eq!((flash.name.as_str(), flash.context_window, flash.max_output), ("Gemini 3.8 Flash", 1_048_576, 65_536));
    assert_eq!(flash.efforts, ["low", "medium", "high"]);
    assert_eq!((flash.vision, flash.copilot_id.as_deref()), (true, Some("gemini-3.8-flash")));
    assert!(models[3].efforts.is_empty(), "Gemma takes no effort levels");
    // Copilot offers Flash, so it's the suggestion.
    assert!(flash.recommended && models.iter().filter(|m| m.recommended).count() == 1);
  }

  #[test]
  fn unnamed_models_read_like_their_makers_name_them() {
    assert_eq!(pretty_name("openai", "gpt-6-astra"), "GPT-6 Astra");
    assert_eq!(pretty_name("openai", "gpt-5.6-sol-fast"), "GPT-5.6 Sol Fast");
    assert_eq!(pretty_name("openai", "gpt-4.1-mini"), "GPT-4.1 mini");
    assert_eq!(pretty_name("openai", "o3"), "o3");
    assert_eq!(pretty_name("xai", "grok-4.20-0309-reasoning"), "Grok 4.20 Reasoning");
    assert_eq!(pretty_name("google", "models/gemini-4-argon"), "gemini-4-argon");
  }
}
