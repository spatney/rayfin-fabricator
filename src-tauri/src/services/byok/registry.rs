//! The registry Copilot sessions get for Your own API keys: each provider with
//! a saved key, and the models the user chose, as the
//! SDK's named `providers` and `models`. They sit alongside Copilot's own
//! models, so a conversation can switch between them with `set_model`.
//!
//! The runtime doesn't persist the registry: a session resumed without it
//! silently runs a provider selection on a Copilot model. So it is handed to
//! every create and resume; [`ByokRegistry::revision`] tells the session cache
//! when it changed (a key replaced, a model added).

use std::collections::HashMap;

use github_copilot_sdk::rpc::{
  AdaptiveThinkingSupport, ModelCapabilitiesOverride, ModelCapabilitiesOverrideLimits,
  ModelCapabilitiesOverrideSupports,
};
use github_copilot_sdk::{NamedProviderConfig, ProviderModelConfig};
use sha2::{Digest, Sha256};

use super::catalog::{self, ProviderSpec};
use crate::types::{ByokModelInfo, ByokSettings};

/// Output budget per reply: whole files travel in edit tool calls.
const MAX_OUTPUT_TOKENS: u32 = 32_768;

#[derive(Clone)]
pub struct ByokRegistry {
  pub providers: Vec<NamedProviderConfig>,
  pub models: Vec<ProviderModelConfig>,
  /// Changes whenever anything a session would see changes, keys included.
  pub revision: String,
}

/// Never print the providers: the SDK's `Debug` for them shows the API key.
impl std::fmt::Debug for ByokRegistry {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ByokRegistry")
      .field("providers", &self.providers.iter().map(|p| p.name.as_str()).collect::<Vec<_>>())
      .field("models", &self.models.iter().map(|m| format!("{}/{}", m.provider, m.id)).collect::<Vec<_>>())
      .field("revision", &self.revision)
      .finish()
  }
}

/// A model id safe inside a `provider/id` selection id (a provider's ids may
/// contain `/` or spaces, like OpenAI's fine-tuned models).
pub fn registry_model_id(model: &str) -> String {
  model
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':') { c } else { '-' })
    .collect()
}

/// The id chat, the Advisor and Design select a model by, e.g. `google/gemini-3.8-flash`.
pub fn selection_id(provider: &str, model: &str) -> String {
  format!("{provider}/{}", registry_model_id(model))
}

/// The provider a selection id names, and the model's registry id.
pub fn parse_selection(selection: &str) -> Option<(&'static ProviderSpec, &str)> {
  let (provider, model) = selection.split_once('/')?;
  let spec = catalog::find(provider)?;
  (!model.is_empty()).then_some((spec, model))
}

/// The provider and model a selection id names, if the model is one the user saved.
pub fn find_model<'a>(settings: &'a ByokSettings, selection: &str) -> Option<(&'static ProviderSpec, &'a ByokModelInfo)> {
  let (spec, model) = parse_selection(selection)?;
  let saved = settings.providers.get(spec.id)?;
  let info = saved.models.iter().find(|m| registry_model_id(&m.id) == model)?;
  Some((spec, info))
}

/// Split a context window into prompt and output budgets. The runtime compacts
/// the conversation before a request would exceed the prompt budget.
pub fn token_limits(m: &ByokModelInfo) -> (u32, u32, u32) {
  let context = m.context_window.max(8_192);
  let output = MAX_OUTPUT_TOKENS.min(m.max_output.max(1_024)).min(context / 4);
  let prompt = m.max_prompt.unwrap_or(u32::MAX).min(context - output);
  (context, prompt, output)
}

fn capabilities(m: &ByokModelInfo) -> ModelCapabilitiesOverride {
  let (context, prompt, output) = token_limits(m);
  let mut limits = ModelCapabilitiesOverrideLimits::default();
  limits.max_context_window_tokens = Some(i64::from(context));
  limits.max_prompt_tokens = Some(i64::from(prompt));
  limits.max_output_tokens = Some(i64::from(output));
  let mut supports = ModelCapabilitiesOverrideSupports::default();
  supports.tool_calls = Some(true);
  supports.vision = Some(m.vision);
  supports.reasoning_effort = Some(!m.efforts.is_empty());
  supports.adaptive_thinking = m
    .adaptive_thinking
    .as_ref()
    .and_then(|a| serde_json::from_value::<AdaptiveThinkingSupport>(serde_json::Value::String(a.clone())).ok())
    .filter(|a| *a != AdaptiveThinkingSupport::Unknown);
  let mut caps = ModelCapabilitiesOverride::default();
  caps.limits = Some(limits);
  caps.supports = Some(supports);
  caps
}

fn model_config(spec: &ProviderSpec, m: &ByokModelInfo) -> ProviderModelConfig {
  let (context, prompt, output) = token_limits(m);
  let mut config = ProviderModelConfig::new(registry_model_id(&m.id), spec.id)
    .with_wire_model(m.id.clone())
    .with_name(format!("{} (your {} key)", m.name, spec.name))
    .with_max_context_window_tokens(i64::from(context))
    .with_max_prompt_tokens(i64::from(prompt))
    .with_max_output_tokens(i64::from(output))
    .with_capabilities(capabilities(m));
  if let Some(copilot_id) = &m.copilot_id {
    config = config.with_model_id(copilot_id.clone());
  }
  config
}

fn provider_config(spec: &ProviderSpec, base_url: String, key: &str) -> NamedProviderConfig {
  let mut config = NamedProviderConfig::new(spec.id, base_url)
    .with_provider_type(spec.kind)
    .with_api_key(key);
  if let Some(wire) = spec.wire_api {
    config = config.with_wire_api(wire);
  }
  if let Some(tag) = spec.telemetry {
    config = config.with_model_provider(tag);
  }
  config
}

/// The registry for the providers that have a key and at least one chosen model,
/// each at its own URL.
#[cfg(test)]
pub fn build(settings: &ByokSettings, keys: &HashMap<String, String>) -> ByokRegistry {
  build_routed(settings, keys, |spec| Some(spec.base_url.to_string()))
}

/// [`build`], reaching each provider at the URL `route` gives (its own, or the
/// relay's); a provider it gives none for is left out.
pub fn build_routed(
  settings: &ByokSettings,
  keys: &HashMap<String, String>,
  route: impl Fn(&ProviderSpec) -> Option<String>,
) -> ByokRegistry {
  let mut providers = Vec::new();
  let mut models = Vec::new();
  for spec in catalog::PROVIDERS.iter() {
    let (Some(key), Some(saved)) = (keys.get(spec.id), settings.providers.get(spec.id)) else {
      continue;
    };
    let chosen: Vec<&ByokModelInfo> = saved.models.iter().filter(|m| saved.enabled.contains(&m.id)).collect();
    let Some(base_url) = route(spec).filter(|_| !chosen.is_empty()) else {
      continue;
    };
    providers.push(provider_config(spec, base_url, key));
    models.extend(chosen.into_iter().map(|m| model_config(spec, m)));
  }
  let mut hasher = Sha256::new();
  hasher.update(serde_json::to_vec(&(&providers, &models)).unwrap_or_default());
  let revision = hex::encode(&hasher.finalize()[..8]);
  ByokRegistry { providers, models, revision }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::ByokProviderSettings;

  fn model(id: &str) -> ByokModelInfo {
    ByokModelInfo {
      id: id.into(),
      name: id.into(),
      context_window: 131_072,
      max_output: 65_536,
      efforts: vec!["low".into(), "high".into()],
      ..Default::default()
    }
  }

  fn settings() -> ByokSettings {
    let mut s = ByokSettings::default();
    s.providers.insert(
      "google".into(),
      ByokProviderSettings {
        models: vec![model("gemini-3.8-flash"), model("gemma-4-31b-it")],
        enabled: vec!["gemini-3.8-flash".into()],
        checked_at: None,
      },
    );
    let mut opus = model("claude-opus-5-5");
    opus.name = "Claude Opus 5.5".into();
    opus.copilot_id = Some("claude-opus-5.5".into());
    opus.adaptive_thinking = Some("required".into());
    opus.context_window = 1_000_000;
    opus.max_output = 128_000;
    s.providers.insert(
      "anthropic".into(),
      ByokProviderSettings { models: vec![opus], enabled: vec!["claude-opus-5-5".into()], checked_at: None },
    );
    s
  }

  fn keys(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(p, k)| (p.to_string(), k.to_string())).collect()
  }

  #[test]
  fn providers_with_a_key_register_their_chosen_models() {
    let reg = build(&settings(), &keys(&[("google", "AIza-test"), ("anthropic", "sk-ant-test")]));
    let json = serde_json::to_value((&reg.providers, &reg.models)).unwrap();
    let anthropic = &json[0][0];
    assert_eq!((anthropic["name"].as_str(), anthropic["type"].as_str()), (Some("anthropic"), Some("anthropic")));
    assert_eq!(anthropic["baseUrl"], "https://api.anthropic.com");
    assert_eq!(anthropic["apiKey"], "sk-ant-test");
    let google = &json[0][1];
    assert_eq!(
      (google["baseUrl"].as_str(), google["wireApi"].as_str()),
      (Some("https://generativelanguage.googleapis.com/v1beta/openai"), Some("completions"))
    );
    assert!(google.get("modelProvider").is_none());

    let models = json[1].as_array().unwrap();
    assert_eq!(models.len(), 2, "only the chosen Google model: {models:?}");
    let opus = &models[0];
    assert_eq!((opus["id"].as_str(), opus["modelId"].as_str()), (Some("claude-opus-5-5"), Some("claude-opus-5.5")));
    assert_eq!(opus["maxContextWindowTokens"], 1_000_000);
    assert_eq!(opus["maxOutputTokens"], 32_768);
    assert_eq!(opus["maxPromptTokens"], 1_000_000 - 32_768);
    assert_eq!(opus["capabilities"]["supports"]["adaptive_thinking"], "required");
    let flash = &models[1];
    assert_eq!((flash["id"].as_str(), flash["wireModel"].as_str()), (Some("gemini-3.8-flash"), Some("gemini-3.8-flash")));
    assert_eq!(flash["provider"], "google");
    assert!(flash.get("modelId").is_none());
    // A model id a selection id can't hold as it is.
    assert_eq!(selection_id("openai", "ft:gpt-4o:acme/run 1"), "openai/ft:gpt-4o:acme-run-1");
    let saved = settings();
    let (spec, info) = find_model(&saved, "google/gemini-3.8-flash").unwrap();
    assert_eq!((spec.id, info.id.as_str()), ("google", "gemini-3.8-flash"));
    assert!(find_model(&settings(), "google/missing").is_none() && find_model(&settings(), "groq/x").is_none());
  }

  #[test]
  fn a_provider_without_a_key_or_chosen_models_is_left_out() {
    let reg = build(&settings(), &keys(&[("anthropic", "sk-ant-test")]));
    assert_eq!(reg.providers.len(), 1);
    assert!(reg.models.iter().all(|m| m.provider == "anthropic"));
    let mut none_chosen = settings();
    none_chosen.providers.get_mut("anthropic").unwrap().enabled.clear();
    assert!(build(&none_chosen, &keys(&[("anthropic", "sk-ant-test")])).providers.is_empty());
  }

  #[test]
  fn revision_changes_with_the_key_and_the_models_but_never_shows_the_key() {
    let a = build(&settings(), &keys(&[("anthropic", "sk-ant-one")]));
    assert_eq!(a.revision, build(&settings(), &keys(&[("anthropic", "sk-ant-one")])).revision);
    assert_ne!(a.revision, build(&settings(), &keys(&[("anthropic", "sk-ant-two")])).revision);
    let mut more = settings();
    more.providers.get_mut("google").unwrap().enabled.push("gemma-4-31b-it".into());
    let both = keys(&[("anthropic", "sk-ant-one"), ("google", "AIza-x")]);
    assert_ne!(build(&settings(), &both).revision, build(&more, &both).revision);
    let shown = format!("{a:?}");
    assert!(!shown.contains("sk-ant-one") && shown.contains("anthropic/claude-opus-5-5"), "{shown}");
  }

  #[test]
  fn small_windows_keep_most_of_the_room_for_the_prompt() {
    let m = |context, max_output, max_prompt| ByokModelInfo { context_window: context, max_output, max_prompt, ..Default::default() };
    assert_eq!(token_limits(&m(131_072, 16_384, None)), (131_072, 131_072 - 16_384, 16_384));
    assert_eq!(token_limits(&m(400_000, 128_000, Some(272_000))), (400_000, 272_000, 32_768));
    assert_eq!(token_limits(&m(32_768, 65_536, None)), (32_768, 24_576, 8_192));
  }
}
