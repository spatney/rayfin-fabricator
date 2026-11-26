use std::sync::Mutex;

use serde_json::json;

use super::*;

/// A folder of its own for a test, with the kit, deleted afterwards.
struct Folder(PathBuf);

impl Folder {
  fn new() -> Folder {
    let path = std::env::temp_dir().join(format!("fab-tools-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join(KIT_FILE), KIT).unwrap();
    Folder(path)
  }
}

impl Drop for Folder {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

fn node() -> bool {
  which::which("node").is_ok()
}

const ECHO: &str = r#"import { serve } from './kit.mjs'
serve({
  name: 'echo',
  tools: [
    {
      name: 'echo',
      description: 'Say it back.',
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      readOnly: true,
      async run({ text }, tool) { return `${text} (${tool.env('ECHO_KEY')})` }
    },
    {
      name: 'save_dot',
      description: 'Save a one-pixel picture.',
      async run(_, tool) {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
        const saved = await tool.save('public/dot.png', png)
        return [tool.text(`Saved ${saved}`), tool.image(png, 'image/png')]
      }
    },
    {
      name: 'wait',
      description: 'Wait until it is cancelled.',
      async run(_, tool) { await new Promise((_, reject) => tool.signal.addEventListener('abort', () => reject(new Error('aborted')))) }
    }
  ]
})
"#;

#[test]
fn copilot_may_read_pages_on_the_web_but_not_this_computer_or_a_private_network() {
  for url in [
    "https://platform.openai.com/docs/api-reference/images",
    "https://developers.openai.com/api/reference/resources/images",
    "https://8.8.8.8/x",
    "https://[2606:4700::1111]/",
  ] {
    assert!(public_page(url), "{url}");
  }
  for url in [
    "http://platform.openai.com/docs",
    "https://localhost:3000/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://127.0.0.1/",
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.1.1/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://user:pass@example.com/",
    "https://intranet/",
    "file:///C:/Windows/win.ini",
    "not a url",
  ] {
    assert!(!public_page(url), "{url}");
  }
}

fn request(body: Value) -> PermissionRequestData {
  serde_json::from_value(json!({ "requestId": "r1", "permissionRequest": body, "promptRequest": body })).unwrap()
}

#[test]
fn a_session_that_makes_a_tool_reads_the_web_and_saves_the_tool_and_nothing_else() {
  assert!(permitted(&request(json!({ "kind": "url", "url": "https://platform.openai.com/docs" }))));
  assert!(permitted(&request(json!({ "kind": "custom-tool", "toolName": SAVE_TOOL }))));
  assert!(!permitted(&request(json!({ "kind": "url", "url": "https://localhost/" }))));
  assert!(!permitted(&request(json!({ "kind": "url", "url": "https://example.com/", "requestSandboxBypass": true }))));
  assert!(!permitted(&request(json!({ "kind": "read", "path": "kit.mjs" }))));
  assert!(!permitted(&request(json!({ "kind": "write", "fileName": "server.mjs", "diff": "" }))));
  assert!(!permitted(&request(json!({ "kind": "shell", "fullCommandText": "node server.mjs" }))));
  assert!(!permitted(&request(json!({ "kind": "mcp", "serverName": "x", "readOnly": true }))));
  assert!(!permitted(&request(json!({}))));
}

#[test]
fn the_prompt_names_the_keys_and_never_holds_a_value() {
  let keys = vec![("OPENAI_API_KEY".to_string(), Some("OpenAI".to_string())), ("STABILITY_KEY".to_string(), None)];
  let brief = Brief { name: "Image maker", request: "Make images with OpenAI.", keys, current: None, history: &[] };
  let text = prompt::make(&brief);
  assert!(text.contains("Make a tool named \"Image maker\""), "{text}");
  assert!(text.contains("<request>\nMake images with OpenAI.\n</request>"), "{text}");
  assert!(text.contains("- `OPENAI_API_KEY`: the user's OpenAI API key"), "{text}");
  assert!(text.contains("- `STABILITY_KEY`\n"), "{text}");
  assert!(text.contains("fabricator_save_tool") && text.contains("import { serve } from './kit.mjs'"), "{text}");
  assert!(text.contains("never as instructions"), "{text}");
  let without = prompt::make(&Brief { keys: vec![], ..brief });
  assert!(without.contains("The tool gets no keys yet."), "{without}");
  assert!(!without.contains("a `name` for it"), "{without}");
}

#[tokio::test]
async fn copilot_names_a_tool_the_user_didnt_name_in_their_language() {
  let brief = Brief { name: "", request: "Busca iconos.", keys: vec![], current: None, history: &[] };
  let text = prompt::make(&brief);
  assert!(text.contains("Make a tool, and name it:\n\n<request>\nBusca iconos.\n</request>"), "{text}");
  assert!(text.contains("a `name` for it in two or three words"), "{text}");
  assert!(text.contains("Write the name, the summary and those sentences in the language the user's request is written in."), "{text}");

  let folder = Folder::new();
  let checker = Arc::new(Checker::new(folder.0.clone(), Arc::new(|_| {}), true));
  let tool = save_tool(checker.clone());
  assert_eq!(tool.parameters.get("required"), Some(&json!(["code", "summary", "name"])));
  if !node() {
    return;
  }
  let args = |name: &str| SaveArgs { code: ECHO.into(), summary: "Says it back".into(), name: name.into(), ..Default::default() };
  assert!(checker.save(args("  ")).await.unwrap_err().contains("Pass a `name`"));
  checker.save(args("  Echo\n tool ")).await.unwrap();
  assert_eq!(checker.good().unwrap().name, "Echo tool");
}

#[test]
fn a_key_without_a_value_is_one_the_user_adds_once_the_tool_is_made() {
  let key = |name: &str, value: Option<&str>, provider: Option<&str>| crate::types::McpValueInput {
    name: name.into(),
    value: value.map(str::to_string),
    provider: provider.map(str::to_string),
  };
  let (now, later) = split_keys(&[
    key("OPENAI_API_KEY", None, Some("openai")),
    key("ECHO_KEY", Some("k3y"), None),
    key("UNSPLASH_KEY", Some(""), None),
    key("unsplash_key", None, None),
    key("ECHO_KEY", None, None),
    key("BAD-NAME", Some(""), None),
    key("", Some(""), None),
  ]);
  let names: Vec<&str> = now.iter().map(|k| k.name.as_str()).collect();
  // An empty row and a bad name stay, for the usual checks to leave out or refuse.
  assert_eq!(names, ["OPENAI_API_KEY", "ECHO_KEY", "BAD-NAME", ""]);
  assert_eq!(later, ["UNSPLASH_KEY"]);
}

#[test]
fn undoing_a_change_puts_back_the_code_and_what_was_asked() {
  let folder = Folder::new();
  assert_eq!(restore_previous(&folder.0).unwrap_err(), "There's no change to undo.");
  std::fs::write(folder.0.join(SERVER_FILE), "// changed").unwrap();
  std::fs::write(folder.0.join(PREVIOUS_FILE), "// before").unwrap();
  restore_previous(&folder.0).unwrap();
  assert_eq!(std::fs::read_to_string(folder.0.join(SERVER_FILE)).unwrap(), "// before");
  assert!(!folder.0.join(PREVIOUS_FILE).exists());

  let mut made = MadeTool {
    summary: "Makes transparent images".into(),
    requests: vec!["Make images.".into(), "Allow transparency.".into()],
    updated_at: "then".into(),
    previous_summary: Some("Makes images".into()),
  };
  undone(&mut made);
  assert_eq!((made.summary.as_str(), made.requests.as_slice()), ("Makes images", ["Make images.".to_string()].as_slice()));
  assert!(made.previous_summary.is_none() && made.updated_at != "then");
}

#[test]
fn a_change_starts_from_the_code_and_what_was_asked_before() {
  let history = vec!["Make images.".to_string()];
  let brief = Brief {
    name: "Image maker",
    request: "Let chat pick the size.",
    keys: vec![],
    current: Some("import { serve } from './kit.mjs'\nserve({ tools: [] })\n"),
    history: &history,
  };
  let text = prompt::make(&brief);
  assert!(text.contains("Change the tool \"Image maker\""), "{text}");
  assert!(text.contains("```js\nimport { serve } from './kit.mjs'\nserve({ tools: [] })\n```"), "{text}");
  assert!(text.contains("<request>\nMake images.\n</request>"), "{text}");
  assert!(text.contains("<request>\nLet chat pick the size.\n</request>"), "{text}");
  let again = prompt::retry(&brief, Some("broken();"), Some("It stopped. SyntaxError"), None);
  assert!(again.contains("```js\nbroken();\n```") && again.contains("When Fabricator started it: It stopped. SyntaxError"), "{again}");
  let unsaved = prompt::retry(&brief, None, None, Some("OpenAI retired that model."));
  assert!(unsaved.contains("You didn't save it with `fabricator_save_tool`."), "{unsaved}");
  assert!(unsaved.contains("<said>\nOpenAI retired that model.\n</said>"), "{unsaved}");
  assert!(unsaved.contains("truly can't be made, don't save one"), "{unsaved}");
  assert_eq!(didnt_work(None, " "), "Copilot finished without making the tool. Try again, or describe it in more detail.");
  assert_eq!(didnt_work(None, "It can't."), "Copilot finished without making the tool. It said: It can't.");
  assert!(didnt_work(Some(Failure::Slow), "ignored").starts_with("Copilot couldn't make a tool that starts."));
}

#[test]
fn what_the_user_asks_for_and_the_keys_a_tool_reads_are_checked() {
  assert_eq!(request_text("  Make images.  ").unwrap(), "Make images.");
  assert_eq!(request_text(" \n ").unwrap_err(), "Describe what the tool should do.");
  assert!(request_text(&"x".repeat(MAX_REQUEST + 1)).unwrap_err().contains("4000"));
  assert_eq!(keys_from(&["OPENAI_API_KEY".into(), " openai_api_key ".into(), "".into()]).unwrap(), ["OPENAI_API_KEY"]);
  assert!(keys_from(&["MY-KEY".into()]).is_err());
  assert_eq!(one_line("  Makes   images\nwith OpenAI ", 120), "Makes images with OpenAI");
  assert_eq!(one_line("abcdef", 3), "abc…");
}

#[test]
fn a_shared_tool_holds_no_keys_values_and_only_a_kit_tool_is_read() {
  let shared = SharedTool {
    fabricator_tool: SHARED_FORMAT,
    name: "Image maker".into(),
    summary: "Makes images".into(),
    requests: vec!["Make images.".into()],
    keys: vec![SharedToolKey { name: "OPENAI_API_KEY".into(), provider: Some("openai".into()) }],
    read_only: false,
    code: "import { serve } from './kit.mjs'".into(),
  };
  let text = serde_json::to_string(&shared).unwrap();
  assert_eq!(
    serde_json::from_str::<Value>(&text).unwrap()["keys"],
    json!([{ "name": "OPENAI_API_KEY", "provider": "openai" }])
  );
  let read = shared_from(&format!("\u{feff}{text}")).unwrap();
  assert_eq!((read.name.as_str(), read.keys.len()), ("Image maker", 1));
  assert_eq!(shared_from("{}").unwrap_err(), "That file isn't a tool shared from Fabricator.");
  assert_eq!(shared_from("not json").unwrap_err(), "That file isn't a tool shared from Fabricator.");
  let newer = text.replace("\"fabricatorTool\":1", "\"fabricatorTool\":2");
  assert!(shared_from(&newer).unwrap_err().contains("newer version"));
  let no_kit = text.replace("./kit.mjs", "./other.mjs");
  assert!(shared_from(&no_kit).is_err());
  let bad_key = text.replace("OPENAI_API_KEY", "OPENAI KEY");
  assert!(shared_from(&bad_key).is_err());
}

#[test]
fn a_shared_tools_name_is_made_unique() {
  let existing: Vec<McpServerEntry> = ["Image maker", "Image maker 2"]
    .iter()
    .map(|name| McpServerEntry { id: name.to_lowercase().replace(' ', "-"), name: name.to_string(), ..Default::default() })
    .collect();
  assert_eq!(unique_name("Charts", &existing), "Charts");
  assert_eq!(unique_name("image MAKER", &existing), "image MAKER 3");
  assert_eq!(unique_name("  ", &existing), "Tool");
}

#[test]
fn a_try_shows_text_and_real_pictures_only() {
  let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
  let svg = base64::engine::general_purpose::STANDARD.encode(b"<svg onload=alert(1)>");
  let result = json!({
    "content": [
      { "type": "text", "text": "Saved public/dot.png" },
      { "type": "image", "data": png, "mimeType": "image/png" },
      { "type": "image", "data": svg, "mimeType": "image/svg+xml" },
      { "type": "resource", "resource": { "uri": "file:///x" } }
    ]
  });
  let shown = contents(&result);
  assert_eq!(shown[0], ToolTryContent::Text { text: "Saved public/dot.png".into() });
  assert_eq!(shown[1], ToolTryContent::Image { url: format!("data:image/png;base64,{png}") });
  assert!(matches!(&shown[2], ToolTryContent::Text { text } if text.contains("left out")));
  assert!(matches!(&shown[3], ToolTryContent::Text { text } if text.contains("file:///x")));
  let structured = contents(&json!({ "content": [], "structuredContent": { "ok": true } }));
  assert!(matches!(&structured[0], ToolTryContent::Text { text } if text.contains("\"ok\": true")));
}

#[test]
fn a_try_lists_the_files_it_saved_or_changed() {
  let folder = Folder::new();
  std::fs::write(folder.0.join("old.txt"), "old").unwrap();
  let before = snapshot(&folder.0);
  std::fs::create_dir_all(folder.0.join("public")).unwrap();
  std::fs::write(folder.0.join("public").join("dot.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
  std::fs::write(folder.0.join("note.txt"), "new").unwrap();
  let files = changed_files(&folder.0, &before);
  let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
  assert_eq!(paths, ["note.txt", "public/dot.png"]);
  assert!(files[0].image.is_none());
  assert!(files[1].image.as_deref().unwrap().starts_with("data:image/png;base64,"));
}

#[tokio::test]
async fn fabricator_starts_a_kit_tool_lists_its_tools_and_calls_one_with_its_keys() {
  if !node() {
    return;
  }
  let folder = Folder::new();
  let script = folder.0.join(SERVER_FILE);
  std::fs::write(&script, ECHO).unwrap();
  let tools = check(&script, &folder.0).await.unwrap();
  let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
  assert_eq!(names, ["echo", "save_dot", "wait"]);
  assert!(tools[0].read_only && !tools[1].read_only);
  assert_eq!(tools[0].input_schema["required"], json!(["text"]));

  let cancel = CancelToken::new();
  let env = [("ECHO_KEY".to_string(), "k3y".to_string())];
  let mut server = Server::start(&script, &folder.0, &env).unwrap();
  server.tools(None).await.unwrap();
  let said = server.call("echo", json!({ "text": "hi" }), Duration::from_secs(10), &cancel).await.unwrap();
  assert_eq!(said["content"][0]["text"], "hi (k3y)");
  let saved = server.call("save_dot", json!({}), Duration::from_secs(10), &cancel).await.unwrap();
  assert_eq!(saved["content"][0]["text"], "Saved public/dot.png");
  assert!(folder.0.join("public").join("dot.png").is_file());
  let shown = contents(&saved);
  assert!(matches!(&shown[1], ToolTryContent::Image { url } if url.starts_with("data:image/png;base64,")));

  // A call that's stopped stops waiting for it.
  let stop = cancel.clone();
  tokio::spawn(async move {
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop.cancel();
  });
  let waited = server.call("wait", json!({}), Duration::from_secs(10), &cancel).await;
  assert_eq!(waited.unwrap_err(), Failure::Cancelled);

  // Without its key, the tool says how to add it.
  let mut keyless = Server::start(&script, &folder.0, &[]).unwrap();
  keyless.tools(None).await.unwrap();
  let missing = keyless.call("echo", json!({ "text": "hi" }), Duration::from_secs(10), &CancelToken::new()).await.unwrap();
  assert_eq!(missing["isError"], true);
  assert!(missing["content"][0]["text"].as_str().unwrap().contains("ECHO_KEY isn't set"), "{missing}");
  // Stopped, a server lets go of its folder.
  server.stop().await;
  keyless.stop().await;
}

#[tokio::test]
async fn a_tool_that_doesnt_start_says_why() {
  if !node() {
    return;
  }
  let folder = Folder::new();
  let script = folder.0.join(SERVER_FILE);
  std::fs::write(&script, "import { serve } from './kit.mjs'\nserve({ tools: [{ name: 'bad name', description: 'x', run() {} }] })\n").unwrap();
  match check(&script, &folder.0).await.unwrap_err() {
    Failure::Stopped(output) => assert!(output.contains("its name must be 1 to 64 letters"), "{output}"),
    other => panic!("{other:?}"),
  }
  std::fs::write(&script, "import { serve } from './kit.mjs'\nserve({ tools: [ }\n").unwrap();
  match check(&script, &folder.0).await.unwrap_err() {
    Failure::Stopped(output) => assert!(output.contains("SyntaxError"), "{output}"),
    other => panic!("{other:?}"),
  }
}

#[tokio::test]
async fn saving_keeps_the_last_tool_that_started_and_tells_copilot_what_to_fix() {
  if !node() {
    return;
  }
  let folder = Folder::new();
  let seen = Arc::new(Mutex::new(Vec::new()));
  let progress: Progress = {
    let seen = seen.clone();
    Arc::new(move |event| seen.lock().unwrap().push(event))
  };
  let checker = Checker::new(folder.0.clone(), progress, false);
  let save = |code: &str, summary: &str| SaveArgs {
    code: code.into(),
    summary: summary.into(),
    keys: vec!["ECHO_KEY".into()],
    ..Default::default()
  };

  let refused = checker.save(save("console.log('no kit')", "x")).await.unwrap_err();
  assert!(refused.contains("Build the tool on the kit"), "{refused}");
  assert!(checker.save(save(ECHO, " ")).await.unwrap_err().contains("summary"));

  let works = checker.save(save(ECHO, "Says it back")).await.unwrap();
  assert!(works.contains("offers: echo, save_dot, wait"), "{works}");
  let broken = checker.save(save("import { serve } from './kit.mjs'\nthrow new Error('boom')\n", "Broken")).await.unwrap_err();
  assert!(broken.starts_with("It didn't start. It stopped.") && broken.contains("boom"), "{broken}");

  let good = checker.good().unwrap();
  assert_eq!((good.summary.as_str(), good.keys.as_slice()), ("Says it back", ["ECHO_KEY".to_string()].as_slice()));
  assert_eq!(good.tools.len(), 3);
  let (code, failed) = checker.last();
  assert!(code.unwrap().contains("boom"));
  assert!(matches!(failed, Some(Failure::Stopped(_))));
  let events = seen.lock().unwrap().clone();
  // The dialog gets each version's whole code as it was saved, then how its check went.
  assert_eq!(events[0], ToolMakerEvent::Writing { code: ECHO.into() });
  assert_eq!(events[1], ToolMakerEvent::Checking);
  assert_eq!(events[2], ToolMakerEvent::Works { tools: vec!["echo".into(), "save_dot".into(), "wait".into()] });
  assert!(matches!(&events[3], ToolMakerEvent::Writing { code } if code.contains("boom")));
  assert_eq!(events[4], ToolMakerEvent::Checking);
  assert!(matches!(&events[5], ToolMakerEvent::Failed { error } if error.contains("boom")));

  // A session that used up its saves stops; the one that starts again gets its own.
  checker.attempts.lock().unwrap().saves = MAX_SAVES;
  assert!(checker.save(save(ECHO, "Says it back")).await.unwrap_err().contains("too many times"));
  checker.fresh_budget();
  assert!(checker.save(save(ECHO, "Says it back")).await.is_ok());
}

#[tokio::test]
async fn a_shared_tool_is_added_only_as_it_was_reviewed() {
  let folder = Folder::new();
  let file = folder.0.join("image-maker.fabricator-tool.json");
  let shared = |code: &str| {
    json!({ "fabricatorTool": 1, "name": "Image maker", "summary": "Makes images", "keys": [{ "name": "OPENAI_API_KEY" }], "code": code })
      .to_string()
  };
  std::fs::write(&file, shared("import { serve } from './kit.mjs'\n// reviewed\n")).unwrap();
  let (reviewed, digest) = read_shared(&file).unwrap();
  assert!(reviewed.code.contains("reviewed") && digest.len() == 64);
  // Changed after the review: refused before anything runs or is saved.
  std::fs::write(&file, shared("import { serve } from './kit.mjs'\n// swapped\n")).unwrap();
  let input = ToolImportInput { path: file.to_string_lossy().into_owned(), digest, name: "Image maker".into(), ..Default::default() };
  assert_eq!(import(&input).await.unwrap_err(), "The file changed after you reviewed it. Add the shared tool again to review it as it is now.");
  assert_ne!(read_shared(&file).unwrap().1, input.digest);
}

#[test]
fn the_code_reads_as_far_as_copilot_has_written_it() {
  let args = r#"{"summary": "Says hi", "keys": ["A", "B"], "code": "import { serve } from './kit.mjs'\nconst q = \"hi\" // caf\u00e9 \ud83d\ude00\n"#;
  assert_eq!(partial_string(args, "code").unwrap(), "import { serve } from './kit.mjs'\nconst q = \"hi\" // café 😀\n");
  // An escape the stream cut off waits for the rest of it.
  assert_eq!(partial_string(r#"{"code":"a\"#, "code").unwrap(), "a");
  assert_eq!(partial_string(r#"{"code":"a\u00"#, "code").unwrap(), "a");
  assert_eq!(partial_string(r#"{"code":"a\ud83d\ude"#, "code").unwrap(), "a");
  assert_eq!(partial_string(r#"{"code":"a\ud83dx"#, "code").unwrap(), "a\u{fffd}");
  // There's none until it starts, and a string that only mentions it isn't it.
  assert_eq!(partial_string("", "code"), None);
  assert_eq!(partial_string(r#"{"summary":"Says \"code\": hi","#, "code"), None);
  assert_eq!(partial_string(r#"{"summary":"Says \"code\": hi","code":"x"}"#, "code").unwrap(), "x");
  assert_eq!(partial_string(r#"{"keys":[1, {"a":"]"}], "n": null, "code" : "ok"#, "code").unwrap(), "ok");
  assert_eq!(partial_string(r#"{"code": 12}"#, "code"), None);
  assert_eq!(tail("one two three", 20), "one two three");
  assert_eq!(tail("one two three four", 9), "…four");
}

#[test]
fn the_model_what_copilot_says_and_its_code_reach_the_dialog_as_they_stream() {
  let seen = Arc::new(Mutex::new(Vec::new()));
  let progress: Progress = {
    let seen = seen.clone();
    Arc::new(move |event| seen.lock().unwrap().push(event))
  };
  let mut live = Live::new(progress);
  let says = |id: &str, text: &str| json!({ "messageId": id, "deltaContent": text });
  let writes = |tool: &str, input: &str| json!({ "toolCallId": "c1", "toolName": tool, "inputDelta": input });
  live.feed("session.auto_mode_resolved", &json!({ "chosenModel": "gpt-6.1-terra" }));
  live.feed("assistant.turn_start", &json!({ "turnId": "0" }));
  live.feed("assistant.turn_start", &json!({ "turnId": "1" }));
  live.feed("assistant.message_delta", &says("m1", "I'll check "));
  // Deltas that come close together wait, across the streams they interleave with.
  live.feed("assistant.message_delta", &says("m1", "the docs."));
  live.feed("assistant.streaming_delta", &json!({ "totalResponseSizeBytes": 30 }));
  live.feed("assistant.tool_call_delta", &writes("web_fetch", r#"{"url":"https://x"}"#));
  live.feed("assistant.message", &json!({}));
  live.feed("assistant.tool_call_delta", &writes(SAVE_TOOL, r#"{"code":"import"#));
  live.feed("assistant.tool_call_delta", &writes(SAVE_TOOL, r#" { serve }\n"#));
  live.feed("external_tool.requested", &json!({}));
  live.feed("assistant.message_delta", &says("m2", "Made it."));
  live.feed("assistant.message", &json!({}));
  assert_eq!(
    seen.lock().unwrap().clone(),
    [
      ToolMakerEvent::Started { model: Some("gpt-6.1-terra".into()) },
      ToolMakerEvent::Saying { text: "I'll check".into() },
      ToolMakerEvent::Saying { text: "I'll check the docs.".into() },
      ToolMakerEvent::Writing { code: "import".into() },
      ToolMakerEvent::Writing { code: "import { serve }\n".into() },
      // A new message starts afresh.
      ToolMakerEvent::Saying { text: "Made it.".into() },
    ]
  );
}