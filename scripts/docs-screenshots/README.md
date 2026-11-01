# Docs screenshots

Tooling for the screenshots in `website/public/screenshots/`. They come from a real
Fabricator instance with a sample project. Personal details are swapped for sample values
before every capture, and screens that are hard to reach live are rendered from the
app's own components with sample data.

Every screenshot is captured twice, once per theme: `<id>.webp` in Fabricator's dark theme and
`<id>.light.webp` in its light theme, each with the sample app in the preview in the same theme.
Pages link the dark one and the docs site shows the one that matches the reader's theme. Make
the sample app follow the system light or dark setting, so the preview can switch with the app.

Everything here is a maintainer tool. It isn't part of the app or of CI.

| File | What it does |
| --- | --- |
| `launch.ps1` | Starts an isolated debug build with its own app data, WebView2 profile and projects folder, plus a DevTools port |
| `cdp.mjs` | Drives the app over the DevTools protocol: list targets, evaluate, click (scripted or with real mouse events), type, scrub, screenshot |
| `shoot.mjs` | Captures the current screen in both themes: switches the app's theme and the preview's color scheme together, scrubs, and runs `capture-window.ps1` for each |
| `scrub.js` | Replaces personal details (names, emails, tenant, workspace and repo names, paths) in a page |
| `capture-window.ps1` | Captures the app window, including the native preview webview a DevTools screenshot can't see |
| `optimize.mjs` | Crops, resizes and converts a capture to WebP, and its light twin the same way (uses `sharp` from `website/node_modules`) |
| `harness/` + `capture-harness.ps1` | Renders components with sample data (team overview, publish menu, deployment panel, account menu, Accounts, Create a team workspace dialog, Rayfin update popover, port-conflict dialog, plan card, Skills and Secrets views, setup, Help, Search, Blueprint, its Data model view with related entities and with loose access, its Data view of the sample app's local data, the local preview with the local backend's output (a stand-in without the app, left out of the default list: the docs capture is live), deploy screen, failed deploy, the chat's model picker, Accounts → Model providers, the chat's + menu, the chat's Plugins menu, the same menu with MCP servers, Add Fabric data, Fabric data chips in the composer, Settings and its Experiments, MCP servers, Migrate a Power BI report, the Migration card) and captures each in both themes with headless Edge. Its local backend runs the sample app with made-up users, rows, secrets and output |

## Before you start

- Windows with Microsoft Edge, Node.js 22+, Rust, and the Tauri prerequisites.
- Signed in to GitHub Copilot and the Azure CLI. The isolated instance shares these sign-ins
  (and the Rayfin CLI's Fabric sign-in) because those tools own their credentials.
- `npm install` in `website/` for `sharp`.
- The rayfin-local sidecar in `src-tauri/binaries/` (`npm run rayfin-local:fetch`). The build
  copies it next to the app, and the app runs the sample app on it.
- Expect to use some Copilot requests: a few chat turns and one Advisor deep review.

Nothing is published: the sample app runs on this computer, and a sample publish record
stands in for its published copy (see [Show the app as published](#show-the-app-as-published)).

## 1. Build an isolated instance

Build from a clean checkout of the release you're documenting, so the shots match what
users have and don't depend on a running dev server:

```powershell
git worktree add --detach $env:TEMP\fab-docs\wt v1.15.0
cd $env:TEMP\fab-docs\wt
npm ci
$env:CARGO_TARGET_DIR = "$env:TEMP\fab-docs\target"
npx tauri build --debug --no-bundle
```

`--debug` keeps `FABRICATOR_DEV_DATA_DIR` working, and `tauri build` embeds the frontend.

## 2. Capture live screens

```powershell
$shots = "$env:TEMP\fab-docs\shots"    # raw captures stay outside the repository
$scrub = "$env:TEMP\fab-docs\scrub-map.json"
$app = ./launch.ps1                    # prints the process id; DevTools on port 9333
node cdp.mjs targets                   # the app window, plus the preview once an app runs
node shoot.mjs $shots\home --pid $app --scrub $scrub   # home.png and home.light.png
```

`shoot.mjs` sets the app's theme and emulates the same `prefers-color-scheme` in every
preview page, waits for the preview to repaint, scrubs every page, captures the window at
1440×900 with `capture-window.ps1`, and puts the app back in the theme it was in. To retake
one theme, pass `--themes light`. Some screens need more:

- **Menus, popovers and dialogs.** While one covers part of the preview, Fabricator shows a
  still frame of the preview taken when it opened, so it keeps the theme it opened in. Let
  `shoot.mjs` open it in each theme: `--open <css>` clicks the element that opens it with real
  mouse events, and `--close <css>` closes it after the capture. Use `--open-wait <ms>` when
  it loads something.
- **Settings.** With the dialog open, add `--settings-theme`, so its Theme buttons show the
  theme in each capture.
- **Screens that keep changing**, such as a chat turn in progress. `--freeze` pauses the app
  window's JavaScript once the dark theme is on screen and switches the theme through the
  DOM, so both captures show the same moment.

Build the sample app with light and dark themes that follow the system setting, so the
preview switches with the app, for example:

```text
Build an expense tracker for my team. Employees log expenses with a date, amount, category
(Travel, Meals, Software or Office) and a short note. Show a dashboard with this month's total,
a chart of spending by category, and a table of recent expenses with the newest first. Use a
clean, modern look with light and dark themes that follow the system setting.
```

The app's Fabric account check uses the Rayfin CLI of a project it knows; with only an old
global `rayfin` on PATH it can report "Sign in to Fabric" even though you're signed in. A
project with the current CLI installed (`npm install @microsoft/rayfin-cli` in a sample
project) fixes that. The preview's sign-in (Fabric SSO) completes on its own once you select
**Sign in** in it.

### Build the sample app on this computer

Take `new-project`, then create the project. It opens with chat ready, running on the local
backend, so the build prompt, `chat-working`, `preview-local`, `preview-as`, `code`, `history`,
`model`, `advisor` and `home` need no Fabric workspace. (`first-deploy`, the **Publish your
app** step new projects had before they ran on this computer first, is no longer in the app. Its
images stay for video lesson 02.) Add sample rows through the app's own form in the preview, and test users with
**Preview as → Add test user…** (they exist only on this computer). Before `preview-local`,
select **Restart** in **Output**, so its last lines are a clean start rather than a hot update
from the last turn.

### Show the app as published

Shots of the published app (`workbench`, and `search`, which renders over it) and the
**Local** and **Published** switch need an app that's published. Don't publish: give the
sample project a sample publish record instead. Close the instance, then write
`<project>/rayfin/.deployments.json` (git-ignored, so it's never in Code or History), which
Fabricator reads instead of asking Fabric:

```json
{
  "deployments": {
    "Contoso Apps": {
      "fabricItemId": "66666666-6666-4666-8666-666666666666",
      "fabricApiUrl": "https://contoso-expenses-1a2b3c4d5e-westus.api.fabricapps.net",
      "fabricWorkspaceId": "55555555-5555-4555-8555-555555555555",
      "hostingUrl": "http://localhost:5173/",
      "fabricDeepLink": "https://app.fabric.microsoft.com/groups/55555555-5555-4555-8555-555555555555/appbackends/66666666-6666-4666-8666-666666666666",
      "deployedAt": "<two hours ago, ISO 8601>"
    }
  },
  "active": "Contoso Apps"
}
```

In `studio.json`, add
`"deploymentNames": { "55555555-5555-4555-8555-555555555555": "Development" }` to the project.
The preview now has **Local** and **Published**. For `workbench` and `preview-toolbar`, also set
the project's `lastDeploy.commit` to the sample project's `HEAD` (so the publish control has no
changes waiting), then select **Published** in the preview: the record's address is the app
Fabricator runs on this computer, so it shows with its local data. Scrub the address to the
published host with whole-text keys, so only the toolbar's address changes: `"=localhost:5173": "contoso-expenses-1a2b3c4d5e-westus.webapp.fabricapps.net"`.

Keep the scrub map outside the repository. It maps your real values onto sample ones:

```json
{
  "jane@fabrikam.com": "avery.chen@contoso.com",
  "Jane Doe": "Avery Chen",
  "janedoe": "averychen",
  "C:\\Users\\jane": "C:\\Users\\avery",
  "=JD": "AC",
  "@initials": "AC"
}
```

Keys match case-insensitively, longest first. A key starting with `=` replaces only a whole
text node equal to it (for avatar initials), and `@initials` sets the badge drawn over
avatar images. `shoot.mjs` scrubs right before each capture, because the app re-renders, and
scrubs every page that's on screen (the app window and the preview are separate pages). To
scrub by hand, use `node cdp.mjs scrub <map>` (and `--url <host>` for the preview). When a
shot lists your Fabric workspaces or capacities, add a whole-text key for each
(`"=Finance Dev": "Contoso Apps"`), in the same alphabetical order as the real names.

Always look at each capture before you use it, in both themes, and discard any that still
show personal data, real tenant or workspace names, or other people from your directory.

## 3. Capture harness screens

```powershell
./capture-harness.ps1 -Checkout $env:TEMP\fab-docs\wt -Out $shots
```

This copies `harness/` into the checkout's `src/renderer`, serves it with Vite on port
1437, captures each `?shot=` with headless Edge in both themes (`&theme=light` for the light
one), then removes the copied files. Add a shot by adding a case to
`harness/docs-harness.tsx`. `setup` and `help` are framed in a shorter window (760 and 680
px high); the script picks that height for them unless you pass `-Height`.

## 4. Optimize and place

```powershell
node optimize.mjs $shots\home.png ..\..\website\public\screenshots\home.webp --crop 0,0,1440,560
```

Each command also turns the capture's light twin (`home.light.png`) into `home.light.webp`
with the same crop. `--crop x,y,width,height` is in window (CSS) pixels. Reference images in
pages as `![Alt text that describes the image](/screenshots/<id>.webp)`, the dark capture
only; see `website/AGENTS.md`.

Keep each screenshot's framing when you refresh it; the intro video points at places in some
of them. The current crops (no crop means the whole 1440×900 window):

| Screenshot | Captured | Crop |
| --- | --- | --- |
| `workbench`, `chat-working`, `code`, `history`, `advisor` | live (`chat-working` with `--freeze`; `workbench` as published, see above) | none |
| `home` | live | `0,0,1440,560` |
| `team-home`, `model` | live | `0,0,1440,700` |
| `new-project` | live | `0,0,1440,380` |
| `preview-toolbar` | live, from the `workbench` capture | `720,40,720,300` |
| `preview-local` | live, the chat and preview divider dragged to x 545, **Output** open | `549,43,891,820` |
| `preview-as` | live, the same split, `--open` and `--close` on `.pva-trigger` | `549,43,891,480` |
| `chat-done` | live, window 1440×1060 | `0,40,720,882` |
| `chat-diff` | live | `0,40,720,860` |
| `model-picker` | harness | `0,355,720,545` |
| `model-providers` | harness | `390,200,660,590` |
| `add-menu` | harness | `0,630,520,270` |
| `plugins` | harness | `0,520,520,380` |
| `mcp-plugins` | harness | `0,320,520,580` |
| `mcp-servers` | harness | `390,114,660,672` |
| `connect-data` | harness | `300,140,840,620` |
| `data-chips` | harness | `0,740,720,160` |
| `design`, `design-theme` | live (`design-theme` with `--open` on the Theme button) | `720,40,720,860` |
| `advisor-finding` | live | `99,191,857,534` |
| `settings`, `settings-experiments` | harness | `410,40,620,820` |
| `migrate-report` | harness | `340,12,760,716` |
| `migration-card` | harness | `0,610,720,290` |
| `account-menu` | harness | `1040,0,400,272` |
| `accounts` | harness | `390,40,660,820` |
| `deployments` | harness | `1000,0,440,360` |
| `share` | live, `--open` on Share, `--close` on Cancel | `400,240,640,420` |
| `team-overview`, `skills`, `secrets`, `blueprint`, `app-gallery` | harness | none |
| `model-relations`, `model-access` | harness | `0,0,1440,770` |
| `local-data` | harness | `0,0,1440,580` |
| `setup`, `help` | harness, shorter window (picked by the script) | none |
| `search` | harness, over the `workbench` screenshot | `225,90,990,546` |
| `team-create` | harness | `405,100,630,700` |
| `team-publish` | harness | `1030,0,410,500` |
| `rayfin-version` | harness | `0,600,340,300` |
| `port-conflict` | harness | `456,236,528,428` |
| `plan` | harness | `334,237,772,410` |
| `deploy-progress` | harness | `340,90,760,720` |
| `deploy-error` | harness | `268,158,904,134` |

## 5. Clean up

Stop the instance and the rayfin-local you started, and remove `$env:TEMP\fab-docs` (data,
WebView2 profile, projects) and the worktree (`git worktree remove $env:TEMP\fab-docs\wt`).
