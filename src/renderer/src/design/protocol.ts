import type {
  DesignApplyReceipt,
  DesignDraft,
  DesignSnapshot,
  DesignSource,
  DesignTransaction
} from '@shared/design'

export function newDesignDraft(
  projectId: string,
  source: DesignSource,
  sourceRevision: string
): DesignDraft {
  return {
    schemaVersion: 1,
    projectId,
    sessionId: crypto.randomUUID(),
    revision: 0,
    source,
    route: '/',
    sourceRevision,
    history: [],
    cursor: 0
  }
}

export function activeDesignChanges(
  draft: Pick<DesignDraft, 'history' | 'cursor'>
): DesignTransaction[] {
  return draft.history.slice(0, draft.cursor)
}

export function designAssetIds(history: DesignTransaction[]): string[] {
  const ids = new Set<string>()
  for (const transaction of history) {
    for (const edit of transaction.edits) {
      if (edit.kind !== 'image') continue
      for (const value of [edit.before, edit.after]) {
        if (!record(value)) continue
        for (const reference of [value, value.value]) {
          if (record(reference) && typeof reference.assetId === 'string') {
            ids.add(reference.assetId)
          }
        }
      }
    }
  }
  return [...ids]
}

export function hasAppliedSource(receipt: DesignApplyReceipt | null): boolean {
  return Boolean(
    receipt &&
    (receipt.filesModified.length > 0 ||
      (receipt.sourceRevisionAfter &&
        receipt.sourceRevisionAfter !== receipt.sourceRevisionBefore) ||
      [
        'editing',
        'source-updated',
        'deploying',
        'deployed',
        'needs-review',
        'interrupted'
      ].includes(receipt.phase))
  )
}

export function canRetryDesignDeployment(receipt: DesignApplyReceipt | null): boolean {
  return Boolean(receipt?.sourceRevisionAfter && receipt.phase === 'source-updated')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function target(value: unknown): boolean {
  return record(value) && ['id', 'selector', 'tag', 'label'].every((key) => typeof value[key] === 'string')
}

function stringMap(value: unknown): boolean {
  return record(value) && Object.values(value).every((item) => typeof item === 'string')
}

function selection(value: unknown): boolean {
  return record(value) && target(value) && stringMap(value.styles) && stringMap(value.inlineStyles) &&
    typeof value.textEditable === 'boolean' && typeof value.ownText === 'string' &&
    finite(value.width) && finite(value.height) &&
    typeof value.canContain === 'boolean' && typeof value.canReorder === 'boolean' &&
    Array.isArray(value.children) && value.children.every(target) &&
    (value.parent === undefined || target(value.parent)) &&
    (value.image === undefined || record(value.image) && typeof value.image.src === 'string' && typeof value.image.alt === 'string') &&
    (value.chart === undefined || record(value.chart) && record(value.chart.spec) && Array.isArray(value.chart.types) &&
      value.chart.types.every((type: unknown) => record(type) && typeof type.value === 'string' && typeof type.label === 'string' && typeof type.enabled === 'boolean'))
}

function transaction(value: unknown): boolean {
  return record(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
    typeof value.route === 'string' && Array.isArray(value.edits) &&
    value.edits.every((edit: unknown) => record(edit) && target(edit.target) &&
      typeof edit.kind === 'string' &&
      ['style', 'text', 'remove', 'reorder', 'insert', 'image', 'theme', 'chart', 'comment', 'annotation'].includes(edit.kind) &&
      'before' in edit && 'after' in edit)
}

export function assertDesignSnapshot(snapshot: unknown, sessionId: string): asserts snapshot is DesignSnapshot {
  if (record(snapshot) && snapshot.protocol === 1 && snapshot.sessionId === sessionId &&
    typeof snapshot.error === 'string' && (!snapshot.enabled || !snapshot.documentId)) {
    throw new Error(snapshot.error)
  }
  if (
    !record(snapshot) ||
    snapshot.protocol !== 1 ||
    snapshot.sessionId !== sessionId ||
    typeof snapshot.documentId !== 'string' ||
    !snapshot.documentId ||
    typeof snapshot.enabled !== 'boolean' ||
    typeof snapshot.route !== 'string' ||
    typeof snapshot.compare !== 'boolean' ||
    typeof snapshot.tool !== 'string' ||
    !['select', 'interact', 'comment', 'draw'].includes(snapshot.tool) ||
    !finite(snapshot.revision) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Array.isArray(snapshot.selection) ||
    !snapshot.selection.every(selection) ||
    !Array.isArray(snapshot.history) ||
    !snapshot.history.every(transaction) ||
    !Array.isArray(snapshot.conflicts) ||
    !Array.isArray(snapshot.acknowledged) ||
    !Array.isArray(snapshot.tokens) ||
    !Array.isArray(snapshot.layers) ||
    !snapshot.layers.every(target) ||
    !Array.isArray(snapshot.breakpoints) ||
    !snapshot.acknowledged.every((id) => typeof id === 'string') ||
    !finite(snapshot.cursor) || !Number.isInteger(snapshot.cursor) ||
    snapshot.cursor < 0 ||
    snapshot.cursor > snapshot.history.length ||
    !record(snapshot.viewport) ||
    !finite(snapshot.viewport.width) ||
    !finite(snapshot.viewport.height)
  ) {
    throw new Error(
      'The design preview returned an invalid or outdated response. Reconnect the preview.'
    )
  }
}

export function designError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
