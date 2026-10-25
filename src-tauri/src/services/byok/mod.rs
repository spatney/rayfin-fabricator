//! Your own API keys: models from Anthropic, OpenAI, xAI and Google
//! on the user's own keys, next to Copilot's in Build chat, the Advisor and Design.
//!
//! - [`keychain`] keeps keys in the OS credential store (never in settings).
//! - [`catalog`] knows each provider and turns its model list into models a
//!   Copilot session can use; settings keep that list and the user's choices.
//! - [`registry`] hands the chosen models to sessions as BYOK providers.
//! - [`relay`] passes OpenAI-compatible providers' traffic through a local relay
//!   that adapts requests (and Google's replies) to what each API takes.
//!
//! Copilot sign-in is still required: the Copilot engine runs the agent loop and
//! calls the provider directly with the key.

pub mod catalog;
pub mod keychain;
pub mod registry;
pub mod relay;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use self::catalog::{Auth, CopilotTwin, Listed, ProviderSpec};
use self::registry::ByokRegistry;
use crate::services::store;
use crate::types::{ByokModelInfo, ByokModelMeta, ByokProviderSettings, ByokProviderStatus, ByokStatus, CopilotModel};

/// Sent to a model whose response was empty: no reply and no tool call. A model
/// can end a response that way (gpt-oss when it garbles a tool call, Claude now
/// and then after a tool result), and the Copilot runtime takes it as the end of
/// the turn, so the turn would stop without a word.
pub const CONTINUE_PROMPT: &str = "[Fabricator: your last response was empty, with no reply and no tool call, so nothing happened. Continue from where you stopped. If you meant to call a tool, call it again. If you're finished, give your final answer.]";
/// How many times one turn asks a model to continue before giving up.
pub const MAX_CONTINUES: u32 = 2;
/// Shown when a model keeps stopping without finishing.
pub const STOPPED_EARLY: &str = "The model stopped before finishing. Select Retry, or choose another model.";

/// A finished `assistant.message` with no text and no tool call (see [`CONTINUE_PROMPT`]).
pub fn is_empty_response(data: &Value) -> bool {
  let text = data.get("content").and_then(Value::as_str).unwrap_or("");
  let calls = data.get("toolRequests").and_then(Value::as_array).is_some_and(|c| !c.is_empty());
  text.trim().is_empty() && !calls
}

/// A model selection that names a provider (`provider/model`). Copilot's own
/// model ids never contain `/`.
pub fn is_provider_selection(id: &str) -> bool {
  id.contains('/')
}

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
  reqwest::Client::builder()
    .timeout(Duration::from_secs(20))
    .user_agent("rayfin-fabricator")
    .build()
    .unwrap_or_default()
});

/// The text of a provider's error reply: `{"error":{"message":…}}`, or xAI's
/// `{"error":"…"}`.
fn error_detail(body: &Value) -> String {
  body
    .pointer("/error/message")
    .or_else(|| body.get("error"))
    .or_else(|| body.get("message"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .trim()
    .to_string()
}

/// GET one of a provider's model lists with `key`.
async fn get_list(spec: &ProviderSpec, url: &str, key: &str) -> Result<Value, String> {
  let request = HTTP.get(url);
  let request = match spec.auth {
    Auth::Anthropic => request.header("x-api-key", key).header("anthropic-version", "2023-06-01"),
    Auth::Bearer => request.bearer_auth(key),
    Auth::Google => request.header("x-goog-api-key", key),
  };
  let response = request.send().await.map_err(|e| {
    log::warn!("listing {} models failed: {e}", spec.name);
    if e.is_timeout() {
      format!("{} didn't answer in time. Check your connection and try again.", spec.name)
    } else {
      format!("Couldn't reach {}. Check your connection and try again.", spec.name)
    }
  })?;
  let status = response.status();
  let body: Value = response.json().await.unwrap_or(Value::Null);
  let detail = error_detail(&body);
  // xAI and Google turn a bad key down with a 400, not a 401.
  if status.as_u16() == 401 || (!status.is_success() && classify(&detail) == Some(Failure::KeyRejected)) {
    return Err(format!("{} didn't accept this key. Check that you copied all of it.", spec.name));
  }
  if !status.is_success() {
    return Err(format!("{} couldn't list its models ({}). {detail}", spec.name, status.as_u16()).trim().to_string());
  }
  Ok(body)
}

/// List the models `key` can use, which also checks the key.
async fn list_models(spec: &ProviderSpec, key: &str) -> Result<Vec<Listed>, String> {
  let mut listed = catalog::parse_models(spec.id, &get_list(spec, spec.models_url, key).await?);
  if let Some(url) = spec.details_url {
    match get_list(spec, url, key).await {
      Ok(details) => catalog::fill_in(&mut listed, catalog::parse_models(spec.id, &details)),
      Err(e) => log::warn!("listing {} model details failed: {e}", spec.name),
    }
  }
  Ok(listed)
}

/// What Copilot's catalog says about one of its models.
pub fn twin_from(m: &github_copilot_sdk::Model) -> CopilotTwin {
  let limits = m.capabilities.limits.as_ref();
  let supports = m.capabilities.supports.as_ref();
  let tokens = |v: Option<i64>| v.filter(|n| *n > 0).map(|n| n.min(u32::MAX as i64) as u32);
  CopilotTwin {
    id: m.id.clone(),
    name: m.name.clone(),
    vision: supports.and_then(|s| s.vision).unwrap_or(false),
    efforts: m.supported_reasoning_efforts.clone().unwrap_or_default(),
    default_effort: m.default_reasoning_effort.clone(),
    context: tokens(limits.and_then(|l| l.max_context_window_tokens)),
    max_prompt: tokens(limits.and_then(|l| l.max_prompt_tokens)),
    max_output: tokens(limits.and_then(|l| l.max_output_tokens)),
    adaptive_thinking: supports
      .and_then(|s| s.adaptive_thinking.as_ref())
      .and_then(|a| serde_json::to_value(a).ok())
      .and_then(|v| v.as_str().map(str::to_string))
      .filter(|a| a != "Unknown"),
  }
}

/// Models the user had chosen that the provider still lists, else its suggestions.
fn keep_enabled(previous: Option<Vec<String>>, models: &[ByokModelInfo]) -> Vec<String> {
  let kept: Vec<String> = previous
    .unwrap_or_default()
    .into_iter()
    .filter(|id| models.iter().any(|m| &m.id == id))
    .collect();
  if !kept.is_empty() {
    return kept;
  }
  models.iter().filter(|m| m.recommended).map(|m| m.id.clone()).collect()
}

/// Who makes a model, for its logo in the picker: each provider's models are its own.
fn vendor_for(spec: &ProviderSpec) -> String {
  spec.name.to_string()
}

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[derive(Default)]
pub struct ByokManager {
  /// Keys read from the credential store, by provider (`None`: no key saved).
  keys: Mutex<HashMap<String, Option<String>>>,
  /// Why the last check of a provider's key failed.
  errors: Mutex<HashMap<String, String>>,
}

impl ByokManager {
  /// The saved key for a provider (read from the credential store once).
  fn key(&self, provider: &str) -> Option<String> {
    if let Some(cached) = self.keys.lock().unwrap().get(provider) {
      return cached.clone();
    }
    let key = match keychain::get(provider) {
      Ok(key) => key,
      Err(e) => {
        log::warn!("reading the {provider} key failed: {e}");
        self.errors.lock().unwrap().insert(provider.to_string(), e);
        None
      }
    };
    self.keys.lock().unwrap().insert(provider.to_string(), key.clone());
    key
  }

  fn provider_status(&self, spec: &ProviderSpec) -> ByokProviderStatus {
    let saved = store::byok_settings().providers.remove(spec.id).unwrap_or_default();
    ByokProviderStatus {
      id: spec.id.into(),
      name: spec.name.into(),
      description: spec.description.into(),
      key_url: spec.key_url.into(),
      key_prefix: spec.key_prefix.into(),
      has_key: self.key(spec.id).is_some(),
      models: saved.models,
      enabled: saved.enabled,
      checked_at: saved.checked_at,
      error: self.errors.lock().unwrap().get(spec.id).cloned(),
    }
  }

  /// Every provider, for Accounts → Model providers.
  pub fn status(&self) -> ByokStatus {
    ByokStatus {
      supported: keychain::supported(),
      store: keychain::store_name().into(),
      providers: catalog::PROVIDERS.iter().map(|spec| self.provider_status(spec)).collect(),
    }
  }

  fn spec(provider: &str) -> Result<&'static ProviderSpec, String> {
    catalog::find(provider).ok_or_else(|| format!("Fabricator doesn't support {provider} keys."))
  }

  /// Check `key` against the provider, then save it and the models it can use.
  pub async fn set_key(&self, provider: &str, key: &str, twins: &[CopilotTwin]) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    let key = key.trim();
    if key.is_empty() {
      return Err("Paste your API key.".into());
    }
    if key.chars().any(char::is_whitespace) {
      return Err("That doesn't look like an API key: it has spaces in it.".into());
    }
    let models = catalog::resolve(spec.id, list_models(spec, key).await?, twins);
    if models.is_empty() {
      return Err(format!("{} didn't list any models Fabricator can use with this key.", spec.name));
    }
    keychain::set(spec.id, key)?;
    self.keys.lock().unwrap().insert(spec.id.into(), Some(key.to_string()));
    let previous = store::byok_settings().providers.remove(spec.id).map(|p| p.enabled);
    let enabled = keep_enabled(previous, &models);
    store::set_byok_provider(spec.id, Some(ByokProviderSettings { models, enabled, checked_at: Some(now()) }));
    self.errors.lock().unwrap().remove(spec.id);
    Ok(self.provider_status(spec))
  }

  /// Check the saved key again and update the models it can use.
  pub async fn refresh(&self, provider: &str, twins: &[CopilotTwin]) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    let key = self.key(spec.id).ok_or_else(|| format!("Add your {} key first.", spec.name))?;
    let listed = match list_models(spec, &key).await {
      Ok(listed) => listed,
      Err(e) => {
        let e = e.replace("this key", "your saved key");
        self.errors.lock().unwrap().insert(spec.id.into(), e.clone());
        return Err(e);
      }
    };
    let models = catalog::resolve(spec.id, listed, twins);
    let previous = store::byok_settings().providers.remove(spec.id).map(|p| p.enabled);
    let enabled = keep_enabled(previous, &models);
    store::set_byok_provider(spec.id, Some(ByokProviderSettings { models, enabled, checked_at: Some(now()) }));
    self.errors.lock().unwrap().remove(spec.id);
    Ok(self.provider_status(spec))
  }

  /// Delete the saved key and forget the provider's models.
  pub fn remove_key(&self, provider: &str) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    keychain::delete(spec.id)?;
    self.keys.lock().unwrap().insert(spec.id.into(), None);
    store::set_byok_provider(spec.id, None);
    self.errors.lock().unwrap().remove(spec.id);
    Ok(self.provider_status(spec))
  }

  /// Choose which of a provider's models the model pickers show.
  pub fn set_models(&self, provider: &str, ids: &[String]) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    let mut saved = store::byok_settings()
      .providers
      .remove(spec.id)
      .ok_or_else(|| format!("Add your {} key first.", spec.name))?;
    saved.enabled = saved.models.iter().filter(|m| ids.contains(&m.id)).map(|m| m.id.clone()).collect();
    store::set_byok_provider(spec.id, Some(saved));
    Ok(self.provider_status(spec))
  }

  /// The registry every chat, Advisor and Design session gets when a provider
  /// has a key and a chosen model. A provider that needs the relay is reached
  /// through it (left out if it can't start).
  pub fn session_registry(&self) -> Option<ByokRegistry> {
    let settings = store::byok_settings();
    let keys: HashMap<String, String> = settings
      .providers
      .keys()
      .filter_map(|p| self.key(p).map(|k| (p.clone(), k)))
      .collect();
    let registry = registry::build_routed(&settings, &keys, |spec| {
      if !spec.relay {
        return Some(spec.base_url.to_string());
      }
      relay::base_url(spec).map_err(|e| log::error!("{} isn't reachable: {e}", spec.name)).ok()
    });
    (!registry.providers.is_empty()).then_some(registry)
  }

  /// Before a turn on a provider's model: make sure it can run. A turn must
  /// never quietly run on another model.
  pub fn ensure_ready(&self, selection: &str) -> Result<(), String> {
    let Some((spec, _)) = registry::parse_selection(selection) else {
      return Err(format!("{selection} isn't available anymore. Choose another model."));
    };
    let settings = store::byok_settings();
    let Some((_, info)) = registry::find_model(&settings, selection) else {
      return Err(format!(
        "That {} model isn't one of your models anymore. Turn it on in Accounts, or choose another model.",
        spec.name
      ));
    };
    if self.key(spec.id).is_none() {
      return Err(format!("Your {} API key isn't set up. Add it in Accounts, or choose another model.", spec.name));
    }
    if !settings.providers.get(spec.id).is_some_and(|p| p.enabled.contains(&info.id)) {
      return Err(format!(
        "{} isn't one of your {} models anymore. Turn it on in Accounts, or choose another model.",
        info.name, spec.name
      ));
    }
    if spec.relay {
      relay::base_url(spec).map_err(|e| {
        format!("Fabricator couldn't connect to {} on this computer: {e}. Restart Fabricator, or choose another model.", spec.name)
      })?;
    }
    Ok(())
  }

  /// The chosen models of every provider, for the model pickers.
  pub fn picker_models(&self) -> Vec<CopilotModel> {
    let settings = store::byok_settings();
    let mut out = Vec::new();
    for spec in catalog::PROVIDERS.iter() {
      let Some(saved) = settings.providers.get(spec.id) else {
        continue;
      };
      let ready = self.key(spec.id).is_some();
      for m in saved.models.iter().filter(|m| saved.enabled.contains(&m.id)) {
        out.push(CopilotModel {
          id: registry::selection_id(spec.id, &m.id),
          name: m.name.clone(),
          supported_reasoning_efforts: m.efforts.clone(),
          default_reasoning_effort: m.default_effort.clone(),
          category: None,
          price_category: None,
          vision: m.vision,
          vendor: Some(vendor_for(spec)),
          context_tiers: Vec::new(),
          byok: Some(ByokModelMeta {
            provider: spec.id.into(),
            provider_name: spec.name.into(),
            ready,
            note: (!ready).then(|| format!("Add your {} key in Accounts", spec.name)),
          }),
        });
      }
    }
    out
  }
}

/// The provider and model names a selection id names, to put errors plainly.
pub fn describe(selection: &str) -> Option<(String, String)> {
  let (spec, _) = registry::parse_selection(selection)?;
  let settings = store::byok_settings();
  let model = registry::find_model(&settings, selection)
    .map(|(_, m)| m.name.clone())
    .unwrap_or_else(|| "this model".into());
  Some((spec.name.to_string(), model))
}

/// A provider's error for a turn on `selection`, in plain language.
pub fn explain_for(selection: &str, raw: &str) -> Option<String> {
  let (provider, model) = describe(selection)?;
  explain(&provider, &model, raw)
}

/// The kind of provider failure a raw error message describes.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Failure {
  KeyRejected,
  OutOfCredit,
  TooLarge,
  RateLimited,
  Overloaded,
  ModelGone,
}

static STATUS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(401|402|403|404|413|429|503|529)\b").unwrap());

pub fn classify(raw: &str) -> Option<Failure> {
  let lower = raw.to_ascii_lowercase();
  let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
  let status = STATUS_RE.captures(&lower).map(|c| c[1].to_string());
  let status = status.as_deref();
  if has(&[
    "invalid x-api-key",
    "invalid_api_key",
    "incorrect api key",
    "invalid api key",
    "authentication_error",
    "api key not valid",
    "api_key_invalid",
    "pass a valid api key",
  ]) || status == Some("401")
  {
    return Some(Failure::KeyRejected);
  }
  if has(&[
    "credit balance",
    "credit_balance_exhausted",
    "insufficient_quota",
    "billing_error",
    "spend_limit",
    "spending limit",
    "spending-limit",
    "available credits",
    "out of credits",
    "usage_limit_exceeded",
    "usage limits",
  ]) || status == Some("402")
  {
    return Some(Failure::OutOfCredit);
  }
  // A request over a plan's per-minute token budget can come back as a 413 that
  // also says "rate_limit_exceeded", or as a 429 that mentions "tokens per
  // minute", so only an explicit "too large" (or 413) counts as one; the rest
  // wait it out.
  if has(&["request too large", "request_too_large"]) || status == Some("413") {
    return Some(Failure::TooLarge);
  }
  if has(&["rate limit", "rate_limit", "slow_down", "too many requests"]) || status == Some("429") {
    return Some(Failure::RateLimited);
  }
  if has(&["overloaded", "server_is_overloaded"]) || matches!(status, Some("503") | Some("529")) {
    return Some(Failure::Overloaded);
  }
  if has(&["model_not_found", "not_found_error", "does not exist", "model not found", "no longer available"])
    || status == Some("404")
  {
    return Some(Failure::ModelGone);
  }
  None
}

/// A failure that trying again won't fix.
pub fn is_permanent(raw: &str) -> bool {
  matches!(classify(raw), Some(Failure::KeyRejected | Failure::OutOfCredit | Failure::TooLarge | Failure::ModelGone))
}

/// A provider's error, in plain language.
pub fn explain(provider: &str, model: &str, raw: &str) -> Option<String> {
  Some(match classify(raw)? {
    Failure::KeyRejected => format!("{provider} didn't accept your API key. Replace it in Accounts, or choose another model."),
    Failure::OutOfCredit => format!(
      "Your {provider} account is out of credit or over its spending limit. Check your billing with {provider}, or choose another model."
    ),
    Failure::TooLarge => format!(
      "This request is bigger than your {provider} plan allows per minute. Fabricator's requests are large, so upgrade your {provider} plan, or choose another model."
    ),
    Failure::RateLimited => format!(
      "{provider} is limiting how often your key can be used. Wait a minute and try again, or choose another model."
    ),
    Failure::Overloaded => format!("{provider} is overloaded right now. Try again in a minute, or choose another model."),
    Failure::ModelGone => format!(
      "{provider} doesn't offer {model} to your key anymore. Check your models in Accounts, or choose another model."
    ),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn a_response_with_neither_reply_nor_tool_call_is_empty() {
    assert!(is_empty_response(&json!({ "content": "", "toolRequests": [] })));
    assert!(is_empty_response(&json!({ "content": "  \n" })));
    assert!(!is_empty_response(&json!({ "content": "", "toolRequests": [{ "name": "grep" }] })));
    assert!(!is_empty_response(&json!({ "content": "Done." })));
  }

  #[test]
  fn provider_errors_read_plainly() {
    let cases = [
      (r#"401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, Failure::KeyRejected),
      ("Incorrect API key provided: sk-proj-****. You can find your API key at …", Failure::KeyRejected),
      ("400 Your credit balance is too low to access the Anthropic API.", Failure::OutOfCredit),
      (r#"429 {"error":{"code":"credit_balance_exhausted"}}"#, Failure::OutOfCredit),
      (
        "429 Request too large for gpt-6.1-sol in organization org-1 on tokens per min (TPM): Limit 30000, Requested 52000.",
        Failure::TooLarge,
      ),
      (r#"429 {"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}"#, Failure::RateLimited),
      (
        "429 Rate limit reached for gpt-6.1-sol in organization org-1 on tokens per min (TPM): Limit 450000, Used 441000, Requested 18000. Please try again in 1.2s.",
        Failure::RateLimited,
      ),
      (
        r#"413 {"error":{"message":"Request too large for model `gpt-6.1-sol` on tokens per minute (TPM): Limit 8000, Requested 21650.","type":"tokens","code":"rate_limit_exceeded"}}"#,
        Failure::TooLarge,
      ),
      (r#"529 {"type":"overloaded_error"}"#, Failure::Overloaded),
      ("The model `gpt-9` does not exist or you do not have access to it.", Failure::ModelGone),
      // xAI and Google answer a bad key with a 400.
      (r#"400 {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}"#, Failure::KeyRejected),
      (r#"400 [{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]"#, Failure::KeyRejected),
      ("API key not valid. Please pass a valid API key.", Failure::KeyRejected),
      (
        r#"429 {"error":"Your team abc has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}"#,
        Failure::OutOfCredit,
      ),
      ("404 This model models/gemini-2.5-pro is no longer available to new users.", Failure::ModelGone),
    ];
    for (raw, want) in cases {
      assert_eq!(classify(raw), Some(want), "{raw}");
    }
    assert_eq!(classify("Session not found abc"), None);
    assert_eq!(classify("listening on port 4013"), None);
    // A request over the plan isn't retried; a per-minute limit is, after a pause.
    assert!(is_permanent(cases[4].0) && is_permanent(cases[7].0) && is_permanent(cases[13].0));
    assert!(!is_permanent(cases[5].0) && !is_permanent(cases[6].0));
    assert_eq!(
      explain("OpenAI", "GPT-6.1 Sol", cases[4].0).unwrap(),
      "This request is bigger than your OpenAI plan allows per minute. Fabricator's requests are large, so upgrade your OpenAI plan, or choose another model."
    );
  }

  #[test]
  fn chosen_models_survive_a_new_key_when_the_provider_still_lists_them() {
    let m = |id: &str, recommended| ByokModelInfo { id: id.into(), recommended, ..Default::default() };
    let models = [m("a", false), m("b", true), m("c", true)];
    assert_eq!(keep_enabled(Some(vec!["a".into(), "gone".into()]), &models), ["a"]);
    assert_eq!(keep_enabled(Some(vec!["gone".into()]), &models), ["b", "c"]);
    assert_eq!(keep_enabled(None, &models), ["b", "c"]);
  }

  #[test]
  fn error_replies_give_their_text_in_either_shape() {
    assert_eq!(error_detail(&json!({ "error": { "message": " Bad key " } })), "Bad key");
    assert_eq!(error_detail(&json!({ "code": "invalid-argument", "error": "Incorrect API key provided." })), "Incorrect API key provided.");
    assert_eq!(error_detail(&json!({ "message": "Nope" })), "Nope");
    assert_eq!(error_detail(&Value::Null), "");
  }
}
