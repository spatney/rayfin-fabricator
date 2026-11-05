import type { LocalSeedProblem } from '@shared/ipc'

/** Where a seed data problem is: its file, row and field. */
export function seedPlace(problem: LocalSeedProblem): string {
  return [
    problem.file,
    problem.row !== null ? `row ${problem.row}` : null,
    problem.field ? `\`${problem.field}\`` : null
  ]
    .filter(Boolean)
    .join(', ')
}

/** What to ask Copilot when loading the seed data was refused. */
export function seedFixPrompt(problems: LocalSeedProblem[]): string {
  const list = problems.map((problem) => `- ${seedPlace(problem)}: ${problem.message}`)
  return [
    'The app’s seed data in rayfin/seed couldn’t be loaded into its local data, so nothing changed. Fix these problems in the seed files. Change the app’s entities only if the seed data is right and an entity is wrong:',
    '',
    ...list,
    '',
    'Then check the seed data again with fabricator_local_seed.'
  ].join('\n')
}
