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
| `harness/` + `capture-harness.ps1` | Renders components with sample data (team overview, publish menu, Create a team workspace dialog, Rayfin update popover, port-conflict dialog, plan card, Skills and Secrets views, setup, Help, Blueprint, deploy screen, failed deploy) and captures each in both themes with headless Edge |

## Before you start

- Windows with Microsoft Edge, Node.js 22+, Rust, and the Tauri prerequisites.
- Signed in to GitHub Copilot and the Azure CLI. The isolated instance shares these sign-ins
  (and the Rayfin CLI's Fabric sign-in) because those tools own their credentials.
- `npm install` in `website/` for `sharp`.
- A Fabric workspace you can deploy a sample app into and delete afterwards.
- Expect to use some Copilot requests: a few chat turns and one Advisor deep review.

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
scrub by hand, use `node cdp.mjs scrub <map>` (and `--url <host>` for the preview).

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
| `workbench`, `chat-working`, `code`, `history`, `advisor` | live (`chat-working` with `--freeze`) | none |
| `home` | live | `0,0,1440,560` |
| `team-home`, `model` | live | `0,0,1440,700` |
| `new-project` | live | `0,0,1440,380` |
| `first-deploy` | live | `0,0,1440,740` |
| `preview-toolbar` | live, from the `workbench` capture | `720,40,720,300` |
| `chat-done` | live, window 1440×1060 | `0,40,720,882` |
| `chat-diff` | live | `0,40,720,860` |
| `composer-menus` | live | `0,343,720,520` |
| `design`, `design-theme` | live (`design-theme` with `--open` on the Theme button) | `720,40,720,860` |
| `advisor-finding` | live | `99,191,857,534` |
| `settings`, `settings-experiments` | live (`settings` with `--settings-theme`) | `410,40,620,820` |
| `account-menu` | live, `--open`/`--close` on the avatar | `1040,0,400,228` |
| `deployments` | live, `--open`/`--close` on the deployment control | `640,0,800,330` |
| `share` | live, `--open` on Share, `--close` on Cancel | `400,240,640,420` |
| `team-overview`, `skills`, `secrets`, `blueprint` | harness | none |
| `setup`, `help` | harness, shorter window (picked by the script) | none |
| `team-create` | harness | `405,100,630,700` |
| `team-publish` | harness | `1030,0,410,500` |
| `rayfin-version` | harness | `0,600,340,300` |
| `port-conflict` | harness | `470,236,500,428` |
| `plan` | harness | `334,237,772,410` |
| `deploy-progress` | harness | `340,90,760,720` |
| `deploy-error` | harness | `268,158,904,134` |

## 5. Clean up

Stop the instance, delete the sample Fabric workspace, and remove
`$env:TEMP\fab-docs` (data, WebView2 profile, projects) and the worktree
(`git worktree remove $env:TEMP\fab-docs\wt`).
