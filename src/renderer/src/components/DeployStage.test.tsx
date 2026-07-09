import { describe, it, expect } from 'vitest'
import { DEPLOY_PHASES, resolvePhaseIndex } from './DeployStage'

/**
 * Regression coverage for deploy phase detection, pinned to a real `rayfin up`
 * transcript. The log is streamed cumulatively, so each slice below is appended
 * to the previous ones; `resolvePhaseIndex` must track the furthest phase reached
 * without ever jumping ahead from an early line (the desync bug this fixes).
 */

const SLICES = {
  connect: `Deploying blanky to Fabric…
👀 Found Rayfin project root: C:\\Users\\sachi\\RayfinProjects\\blanky
📋 Using project name 'blanky' from rayfin.yml configuration
🔑 No active session found — launching login...
🏢 Using workspace "FabCON" (ID: fa67c3f6-03b2-4cc3-9403-956c4be2f38b)
🚀 Deploying project "blanky" to Fabric...`,
  prepare: `♻️  Redeployment detected — reusing Rayfin item b1fde25e-eccd-498e-89ed-11a7ef4a2da2
📍 Targeting:
   Workspace:   FabCON (fa67c3f6-03b2-4cc3-9403-956c4be2f38b)
   Item:        blanky (b1fde25e-eccd-498e-89ed-11a7ef4a2da2)
🔗 Workload endpoint: https://943bd5c7.pbidedicated.windows.net/webapi/...
[rayfin up] Publishable key retrieved... done (2.7s)
[rayfin up] Runtime settings applied... done (251ms)
🗄️  Applying database configuration...
[rayfin] TypeScript compilation successful... done (368ms)
✅ Wrote deployment config to C:\\Users\\sachi\\RayfinProjects\\blanky\\rayfin\\.deployments.json`,
  build: `📄 Deploying static content...
🔨 Running static build command: npm run build:fabric

> blanky@0.0.0 build:fabric
> tsc -b && vite build

vite v7.3.6 building client environment for production...
transforming...
✓ 101 modules transformed.`,
  pkg: `rendering chunks...
computing gzip size...
dist/index.html                   0.67 kB │ gzip:   0.37 kB
✓ built in 697ms
✔ Static build command completed
[rayfin up] Static content packaged (3 files, 334.3 KB)... done (18ms)`,
  upload: `[rayfin up] Static content deployed (3 files, 334.3 KB)... done (4.8s)
  🌐 Hosting URL: https://hazy-shade-9227facbc8-westus.webapp.fabricapps.net
  🏷️ Deployment ID: deploy-20260709062507-f6791c3c`,
  live: `🎉 Project "blanky" is now deployed to Fabric!

📌 Next steps:
   • Your app is live at: https://hazy-shade-9227facbc8-westus.webapp.fabricapps.net`
}

const ORDER = ['connect', 'prepare', 'build', 'pkg', 'upload', 'live'] as const

/** Cumulative log up to and including the given slice (as the CLI streams it). */
function cumulative(upTo: keyof typeof SLICES): string {
  const stop = ORDER.indexOf(upTo)
  return ORDER.slice(0, stop + 1)
    .map((k) => SLICES[k])
    .join('\n')
}

const labelAt = (i: number): string => DEPLOY_PHASES[i].label

describe('deploy phase detection', () => {
  it('tracks the real rayfin up output through every phase in order', () => {
    // elapsed 0 so the time floor never interferes — pure marker detection.
    expect(labelAt(resolvePhaseIndex(cumulative('connect'), 0))).toBe('Connecting to Fabric')
    expect(labelAt(resolvePhaseIndex(cumulative('prepare'), 0))).toBe('Preparing deployment')
    expect(labelAt(resolvePhaseIndex(cumulative('build'), 0))).toBe('Building your app')
    expect(labelAt(resolvePhaseIndex(cumulative('pkg'), 0))).toBe('Packaging assets')
    expect(labelAt(resolvePhaseIndex(cumulative('upload'), 0))).toBe('Uploading to Fabric')
    expect(labelAt(resolvePhaseIndex(cumulative('live'), 0))).toBe('Going live')
  })

  it('does not jump ahead from the early workspace / deploy / item lines (the desync bug)', () => {
    // Through "Runtime settings applied" the log already repeats workspace, deploy,
    // and item many times — it must still read as an early phase, not Uploading/Live.
    const early = cumulative('prepare').toLowerCase()
    expect(early).toContain('workspace')
    expect(early).toContain('item')
    expect(early).toContain('deploying')
    expect(resolvePhaseIndex(cumulative('prepare'), 0)).toBeLessThanOrEqual(1)
  })

  it('advances gently by time during the initial silent period, capped at Packaging', () => {
    expect(labelAt(resolvePhaseIndex('', 0))).toBe('Connecting to Fabric')
    expect(labelAt(resolvePhaseIndex('', 5))).toBe('Preparing deployment')
    expect(labelAt(resolvePhaseIndex('', 12))).toBe('Building your app')
    // Time alone never claims the app is uploaded or live — capped at Packaging.
    expect(labelAt(resolvePhaseIndex('', 600))).toBe('Packaging assets')
  })

  it('never regresses once a phase marker has been seen', () => {
    const built = cumulative('build') + '\n[rayfin up] some unrelated trailing chatter\n'
    expect(labelAt(resolvePhaseIndex(built, 0))).toBe('Building your app')
  })

  it('is resilient to CLI wording changes via generic synonyms', () => {
    // A future/other CLI phrasing that shares none of the exact rayfin lines.
    expect(labelAt(resolvePhaseIndex('Compiling application with esbuild…', 0))).toBe('Building your app')
    expect(labelAt(resolvePhaseIndex('Uploading artifacts to the workspace…', 0))).toBe('Uploading to Fabric')
  })
})
