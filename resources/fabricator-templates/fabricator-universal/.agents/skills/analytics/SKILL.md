---
name: analytics
description: Enable on demand for Power BI, semantic model, dataset, DAX, analytics dashboard, KPI dashboard, report, measure, business intelligence, or BI requests.
---

# Analytics capability pack

This pack is dormant reference code until copied into the app. Do not import `kit/**` from the running universal template.

When the user asks for a Power BI / semantic-model analytics dashboard:

1. Install the npm modules in `MODULES.md` (runtime dependencies and devDependencies).
2. Copy `kit/components/**`, `kit/hooks/**`, `kit/lib/**`, `kit/demo/**`, `kit/global.css`, and `kit/fabric.generated.ts` into `src/`; copy `kit/fabric.yaml` to the project root; copy `kit/scripts/preview-visual.mjs` to `scripts/preview-visual.mjs`.
3. Add/replace the required scripts from the data app:
   - `build:fabric`: `npx fabric-app-data generate -o src/fabric.generated.ts && tsc -b --noCheck && vite build`
   - `preview`: `node scripts/preview-visual.mjs`
   - `gallery`: `vite`
4. Wire the semantic model using the `fabric-data` skill and the `connect-semantic-model` skill if available. Edit `fabric.yaml`; regenerate `src/fabric.generated.ts` via `build:fabric`.
5. Build the dashboard by pulling in `build-workflow`, `visuals`, and `dax` as needed. Keep imports such as `@/components/dashboard` unchanged after copying into `src/`.
