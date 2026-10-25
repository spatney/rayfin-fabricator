import { describe, expect, it } from 'vitest'
import {
  LEGACY_PHASES,
  deployRuns,
  legacyPhaseIndex,
  readDeployProgress,
  type DeployProgress
} from './deployProgress'

/**
 * A Rayfin 1.36 deploy, as a piped `rayfin up -y --force` prints it: the
 * workflow's `[rayfin] <phase>: <message>` progress (the build itself is
 * quiet), then the result. Reconstructed from the CLI's source and the
 * diagnostic log of a real run.
 */
const V2 = {
  start: `Deploying Boo to Fabric…
👀 Found Rayfin project root: C:\\Users\\sachi\\RayfinProjects\\boo`,
  license: `[rayfin] license: Checking user license`,
  workspace: `[rayfin] dependencies: Inspecting project dependencies
[rayfin] workspace: Resolving workspace`,
  item: `[rayfin] item: Resolving Rayfin item
[rayfin] target: Resolving workload endpoint`,
  settings: `[rayfin] settings: Applying runtime settings`,
  data: `[rayfin] data: Applying database configuration
[rayfin] persist: Recording deployment`,
  build: `[rayfin] static: Deploying static content`,
  live: `
📝 Deployment details:
  - Rayfin Item Name: boo
  - Static Hosting URL: https://hazy-shade-9227facbc8-westus.webapp.fabricapps.net

🎉 Project "boo" is now deployed to Fabric!
   • Your app is live at: https://hazy-shade-9227facbc8-westus.webapp.fabricapps.net`
}

const V2_ORDER = ['start', 'license', 'workspace', 'item', 'settings', 'data', 'build', 'live'] as const

/** The log streamed so far, up to and including `upTo`, in chunks as Fabricator receives them. */
function v2(upTo: (typeof V2_ORDER)[number], extra = ''): string[] {
  const parts = V2_ORDER.slice(0, V2_ORDER.indexOf(upTo) + 1).map((k) => `${V2[k]}\n`)
  return extra ? [...parts, extra] : parts
}

const labels = (p: DeployProgress, state?: 'done' | 'active' | 'todo'): string[] =>
  p.steps.filter((s) => !state || s.state === state).map((s) => s.label)

describe('reading Rayfin 1.35+ progress', () => {
  it('turns each progress phase into a step, in order, with the CLI’s words as its detail', () => {
    const at = (upTo: (typeof V2_ORDER)[number]): DeployProgress => readDeployProgress(v2(upTo), 0)

    expect(at('license').current.label).toBe('Connecting to Fabric')
    expect(at('license').detail).toBe('Checking user license')
    expect(at('workspace').current.label).toBe('Finding your workspace')
    expect(at('item').current.label).toBe('Setting up your app in Fabric')
    expect(at('item').detail).toBe('Resolving workload endpoint')
    expect(at('data').current.label).toBe('Updating your database')
    // "Recording deployment" is a moment within the step, not a step of its own.
    expect(at('data').detail).toBe('Recording deployment')
    expect(at('build').current.label).toBe('Building and uploading your app')
    expect(at('build').reading).toBe('structured')

    const live = at('live')
    expect(live.live).toBe(true)
    expect(labels(live, 'done')).toEqual([
      'Connecting to Fabric',
      'Finding your workspace',
      'Setting up your app in Fabric',
      'Applying settings',
      'Updating your database',
      'Building and uploading your app',
      'Going live'
    ])
    expect(live.at).toBe(1)
  })

  it('shows the steps every deploy still has to come, and moves forward only', () => {
    const item = readDeployProgress(v2('item'), 0)
    expect(labels(item, 'todo')).toEqual([
      'Applying settings',
      'Building and uploading your app',
      'Going live'
    ])

    let at = 0
    for (const upTo of V2_ORDER) {
      const p = readDeployProgress(v2(upTo), 0)
      expect(p.at).toBeGreaterThanOrEqual(at)
      expect(p.next).toBeGreaterThanOrEqual(p.at)
      at = p.at
    }

    // A later line about an earlier step changes nothing.
    const back = readDeployProgress(v2('data', '[rayfin] settings: Applying runtime settings\n'), 0)
    expect(back.current.label).toBe('Updating your database')
    expect(back.detail).toBe('Recording deployment')
  })

  it('shows a phase it doesn’t know in the CLI’s own words, and takes its percentage', () => {
    const p = readDeployProgress(v2('settings', '[rayfin] secrets: Syncing 3 secrets... (40%)\n'), 0)
    expect(p.current.id).toBe('cli:secrets')
    expect(p.current.label).toBe('Syncing 3 secrets')
    expect(p.detail).toBeNull()
    expect(p.percent).toBe(40)
    expect(p.topic).toBe('other')

    const after = readDeployProgress(v2('settings', '[rayfin] secrets: Syncing\n' + V2.build + '\n'), 0)
    expect(labels(after, 'done')).toContain('Syncing')
    expect(after.current.label).toBe('Building and uploading your app')
  })

  it('ignores lines that only look like progress', () => {
    const odd = [
      '[rayfin] working',
      '[rayfin] using ambient token from RAYFIN_TOKEN',
      '[rayfin] rayfin/.lockfile.json: ignoring unknown packages: x',
      '[rayfin] TypeScript compilation successful... done (368ms)',
      '⚠️  Something the screen has never seen before',
      '\u001b[33mcoloured noise\u001b[0m'
    ].join('\n')
    const p = readDeployProgress(v2('item', `${odd}\n`), 0)
    expect(p.current.label).toBe('Setting up your app in Fabric')
    expect(p.steps).toHaveLength(readDeployProgress(v2('item'), 0).steps.length)
  })
})

describe('reading any deploy', () => {
  it('connects first, and waits for evidence before reading the log as an older CLI’s', () => {
    expect(readDeployProgress([], 0).current.label).toBe('Connecting to Fabric')
    // A silent CLI is still connecting, not building.
    expect(readDeployProgress(v2('start'), 10).reading).toBe('pending')
    expect(readDeployProgress(v2('start'), 10).current.label).toBe('Connecting to Fabric')
    // Nothing telling for long enough: read it as an older CLI's, by the clock.
    expect(readDeployProgress(v2('start'), 25).reading).toBe('legacy')
    expect(readDeployProgress(v2('start'), 25).current.label).toBe('Building your app')
  })

  it('says when the CLI is waiting for a browser sign-in', () => {
    const asking = v2('start', '🔑 No active session found — launching login...\n')
    expect(readDeployProgress(asking, 0).topic).toBe('signin')
    // Never mistaken for an older CLI, however long the sign-in takes.
    expect(readDeployProgress(asking, 90).reading).toBe('pending')
    expect(readDeployProgress([...asking, `${V2.license}\n`], 90).topic).toBe('connect')
  })

  it('installs missing packages before connecting', () => {
    const installing = [
      'Deploying Boo to Fabric…\n',
      'Project dependencies are missing; installing them with npm...\n',
      'added 412 packages in 38s\n'
    ]
    const p = readDeployProgress(installing, 60)
    expect(p.current.label).toBe('Installing packages')
    expect(labels(p, 'todo')[0]).toBe('Connecting to Fabric')
    expect(p.reading).toBe('pending')

    const started = readDeployProgress([...installing, '👀 Found Rayfin project root: C:\\boo\n'], 0)
    expect(labels(started, 'done')).toEqual(['Installing packages'])
    expect(started.current.label).toBe('Connecting to Fabric')

    const repairing = readDeployProgress(
      [
        'Deploying Boo to Fabric…\n',
        'Project dependencies are missing or incomplete (commander); reinstalling them with npm...\n'
      ],
      5
    )
    expect(repairing.current.label).toBe('Installing packages')

    // Waiting for another install to finish isn't an older CLI building.
    const waiting = readDeployProgress(
      ['Deploying Boo to Fabric…\n', "Waiting for changes to this project's packages to finish...\n"],
      60
    )
    expect(waiting.current.label).toBe('Installing packages')
    expect(waiting.reading).toBe('pending')
  })

  it('starts over when a sign-in retry runs the deploy again', () => {
    const log = [
      ...v2('license'),
      'Deploy failed: Unauthorized\n',
      'Deploying Boo to Fabric…\n',
      `${V2.license}\n`
    ]
    expect(deployRuns(log)).toBe(2)
    expect(readDeployProgress(log, 0).current.label).toBe('Connecting to Fabric')
    expect(readDeployProgress([...log, `${V2.workspace}\n`], 0).current.label).toBe(
      'Finding your workspace'
    )
  })

  it('says when an older CLI is trying a request again', () => {
    const p = readDeployProgress(['⏳ Waiting 2s before retry... (1/5)\n'], 0)
    expect(p.topic).toBe('retry')
  })
})

/**
 * An older CLI's deploy (Rayfin 1.34 and earlier), pinned to a real `rayfin up`
 * transcript. Each slice is appended to the previous ones, as the log streams.
 */
const LEGACY = {
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

const LEGACY_ORDER = ['connect', 'prepare', 'build', 'pkg', 'upload', 'live'] as const

/** Cumulative log up to and including the given slice (as the CLI streams it). */
function cumulative(upTo: (typeof LEGACY_ORDER)[number]): string {
  return LEGACY_ORDER.slice(0, LEGACY_ORDER.indexOf(upTo) + 1)
    .map((k) => LEGACY[k])
    .join('\n')
}

const labelAt = (i: number): string => LEGACY_PHASES[i].label

describe('reading an older CLI’s deploy', () => {
  it('tracks the real rayfin up output through every step in order', () => {
    // elapsed 0 so the time floor never interferes — pure marker detection.
    expect(labelAt(legacyPhaseIndex(cumulative('connect'), 0))).toBe('Connecting to Fabric')
    expect(labelAt(legacyPhaseIndex(cumulative('prepare'), 0))).toBe('Preparing deployment')
    expect(labelAt(legacyPhaseIndex(cumulative('build'), 0))).toBe('Building your app')
    expect(labelAt(legacyPhaseIndex(cumulative('pkg'), 0))).toBe('Packaging assets')
    expect(labelAt(legacyPhaseIndex(cumulative('upload'), 0))).toBe('Uploading to Fabric')
    expect(labelAt(legacyPhaseIndex(cumulative('live'), 0))).toBe('Going live')

    const p = readDeployProgress([`${cumulative('pkg')}\n`], 0)
    expect(p.reading).toBe('legacy')
    expect(labels(p, 'done')).toEqual(['Connecting to Fabric', 'Preparing deployment', 'Building your app'])
    expect(p.current.label).toBe('Packaging assets')
    expect(labels(p, 'todo')).toEqual(['Uploading to Fabric', 'Going live'])
    expect(p.detail).toBeNull()
  })

  it('does not jump ahead from the early workspace / deploy / item lines (the desync bug)', () => {
    // Through "Runtime settings applied" the log already repeats workspace, deploy,
    // and item many times — it must still read as an early step, not Uploading/Live.
    const early = cumulative('prepare').toLowerCase()
    expect(early).toContain('workspace')
    expect(early).toContain('item')
    expect(early).toContain('deploying')
    expect(legacyPhaseIndex(cumulative('prepare'), 0)).toBeLessThanOrEqual(1)
  })

  it('advances gently by time during silent stretches, capped at Packaging', () => {
    expect(labelAt(legacyPhaseIndex('', 0))).toBe('Connecting to Fabric')
    expect(labelAt(legacyPhaseIndex('', 5))).toBe('Preparing deployment')
    expect(labelAt(legacyPhaseIndex('', 12))).toBe('Building your app')
    // Time alone never claims the app is uploaded or live — capped at Packaging.
    expect(labelAt(legacyPhaseIndex('', 600))).toBe('Packaging assets')
  })

  it('never regresses once a step marker has been seen', () => {
    const built = cumulative('build') + '\n[rayfin up] some unrelated trailing chatter\n'
    expect(labelAt(legacyPhaseIndex(built, 0))).toBe('Building your app')
  })

  it('is resilient to CLI wording changes via generic synonyms', () => {
    // A future/other CLI phrasing that shares none of the exact rayfin lines.
    expect(labelAt(legacyPhaseIndex('Compiling application with esbuild…', 0))).toBe(
      'Building your app'
    )
    expect(labelAt(legacyPhaseIndex('Uploading artifacts to the workspace…', 0))).toBe(
      'Uploading to Fabric'
    )
  })
})
