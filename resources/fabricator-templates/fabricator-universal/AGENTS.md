# Universal App — agent guide

> **You're an agent** working in a **lean, universal Rayfin app** (a Microsoft
> Fabric Backend-as-a-Service app). It ships as a tiny "hello world" and is
> designed to **grow into whatever the user asks for** — a CRUD app, a charts
> dashboard, a Power BI analytics dashboard, or any mix. Your job is to grow it
> **on demand**, pulling in only the capabilities the request actually needs.

**Before you write any code, do two things:**

1. **Route first.** Read the **`capability-router` skill**
   (`.agents/skills/capability-router/SKILL.md`). It maps a plain-English request
   to a set of **capability packs**, and for each one tells you exactly what to
   turn on: which Fabric **service** to enable, which npm **modules** to install,
   which **code** to scaffold, and which **skill** to read for the patterns.
2. **Stay lean.** Don't enable services, install modules, or copy in kit code the
   request doesn't need. The whole point of this template is that it starts small
   and only grows where the user is going.

---

## What ships in the base

A minimal React 19 + Vite app, Fabric-ready but deliberately bare:

- A no-auth `HomePage` (`src/pages/HomePage.tsx`) rendered by `src/App.tsx` — so
  it previews with **no backend** (`npm run preview`).
- **Fabric auth scaffolding, wired OFF** under `src/services/` +
  `src/hooks/AuthContext.tsx`. The `authentication` pack turns it on.
- **Graphein** wired in for charts: `src/components/Chart.tsx` (+ `useChart.ts`)
  renders a declarative `<Chart spec={…} />`. The `graphein-visuals` pack covers
  authoring specs.
- An **empty data schema** (`rayfin/data/schema.ts`) and `rayfin/rayfin.yml` with
  `auth` + `data` (mssql) + `staticHosting` enabled. The analytics stack is
  **absent** until the analytics pack turns it on.

## The capability packs

Each pack is a skill under `.agents/skills/`, trigger-gated so it only fires when
relevant. The router picks packs; the pack skill has the details.

| Pack (skill) | Turn it on when the user wants… |
|---|---|
| `authentication` | Sign-in, accounts, login, protected pages, per-user data |
| `data-modeling` | Records, CRUD, a database, entities, row-level security |
| `graphein-visuals` | Charts, graphs, KPIs, tables, a simple dashboard |
| `analytics` | Power BI / semantic-model dashboards, DAX, BI reporting |

The `analytics` pack also brings its own supporting skills (`build-workflow`,
`visuals`, `dax`, `fabric-data`, `app-design`, `headless-preview`) — read those
only when you're on the analytics path.

---

## Rules (Fabricator deploy-to-test)

- **Make the requested code changes only**, and keep the project building —
  prefer small, correct increments.
- **Do NOT run `rayfin up` or otherwise deploy.** Fabricator runs the full
  `rayfin up` automatically after your changes and shows the deployed app in its
  preview.
- **Do NOT start dev servers or local test runners** (`npm run dev`, `vite`,
  `npm test`, …). This app is only ever run via deploy. Fast static checks
  (type-check, lint) and `npm run preview` (no backend) are fine; the analytics
  path validates visuals headlessly with `npm run preview -- --spec …`.
- **Only use what Rayfin natively provides** (auth, data, static hosting) — don't
  add external services like payment processors or email senders. Prefer
  **stable, Fabric-supported** features unless the user asks for an experimental
  one.
- **Installing npm modules is expected and fast** — Fabricator ships a warm
  offline package cache, so `npm install <module>` from a pack is quick. Install
  what a pack needs; don't pre-install everything.

When you finish editing, briefly summarize what you changed — Fabricator handles
the deploy.

## If you're asked to…

| Task | Start here |
|---|---|
| Build "an app" / anything, from scratch | **`capability-router`** — classify the request, then pull in packs |
| Add sign-in / accounts / per-user data | `authentication` |
| Store records / build CRUD / add a table | `data-modeling` |
| Restrict rows to their owner | `data-modeling` → row-level security |
| Add a chart / KPI / small dashboard | `graphein-visuals` |
| Build a Power BI / semantic-model dashboard | `analytics` (then its sub-skills) |
| Make it look polished / themed | the relevant pack's styling notes + Tailwind theme in `src/main.css` |
