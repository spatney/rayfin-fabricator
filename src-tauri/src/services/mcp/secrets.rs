//! The values of an MCP server's environment variables and headers: keys and
//! tokens, so they live in the OS credential store, one entry per server
//! (`rayfin-fabricator/mcp/<id>`), never in Fabricator's settings, and never go
//! back to the renderer.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::services::keychain::{self, Item};

/// A server's saved values, by name.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Values {
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub env: BTreeMap<String, String>,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub headers: BTreeMap<String, String>,
}

impl Values {
  pub fn is_empty(&self) -> bool {
    self.env.is_empty() && self.headers.is_empty()
  }
}

/// The values saved for server `id` (none when there are none).
pub fn load(id: &str) -> Result<Values, String> {
  match keychain::read(Item::McpServer(id))? {
    Some(raw) => serde_json::from_str(&raw)
      .map_err(|_| "The server's saved values couldn't be read. Enter them again.".to_string()),
    None => Ok(Values::default()),
  }
}

/// Save `values` for server `id`, replacing what was saved; with none, delete it.
pub fn save(id: &str, values: &Values) -> Result<(), String> {
  if values.is_empty() {
    return forget(id);
  }
  let raw = serde_json::to_string(values).map_err(|e| format!("Couldn't save the server's values ({e})."))?;
  keychain::write(Item::McpServer(id), &raw)
}

/// Delete what's saved for server `id`.
pub fn forget(id: &str) -> Result<(), String> {
  keychain::remove(Item::McpServer(id))
}
