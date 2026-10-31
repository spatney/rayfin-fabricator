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
title: Publish to Microsoft Fabric
description: Publish your app to a Fabric workspace, choose whether chat turns publish it automatically, and manage the workspaces it's published to.
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
![The publish control's panel for the Development published app, with its address, workspace and account, Publish after each chat turn, and Publish to another workspace](/screenshots/deployments.webp)
```

When a page needs a screenshot that doesn't exist yet, mark the spot with an MDX comment on
its own line and capture the image before publishing. Comments are invisible on the page and
in `.md`.

```mdx
{/* screenshot: team-members */}
```

| Image | What it shows | Used on |
| --- | --- | --- |
| `workbench` | Build view: a finished chat turn and the published sample app in the preview (sample data) | `/docs`, `/docs/start/tour`, `/docs/start/first-app`, landing page |
| `setup` | Setup with all three steps complete, including the optional **Sign in to Azure**, and the `You're all set` block (sample data) | `/docs/start/setup` |
| `accounts` | **Accounts** with the sample accounts signed in to each service (sample data) | `/docs/start/accounts` |
| `help` | The Help assistant answering why publishing failed, with its action button and citation (sample data) | `/docs/troubleshooting/help` |
| `search` | Search with "deploy" typed, over the workbench: one ranked list of actions and docs led by **Publish 3 changes**, Use "deploy" with…, and the action bar (sample data) | `/docs/start/search` |
| `home` | Home with the project actions and recent projects | `/docs/start/tour`, `/docs/build/projects` |
| `new-project` | New project screen with a name entered | `/docs/start/first-app`, `/docs/build/projects` |
| `first-deploy` | The **Publish your app** step new projects had before apps ran on this computer first, with a workspace picked. No longer in the app: kept for the Learn Rayfin with Ray video lesson 02 | none (video lesson 02 only) |
| `deploy-progress` | The publish screen during a publish: Ray and the steps so far (sample data) | `/docs/ship/deploy` |
| `chat-working` | Chat during a turn, with the live work log and the live preview | `/docs/build/chat`, `/docs/start/first-app` |
| `chat-done` | A finished turn with the "Worked for …" summary and changed-file chips | `/docs/build/chat` |
| `chat-diff` | The diff for one changed file, opened from its chip | `/docs/build/chat` |
| `model-picker` | The chat composer's model picker with **Auto** off and the model list open, including **Your API keys** (sample data) | `/docs/build/chat`, `/docs/build/your-own-api-keys` |
| `model-providers` | **Accounts → Model providers** with an Anthropic key saved and an OpenAI key being added (sample data) | `/docs/build/your-own-api-keys` |
| `add-menu` | The chat composer's **+** menu with **Fabric data** open beside it, listing the kinds of data (sample data) | `/docs/build/chat` |
| `plugins` | The chat composer's **Plugins** menu with **Fabric IQ** on and **Work IQ**, marked **Experiment**, off; the **Plugins** button names Fabric IQ (sample data) | `/docs/build/fabric-iq-and-work-iq` |
| `connect-data` | **Add Fabric data** on the Finance analytics workspace: recent workspaces first, three items already connected and two picked (sample data) | `/docs/build/data-model` |
| `data-chips` | The chat composer with the two items picked in `connect-data` waiting as chips for the next message (sample data) | `/docs/build/data-model` |
| `plan` | A proposed plan waiting for approval | `/docs/build/chat` |
| `preview-toolbar` | The default preview toolbar above the published sample app (sample data) | `/docs/build/preview` |
| `preview-local` | The sample app's preview on this computer: **Local** and **Published**, **Preview as**, and **Output** open below the app (sample data) | `/docs/build/local-development`, `/docs/build/preview` |
| `preview-as` | The **Preview as** menu open over the sample app on this computer: **You**, two test users, **Signed out** and **Add test user…** (sample data) | `/docs/build/preview` |
| `design` | Design mode with an element selected and its change card open | `/docs/build/design` |
| `design-theme` | Design mode's Theme panel | `/docs/build/design` |
| `code` | Code view with the file tree and the editor | `/docs/build/code-and-history` |
| `history` | The History tab with a version per request, one selected and a file's diff open | `/docs/build/code-and-history` |
| `blueprint` | Blueprint's Architecture view of the sample app (sample data) | `/docs/build/data-model` |
| `model` | Blueprint's Data model view with the entity diagram | `/docs/build/data-model` |
| `model-relations` | Blueprint's Data model view with four related entities and a join entity (sample data) | `/docs/build/data-model` |
| `model-access` | The same Data model view with one entity left without a permission decorator: its amber access dot and **Harden** (sample data) | `/docs/build/data-model` |
| `local-data` | Blueprint's **Data** view of the sample app's local data (sample data) | `/docs/build/data-model` |
| `skills` | The Skills view | `/docs/build/skills` |
| `secrets` | The Secrets view: **Local value** and **Published value**, and a secret selected (sample data) | `/docs/build/secrets` |
| `deployments` | The publish control's panel, open on the sample app's published app, with **Publish after each chat turn** off (sample data) | `/docs/ship/deploy` |
| `share` | The share dialog | `/docs/ship/share` |
| `advisor` | The Advisor: grade, check strip, summary and issues | `/docs/ship/advisor` |
| `advisor-finding` | An open Advisor issue with its fix actions | `/docs/ship/advisor` |
| `rayfin-version` | The Rayfin version control with an update available | `/docs/ship/rayfin-versions` |
| `settings` | The Settings dialog: General (with **API keys**), Appearance and the start of Diagnostics (sample data) | `/docs/reference/settings` |
| `settings-experiments` | Settings' Experiments section with **Team workspaces**, **Migrate Power BI reports**, **App gallery** and **Work IQ**, all off (sample data) | `/docs/team`, `/docs/build/migrate-power-bi`, `/docs/build/fabric-iq-and-work-iq` |
| `migrate-report` | **Migrate a Power BI report** with a report picked: its workspace, semantic model, pages and the three checks, all passing (sample data) | `/docs/build/migrate-power-bi` |
| `migration-card` | The Migration card above the chat composer after the first page, with **Migrate next page** and **Migrate the rest** (sample data) | `/docs/build/migrate-power-bi` |
| `app-gallery` | The **App gallery** with the sample user's apps, and the sample app's details open beside them (sample data) | `/docs/build/app-gallery` |
| `account-menu` | The account menu with **Refresh Fabric authentication** and **Settings**, beside the publish control (sample data) | `/docs/start/tour`, `/docs/troubleshooting/deploy` |
| `deploy-error` | Ray above the preview after a failed publish, offering **Find out why** and **View logs** (sample data) | `/docs/troubleshooting/deploy` |
| `port-conflict` | The dialog shown when the live preview's port is in use | `/docs/troubleshooting/preview` |
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
  the same change (`npm run verify:app-links` fails the build otherwise). Fabricator's Rust
  core also links to `windows-blocked-rayfin-local` directly (`BLOCKED_DOCS_URL` in
  `src-tauri/src/services/local_backend/binary.rs`), so renaming that heading means changing
  it there too. Releases of the app already installed keep linking to these headings, so a
  heading such as "A deploy failed" keeps its wording even though the app now says Publish:

  | Page | Heading |
  | --- | --- |
  | `/docs/troubleshooting/setup-and-sign-in` | A tool shows as missing or failed |
  | `/docs/troubleshooting/setup-and-sign-in` | GitHub Copilot sign-in doesn't work |
  | `/docs/troubleshooting/setup-and-sign-in` | Copilot asks you to sign in again |
  | `/docs/troubleshooting/setup-and-sign-in` | Fabric sign-in doesn't complete |
  | `/docs/troubleshooting/preview` | All preview ports are busy |
  | `/docs/troubleshooting/preview` | Windows blocked rayfin-local |
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
