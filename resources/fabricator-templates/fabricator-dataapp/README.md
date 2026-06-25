# Data App

A **Fabric Analytics** React + Vite app: connect a Power BI semantic model,
query it with DAX, and build interactive dashboards with the Fabric visuals
toolkit — tuned for the **Rayfin Fabricator** deploy-to-test workflow.

> This is a Fabricator template: there is **no local backend, dev server, or
> test harness**. You build your app and deploy it to a Fabric test workspace —
> the Fabricator agent does this for you and validates the running app in its
> built-in browser.

## Getting started

In Fabricator, just describe the dashboard you want to build. The agent ships
with skills for schema discovery, DAX authoring, query design, and the Fabric
visuals/SDK. To deploy from the CLI:

```bash
npm run rayfin:up
```

The app authenticates through Fabric and renders inside the Fabric portal shell,
so it is meant to be opened from a deployed Fabric workspace (not `localhost`).

## Project structure

```text
├── .agents/
│   └── skills/             # Copilot skills (app-design, dax-authoring,
│                           # query-design, schema-discovery, visuals, …)
├── rayfin/
│   └── rayfin.yml          # Fabric service configuration (Fabric auth + static hosting)
├── fabric.yaml             # Fabric data connections (semantic model profiles)
├── src/
│   ├── main.tsx            # Entry point: theme, auth provider, auth gate
│   ├── App.tsx             # Your dashboard (starts on the empty-state preview)
│   ├── EmptyStatePreview.tsx   # Placeholder shown until you build a dashboard
│   ├── components/
│   │   └── auth-gate.component.tsx  # Blocks use outside the Fabric portal
│   ├── hooks/
│   │   ├── use-auth.tsx / auth.context.ts   # Fabric auth context
│   │   ├── use-theme.ts / theme.context.ts  # Light/dark theme
│   │   └── use-semantic-model-query.ts      # Query the connected semantic model
│   ├── lib/
│   │   ├── fabric-client.ts        # Fabric data client (connections from fabric.generated.ts)
│   │   ├── rayfin-client.ts        # Rayfin client singleton
│   │   ├── to-data-table.ts        # Shape query results for visuals
│   │   └── utils.ts
│   └── services/
│       └── rayfin-auth.service.ts  # Reads VITE_* env, builds Fabric auth
└── package.json
```

## Building a dashboard

1. **Connect a semantic model** — add a connection profile to `fabric.yaml`
   (the Fabricator agent wires this up when you point it at a model).
2. **Discover the schema** — list tables, columns, and measures.
3. **Write DAX queries** with `use-semantic-model-query`.
4. **Render visuals** from `@microsoft/fabric-visuals` / `@microsoft/fabric-datagrid`.
5. Replace `<EmptyStatePreview />` in `src/App.tsx` with your dashboard (and
   delete `EmptyStatePreview.tsx` + `empty-state-preview-world-map.png`).

`npm run build:fabric` runs `fabric-app-data generate` to produce
`src/fabric.generated.ts` (typed connection aliases) before the Vite build.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up`) |
| `npm run lint` | Lint with ESLint |
| `npm run rayfin:up` | Deploy the app to a Fabric test workspace |
