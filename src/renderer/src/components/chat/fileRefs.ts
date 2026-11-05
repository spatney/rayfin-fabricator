import type { ChatFileRef } from '@shared/ipc'
import { pathReference } from './mentions'

/** Files and folders added for each project's next message. Kept here so the chips
 *  survive the chat panel unmounting (switching tabs), like the draft. */
const pending = new Map<string, ChatFileRef[]>()

export function pendingFiles(projectId: string): ChatFileRef[] {
  return pending.get(projectId) ?? []
}

export function setPendingFiles(projectId: string, files: readonly ChatFileRef[]): void {
  if (files.length > 0) pending.set(projectId, [...files])
  else pending.delete(projectId)
}

/** `files` followed by the ones in `added` it doesn't have yet. */
export function withFiles(
  files: readonly ChatFileRef[],
  added: readonly ChatFileRef[]
): ChatFileRef[] {
  const out = [...files]
  for (const file of added) {
    if (!out.some((f) => f.path === file.path)) out.push(file)
  }
  return out
}

/** A file's or folder's own name: the last part of its path. */
export function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/**
 * What Copilot receives for a message sent with files and folders: the message
 * (or, with none, a request to look at them), then an `@` reference to each,
 * which Copilot reads. Only the chips show in the chat, not the references.
 */
export function filesTurnPrompt(
  text: string,
  files: readonly ChatFileRef[],
  projectRoot: string
): string {
  if (files.length === 0) return text
  const ask = text.trim() || `Take a look at ${files.length === 1 ? 'this' : 'these'}.`
  return `${ask}\n\n${files.map((f) => pathReference(f.path, projectRoot, f.dir)).join(' ')}`
}
