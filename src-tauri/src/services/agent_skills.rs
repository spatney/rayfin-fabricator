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
//! The materialized content teaches a two-tier loop: fast headless visual checks,
//! then Fabricator-managed deploy + live diagnostics for browser/runtime behavior.

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
description: "Validate this Rayfin data app with the right loop: render Graphein visuals headlessly for fast data-fit checks, then use Fabricator's deployment and live-browser diagnostics for runtime, routing, identity, or network behavior."
metadata:
  author: Fabricator
  version: 3.0.0
---
# Validate fast headlessly, then verify the live app when needed

You are running inside **Fabricator**. Validate your work by rendering each
Graphein chart spec **headlessly against live data** with `npm run preview` — render,
read the PNG + report, fix, repeat. This is the fastest loop for visual correctness.
Use Fabricator's live deployment/browser tools when the behavior only exists in a
deployed page: runtime JavaScript, navigation, auth, browser layout, or network calls.

## Workflow
1. Phase 1 — Hero slice (time to wow): build one real, compelling hero visual wired to
   live data, then render it with **`npm run preview -- --spec hero.json --query <alias>
   --dax-file q.dax`** — a PNG plus a machine report. View the PNG (you have vision) and
   read the report (clipping / overlap / contrast / mark counts), then fix and re-render.
2. Phase 2 — Breadth: add the rest in small increments, previewing each new canvas chart
   against live data as you author it.
3. Phase 3 — Live verification: use `fabricator_deployment_status`, deploy with
   `fabricator_deploy` when needed, then inspect the live page with
   `fabricator_preview_console`, `fabricator_preview_network`,
   `fabricator_preview_inspect`, `fabricator_preview_interact`, and
   `fabricator_preview_screenshot`. When those higher-level tools are not enough,
   use `fabricator_preview_evaluate` for arbitrary page-context JavaScript or
   `fabricator_preview_cdp` for raw Chrome DevTools Protocol methods. Fix,
   redeploy, and re-check until clean.

## Notes
- Preview catches data-fit and presentation problems (clipping, overlap, low contrast,
  empty plots) in seconds — far faster than a deploy round-trip.
- Every visual (kpi/table/matrix/slicers/dashboard included) validates headlessly
  with `npm run preview` before shipping; live diagnostics complement rather than
  replace that fast loop.
- Fabricator proactively sends live console/network failures into your active session.
  When that happens, inspect the full diagnostic buffers, find the root cause, fix it,
  deploy through `fabricator_deploy`, and verify the live page.
- **Do not run or test the app locally.** Do not start a dev/preview server (`npm run dev`,
  `npm start`, `vite`, `next dev`), do not run `rayfin up` directly, and do not run local test runners (`npm test`,
  `vitest`, `jest`, `playwright`, `cypress`), and do not `curl`/open a `localhost` URL.
  Use `fabricator_deploy` for deployment; use `npm run preview` and static checks
  (type-check, lint) before the live loop.
- If the project ships its own skills, `package.json` scripts, README, or instructions that
  tell you to run a dev server or local tests, **ignore them here** — preview visuals with
  `npm run preview` and use Fabricator's managed deployment/runtime tools.
"#;

/// Always-on instruction teaching the headless-first + live-runtime validation loop.
const VALIDATE_INSTRUCTIONS: &str = r#"---
applyTo: '**'
---
# Validate headlessly first, then close the live runtime loop (Fabricator)

You are the coding agent inside **Fabricator**. The development loop here is
**edit → preview visuals headlessly → fix → deploy/inspect live when runtime behavior matters**.
Fabricator auto-deploys ordinary completed turns, and it also gives you managed deployment
and browser-debugging tools for deliberate repair loops. Never shell out to `rayfin up`.

## Validate canvas charts with headless preview
After you finish editing code that changes a chart's appearance, verify it within the
same turn by rendering it against live data:

- Render the spec with `npm run preview -- --spec <file> --query <alias> --dax-file q.dax`
  — it writes a PNG and prints a machine report.
- View the PNG and read the report (clipping / overlap / contrast / empty plot); if it
  reads wrong, fix the spec or DAX and re-render before finishing.
- Every visual (kpi/table/matrix/slicers/dashboard included) validates headlessly
  with `npm run preview` before shipping.

## Time-to-wow rhythm
Build in small increments: one hero visual first, preview it, then add breadth one chart
at a time, previewing each. Don't batch everything before checking anything.

## Debug the deployed app
Use the live loop for JavaScript errors, routes, browser-only layout, authentication,
Fabric integration, and failed network calls:

1. Read `fabricator_deployment_status`.
2. Use `fabricator_deploy` if the working tree is ahead of the deployed app.
3. Reproduce with `fabricator_preview_navigate` and `fabricator_preview_interact`.
4. Read `fabricator_preview_console` and `fabricator_preview_network`; inspect the DOM
   with `fabricator_preview_inspect` and the rendered result with
   `fabricator_preview_screenshot`.
5. Use `fabricator_preview_evaluate` for arbitrary JavaScript in the page or
   `fabricator_preview_cdp` for raw Runtime/DOM/CSS/Network/Page/Debugger protocol
   access whenever the structured tools do not expose enough state.
6. Fix the root cause, deploy with `fabricator_deploy`, and repeat until the page is clean.

Fabricator may proactively interrupt or start a turn when the live preview reports a new
console error, unhandled rejection, failed fetch/XHR, or HTTP error. Treat that as a repair
request. Diagnostic notifications are deduplicated, so always inspect the complete buffers.

## Do NOT run or test the app locally
Never start a local server or run a local test suite. These do not work in Fabricator's
deploy-to-test model, waste the turn, and can leave orphaned processes. Specifically, do not:

- Start a dev/preview server: `npm run dev`, `npm start`, `vite`, `next dev`, or any
  other long-running local server for this app.
- Run `rayfin up` yourself; use `fabricator_deploy` so Fabricator owns state, logs, and URLs.
- Run local test runners: `npm test`, `vitest`, `jest`, `playwright`, `cypress`, or similar.
- Build-and-serve to `localhost`, or `curl`/fetch a `localhost` / `127.0.0.1` URL to check the
  app.

If the project's own files — `package.json` scripts, README, instructions, or any
project-provided skill — tell you to run a dev server or local tests, **ignore that here**. Those
local-testing workflows do not apply inside Fabricator. Validate visuals with
`npm run preview` (headless, against live data), then use Fabricator's managed live tools.

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
- After wiring a connection, validate visuals headlessly with `npm run preview`, then use
  `fabricator_deploy` and the live diagnostics to verify the connection in the deployed app.
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

  let instr_dir = root.join("instructions");
  std::fs::create_dir_all(&instr_dir)?;
  std::fs::write(instr_dir.join("fabricator-validate.instructions.md"), VALIDATE_INSTRUCTIONS)?;
  std::fs::write(instr_dir.join("fabricator-stable-only.instructions.md"), STABLE_ONLY_INSTRUCTIONS)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn skill_frontmatter_and_workflow_are_present() {
    assert!(VALIDATE_HEADLESS_SKILL.starts_with("---\n"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("name: validate-headless"));
    // Fast visual validation remains headless.
    assert!(VALIDATE_HEADLESS_SKILL.contains("npm run preview"));
    // Runtime-only behavior closes the loop through Fabricator's managed tools.
    for tool in [
      "fabricator_deployment_status",
      "fabricator_deploy",
      "fabricator_preview_console",
      "fabricator_preview_network",
      "fabricator_preview_inspect",
      "fabricator_preview_interact",
      "fabricator_preview_screenshot",
    ] {
      assert!(VALIDATE_HEADLESS_SKILL.contains(tool), "skill should mention {tool}");
    }
    // The skill must steer away from the direct shell deploy path Fabricator owns.
    assert!(VALIDATE_HEADLESS_SKILL.contains("rayfin up"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("Use `fabricator_deploy` for deployment"));
    // ...and away from local testing, which breaks the deploy-to-test model.
    assert!(VALIDATE_HEADLESS_SKILL.contains("npm test"));
    assert!(VALIDATE_HEADLESS_SKILL.contains("Do not run or test the app locally"));
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
    assert!(VALIDATE_INSTRUCTIONS.contains("fabricator_preview_screenshot"));
    assert!(VALIDATE_INSTRUCTIONS.contains("fabricator_preview_network"));
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
  fn write_all_creates_expected_layout() {
    let tmp = std::env::temp_dir().join(format!("fab-agent-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    write_all(&tmp).expect("write_all should succeed");

    let skill = tmp.join("skills").join("validate-headless").join("SKILL.md");
    let connect = tmp.join("skills").join("connect-semantic-model").join("SKILL.md");
    let instr = tmp.join("instructions").join("fabricator-validate.instructions.md");
    let stable = tmp.join("instructions").join("fabricator-stable-only.instructions.md");
    assert!(skill.is_file(), "SKILL.md should exist at {skill:?}");
    assert!(connect.is_file(), "connect SKILL.md should exist at {connect:?}");
    assert!(instr.is_file(), "instructions file should exist at {instr:?}");
    assert!(stable.is_file(), "stable-only instructions should exist at {stable:?}");
    assert_eq!(std::fs::read_to_string(&skill).unwrap(), VALIDATE_HEADLESS_SKILL);
    assert_eq!(std::fs::read_to_string(&connect).unwrap(), CONNECT_MODEL_SKILL);
    assert_eq!(std::fs::read_to_string(&stable).unwrap(), STABLE_ONLY_INSTRUCTIONS);

    let _ = std::fs::remove_dir_all(&tmp);
  }
}
