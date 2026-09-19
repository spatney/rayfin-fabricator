//! Correlated Design Studio bridge over the existing all-frame injection path.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, State, Url};

use super::design_contract::{self as contract, DesignConnection, DesignSnapshot, ValidatedCommand};
use super::{design_store, dev_server::DevServers, preview, store};

#[derive(Default)]
pub struct StudioState {
  gate: tokio::sync::Mutex<()>,
  current: Mutex<Option<StudioSession>>,
}

#[derive(Clone)]
struct StudioSession {
  project_id: String,
  options: DesignConnection,
  document_id: Option<String>,
}

fn url(value: &str) -> Result<Url, String> {
  let u = Url::parse(value).map_err(|_| "Invalid Design app URL.")?;
  if !matches!(u.scheme(), "http" | "https")
    || u.host_str().is_none()
    || !u.username().is_empty()
    || u.password().is_some()
  {
    return Err("Design requires an HTTP(S) app URL without embedded credentials.".into());
  }
  Ok(u)
}

fn same_app(actual: &Url, expected: &Url) -> bool {
  if actual.origin() != expected.origin() {
    return false;
  }
  for (key, value) in expected.query_pairs() {
    if matches!(
      key.to_ascii_lowercase().as_str(),
      "id" | "itemid" | "workspaceid" | "reportid" | "appid" | "tenantid" | "ctid"
    ) && !actual.query_pairs().any(|(k, v)| k.eq_ignore_ascii_case(&key) && v == value)
    {
      return false;
    }
  }
  let base = expected.path().trim_end_matches('/');
  base.is_empty() || actual.path() == base || actual.path().strip_prefix(base).is_some_and(|p| p.starts_with('/'))
}

fn validate_project(app: &AppHandle, session: &StudioSession) -> Result<(), String> {
  let project = store::active_project().ok_or("Select a project before entering Design.")?;
  if project.id != session.project_id {
    return Err("This Design session belongs to a different project. Reconnect to the selected app.".into());
  }
  let target = url(&session.options.app_url)?;
  let current = preview::studio_url(app)?;
  let local = target.origin().ascii_serialization() == "http://localhost:5173";
  if local {
    if session.options.embedded || !app.state::<DevServers>().owns_project(&project.id) {
      return Err(
        "Design local preview must be started for this project by Fabricator. Start Local preview and retry.".into(),
      );
    }
  } else {
    let known = project.last_deploy.as_ref().is_some_and(|d| {
      [&d.url, &d.api_url]
        .iter()
        .filter_map(|u| u.as_deref())
        .filter_map(|u| url(u).ok())
        .any(|approved| same_app(&target, &approved))
    });
    if !known {
      return Err(
        "The Design app URL does not match this project's recorded deployment. Refresh deployment status and retry."
          .into(),
      );
    }
  }
  if session.options.embedded {
    let portal = project
      .last_deploy
      .as_ref()
      .and_then(|d| d.portal_url.as_deref())
      .ok_or("This project has no recorded Fabric portal URL.")?;
    if !same_app(&current, &url(portal)?) {
      return Err("The Fabric preview is not showing this project's portal page. Complete sign-in or reopen the app before Design.".into());
    }
    if target.origin() == current.origin() {
      return Err("Design cannot edit the Fabric shell. Choose the deployed app frame.".into());
    }
  } else if !same_app(&current, &target) {
    return Err(
      "The preview navigated away from the Design app. Complete sign-in or reopen the app before editing.".into(),
    );
  }
  Ok(())
}

fn script(method: &str, args: &Value) -> Result<String, String> {
  let argument = serde_json::to_string(args).map_err(|e| e.to_string())?;
  Ok(format!(
    "(function(){{try{{var d=window.__rayfinDesign&&window.__rayfinDesign.studio;if(!d)throw new Error('Design Studio controller is unavailable; reload the preview');return d.{method}({argument})||null}}catch(e){{return {{__studioError:String(e&&e.message||e)}}}}}})()"
  ))
}

fn parse_snapshot(value: Value) -> Result<Option<DesignSnapshot>, String> {
  if value.is_null() {
    return Ok(None);
  }
  let snapshot: DesignSnapshot =
    serde_json::from_value(value).map_err(|e| format!("Design controller snapshot does not match protocol 1: {e}"))?;
  contract::snapshot(&snapshot)?;
  Ok(Some(snapshot))
}

fn matching_snapshot(
  snapshot: &DesignSnapshot,
  session: &StudioSession,
  command: Option<&ValidatedCommand>,
) -> Result<bool, String> {
  if snapshot.session_id != session.options.session_id {
    return Ok(false);
  }
  if let Some(command) = command {
    if snapshot.document_id != command.document_id {
      return Err("The app document changed during the Design command. Re-select the element and retry.".into());
    }
    if !snapshot.acknowledged.contains(&command.command_id) {
      return Ok(false);
    }
  }
  if let Some(error) = &snapshot.error {
    return Err(error.clone());
  }
  if !snapshot.enabled {
    return Ok(false);
  }
  if snapshot.revision < session.options.revision {
    return Err(
      "The Design controller returned an older journal revision. Reconnect to recover the saved draft.".into(),
    );
  }
  Ok(true)
}

fn accept(state: &StudioState, session: &StudioSession, snapshot: &DesignSnapshot) -> Result<(), String> {
  let mut current = state.current.lock().map_err(|_| "Design session state is unavailable.")?;
  let active = current.as_mut().ok_or("Design session was disconnected.")?;
  if active.project_id != session.project_id || active.options.session_id != session.options.session_id {
    return Err("Ignored a stale Design controller response.".into());
  }
  active.document_id = Some(snapshot.document_id.clone());
  active.options.history = snapshot.history.clone();
  active.options.cursor = snapshot.cursor;
  active.options.revision = snapshot.revision;
  active.options.route = Some(snapshot.route.clone());
  Ok(())
}

fn verification_complete(command: &ValidatedCommand, snapshot: &DesignSnapshot) -> Result<(), String> {
  if command.value["type"] != "verify" {
    return Ok(());
  }
  let history: Vec<contract::DesignTransaction> =
    serde_json::from_value(command.value["history"].clone()).map_err(|e| e.to_string())?;
  let cursor = command.value["cursor"].as_u64().ok_or("Invalid Design verification cursor.")? as usize;
  let expected: std::collections::HashSet<_> = history.iter().take(cursor).map(|t| t.id.as_str()).collect();
  let outcomes =
    snapshot.verification.as_ref().ok_or("The Design controller did not return fresh-app verification outcomes.")?;
  let actual: std::collections::HashSet<_> = outcomes.iter().map(|v| v.transaction_id.as_str()).collect();
  if expected != actual || outcomes.len() != actual.len() {
    return Err(
      "Fresh-app verification must report every requested transaction exactly once; the draft was not marked applied."
        .into(),
    );
  }
  Ok(())
}

fn validate_verification_journal(project_id: &str, command: &ValidatedCommand) -> Result<(), String> {
  let _disk = design_store::lock()?;
  let project = design_store::project(project_id)?;
  let receipt = project.load_receipt()?.ok_or("There is no deployed Design Apply to verify.")?;
  validate_verification_receipt(&receipt.receipt, &design_store::source_snapshot(&project.project_path)?.revision)?;
  let baseline = project.load_baseline(&receipt.receipt.id)?;
  let history: Vec<contract::DesignTransaction> =
    serde_json::from_value(command.value["history"].clone()).map_err(|e| e.to_string())?;
  let cursor = command.value["cursor"].as_u64().ok_or("Invalid Design verification cursor.")? as usize;
  if cursor != baseline.draft.cursor || history.get(..cursor) != baseline.draft.history.get(..baseline.draft.cursor) {
    return Err("Fresh-app verification must target the exact accepted Design Apply journal.".into());
  }
  Ok(())
}

fn validate_verification_receipt(receipt: &contract::DesignApplyReceipt, source_revision: &str) -> Result<(), String> {
  if !matches!(receipt.phase, contract::ApplyPhase::Deployed | contract::ApplyPhase::NeedsReview)
    || !receipt.deployment.as_ref().is_some_and(|deployment| deployment.ok)
  {
    return Err("Verify the refreshed app after Design deployment succeeds.".into());
  }
  if receipt.source_revision_after.as_deref() != Some(source_revision) {
    return Err("Source changed after publishing. Review it before verifying the saved Design result.".into());
  }
  Ok(())
}

async fn await_snapshot(
  app: &AppHandle,
  state: &StudioState,
  session: &StudioSession,
  first: Value,
  command: Option<&ValidatedCommand>,
) -> Result<DesignSnapshot, String> {
  let wait = async {
    let mut value = first;
    loop {
      validate_project(app, session)?;
      if let Some(snapshot) = parse_snapshot(value)? {
        if matching_snapshot(&snapshot, session, command)? {
          accept(state, session, &snapshot)?;
          return Ok(snapshot);
        }
      }
      tokio::time::sleep(Duration::from_millis(80)).await;
      value = preview::studio_eval(app, &script("peek", &Value::String(session.options.session_id.clone()))?).await?;
    }
  };
  tokio::time::timeout(Duration::from_secs(15), wait).await.map_err(|_| {
    "Design app-frame acknowledgement timed out. Check that the app has loaded and is signed in, then reconnect."
      .to_string()
  })?
}

fn current(state: &StudioState, session_id: &str) -> Result<StudioSession, String> {
  contract::identity(session_id)?;
  let session = state
    .current
    .lock()
    .map_err(|_| "Design session state is unavailable.")?
    .clone()
    .ok_or("Design Studio is not connected.")?;
  if session.options.session_id != session_id {
    return Err("Stale Design session; reconnect before editing.".into());
  }
  Ok(session)
}

fn validate_previews(session: &StudioSession) -> Result<(), String> {
  if let Some(previews) = &session.options.asset_previews {
    let _disk = design_store::lock()?;
    let project = design_store::project(&session.project_id)?;
    for (id, preview) in previews {
      if &project.asset_preview(id)? != preview {
        return Err("Design image preview does not match its project-scoped original bytes.".into());
      }
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn preview_studio_connect(
  app: AppHandle,
  state: State<'_, StudioState>,
  options: DesignConnection,
) -> Result<DesignSnapshot, String> {
  contract::connection(&options)?;
  let _gate = state.gate.lock().await;
  let project_id = store::active_project().ok_or("Select a project before entering Design.")?.id;
  let session = StudioSession { project_id, options, document_id: None };
  validate_project(&app, &session)?;
  validate_previews(&session)?;
  {
    let previous = state.current.lock().unwrap().clone();
    if let Some(previous) = previous {
      if previous.options.session_id != session.options.session_id {
        preview::studio_eval(&app, &script("disconnect", &Value::String(previous.options.session_id))?).await?;
      }
    }
  }
  preview::studio_active(&app, true);
  *state.current.lock().unwrap() = Some(session.clone());
  let result = async {
    let first = preview::studio_eval(
      &app,
      &script("connect", &serde_json::to_value(&session.options).map_err(|e| e.to_string())?)?,
    )
    .await?;
    await_snapshot(&app, &state, &session, first, None).await
  }
  .await;
  if result.is_err() {
    let _ =
      preview::studio_eval(&app, &script("disconnect", &Value::String(session.options.session_id.clone()))?).await;
    *state.current.lock().unwrap() = None;
    preview::studio_active(&app, false);
  }
  result
}

#[tauri::command]
pub async fn preview_studio_poll(
  app: AppHandle,
  state: State<'_, StudioState>,
  session_id: String,
) -> Result<Option<DesignSnapshot>, String> {
  let _gate = state.gate.lock().await;
  let session = current(&state, &session_id)?;
  validate_project(&app, &session)?;
  let value = preview::studio_eval(&app, &script("peek", &Value::String(session_id))?).await?;
  let Some(snapshot) = parse_snapshot(value)? else {
    return Ok(None);
  };
  if !matching_snapshot(&snapshot, &session, None)? {
    return Err("The Design controller is not connected to the requested session.".into());
  }
  accept(&state, &session, &snapshot)?;
  Ok(Some(snapshot))
}

#[tauri::command]
pub async fn preview_studio_command(
  app: AppHandle,
  state: State<'_, StudioState>,
  command: Value,
) -> Result<DesignSnapshot, String> {
  let command = contract::command(command)?;
  let _gate = state.gate.lock().await;
  let session = current(&state, &command.session_id)?;
  validate_project(&app, &session)?;
  if session.document_id.as_deref() != Some(&command.document_id) {
    return Err("Design command targets a stale document. Refresh the selection and retry.".into());
  }
  let kind = command.value["type"].as_str().unwrap();
  let mutations = &app.state::<crate::state::AppState>().mutations;
  if let Some(apply_id) = mutations.apply_id(&session.project_id) {
    let clearing_projection = matches!(kind, "clear" | "discard")
      && mutations.is_apply(&session.project_id, &apply_id, super::project_mutation::ApplyStage::Verifying);
    if !clearing_projection && !matches!(kind, "select" | "compare" | "capture" | "debug" | "verify" | "tool") {
      return Err("Design Apply has frozen this journal. Finish or cancel it before making more draft edits.".into());
    }
  }
  if kind == "verify" {
    validate_verification_journal(&session.project_id, &command)?;
  }
  if command.value["type"] == "image" {
    let _disk = design_store::lock()?;
    let project = design_store::project(&session.project_id)?;
    let id = command.value["assetId"].as_str().ok_or("Missing Design image ID.")?;
    if project.asset_preview(id)? != command.value["dataUrl"].as_str().ok_or("Missing Design image preview.")? {
      return Err("Design image preview does not match the staged asset.".into());
    }
    let mut options = session.options.clone();
    options
      .asset_previews
      .get_or_insert_with(Default::default)
      .insert(id.to_string(), command.value["dataUrl"].as_str().unwrap().to_string());
    contract::connection(&options)?;
    if let Some(active) = state.current.lock().unwrap().as_mut() {
      active.options.asset_previews = options.asset_previews;
    }
  }
  let first = preview::studio_eval(&app, &script("command", &command.value)?).await?;
  let snapshot = await_snapshot(&app, &state, &session, first, Some(&command)).await?;
  verification_complete(&command, &snapshot)?;
  Ok(snapshot)
}

#[tauri::command]
pub async fn preview_studio_disconnect(
  app: AppHandle,
  state: State<'_, StudioState>,
  session_id: String,
) -> Result<(), String> {
  let _gate = state.gate.lock().await;
  contract::identity(&session_id)?;
  if state.current.lock().unwrap().is_none() {
    return Ok(());
  }
  current(&state, &session_id)?;
  preview::studio_eval(&app, &script("disconnect", &Value::String(session_id.clone()))?).await?;
  let wait = async {
    loop {
      let value = preview::studio_eval(&app, &script("peek", &Value::String(session_id.clone()))?).await?;
      match parse_snapshot(value)? {
        None => break,
        Some(s) if s.session_id == session_id && !s.enabled => break,
        Some(s) if s.session_id != session_id => {
          return Err("A different Design session replaced the one being disconnected.".into())
        }
        _ => tokio::time::sleep(Duration::from_millis(80)).await,
      }
    }
    Ok::<(), String>(())
  };
  tokio::time::timeout(Duration::from_secs(10), wait)
    .await
    .map_err(|_| "Design disconnect acknowledgement timed out.")??;
  *state.current.lock().unwrap() = None;
  preview::studio_active(&app, false);
  Ok(())
}

pub fn on_load(app: AppHandle) {
  tauri::async_runtime::spawn(async move {
    let state = app.state::<StudioState>();
    let _gate = state.gate.lock().await;
    let Some(mut session) = state.current.lock().unwrap().clone() else {
      return;
    };
    if validate_project(&app, &session).is_err() {
      return;
    }
    let result = async {
      let may_project = {
        let _disk = design_store::lock()?;
        let receipt = design_store::project(&session.project_id)?.load_receipt()?;
        let applying = app.state::<crate::state::AppState>().mutations.apply_id(&session.project_id).is_some();
        recovery_may_project(receipt.as_ref(), applying)
      };
      if !may_project {
        // Recovery must not taint a freshly loaded verification document by
        // replaying cached visual edits before the renderer reconnects.
        session.options.history.clear();
        session.options.cursor = 0;
        session.options.route = None;
      }
      let first = preview::studio_eval(
        &app,
        &script("connect", &serde_json::to_value(&session.options).map_err(|e| e.to_string())?)?,
      )
      .await?;
      await_snapshot(&app, &state, &session, first, None).await
    }
    .await;
    if let Err(error) = result {
      log::warn!("Design recovery after preview navigation: {error}");
    }
  });
}

fn recovery_may_project(receipt: Option<&design_store::ReceiptRecord>, applying: bool) -> bool {
  if applying {
    return false;
  }
  let Some(record) = receipt else {
    return true;
  };
  if record.finished && record.receipt.phase == contract::ApplyPhase::Deployed {
    return true;
  }
  record.receipt.phase == contract::ApplyPhase::Error
    && record.receipt.files_modified.is_empty()
    && record.receipt.source_revision_after.as_ref() == Some(&record.receipt.source_revision_before)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn design_verification_can_retry_a_published_result_without_reapplying_source() {
    let revision = format!("sha256:{}", "a".repeat(64));
    let mut receipt: contract::DesignApplyReceipt = serde_json::from_value(json!({
      "id":"apply","projectId":"p","draftRevision":1,"turnId":"apply",
      "phase":"needs-review","sourceRevisionBefore":revision,
      "sourceRevisionAfter":revision,"filesModified":["src/App.tsx"],
      "deployment":{"ok":true,"outcome":"success"}
    })).unwrap();
    assert!(validate_verification_receipt(&receipt, &revision).is_ok());
    assert!(validate_verification_receipt(&receipt, "changed").is_err());
    receipt.phase = contract::ApplyPhase::Editing;
    assert!(validate_verification_receipt(&receipt, &revision).is_err());
    receipt.phase = contract::ApplyPhase::Deployed;
    receipt.deployment.as_mut().unwrap().ok = false;
    assert!(validate_verification_receipt(&receipt, &revision).is_err());
  }

  #[test]
  fn design_bridge_arguments_are_json_encoded_and_schemes_checked() {
    let js = script("peek", &json!("quote\"\\")).unwrap();
    assert!(js.contains("d.peek(\"quote\\\"\\\\\")"));
    assert!(url("file:///C:/private.txt").is_err());
    assert!(url("https://user:password@example.com").is_err());
    assert!(!same_app(&url("https://example.com/app-other").unwrap(), &url("https://example.com/app").unwrap()));
    assert!(same_app(&url("https://example.com/app/route").unwrap(), &url("https://example.com/app").unwrap()));
    assert!(!same_app(
      &url("https://example.com/?itemId=other").unwrap(),
      &url("https://example.com/?itemId=ours").unwrap()
    ));
  }

  #[test]
  fn design_bridge_does_not_accept_unacknowledged_fabric_snapshots() {
    let snapshot: DesignSnapshot = serde_json::from_value(json!({
      "protocol":1,"sessionId":"s","documentId":"d","revision":1,"enabled":true,
      "route":"/","tool":"select","compare":false,"selection":[],"layers":[],"tokens":[],
      "breakpoints":[],"viewport":{"width":800,"height":600},"history":[],"cursor":0,
      "conflicts":[],"acknowledged":["old"]
    }))
    .unwrap();
    let session = StudioSession {
      project_id: "p".into(),
      document_id: Some("d".into()),
      options: DesignConnection {
        session_id: "s".into(),
        embedded: true,
        app_url: "https://example.com".into(),
        history: vec![],
        cursor: 0,
        revision: 1,
        route: None,
        asset_previews: None,
      },
    };
    let command = contract::command(json!({"sessionId":"s","documentId":"d","commandId":"new","type":"undo"})).unwrap();
    assert!(!matching_snapshot(&snapshot, &session, Some(&command)).unwrap());
    let mut fresh = snapshot.clone();
    fresh.acknowledged.push("new".into());
    assert!(matching_snapshot(&fresh, &session, Some(&command)).unwrap());
    fresh.document_id = "different".into();
    assert!(matching_snapshot(&fresh, &session, Some(&command)).is_err());
  }

  #[test]
  fn design_recovery_never_projects_onto_apply_verification_documents() {
    let before = format!("sha256:{}", "a".repeat(64));
    let mut record = design_store::ReceiptRecord {
      schema_version: 1,
      finished: false,
      receipt: contract::DesignApplyReceipt {
        id: "apply".into(),
        project_id: "p".into(),
        draft_revision: 1,
        turn_id: "apply".into(),
        phase: contract::ApplyPhase::SourceUpdated,
        source_revision_before: before.clone(),
        source_revision_after: Some(before),
        files_modified: vec![],
        error: None,
        deployment: None,
      },
    };
    assert!(recovery_may_project(None, false));
    assert!(!recovery_may_project(None, true));
    for phase in [
      contract::ApplyPhase::Editing,
      contract::ApplyPhase::SourceUpdated,
      contract::ApplyPhase::Deploying,
      contract::ApplyPhase::Deployed,
      contract::ApplyPhase::NeedsReview,
      contract::ApplyPhase::Interrupted,
    ] {
      record.receipt.phase = phase;
      assert!(!recovery_may_project(Some(&record), false));
    }
    record.receipt.phase = contract::ApplyPhase::Deployed;
    record.finished = true;
    assert!(recovery_may_project(Some(&record), false));
    assert!(!recovery_may_project(Some(&record), true));
    record.receipt.phase = contract::ApplyPhase::Error;
    assert!(recovery_may_project(Some(&record), false));
    record.receipt.files_modified.push("index.html".into());
    assert!(!recovery_may_project(Some(&record), false));
  }
}
