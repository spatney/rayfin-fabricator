//! Product-scoped agent guidance injected only when Copilot runs **inside
//! Rayfin Fabricator**.
//!
//! Unlike the per-project skills under `.agents/skills/` (which are committed to
//! the user's repo and visible to a plain `copilot` CLI), these files live under
//! the app's private data directory and are wired into each SDK session via
//! [`SessionConfig::with_skill_directories`] /
//! [`with_instruction_directories`](github_copilot_sdk::SessionConfig::with_instruction_directories)
//! in [`crate::services::copilot`]. They are therefore present *only* in
//! Fabricator-driven sessions, never in the project on disk.
//!
//! The materialized content biases the agent toward a deploy → open the built-in
//! preview browser → screenshot → self-correct loop, using the in-process
//! `fabricator_*` tools (see [`crate::services::agent_tools`]).

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

/// The deploy-and-validate skill, model-invoked when the user wants to verify,
/// debug, or see the running app.
const DEPLOY_VALIDATE_SKILL: &str = r#"---
name: deploy-and-validate
description: "Deploy this Rayfin app and visually verify it in Fabricator's built-in browser. Use after editing the app, or whenever the user wants to validate, verify, test, check, see, preview, or debug how the running/deployed app looks or behaves (screenshots, visual issues, 'does it work', 'make sure it looks right')."
metadata:
  author: Rayfin Fabricator
  version: 1.0.0
---
# Deploy and visually validate

You are running inside **Rayfin Fabricator** and can deploy this app and view it in the
built-in preview browser using the `fabricator_*` tools. Deploy early and iterate: the
first deploy should happen as soon as the first real hero visual is wired to live data,
not after the whole dashboard is finished.

## Workflow
1. Phase 1 — Hero slice (time to wow): build one real, compelling visual wired to live
   data, then deploy immediately with the **`fabricator_deploy_and_wait`** tool. Do
   **not** run `rayfin up` in the
   shell or start a dev server — this tool runs the real deploy and waits for the app to go
   live, returning the live URL or a build/deploy error.
2. If the deploy fails, read the returned error, fix the code, and deploy again.
3. Once live, open the page you changed with **`fabricator_navigate`** (pass a route such as
   `/` or `/todos`, or a full URL) and/or take a **`fabricator_screenshot`**. Both return a
   screenshot of the running app, so you see exactly what the user sees. If the page is taller
   than the viewport (the screenshot looks cut off at the bottom), use **`fabricator_scroll`**
   (`direction`: `down`/`up`/`top`/`bottom`) to bring lower content — e.g. the bottom tiles or
   the rest of a table — into view; it returns a fresh screenshot after scrolling.
4. Inspect the screenshot. If the hero slice is missing, broken, or looks wrong, fix the
   code and redeploy until the deployed app is correct. If the page is blank, data is missing,
   or something errors in a way you can't see, read the browser console with
   **`fabricator_console`** (recent `console.*` plus uncaught errors and unhandled promise
   rejections) to pinpoint the failure, then fix and redeploy.
5. Phase 2 — Breadth: add the rest in small increments, deploying and screenshotting after
   every 1–2 additions.
6. Phase 3 — Polish: refine theme, states, spacing, and edge cases based on what the
   screenshots reveal, redeploying after each small correction.

## Notes
- Prefer screenshots over assumptions — verify visually that the change actually works in the
  deployed app.
- For content below the fold, scroll with `fabricator_scroll` instead of assuming it renders —
  e.g. to confirm the lower tiles of a dashboard or the rest of a long table. (Scrolling is
  unavailable while the preview shows the app embedded in the Fabric portal — the Data App's
  default view — because the app then runs inside a cross-origin iframe; the tool will say so.
  Rely on the screenshot, or have the user switch the preview to the direct app view.)
- When a screenshot can't explain a blank page, missing data, or a broken interaction, check
  `fabricator_console` for errors before guessing at the cause.
- Never batch all changes into one final deploy; deploy + screenshot after the hero slice
  and after every 1–2 subsequent additions, fixing what the screenshots reveal.
- Deployment and preview happen exclusively through these tools; never run `rayfin up`
  yourself.
- **Do not run or test the app locally.** The dev loop is edit → deploy → validate. Do not start
  a dev/preview server (`npm run dev`, `npm start`, `vite`, `next dev`), do not run local test
  runners (`npm test`, `vitest`, `jest`, `playwright`, `cypress`), and do not `curl`/open a
  `localhost` URL. Deploy and inspect the live app instead.
- If the project ships its own skills, `package.json` scripts, README, or instructions that tell
  you to run a dev server or local tests, **ignore them here** — in Fabricator the only way to run
  and validate this app is to deploy it and view it through these tools.
- Keep iterating in small deploy → screenshot loops until the live app reflects the user's request.
"#;

/// Always-on instruction biasing every Fabricator turn toward visual validation.
const VALIDATE_INSTRUCTIONS: &str = r#"---
applyTo: '**'
---
# Validate in the deployed app, never locally (Rayfin Fabricator)

You are the coding agent inside **Rayfin Fabricator**. The development loop here is
**edit → deploy → validate in the built-in preview browser**. Fabricator deploys this Rayfin app
to a real test environment; there is no local run target, and running it locally does not reflect
how it actually behaves when deployed.

## Always validate by deploying
After you finish editing code in response to a request that changes the app's behavior or
appearance, verify your work in the live app within the same turn:

- Deploy now with the `fabricator_deploy_and_wait` tool (even though Fabricator also
  auto-deploys after the turn — deploying now lets you validate before finishing).
- Then use `fabricator_navigate` and/or `fabricator_screenshot` to view the running app and
  confirm the change is actually present and correct.
- If a screenshot shows the change is missing or broken, fix it and redeploy before you finish.

## Time-to-wow rhythm
Deploy early and often; do not batch everything into one final deploy. Phase 1 — Hero slice
(time to wow): the first deploy targets one real, compelling hero visual wired to live data.
Phase 2 — Breadth: add the rest in small increments, using `fabricator_navigate` and
`fabricator_screenshot` after every 1–2 additions. Phase 3 — Polish: refine theme, states, and
edge cases from what the screenshots reveal, then redeploy.

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
local-testing workflows do not apply inside Fabricator. The only supported way to run and test
this app is to deploy it with `fabricator_deploy_and_wait` and inspect it through
`fabricator_navigate` / `fabricator_screenshot`.

(Fast, non-serving static checks that help a deploy succeed — e.g. type-checking or linting — are
still fine; what is off-limits is running, serving, or test-executing the app locally.)
"#;

/// Always-on instruction keeping the agent on stable, Fabric-supported Rayfin
/// features and off experimental/preview ones (which often fail to deploy on
/// Fabric) unless the user explicitly asks for them.
const STABLE_ONLY_INSTRUCTIONS: &str = r#"---
applyTo: '**'
---
# Build with stable, Fabric-supported Rayfin features (Rayfin Fabricator)

You are the coding agent inside **Rayfin Fabricator**. Apps built here are deployed to Microsoft
Fabric. **Experimental / preview Rayfin features are usually incomplete and often do not deploy on
Fabric** — for example, anonymous data access is documented as *"not currently supported on
Fabric,"* and applying such a schema fails today. Reaching for these on your own wastes the
deploy-and-validate loop and leaves the user with an app that breaks when deployed.

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
  author: Rayfin Fabricator
  version: 1.0.0
---
# Connect a Power BI / Fabric semantic model

You are running inside **Rayfin Fabricator** and can locate the **semantic model (dataset)** behind
a Power BI report or app, then wire it into this app's data — without the user having to dig up the
model's URL or id. Use this whenever the app needs to read data from an existing Power BI / Fabric
model.

## Two tools

- **`fabricator_locate_semantic_model`** — when you already have a **link or id**. Pass a Power BI
  URL (a report, app, or dataset link) or a bare GUID as `target`. Returns the underlying model's
  name, **workspace id**, and **item id**.
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
- After wiring a connection, deploy and validate as usual (see the deploy-and-validate skill).
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
  let skill_dir = root.join("skills").join("deploy-and-validate");
  std::fs::create_dir_all(&skill_dir)?;
  std::fs::write(skill_dir.join("SKILL.md"), DEPLOY_VALIDATE_SKILL)?;

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
  fn skill_frontmatter_and_tools_are_present() {
    assert!(DEPLOY_VALIDATE_SKILL.starts_with("---\n"));
    assert!(DEPLOY_VALIDATE_SKILL.contains("name: deploy-and-validate"));
    for tool in [
      "fabricator_deploy_and_wait",
      "fabricator_navigate",
      "fabricator_screenshot",
      "fabricator_scroll",
      "fabricator_console",
    ] {
      assert!(DEPLOY_VALIDATE_SKILL.contains(tool), "skill should mention {tool}");
    }
    // The skill must steer away from the shell deploy path Fabricator owns.
    assert!(DEPLOY_VALIDATE_SKILL.contains("rayfin up"));
    // ...and away from local testing, which breaks the deploy-to-test model.
    assert!(DEPLOY_VALIDATE_SKILL.contains("npm test"));
    assert!(DEPLOY_VALIDATE_SKILL.contains("Do not run or test the app locally"));
    assert!(DEPLOY_VALIDATE_SKILL.contains("Deploy early and iterate"));
    assert!(DEPLOY_VALIDATE_SKILL.contains("hero visual"));
  }

  #[test]
  fn instructions_apply_everywhere() {
    assert!(VALIDATE_INSTRUCTIONS.contains("applyTo: '**'"));
    assert!(VALIDATE_INSTRUCTIONS.contains("fabricator_deploy_and_wait"));
    assert!(VALIDATE_INSTRUCTIONS.contains("Time-to-wow rhythm"));
    assert!(VALIDATE_INSTRUCTIONS.contains("do not batch everything into one final deploy"));
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

    let skill = tmp.join("skills").join("deploy-and-validate").join("SKILL.md");
    let connect = tmp.join("skills").join("connect-semantic-model").join("SKILL.md");
    let instr = tmp.join("instructions").join("fabricator-validate.instructions.md");
    let stable = tmp.join("instructions").join("fabricator-stable-only.instructions.md");
    assert!(skill.is_file(), "SKILL.md should exist at {skill:?}");
    assert!(connect.is_file(), "connect SKILL.md should exist at {connect:?}");
    assert!(instr.is_file(), "instructions file should exist at {instr:?}");
    assert!(stable.is_file(), "stable-only instructions should exist at {stable:?}");
    assert_eq!(std::fs::read_to_string(&skill).unwrap(), DEPLOY_VALIDATE_SKILL);
    assert_eq!(std::fs::read_to_string(&connect).unwrap(), CONNECT_MODEL_SKILL);
    assert_eq!(std::fs::read_to_string(&stable).unwrap(), STABLE_ONLY_INSTRUCTIONS);

    let _ = std::fs::remove_dir_all(&tmp);
  }
}
