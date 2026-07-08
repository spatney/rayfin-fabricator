# Blank App

A bare-bones, Fabric-authenticated React + Vite app tuned for the **Fabricator**
deploy-to-test workflow — sign-in, routing, and a placeholder "Hello, World" home
page, with **[Graphein](https://github.com/spatney/graphein) wired in for
data-viz** so you can start building charts right away.

> This is a Fabricator template: there is **no local backend, dev server, or
> test harness**. You build your app and deploy it to a Fabric test workspace —
> the Fabricator agent does this for you and validates the running app in its
> built-in browser.

## Getting started

In Fabricator, just describe what you want to build. To deploy from the CLI:

```bash
npm run rayfin:up
```

## Charts with Graphein

Charts are **declarative**: one chart is one JSON `ChartSpec`. Author a spec and
drop it into the bundled `<Chart>` component — no charting library to wire up, no
SVG to hand-write.

```tsx
import { Chart } from '@/components/Chart';
import type { ChartSpec } from 'graphein';

const spec: ChartSpec = {
  type: 'bar',
  data: [
    { region: 'North', revenue: 4200 },
    { region: 'South', revenue: 3100 },
    { region: 'East', revenue: 5300 },
  ],
  encoding: {
    x: { field: 'region', type: 'nominal' },
    y: { field: 'revenue', type: 'quantitative', format: '$,.0f' },
  },
};

<div style={{ width: 640, height: 360 }}>
  <Chart spec={spec} />
</div>;
```

The `<Chart>` container fills its parent, so give the parent an explicit size.
See the **graphein-visuals** skill (`.agents/skills/graphein-visuals/`) for the
spec model, the chart-type catalog, and authoring guidance.

## Project structure

```text
├── rayfin/
│   ├── rayfin.yml          # Fabric service configuration (auth + data + static hosting)
│   └── data/
│       └── schema.ts       # Empty data schema — add entities here if you need storage
├── src/
│   ├── main.tsx            # Entry point + Rayfin client bootstrap
│   ├── App.tsx             # Routes and auth gate
│   ├── main.css            # Tailwind theme
│   ├── components/
│   │   ├── AuthPage.tsx    # Sign-in UI
│   │   ├── Chart.tsx       # Declarative <Chart spec={…} /> — Graphein React binding
│   │   └── useChart.ts     # Headless Graphein binding hook (render/update/destroy)
│   ├── hooks/
│   │   └── AuthContext.tsx # React context wrapping the auth helpers
│   ├── pages/
│   │   └── HomePage.tsx    # Post-auth landing page ("Hello, World")
│   └── services/
│       ├── IAuthService.ts        # Auth service contract + AuthUser type
│       ├── RayfinAuthService.ts   # Fabric brokered auth
│       ├── rayfinClient.ts        # Typed Rayfin client singleton
│       └── bootstrap.ts           # Reads env, builds the auth service
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up`) |
| `npm run lint` | Lint with ESLint |
| `npm run rayfin:up` | Deploy the app to a Fabric test workspace |
