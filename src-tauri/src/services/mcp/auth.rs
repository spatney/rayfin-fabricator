//! The runtime's sign-in requests for a Build chat session's MCP servers.

use async_trait::async_trait;
use github_copilot_sdk::handler::{McpAuthHandler, McpAuthRequest, McpAuthResponse, McpAuthResult};
use github_copilot_sdk::session_events::McpOauthRequestReason;
use github_copilot_sdk::{RequestId, SessionId};

use crate::services::iq::{Iq, IqAuth};

/// Answers the runtime's sign-in requests for a chat session's MCP servers.
/// Fabric IQ and Work IQ get Fabricator's tokens ([`IqAuth`]). A server the
/// user added signs in with the runtime itself: the runtime renews that sign-in
/// on its own, and a first one waits, with the server needing a sign-in, until
/// [`super::prepare`] asks the user to sign in in the browser.
pub struct SessionAuth;

/// Whether the runtime should renew a sign-in itself.
fn runtime_renews(request: &McpAuthRequest, runtime_refresh_supported: bool) -> bool {
  runtime_refresh_supported
    && request.reason == McpOauthRequestReason::Refresh
    && Iq::from_server(&request.server_name).is_none()
}

#[async_trait]
impl McpAuthHandler for SessionAuth {
  async fn handle(&self, session_id: SessionId, request_id: RequestId, request: McpAuthRequest) -> McpAuthResult {
    // Declines a server the user added.
    IqAuth.handle(session_id, request_id, request).await
  }

  async fn handle_with_runtime_refresh(
    &self,
    session_id: SessionId,
    request_id: RequestId,
    request: McpAuthRequest,
    runtime_refresh_supported: bool,
  ) -> McpAuthResponse {
    if runtime_renews(&request, runtime_refresh_supported) {
      return McpAuthResponse::RuntimeRefresh;
    }
    McpAuthResponse::Legacy(self.handle(session_id, request_id, request).await)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use github_copilot_sdk::RequestId;

  fn request(server: &str, reason: McpOauthRequestReason) -> McpAuthRequest {
    McpAuthRequest {
      request_id: RequestId::new("r"),
      server_name: server.into(),
      server_url: "https://example.com/mcp".into(),
      reason,
      www_authenticate_params: None,
      resource_metadata: None,
      static_client_config: None,
    }
  }

  #[test]
  fn the_runtime_renews_the_sign_in_to_a_server_the_user_added() {
    assert!(runtime_renews(&request("linear", McpOauthRequestReason::Refresh), true));
    // Not when the runtime can't, nor a first sign-in, nor Fabric IQ's or Work IQ's tokens.
    assert!(!runtime_renews(&request("linear", McpOauthRequestReason::Refresh), false));
    assert!(!runtime_renews(&request("linear", McpOauthRequestReason::Initial), true));
    assert!(!runtime_renews(&request("workiq", McpOauthRequestReason::Refresh), true));
  }

  #[tokio::test]
  async fn a_first_sign_in_to_a_server_the_user_added_waits_for_the_user() {
    let result = SessionAuth
      .handle(SessionId::from("s"), RequestId::new("1"), request("linear", McpOauthRequestReason::Initial))
      .await;
    assert!(matches!(result, McpAuthResult::Cancelled));
  }
}
