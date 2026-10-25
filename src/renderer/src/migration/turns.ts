/**
 * A report migration's turns: which page comes next, whether the material is
 * ready, and what Copilot is asked for each page. Pure, so it's easy to test;
 * `useMigration` drives it.
 */
import type { ChatMigrationRef, MigrationPage, MigrationState } from '@shared/ipc'

/**
 * The order pages are migrated in: the report's visible pages in order, then
 * its hidden drillthrough pages, its tooltip pages, and any other hidden page.
 * Returns indexes into `state.pages`.
 */
export function turnOrder(state: Pick<MigrationState, 'pages'>): number[] {
  const rank = (p: MigrationPage): number =>
    !p.hidden && p.kind !== 'tooltip' ? 0 : p.kind === 'drillthrough' ? 1 : p.kind === 'tooltip' ? 2 : 3
  return state.pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => rank(a.page) - rank(b.page) || a.page.order - b.page.order)
    .map(({ index }) => index)
}

const open = (status: string): boolean => status === 'pending' || status === 'running'

/** Gathering is finished: whatever could be read and drawn has been. */
export function materialReady(state: MigrationState): boolean {
  const { definition, model, export: pdf, images } = state.stages
  if (open(definition.status) || open(model.status) || open(pdf.status)) return false
  return !(pdf.status === 'done' && open(images.status))
}

/** The export finished and its pages still need drawing. */
export function needsDrawing(state: MigrationState): boolean {
  return state.stages.export.status === 'done' && state.pdfs.length > 0 && open(state.stages.images.status)
}

/** No page has had a turn yet. */
export function isFresh(state: MigrationState): boolean {
  return state.pages.length > 0 && state.pages.every((p) => p.status === 'pending')
}

/** The next page to migrate: the first in turn order that isn't done or running. */
export function nextPage(state: MigrationState): number | null {
  if (state.pages.some((p) => p.status === 'running')) return null
  return turnOrder(state).find((i) => state.pages[i].status !== 'done') ?? null
}

export function doneCount(state: MigrationState): number {
  return state.pages.filter((p) => p.status === 'done').length
}

/** One migration turn, ready to send. */
export interface MigrationTurn {
  pageIndex: number
  display: string
  prompt: string
  migration: ChatMigrationRef
  /** The page image, when it was drawn, as an absolute path with its preview. */
  shots: { path: string; thumb: string }[]
}

/** `rel` (forward slashes) under `root`, in `root`'s own separator style. */
export function absolutePath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}

const quote = (text: string): string => `“${text.replace(/\s+/g, ' ').trim()}”`

function kindNote(page: MigrationPage): string | null {
  if (page.kind === 'tooltip') return 'This is a tooltip page: build it as the tooltip of the visuals that use it, not as a tab.'
  if (page.kind === 'drillthrough') {
    return 'This is a drillthrough page: build it as a detail view, opened from the visuals the report drills from and filtered by the value clicked, not as a tab.'
  }
  if (page.hidden) return 'This page is hidden in the report: build it, and leave it out of the navigation unless a button leads there.'
  return null
}

/** Where Copilot finds a page's material, and what's missing. */
function pageMaterial(state: MigrationState, page: MigrationPage): string {
  const parts = [`its section in \`${state.dir}/README.md\``]
  if (page.image) parts.push(`\`${page.image}\` (attached; what it looks like)`)
  if (page.text) parts.push(`\`${page.text}\` (its text and values)`)
  let out = `Use ${parts.join(', ')}.`
  if (!page.image) out += ' There is no page image: work from the README and `report.json`.'
  return out
}

/** Notes about material that couldn't be gathered. */
function gaps(state: MigrationState): string[] {
  const out: string[] = []
  if (state.stages.definition.status !== 'done') {
    out.push(
      "Fabricator couldn't read the report's definition, so the README lists the pages only: work from the page images and text, and use `schema-discovery` to find the fields."
    )
  }
  if (state.stages.model.status !== 'done' && state.source.modelId) {
    out.push("`model.md` isn't available: discover the model's tables and measures with queries (`schema-discovery`).")
  } else if (state.stages.model.message) {
    out.push(`\`model.md\`: ${state.stages.model.message}`)
  }
  return out
}

/** The turn that migrates `pageIndex`; the first turn also sets up the app. */
export function migrationTurn(state: MigrationState, pageIndex: number, projectPath: string): MigrationTurn {
  const order = turnOrder(state)
  const page = state.pages[pageIndex]
  const position = order.indexOf(pageIndex)
  const count = state.pages.length
  const report = state.source.reportName
  const foundation = isFresh(state) || (position === 0 && page.status !== 'done' && doneCount(state) === 0)
  const last = order.filter((i) => i !== pageIndex).every((i) => state.pages[i].status === 'done')
  const migration: ChatMigrationRef = {
    reportName: report,
    foundation: foundation || undefined,
    page: { index: position, count, name: page.displayName }
  }
  const shots = page.image && page.thumb ? [{ path: absolutePath(projectPath, page.image), thumb: page.thumb }] : []
  const lines: string[] = []

  if (foundation) {
    const command = connectorCommand(state)
    lines.push(
      `[Fabricator: migrate the Power BI report ${quote(report)} into this app with the migrate-powerbi-report skill. This is the first turn: set up the app, then migrate page 1 of ${count}.]`,
      '',
      `The material is in \`${state.dir}/\`. Start with \`${state.dir}/README.md\`.`
    )
    if (command) {
      lines.push(
        '',
        `Connect the report's semantic model${state.source.modelName ? ` ${quote(state.source.modelName)}` : ''} live, as \`${state.alias}\`:`,
        '',
        '```',
        command,
        '```'
      )
    }
    const tabs = order
      .map((i) => state.pages[i])
      .filter((p) => !p.hidden && p.kind !== 'tooltip')
      .map((p) => quote(p.displayName))
    lines.push(
      '',
      'This turn:',
      `1. Set up the app as the skill's first turn describes: the capabilities, the connector, Graphein for the visuals, a page for each report page (${tabs.join(', ')}), the report-level filters and the theme.`,
      `2. Migrate page 1, ${quote(page.displayName)}. ${pageMaterial(state, page)}`,
      '3. Start `MIGRATION.md`.'
    )
    if (count > 1) lines.push('', "Don't migrate the other pages yet: Fabricator asks for them one at a time.")
  } else {
    lines.push(
      `[Fabricator: continue migrating the Power BI report ${quote(report)} with the migrate-powerbi-report skill: page ${position + 1} of ${count}, ${quote(page.displayName)}.]`,
      '',
      `${pageMaterial(state, page)} Build its visuals with Graphein, keep the app's navigation, theme and shared filters, apply this page's filters, and update \`MIGRATION.md\`.`
    )
  }
  const note = kindNote(page)
  if (note) lines.push('', note)
  if (last && count > 1) {
    lines.push(
      '',
      "This is the last page. Then wire the report's buttons, bookmarks and drillthroughs across pages, check the app against `MIGRATION.md`, and list what's approximated."
    )
  } else if (last) {
    lines.push(
      '',
      "This is the report's only page, so finish the migration in this turn: build the views its bookmarks show, wire its buttons, check the app against `MIGRATION.md`, and list what's approximated."
    )
  }
  const missing = gaps(state)
  if (missing.length) lines.push('', ...missing)

  const display = foundation
    ? `Migrate ${quote(report)} from Power BI`
    : `Migrate page ${position + 1} of ${count}: ${page.displayName}`
  return { pageIndex, display, prompt: lines.join('\n'), migration, shots }
}

/** The exact command that connects the app to the report's model. */
export function connectorCommand(state: MigrationState): string | null {
  const { modelId, modelWorkspaceId, workspaceId } = state.source
  if (!modelId) return null
  return `npx rayfin connector add --type fabric-semanticmodel --workspace-id ${modelWorkspaceId ?? workspaceId} --item-id ${modelId} --name ${state.alias}`
}
