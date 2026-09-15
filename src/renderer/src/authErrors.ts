/** Tauri can reject with a string rather than an Error. Keep either reason visible. */
export function authErrorMessage(reason: unknown, fallback: string): string {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return message.trim() || fallback
}
