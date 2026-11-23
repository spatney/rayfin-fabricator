//! A relay on this computer for providers that take less than the Copilot
//! runtime sends them: OpenAI, xAI, Google (Gemini, through its
//! OpenAI-compatible endpoint), OpenRouter, Ollama and OpenAI-compatible servers.
//!
//! For each of them it fits the reasoning effort to the model. When none was
//! chosen, the runtime asks for `medium`, and models without effort levels
//! (OpenAI's GPT-4.1, xAI's Grok Build, Google's Gemma, most local models)
//! fail the request with any effort at all ("'reasoning.effort' is not
//! supported with this model"). So an effort the chosen model doesn't take is
//! left out, and the provider uses its default.
//!
//! Google needs more. Without it, every conversation failed from its second
//! model call. On the way out the relay adapts the request:
//! - It keeps only the request and message fields Gemini takes. The runtime's
//!   OpenAI client adds `refusal: null` to each assistant message it replays,
//!   and request fields such as `prompt_cache_key`; Gemini fails a request with
//!   either ("Value is not a string: null", "Unknown name").
//! - It gives each replayed tool call back its thought signature. Gemini signs
//!   the first tool call of a reply and fails a later request whose replayed
//!   calls lost it ("Function call is missing a thought_signature"), which the
//!   runtime's client drops. The relay remembers the signatures in the replies
//!   it passes back; for a reply it never saw (another model's, or one from
//!   before Fabricator restarted) it sends the placeholder Google documents for
//!   calls Gemini didn't make, which skips the check.
//! - It moves images out of tool results, where Gemini refuses them, into a user
//!   message right after the results.
//!
//! On the way back it numbers the tool calls of a streamed Gemini reply (Gemini
//! leaves out the `index` OpenAI clients tell parallel calls apart by) and has a
//! reply that called tools finish with `tool_calls` rather than `stop`.
//!
//! Ollama sets the context a model runs with itself: its Context length
//! setting, else a default that depends on the GPU's memory (4k, 32k or 256k).
//! Its OpenAI-compatible API can't change it. A conversation longer than that
//! fails in ways that don't say why: Ollama drops its start, the user's request
//! with it ("no user query found in messages" from Qwen's models), and cuts
//! replies off while the model is still reasoning. So once Ollama answers a
//! chat request, the relay reads the context the model runs with for it from
//! `/api/ps`. When that's less than sessions count on for the model, it drops
//! Ollama's reply, which stops it, and turns the request down
//! ([`CONTEXT_TOO_SHORT`]).
//!
//! For a server people run, it also gives each message that calls no tools its
//! text, even an empty one: the runtime sends `content: null` for a reply that
//! had neither text nor a tool call (one cut off while reasoning, which it then
//! asks the model to go on from), and Ollama turns down a request with one
//! ("invalid message content type: <nil>").
//!
//! It listens on 127.0.0.1 only, under a random path token, and only forwards to
//! the provider's own host, or for a server people run, the address saved for
//! it. It keeps nothing but Gemini's thought signatures, in
//! memory: the runtime's credentials pass through, and it never logs a request
//! or a header.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderName};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use once_cell::sync::{Lazy, OnceCell};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::catalog::{self, Endpoint, ProviderSpec};
use crate::services::store;

/// The largest request the relay takes (a long conversation with images).
const MAX_BODY: usize = 64 * 1024 * 1024;

/// The thought signature Google documents for a function call Gemini didn't
/// make: it skips the check.
const SKIP_SIGNATURE: &str = "skip_thought_signature_validator";

/// How many thought signatures the relay keeps (the newest).
const SIGNATURES_KEPT: usize = 4096;

/// How the relay starts turning down a request to Ollama that the model's
/// context can't hold; the context in tokens follows. `byok::classify` knows
/// the failure by it.
pub const CONTEXT_TOO_SHORT: &str = "Ollama runs this model with a context length of";

/// How long the relay waits for Ollama to list the models it's running.
const RUNNING_TIMEOUT: Duration = Duration::from_secs(10);

/// The request fields Gemini's OpenAI-compatible endpoint takes. It fails a
/// request with any other ("Unknown name \"prompt_cache_key\"").
const REQUEST_FIELDS: [&str; 22] = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "n",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "reasoning_effort",
  "response_format",
  "logprobs",
  "top_logprobs",
  "user",
  "extra_body",
];

type Body = BoxBody<Bytes, std::io::Error>;

struct Relay {
  port: u16,
  token: String,
}

static RELAY: OnceCell<Result<Relay, String>> = OnceCell::new();

/// The relay, started the first time a session needs it.
fn relay() -> Result<&'static Relay, String> {
  RELAY.get_or_init(start).as_ref().map_err(Clone::clone)
}

fn start() -> Result<Relay, String> {
  let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("couldn't open a local port ({e})"))?;
  listener.set_nonblocking(true).map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  let token = uuid::Uuid::new_v4().simple().to_string();
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(20))
    .read_timeout(Duration::from_secs(300))
    .build()
    .map_err(|e| e.to_string())?;
  let path_token = token.clone();
  tauri::async_runtime::spawn(async move {
    let listener = match tokio::net::TcpListener::from_std(listener) {
      Ok(listener) => listener,
      Err(e) => {
        log::error!("the provider relay couldn't listen: {e}");
        return;
      }
    };
    loop {
      let Ok((stream, _)) = listener.accept().await else { continue };
      let (token, client) = (path_token.clone(), client.clone());
      tokio::spawn(async move {
        let service = service_fn(move |req| {
          let (token, client) = (token.clone(), client.clone());
          async move { Ok::<_, Infallible>(handle(req, &token, &client).await) }
        });
        if let Err(e) = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await {
          log::debug!("provider relay connection ended: {e}");
        }
      });
    }
  });
  log::info!("provider relay listening on 127.0.0.1:{port}");
  Ok(Relay { port, token })
}

/// The base URL a session reaches `spec` at through the relay, for its base
/// URL `upstream`, e.g. `http://127.0.0.1:52811/<token>/google/v1beta/openai`.
pub fn base_url(spec: &ProviderSpec, upstream: &str) -> Result<String, String> {
  let relay = relay()?;
  Ok(format!("http://127.0.0.1:{}/{}/{}{}", relay.port, relay.token, spec.id, path_of(upstream)))
}

/// Where the relay forwards `spec`'s requests: its own base URL, or the one
/// saved for a server people run (read for each request, so a changed address
/// takes effect at once).
fn upstream_of(spec: &ProviderSpec) -> Option<String> {
  let settings = store::byok_settings();
  spec.base_url_with(settings.providers.get(spec.id).and_then(|p| p.base_url.as_deref()))
}

/// `https://generativelanguage.googleapis.com/v1beta/openai` → `https://generativelanguage.googleapis.com`.
pub(super) fn origin_of(url: &str) -> &str {
  let host_start = url.find("://").map_or(0, |i| i + 3);
  url[host_start..].find('/').map_or(url, |i| &url[..host_start + i])
}

/// `https://generativelanguage.googleapis.com/v1beta/openai` → `/v1beta/openai`.
fn path_of(url: &str) -> &str {
  &url[origin_of(url).len()..]
}

/// Headers that belong to one connection, or that the relay sets itself.
fn passes(name: &HeaderName) -> bool {
  !matches!(
    name.as_str(),
    "host" | "connection" | "keep-alive" | "proxy-connection" | "proxy-authorization" | "te" | "trailer"
      | "transfer-encoding" | "upgrade" | "content-length" | "accept-encoding"
  )
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
  let body = Full::new(Bytes::from(json!({ "error": { "message": message } }).to_string()))
    .map_err(|never| match never {})
    .boxed();
  let mut response = Response::new(body);
  *response.status_mut() = status;
  response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json"));
  response
}

async fn handle(req: Request<Incoming>, token: &str, client: &reqwest::Client) -> Response<Body> {
  match forward(req, token, client).await {
    Ok(response) => response,
    Err((status, message)) => plain(status, &message),
  }
}

async fn forward(
  req: Request<Incoming>,
  token: &str,
  client: &reqwest::Client,
) -> Result<Response<Body>, (StatusCode, String)> {
  let not_found = || (StatusCode::NOT_FOUND, "Not found".to_string());
  let rest = req
    .uri()
    .path()
    .strip_prefix('/')
    .and_then(|p| p.strip_prefix(token))
    .and_then(|p| p.strip_prefix('/'))
    .ok_or_else(not_found)?;
  let (provider, rest) = rest.split_once('/').ok_or_else(not_found)?;
  let spec = catalog::find(provider).filter(|s| s.relay).ok_or_else(not_found)?;
  let upstream = upstream_of(spec).ok_or_else(not_found)?;
  let mut url = format!("{}/{rest}", origin_of(&upstream));
  if let Some(query) = req.uri().query() {
    url.push('?');
    url.push_str(query);
  }
  let chat = rest.ends_with("chat/completions");
  let responses = rest.ends_with("responses");
  let gemini = spec.id == "google";
  let (parts, body) = req.into_parts();
  let body = body
    .collect()
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, format!("Couldn't read the request ({e})")))?
    .to_bytes();
  if body.len() > MAX_BODY {
    return Err((StatusCode::PAYLOAD_TOO_LARGE, "The request is too large.".into()));
  }
  // For a chat request to Ollama: where Ollama is, the model, and the context
  // sessions count on for it (see the module docs).
  let mut context_needed = None;
  let body = match serde_json::from_slice::<Value>(&body) {
    Ok(json) if chat || responses => {
      if chat && spec.id == "ollama" {
        context_needed = json
          .get("model")
          .and_then(Value::as_str)
          .and_then(|model| Some((super::ollama_root(&upstream).to_string(), model.to_string(), saved_context(spec.id, model)?)));
      }
      let efforts = model_efforts(spec.id, &json);
      let json = if chat && gemini {
        prepare_chat(json)
      } else if chat && spec.endpoint != Endpoint::Fixed {
        fill_in_content(json)
      } else {
        json
      };
      Bytes::from(serde_json::to_vec(&fit_effort(json, responses, efforts.as_deref())).unwrap_or_default())
    }
    _ => body,
  };
  // Only Gemini's replies need rewriting.
  let chat = chat && gemini;

  let mut upstream = client.request(parts.method, &url).body(body);
  for (name, value) in parts.headers.iter().filter(|(name, _)| passes(name)) {
    upstream = upstream.header(name, value);
  }
  let reply = upstream
    .send()
    .await
    .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Couldn't reach {} ({e}).", spec.name)))?;
  // Ollama runs the model for the request now. Dropping the reply on the way
  // out stops it.
  if let Some((root, model, needed)) = &context_needed {
    check_context(client, root, model, *needed).await?;
  }

  let mut response = Response::builder().status(reply.status());
  for (name, value) in reply.headers().iter().filter(|(name, _)| passes(name)) {
    response = response.header(name, value);
  }
  let content_type = reply
    .headers()
    .get(header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("")
    .to_ascii_lowercase();
  let body: Body = if chat && content_type.starts_with("text/event-stream") {
    // A streamed reply: rewrite it line by line as it comes.
    let lines = futures::stream::unfold((Some(reply), SseLines::default()), |(reply, mut lines)| async move {
      let mut reply = reply?;
      loop {
        match reply.chunk().await {
          Ok(Some(chunk)) => {
            let out = lines.push(&chunk);
            if !out.is_empty() {
              return Some((Ok(Frame::data(Bytes::from(out))), (Some(reply), lines)));
            }
          }
          Ok(None) => {
            let out = lines.finish();
            return (!out.is_empty()).then(|| (Ok(Frame::data(Bytes::from(out))), (None, lines)));
          }
          Err(e) => return Some((Err(std::io::Error::other(e)), (None, lines))),
        }
      }
    });
    StreamBody::new(lines).boxed()
  } else if chat && content_type.starts_with("application/json") {
    let bytes = reply
      .bytes()
      .await
      .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Couldn't read {}'s reply ({e}).", spec.name)))?;
    let bytes = match serde_json::from_slice::<Value>(&bytes) {
      Ok(mut json) => {
        let mut seen = Reply::default();
        let changed = seen.read(&mut json);
        seen.finish();
        if changed {
          Bytes::from(json.to_string())
        } else {
          bytes
        }
      }
      Err(_) => bytes,
    };
    Full::new(bytes).map_err(|never| match never {}).boxed()
  } else {
    let chunks = futures::stream::unfold(Some(reply), |reply| async move {
      let mut reply = reply?;
      match reply.chunk().await {
        Ok(Some(chunk)) => Some((Ok(Frame::data(chunk)), Some(reply))),
        Ok(None) => None,
        Err(e) => Some((Err(std::io::Error::other(e)), None)),
      }
    });
    StreamBody::new(chunks).boxed()
  };
  response.body(body).map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))
}

/// The effort levels of the model a request names, when it's one the user saved.
fn model_efforts(provider: &str, request: &Value) -> Option<Vec<String>> {
  let model = request.get("model")?.as_str()?;
  let settings = store::byok_settings();
  let saved = settings.providers.get(provider)?;
  saved.models.iter().find(|m| m.id == model).map(|m| m.efforts.clone())
}

/// Leave out a reasoning effort the model doesn't take (see the module docs):
/// `reasoning.effort` in a Responses request, `reasoning_effort` in a chat
/// completions one. A model the user didn't save (`efforts` is `None`) gets
/// the request as it is.
fn fit_effort(mut request: Value, responses: bool, efforts: Option<&[String]>) -> Value {
  let Some(efforts) = efforts else {
    return request;
  };
  let takes = |effort: Option<&Value>| effort.and_then(Value::as_str).map_or(true, |e| efforts.iter().any(|x| x == e));
  if responses {
    if let Some(reasoning) = request.get_mut("reasoning").and_then(Value::as_object_mut) {
      if !takes(reasoning.get("effort")) {
        reasoning.remove("effort");
      }
    }
  } else if let Some(object) = request.as_object_mut() {
    if !takes(object.get("reasoning_effort")) {
      object.remove("reasoning_effort");
    }
  }
  request
}

/// Turn down a request whose model Ollama runs with less context than
/// sessions count on for it (see the module docs). When Ollama doesn't say,
/// the reply goes on as it is.
async fn check_context(client: &reqwest::Client, root: &str, model: &str, needed: u32) -> Result<(), (StatusCode, String)> {
  match running_models(client, root).await.and_then(|running| context_in(&running, model)) {
    Some(context) if context < needed => Err((StatusCode::BAD_REQUEST, too_short(model, context, needed))),
    _ => Ok(()),
  }
}

/// The relay's reply when Ollama runs `model` with less context than it needs.
pub(super) fn too_short(model: &str, context: u32, needed: u32) -> String {
  format!(
    "{CONTEXT_TOO_SHORT} {context} tokens, and Fabricator counts on {needed} for {model}. Set Context length to 64k or more in Ollama's settings."
  )
}

/// The context sessions count on for a model the user saved (see `registry::token_limits`).
fn saved_context(provider: &str, model: &str) -> Option<u32> {
  let settings = store::byok_settings();
  let saved = settings.providers.get(provider)?.models.iter().find(|m| m.id == model)?;
  Some(super::registry::token_limits(saved).0)
}

/// The models Ollama is running (`/api/ps`).
async fn running_models(client: &reqwest::Client, root: &str) -> Option<Value> {
  let reply = client.get(format!("{root}/api/ps")).timeout(RUNNING_TIMEOUT).send().await.ok()?;
  reply.error_for_status().ok()?.json().await.ok()
}

/// The context of `model` in Ollama's list of the models it's running.
fn context_in(running: &Value, model: &str) -> Option<u32> {
  running
    .get("models")?
    .as_array()?
    .iter()
    .find(|m| ["name", "model"].iter().any(|key| m.get(*key).and_then(Value::as_str) == Some(model)))?
    .get("context_length")?
    .as_u64()
    .filter(|tokens| *tokens > 0)
    .map(|tokens| u32::try_from(tokens).unwrap_or(u32::MAX))
}

/// Give each message that calls no tools its text, even an empty one (see the
/// module docs).
fn fill_in_content(mut request: Value) -> Value {
  for message in request.get_mut("messages").and_then(Value::as_array_mut).into_iter().flatten() {
    let Some(message) = message.as_object_mut() else {
      continue;
    };
    let calls_tools = message.get("tool_calls").and_then(Value::as_array).is_some_and(|calls| !calls.is_empty());
    if !calls_tools && message.get("content").is_none_or(Value::is_null) {
      message.insert("content".into(), Value::from(""));
    }
  }
  request
}

/// Thought signatures from Gemini's replies, by tool call (see [`call_key`]).
#[derive(Default)]
struct Signatures {
  by_call: HashMap<String, String>,
  order: VecDeque<String>,
}

impl Signatures {
  fn remember(&mut self, key: String, signature: String) {
    if self.by_call.insert(key.clone(), signature).is_none() {
      self.order.push_back(key);
      while self.order.len() > SIGNATURES_KEPT {
        if let Some(oldest) = self.order.pop_front() {
          self.by_call.remove(&oldest);
        }
      }
    }
  }
}

static SIGNATURES: Lazy<Mutex<Signatures>> = Lazy::new(Default::default);

fn signatures() -> std::sync::MutexGuard<'static, Signatures> {
  SIGNATURES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a tool call's signature is kept under: its id, name and arguments
/// (compared as JSON, so a client that writes them out again still matches).
fn call_key(id: &str, name: &str, arguments: &str) -> String {
  let arguments = serde_json::from_str::<Value>(arguments).map_or_else(|_| arguments.to_string(), |v| v.to_string());
  let mut hasher = Sha256::new();
  for part in [id, name, arguments.as_str()] {
    hasher.update(part.as_bytes());
    hasher.update([0u8]);
  }
  hex::encode(&hasher.finalize()[..16])
}

/// A chat request as Gemini takes it (see the module docs).
pub fn prepare_chat(request: Value) -> Value {
  let kept = signatures();
  prepare_chat_with(request, |key| kept.by_call.get(key).cloned())
}

fn prepare_chat_with(request: Value, signature: impl Fn(&str) -> Option<String>) -> Value {
  let Value::Object(mut request) = request else {
    return request;
  };
  request.retain(|key, _| REQUEST_FIELDS.contains(&key.as_str()));
  if let Some(Value::Array(messages)) = request.get_mut("messages") {
    let replayed = std::mem::take(messages);
    *messages = adapt_messages(replayed, &signature);
  }
  Value::Object(request)
}

/// Earlier messages as Gemini takes them: only the fields it knows, each
/// replayed tool call signed, and images from tool results in a user message.
fn adapt_messages(messages: Vec<Value>, signature: &impl Fn(&str) -> Option<String>) -> Vec<Value> {
  let mut out = Vec::with_capacity(messages.len() + 1);
  let mut images: Vec<Value> = Vec::new();
  for mut message in messages {
    let Some(object) = message.as_object_mut() else {
      out.push(message);
      continue;
    };
    let role = object.get("role").and_then(Value::as_str).unwrap_or("").to_string();
    if role != "tool" && !images.is_empty() {
      out.push(images_message(std::mem::take(&mut images)));
    }
    let allowed: &[&str] = match role.as_str() {
      "assistant" => &["role", "content", "name", "tool_calls"],
      "tool" => &["role", "content", "tool_call_id", "name"],
      _ => &["role", "content", "name"],
    };
    object.retain(|key, _| allowed.contains(&key.as_str()));
    match role.as_str() {
      "assistant" => sign_tool_calls(object, signature),
      "tool" => images.extend(take_images(object)),
      _ => {}
    }
    out.push(message);
  }
  if !images.is_empty() {
    out.push(images_message(images));
  }
  out
}

fn text_of(value: Option<&Value>) -> String {
  match value {
    Some(Value::String(s)) => s.clone(),
    Some(Value::Null) | None => String::new(),
    Some(other) => other.to_string(),
  }
}

/// Keep each replayed tool call's id, type and function (name and arguments),
/// and give it back the thought signature Gemini sent with it. A reply none of
/// whose calls the relay saw gets the placeholder on its first call.
fn sign_tool_calls(message: &mut Map<String, Value>, signature: &impl Fn(&str) -> Option<String>) {
  let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
    return;
  };
  let mut signed = false;
  for call in calls.iter_mut().filter_map(Value::as_object_mut) {
    call.retain(|key, _| matches!(key.as_str(), "id" | "type" | "function"));
    let (name, arguments) = match call.get_mut("function").and_then(Value::as_object_mut) {
      Some(function) => {
        function.retain(|key, _| matches!(key.as_str(), "name" | "arguments"));
        (text_of(function.get("name")), text_of(function.get("arguments")))
      }
      None => (String::new(), String::new()),
    };
    let key = call_key(call.get("id").and_then(Value::as_str).unwrap_or(""), &name, &arguments);
    if let Some(found) = signature(&key) {
      call.insert("extra_content".into(), json!({ "google": { "thought_signature": found } }));
      signed = true;
    }
  }
  if !signed {
    if let Some(first) = calls.first_mut().and_then(Value::as_object_mut) {
      first.insert("extra_content".into(), json!({ "google": { "thought_signature": SKIP_SIGNATURE } }));
    }
  }
}

/// Take the images out of a tool result, leaving its text.
fn take_images(message: &mut Map<String, Value>) -> Vec<Value> {
  let Some(Value::Array(parts)) = message.get_mut("content") else {
    return Vec::new();
  };
  let (images, text): (Vec<Value>, Vec<Value>) = std::mem::take(parts)
    .into_iter()
    .partition(|part| part.get("type").and_then(Value::as_str) == Some("image_url"));
  *parts = if text.is_empty() && !images.is_empty() {
    vec![json!({ "type": "text", "text": "The image is in the next message." })]
  } else {
    text
  };
  images
}

fn images_message(images: Vec<Value>) -> Value {
  let mut content = vec![json!({ "type": "text", "text": "Images from the tool results above:" })];
  content.extend(images);
  json!({ "role": "user", "content": content })
}

/// What a reply has said about its tool calls so far.
#[derive(Default)]
struct Reply {
  calls: Vec<SeenCall>,
  /// The call a streamed chunk that names none continues.
  current: Option<usize>,
  finished: bool,
}

#[derive(Default)]
struct SeenCall {
  id: String,
  name: String,
  arguments: String,
  signature: Option<String>,
}

impl Reply {
  /// Read a streamed chunk or a whole reply: number its tool calls, note their
  /// signatures, and have it finish with `tool_calls` if it called any. Says
  /// whether it changed the chunk.
  fn read(&mut self, chunk: &mut Value) -> bool {
    let mut changed = false;
    for choice in chunk.get_mut("choices").and_then(Value::as_array_mut).into_iter().flatten() {
      for (part, streamed) in [("delta", true), ("message", false)] {
        let calls = choice.get_mut(part).and_then(|m| m.get_mut("tool_calls")).and_then(Value::as_array_mut);
        for call in calls.into_iter().flatten() {
          changed |= self.read_call(call, streamed);
        }
      }
      let Some(reason) = choice.get("finish_reason").filter(|r| !r.is_null()) else {
        continue;
      };
      if reason == "stop" && !self.calls.is_empty() {
        choice["finish_reason"] = Value::from("tool_calls");
        changed = true;
      }
      self.finish();
    }
    changed
  }

  fn read_call(&mut self, call: &mut Value, streamed: bool) -> bool {
    let id = call.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string);
    let given = call.get("index").and_then(Value::as_u64).map(|i| i as usize);
    let index = match (given, &id) {
      (Some(index), _) => index,
      (None, Some(id)) => self.calls.iter().position(|c| &c.id == id).unwrap_or(self.calls.len()),
      (None, None) => self.current.unwrap_or(0),
    };
    if self.calls.len() <= index {
      self.calls.resize_with(index + 1, SeenCall::default);
    }
    let seen = &mut self.calls[index];
    if let Some(id) = id {
      seen.id = id;
    }
    if let Some(function) = call.get("function") {
      seen.name.push_str(function.get("name").and_then(Value::as_str).unwrap_or(""));
      seen.arguments.push_str(function.get("arguments").and_then(Value::as_str).unwrap_or(""));
    }
    if let Some(signature) = call.pointer("/extra_content/google/thought_signature").and_then(Value::as_str) {
      seen.signature = Some(signature.to_string());
    }
    self.current = Some(index);
    if given.is_none() && streamed {
      call["index"] = Value::from(index);
      return true;
    }
    false
  }

  /// Keep the reply's signatures for the requests that replay its calls.
  fn finish(&mut self) {
    if std::mem::replace(&mut self.finished, true) {
      return;
    }
    let signed: Vec<_> = self.calls.iter().filter(|c| !c.id.is_empty()).filter_map(|c| Some((c, c.signature.clone()?))).collect();
    if signed.is_empty() {
      return;
    }
    let mut kept = signatures();
    for (call, signature) in signed {
      kept.remember(call_key(&call.id, &call.name, &call.arguments), signature);
    }
  }
}

/// A streamed (server-sent events) reply, read and rewritten a whole line at a
/// time: a line split across chunks waits for the rest.
#[derive(Default)]
struct SseLines {
  pending: Vec<u8>,
  reply: Reply,
}

impl SseLines {
  /// The complete lines so far, rewritten.
  fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
    self.pending.extend_from_slice(chunk);
    let Some(end) = self.pending.iter().rposition(|b| *b == b'\n') else {
      return Vec::new();
    };
    let rest = self.pending.split_off(end + 1);
    let lines = std::mem::replace(&mut self.pending, rest);
    self.rewrite(&lines)
  }

  /// Whatever is left once the reply ends.
  fn finish(&mut self) -> Vec<u8> {
    let tail = std::mem::take(&mut self.pending);
    let out = self.rewrite(&tail);
    self.reply.finish();
    out
  }

  fn rewrite(&mut self, text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for line in text.split_inclusive(|b| *b == b'\n') {
      match self.rewrite_line(line) {
        Some(rewritten) => out.extend_from_slice(&rewritten),
        None => out.extend_from_slice(line),
      }
    }
    out
  }

  /// A `data:` line, rewritten when its chunk changed.
  fn rewrite_line(&mut self, line: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(line).ok()?;
    let body = text.trim_end_matches(['\r', '\n']);
    let ending = &text[body.len()..];
    let payload = body.strip_prefix("data:")?.trim_start();
    if payload == "[DONE]" {
      self.reply.finish();
      return None;
    }
    let mut chunk = serde_json::from_str::<Value>(payload).ok()?;
    self.reply.read(&mut chunk).then(|| format!("data: {chunk}{ending}").into_bytes())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn call(id: &str, name: &str, arguments: &str) -> Value {
    json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } })
  }

  #[test]
  fn requests_keep_only_the_fields_gemini_takes() {
    let request = json!({
      "model": "gemini-3.8-flash",
      "stream": true,
      "stream_options": { "include_usage": true },
      "reasoning_effort": "low",
      "prompt_cache_key": "conversation-1",
      "store": false,
      "copilotToolsFingerprint": "abc",
      "messages": [
        { "role": "system", "content": "You are Fabricator." },
        { "role": "user", "content": [{ "type": "text", "text": "Fix the footer" }] },
        { "role": "assistant", "content": "Done.", "refusal": null, "reasoning_text": "…", "annotations": [] }
      ]
    });
    let clean = prepare_chat_with(request, |_| None);
    let mut keys: Vec<&str> = clean.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["messages", "model", "reasoning_effort", "stream", "stream_options"]);
    let messages = clean["messages"].as_array().unwrap();
    assert_eq!(messages[1]["content"][0]["text"], "Fix the footer");
    assert_eq!(messages[2], json!({ "role": "assistant", "content": "Done." }));
  }

  #[test]
  fn replayed_tool_calls_get_their_thought_signatures_back() {
    let signed = call_key("call_1", "view", r#"{"path":"README.md"}"#);
    let request = json!({ "messages": [
      { "role": "user", "content": "Look at both files" },
      {
        "role": "assistant", "content": null, "refusal": null,
        "tool_calls": [
          // Written out again with a space: still the same call.
          { "index": 0, "id": "call_1", "type": "function", "function": { "name": "view", "arguments": "{\"path\": \"README.md\"}", "parsed": {} } },
          call("call_2", "view", r#"{"path":"package.json"}"#)
        ]
      },
      { "role": "tool", "tool_call_id": "call_1", "content": "# Todo", "is_error": false },
      { "role": "tool", "tool_call_id": "call_2", "content": "{}" },
      // Another model's call, which Gemini never signed.
      { "role": "assistant", "content": null, "tool_calls": [call("toolu_9", "grep", r#"{"pattern":"x"}"#), call("toolu_10", "view", "{}")] },
      { "role": "tool", "tool_call_id": "toolu_9", "content": "" },
      { "role": "tool", "tool_call_id": "toolu_10", "content": "" }
    ]});
    let clean = prepare_chat_with(request, |key| (key == signed).then(|| "sig-1".to_string()));
    let messages = clean["messages"].as_array().unwrap();
    let first = &messages[1]["tool_calls"];
    assert_eq!(
      first[0],
      json!({ "id": "call_1", "type": "function", "function": { "name": "view", "arguments": "{\"path\": \"README.md\"}" },
              "extra_content": { "google": { "thought_signature": "sig-1" } } })
    );
    assert!(first[1].get("extra_content").is_none(), "Gemini signs only the first of parallel calls");
    assert!(messages[1].get("refusal").is_none());
    assert_eq!(messages[2], json!({ "role": "tool", "tool_call_id": "call_1", "content": "# Todo" }));
    let other = &messages[4]["tool_calls"];
    assert_eq!(other[0]["extra_content"]["google"]["thought_signature"], SKIP_SIGNATURE);
    assert!(other[1].get("extra_content").is_none());
  }

  #[test]
  fn images_in_tool_results_move_to_a_user_message_after_them() {
    let image = json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } });
    let request = json!({ "messages": [
      { "role": "assistant", "content": null, "tool_calls": [call("call_1", "view", "{}"), call("call_2", "view", "{}")] },
      { "role": "tool", "tool_call_id": "call_1", "content": [{ "type": "text", "text": "logo.png:" }, image.clone()] },
      { "role": "tool", "tool_call_id": "call_2", "content": [image.clone()] },
      { "role": "assistant", "content": "It's coral." }
    ]});
    let clean = prepare_chat_with(request, |_| None);
    let messages = clean["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[1]["content"], json!([{ "type": "text", "text": "logo.png:" }]));
    assert_eq!(messages[2]["content"], json!([{ "type": "text", "text": "The image is in the next message." }]));
    assert_eq!(messages[3], json!({ "role": "user", "content": [{ "type": "text", "text": "Images from the tool results above:" }, image.clone(), image] }));
    assert_eq!(messages[4]["role"], "assistant");
    // At the end of the conversation, the images close it.
    let last = prepare_chat_with(
      json!({ "messages": [{ "role": "tool", "tool_call_id": "c", "content": [{ "type": "image_url", "image_url": { "url": "x" } }] }] }),
      |_| None,
    );
    assert_eq!(last["messages"][1]["role"], "user");
  }

  #[test]
  fn streamed_tool_calls_get_numbered_and_their_signatures_kept_for_the_next_request() {
    // Gemini's parallel calls: no index, a signature on the first, and "stop".
    let calls = [
      r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_relay_t1","type":"function","function":{"name":"view","arguments":"{\"path\":\"README.md\"}"},"extra_content":{"google":{"thought_signature":"sig-from-gemini"}}}]}}]}"#,
      r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_relay_t2","type":"function","function":{"name":"view","arguments":"{\"path\":\"index.html\"}"}}]}}]}"#,
      r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
    ];
    let stream = format!("{}\n\n{}\n\n{}\n\ndata: [DONE]\n\n", calls[0], calls[1], calls[2]);
    let (first, second) = stream.split_at(stream.find("index.html").unwrap());
    let mut lines = SseLines::default();
    let mut out = lines.push(first.as_bytes());
    assert!(!String::from_utf8_lossy(&out).contains("call_relay_t2"), "the unfinished line waits");
    out.extend(lines.push(second.as_bytes()));
    out.extend(lines.finish());
    let out = String::from_utf8(out).unwrap();
    let chunks: Vec<Value> = out
      .lines()
      .filter_map(|l| l.strip_prefix("data: "))
      .filter(|l| *l != "[DONE]")
      .map(|l| serde_json::from_str(l).unwrap())
      .collect();
    assert_eq!(chunks[0]["choices"][0]["delta"]["tool_calls"][0]["index"], 0);
    assert_eq!(chunks[1]["choices"][0]["delta"]["tool_calls"][0]["index"], 1);
    assert_eq!(chunks[2]["choices"][0]["finish_reason"], "tool_calls");
    assert!(out.ends_with("data: [DONE]\n\n"));

    let replay = prepare_chat(json!({ "messages": [{ "role": "assistant", "content": null, "refusal": null, "tool_calls": [
      call("call_relay_t1", "view", r#"{"path":"README.md"}"#),
      call("call_relay_t2", "view", r#"{"path":"index.html"}"#)
    ] }] }));
    let replayed = &replay["messages"][0]["tool_calls"];
    assert_eq!(replayed[0]["extra_content"]["google"]["thought_signature"], "sig-from-gemini");
    assert!(replayed[1].get("extra_content").is_none());
  }

  #[test]
  fn a_reply_without_tool_calls_passes_through_as_it_came() {
    let stream = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let mut lines = SseLines::default();
    let mut out = lines.push(stream.as_bytes());
    out.extend(lines.finish());
    assert_eq!(String::from_utf8(out).unwrap(), stream);
    // A whole (unstreamed) reply that called a tool finishes with tool_calls.
    let mut reply = json!({ "choices": [{ "message": { "tool_calls": [call("call_9", "view", "{}")] }, "finish_reason": "stop" }] });
    assert!(Reply::default().read(&mut reply));
    assert_eq!(reply["choices"][0]["finish_reason"], "tool_calls");
    assert!(reply["choices"][0]["message"]["tool_calls"][0].get("index").is_none());
  }

  #[test]
  fn signatures_kept_are_capped_to_the_newest() {
    let mut kept = Signatures::default();
    for i in 0..SIGNATURES_KEPT + 2 {
      kept.remember(format!("k{i}"), format!("s{i}"));
    }
    assert_eq!((kept.by_call.len(), kept.order.len()), (SIGNATURES_KEPT, SIGNATURES_KEPT));
    assert!(kept.by_call.get("k0").is_none() && kept.by_call.get("k1").is_none());
    let newest = SIGNATURES_KEPT + 1;
    assert_eq!(kept.by_call.get(&format!("k{newest}")), Some(&format!("s{newest}")));
  }

  #[test]
  fn an_effort_the_model_doesnt_take_is_left_out() {
    let none: &[String] = &[];
    let some = ["low".to_string(), "high".to_string()];
    // The runtime asks for medium on the Responses wire; GPT-4.1 and Grok Build take no effort.
    let request = json!({ "model": "grok-build-0.1", "reasoning": { "effort": "medium", "summary": "auto" }, "include": ["reasoning.encrypted_content"] });
    let fitted = fit_effort(request.clone(), true, Some(none));
    assert_eq!(fitted["reasoning"], json!({ "summary": "auto" }));
    assert_eq!(fitted["include"], json!(["reasoning.encrypted_content"]));
    assert_eq!(fit_effort(request.clone(), true, Some(&some))["reasoning"], json!({ "summary": "auto" }));
    let high = json!({ "reasoning": { "effort": "high" } });
    assert_eq!(fit_effort(high.clone(), true, Some(&some)), high);
    // A model the user didn't save goes as it is.
    assert_eq!(fit_effort(request.clone(), true, None), request);
    // Chat completions carry it at the top level.
    let chat = json!({ "model": "gemma-4-31b-it", "reasoning_effort": "medium", "messages": [] });
    assert!(fit_effort(chat.clone(), false, Some(none)).get("reasoning_effort").is_none());
    let low = json!({ "reasoning_effort": "low" });
    assert_eq!(fit_effort(low.clone(), false, Some(&some)), low);
  }

  #[test]
  fn messages_that_call_no_tools_get_their_text() {
    let request = json!({ "messages": [
      { "role": "user", "content": "Build a task tracker" },
      // A reply cut off while reasoning, which the runtime asks the model to go on from.
      { "role": "assistant", "content": null, "reasoning_text": "The starter Item entity…" },
      { "role": "assistant" },
      { "role": "assistant", "content": null, "tool_calls": [call("call_1", "view", "{}")] },
      { "role": "tool", "tool_call_id": "call_1", "content": [{ "type": "text", "text": "{}" }] },
      { "role": "assistant", "content": null, "tool_calls": [] },
      { "role": "user", "content": "Please continue from where you left off." }
    ]});
    let filled = fill_in_content(request.clone());
    let (before, after) = (request["messages"].as_array().unwrap(), filled["messages"].as_array().unwrap());
    assert_eq!(after[1], json!({ "role": "assistant", "content": "", "reasoning_text": "The starter Item entity…" }));
    assert_eq!(after[2], json!({ "role": "assistant", "content": "" }));
    assert_eq!(after[5]["content"], "");
    for i in [0, 3, 4, 6] {
      assert_eq!(after[i], before[i], "message {i}");
    }
  }

  /// An Ollama running `model` with `context` tokens of context.
  async fn fake_ollama(model: &'static str, context: u64) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
      while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(async move {
          let service = service_fn(move |req: Request<Incoming>| async move {
            let body = match req.uri().path() {
              "/api/ps" => json!({ "models": [{ "name": model, "model": model, "context_length": context }] }),
              _ => json!({}),
            };
            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(body.to_string()))))
          });
          let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
      }
    });
    root
  }

  #[tokio::test]
  async fn ollama_replies_stop_when_the_models_context_is_too_short() {
    let client = reqwest::Client::new();
    // Ollama's default on a 24 GB GPU, for a model sessions count on 64K for.
    let root = fake_ollama("qwen3.8:latest", 32_768).await;
    let (status, message) = check_context(&client, &root, "qwen3.8:latest", 64_000).await.unwrap_err();
    assert_eq!((status, message), (StatusCode::BAD_REQUEST, too_short("qwen3.8:latest", 32_768, 64_000)));
    assert!(check_context(&client, &root, "qwen3.8:latest", 32_768).await.is_ok());
    // When Ollama doesn't say, or doesn't answer, the reply goes on as it is.
    assert!(check_context(&client, &root, "gpt-oss:120b-cloud", 64_000).await.is_ok());
    let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap();
    assert!(check_context(&client, &format!("http://{closed}"), "qwen3.8:latest", 64_000).await.is_ok());
  }

  #[test]
  fn urls_split_into_the_providers_host_and_path() {
    let google = "https://generativelanguage.googleapis.com/v1beta/openai";
    assert_eq!(origin_of(google), "https://generativelanguage.googleapis.com");
    assert_eq!(path_of(google), "/v1beta/openai");
    assert_eq!(path_of("https://api.example.com"), "");
    assert_eq!(origin_of("http://192.168.1.20:11434/v1"), "http://192.168.1.20:11434");
  }

  #[tokio::test]
  async fn the_relay_answers_only_under_its_token_and_only_for_relayed_providers() {
    let google = catalog::find("google").unwrap();
    let url = base_url(google, google.base_url).unwrap();
    assert!(url.starts_with("http://127.0.0.1:") && url.ends_with("/google/v1beta/openai"), "{url}");
    let ollama = catalog::find("ollama").unwrap();
    assert!(base_url(ollama, "http://192.168.1.20:11434/v1").unwrap().ends_with("/ollama/v1"));
    let client = reqwest::Client::new();
    let port = url.trim_start_matches("http://127.0.0.1:").split('/').next().unwrap();
    for path in [
      "/guess/google/v1beta/openai/models".to_string(),
      format!("{}/anthropic/v1/models", url.trim_end_matches("/google/v1beta/openai")),
    ] {
      let target = if path.starts_with("http") { path } else { format!("http://127.0.0.1:{port}{path}") };
      let status = client.get(&target).send().await.unwrap().status();
      assert_eq!(status, reqwest::StatusCode::NOT_FOUND, "{target}");
    }
  }
}
