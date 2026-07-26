---
name: capability-router
description: >
  START HERE at the beginning of essentially every build request in this
  universal Rayfin app. Use this first whenever the user asks to build, create,
  add, or make something ("build me an app", "add sign-in", "let users upload
  files", "show a chart", "build a dashboard", "store todos", "make a Power BI
  report") and you need to decide WHICH capabilities to turn on. This skill maps
  the request to capability packs and tells you, for each, which Fabric service
  to enable, which npm modules to install, which code to scaffold, and which
  skill to read next. Triggers: build, create, add, make, app, feature, start,
  scaffold, capability, which service, what should I install, where do I begin.
---

# Capability router — pick capabilities, enable services, install modules, activate skills

This is a **lean universal app** that grows on demand. Your first job for any
build request is to **route**: figure out which capabilities the request needs,
then turn on *only* those. Don't build everything; build toward what the user
asked for.

## The procedure

1. **Classify the request** into one or more capabilities using the matrix below.
   Most requests need 1–2 packs. When in doubt, start with the smallest set and
   grow later — you can always route again on the next turn.
2. **For each chosen pack, in order:**
   0. **If the pack ships a `pack.json`, scaffold it in one command** — `npm run
      pack:add -- <pack>` enables the service, installs the pinned modules,
      copies the kit, and wires scripts in one idempotent pass (see
      [`pack-manifest.md`](pack-manifest.md)). Today **`analytics`** ships one, so
      that whole path is a single command — then jump straight to reading the
      pack skill. Otherwise, do the manual steps below.
   1. **Enable the service** — edit `rayfin/rayfin.yml` (see the pack's row).
      Auth + data + static hosting are already on.
   2. **Install the modules** — `npm install <…>` for that pack. This is fast
      (Fabricator ships a warm offline cache), so just install what the pack
      needs. Skip modules that are already in `package.json`.
   3. **Scaffold the code** — create the entities / wiring / files the pack calls
      for (the pack's row says what; the pack's SKILL.md has the patterns).
   4. **Read the pack skill** — open `.agents/skills/<pack>/SKILL.md` and follow
      it for the real implementation details. Don't duplicate its guidance here.
3. **Keep it building** and let Fabricator auto-deploy. Don't run `rayfin up`, a
   dev server, or a local test runner (see `AGENTS.md`).

## Capability matrix

| Pack | Route here when the user wants… | Enable in `rayfin.yml` | Install | Scaffold | Then read |
|---|---|---|---|---|---|
| **authentication** | sign-in, accounts, login, logout, protected pages, "who is the current user", per-user data | `auth` (already on) | — (scaffolding already present) | Wire `AuthProvider` + `bootstrapAuth()` in `src/main.tsx`; add the route guard in `src/App.tsx` | `authentication` |
| **data-modeling** | records, CRUD, a database, entities, lists, "save/store X", per-user rows, row-level security | `data` (already on, `dialect: mssql`) + `auth` | `@microsoft/rayfin-data` | Add entity classes under `rayfin/data/*.ts`; register them in `rayfin/data/schema.ts`; read/write via the `rayfin-client`; **wire auth** (Rayfin data is always authenticated) | `data-modeling` **+ `authentication`** |
| **graphein-visuals** | a chart, graph, plot, KPI, table, or small dashboard over app data | — | `graphein` (already present) | Author a `ChartSpec`, drop into `<Chart spec={…} />` (`src/components/Chart.tsx`) | `graphein-visuals` |
| **analytics** | a **Power BI / semantic-model** dashboard, DAX measures, BI reporting over an existing dataset | one command: **`npm run pack:add -- analytics`** (sets `auth` on / **`data` off**, installs modules, copies `kit/**`, seeds a runnable demo) | — (the command installs them) | — (the command copies the kit + seeds `App.tsx`/`main.tsx`); then wire the semantic model | `analytics` (then `build-workflow`, `visuals`, `dax`, `fabric-data`, `app-design`, `headless-preview`) |

## Notes on routing

- **App-building vs analytics are different shapes.** The app-building packs
  (`authentication`, `data-modeling`, `graphein-visuals`)
  build a normal interactive app over Rayfin data, with `data` enabled. The
  **`analytics`** pack builds a read-only dashboard over an external Power BI
  **semantic model** (`data` disabled, its own dashboard kit). If the user wants
  charts over **their own app's data**, use `graphein-visuals`; if they want a
  dashboard over an **existing Power BI dataset/report**, use `analytics`.
- **Charts everywhere.** `graphein-visuals` composes with the app-building packs
  (e.g. `data-modeling` for the data + `graphein-visuals` for the chart).
- **Row-level security** lives inside `data-modeling` — route there when the user
  says "each user only sees their own …".
- **Data implies auth.** Rayfin data is always accessed as an authenticated user
  (no anonymous access on Fabric), so any request that stores or reads app data —
  `data-modeling` especially — must **also wire `authentication`**; route to both.
  A **static page over public data** needs neither. (Analytics is separate: its
  Power BI model is read through the Fabric embed proxy, which Fabric
  authenticates — no app `AuthProvider` needed.)
- **Grow incrementally.** Ship the core of what was asked, let it deploy, then add
  the next capability. You don't have to wire every pack up front.
