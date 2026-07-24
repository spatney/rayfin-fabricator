//! Product-scoped agent guidance injected only when Copilot runs **inside
//! Fabricator**.
//!
//! Unlike the per-project skills under `.agents/skills/` (which are committed to
//! the user's repo and visible to a plain `copilot` CLI), these files live under
//! the app's private data directory and are wired into each SDK session via
//! [`SessionConfig::with_skill_directories`] /
//! [`with_instruction_directories`](github_copilot_sdk::SessionConfig::with_instruction_directories)
//! in [`crate::services::copilot`]. They are therefore present *only* in
//! Fabricator-driven sessions, never in the project on disk.
//!
//! The materialized content biases the agent toward a headless validation loop
//! (`npm run preview` → PNG + report against live data) plus the in-process
//! semantic-model tools; Fabricator auto-deploys after the turn (see
//! [`crate::services::agent_tools`]).

use std::path::PathBuf;

use crate::services::paths;

/// Root for all Fabricator-injected agent guidance, under the app data dir.
fn agent_root() -> PathBuf {
  paths::data_dir().join("fabricator-agent")
}

/// Directory passed to `with_skill_directories` (holds `<skill>/SKILL.md`).
pub fn skills_dir() -> PathBuf {
  agent_root().join("skills")
}

/// Directory passed to `with_instruction_directories` (holds `*.instructions.md`).
pub fn instructions_dir() -> PathBuf {
  agent_root().join("instructions")
}

/// The headless-validation skill, model-invoked when the user wants to verify,
/// debug, or see how the app's visuals look.
const VALIDATE_HEADLESS_SKILL: &str = r#"---
name: validate-headless
description: "Validate this Rayfin data app's visuals fast with headless Graphein preview. Use after editing the app, or whenever the user wants to validate, verify, test, check, see, preview, or debug how a chart looks or behaves ('does it work', 'make sure it looks right'). Renders one spec against live DAX data to a PNG + report — no deploy or screenshot needed; Fabricator auto-deploys after the turn."
metadata:
  author: Fabricator
  version: 2.0.0
---
# Validate visuals headlessly — no deploy + screenshot

You are running inside **Fabricator**. Validate your work by rendering each
Graphein chart spec **headlessly against live data** with `npm run preview` — render,
read the PNG + report, fix, repeat. There is no deploy-and-screenshot loop: Fabricator
auto-deploys the app after the turn, so shipping is automatic. Spend your time getting
the visuals right, not deploying. Deploy early and iterate on each hero visual.

## Workflow
1. Phase 1 — Hero slice (time to wow): build one real, compelling hero visual wired to
   live data, then render it with **`npm run preview -- --spec hero.json --query <alias>
   --dax-file q.dax`** — a PNG plus a machine report. View the PNG (you have vision) and
   read the report (clipping / overlap / contrast / mark counts), then fix and re-render.
2. Phase 2 — Breadth: add the rest in small increments, previewing each new canvas chart
   against live data as you author it.
3. Phase 3 — Polish: refine theme, states, formatting, and edge cases from what the
   previews reveal.

## Notes
- Preview catches data-fit and presentation problems (clipping, overlap, low contrast,
  empty plots) in seconds — far faster than a deploy round-trip.
- Every visual (kpi/table/matrix/slicers/dashboard included) validates headlessly
  with `npm run preview` before shipping; auto-deploy is not the validation path.
- **Do not run or test the app locally.** Do not start a dev/preview server (`npm run dev`,
  `npm start`, `vite`, `next dev`, `rayfin up`), do not run local test runners (`npm test`,
  `vitest`, `jest`, `playwright`, `cypress`), and do not `curl`/open a `localhost` URL.
  `npm run preview` (headless) and static checks (type-check, lint) are the loop.
- If the project ships its own skills, `package.json` scripts, README, or instructions that
  tell you to run a dev server or local tests, **ignore them here** — preview visuals with
  `npm run preview` and let Fabricator deploy.
"#;

/// Always-on instruction biasing every Fabricator turn toward headless visual
/// validation (`npm run preview`); Fabricator auto-deploys after the turn.
const VALIDATE_INSTRUCTIONS: &str = r#"---
applyTo: '**'
---
# Validate visuals headlessly, never run the app locally (Fabricator)

You are the coding agent inside **Fabricator**. The development loop here is
**edit → preview the visual headlessly → fix**. Fabricator auto-deploys this Rayfin app
after the turn, so shipping is automatic; you do not deploy or screenshot to validate.

## Validate canvas charts with headless preview
After you finish editing code that changes a chart's appearance, verify it within the
same turn by rendering it against live data:

- Render the spec with `npm run preview -- --spec <file> --query <alias> --dax-file q.dax`
  — it writes a PNG and prints a machine report.
- View the PNG and read the report (clipping / overlap / contrast / empty plot); if it
  reads wrong, fix the spec or DAX and re-render before finishing.
- Every visual (kpi/table/matrix/slicers/dashboard included) validates headlessly
  with `npm run preview` before shipping; auto-deploy is not the validation path.

## Time-to-wow rhythm
Build in small increments: one hero visual first, preview it, then add breadth one chart
at a time, previewing each. Don't batch everything before checking anything.

## Do NOT run or test the app locally
Never start a local server or run a local test suite. These do not work in Fabricator's
deploy-to-test model, waste the turn, and can leave orphaned processes. Specifically, do not:

- Start a dev/preview server: `npm run dev`, `npm start`, `vite`, `next dev`, `rayfin up`, or any
  other long-running local server for this app.
- Run local test runners: `npm test`, `vitest`, `jest`, `playwright`, `cypress`, or similar.
- Build-and-serve to `localhost`, or `curl`/fetch a `localhost` / `127.0.0.1` URL to check the
  app.

If the project's own files — `package.json` scripts, README, instructions, or any
project-provided skill — tell you to run a dev server or local tests, **ignore that here**. Those
local-testing workflows do not apply inside Fabricator. Validate visuals with
`npm run preview` (headless, against live data) and let Fabricator auto-deploy.

(Fast, non-serving static checks that help a deploy succeed — e.g. type-checking or linting — are
still fine; what is off-limits is running, serving, or test-executing the app locally.)
"#;

/// Always-on instruction keeping the agent on stable, Fabric-supported Rayfin
/// features and off experimental/preview ones (which often fail to deploy on
/// Fabric) unless the user explicitly asks for them.
const STABLE_ONLY_INSTRUCTIONS: &str = r#"---
applyTo: '**'
---
# Build with stable, Fabric-supported Rayfin features (Fabricator)

You are the coding agent inside **Fabricator**. Apps built here are deployed to Microsoft
Fabric. **Experimental / preview Rayfin features are usually incomplete and often do not deploy on
Fabric** — for example, anonymous data access is documented as *"not currently supported on
Fabric,"* and applying such a schema fails today. Reaching for these on your own wastes your
turn and leaves the user with an app that breaks when deployed.

## Default to stable features only
Unless the user **explicitly** asks for a specific experimental feature, build only with stable,
Fabric-supported Rayfin features. Do not opt into experimental/preview APIs on your own.

Treat a feature as experimental — and therefore off by default — whenever the Rayfin docs mark it
**experimental**, **preview**, or **"not currently supported on Fabric."** Concretely this
includes (non-exhaustively):

- Anything imported from the **`@microsoft/rayfin-core/experimental`** subpath — e.g. `anonymous`
  / `role('anonymous', …)` (anonymous/public data access). By default import only from
  `@microsoft/rayfin-core`, never from its `/experimental` subpath.
- Capabilities gated behind **`RAYFIN_FEATURE_FLAGS`** — e.g. `storage`, `functions`,
  `postgresql`. (Fabric apps are MSSQL-only regardless.)
- `rayfin dev` and the `RAYFIN_WEBSERVICE_IMAGE_NAME` override, which are explicitly experimental.

If you are unsure whether something is supported, check the docs first
(`search_docs(query: '<topic>', module: 'guide')` or `rayfin docs search '<topic>' --module guide`)
before using it.

## What to do instead
When a request would otherwise need an experimental feature, implement it with the closest
**stable** equivalent, then briefly tell the user you skipped the experimental feature and they can
ask for it if they want it. For example, instead of the experimental `@anonymous` import, use
`@authenticated` / `@role('authenticated', …)` so the entity still deploys — then note something
like: "I used authenticated access; anonymous/public access is an experimental Rayfin feature that
isn't supported on Fabric yet, so I skipped it. Let me know if you'd like me to try it anyway."

## When the user explicitly asks
If the user explicitly asks for the experimental feature (names it, or says to use the experimental
version), go ahead — but warn them up front that it is experimental and may fail to deploy on
Fabric, then deploy and validate as usual so they see the real result.
"#;

/// Model-invoked skill for finding and wiring the Power BI / Fabric semantic
/// model (dataset) behind a report or app, using the in-process locator/search
/// tools (see [`crate::services::agent_tools`]).
const CONNECT_MODEL_SKILL: &str = r#"---
name: connect-semantic-model
description: "Find and connect the Power BI / Fabric semantic model (dataset) behind a report or app. Use when this app needs to read data from an existing Power BI report, app, dataset, or semantic model — when the user pastes a Power BI link or id, or describes the data by name/topic and you need to locate the model and wire it into the app's data."
metadata:
  author: Fabricator
  version: 1.0.0
---
# Connect a Power BI / Fabric semantic model

You are running inside **Fabricator** and can locate the **semantic model (dataset)** behind
a Power BI report or app, then wire it into this app's data — without the user having to dig up the
model's URL or id. Use this whenever the app needs to read data from an existing Power BI / Fabric
model.

## Two tools

- **`fabricator_locate_semantic_model`** — when you already have a **link or id**. Pass a Power BI
  URL (a report, app, dataset, or model-editor `.../modeling/<id>/modelView` link) or a bare GUID as
  `target`. Returns the underlying model's name, **workspace id**, and **item id**.
- **`fabricator_search_semantic_models`** — when you only have a **description**. Pass
  natural-language keywords as `query` (e.g. "sales pipeline", "finance revenue by region"). Returns
  matching models with their workspace id and item id. (Requires Azure CLI sign-in, which the
  Fabricator setup screen handles.)

Prefer locate when the user gives you a link or id; fall back to search when they only describe the
data.

## Wire the model into the app

A Power BI **dataset id is the same as the Fabric semantic-model item id**, so the tool output plugs
straight into a data connection. Once you have a model's `workspaceId` and `itemId`:

1. Add it as a data connection (see the **fabric-data** skill for the full command surface):
   ```
   fabric-app-data add <alias> -w <workspaceId> -i <itemId>
   ```
   Pick a short, meaningful `<alias>` (e.g. `sales`).
2. Generate / build so the model's tables and measures become available to the app.
3. Write your queries and visuals against that connection.

## Notes

- You do **not** need to ask the user for a workspace id or item id — locate/search return them.
  Only ask for a report/app link, an id, or a description when you don't have one yet.
- If a report matched but its model couldn't be resolved, the tool says so — the signed-in user may
  lack access to the underlying model. Ask them to confirm access or share the workspace/model.
- For an **app** link, consumers often can't enumerate the app's models directly; the tool surfaces
  what it can and notes when admin access would be needed.
- After wiring a connection, validate your visuals headlessly with `npm run preview` (see the
  validate-headless skill); Fabricator auto-deploys the app after the turn.
"#;

/// Always-on instruction: Fabricator owns dependency installation, so the agent
/// must never run its own `npm install` (a second install in the same project
/// races the app's background install and corrupts `node_modules`).
const MANAGED_DEPS_INSTRUCTIONS: &str = r#"---
applyTo: '**'
---
# Dependencies are installed and managed by Fabricator

You are the coding agent inside **Fabricator**. Fabricator installs and manages this
project's npm dependencies for you — it runs the install when the project opens and
shows the user an install-status banner (with a **Retry**) if it fails. Managing
`node_modules` yourself starts a second install in the same folder, which races the
app's install and corrupts it.

## Never install or mutate dependencies
Do **not** run any of these (or their equivalents):

- `npm install` / `npm i` / `npm ci` / `npm update` / `npm rebuild`
- `pnpm install` / `yarn` / `yarn install` / `bun install`
- Deleting, moving, or hand-editing `node_modules/`, `package-lock.json`, or any lockfile.

Editing `package.json` to add a dependency is fine when a task genuinely needs a new
package — but do **not** then run an install; tell the user which package you added
and let Fabricator install it.

(`npx fabric-app-data …` is **not** a dependency install — it's the app's own data
CLI. Keep using it, and the build/preview scripts, normally.)

## If a command fails because a module is missing
That means the background install hasn't finished yet (or failed) — **not** that you
should install it. Instead:

1. Wait a few seconds and retry the **same** command once or twice; the install
   usually finishes within a minute of the project opening.
2. If it still fails, stop and tell the user their dependencies are still installing
   or failed to install, and point them at the install banner's **Retry installation**
   button. Do not try to work around it by installing packages yourself.
"#;

/// Model-invoked skill for rebuilding an imported Power BI report (PBIR / legacy
/// report.json + semantic-model TMDL under `source-report/` and `source-model/`)
/// as this data app: read the report as the UI spec, find the semantic model id it
/// binds to, wire a live connection, reuse its DAX, and map visuals to Graphein.
const BUILD_FROM_REPORT_SKILL: &str = r#"---
name: build-from-powerbi-report
description: "Rebuild an imported Power BI report as this Rayfin data app. Use whenever the project contains an imported report under `source-report/` (a PBIR `definition.pbir` / `definition/` folder, or a classic `report.json`) and/or a semantic model under `source-model/` (TMDL) — e.g. a migrated Power BI report. Covers reading the report as the UI spec, finding the semantic model id it binds to, wiring a live connection, reusing its DAX, and mapping its visuals to Graphein specs."
metadata:
  author: Fabricator
  version: 1.0.0
---
# Rebuild an imported Power BI report

You are running inside **Fabricator**, rebuilding an existing Power BI report as a
Rayfin **data app** that reads from the report's own Fabric **semantic model**, live.
The importer dropped two reference folders in the project:

- **`source-report/`** — the report definition: a PBIR `definition.pbir` + `definition/`
  folder (pages, visuals, layout), or a classic `report.json` for a legacy report. This
  is the **UI spec** — what pages, visuals, and layout to rebuild.
- **`source-model/`** — the semantic model as **TMDL** (tables, relationships,
  measures/DAX). This is **schema + DAX reference — metadata, not data.**

Both are references you read; they are not wired into the app. Your job: connect to the
live model and rebuild the visuals with Graphein.

## 1. Find the semantic model it binds to
Fabricator usually hands you the model's coordinates (workspace id + dataset id) in the
message that opens this chat — **use those directly** when present. If you need to find
the id yourself, read the report's PBIR and look for the dataset reference:

- Open `source-report/definition.pbir` (or files under `source-report/definition/`).
- Modern PBIR (`version` 4.0+) stores the binding as a **connection string** under
  `datasetReference.byConnection.connectionString`. The dataset GUID is the
  **`semanticmodelid=<GUID>`** param — e.g. `…;semanticmodelid=<GUID>`. **Note the
  `initial catalog=<name>` in that same string is the model's display name, NOT a
  GUID — don't use it as the id.**
- Older/thick PBIR instead exposes the GUID as a **`pbiModelDatabaseName`** under
  `datasetReference.byConnection` — e.g. `"pbiModelDatabaseName": "<GUID>"`.
- Either way, that GUID is the Power BI **dataset id, which IS the
  Fabric semantic-model item id.** Further fallbacks: an `Initial Catalog=<GUID>`
  in a connection string, or a `"datasetId": "<GUID>"`.
- A **`byPath`** reference (a model inside the same PBIP project) has no remote id —
  resolve it with **`fabricator_locate_semantic_model`** (pass the report/model link or
  a GUID), or ask the user for the workspace + dataset id.

## 2. Wire the model as a live connection
Once you have `workspaceId` + `itemId` (= the dataset id), add it and generate — see the
**fabric-data** and **connect-semantic-model** skills for the full surface:

```
fabric-app-data add <alias> -w <workspaceId> -i <itemId>
```

Then query it live with `useSemanticModelQuery` / `fabric-app-data query`. **Do not
import, copy, or reload the data, and do not recreate the model as Rayfin `data`
entities** — the data stays in the semantic model and the app reads it on demand. You
can disable the `data` service in `rayfin/rayfin.yml`.

## 3. Reuse the report's DAX
The TMDL in `source-model/` holds the measure names and expressions the original report
used. **Reuse the exact measure names** (and their definitions where you must recompute)
so your numbers match the original report. Prefer the model's own measures over
re-deriving aggregates in TypeScript. (→ `dax`)

## 4. Rebuild the visuals as Graphein specs
Treat `source-report/` as the layout brief, not something to port line-for-line:

- Each report page → a dashboard page/section; each visual → the closest Graphein spec
  (`ChartCard` / `KpiCard` / `DataTableCard`), authored from a DAX result. (→ `visuals`)
- Report slicers → React slicers over shared filter state; cross-filtering → Graphein
  selections. (→ `visuals`: Interactivity)
- Start with ONE hero visual wired to live data, preview it, then expand. (→ `build-workflow`)

## Notes
- If the model can't be resolved or you lack access to it, say so and ask the user for
  the workspace + dataset id — don't fall back to copying data out of the TMDL.
- Validate every visual headlessly with `npm run preview`; Fabricator auto-deploys after
  the turn. Don't run `rayfin up`, a dev server, or `npm install`.
"#;

/// Write (or refresh) the injected skill + instruction files under the app data
/// dir. Idempotent and best-effort: always overwrites so content updates ship
/// with the app. Call once at startup, before any session opens.
pub fn ensure_materialized() {
  if let Err(e) = write_all(&agent_root()) {
    log::warn!("failed to materialize Fabricator agent guidance: {e}");
  }
}

/// Materialize the skill + instruction tree under `root` (`<root>/skills/...` and
/// `<root>/instructions/...`). Separated from [`ensure_materialized`] so it can be
/// exercised against a temp dir in tests.
fn write_all(root: &std::path::Path) -> std::io::Result<()> {
  let skill_dir = root.join("skills").join("validate-headless");
  std::fs::create_dir_all(&skill_dir)?;
  std::fs::write(skill_dir.join("SKILL.md"), VALIDATE_HEADLESS_SKILL)?;

  let connect_dir = root.join("skills").join("connect-semantic-model");
  std::fs::create_dir_all(&connect_dir)?;
  std::fs::write(connect_dir.join("SKILL.md"), CONNECT_MODEL_SKILL)?;

  let report_dir = root.join("skills").join("build-from-powerbi-report");
  std::fs::create_dir_all(&report_dir)?;
  std::fs::write(report_dir.join("SKILL.md"), BUILD_FROM_REPORT_SKILL)?;

  let instr_dir = root.join("instructions");
  std::fs::create_dir_all(&instr_dir)?;
  std::fs::write(instr_dir.join("fabricator-validate.instructions.md"), VALIDATE_INSTRUCTIONS)?;
  std::fs::write(instr_dir.join("fabricator-stable-only.instructions.md"), STABLE_ONLY_INSTRUCTIONS)?;
  std::fs::write(instr_dir.join("fabricator-dependencies.instructions.md"), MANAGED_DEPS_INSTRUCTIONS)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn skill_frontmatter_and_workflow_are_present() {
    assert!(VALIDATE_HEADLESS_SKILL.starts_with("---\n"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("name: validate-headless"));
    // The headless loop, not a deploy/screenshot loop, is the validation path.
    assert!(VALIDATE_HEADLESS_SKILL.contains("npm run preview"));
    // No retired preview-browser tools should be referenced.
    for tool in [
      "fabricator_deploy_and_wait",
      "fabricator_navigate",
      "fabricator_screenshot",
      "fabricator_scroll",
      "fabricator_console",
    ] {
      assert!(!VALIDATE_HEADLESS_SKILL.contains(tool), "skill should not mention {tool}");
    }
    // The skill must steer away from the shell deploy path Fabricator owns.
    assert!(VALIDATE_HEADLESS_SKILL.contains("rayfin up"));
    // ...and away from local testing, which breaks the deploy-to-test model.
    assert!(VALIDATE_HEADLESS_SKILL.contains("npm test"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("Do not run or test the app locally"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("Deploy early and iterate"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("hero visual"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("Every visual (kpi/table/matrix/slicers/dashboard included)"));
    assert!(!VALIDATE_HEADLESS_SKILL.contains("have no headless form"));
  }

  #[test]
  fn instructions_apply_everywhere() {
    assert!(VALIDATE_INSTRUCTIONS.contains("applyTo: '**'"));
    assert!(VALIDATE_INSTRUCTIONS.contains("npm run preview"));
    assert!(VALIDATE_INSTRUCTIONS.contains("Time-to-wow rhythm"));
    assert!(VALIDATE_INSTRUCTIONS.contains("Every visual (kpi/table/matrix/slicers/dashboard included)"));
    assert!(!VALIDATE_INSTRUCTIONS.contains("have no headless form"));
    assert!(!VALIDATE_INSTRUCTIONS.contains("fabricator_screenshot"));
  }

  #[test]
  fn instructions_forbid_local_testing() {
    // Always-on guidance must explicitly ban local servers + test runners and
    // override any project-shipped local-testing workflow.
    assert!(VALIDATE_INSTRUCTIONS.contains("Do NOT run or test the app locally"));
    for forbidden in ["npm run dev", "npm test", "vitest", "localhost"] {
      assert!(
        VALIDATE_INSTRUCTIONS.contains(forbidden),
        "instructions should call out {forbidden}"
      );
    }
    assert!(VALIDATE_INSTRUCTIONS.contains("ignore that here"));
  }

  #[test]
  fn stable_only_instructions_steer_away_from_experimental() {
    assert!(STABLE_ONLY_INSTRUCTIONS.contains("applyTo: '**'"));
    // Names the concrete experimental surfaces the agent must avoid by default.
    for marker in ["@microsoft/rayfin-core/experimental", "RAYFIN_FEATURE_FLAGS", "rayfin dev"] {
      assert!(
        STABLE_ONLY_INSTRUCTIONS.contains(marker),
        "stable-only instructions should call out {marker}"
      );
    }
    // Off by default unless explicitly requested, with a stable fallback the agent
    // should reach for instead.
    assert!(STABLE_ONLY_INSTRUCTIONS.contains("explicitly"));
    assert!(STABLE_ONLY_INSTRUCTIONS.contains("@authenticated"));
  }

  #[test]
  fn connect_model_skill_documents_tools_and_wiring() {
    assert!(CONNECT_MODEL_SKILL.starts_with("---\n"));
    assert!(CONNECT_MODEL_SKILL.contains("name: connect-semantic-model"));
    for tool in [
      "fabricator_locate_semantic_model",
      "fabricator_search_semantic_models",
    ] {
      assert!(CONNECT_MODEL_SKILL.contains(tool), "skill should mention {tool}");
    }
    // The skill must show the exact wiring command and the id-equivalence fact.
    assert!(CONNECT_MODEL_SKILL.contains("fabric-app-data add <alias> -w <workspaceId> -i <itemId>"));
    assert!(CONNECT_MODEL_SKILL.contains("dataset id is the same as the Fabric semantic-model item id"));
    // ...and point at the fabric-data skill it builds on.
    assert!(CONNECT_MODEL_SKILL.contains("fabric-data"));
  }

  #[test]
  fn managed_deps_instructions_forbid_agent_install() {
    assert!(MANAGED_DEPS_INSTRUCTIONS.contains("applyTo: '**'"));
    // Fabricator owns the install; the agent must never start its own.
    for forbidden in ["npm install", "npm ci", "yarn install", "pnpm install"] {
      assert!(
        MANAGED_DEPS_INSTRUCTIONS.contains(forbidden),
        "managed-deps instructions should ban {forbidden}"
      );
    }
    // ...but the app's own data CLI stays allowed, and missing modules mean "wait".
    assert!(MANAGED_DEPS_INSTRUCTIONS.contains("fabric-app-data"));
    assert!(MANAGED_DEPS_INSTRUCTIONS.contains("Retry installation"));
  }

  #[test]
  fn build_from_report_skill_documents_model_id_and_wiring() {
    assert!(BUILD_FROM_REPORT_SKILL.starts_with("---\n"));
    assert!(BUILD_FROM_REPORT_SKILL.contains("name: build-from-powerbi-report"));
    // Names the reference folders the importer drops in.
    assert!(BUILD_FROM_REPORT_SKILL.contains("source-report/"));
    assert!(BUILD_FROM_REPORT_SKILL.contains("source-model/"));
    // Teaches where the semantic model id lives in the PBIR and the id-equivalence.
    assert!(BUILD_FROM_REPORT_SKILL.contains("pbiModelDatabaseName"));
    // ...including the modern PBIR v4 connection-string form.
    assert!(BUILD_FROM_REPORT_SKILL.contains("semanticmodelid"));
    assert!(BUILD_FROM_REPORT_SKILL.contains("Fabric semantic-model item id"));
    assert!(BUILD_FROM_REPORT_SKILL.contains("fabricator_locate_semantic_model"));
    // ...and reuses the model live rather than copying the data out of the TMDL.
    assert!(BUILD_FROM_REPORT_SKILL.contains("fabric-app-data add <alias> -w <workspaceId> -i <itemId>"));
    assert!(BUILD_FROM_REPORT_SKILL.contains("do not recreate the model as Rayfin `data`"));
  }

  #[test]
  fn write_all_creates_expected_layout() {
    let tmp = std::env::temp_dir().join(format!("fab-agent-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    write_all(&tmp).expect("write_all should succeed");

    let skill = tmp.join("skills").join("validate-headless").join("SKILL.md");
    let connect = tmp.join("skills").join("connect-semantic-model").join("SKILL.md");
    let report = tmp.join("skills").join("build-from-powerbi-report").join("SKILL.md");
    let instr = tmp.join("instructions").join("fabricator-validate.instructions.md");
    let stable = tmp.join("instructions").join("fabricator-stable-only.instructions.md");
    let deps = tmp.join("instructions").join("fabricator-dependencies.instructions.md");
    assert!(skill.is_file(), "SKILL.md should exist at {skill:?}");
    assert!(connect.is_file(), "connect SKILL.md should exist at {connect:?}");
    assert!(report.is_file(), "build-from-report SKILL.md should exist at {report:?}");
    assert!(instr.is_file(), "instructions file should exist at {instr:?}");
    assert!(stable.is_file(), "stable-only instructions should exist at {stable:?}");
    assert!(deps.is_file(), "managed-deps instructions should exist at {deps:?}");
    assert_eq!(std::fs::read_to_string(&skill).unwrap(), VALIDATE_HEADLESS_SKILL);
    assert_eq!(std::fs::read_to_string(&connect).unwrap(), CONNECT_MODEL_SKILL);
    assert_eq!(std::fs::read_to_string(&report).unwrap(), BUILD_FROM_REPORT_SKILL);
    assert_eq!(std::fs::read_to_string(&stable).unwrap(), STABLE_ONLY_INSTRUCTIONS);
    assert_eq!(std::fs::read_to_string(&deps).unwrap(), MANAGED_DEPS_INSTRUCTIONS);

    let _ = std::fs::remove_dir_all(&tmp);
  }
}
