//! Your own API keys: models from Anthropic, OpenAI, xAI, Google and
//! OpenRouter on the user's own keys, and from Ollama or any OpenAI-compatible
//! server they run, next to Copilot's in Build chat, the Advisor and Design.
//!
//! - [`keychain`](crate::services::keychain) keeps keys in the OS credential
//!   store (never in settings).
//! - [`catalog`] knows each provider and turns its model list into models a
//!   Copilot session can use; settings keep that list, the user's choices, and
//!   where a server they run is.
//! - [`registry`] hands the chosen models to sessions as BYOK providers.
//! - [`relay`] passes OpenAI-compatible providers' traffic through a local relay
//!   that adapts requests (and Google's replies) to what each API takes.
//!
//! The Copilot engine runs the agent loop and calls the provider directly
//! (through the relay), so a session on one of these models needs no Copilot
//! sign-in.

pub mod catalog;
pub mod registry;
pub mod relay;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use self::catalog::{Auth, CopilotTwin, Endpoint, KeyNeed, Listed, ProviderSpec};
use self::registry::ByokRegistry;
use crate::services::keychain;
use crate::services::store;
use crate::types::{ByokModelInfo, ByokModelMeta, ByokProviderSettings, ByokProviderStatus, ByokStatus, CopilotModel};

/// Sent to a model whose response was empty: no reply and no tool call. A model
/// can end a response that way (gpt-oss when it garbles a tool call, Claude now
/// and then after a tool result), and the Copilot runtime takes it as the end of
/// the turn, so the turn would stop without a word.
pub const CONTINUE_PROMPT: &str = "[Fabricator: your last response was empty, with no reply and no tool call, so nothing happened. Continue from where you stopped. If you meant to call a tool, call it again. If you're finished, give your final answer.]";
/// How many times one turn asks a model to continue before giving up.
pub const MAX_CONTINUES: u32 = 2;

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

/// Why a provider couldn't be reached: a cloud API's connection, or for a
/// server people run, that it isn't running at the address they gave.
fn unreachable(spec: &ProviderSpec, url: &str, timeout: bool) -> String {
  match spec.endpoint {
    Endpoint::Local => t!("services.byok.ollamaUnreachable", url = relay::origin_of(url)),
    Endpoint::Custom => t!("services.byok.serverUnreachable", url = relay::origin_of(url)),
    Endpoint::Fixed if timeout => t!("services.byok.noAnswer", name = spec.display_name()),
    Endpoint::Fixed => t!("services.byok.unreachable", name = spec.display_name()),
  }
}

/// GET one of a provider's model lists with `key`, the user's saved key when
/// `saved` (with none, for a server that takes none).
async fn get_list(spec: &ProviderSpec, url: &str, key: Option<&str>, saved: bool) -> Result<Value, String> {
  let mut request = HTTP.get(url);
  if let Some(key) = key {
    request = match spec.auth {
      Auth::Anthropic => request.header("x-api-key", key).header("anthropic-version", "2023-06-01"),
      Auth::Bearer => request.bearer_auth(key),
      Auth::Google => request.header("x-goog-api-key", key),
    };
  }
  let response = request.send().await.map_err(|e| {
    log::warn!("listing {} models failed: {e}", spec.name);
    unreachable(spec, url, e.is_timeout())
  })?;
  let status = response.status();
  let body: Value = response.json().await.unwrap_or(Value::Null);
  let detail = error_detail(&body);
  // xAI and Google turn a bad key down with a 400, not a 401.
  if status.as_u16() == 401 || (!status.is_success() && classify(&detail) == Some(Failure::KeyRejected)) {
    return Err(if key.is_none() {
      t!("services.byok.serverNeedsKey")
    } else if saved {
      t!("services.byok.savedKeyRefused", name = spec.display_name())
    } else {
      t!("services.byok.keyRefused", name = spec.display_name())
    });
  }
  if !status.is_success() {
    return Err(t!("services.byok.listFailed", name = spec.display_name(), status = status.as_u16(), detail = detail).trim().to_string());
  }
  Ok(body)
}

/// List the models a provider offers at `base` with `key`, which also checks
/// the key (the saved one when `saved`).
async fn list_models(spec: &ProviderSpec, base: &str, key: Option<&str>, saved: bool) -> Result<Vec<Listed>, String> {
  if spec.id == "ollama" {
    return list_ollama(spec, base).await;
  }
  // OpenRouter lists its models to anyone, so the key is checked on its own.
  if let Some(url) = spec.key_check_url {
    get_list(spec, url, key, saved).await?;
  }
  let url = if spec.models_url.starts_with('/') {
    format!("{}{}", base.trim_end_matches('/'), spec.models_url)
  } else {
    spec.models_url.to_string()
  };
  let mut listed = catalog::parse_models(spec.id, &get_list(spec, &url, key, saved).await?);
  if let Some(url) = spec.details_url {
    match get_list(spec, url, key, saved).await {
      Ok(details) => catalog::fill_in(&mut listed, catalog::parse_models(spec.id, &details)),
      Err(e) => log::warn!("listing {} model details failed: {e}", spec.name),
    }
  }
  Ok(listed)
}

/// Ollama's own API, beside its OpenAI-compatible one: `http://localhost:11434`
/// for `http://localhost:11434/v1`.
fn ollama_root(base: &str) -> &str {
  let base = base.trim_end_matches('/');
  base.strip_suffix("/v1").unwrap_or(base)
}

/// The models pulled into Ollama, with what `/api/show` says each one can do.
async fn list_ollama(spec: &ProviderSpec, base: &str) -> Result<Vec<Listed>, String> {
  let root = ollama_root(base);
  let tags = get_list(spec, &format!("{root}{}", spec.models_url), None, false).await?;
  let entries = tags.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
  let shows = futures::future::join_all(entries.iter().map(|tag| async move {
    let name = tag.get("name").or_else(|| tag.get("model")).and_then(Value::as_str)?;
    let reply = HTTP
      .post(format!("{root}/api/show"))
      .json(&serde_json::json!({ "model": name }))
      .send()
      .await
      .map_err(|e| log::warn!("Ollama couldn't describe {name}: {e}"))
      .ok()?;
    reply.json::<Value>().await.ok()
  }))
  .await;
  Ok(
    entries
      .iter()
      .zip(shows)
      .filter_map(|(tag, show)| catalog::parse_ollama(tag, &show.unwrap_or(Value::Null)))
      .collect(),
  )
}

/// The address people gave for a server, tidied: `http://` when they left the
/// scheme out, no trailing slash, and for Ollama, its OpenAI-compatible API
/// under `/v1`.
fn server_url(spec: &ProviderSpec, url: &str) -> Result<String, String> {
  let url = url.trim();
  let url = if url.contains("://") { url.to_string() } else { format!("http://{url}") };
  let valid = reqwest::Url::parse(&url)
    .is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some_and(|h| !h.is_empty()));
  if !valid {
    return Err(t!("services.byok.badServerUrl"));
  }
  let url = url.trim_end_matches('/');
  Ok(if spec.id == "ollama" && !url.ends_with("/v1") { format!("{url}/v1") } else { url.to_string() })
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

/// Who makes a model, for its logo in the picker: each provider's models are
/// its own, but OpenRouter's come from many makers, named in their ids
/// (`anthropic/claude-sonnet-5.5`).
fn vendor_for(spec: &ProviderSpec, model: &str) -> String {
  if spec.id != "openrouter" {
    return spec.name.to_string();
  }
  match model.split('/').next().unwrap_or_default() {
    "anthropic" => "Anthropic",
    "openai" => "OpenAI",
    "google" => "Google",
    "x-ai" => "xAI",
    "meta-llama" => "Meta",
    "microsoft" => "Microsoft",
    _ => spec.name,
  }
  .to_string()
}

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Keys read from the credential store, by provider (`None`: no key saved).
/// Shared by every [`ByokManager`], so the Copilot engine's own handle sees a
/// key the moment Accounts saves it.
static KEYS: Lazy<Mutex<HashMap<String, Option<String>>>> = Lazy::new(Default::default);
/// Why the last check of a provider's key failed.
static ERRORS: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(Default::default);

/// Your own API keys and servers. A handle: what it knows is shared (see
/// [`KEYS`]), so any part of the core can make one.
#[derive(Default)]
pub struct ByokManager;

impl ByokManager {
  /// The saved key for a provider (read from the credential store once); never
  /// one for a provider that takes none.
  fn key(&self, provider: &str) -> Option<String> {
    if catalog::find(provider).is_some_and(|spec| spec.key == KeyNeed::Unused) {
      return None;
    }
    if let Some(cached) = KEYS.lock().unwrap().get(provider) {
      return cached.clone();
    }
    let key = match keychain::get(provider) {
      Ok(key) => key,
      Err(e) => {
        log::warn!("reading the {provider} key failed: {e}");
        ERRORS.lock().unwrap().insert(provider.to_string(), e);
        None
      }
    };
    KEYS.lock().unwrap().insert(provider.to_string(), key.clone());
    key
  }

  fn provider_status(&self, spec: &ProviderSpec) -> ByokProviderStatus {
    let saved = store::byok_settings().providers.remove(spec.id);
    let has_key = self.key(spec.id).is_some();
    // A server people run is set up once Fabricator has reached it.
    let connected = if spec.endpoint == Endpoint::Fixed { has_key } else { saved.is_some() };
    let saved = saved.unwrap_or_default();
    ByokProviderStatus {
      id: spec.id.into(),
      name: spec.display_name(),
      description: (spec.description)(),
      key_url: spec.key_url.into(),
      key_prefix: spec.key_prefix.into(),
      endpoint: spec.endpoint.as_str().into(),
      key_need: spec.key.as_str().into(),
      has_key,
      connected,
      base_url: saved.base_url,
      default_base_url: (spec.endpoint == Endpoint::Local).then(|| spec.base_url.to_string()),
      models: saved.models,
      enabled: saved.enabled,
      checked_at: saved.checked_at,
      error: ERRORS.lock().unwrap().get(spec.id).cloned(),
    }
  }

  /// Every provider, for Accounts → Model providers.
  pub fn status(&self) -> ByokStatus {
    ByokStatus {
      supported: keychain::supported(),
      store: keychain::store_name().into(),
      providers: catalog::PROVIDERS.iter().map(|spec| self.provider_status(spec)).collect(),
      own_models: self.has_ready_model(),
    }
  }

  fn spec(provider: &str) -> Result<&'static ProviderSpec, String> {
    catalog::find(provider).ok_or_else(|| t!("services.byok.unsupportedProvider", provider = provider))
  }

  /// Check `key` against a provider at a fixed address, then save it and the
  /// models it can use.
  pub async fn set_key(&self, provider: &str, key: &str, twins: &[CopilotTwin]) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    if spec.endpoint != Endpoint::Fixed {
      return Err(t!("services.byok.unsupportedProvider", provider = provider));
    }
    let key = key.trim();
    if key.is_empty() {
      return Err(t!("services.byok.pasteKey"));
    }
    if key.chars().any(char::is_whitespace) {
      return Err(t!("services.byok.keyHasSpaces"));
    }
    let models = catalog::resolve(spec.id, list_models(spec, spec.base_url, Some(key), false).await?, twins);
    if models.is_empty() {
      return Err(t!("services.byok.noModels", name = spec.display_name()));
    }
    keychain::set(spec.id, key)?;
    KEYS.lock().unwrap().insert(spec.id.into(), Some(key.to_string()));
    self.save(spec, models, None);
    Ok(self.provider_status(spec))
  }

  /// Reach a server people run (Ollama, an OpenAI-compatible server) at `url`,
  /// with `key` when it wants one, then save it and the models it offers.
  pub async fn connect(
    &self,
    provider: &str,
    url: &str,
    key: Option<&str>,
    twins: &[CopilotTwin],
  ) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    if spec.endpoint == Endpoint::Fixed {
      return Err(t!("services.byok.unsupportedProvider", provider = provider));
    }
    let base = server_url(spec, url)?;
    let key = key.map(str::trim).filter(|k| !k.is_empty() && spec.key != KeyNeed::Unused);
    if key.is_some_and(|k| k.chars().any(char::is_whitespace)) {
      return Err(t!("services.byok.keyHasSpaces"));
    }
    // Servers differ on whether their OpenAI-compatible API is under /v1
    // (LM Studio's and vLLM's are), so try there when the address people gave
    // doesn't list any models.
    let (base, listed) = match list_models(spec, &base, key, false).await {
      Ok(listed) if !listed.is_empty() => (base, listed),
      first if spec.endpoint == Endpoint::Custom && !base.ends_with("/v1") => {
        let under_v1 = format!("{base}/v1");
        match list_models(spec, &under_v1, key, false).await {
          Ok(listed) if !listed.is_empty() => (under_v1, listed),
          _ => (base, first?),
        }
      }
      other => (base, other?),
    };
    let models = catalog::resolve(spec.id, listed, twins);
    if models.is_empty() {
      return Err(if spec.id == "ollama" {
        t!("services.byok.noOllamaModels")
      } else {
        t!("services.byok.noServerModels")
      });
    }
    if spec.key == KeyNeed::Optional {
      match key {
        Some(key) => keychain::set(spec.id, key)?,
        None => keychain::delete(spec.id)?,
      }
      KEYS.lock().unwrap().insert(spec.id.into(), key.map(str::to_string));
    }
    self.save(spec, models, Some(base));
    Ok(self.provider_status(spec))
  }

  /// Save a provider's models, keeping the ones the user had chosen that it
  /// still offers (else its suggestions), and where it is.
  fn save(&self, spec: &ProviderSpec, models: Vec<ByokModelInfo>, base_url: Option<String>) {
    let previous = store::byok_settings().providers.remove(spec.id).map(|p| p.enabled);
    let enabled = keep_enabled(previous, &models);
    store::set_byok_provider(spec.id, Some(ByokProviderSettings { models, enabled, checked_at: Some(now()), base_url }));
    ERRORS.lock().unwrap().remove(spec.id);
  }

  /// Check the provider again with the saved key (or at the saved address) and
  /// update the models it offers.
  pub async fn refresh(&self, provider: &str, twins: &[CopilotTwin]) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    let saved = store::byok_settings().providers.remove(spec.id);
    let key = self.key(spec.id);
    if spec.endpoint != Endpoint::Fixed && saved.is_none() {
      return Err(t!("services.byok.connectFirst", name = spec.display_name()));
    }
    if !spec.usable(key.is_some()) {
      return Err(t!("services.byok.addKeyFirst", name = spec.display_name()));
    }
    let saved_url = saved.and_then(|p| p.base_url);
    let base = spec
      .base_url_with(saved_url.as_deref())
      .ok_or_else(|| t!("services.byok.connectFirst", name = spec.display_name()))?;
    let listed = match list_models(spec, &base, key.as_deref(), true).await {
      Ok(listed) => listed,
      Err(e) => {
        ERRORS.lock().unwrap().insert(spec.id.into(), e.clone());
        return Err(e);
      }
    };
    self.save(spec, catalog::resolve(spec.id, listed, twins), saved_url);
    Ok(self.provider_status(spec))
  }

  /// Delete the saved key (for a server people run, forget it) and the
  /// provider's models.
  pub fn remove_key(&self, provider: &str) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    if spec.key != KeyNeed::Unused {
      keychain::delete(spec.id)?;
      KEYS.lock().unwrap().insert(spec.id.into(), None);
    }
    store::set_byok_provider(spec.id, None);
    ERRORS.lock().unwrap().remove(spec.id);
    Ok(self.provider_status(spec))
  }

  /// Choose which of a provider's models the model pickers show.
  pub fn set_models(&self, provider: &str, ids: &[String]) -> Result<ByokProviderStatus, String> {
    let spec = Self::spec(provider)?;
    let mut saved = store::byok_settings()
      .providers
      .remove(spec.id)
      .ok_or_else(|| t!("services.byok.addKeyFirst", name = spec.display_name()))?;
    saved.enabled = saved.models.iter().filter(|m| ids.contains(&m.id)).map(|m| m.id.clone()).collect();
    store::set_byok_provider(spec.id, Some(saved));
    Ok(self.provider_status(spec))
  }

  /// The registry every chat, Advisor and Design session gets when a provider
  /// can be used and has a chosen model. A provider that needs the relay is
  /// reached through it (left out if it can't start).
  pub fn session_registry(&self) -> Option<ByokRegistry> {
    let settings = store::byok_settings();
    let keys: HashMap<String, String> = settings
      .providers
      .keys()
      .filter_map(|p| self.key(p).map(|k| (p.clone(), k)))
      .collect();
    let registry = registry::build_routed(&settings, &keys, |spec, base| {
      if !spec.relay {
        return Some(base.to_string());
      }
      relay::base_url(spec, base).map_err(|e| log::error!("{} isn't reachable: {e}", spec.name)).ok()
    });
    (!registry.providers.is_empty()).then_some(registry)
  }

  /// Before a turn on a provider's model: make sure it can run. A turn must
  /// never quietly run on another model.
  pub fn ensure_ready(&self, selection: &str) -> Result<(), String> {
    let Some((spec, _)) = registry::parse_selection(selection) else {
      return Err(t!("services.byok.selectionGone", selection = selection));
    };
    let settings = store::byok_settings();
    let Some((_, info)) = registry::find_model(&settings, selection) else {
      return Err(t!("services.byok.modelGone", name = spec.display_name()));
    };
    if !spec.usable(self.key(spec.id).is_some()) {
      return Err(t!("services.byok.keyMissing", name = spec.display_name()));
    }
    let saved = settings.providers.get(spec.id);
    if !saved.is_some_and(|p| p.enabled.contains(&info.id)) {
      return Err(t!("services.byok.modelOff", model = info.name, name = spec.display_name()));
    }
    let base = spec
      .base_url_with(saved.and_then(|p| p.base_url.as_deref()))
      .ok_or_else(|| t!("services.byok.connectFirst", name = spec.display_name()))?;
    if spec.relay {
      relay::base_url(spec, &base).map_err(|e| t!("services.byok.relayFailed", name = spec.display_name(), error = e))?;
    }
    Ok(())
  }

  /// Whether any provider's model can run a session: Fabricator can be used
  /// without a GitHub Copilot sign-in then.
  pub fn has_ready_model(&self) -> bool {
    self.picker_models().iter().any(|m| m.byok.as_ref().is_some_and(|b| b.ready))
  }

  /// The model a session meant for Copilot runs on when Copilot isn't signed
  /// in: Chat defaults' model when it's one of the user's own that can run,
  /// else the first of their models that can, in the order the pickers list them.
  pub fn default_own_model(&self) -> Option<String> {
    let ready: Vec<String> = self
      .picker_models()
      .into_iter()
      .filter(|m| m.byok.as_ref().is_some_and(|b| b.ready))
      .map(|m| m.id)
      .collect();
    let preferred = store::get_settings().chat_defaults.and_then(|d| d.model).filter(|m| ready.contains(m));
    preferred.or_else(|| ready.into_iter().next()).filter(|m| self.ensure_ready(m).is_ok())
  }

  /// The chosen models of every provider, for the model pickers.
  pub fn picker_models(&self) -> Vec<CopilotModel> {
    let settings = store::byok_settings();
    let mut out = Vec::new();
    for spec in catalog::PROVIDERS.iter() {
      let Some(saved) = settings.providers.get(spec.id) else {
        continue;
      };
      let ready = spec.usable(self.key(spec.id).is_some()) && spec.base_url_with(saved.base_url.as_deref()).is_some();
      for m in saved.models.iter().filter(|m| saved.enabled.contains(&m.id)) {
        out.push(CopilotModel {
          id: registry::selection_id(spec.id, &m.id),
          name: m.name.clone(),
          supported_reasoning_efforts: m.efforts.clone(),
          default_reasoning_effort: m.default_effort.clone(),
          category: None,
          price_category: None,
          vision: m.vision,
          vendor: Some(vendor_for(spec, &m.id)),
          context_tiers: Vec::new(),
          byok: Some(ByokModelMeta {
            provider: spec.id.into(),
            provider_name: spec.display_name(),
            ready,
            note: (!ready).then(|| t!("services.byok.addKeyInAccounts", name = spec.display_name())),
            stand_in: false,
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
    .unwrap_or_else(|| t!("services.byok.thisModel"));
  Some((spec.display_name(), model))
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
  /// Nothing answered: a server people run (Ollama) isn't running, or the
  /// relay couldn't connect.
  Unreachable,
  /// The conversation needs more context than a server people run (Ollama)
  /// gives the model: the relay turned the request down, or Ollama dropped
  /// the start of it, the user's request with it.
  ContextTooShort,
}

static STATUS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(401|402|403|404|413|429|503|529)\b").unwrap());

pub fn classify(raw: &str) -> Option<Failure> {
  let lower = raw.to_ascii_lowercase();
  let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
  // First, as the relay's reply names the model, which might look like a status.
  if raw.contains(relay::CONTEXT_TOO_SHORT) || has(&["no user query found in messages"]) {
    return Some(Failure::ContextTooShort);
  }
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
  // The relay's own reply when it can't connect (see `relay::forward`).
  if has(&["couldn't reach", "connection refused", "actively refused"]) {
    return Some(Failure::Unreachable);
  }
  None
}

/// A failure that trying again won't fix.
pub fn is_permanent(raw: &str) -> bool {
  matches!(
    classify(raw),
    Some(Failure::KeyRejected | Failure::OutOfCredit | Failure::TooLarge | Failure::ModelGone | Failure::ContextTooShort)
  )
}

/// The context the relay turned a request down for, in Ollama's units (`32k`).
fn short_context(raw: &str) -> Option<String> {
  let after = &raw[raw.find(relay::CONTEXT_TOO_SHORT)? + relay::CONTEXT_TOO_SHORT.len()..];
  let tokens: u32 = after.trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
  Some(if tokens < 1024 { tokens.to_string() } else { format!("{}k", tokens / 1024) })
}

/// A provider's error, in plain language.
pub fn explain(provider: &str, model: &str, raw: &str) -> Option<String> {
  Some(match classify(raw)? {
    Failure::KeyRejected => t!("services.byok.failure.keyRejected", provider = provider),
    Failure::OutOfCredit => t!("services.byok.failure.outOfCredit", provider = provider),
    Failure::TooLarge => t!("services.byok.failure.tooLarge", provider = provider),
    Failure::RateLimited => t!("services.byok.failure.rateLimited", provider = provider),
    Failure::Overloaded => t!("services.byok.failure.overloaded", provider = provider),
    Failure::ModelGone => t!("services.byok.failure.modelGone", provider = provider, model = model),
    Failure::Unreachable => t!("services.byok.failure.unreachable", provider = provider),
    Failure::ContextTooShort => match short_context(raw) {
      Some(context) => t!("services.byok.failure.contextTooShort", provider = provider, model = model, context = context),
      None => t!("services.byok.failure.contextOutgrown", provider = provider, model = model),
    },
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
    // Ollama not running: the relay couldn't connect. Worth retrying once it's started.
    assert_eq!(classify("502 Couldn't reach Ollama (error sending request for url (http://localhost:11434/v1/chat/completions))."), Some(Failure::Unreachable));
    assert!(!is_permanent("Couldn't reach Ollama (connection refused)."));
    // A request over the plan isn't retried; a per-minute limit is, after a pause.
    assert!(is_permanent(cases[4].0) && is_permanent(cases[7].0) && is_permanent(cases[13].0));
    assert!(!is_permanent(cases[5].0) && !is_permanent(cases[6].0));
    assert_eq!(
      explain("OpenAI", "GPT-6.1 Sol", cases[4].0).unwrap(),
      "This request is bigger than your OpenAI plan allows per minute. Fabricator's requests are large, so upgrade your OpenAI plan, or choose another model."
    );
  }

  #[test]
  fn a_context_too_short_for_the_conversation_reads_plainly() {
    // The relay turned the request down. Its reply names the model, which mustn't read as a status.
    let turned_down = format!("400 {}", relay::too_short("llama-404:latest", 32_768, 64_000));
    assert_eq!(classify(&turned_down), Some(Failure::ContextTooShort));
    assert!(is_permanent(&turned_down));
    assert_eq!(
      explain("Ollama", "llama-404:latest", &turned_down).unwrap(),
      "Ollama runs llama-404:latest with a context length of 32k, which is too short for Fabricator. In Ollama's settings, set Context length to 64k or more, then try again, or choose another model."
    );
    // Ollama dropped the start of a conversation too long for it, the user's request with it.
    let dropped = "Failed to get response from the AI model; retried 5 times (total retry wait time: 17.43 seconds) Last error: 500 no user query found in messages";
    assert_eq!(classify(dropped), Some(Failure::ContextTooShort));
    assert_eq!(
      explain("Ollama", "qwen3.8:latest", dropped).unwrap(),
      "This conversation got longer than the context length Ollama gives qwen3.8:latest. In Ollama's settings, set Context length to 64k or more, then try again, or choose another model."
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

  #[test]
  fn server_addresses_are_tidied_or_turned_down() {
    let ollama = catalog::find("ollama").unwrap();
    let custom = catalog::find("custom").unwrap();
    assert_eq!(server_url(ollama, " localhost:11434/ ").unwrap(), "http://localhost:11434/v1");
    assert_eq!(server_url(ollama, "http://studio.local:11434/v1").unwrap(), "http://studio.local:11434/v1");
    assert_eq!(server_url(custom, "https://llm.contoso.com/v1/").unwrap(), "https://llm.contoso.com/v1");
    assert_eq!(server_url(custom, "http://localhost:1234").unwrap(), "http://localhost:1234");
    for bad in ["", "ftp://files.contoso.com", "http://", "not a url"] {
      assert!(server_url(custom, bad).is_err(), "{bad:?}");
    }
    assert_eq!(ollama_root("http://localhost:11434/v1"), "http://localhost:11434");
    assert_eq!(ollama_root("https://gpu.contoso.com/ollama/v1/"), "https://gpu.contoso.com/ollama");
  }

  #[test]
  fn openrouter_models_show_their_makers_logo() {
    let openrouter = catalog::find("openrouter").unwrap();
    assert_eq!(vendor_for(openrouter, "anthropic/claude-sonnet-5.5"), "Anthropic");
    assert_eq!(vendor_for(openrouter, "x-ai/grok-code-fast-1"), "xAI");
    assert_eq!(vendor_for(openrouter, "qwen/qwen3-coder"), "OpenRouter");
    assert_eq!(vendor_for(catalog::find("ollama").unwrap(), "llama3.2"), "Ollama");
  }
}
