# Universal App

A lean React + Vite starter that **grows into whatever you ask for**. Instead of
committing you to an app shape up front, it ships a small "hello world" home page
plus a **capability router** the agent reads first — it picks the right Rayfin
services, installs the right npm modules, and activates the right skills for the
app you describe.

> This is a Fabricator template: describe your app, and Fabricator deploys the
> agent's changes to a Fabric test workspace and shows the running app in its
> built-in browser. For a quick look at the public starter without deploying,
> run `npm run preview` to serve the home page locally (no backend, no sign-in).

## How it works

Describe what you want in plain English. The agent starts at the **capability
router** (`AGENTS.md` + `.agents/skills/capability-router/`), maps your request
to one or more **capability packs**, and only then pulls each one in:

| You ask for… | The router activates | Which brings in |
|---|---|---|
| Sign-in / accounts / per-user data | `authentication` | Wire the Fabric auth that already ships in `src/services/` |
| Data, records, CRUD, a database | `data-modeling` **+ `authentication`** by default | Entities + row-level security in `rayfin/data/`; auth wired for the template's default authenticated data workflow |
| Charts, dashboards, KPIs | `graphein-visuals` | Author Graphein specs, drop into `<Chart>` |
| Power BI / semantic-model analytics | `analytics` | One command — `npm run pack:add -- analytics` scaffolds the dashboard kit, DAX + headless preview, and a runnable demo |

Nothing heavy is loaded until it's needed — the base app stays small and fast.

## Getting started

In Fabricator, describe what you want to build; Fabricator handles deployment
after the agent's changes. For manual CLI deployment outside that workflow:

```bash
npm run rayfin:up
```

## Documentation

Visit [Rayfin](https://rayfin.ai/) or
[browse the documentation](https://rayfin.ai/docs) for platform guides, SDK
APIs, authentication, data modeling, configuration, and known limitations.
This template's README and skills focus on its own integration points rather
than duplicating those guides.

Coding agents should start with [AGENTS.md](AGENTS.md), including its
[documentation guidance](AGENTS.md#rayfin-documentation) for machine-readable
references, version-matched APIs, and Fabricator's workflow rules.
The [rayfin-web-docs skill](.agents/skills/rayfin-web-docs/SKILL.md) performs
targeted website lookups before Rayfin-specific changes, without fetching
unrelated documentation for purely visual edits.

## Project structure

```text
├── AGENTS.md                       # Capability router — the agent reads this first
├── .agents/skills/                 # Capability packs (skills + on-demand assets)
│   ├── capability-router/          # Start-here orchestrator
│   ├── rayfin-web-docs/            # Official docs lookup for Rayfin changes
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

Authentication ships wired **off** so the static base previews with no backend.
The agent wires it in for the template's **default authenticated data workflow**
or features that need sign-in. A static page over public data can stay no-auth.
See the [authentication skill](.agents/skills/authentication/SKILL.md) for the
template's wiring and backend requirements.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run preview` | Preview the home page locally — no backend, no deploy |
| `npm run pack:add -- <pack>` | Turn on a capability pack in one step (e.g. `analytics`) — see `.agents/skills/capability-router/pack-manifest.md` |
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up`) |
| `npm run lint` | Lint with ESLint |
| `npm run rayfin:up` | Deploy the app to a Fabric test workspace |
