/**
 * Project "skills": curated, app-building guidance modules the user can switch on
 * per project. Each active skill is inlined into `.github/copilot-instructions.md`
 * — the file the Copilot CLI reads from the project root — so enabling a skill
 * genuinely changes what the agent builds.
 *
 * The base "Rayfin essentials" skill is always present and cannot be removed.
 * Which add-on skills are active is tracked in `.github/rayfin-skills.json` (the
 * source of truth); the instructions file is a deterministic render of it. Every
 * add/remove is committed so the History view shows it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { run } from './exec'
import { findProject } from './store'
import type { SkillActionResult, SkillInfo } from '../../shared/ipc'

interface SkillDef {
  id: string
  title: string
  description: string
  icon: string
  /** The base skill is always on and cannot be toggled off. */
  base: boolean
  /** Markdown guidance inlined into the agent instructions when active. */
  body: string
}

/** The locked base skill: the core rules every Rayfin app build must follow. */
const BASE_BODY = `This is a **Rayfin app** (a Microsoft Fabric Backend-as-a-Service app). You are the
coding agent running inside **Rayfin Fabricator**, a desktop app that drives you plus the
Rayfin CLI to build and deploy this app.

- **Make the requested code changes only.** Edit files to implement what the user asks.
- **Do NOT run \`rayfin up\` or otherwise deploy.** Rayfin Fabricator runs the full
  \`rayfin up\` automatically after your changes and shows the deployed app in its preview.
- Do **not** start dev servers or run the app locally — it is only ever run via deploy.
- Keep the project building; prefer small, correct changes.
- Rayfin project config lives under \`rayfin/\` (e.g. \`rayfin/rayfin.yml\`); the data model
  and services (auth/data/storage/functions/static hosting) are configured there.
- Only use what Rayfin natively provides (data, auth, file storage, functions, static
  hosting). Do **not** add external services like payment processors or email senders.

When you finish editing, briefly summarize what you changed — Rayfin Fabricator handles the deploy.`

/**
 * The skill catalog. Order here is the canonical render + display order, so the
 * generated instructions file is stable regardless of the order skills are added.
 */
const CATALOG: SkillDef[] = [
  {
    id: 'rayfin-essentials',
    title: 'Rayfin essentials',
    description: 'Core rules for building & deploying this Rayfin app. Always on.',
    icon: '◆',
    base: true,
    body: BASE_BODY
  },
  {
    id: 'buttery-animations',
    title: 'Buttery-smooth animations',
    description: 'Add tasteful, performant motion — transitions, springs and micro-interactions.',
    icon: '✨',
    base: false,
    body: `Make the app feel alive with smooth, tasteful motion:
- Animate state changes (mount/unmount, list add/remove, route changes) instead of snapping.
- Prefer GPU-friendly \`transform\` and \`opacity\`; avoid animating layout properties (width,
  height, top/left) that cause reflow. Target a steady 60fps.
- Use natural easing — ease-out for entrances, spring-like curves for interactive elements.
  Keep durations short (120–300ms); never block the user waiting on an animation.
- Add subtle micro-interactions: hover/press feedback on buttons, gentle focus rings.
- Always respect \`prefers-reduced-motion\`: drop to instant/opacity-only when the user asks.`
  },
  {
    id: 'polished-ui',
    title: 'Polished, modern UI',
    description: 'A clean, consistent visual style with good spacing, type and color.',
    icon: '🎨',
    base: false,
    body: `Give the app a clean, modern, consistent look:
- Use a consistent spacing scale (4/8px rhythm), a clear type hierarchy and generous whitespace.
- Establish reusable design tokens (colors, radius, shadows) instead of one-off values; keep a
  single accent color and use it sparingly for primary actions.
- Flat and modern: subtle borders and soft shadows over heavy gradients; align elements to a grid.
- Support both light and dark themes with accessible contrast in each.
- Keep components visually consistent — buttons, inputs and cards should share sizing and shape.`
  },
  {
    id: 'responsive-layout',
    title: 'Responsive on every screen',
    description: 'Layouts that adapt cleanly from mobile to large desktop.',
    icon: '📱',
    base: false,
    body: `Make the UI work on any screen size:
- Design mobile-first, then enhance for larger viewports with sensible breakpoints.
- Use fluid layouts (flexbox/grid, %/fr, min/max, clamp()) rather than fixed pixel widths.
- Ensure tap targets are at least 44px and content never overflows or requires horizontal scroll.
- Collapse multi-column layouts into a single column on small screens; keep key actions reachable.
- Test the important flows at narrow (~375px) and wide (~1440px) widths.`
  },
  {
    id: 'accessibility',
    title: 'Accessible to everyone',
    description: 'Semantic, keyboard-friendly UI that works with screen readers.',
    icon: '♿',
    base: false,
    body: `Build the app to be usable by everyone:
- Use semantic HTML (button, nav, main, label, headings in order) before reaching for ARIA.
- Every interactive element must be keyboard reachable and operable, with a visible focus state.
- Label all form controls; associate errors with their inputs via aria-describedby.
- Provide alt text for meaningful images and aria-labels for icon-only buttons.
- Meet WCAG AA color contrast (4.5:1 for text); never rely on color alone to convey meaning.`
  },
  {
    id: 'loading-empty-states',
    title: 'Great loading & empty states',
    description: 'Skeletons, spinners and friendly empty/error states everywhere data loads.',
    icon: '⏳',
    base: false,
    body: `Handle every async state gracefully:
- Show a loading indicator (skeleton placeholders preferred over spinners) while data fetches.
- Design friendly empty states with a short explanation and a clear primary action ("Add your
  first item") instead of a blank screen.
- Show concise, recoverable error states with a retry option; never leave the user stuck.
- Use optimistic updates for quick actions where safe, reconciling once the server responds.
- Disable buttons and show progress while a submit is in flight to prevent double submits.`
  },
  {
    id: 'friendly-forms',
    title: 'Friendly forms & validation',
    description: 'Clear inputs, inline validation and helpful, human error messages.',
    icon: '📝',
    base: false,
    body: `Make data entry painless:
- Validate inline as the user goes and on submit; show errors next to the field, in plain language.
- Write helpful messages ("Enter a date in the future") rather than codes; suggest how to fix it.
- Use the right input types/keyboards, sensible defaults, placeholders and autofocus on the first field.
- Keep forms short; group related fields and explain anything non-obvious with helper text.
- Preserve the user's input on error and confirm success clearly after submit.`
  },
  {
    id: 'data-viz',
    title: 'Beautiful charts & dashboards',
    description: 'Turn your Rayfin data into clear, attractive charts and summaries.',
    icon: '📊',
    base: false,
    body: `Visualize the app's data well (it lives in Rayfin's data service):
- Pick the right chart for the question: trends over time → line, comparisons → bar,
  parts of a whole → donut (sparingly). Avoid 3D and chart junk.
- Lead with the headline numbers (KPIs/summary cards), then the supporting charts.
- Use clear axis labels, readable tick counts, accessible colors and tooltips on hover.
- Keep charts responsive and show a tidy empty state when there's no data yet.
- Aggregate/query data through Rayfin rather than pulling everything to the client.`
  }
]

const MANIFEST_REL = join('.github', 'rayfin-skills.json')
const INSTRUCTIONS_REL = join('.github', 'copilot-instructions.md')
const BASE_ID = 'rayfin-essentials'

interface Manifest {
  active: string[]
}

function byId(id: string): SkillDef | undefined {
  return CATALOG.find((s) => s.id === id)
}

/** Read the active-skill ids from the manifest, always including the base skill. */
function readActive(dir: string): Set<string> {
  const active = new Set<string>([BASE_ID])
  try {
    const raw = readFileSync(join(dir, MANIFEST_REL), 'utf8')
    const parsed = JSON.parse(raw) as Manifest
    if (Array.isArray(parsed.active)) {
      for (const id of parsed.active) if (byId(id)) active.add(id)
    }
  } catch {
    /* no manifest yet → base only */
  }
  return active
}

function writeManifest(dir: string, active: Set<string>): void {
  // Persist in catalog order for a stable, readable file.
  const ordered = CATALOG.filter((s) => active.has(s.id)).map((s) => s.id)
  const ghDir = join(dir, '.github')
  if (!existsSync(ghDir)) mkdirSync(ghDir, { recursive: true })
  writeFileSync(join(dir, MANIFEST_REL), JSON.stringify({ active: ordered }, null, 2) + '\n', 'utf8')
}

/** Deterministically render the agent instructions file from the active skills. */
function renderInstructions(active: Set<string>): string {
  const base = byId(BASE_ID)!
  const addOns = CATALOG.filter((s) => !s.base && active.has(s.id))

  let out = '<!-- Generated by Rayfin Fabricator. Manage these in the Skills tab;'
  out += ' changes here may be overwritten. -->\n\n'
  out += '# Rayfin Fabricator — agent guidance\n\n'
  out += base.body.trim() + '\n'

  if (addOns.length) {
    out += '\n---\n\n# Enabled skills\n\n'
    out += 'The user turned these skills on for this app. Apply them to all relevant work.\n'
    for (const s of addOns) {
      out += `\n<!-- skill:${s.id} -->\n`
      out += `## ${s.icon} ${s.title}\n\n`
      out += s.body.trim() + '\n'
      out += `<!-- /skill:${s.id} -->\n`
    }
  }
  return out
}

/** Write the instructions file only when its content actually changed (avoids churn). */
function writeInstructions(dir: string, active: Set<string>): void {
  const content = renderInstructions(active)
  const file = join(dir, INSTRUCTIONS_REL)
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return
  } catch {
    /* fall through and write */
  }
  const ghDir = join(dir, '.github')
  if (!existsSync(ghDir)) mkdirSync(ghDir, { recursive: true })
  writeFileSync(file, content, 'utf8')
}

/**
 * Ensure the project has a skills manifest + a current instructions file. Called
 * on scaffold/open. Best-effort: the deploy loop still works without it.
 */
export function ensureProjectSkills(dir: string): void {
  try {
    if (!existsSync(join(dir, MANIFEST_REL))) {
      writeManifest(dir, new Set([BASE_ID]))
    }
    writeInstructions(dir, readActive(dir))
  } catch {
    /* best-effort */
  }
}

function toInfo(active: Set<string>): SkillInfo[] {
  return CATALOG.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    icon: s.icon,
    base: s.base,
    active: active.has(s.id)
  }))
}

/** The skill catalog for a project, each flagged with whether it's currently active. */
export function listSkills(projectId: string): SkillInfo[] {
  const project = findProject(projectId)
  if (!project) return []
  return toInfo(readActive(project.path))
}

/** Ensure a local git identity exists so commits don't fail on a fresh machine. */
async function ensureGitIdentity(dir: string): Promise<void> {
  const email = await run('git', ['config', 'user.email'], { cwd: dir, timeout: 15_000 })
  if (!email.stdout.trim()) {
    await run('git', ['config', 'user.email', 'fabricator@rayfin.local'], { cwd: dir, timeout: 15_000 })
    await run('git', ['config', 'user.name', 'Rayfin Fabricator'], { cwd: dir, timeout: 15_000 })
  }
}

/**
 * Turn a skill on or off for a project: update the manifest, re-render the agent
 * instructions, and commit just those two files. The base skill cannot be removed.
 */
export async function setSkill(
  projectId: string,
  skillId: string,
  active: boolean
): Promise<SkillActionResult> {
  const project = findProject(projectId)
  if (!project) return { ok: false, error: 'Project not found.', skills: [] }

  const def = byId(skillId)
  if (!def) return { ok: false, error: 'Unknown skill.', skills: listSkills(projectId) }
  if (def.base && !active) {
    return {
      ok: false,
      error: "The base Rayfin skill is required and can't be removed.",
      skills: listSkills(projectId)
    }
  }

  const dir = project.path
  const current = readActive(dir)
  if (active) current.add(skillId)
  else current.delete(skillId)

  try {
    writeManifest(dir, current)
    writeInstructions(dir, current)
  } catch (err) {
    return { ok: false, error: `Could not update skills: ${String(err)}`, skills: toInfo(current) }
  }

  // Commit just the skill files (best-effort) so the change shows in History.
  try {
    await ensureGitIdentity(dir)
    await run('git', ['add', MANIFEST_REL, INSTRUCTIONS_REL], { cwd: dir, timeout: 30_000 })
    const message = `${active ? 'Add' : 'Remove'} skill: ${def.title}`
    await run('git', ['commit', '-m', message, '--', MANIFEST_REL, INSTRUCTIONS_REL], {
      cwd: dir,
      timeout: 30_000
    })
  } catch {
    /* best-effort — the files are written even if the commit fails */
  }

  return { ok: true, skills: toInfo(current) }
}
