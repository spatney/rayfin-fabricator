import type { LocalSeedProblem } from '@shared/ipc'
import { translator } from '../../i18n'

function place(problem: LocalSeedProblem, row: (row: number) => string): string {
  return [
    problem.file,
    problem.row !== null ? row(problem.row) : null,
    problem.field ? `\`${problem.field}\`` : null
  ]
    .filter(Boolean)
    .join(', ')
}

/** Where a seed data problem is: its file, row and field. */
export function seedPlace(problem: LocalSeedProblem): string {
  const t = translator('preview')
  return place(problem, (row) => t('seed.row', { row }))
}

/** What to ask Copilot when loading the seed data was refused. */
export function seedFixPrompt(problems: LocalSeedProblem[]): string {
  const list = problems.map(
    (problem) => `- ${place(problem, (row) => `row ${row}`)}: ${problem.message}`
  )
  return [
    'The app’s seed data in rayfin/seed couldn’t be loaded into its local data, so nothing changed. Fix these problems in the seed files. Change the app’s entities only if the seed data is right and an entity is wrong:',
    '',
    ...list,
    '',
    'Then check the seed data again with fabricator_local_seed.'
  ].join('\n')
}
