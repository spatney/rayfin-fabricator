//! Files Fabricator writes into a team workspace repository: the managed
//! deploy workflow, a README, a root `.gitignore`, and the workspace manifest.
//!
//! The workflow signs in to Entra ID itself: it exchanges the job's GitHub OIDC
//! token for a Fabric API token (client credentials with a client assertion)
//! and hands it to the Rayfin CLI as `RAYFIN_TOKEN` (`rayfin up` only needs the
//! Fabric scope). It uses only GitHub's own actions plus bash, curl and git, so
//! it also runs on an organization's own runners, chosen with the
//! [`RUNS_ON_VARIABLE`] Actions variable. No secrets are stored in the
//! repository: the variables hold IDs only.

use serde_json::{json, Value};

use crate::types::{TeamManifest, TeamRunner};

use super::MIN_RAYFIN;

/// Bump when [`WORKFLOW`] changes so existing workspaces are offered an update.
pub const TEMPLATE_VERSION: u32 = 6;

/// The first template whose draft pull requests don't deploy a preview: their
/// author runs the app on their own computer, and Fabricator's Publish marks
/// the pull request ready, which deploys it. The renderer's `READY_PREVIEWS_TEMPLATE`.
pub const READY_PREVIEWS_VERSION: u32 = 6;

/// How the workflow names a draft pull request's run (`run-name`), which
/// deploys nothing: Fabricator waits for, and reports, the other runs.
pub const DRAFT_RUN_PREFIX: &str = "Draft (no preview): ";

/// Whether a run of the workflow is a draft pull request's, which deploys nothing.
pub fn is_draft_run(event: &str, title: Option<&str>) -> bool {
  event == "pull_request" && title.is_some_and(|t| t.starts_with(DRAFT_RUN_PREFIX))
}

/// The Actions variable (repository or organization) that names the runners
/// the workflow's jobs use, as JSON `runs-on` accepts. GitHub-hosted
/// `ubuntu-latest` runners when it isn't set.
pub const RUNS_ON_VARIABLE: &str = "FABRICATOR_RUNS_ON";

const WORKFLOW: &str = r##"# Managed by Fabricator (team workspace template v{{VERSION}}).
# Fabricator replaces this file when its template changes, so edits here may be lost.
#
# Every top-level folder that contains rayfin/rayfin.yml is a Rayfin app.
# - Pull requests that are ready for review deploy a personal preview of the
#   changed apps for their author. Draft pull requests don't deploy: Fabricator
#   runs the app on its author's computer while they work, and marks the pull
#   request ready when they publish.
# - Pushes to main deploy the published apps.
# Jobs sign in through GitHub OIDC: pull requests as the preview identity (which
# can only reach the previews workspace), main as the deploy identity.
# No secrets are stored here; the repository variables hold IDs only.
#
# Jobs run on GitHub-hosted ubuntu-latest runners unless the FABRICATOR_RUNS_ON
# variable (repository or organization) names other runners as JSON, for example
# {"group":"my-runners"} or ["self-hosted","linux"]. Runners need bash, curl and git.
name: Fabricator
run-name: "${{ github.event_name == 'pull_request' && github.event.pull_request.draft && format('{{DRAFT_RUN_PREFIX}}{0}', github.event.pull_request.title) || ' ' }}"

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      action:
        description: Deploy apps, or only check that the pipeline can reach Fabric
        type: choice
        options: [deploy, verify]
        default: deploy
      project:
        description: App folder to deploy (leave blank for every app)
        type: string
        required: false
      force:
        description: Allow data-model changes that delete data
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write
  deployments: write

env:
  AZURE_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}
  FABRIC_WORKSPACE_ID: ${{ vars.FABRIC_WORKSPACE_ID }}
  FABRIC_PREVIEW_WORKSPACE_ID: ${{ vars.FABRIC_PREVIEW_WORKSPACE_ID }}

jobs:
  plan:
    name: Plan
    # A draft pull request deploys nothing, so none of its jobs run.
    if: github.event_name != 'pull_request' || !github.event.pull_request.draft
    runs-on: ${{ fromJSON(vars.FABRICATOR_RUNS_ON || '"ubuntu-latest"') }}
    outputs:
      mode: ${{ steps.plan.outputs.mode }}
      projects: ${{ steps.plan.outputs.projects }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: plan
        name: Find the apps to deploy
        shell: bash
        env:
          EVENT: ${{ github.event_name }}
          BEFORE: ${{ github.event.before }}
          PR_BASE: ${{ github.event.pull_request.base.sha }}
          INPUT_ACTION: ${{ inputs.action }}
          INPUT_PROJECT: ${{ inputs.project }}
        run: |
          set -euo pipefail
          all_projects() {
            for dir in */; do
              dir="${dir%/}"
              if [ -f "$dir/rayfin/rayfin.yml" ]; then echo "$dir"; fi
            done
          }
          is_app_folder() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [[ "$1" != *..* ]]; }
          mode=production
          if [ "$EVENT" = "pull_request" ]; then mode=preview; fi
          if [ "$EVENT" = "workflow_dispatch" ] && [ "${INPUT_ACTION:-deploy}" = "verify" ]; then
            echo "mode=verify" >> "$GITHUB_OUTPUT"
            echo "projects=[]" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ "$EVENT" = "workflow_dispatch" ]; then
            if [ -n "${INPUT_PROJECT:-}" ]; then
              if ! is_app_folder "$INPUT_PROJECT"; then
                echo "::error::'$INPUT_PROJECT' isn't an app folder name."
                exit 1
              fi
              list="$INPUT_PROJECT"
            else
              list="$(all_projects)"
            fi
          else
            base="$BEFORE"
            if [ "$EVENT" = "pull_request" ]; then
              # The checkout is GitHub's test merge of the pull request into main, and its
              # first parent is that main. The event's base can be where the branch
              # started, which would count apps published since then as changed here.
              base="$PR_BASE"
              if git rev-parse --quiet --verify "$GITHUB_SHA^2" >/dev/null; then
                base="$(git rev-parse "$GITHUB_SHA^1")"
              fi
            fi
            if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
              list="$(all_projects)"
            else
              list="$(git diff --name-only "$base" "$GITHUB_SHA" | grep / | cut -d/ -f1 | sort -u || true)"
            fi
          fi
          # A JSON list of the app folders; their names need no escaping.
          projects=""
          for project in $list; do
            if [ -f "$project/rayfin/rayfin.yml" ]; then
              if ! is_app_folder "$project"; then
                echo "::warning::Skipped '$project': it isn't a valid app folder name."
                continue
              fi
              projects="${projects:+$projects,}\"$project\""
            fi
          done
          projects="[$projects]"
          echo "mode=$mode" >> "$GITHUB_OUTPUT"
          echo "projects=$projects" >> "$GITHUB_OUTPUT"
          echo "Mode: $mode. Apps: $projects"

  verify:
    name: Verify Fabric access
    needs: plan
    if: needs.plan.outputs.mode == 'verify'
    runs-on: ${{ fromJSON(vars.FABRICATOR_RUNS_ON || '"ubuntu-latest"') }}
    steps:
      - name: Sign in as each identity and read its workspace
        shell: bash
        env:
          DEPLOY_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
          PREVIEW_CLIENT_ID: ${{ vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID }}
        run: |
          set -uo pipefail
          {{SIGN_IN}}
          check() {
            local who="$1" client="$2" workspace="$3" code
            fabric_sign_in "$client" || return 1
            code="$(curl -sS --retry 2 --max-time 60 -o "$RUNNER_TEMP/workspace.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "https://api.fabric.microsoft.com/v1/workspaces/$workspace")" || code=000
            if [ "$code" = "000" ]; then
              echo "::error title=Fabric access::Couldn't reach Microsoft Fabric (api.fabric.microsoft.com) from this runner."
              return 1
            fi
            if [ "$code" != "200" ]; then
              echo "::error title=Fabric access::Workspace $workspace returned HTTP $code to the $who identity: $(head -c 400 "$RUNNER_TEMP/workspace.json")"
              return 1
            fi
            echo "The $who identity can reach Fabric workspace $workspace."
          }
          check deploy "$DEPLOY_CLIENT_ID" "$FABRIC_WORKSPACE_ID" || exit 1
          check preview "$PREVIEW_CLIENT_ID" "$FABRIC_PREVIEW_WORKSPACE_ID" || exit 1

  deploy:
    name: ${{ needs.plan.outputs.mode == 'preview' && 'Preview' || 'Deploy' }} ${{ matrix.project }}
    needs: plan
    if: needs.plan.outputs.mode != 'verify' && needs.plan.outputs.projects != '[]'
    runs-on: ${{ fromJSON(vars.FABRICATOR_RUNS_ON || '"ubuntu-latest"') }}
    strategy:
      fail-fast: false
      matrix:
        project: ${{ fromJSON(needs.plan.outputs.projects) }}
    concurrency:
      group: fabricator-${{ needs.plan.outputs.mode }}-${{ matrix.project }}-${{ github.event.pull_request.user.login || 'main' }}
      cancel-in-progress: ${{ needs.plan.outputs.mode == 'preview' }}
    env:
      MODE: ${{ needs.plan.outputs.mode }}
      PROJECT: ${{ matrix.project }}
      AUTHOR: ${{ github.event.pull_request.user.login }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
      FORCE: ${{ inputs.force }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - id: target
        name: Choose where to deploy
        shell: bash
        run: |
          set -euo pipefail
          item_name() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-60; }
          if [ "$MODE" = "preview" ]; then
            login="$(printf '%s' "$AUTHOR" | tr '[:upper:]' '[:lower:]')"
            {
              echo "workspace=$FABRIC_PREVIEW_WORKSPACE_ID"
              echo "item=$(item_name "$PROJECT-pv-$login")"
              echo "environment=preview/$PROJECT/$login"
              echo "force=--force"
            } >> "$GITHUB_OUTPUT"
          else
            force=""
            if [ "${FORCE:-false}" = "true" ]; then force="--force"; fi
            {
              echo "workspace=$FABRIC_WORKSPACE_ID"
              echo "item=$(item_name "$PROJECT")"
              echo "environment=production/$PROJECT"
              echo "force=$force"
            } >> "$GITHUB_OUTPUT"
          fi
      - name: Install dependencies
        working-directory: ${{ matrix.project }}
        shell: bash
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - id: rayfin
        name: Check the Rayfin version
        working-directory: ${{ matrix.project }}
        shell: bash
        run: |
          # Deploying by item name needs Rayfin {{MIN_RAYFIN}} or newer.
          help="$(npx --no-install rayfin up --help 2>&1 || true)"
          if ! grep -q -- '--item-name' <<<"$help"; then
            found="$(node -p "require('./node_modules/@microsoft/rayfin-cli/package.json').version" 2>/dev/null || echo none)"
            echo "reason=rayfin-update" >> "$GITHUB_OUTPUT"
            echo "::error title=Rayfin update needed::$PROJECT uses Rayfin CLI $found. Team workspaces need Rayfin {{MIN_RAYFIN}} or newer: open the app in Fabricator, select Rayfin in the status bar and choose Update with Copilot."
            exit 1
          fi
      - id: deploy
        name: Deploy with Rayfin
        working-directory: ${{ matrix.project }}
        shell: bash
        env:
          # Pull requests can only use the preview identity.
          CLIENT_ID: ${{ needs.plan.outputs.mode == 'preview' && (vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID) || vars.AZURE_CLIENT_ID }}
          WORKSPACE: ${{ steps.target.outputs.workspace }}
          ITEM: ${{ steps.target.outputs.item }}
          FORCE_FLAG: ${{ steps.target.outputs.force }}
        run: |
          set -uo pipefail
          {{SIGN_IN}}
          # Signed in only now, after the app's own code (npm scripts, its CLI) has run.
          fabric_sign_in "$CLIENT_ID" || exit 1
          RAYFIN_TOKEN="$TOKEN"
          export RAYFIN_TOKEN
          npx rayfin up --workspace-id "$WORKSPACE" --item-name "$ITEM" --yes $FORCE_FLAG 2>&1 | tee "$RUNNER_TEMP/deploy.log"
          code="${PIPESTATUS[0]}"
          if [ "$code" != "0" ]; then
            # The Rayfin CLI refuses data-model or storage changes that delete data.
            if grep -qiE 'use --force to apply (destructive|storage) changes' "$RUNNER_TEMP/deploy.log"; then
              echo "reason=data-loss" >> "$GITHUB_OUTPUT"
              echo "::error title=Deploy stopped::This change would delete data in the published app. Publish it again from Fabricator and confirm to allow it."
            fi
            exit "$code"
          fi
          npx rayfin up status --json > "$RUNNER_TEMP/status.json" 2>/dev/null || true
          if [ -f rayfin/.deployments.json ]; then cp rayfin/.deployments.json "$RUNNER_TEMP/deployments.json"; fi
          # The app's public settings (also built into its web page), so Fabricator
          # can run a local preview against this deployment.
          if [ -f rayfin/.env ]; then grep -E '^RAYFIN_PUBLIC_[A-Z0-9_]+=' rayfin/.env > "$RUNNER_TEMP/public.env" || true; fi
      - name: Record the deployment
        # Not for runs a newer push cancelled: the newer run records instead.
        if: ${{ !cancelled() && steps.target.outputs.environment != '' }}
        uses: actions/github-script@v9
        env:
          ENVIRONMENT: ${{ steps.target.outputs.environment }}
          OUTCOME: ${{ steps.deploy.outcome }}
          REASON: ${{ steps.deploy.outputs.reason || steps.rayfin.outputs.reason }}
        with:
          script: |
            const fs = require('fs')
            const path = require('path')
            const read = (name) => {
              try { return fs.readFileSync(path.join(process.env.RUNNER_TEMP, name), 'utf8') } catch { return '' }
            }
            let entry = {}
            try {
              const registry = JSON.parse(read('deployments.json'))
              const all = registry.deployments || {}
              entry = all[registry.active] || Object.values(all)[0] || {}
            } catch {}
            let status = {}
            for (const line of read('status.json').split('\n').reverse()) {
              try {
                const parsed = JSON.parse(line)
                if (parsed && typeof parsed === 'object') { status = parsed.deployment || {}; break }
              } catch {}
            }
            const scraped = (read('deploy.log').match(/(?:Hosting URL|Static app):\s*(\S+)/i) || [])[1]
            const publicEnv = {}
            for (const line of read('public.env').split('\n')) {
              const m = line.trim().match(/^(RAYFIN_PUBLIC_[A-Z0-9_]+)=(.*)$/)
              if (m && m[1] !== 'RAYFIN_PUBLIC_FRONTEND_PORT') publicEnv[m[1]] = m[2]
            }
            const payload = {
              project: process.env.PROJECT,
              mode: process.env.MODE,
              headSha: process.env.HEAD_SHA,
              itemId: entry.fabricItemId || status.fabricItemId || null,
              workspaceId: entry.fabricWorkspaceId || status.fabricWorkspaceId || null,
              apiUrl: entry.fabricApiUrl || status.rayfinApiUrl || null,
              hostingUrl: entry.hostingUrl || status.hostingUrl || scraped || null,
              portalUrl: entry.fabricDeepLink || status.fabricPortalUrl || null,
              publicEnv: Object.keys(publicEnv).length ? publicEnv : null,
              reason: process.env.REASON || null
            }
            const ok = process.env.OUTCOME === 'success'
            const { owner, repo } = context.repo
            const deployment = await github.rest.repos.createDeployment({
              owner,
              repo,
              ref: process.env.HEAD_SHA,
              environment: process.env.ENVIRONMENT,
              auto_merge: false,
              required_contexts: [],
              transient_environment: process.env.MODE === 'preview',
              production_environment: process.env.MODE !== 'preview',
              description: `Fabricator ${process.env.MODE} of ${process.env.PROJECT}`,
              payload
            })
            await github.rest.repos.createDeploymentStatus({
              owner,
              repo,
              deployment_id: deployment.data.id,
              state: ok ? 'success' : 'failure',
              environment_url: ok && payload.hostingUrl ? payload.hostingUrl : undefined,
              log_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
              description: ok ? 'deployed' : (payload.reason || 'failed'),
              auto_inactive: true
            })
"##;

/// Bash for the workflow's `{{SIGN_IN}}` lines: GitHub OIDC → Microsoft Entra
/// ID client credentials, the same exchange `azure/login` makes, without
/// needing the Azure CLI on the runner. Sign-in errors keep Entra ID's own
/// text (AADSTS codes), which setup's verification explains.
const SIGN_IN: &str = r##"# Sign in to Microsoft Entra ID as the identity with client ID $1 using this
# job's GitHub OIDC token (no secrets), and put a Fabric API token in $TOKEN.
fabric_sign_in() {
  local response assertion detail
  TOKEN=""
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "::error title=Sign-in failed::GitHub didn't give this job an OIDC token. The workflow needs the id-token: write permission."
    return 1
  fi
  if ! response="$(curl -sS --retry 2 --max-time 60 -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange")"; then
    echo "::error title=Sign-in failed::Couldn't get an OIDC token from GitHub."
    return 1
  fi
  assertion="$(sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$response")"
  if [ -z "$assertion" ]; then
    echo "::error title=Sign-in failed::GitHub didn't issue an OIDC token: $(head -c 300 <<<"$response" | tr -d '\r\n')"
    return 1
  fi
  echo "::add-mask::$assertion"
  if ! response="$(curl -sS --retry 2 --max-time 60 "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
    --data-urlencode "client_id=$1" \
    --data-urlencode "scope=https://api.fabric.microsoft.com/.default" \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    --data-urlencode "client_assertion=$assertion")"; then
    echo "::error title=Sign-in failed::Couldn't reach Microsoft Entra ID (login.microsoftonline.com) from this runner."
    return 1
  fi
  TOKEN="$(sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$response")"
  if [ -z "$TOKEN" ]; then
    detail="$(sed -n 's/.*"error_description"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$response")"
    echo "::error title=Sign-in failed::Microsoft Entra ID didn't sign in $1: ${detail:-$(head -c 400 <<<"$response" | tr -d '\r\n')}"
    return 1
  fi
  echo "::add-mask::$TOKEN"
}
"##;

const README: &str = r##"# {{NAME}}

This repository is a **Fabricator team workspace**. Each top-level folder is a Rayfin app.

- Open it in Fabricator (Settings → Experiments → Team workspaces) to build the apps with your team.
- Fabricator runs each app on your computer while you work on it, saves your changes to a branch and a
  draft pull request, and publishes by merging it.
- The `Fabricator` workflow deploys a personal preview for each pull request that's ready for review, and the
  published app for `main`. Draft pull requests don't deploy.
  It signs in to Microsoft Fabric as the workspace's service principal through GitHub OIDC; no secrets are stored.

Each folder's name is also its app's name in Fabric, so don't rename the folders.
"##;

const GITIGNORE: &str = "node_modules/\n.DS_Store\n.rayfin-local/\n";

/// The managed deploy workflow.
pub fn workflow() -> String {
  let text = WORKFLOW
    .replace("{{VERSION}}", &TEMPLATE_VERSION.to_string())
    .replace("{{MIN_RAYFIN}}", MIN_RAYFIN)
    .replace("{{DRAFT_RUN_PREFIX}}", DRAFT_RUN_PREFIX);
  let mut out = String::with_capacity(text.len() + 2 * SIGN_IN.len());
  for line in text.split_inclusive('\n') {
    if line.trim() != "{{SIGN_IN}}" {
      out.push_str(line);
      continue;
    }
    // The function, indented like the placeholder inside its `run: |` block.
    let indent = &line[..line.len() - line.trim_start().len()];
    for sign_in in SIGN_IN.lines() {
      if !sign_in.is_empty() {
        out.push_str(indent);
        out.push_str(sign_in);
      }
      out.push('\n');
    }
  }
  out
}

/// The [`RUNS_ON_VARIABLE`] value for `runner`, as JSON `runs-on` accepts, or
/// `None` for GitHub-hosted runners, which need no variable.
pub fn runs_on_value(runner: &TeamRunner) -> Option<String> {
  let value = match (&runner.group, runner.labels.is_empty()) {
    (Some(group), true) => json!({ "group": group }),
    (Some(group), false) => json!({ "group": group, "labels": runner.labels }),
    (None, true) => return None,
    (None, false) => json!(runner.labels),
  };
  Some(value.to_string())
}

/// What a [`RUNS_ON_VARIABLE`] value means, or `None` when `runs-on` can't use
/// it (it was written by hand).
pub fn parse_runs_on(value: &str) -> Option<TeamRunner> {
  fn names(v: &Value) -> Option<Vec<String>> {
    match v {
      Value::String(s) => Some(vec![s.clone()]),
      Value::Array(items) => items.iter().map(|i| i.as_str().map(String::from)).collect(),
      _ => None,
    }
  }
  let runner = match serde_json::from_str::<Value>(value.trim()).ok()? {
    Value::Object(map) => {
      if map.keys().any(|k| k != "group" && k != "labels") {
        return None;
      }
      let group = match map.get("group") {
        Some(Value::String(g)) => Some(g.clone()),
        Some(_) => return None,
        None => None,
      };
      let labels = match map.get("labels") {
        Some(v) => names(v)?,
        None => Vec::new(),
      };
      TeamRunner { group, labels }
    }
    other => TeamRunner { group: None, labels: names(&other)? },
  };
  clean_runner(runner).ok().filter(|r| r.group.is_some() || !r.labels.is_empty())
}

/// `runner` with its names trimmed, labels split at commas and duplicates
/// dropped, or why it can't be used.
pub fn clean_runner(runner: TeamRunner) -> Result<TeamRunner, String> {
  let group = runner.group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
  let mut labels: Vec<String> = Vec::new();
  for label in runner.labels.iter().flat_map(|l| l.split(',')).map(str::trim).filter(|l| !l.is_empty()) {
    if !labels.iter().any(|l| l.eq_ignore_ascii_case(label)) {
      labels.push(label.to_string());
    }
  }
  if group.iter().chain(&labels).any(|n| n.chars().count() > 256 || n.chars().any(char::is_control)) {
    return Err(t!("team.templates.invalidRunner"));
  }
  Ok(TeamRunner { group, labels })
}

pub fn readme(name: &str) -> String {
  let title: String = name.chars().filter(|c| *c != '\n' && *c != '\r').collect();
  README.replace("{{NAME}}", title.trim())
}

pub fn gitignore() -> &'static str {
  GITIGNORE
}

/// Pretty JSON for `fabricator.workspace.json`.
pub fn manifest_json(manifest: &TeamManifest) -> String {
  let mut text = serde_json::to_string_pretty(manifest).unwrap_or_else(|_| "{}".into());
  text.push('\n');
  text
}

/// Parse `fabricator.workspace.json`.
pub fn parse_manifest(text: &str) -> Option<TeamManifest> {
  serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::team::naming;
  use crate::types::{TeamDeployIdentity, TeamFabricTargets, TeamFabricWorkspace, TeamSettings};

  fn yaml() -> serde_yaml::Value {
    serde_yaml::from_str(&workflow()).expect("workflow is valid YAML")
  }

  #[test]
  fn workflow_is_valid_yaml_with_the_expected_jobs_and_triggers() {
    let doc = yaml();
    let jobs = doc["jobs"].as_mapping().unwrap();
    for job in ["plan", "verify", "deploy"] {
      assert!(jobs.contains_key(job), "missing job {job}");
    }
    // YAML 1.2 (serde_yaml) reads `on` as a string; YAML 1.1 parsers read it as true.
    let on = doc
      .as_mapping()
      .unwrap()
      .iter()
      .find(|(k, _)| k.as_str() == Some("on") || k.as_bool() == Some(true))
      .map(|(_, v)| v)
      .expect("triggers");
    assert!(on.get("pull_request").is_some());
    assert!(on.get("workflow_dispatch").is_some());
    assert_eq!(doc["permissions"]["id-token"].as_str(), Some("write"));
    assert_eq!(doc["permissions"]["deployments"].as_str(), Some("write"));
    assert!(workflow().starts_with(&format!("# Managed by Fabricator (team workspace template v{TEMPLATE_VERSION})")));
  }

  #[test]
  fn workflow_never_references_secrets_and_uses_oidc() {
    let text = workflow();
    assert!(!text.contains("secrets."));
    assert!(text.contains("RAYFIN_TOKEN"));
    assert!(text.contains("--item-name \"$ITEM\" --yes $FORCE_FLAG"));
    // Runners need only bash, curl and git: no Azure CLI, azure/login or jq.
    for tool in ["azure/login", "az account", "az login", "jq "] {
      assert!(!text.contains(tool), "uses {tool}");
    }
    for placeholder in ["{{VERSION}}", "{{MIN_RAYFIN}}", "{{SIGN_IN}}", "{{DRAFT_RUN_PREFIX}}"] {
      assert!(!text.contains(placeholder), "{placeholder} was left in");
    }
  }

  #[test]
  fn jobs_sign_in_with_the_oidc_token_exchange() {
    let text = workflow();
    assert!(text.contains(&format!("audience={}", crate::services::team::entra::TOKEN_EXCHANGE_AUDIENCE)));
    assert!(text.contains("https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token"));
    assert!(text.contains("--data-urlencode \"client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer\""));
    assert!(text.contains("--data-urlencode \"scope=https://api.fabric.microsoft.com/.default\""));
    // Both tokens are masked before anything could print them.
    assert!(text.contains("echo \"::add-mask::$assertion\""));
    assert!(text.contains("echo \"::add-mask::$TOKEN\""));
    // Entra ID's own error text (AADSTS codes) reaches the log for setup to explain.
    assert!(text.contains("Microsoft Entra ID didn't sign in $1: ${detail:-"));
    let doc = yaml();
    assert_eq!(doc["env"]["AZURE_TENANT_ID"].as_str(), Some("${{ vars.AZURE_TENANT_ID }}"));
    // The same function, indented to fit, wherever a step signs in.
    let defined: Vec<String> = ["verify", "deploy"]
      .iter()
      .flat_map(|job| doc["jobs"][*job]["steps"].as_sequence().unwrap().iter())
      .filter_map(|s| s["run"].as_str())
      .filter(|run| run.contains("fabric_sign_in() {"))
      .map(|run| {
        let start = run.find("# Sign in to Microsoft Entra ID").unwrap();
        let end = run[start..].find("\n}\n").unwrap() + start + 3;
        run[start..end].to_string()
      })
      .collect();
    assert_eq!(defined.len(), 2);
    assert_eq!(defined[0], defined[1]);
    assert_eq!(defined[0], SIGN_IN);
  }

  #[test]
  fn every_job_runs_where_the_variable_says() {
    let doc = yaml();
    for job in ["plan", "verify", "deploy"] {
      assert_eq!(
        doc["jobs"][job]["runs-on"].as_str(),
        Some(format!("${{{{ fromJSON(vars.{RUNS_ON_VARIABLE} || '\"ubuntu-latest\"') }}}}").as_str()),
        "{job}"
      );
    }
  }

  #[test]
  fn runner_choices_become_runs_on_json_and_back() {
    let group = TeamRunner { group: Some("deployers".into()), labels: vec![] };
    let both = TeamRunner { group: Some("deployers".into()), labels: vec!["linux".into()] };
    let labels = TeamRunner { group: None, labels: vec!["self-hosted".into(), "linux".into()] };
    assert_eq!(runs_on_value(&group).as_deref(), Some(r#"{"group":"deployers"}"#));
    assert_eq!(runs_on_value(&both).as_deref(), Some(r#"{"group":"deployers","labels":["linux"]}"#));
    assert_eq!(runs_on_value(&labels).as_deref(), Some(r#"["self-hosted","linux"]"#));
    assert_eq!(runs_on_value(&TeamRunner::default()), None);
    for runner in [&group, &both, &labels] {
      assert_eq!(parse_runs_on(&runs_on_value(runner).unwrap()).as_ref(), Some(runner));
    }
    // What organization owners may write by hand.
    assert_eq!(parse_runs_on(r#""self-hosted""#).unwrap().labels, vec!["self-hosted"]);
    assert_eq!(parse_runs_on(r#" {"group": "g", "labels": "x64"} "#), Some(TeamRunner { group: Some("g".into()), labels: vec!["x64".into()] }));
    for invalid in ["self-hosted", "", "{}", "[]", "[1]", r#"{"group":1}"#, r#"{"name":"g"}"#, r#"{"group":"  "}"#] {
      assert_eq!(parse_runs_on(invalid), None, "{invalid}");
    }
  }

  #[test]
  fn runner_choices_are_cleaned_up() {
    let cleaned = clean_runner(TeamRunner {
      group: Some("  ".into()),
      labels: vec!["self-hosted, Linux".into(), " linux ".into(), "".into(), "x64".into()],
    })
    .unwrap();
    assert_eq!(cleaned, TeamRunner { group: None, labels: vec!["self-hosted".into(), "Linux".into(), "x64".into()] });
    assert!(clean_runner(TeamRunner { group: Some("a\nb".into()), labels: vec![] }).is_err());
    assert!(clean_runner(TeamRunner { group: Some("g".repeat(300)), labels: vec![] }).is_err());
  }

  #[test]
  fn pull_requests_deploy_with_the_preview_identity() {
    let doc = yaml();
    let deploy = doc["jobs"]["deploy"]["steps"].as_sequence().unwrap().iter().find(|s| s["id"].as_str() == Some("deploy")).unwrap();
    assert_eq!(
      deploy["env"]["CLIENT_ID"].as_str(),
      Some("${{ needs.plan.outputs.mode == 'preview' && (vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID) || vars.AZURE_CLIENT_ID }}")
    );
    assert!(deploy["run"].as_str().unwrap().contains("fabric_sign_in \"$CLIENT_ID\" || exit 1"));
    // Verification checks each identity against its own workspace.
    let steps = doc["jobs"]["verify"]["steps"].as_sequence().unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["env"]["DEPLOY_CLIENT_ID"].as_str(), Some("${{ vars.AZURE_CLIENT_ID }}"));
    assert_eq!(steps[0]["env"]["PREVIEW_CLIENT_ID"].as_str(), Some("${{ vars.AZURE_PREVIEW_CLIENT_ID || vars.AZURE_CLIENT_ID }}"));
    let run = steps[0]["run"].as_str().unwrap();
    assert!(run.contains("check deploy \"$DEPLOY_CLIENT_ID\" \"$FABRIC_WORKSPACE_ID\" || exit 1"));
    assert!(run.contains("check preview \"$PREVIEW_CLIENT_ID\" \"$FABRIC_PREVIEW_WORKSPACE_ID\" || exit 1"));
    // Setup explains these messages (see setup::verify_problem).
    assert!(run.contains("returned HTTP $code to the $who identity"));
    assert!(run.contains("Couldn't reach Microsoft Fabric (api.fabric.microsoft.com) from this runner."));
  }

  #[test]
  fn workflow_names_match_the_app() {
    let text = workflow();
    // The same sanitizer as naming::item_name, and the same environments.
    assert!(text.contains("sed 's/[^a-z0-9-]/-/g' | cut -c1-60"));
    assert!(text.contains("item_name \"$PROJECT-pv-$login\""));
    assert!(text.contains("environment=preview/$PROJECT/$login"));
    assert!(text.contains("environment=production/$PROJECT"));
    assert_eq!(naming::preview_environment("app", "amy"), "preview/app/amy");
    assert_eq!(naming::preview_item("app", "Amy"), "app-pv-amy");
  }

  #[test]
  fn pull_requests_plan_only_the_apps_they_change() {
    let doc = yaml();
    let steps = doc["jobs"]["plan"]["steps"].as_sequence().unwrap();
    let plan = steps.iter().find(|s| s["id"].as_str() == Some("plan")).unwrap();
    let run = plan["run"].as_str().unwrap();
    // `pull_request.base.sha` can be where the branch started, so apps published
    // since then would count as changed. Diff against the test merge's first parent.
    assert!(run.contains(r#"if git rev-parse --quiet --verify "$GITHUB_SHA^2" >/dev/null; then"#));
    assert!(run.contains(r#"base="$(git rev-parse "$GITHUB_SHA^1")""#));
    assert!(run.contains(r#"git diff --name-only "$base" "$GITHUB_SHA""#));
    // Pushes to main still compare with the commit before the push.
    assert!(run.contains(r#"base="$BEFORE""#));
  }

  #[test]
  fn production_deploys_need_explicit_force_and_previews_always_force() {
    let text = workflow();
    assert!(text.contains("echo \"force=--force\""));
    assert!(text.contains("if [ \"${FORCE:-false}\" = \"true\" ]; then force=\"--force\"; fi"));
  }

  #[test]
  fn data_loss_is_recorded_only_for_the_clis_refusal() {
    let text = workflow();
    assert!(text.contains("grep -qiE 'use --force to apply (destructive|storage) changes' \"$RUNNER_TEMP/deploy.log\""));
    assert!(text.contains("echo \"reason=data-loss\" >> \"$GITHUB_OUTPUT\""));
  }

  #[test]
  fn deployments_record_only_the_apps_public_settings() {
    let text = workflow();
    assert!(text.contains("grep -E '^RAYFIN_PUBLIC_[A-Z0-9_]+=' rayfin/.env > \"$RUNNER_TEMP/public.env\""));
    assert!(text.contains("m[1] !== 'RAYFIN_PUBLIC_FRONTEND_PORT'"));
    assert!(text.contains("publicEnv: Object.keys(publicEnv).length ? publicEnv : null"));
  }

  #[test]
  fn an_outdated_rayfin_cli_stops_before_signing_in_and_is_recorded() {
    let text = workflow();
    assert!(!text.contains("{{MIN_RAYFIN}}"));
    assert!(text.contains(&format!("need Rayfin {MIN_RAYFIN} or newer")));
    let doc = yaml();
    let steps = doc["jobs"]["deploy"]["steps"].as_sequence().unwrap();
    let position = |name: &str| steps.iter().position(|s| s["name"].as_str() == Some(name)).unwrap();
    assert!(position("Install dependencies") < position("Check the Rayfin version"));
    assert!(position("Check the Rayfin version") < position("Deploy with Rayfin"));
    // Only the deploy step signs in, after the app's own code has run.
    let signs_in: Vec<&str> = steps
      .iter()
      .filter(|s| s["run"].as_str().is_some_and(|r| r.contains("fabric_sign_in")))
      .filter_map(|s| s["name"].as_str())
      .collect();
    assert_eq!(signs_in, vec!["Deploy with Rayfin"]);
    let check = &steps[position("Check the Rayfin version")];
    assert_eq!(check["id"].as_str(), Some("rayfin"));
    // Only the project's own CLI counts: never download a package named `rayfin`.
    assert!(check["run"].as_str().unwrap().contains("npx --no-install rayfin up --help"));
    let record = &steps[position("Record the deployment")];
    assert_eq!(
      record["env"]["REASON"].as_str(),
      Some("${{ steps.deploy.outputs.reason || steps.rayfin.outputs.reason }}")
    );
  }

  #[test]
  fn cancelled_runs_dont_record_deployments() {
    let doc = yaml();
    let steps = doc["jobs"]["deploy"]["steps"].as_sequence().unwrap();
    let record = steps.iter().find(|s| s["name"].as_str() == Some("Record the deployment")).unwrap();
    assert_eq!(record["if"].as_str(), Some("${{ !cancelled() && steps.target.outputs.environment != '' }}"));
  }

  #[test]
  fn draft_pull_requests_deploy_nothing_until_they_are_ready() {
    let doc = yaml();
    let on = doc
      .as_mapping()
      .unwrap()
      .iter()
      .find(|(k, _)| k.as_str() == Some("on"))
      .map(|(_, v)| v)
      .unwrap();
    // Publish marks the draft ready, which deploys the preview it checks.
    let types: Vec<&str> = on["pull_request"]["types"].as_sequence().unwrap().iter().filter_map(|t| t.as_str()).collect();
    assert_eq!(types, vec!["opened", "synchronize", "reopened", "ready_for_review"]);
    // The plan skips a draft's run, and so every job after it: no runner, no deploy.
    assert_eq!(
      doc["jobs"]["plan"]["if"].as_str(),
      Some("github.event_name != 'pull_request' || !github.event.pull_request.draft")
    );
    for job in ["verify", "deploy"] {
      assert_eq!(doc["jobs"][job]["needs"].as_str(), Some("plan"), "{job}");
    }
    // A draft's run is named so Fabricator can tell it apart; other runs keep GitHub's name.
    assert_eq!(
      doc["run-name"].as_str(),
      Some("${{ github.event_name == 'pull_request' && github.event.pull_request.draft && format('Draft (no preview): {0}', github.event.pull_request.title) || ' ' }}")
    );
    assert!(is_draft_run("pull_request", Some("Draft (no preview): Leads: Add a chart")));
    assert!(!is_draft_run("pull_request", Some("Leads: Add a chart")));
    assert!(!is_draft_run("push", Some("Draft (no preview): x")));
    assert!(!is_draft_run("pull_request", None));
  }

  #[test]
  fn manifest_round_trips() {
    let manifest = TeamManifest {
      schema: 1,
      name: "Acme".into(),
      tenant_id: "t".into(),
      deploy_identity: TeamDeployIdentity { client_id: "c".into(), display_name: "d".into() },
      preview_identity: TeamDeployIdentity { client_id: "pc".into(), display_name: "pd".into() },
      fabric: TeamFabricTargets {
        production: TeamFabricWorkspace { id: "p".into(), name: "Acme".into() },
        previews: TeamFabricWorkspace { id: "v".into(), name: "Acme previews".into() },
      },
      settings: TeamSettings { require_review: true },
      template_version: TEMPLATE_VERSION,
    };
    let text = manifest_json(&manifest);
    assert!(text.contains("\"requireReview\": true"));
    assert_eq!(parse_manifest(&text), Some(manifest));
    assert_eq!(parse_manifest("{}").unwrap().schema, 1);
  }

  #[test]
  fn readme_uses_the_workspace_name() {
    assert!(readme("Acme\nOps").starts_with("# AcmeOps\n"));
  }
}
