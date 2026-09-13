//! Shared Fabric helper transport. Tokens remain in the Node child; Rust only
//! reads its structured result and never accepts success from a failed process.

use std::path::PathBuf;

use once_cell::sync::{Lazy, OnceCell};
use regex::Regex;
use serde::de::DeserializeOwned;

use crate::services::{exec, paths};

pub const HELPER_SOURCE: &str = include_str!("fabric_auth_helper.mjs");

static LOGIN_ERROR: Lazy<Regex> = Lazy::new(|| {
  Regex::new(concat!(
    r"(?i)\b(interaction_required|login_required|consent_required|invalid_grant|",
    r"no_account_error|no_account_in_silent_request|no_tokens_found)\b|",
    r"\bno (?:cached )?(?:account|credentials?|tokens?|session)\b|",
    r"\bnot (?:signed|logged) in\b|",
    r"\b(?:sign[ -]?in|log[ -]?in|interactive authentication) (?:is )?required\b|",
    r"\binteractive\s+(?:log[ -]?in|authentication)\s+(?:(?:was|is)\s+)?not\s+allowed\b|",
    r"\b(?:please|must|need to) (?:sign|log)[ -]?in\b|",
    r"\b(?:access|refresh) token\b[^\n]*(?:expired|revoked)|",
    r"\bAADSTS(?:50058|50076|50079|50173|65001|70043|700082|700084)\b|",
    r#"(?:run|use)\s+[`'"]?(?:az|rayfin) login\b"#,
  ))
  .unwrap()
});
static AZ_ERROR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\baz\b|azure cli").unwrap());
static TRANSPORT_ERROR: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|timed? ?out|network (?:error|request failed)|fetch failed").unwrap()
});
static BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)\bBearer\s+[^\s"',;]+"#).unwrap());
static JWT: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").unwrap());

pub fn failure_flags(error: &str) -> (bool, bool) {
  if TRANSPORT_ERROR.is_match(error) {
    return (false, false);
  }
  let login = LOGIN_ERROR.is_match(error);
  let az = AZ_ERROR.is_match(error)
    && (login || error.to_lowercase().contains("not found") || error.to_lowercase().contains("not recognized"));
  (login && !az, az)
}

pub fn failure_message(res: &exec::RunResult) -> String {
  let message = if res.not_found {
    "Node.js was not found on PATH.".to_string()
  } else if !res.stderr.trim().is_empty() {
    res.stderr.trim().to_string()
  } else if let Some(error) = serde_json::from_str::<serde_json::Value>(res.stdout.trim())
    .ok()
    .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(str::to_owned))
  {
    error
  } else if !res.stdout.trim().is_empty() {
    "The Fabric helper returned an invalid response.".to_string()
  } else {
    format!(
      "The Fabric helper failed (exit {}).",
      res.exit_code.map(|code| code.to_string()).unwrap_or_else(|| "unknown".into())
    )
  };
  JWT.replace_all(&BEARER.replace_all(&message, "Bearer [redacted]"), "[redacted]").into_owned()
}

pub fn parse_helper_output<T: DeserializeOwned>(res: &exec::RunResult) -> Result<T, String> {
  if !res.ok || res.not_found {
    return Err(failure_message(res));
  }
  serde_json::from_str(res.stdout.trim()).map_err(|_| failure_message(res))
}

pub fn write_helper() -> std::io::Result<PathBuf> {
  static HELPER_PATH: OnceCell<PathBuf> = OnceCell::new();
  HELPER_PATH
    .get_or_try_init(|| {
      let path = paths::ensure_data_dir()?.join("fabric_auth_helper.mjs");
      std::fs::write(&path, HELPER_SOURCE)?;
      Ok(path)
    })
    .cloned()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn auth_failures_are_distinct_from_permission_and_transport_errors() {
    assert_eq!(failure_flags("no cached account"), (true, false));
    assert_eq!(failure_flags("invalid_grant: AADSTS700082"), (true, false));
    assert_eq!(failure_flags("Please run 'az login'"), (false, true));
    for message in [
      "Silent token acquisition failed and interactive login was not allowed",
      "Silent token acquisition failed and interactive login is not allowed",
      "Interactive login not allowed",
    ] {
      assert_eq!(failure_flags(message), (true, false), "{message}");
    }
    for message in [
      "Unexpected token in JSON",
      "Workspace role assignment failed (403)",
      "Account limit exceeded",
      "az account get-access-token timed out",
      "Network request failed: token endpoint",
      "Silent token acquisition failed and interactive login was not allowed: request timed out",
    ] {
      assert_eq!(failure_flags(message), (false, false), "{message}");
    }
  }

  #[test]
  fn failed_process_cannot_return_success() {
    let res = exec::RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: r#"{"ok":true,"workspaces":[]}"#.into(),
      stderr: "process terminated".into(),
      not_found: false,
    };
    assert!(parse_helper_output::<serde_json::Value>(&res).is_err());
  }

  #[test]
  fn fallback_errors_redact_authorization_values() {
    let res = exec::RunResult {
      ok: false,
      exit_code: Some(1),
      stdout: String::new(),
      stderr: "Request rejected: Bearer synthetic-test-value".into(),
      not_found: false,
    };
    assert_eq!(failure_message(&res), "Request rejected: Bearer [redacted]");
  }

  #[test]
  fn fabric_auth_helper_regressions() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("src").join("services").join("fabric_auth_helper.test.mjs");
    let output = match std::process::Command::new("node").arg("--test").arg(script).output() {
      Ok(output) => output,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
      Err(error) => panic!("Could not run offline Fabric auth tests: {error}"),
    };
    assert!(
      output.status.success(),
      "{}\n{}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }
}
