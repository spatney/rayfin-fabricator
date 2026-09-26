/**
 * The prompt behind "Try again". The Copilot session keeps its context and the
 * previous attempt's file changes stay, so the request is framed as a fresh
 * attempt rather than silently repeated.
 */
export function tryAgainPrompt(original: string): string {
  return `Let's try that again. Take a fresh approach to my previous request, improving on your last attempt:\n\n${original}`
}
