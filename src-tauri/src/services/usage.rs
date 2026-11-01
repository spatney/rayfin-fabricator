//! What a Build chat has used, from its Copilot session's own accounting, and
//! what's left of the signed-in account's Copilot allowance.
//!
//! The runtime keeps a session's totals across resumes (`session.usage.getMetrics`)
//! and splits them by the provider that served each model. Copilot's calls report
//! AI credits (in nano-AI units) and premium requests. Calls on the user's own
//! API keys carry no provider and are billed by that provider, so only their
//! tokens are known.

use github_copilot_sdk::session::Session;
use github_copilot_sdk::session_events::{
  AiCreditsStatus, ModelProviderKind, UsageGetMetricsResult, UsageMetricsModelMetric, UsageMetricsProviderModelMetric,
};
use serde_json::Value;

use crate::services::byok::registry::split_session_name;
use crate::types::{ChatModelUsage, ChatUsage, CopilotBilling, CopilotQuota};

/// Nano-AI units in one AI credit.
const NANO_PER_CREDIT: f64 = 1e9;

/// The chat's usage so far, read from its open session. Both reads stay inside
/// the runtime (no network). `None` when the runtime can't report it.
pub async fn read(session: &Session) -> Option<ChatUsage> {
  let metrics = match session.rpc().usage().get_metrics().await {
    Ok(metrics) => metrics,
    Err(e) => {
      log::debug!("couldn't read the chat's usage: {e}");
      return None;
    }
  };
  let tbb = session.rpc().quota().get().await.ok().map(|q| q.is_tbb_user);
  Some(snapshot(session.id().as_str(), &metrics, tbb))
}

/// The chat's usage from its session's metrics. `tbb` says whether the account
/// pays in AI credits (token-based billing), when the session knows.
pub fn snapshot(session_id: &str, metrics: &UsageGetMetricsResult, tbb: Option<bool>) -> ChatUsage {
  let (mut models, credits_partial) = match &metrics.provider_model_metrics {
    Some(rows) => {
      let models = rows
        .iter()
        .filter_map(|r| row(r.model_id.as_deref(), r.model_display_name.as_deref(), &r.metrics, !served_by_copilot(r)))
        .collect::<Vec<_>>();
      let partial = rows.iter().filter(|r| served_by_copilot(r)).any(|r| incomplete(r.metrics.ai_credits_status.as_ref()));
      (models, partial)
    }
    // A runtime without provider attribution: Copilot's calls are the ones it billed.
    None => (
      metrics.model_metrics.iter().filter_map(|(id, m)| row(Some(id), None, m, !billed(m))).collect(),
      incomplete(metrics.ai_credits_status.as_ref()),
    ),
  };
  models.sort_by(|a, b| {
    a.own_key
      .cmp(&b.own_key)
      .then(b.ai_credits.total_cmp(&a.ai_credits))
      .then((b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens)))
      .then(a.name.cmp(&b.name))
  });
  let ai_credits = metrics.total_nano_aiu.unwrap_or(0.0).max(0.0) / NANO_PER_CREDIT;
  let premium_requests = metrics.total_premium_request_cost.max(0.0);
  let billing = match tbb {
    Some(true) => CopilotBilling::AiCredits,
    Some(false) => CopilotBilling::PremiumRequests,
    None if ai_credits == 0.0 && premium_requests > 0.0 => CopilotBilling::PremiumRequests,
    None => CopilotBilling::AiCredits,
  };
  ChatUsage { session_id: session_id.to_string(), billing, ai_credits, credits_partial, premium_requests, models }
}

/// Copilot served these calls: they're attributed to it, or (for usage recorded
/// before calls were attributed) Copilot billed them. Calls on the user's own
/// keys have no provider.
fn served_by_copilot(r: &UsageMetricsProviderModelMetric) -> bool {
  match &r.provider {
    Some(p) => p.kind == ModelProviderKind::Copilot || billed(&r.metrics),
    None => r.model_id.is_none() || billed(&r.metrics),
  }
}

fn billed(m: &UsageMetricsModelMetric) -> bool {
  m.total_nano_aiu.unwrap_or(0.0) > 0.0 || m.requests.cost > 0.0
}

/// Some calls reported no credit amount (which isn't the same as no charge).
fn incomplete(status: Option<&AiCreditsStatus>) -> bool {
  matches!(status, Some(AiCreditsStatus::Partial | AiCreditsStatus::Unavailable))
}

fn row(id: Option<&str>, name: Option<&str>, m: &UsageMetricsModelMetric, own_key: bool) -> Option<ChatModelUsage> {
  let u = &m.usage;
  if m.requests.count == 0 && u.input_tokens == 0 && u.output_tokens == 0 {
    return None;
  }
  let id = id.unwrap_or("").to_string();
  let name = name
    .map(str::trim)
    .filter(|n| !n.is_empty())
    .map(str::to_string)
    .unwrap_or_else(|| if id.is_empty() { "Other models".to_string() } else { id.clone() });
  // A model on the user's own key is named after it ("Grok 4.7 (your xAI key)").
  let (name, provider) = match split_session_name(&name) {
    Some((model, provider)) if own_key => (model.to_string(), Some(provider.to_string())),
    _ => (name, None),
  };
  Some(ChatModelUsage {
    model: id,
    name,
    own_key,
    provider,
    input_tokens: u.input_tokens.max(0),
    cached_tokens: u.cache_read_tokens.max(0),
    output_tokens: u.output_tokens.max(0),
    ai_credits: if own_key { 0.0 } else { m.total_nano_aiu.unwrap_or(0.0).max(0.0) / NANO_PER_CREDIT },
    premium_requests: if own_key { 0.0 } else { m.requests.cost.max(0.0) },
  })
}

/// The account's allowance from `account.getQuota`: its premium interactions
/// quota, in AI credits under token-based billing, else in premium requests.
/// `None` when the account has no such quota.
pub fn parse_quota(raw: &Value) -> Option<CopilotQuota> {
  let q = raw.pointer("/quotaSnapshots/premium_interactions")?;
  let num = |key: &str| q.get(key).and_then(Value::as_f64);
  let flag = |key: &str| q.get(key).and_then(Value::as_bool).unwrap_or(false);
  let entitlement = num("entitlementRequests")?;
  let used = num("usedRequests").unwrap_or(0.0).max(0.0);
  let remaining_percent = num("remainingPercentage")
    .unwrap_or(if entitlement > 0.0 { 100.0 * (1.0 - used / entitlement) } else { 100.0 })
    .clamp(0.0, 100.0);
  Some(CopilotQuota {
    unit: if flag("tokenBasedBilling") { CopilotBilling::AiCredits } else { CopilotBilling::PremiumRequests },
    unlimited: flag("isUnlimitedEntitlement") || entitlement < 0.0,
    entitlement: entitlement.max(0.0),
    used,
    remaining_percent,
    overage: num("overage").unwrap_or(0.0).max(0.0),
    overage_allowed: flag("overageAllowedWithExhaustedQuota"),
    reset_date: q.get("resetDate").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn metric(count: i64, cost: f64, input: i64, cached: i64, output: i64, nano: f64, status: &str) -> Value {
    json!({
      "requests": { "count": count, "cost": cost },
      "usage": { "inputTokens": input, "outputTokens": output, "cacheReadTokens": cached, "cacheWriteTokens": 0 },
      "totalNanoAiu": nano,
      "aiCreditsStatus": status
    })
  }

  fn metrics(extra: Value) -> UsageGetMetricsResult {
    let mut base = json!({
      "totalPremiumRequestCost": 0,
      "totalUserRequests": 0,
      "totalApiDurationMs": 0,
      "sessionStartTime": "2026-10-25T06:59:55.969Z",
      "codeChanges": { "linesAdded": 0, "linesRemoved": 0, "filesModifiedCount": 0, "filesModified": [] },
      "modelMetrics": {},
      "lastCallInputTokens": 0,
      "lastCallOutputTokens": 0
    });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
  }

  /// A chat that ran Grok 4.7 on Copilot and on the user's xAI key, as the
  /// runtime reported it after the session was resumed.
  fn mixed_chat() -> UsageGetMetricsResult {
    metrics(json!({
      "totalPremiumRequestCost": 3,
      "totalNanoAiu": 454_775_200_000.0,
      "aiCreditsStatus": "partial",
      "modelMetrics": { "grok-4.7": metric(215, 3.0, 25_115_004, 24_509_824, 148_325, 454_775_200_000.0, "partial") },
      "providerModelMetrics": [
        {
          "provider": null, "modelId": "grok-4.7", "modelDisplayName": "Grok 4.7 (your xAI key)",
          "metrics": metric(121, 0.0, 17_541_757, 17_256_192, 101_374, 0.0, "unavailable")
        },
        {
          "provider": { "id": "copilot", "label": "GitHub Copilot", "kind": "copilot" },
          "modelId": "grok-4.7", "modelDisplayName": "Grok 4.7",
          "metrics": metric(94, 3.0, 7_573_247, 7_253_632, 46_951, 454_775_200_000.0, "complete")
        }
      ]
    }))
  }

  fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
  }

  #[test]
  fn a_chat_on_copilot_and_on_its_own_key_splits_credits_from_tokens() {
    let usage = snapshot("thread", &mixed_chat(), Some(true));
    assert_eq!(usage.session_id, "thread");
    assert_eq!(usage.billing, CopilotBilling::AiCredits);
    assert!(close(usage.ai_credits, 454.7752));
    assert_eq!(usage.premium_requests, 3.0);
    // The own-key calls reported no credits, but that leaves Copilot's complete.
    assert!(!usage.credits_partial);

    let [copilot, own] = usage.models.as_slice() else { panic!("two models: {:?}", usage.models) };
    assert_eq!((copilot.name.as_str(), copilot.own_key, copilot.provider.as_deref()), ("Grok 4.7", false, None));
    assert!(close(copilot.ai_credits, 454.7752));
    assert_eq!(copilot.premium_requests, 3.0);
    assert_eq!((copilot.input_tokens, copilot.cached_tokens, copilot.output_tokens), (7_573_247, 7_253_632, 46_951));
    assert_eq!((own.name.as_str(), own.own_key, own.provider.as_deref()), ("Grok 4.7", true, Some("xAI")));
    assert_eq!((own.ai_credits, own.premium_requests), (0.0, 0.0));
    assert_eq!((own.input_tokens, own.cached_tokens, own.output_tokens), (17_541_757, 17_256_192, 101_374));
  }

  #[test]
  fn the_accounts_billing_decides_what_a_chat_counts() {
    assert_eq!(snapshot("s", &mixed_chat(), Some(false)).billing, CopilotBilling::PremiumRequests);
    assert_eq!(snapshot("s", &mixed_chat(), None).billing, CopilotBilling::AiCredits);
    let requests_only = metrics(json!({
      "totalPremiumRequestCost": 2.5,
      "modelMetrics": { "claude-sonnet-5.5": metric(4, 2.5, 9_000, 0, 300, 0.0, "unavailable") }
    }));
    let usage = snapshot("s", &requests_only, None);
    assert_eq!(usage.billing, CopilotBilling::PremiumRequests);
    assert_eq!(usage.premium_requests, 2.5);
  }

  #[test]
  fn usage_from_before_calls_were_attributed_counts_as_copilots() {
    let usage = snapshot(
      "s",
      &metrics(json!({
        "totalNanoAiu": 2_000_000_000.0,
        "providerModelMetrics": [
          { "provider": null, "modelId": null, "metrics": metric(3, 1.0, 5_000, 0, 200, 2_000_000_000.0, "complete") }
        ]
      })),
      Some(true),
    );
    let [earlier] = usage.models.as_slice() else { panic!("one row: {:?}", usage.models) };
    assert_eq!((earlier.name.as_str(), earlier.own_key), ("Other models", false));
    assert!(close(earlier.ai_credits, 2.0));
  }

  #[test]
  fn without_provider_attribution_unbilled_models_are_the_users_own() {
    let usage = snapshot(
      "s",
      &metrics(json!({
        "totalNanoAiu": 24_809_600_000.0,
        "aiCreditsStatus": "partial",
        "modelMetrics": {
          "claude-sonnet-5-5": metric(2, 0.0, 72_748, 0, 510, 0.0, "unavailable"),
          "claude-opus-5.5": metric(1, 15.0, 46_728, 0, 723, 24_809_600_000.0, "complete"),
          "unused": metric(0, 0.0, 0, 0, 0, 0.0, "complete")
        }
      })),
      Some(true),
    );
    let names: Vec<(&str, bool)> = usage.models.iter().map(|m| (m.model.as_str(), m.own_key)).collect();
    assert_eq!(names, [("claude-opus-5.5", false), ("claude-sonnet-5-5", true)]);
    assert!(close(usage.ai_credits, 24.8096));
    assert!(usage.credits_partial);
  }

  #[test]
  fn the_allowance_counts_ai_credits_or_premium_requests() {
    // As account.getQuota reported it for an account on token-based billing.
    let credits = parse_quota(&json!({ "quotaSnapshots": {
      "chat": { "isUnlimitedEntitlement": true, "entitlementRequests": 0, "usedRequests": 0, "remainingPercentage": 100 },
      "premium_interactions": {
        "isUnlimitedEntitlement": false, "entitlementRequests": 1_000_000, "usedRequests": 1000,
        "usageAllowedWithExhaustedQuota": true, "overage": 0, "overageAllowedWithExhaustedQuota": true,
        "remainingPercentage": 99.9, "resetDate": "2026-12-01T00:00:00Z", "hasQuota": true,
        "tokenBasedBilling": true, "overageEntitlement": 0
      }
    }}))
    .unwrap();
    assert_eq!(
      credits,
      CopilotQuota {
        unit: CopilotBilling::AiCredits,
        unlimited: false,
        entitlement: 1_000_000.0,
        used: 1000.0,
        remaining_percent: 99.9,
        overage: 0.0,
        overage_allowed: true,
        reset_date: Some("2026-12-01T00:00:00Z".into()),
      }
    );

    let requests = parse_quota(&json!({ "quotaSnapshots": { "premium_interactions": {
      "isUnlimitedEntitlement": false, "entitlementRequests": 300, "usedRequests": 312, "overage": 12,
      "overageAllowedWithExhaustedQuota": false
    }}}))
    .unwrap();
    assert_eq!(requests.unit, CopilotBilling::PremiumRequests);
    assert_eq!((requests.used, requests.overage, requests.remaining_percent), (312.0, 12.0, 0.0));

    let unlimited = parse_quota(&json!({ "quotaSnapshots": { "premium_interactions": {
      "isUnlimitedEntitlement": false, "entitlementRequests": -1, "usedRequests": 0
    }}}))
    .unwrap();
    assert!(unlimited.unlimited);
    assert_eq!(parse_quota(&json!({ "quotaSnapshots": {} })), None);
  }
}
