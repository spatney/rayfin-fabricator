# Writing the Fabricator docs

This folder is the documentation site for **Fabricator**, the desktop app for building
Rayfin apps by chatting with GitHub Copilot. It is published at
<https://spatney.github.io/rayfin-fabricator/>. This file is the authoring contract: read it
before you add or change a page.

Many readers are analysts and makers rather than professional developers, and many are
opening Fabricator for the first time. Write so they can follow along without help.

## The one rule that governs everything

> Every page must read the same as HTML and as Markdown.

Appending `.md` to any page URL returns that page as raw Markdown, and the same text feeds
`/llms.txt` and `/llms-full.txt`. Anything that only exists as a React component disappears
for agents. Express rich content with Markdown primitives that the renderer upgrades:

| Need | Author as | Renders as | In `.md` |
| --- | --- | --- | --- |
| Something to paste into Fabricator's chat | ` ```prompt title="…" ` fence | Prompt card with **Copy** | intact fence |
| Note, tip, warning | GFM alert `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` | Callout | intact alert |
| Diagram | ` ```mermaid ` fence | Diagram | intact fence |
| Command or file content | fenced block with a language, plus `title="…"` when it belongs in a file | Highlighted block with copy button | intact fence |
| Comparison | GFM table | Table | table |
| Screenshot | `![Alt text](/screenshots/<id>.webp)` | Image | image link |

Allowed MDX components: `<Steps>` / `<Step>`, `<Tabs>` / `<Tab>`, `<Cards>` / `<Card>`.
Nothing else. Keep them shallow, so the content still makes sense when it is flattened into
Markdown. Prefer plain numbered lists to `<Steps>` unless a procedure has sub-content.

Mermaid diagrams tag nodes with semantic classes, for example `class Repo,Branch store`:
`actor`, `service`, `store`, `external` and `experimental`. The site injects theme-aware
styles for these, so never add `classDef`, `style` or colors to a fence. `check-docs`
rejects them.

MDX pitfalls: a bare `{` starts an expression and a bare `<` starts a tag. Put code,
paths, placeholders and anything with braces or angle brackets in backticks
(`` `<project>/rayfin.yml` ``), or escape them (`\{`, `&lt;`).

## Frontmatter

Every page needs `title` and `description`. `npm run check:docs` enforces both.

```yaml
---
title: Deploy to Microsoft Fabric
description: Deploy your app to a Fabric workspace with one click, understand automatic redeploys after chat turns, and manage deployments across workspaces.
---
```

- `title` is sentence case and names the task or the thing.
- `description` is one sentence, at most 200 characters. It must make sense out of
  context, because it is what search results, social cards and `/llms.txt` show.
- Do not repeat the title as an H1 in the body. The page renders the title for you, so the
  body starts with an introduction paragraph or an H2.

## Voice and style

- **Task-first.** Open with what the reader is trying to do and what they'll end up with.
  Introduce concepts only when the task needs them.
- **Plain language.** Use short sentences, address the reader as "you", write in the
  present tense, and use active voice. Define jargon the first time you use it or link to
  the [glossary](/docs/reference/glossary).
- **Numbered steps for procedures.** Use one action per step and start with the verb
  ("Select", "Type", "Choose"). Say where something is before saying what to do with it:
  "In the status bar, select **Report an issue**."
- **UI labels in bold, exactly as on screen.** Match the capitalization and punctuation in
  the app's source, for example **Run deep review**, **Refresh Fabric authentication**,
  **Bring in their changes**. Check them in the code; don't paraphrase them.
- **Quote messages exactly.** When the app shows a message, quote its exact text so search
  finds it: You see "Couldn't read the semantic model".
- **One idea per heading.** Headings are sentence case with no trailing punctuation.
  Agents and search chunk the content on headings.
- **Link with absolute site paths**, such as `/docs/ship/deploy` or
  `/docs/troubleshooting/deploy#a-deploy-failed`. Never use relative `./page` links.
  Rayfin's own docs are at <https://rayfin.ai>; link there for Rayfin SDK, CLI or Fabric
  app concepts instead of re-explaining them.
- **No marketing.** Avoid "simply", "just", "easy", "powerful", "seamless" and
  exclamation marks.
- **Windows first, macOS noted.** Fabricator runs on Windows 10/11 and macOS (Apple
  Silicon). Call out a macOS difference inline, or use `<Tabs>` when the steps differ.

## What to document

- **Only shipped behavior.** Document the Fabricator release in the repo-root
  `package.json`, and ground every statement in the source code (`src/renderer/src/**`,
  `src/shared/**`, `src-tauri/src/**`) or in `README.md`. If you can't verify something,
  leave it out.
- **No internals in task pages.** Rust, IPC, Tauri and file formats belong only in
  `/docs/reference/how-it-works`. Never document development-only switches such as
  `FABRICATOR_DEV_DATA_DIR`.
- **Experimental features** carry this callout at the top of the page, adjusted to the
  feature:

  ```md
  > [!WARNING]
  > Team workspaces are an experiment. Turn them on in **Settings → Experiments**. They may
  > change or be removed in a future update.
  ```

- **Fabricator is a personal project.** Never imply that Microsoft makes, endorses or
  supports it. The FAQ and the site footer carry the disclaimer.

## Naming

- **Fabricator** is the product. The installer and app bundle are named "Rayfin
  Fabricator"; use that name only when you refer to those files or to the installed app's
  name in the OS.
- **Rayfin** is Microsoft's backend platform that Fabricator apps are built on.
- **Microsoft Fabric** on first mention, then **Fabric**. Use **Fabric workspace** and
  **Fabric capacity**.
- **GitHub Copilot** on first mention, then **Copilot**.
- **Microsoft Entra ID**, never "Azure AD".
- **team workspace** in lowercase in prose. The setting is labelled **Team workspaces**.

## Screenshots

Screenshots are captured from a real Fabricator instance with a sample project ("Contoso
Expenses"), or rendered from the app's components with sample data. Personal details
(names, emails, tenant, workspace and repository names, paths) are replaced with sample
values before capture. Never add an image that shows real personal data. The tooling and
procedure are in [`scripts/docs-screenshots/`](../scripts/docs-screenshots/README.md).

Images are WebP files in `public/screenshots/`. Every screenshot has two captures of the same
screen: `<id>.webp` in Fabricator's dark theme and `<id>.light.webp` in its light theme, with the
sample app in the preview in the same theme. Pages link only the dark capture; the site shows the
one that matches the reader's theme, and `npm run check:docs` fails when a light capture is
missing. The alt text describes what the image shows for someone who can't see it:

```md
![The deployments panel listing the active Development deployment, with a New deployment link](/screenshots/deployments.webp)
```

When a page needs a screenshot that doesn't exist yet, mark the spot with an MDX comment on
its own line and capture the image before publishing. Comments are invisible on the page and
in `.md`.

```mdx
{/* screenshot: team-members */}
```

| Image | What it shows | Used on |
| --- | --- | --- |
| `workbench` | Build view: a finished chat turn and the running sample app in the preview | `/docs`, `/docs/start/tour`, `/docs/start/first-app`, landing page |
| `setup` | Setup screen with all three steps complete and the `You're all set` block | `/docs/start/setup` |
| `help` | The Help assistant answering a failed deploy, with its action button and citation | `/docs/troubleshooting/help` |
| `home` | Home with the project actions and recent projects | `/docs/start/tour`, `/docs/build/projects` |
| `new-project` | New project screen with a name entered | `/docs/start/first-app`, `/docs/build/projects` |
| `first-deploy` | The Deploy your app step of a new project | `/docs/start/first-app`, `/docs/ship/deploy` |
| `deploy-progress` | The deploy screen during a deploy: Ray and the steps so far (sample data) | `/docs/ship/deploy` |
| `chat-working` | Chat during a turn, with the live work log | `/docs/build/chat`, `/docs/start/first-app` |
| `chat-done` | A finished turn with the "Worked for …" summary and changed-file chips | `/docs/build/chat` |
| `chat-diff` | The diff for one changed file, opened from its chip | `/docs/build/chat` |
| `composer-menus` | The chat composer with the model and reasoning menu open | `/docs/build/chat` |
| `plan` | A proposed plan waiting for approval | `/docs/build/chat` |
| `preview-toolbar` | The preview toolbar above the running app | `/docs/build/preview` |
| `design` | Design mode with an element selected and its change card open | `/docs/build/design` |
| `design-theme` | Design mode's Theme panel | `/docs/build/design` |
| `code` | Code view with the file tree and the editor | `/docs/build/code-and-history` |
| `history` | The History tab with a version selected | `/docs/build/code-and-history` |
| `blueprint` | Blueprint's Architecture view of the sample app (sample data) | `/docs/build/data-model` |
| `model` | Blueprint's Data model view with the entity diagram | `/docs/build/data-model` |
| `skills` | The Skills view | `/docs/build/skills` |
| `secrets` | The Secrets view with a secret selected | `/docs/build/secrets` |
| `deployments` | The deployments panel | `/docs/ship/deploy` |
| `share` | The share dialog | `/docs/ship/share` |
| `advisor` | The Advisor: grade, check strip, summary and issues | `/docs/ship/advisor` |
| `advisor-finding` | An open Advisor issue with its fix actions | `/docs/ship/advisor` |
| `rayfin-version` | The Rayfin version control with an update available | `/docs/ship/rayfin-versions` |
| `settings` | The Settings dialog | `/docs/reference/settings` |
| `settings-experiments` | Settings' Experiments section with **Team workspaces** | `/docs/team` |
| `account-menu` | The account menu with **Refresh Fabric authentication** | `/docs/start/tour`, `/docs/troubleshooting/deploy` |
| `deploy-error` | Ray above the preview after a failed deploy, offering **Find out why** and **View logs** (sample data) | `/docs/troubleshooting/deploy` |
| `port-conflict` | The dialog shown when the preview's port is in use | `/docs/troubleshooting/preview` |
| `team-home` | Home's team workspaces section | `/docs/team` |
| `team-create` | The create team workspace dialog | `/docs/team/create` |
| `team-overview` | The workspace overview (sample data) | `/docs/team/overview` |
| `team-publish` | The team app menu next to **Publish** (sample data) | `/docs/team/publish` |

## Prompts

A `prompt` fence is text the reader pastes into Fabricator's chat box. Write it in plain
English as the outcome you want, with the details a good result needs. It must make sense
on its own, with no surrounding context.

````md
```prompt title="Track team expenses"
Build an expense tracker for my team. Employees submit expenses with a date, amount,
category and a short note. Managers see everything their team submitted and can approve or
reject each expense with a comment. Show a dashboard with this month's total by category.
```
````

Don't write "ask Copilot to do X" in prose. Write the prompt instead.

## Troubleshooting pages

- Each problem is an H2 phrased as the symptom the reader sees, such as "## A deploy
  failed", not as the cause.
- Structure each one as: what you see, which quotes the exact message → why it happens, in
  one or two sentences → how to fix it, as numbered steps → a link to
  [Report a problem](/docs/troubleshooting/report-a-problem) if it still fails.
- **Stable anchors.** The app links to pages and headings listed in
  `src/shared/docs-links.json`, and the troubleshooting overview links to every heading
  below. Don't rename these headings; if you must, update `src/shared/docs-links.json` in
  the same change (`npm run verify:app-links` fails the build otherwise):

  | Page | Heading |
  | --- | --- |
  | `/docs/troubleshooting/setup-and-sign-in` | A tool shows as missing or failed |
  | `/docs/troubleshooting/setup-and-sign-in` | GitHub Copilot sign-in doesn't work |
  | `/docs/troubleshooting/setup-and-sign-in` | Copilot asks you to sign in again |
  | `/docs/troubleshooting/setup-and-sign-in` | Fabric sign-in doesn't complete |
  | `/docs/troubleshooting/preview` | All preview ports are busy |
  | `/docs/troubleshooting/deploy` | A deploy failed |
  | `/docs/troubleshooting/deploy` | Automatic redeploy stopped |
  | `/docs/troubleshooting/team` | Setup needs an administrator |

  Heading anchors are the GitHub-style slug of the heading text, for example
  `#github-copilot-sign-in-doesnt-work`.

## Commands

```bash
npm install
npm run dev            # http://localhost:3000
npm run check:docs     # frontmatter, fences, links, images, component allowlist
npm run build          # static export to out/ plus the agent surface
npm run verify:agent   # every page has a valid .md mirror
npm run verify:app-links  # every page and heading the app links to exists
npm run typecheck
```

See `README.md` in this folder for the build, base path and deployment details.
