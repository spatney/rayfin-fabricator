use std::path::{Path, PathBuf};

use super::*;

/// A project folder of its own under the temp folder, removed when dropped.
struct Project(PathBuf);

impl Project {
  fn new() -> Self {
    let dir = std::env::temp_dir().join(format!("fab-supporting-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Project(dir)
  }

  fn path(&self) -> &Path {
    &self.0
  }

  fn write(&self, rel: &str, text: &str) {
    let path = rel.split('/').fold(self.0.clone(), |p, part| p.join(part));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
  }

  fn remove(&self, rel: &str) {
    let path = rel.split('/').fold(self.0.clone(), |p, part| p.join(part));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&path);
  }
}

impl Drop for Project {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

const LOGICAL_ID: &str = "5F1C2A4E-3B7D-4C11-9A5E-2D4B6F8A9C01";

/// A small, valid semantic model in `supporting-items/Sales.SemanticModel`.
fn sales_model(project: &Project) {
  let root = "supporting-items/Sales.SemanticModel";
  project.write(
    &format!("{root}/.platform"),
    &format!(
      r#"{{"$schema":"https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json","metadata":{{"type":"SemanticModel","displayName":"Sales"}},"config":{{"version":"2.0","logicalId":"{LOGICAL_ID}"}}}}"#
    ),
  );
  project.write(&format!("{root}/definition.pbism"), r#"{"version":"4.0","settings":{}}"#);
  project.write(&format!("{root}/definition/database.tmdl"), "database\n\tcompatibilityLevel: 1567\n");
  project.write(&format!("{root}/definition/model.tmdl"), "model Model\n\tculture: en-US\n");
  project.write(
    &format!("{root}/definition/tables/Sales.tmdl"),
    "table Sales\n\n\tmeasure 'Total Revenue' = SUM(Sales[Revenue])\n\t\tformatString: #,0.00\n\n\tcolumn CustomerKey\n\t\tdataType: string\n\t\tsourceColumn: CUSTOMER_KEY\n\n\tcolumn Revenue\n\t\tdataType: decimal\n\t\tsourceColumn: REVENUE\n\n\tpartition Sales = m\n\t\tmode: import\n\t\tsource =\n\t\t\t\tlet\n\t\t\t\t    Source = Sql.Database(\"sql.contoso.com\", \"sales\")\n\t\t\t\tin\n\t\t\t\t    Source\n",
  );
  project.write(
    &format!("{root}/definition/tables/Customer.tmdl"),
    "table Customer\n\n\tcolumn CustomerKey\n\t\tdataType: string\n\t\tisKey\n\t\tsourceColumn: CUSTOMER_KEY\n\n\tpartition Customer = m\n\t\tmode: import\n\t\tsource = Sql.Database(\"sql.contoso.com\", \"sales\")\n",
  );
  project.write(
    &format!("{root}/definition/relationships.tmdl"),
    "relationship 7a1c2a4e-3b7d-4c11-9a5e-2d4b6f8a9c02\n\tfromColumn: Sales.CustomerKey\n\ttoColumn: Customer.CustomerKey\n",
  );
  // Power BI Desktop's cache, which isn't part of the definition.
  project.write(&format!("{root}/.pbi/localSettings.json"), "{}");
}

fn codes(problems: &[Problem]) -> Vec<&str> {
  problems.iter().map(|p| p.code.as_str()).collect()
}

#[test]
fn a_valid_folder_is_read_with_its_model_and_checks() {
  let project = Project::new();
  sales_model(&project);
  assert_eq!(folders(project.path()), ["Sales.SemanticModel"]);
  let item = read_item(project.path(), "Sales.SemanticModel").unwrap_or_else(|p| panic!("{p:?}"));
  assert_eq!((item.name.as_str(), item.item_type.as_str()), ("Sales", SEMANTIC_MODEL));
  assert_eq!(item.key, LOGICAL_ID.to_lowercase());
  assert_eq!(item.path(), "supporting-items/Sales.SemanticModel");
  let paths: Vec<&str> = item.parts.iter().map(|p| p.path.as_str()).collect();
  assert!(paths.contains(&".platform") && paths.contains(&"definition/tables/Sales.tmdl"));
  assert!(!paths.iter().any(|p| p.starts_with(".pbi/")), "{paths:?}");
  assert_eq!(item.model.tables.len(), 2);
  // The key on the relationship's one side has to be unique and never blank.
  assert!(item.advisory.iter().any(|c| c.code == "one-side-key"), "{:?}", item.advisory);
}

#[test]
fn a_definitions_hash_ignores_line_endings_but_not_changes() {
  let project = Project::new();
  sales_model(&project);
  let first = read_item(project.path(), "Sales.SemanticModel").unwrap().hash;
  let model = "supporting-items/Sales.SemanticModel/definition/model.tmdl";
  project.write(model, "model Model\r\n\tculture: en-US\r\n");
  assert_eq!(read_item(project.path(), "Sales.SemanticModel").unwrap().hash, first);
  project.write(model, "model Model\n\tculture: pt-BR\n");
  assert_ne!(read_item(project.path(), "Sales.SemanticModel").unwrap().hash, first);
}

#[test]
fn what_stops_a_folder_from_being_applied_is_said_for_each_problem() {
  let project = Project::new();
  sales_model(&project);
  let root = "supporting-items/Sales.SemanticModel";
  project.write(
    &format!("{root}/.platform"),
    r#"{"metadata":{"type":"Report","displayName":"Revenue"},"config":{"logicalId":"not-a-guid"}}"#,
  );
  project.write(&format!("{root}/definition.pbism"), r#"{"version":"1.0"}"#);
  project.remove(&format!("{root}/definition/database.tmdl"));
  project.write(&format!("{root}/model.bim"), "{}");
  project.write(
    &format!("{root}/definition/expressions.tmdl"),
    "expression Conn = \"Server=sql;Password=hunter22\" meta [IsParameterQuery=true, Type=\"Text\"]\n",
  );
  let problems = read_item(project.path(), "Sales.SemanticModel").unwrap_err();
  let found = codes(&problems);
  for code in ["tmsl", "wrong-type", "name-mismatch", "no-logical-id", "pbism-version", "missing-file", "secret"] {
    assert!(found.contains(&code), "{code} in {found:?}");
  }
  let secret = problems.iter().find(|p| p.code == "secret").unwrap();
  assert_eq!((secret.file.as_deref(), secret.line), (Some("definition/expressions.tmdl"), Some(1)));
  let text = problems_text("Sales.SemanticModel", &problems);
  assert!(text.starts_with("Fabricator can't apply supporting-items/Sales.SemanticModel yet:"), "{text}");
  assert!(text.contains("definition/database.tmdl is missing."), "{text}");
}

#[test]
fn only_semantic_models_and_lakehouses_in_well_named_folders_are_items() {
  let project = Project::new();
  sales_model(&project);
  project.write("supporting-items/Orders.Warehouse/.platform", "{}");
  project.write("supporting-items/Stage.Lakehouse/.platform", "{}");
  project.write("supporting-items/notes/readme.txt", "x");
  project.write("supporting-items/README.md", "x");
  assert_eq!(folders(project.path()), ["Orders.Warehouse", "Sales.SemanticModel", "Stage.Lakehouse"]);
  assert_eq!(codes(&read_item(project.path(), "Orders.Warehouse").unwrap_err()), ["unsupported-type"]);
  assert_eq!(codes(&read_item(project.path(), "Stage.Lakehouse").unwrap_err()), ["wrong-type", "name-mismatch", "no-logical-id"]);
  assert_eq!(codes(&read_item(project.path(), "notes").unwrap_err()), ["bad-name"]);
}

#[test]
fn a_lakehouse_lists_the_tables_it_loads_and_changes_when_their_data_does() {
  let project = Project::new();
  let platform = r#"{"metadata":{"type":"Lakehouse","displayName":"Stage"},"config":{"version":"2.0","logicalId":"3f2a1b4c-0000-4000-8000-00000000000a"}}"#;
  project.write("supporting-items/Stage.Lakehouse/.platform", platform);
  project.write("supporting-items/Stage.Lakehouse/lakehouse.metadata.json", "{}");
  project.write(
    "supporting-items/Stage.Lakehouse/tables.json",
    r#"{"tables":[{"name":"orders","file":"data/orders.csv"}]}"#,
  );
  project.write("supporting-items/Stage.Lakehouse/data/orders.csv", "OrderId,Amount\n1,2.5\n2,3\n");
  let item = read_item(project.path(), "Stage.Lakehouse").unwrap();
  assert!(item.is_lakehouse() && item.model.tables.is_empty());
  let table = &item.lakehouse.as_ref().unwrap().tables[0];
  assert_eq!((table.name.as_str(), table.columns.clone(), table.rows), ("orders", vec!["OrderId".to_string(), "Amount".into()], Some(2)));
  let card = review::create_item(&item);
  assert_eq!((card.tables.len(), card.tables[0].source.as_str()), (1, "supporting-items/Stage.Lakehouse/data/orders.csv"));

  let mut state = AppliedState::default();
  state.items.insert(item.key.clone(), AppliedItem { item_id: "i".into(), local_hash: item.hash.clone(), ..Default::default() });
  assert_eq!(status_of(&item, &state), Status::Applied);
  std::thread::sleep(std::time::Duration::from_millis(20));
  project.write("supporting-items/Stage.Lakehouse/data/orders.csv", "OrderId,Amount\n1,2.5\n2,3\n3,4\n");
  let changed = read_item(project.path(), "Stage.Lakehouse").unwrap();
  assert_eq!(status_of(&changed, &state), Status::Changed);
}

#[test]
fn the_folder_keeps_lakehouse_data_out_of_git() {
  let project = Project::new();
  project.write("supporting-items/.gitignore", "*.log\n");
  super::ensure_gitignore(project.path());
  super::ensure_gitignore(project.path());
  let text = std::fs::read_to_string(project.path().join("supporting-items/.gitignore")).unwrap();
  assert!(text.starts_with("*.log\n"), "{text}");
  assert_eq!(text.matches("*.Lakehouse/data/").count(), 1, "{text}");
}

#[test]
fn a_broken_model_is_reported_with_its_file_and_line() {
  let project = Project::new();
  sales_model(&project);
  project.write(
    "supporting-items/Sales.SemanticModel/definition/relationships.tmdl",
    "relationship r1\n\tfromColumn: Sales.CustomerKey\n\ttoColumn: Customer.Missing\n",
  );
  let problems = read_item(project.path(), "Sales.SemanticModel").unwrap_err();
  let missing = problems.iter().find(|p| p.code == "missing-column").unwrap_or_else(|| panic!("{problems:?}"));
  assert_eq!((missing.table.as_deref(), missing.column.as_deref()), (Some("Customer"), Some("Missing")));
}

#[test]
fn state_is_saved_with_a_readme_and_read_back_and_a_damaged_file_is_not_guessed_around() {
  let project = Project::new();
  assert_eq!(load_state(project.path()).unwrap(), AppliedState::default());
  let mut state = AppliedState { workspace: Some(Workspace { id: "w".into(), name: "Finance".into() }), ..Default::default() };
  state.items.insert(
    "k".into(),
    AppliedItem {
      item_id: "i".into(),
      item_type: SEMANTIC_MODEL.into(),
      display_name: "Sales".into(),
      folder: "Sales.SemanticModel".into(),
      applied_at: "2026-11-24T00:00:00Z".into(),
      local_hash: "h".into(),
      fabric_hash: None,
      ..Default::default()
    },
  );
  save_state(project.path(), &state).unwrap();
  assert_eq!(load_state(project.path()).unwrap(), state);
  let text = std::fs::read_to_string(project.path().join("supporting-items/applied.json")).unwrap();
  assert!(text.contains("\"itemId\": \"i\"") && text.contains("\"type\": \"SemanticModel\""), "{text}");
  assert!(!text.contains("fabricHash") && !text.contains("creating"), "{text}");
  let readme = std::fs::read_to_string(project.path().join("supporting-items/README.md")).unwrap();
  assert!(readme.contains("aren't part of the Rayfin app") && readme.contains("Publish"), "{readme}");
  project.write("supporting-items/applied.json", "{ not json");
  assert!(load_state(project.path()).unwrap_err().contains("restore it from git"));
}

#[test]
fn an_items_status_follows_what_was_applied() {
  let project = Project::new();
  sales_model(&project);
  let item = read_item(project.path(), "Sales.SemanticModel").unwrap();
  let mut state = AppliedState::default();
  assert_eq!(status_of(&item, &state), Status::NotCreated);
  let mut applied = AppliedItem { item_id: "i".into(), local_hash: item.hash.clone(), ..Default::default() };
  state.items.insert(item.key.clone(), applied.clone());
  assert_eq!(status_of(&item, &state), Status::Applied);
  applied.local_hash = "older".into();
  state.items.insert(item.key.clone(), applied);
  assert_eq!(status_of(&item, &state), Status::Changed);
}

fn project_at(path: &Path, over: serde_json::Value) -> StudioProject {
  let mut value = serde_json::json!({
    "id": "p", "name": "Contoso Expenses", "path": path.to_string_lossy(), "addedAt": "2026-01-01T00:00:00.000Z"
  });
  value.as_object_mut().unwrap().extend(over.as_object().unwrap().clone());
  serde_json::from_value(value).unwrap()
}

#[test]
fn new_items_go_to_the_workspace_the_items_are_in_else_the_one_the_app_is_published_to() {
  let project = Project::new();
  let ws = "11111111-2222-3333-4444-555555555555";
  project.write(
    "rayfin/.deployments.json",
    &format!(r#"{{"active":"finance","deployments":{{"finance":{{"fabricItemId":"a1","fabricWorkspaceId":"{ws}"}}}}}}"#),
  );
  let published = project_at(project.path(), serde_json::json!({ "workspaceName": "Finance analytics" }));
  let target_ws = publish_workspace(&published).unwrap();
  assert_eq!(target_ws, Workspace { id: ws.into(), name: "Finance analytics".into() });
  // Once items are in a workspace, new ones go there too.
  let state = AppliedState { workspace: Some(Workspace { id: "w2".into(), name: "Sales".into() }), ..Default::default() };
  assert_eq!(target(&published, &state).unwrap().id, "w2");
  // An app that was never published has none; a team app never has one.
  project.remove("rayfin/.deployments.json");
  assert_eq!(publish_workspace(&project_at(project.path(), serde_json::json!({}))), None);
  let remembered = project_at(project.path(), serde_json::json!({ "workspace": ws }));
  assert_eq!(publish_workspace(&remembered).unwrap().id, ws);
  let mut team = remembered.clone();
  team.team = Some(crate::types::TeamBinding::default());
  assert_eq!(publish_workspace(&team), None);
  assert_eq!(target(&team, &AppliedState::default()), None);
}

#[test]
fn chat_has_supporting_items_only_with_its_switch_and_outside_team_apps() {
  let project = Project::new();
  let with_switch = project_at(project.path(), serde_json::json!({ "plugins": [PLUGIN] }));
  assert!(on_for(&with_switch));
  assert!(!on_for(&project_at(project.path(), serde_json::json!({}))));
  let mut team = with_switch.clone();
  team.team = Some(crate::types::TeamBinding::default());
  assert!(!on_for(&team));
  // Off in a chat where they're offered, chat can ask the user to turn them on.
  assert_eq!(in_chat(&with_switch), InChat::On);
  assert_eq!(in_chat(&project_at(project.path(), serde_json::json!({}))), InChat::Off);
  assert_eq!(in_chat(&team), InChat::Unavailable);
}

#[test]
fn chat_continues_once_after_the_turn_in_which_supporting_items_were_turned_on() {
  tools::CONTINUE.lock().unwrap().insert("p-continue".into(), "t1".into());
  assert!(!tools::take_continue("p-continue", "t0"), "another turn doesn't continue");
  assert!(tools::take_continue("p-continue", "t1"));
  assert!(!tools::take_continue("p-continue", "t1"), "only once");
}

#[test]
fn a_description_fits_fabrics_limit_and_names_the_app_and_folder() {
  let text = description("Contoso Expenses", "Sales.SemanticModel");
  assert_eq!(
    text,
    "Supporting item for the Rayfin app \"Contoso Expenses\", managed in Fabricator from supporting-items/Sales.SemanticModel."
  );
  let long = description(&"A".repeat(400), "Sales.SemanticModel");
  assert!(long.chars().count() <= 256, "{}", long.chars().count());
  assert!(long.ends_with("from supporting-items/Sales.SemanticModel."), "{long}");
}

#[test]
fn a_model_is_drawn_like_one_read_from_fabric() {
  let project = Project::new();
  sales_model(&project);
  let schema = to_schema(&read_item(project.path(), "Sales.SemanticModel").unwrap().model);
  assert!(schema.ok && schema.matched);
  assert_eq!(schema.tables.len(), 2);
  assert_eq!(schema.tables.iter().find(|t| t.name.as_deref() == Some("Sales")).unwrap().storage_mode.as_deref(), Some("import"));
  let key = schema.columns.iter().find(|c| c.table.as_deref() == Some("Customer")).unwrap();
  assert!(key.is_key);
  let rel = &schema.relationships[0];
  assert_eq!(
    (rel.from_cardinality.as_deref(), rel.to_cardinality.as_deref(), rel.cross_filter.as_deref(), rel.is_active),
    (Some("many"), Some("one"), Some("oneDirection"), true)
  );
  assert_eq!(schema.measures[0].expression.as_deref(), Some("SUM(Sales[Revenue])"));
}
