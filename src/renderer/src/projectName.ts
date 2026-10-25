/**
 * Project names follow the Rayfin CLI's rule (`isValidProjectName`), which
 * rejects anything else when the project is created: letters, numbers, spaces,
 * hyphens and underscores, with at least one letter or number.
 */
const ALLOWED = /^[A-Za-z0-9\s_-]+$/

/** Why `name` can't name a project, or null when it can (or is still blank). */
export function projectNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (!ALLOWED.test(trimmed)) return 'Use only letters, numbers, spaces, hyphens and underscores.'
  if (!/[A-Za-z0-9]/.test(trimmed)) return 'Include at least one letter or number.'
  return null
}

/** A valid project name from any text, such as a report's name: accents dropped, other characters made spaces. */
export function toProjectName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
