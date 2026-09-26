import type { ChatSegment } from '@shared/ipc'

/** Longest reasoning text kept per segment on disk (the live view is uncapped). */
export const REASONING_STORE_MAX = 6000

const KNOWN_SEGMENT_KINDS = new Set<string>([
  'text',
  'tool',
  'question',
  'interjection',
  'reasoning'
])

/** Drop segment kinds this build doesn't understand (the Rust DTO maps them to `unknown`). */
export function segmentsFromStorage(
  segments: ChatSegment[] | undefined
): ChatSegment[] | undefined {
  if (!segments?.some((s) => !KNOWN_SEGMENT_KINDS.has(s.kind))) return segments
  return segments.filter((s) => KNOWN_SEGMENT_KINDS.has(s.kind))
}

/** Shrink segments for persistence: long reasoning is capped so transcripts stay small. */
export function segmentsForStorage(segments: ChatSegment[] | undefined): ChatSegment[] | undefined {
  if (!segments?.some((s) => s.kind === 'reasoning' && s.text.length > REASONING_STORE_MAX)) {
    return segments
  }
  return segments.map((s) =>
    s.kind === 'reasoning' && s.text.length > REASONING_STORE_MAX
      ? { ...s, text: `${s.text.slice(0, REASONING_STORE_MAX).trimEnd()}…` }
      : s
  )
}
