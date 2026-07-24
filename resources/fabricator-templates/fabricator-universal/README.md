# Universal App

A lean React + Vite starter that **grows into whatever you ask for**. Instead of
committing you to an app shape up front, it ships a small "hello world" home page
plus a **capability router** the agent reads first — it picks the right Rayfin
services, installs the right npm modules, and activates the right skills for the
app you describe.

> This is a Fabricator template: you build your app and deploy it to a Fabric
> test workspace — the Fabricator agent does this for you and validates the
> running app in its built-in browser. For a quick look without deploying, run
> `npm run preview` to serve the home page locally (no backend, no sign-in).

## How it works

Describe what you want in plain English. The agent starts at the **capability
router** (`AGENTS.md` + `.agents/skills/capability-router/`), maps your request
to one or more **capability packs**, and only then pulls each one in:

| You ask for… | The router activates | Which brings in |
|---|---|---|
| Sign-in / accounts / per-user data | `authentication` | Wire the Fabric auth that already ships in `src/services/` |
| Data, records, CRUD, a database | `data-modeling` | Entities + row-level security in `rayfin/data/`, `data` service |
| Charts, dashboards, KPIs | `graphein-visuals` | Author Graphein specs, drop into `<Chart>` |
| Power BI / semantic-model analytics | `analytics` | The dashboard kit, DAX queries, and headless preview |

Nothing heavy is loaded until it's needed — the base app stays small and fast.

## Getting started

In Fabricator, just describe what you want to build. To deploy from the CLI:

```bash
npm run rayfin:up
```

## Project structure

```text
├── AGENTS.md                       # Capability router — the agent reads this first
├── .agents/skills/                 # Capability packs (skills + on-demand assets)
│   ├── capability-router/          # Start-here orchestrator
│   ├── authentication/             # Turn on Fabric sign-in
│   ├── data-modeling/              # Entities + row-level security
│   ├── graphein-visuals/           # Charts as declarative specs
│   └── analytics/                  # Power BI semantic model + DAX dashboards
├── rayfin/
│   ├── rayfin.yml                  # Fabric service configuration
│   └── data/
│       └── schema.ts               # Empty data schema — the router fills this in
├── src/
│   ├── main.tsx                    # Entry point (auth wired off; router turns it on)
│   ├── App.tsx                     # Routes (no auth gate by default)
│   ├── main.css                    # Tailwind theme
│   ├── components/
│   │   ├── Chart.tsx               # Declarative <Chart spec={…} /> — Graphein binding
│   │   └── useChart.ts             # Headless Graphein binding hook
│   ├── hooks/AuthContext.tsx       # React context wrapping the auth helpers
│   ├── pages/HomePage.tsx          # "Hello, World" landing page
│   └── services/                   # Fabric auth scaffolding (wired off until needed)
└── package.json
```

Authentication ships wired **off** so the app previews with no backend. The
router turns it on when your app needs sign-in — see
`.agents/skills/authentication/SKILL.md`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run preview` | Preview the home page locally — no backend, no deploy |
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up`) |
| `npm run lint` | Lint with ESLint |
| `npm run rayfin:up` | Deploy the app to a Fabric test workspace |
