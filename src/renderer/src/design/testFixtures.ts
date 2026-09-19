import { vi } from 'vitest'
import type {
  DesignApplyReceipt,
  DesignCommand,
  DesignConnection,
  DesignDraft,
  DesignSelection,
  DesignSnapshot,
  DesignStudioApi,
  DesignTransaction
} from '@shared/design'

export function designSelection(): DesignSelection {
  return {
    id: 'heading',
    selector: '#heading',
    tag: 'h1',
    label: 'Heading',
    text: 'Hello',
    styles: { color: 'rgb(0, 0, 0)', width: '200px' },
    inlineStyles: {},
    textEditable: true,
    ownText: 'Hello',
    width: 200,
    height: 40,
    children: [],
    canContain: false,
    canReorder: true
  }
}

export function designTransaction(id = 'edit-1'): DesignTransaction {
  return {
    id,
    label: 'Text color',
    route: '/',
    edits: [
      { kind: 'style', target: designSelection(), property: 'color', before: '', after: '#ff0000' }
    ]
  }
}

export function designReceipt(over: Partial<DesignApplyReceipt> = {}): DesignApplyReceipt {
  return {
    id: 'apply-1',
    projectId: 'p1',
    draftRevision: 1,
    turnId: 'apply-1',
    phase: 'source-updated',
    sourceRevisionBefore: 'source-1',
    sourceRevisionAfter: 'source-2',
    filesModified: ['src/App.tsx'],
    ...over
  }
}

export function createDesignHarness(
  initialDraft: DesignDraft | null = null,
  initialReceipt: DesignApplyReceipt | null = null
) {
  let stored = initialDraft
  let receipt = initialReceipt
  let frame: DesignSnapshot | null = null
  let sourceRevision = 'source-1'
  let documentId = 'document-1'
  const copy = <T>(value: T): T => structuredClone(value)
  const api = {
    load: vi.fn(async () => copy(stored)),
    save: vi.fn(async (draft: DesignDraft) => {
      stored = copy(draft)
      return draft.revision
    }),
    clear: vi.fn(async () => {
      stored = null
      receipt = null
    }),
    sourceRevision: vi.fn(async () => sourceRevision),
    receipt: vi.fn(async () => copy(receipt)),
    assets: vi.fn(async () => []),
    importAsset: vi.fn(async () => null),
    assetPreview: vi.fn(async () => 'data:image/png;base64,AAAA'),
    connect: vi.fn(async (options: DesignConnection): Promise<DesignSnapshot> => {
      frame = {
        protocol: 1,
        sessionId: options.sessionId,
        documentId,
        revision: options.revision,
        enabled: true,
        route: '/',
        tool: 'select',
        compare: false,
        selection: [designSelection()],
        layers: [designSelection()],
        tokens: [],
        breakpoints: [],
        viewport: { width: 1000, height: 700 },
        history: copy(options.history),
        cursor: options.cursor,
        conflicts: [],
        acknowledged: []
      }
      return copy(frame)
    }),
    poll: vi.fn(
      async (sessionId: string): Promise<DesignSnapshot | null> =>
        frame?.sessionId === sessionId ? copy(frame) : null
    ),
    disconnect: vi.fn(async (sessionId: string) => {
      if (frame?.sessionId === sessionId) frame = null
    }),
    command: vi.fn(async (command: DesignCommand): Promise<DesignSnapshot> => {
      if (!frame) throw new Error('No frame')
      if (command.type === 'style' && command.phase !== 'preview' && command.phase !== 'cancel') {
        frame.history = [
          ...frame.history.slice(0, frame.cursor),
          designTransaction(command.commandId)
        ]
        frame.cursor = frame.history.length
        frame.revision++
      } else if (command.type === 'undo') {
        frame.cursor = Math.max(0, frame.cursor - 1)
        frame.revision++
      } else if (command.type === 'redo') {
        frame.cursor = Math.min(frame.history.length, frame.cursor + 1)
        frame.revision++
      } else if (command.type === 'tool') frame.tool = command.tool
      else if (command.type === 'compare') frame.compare = command.enabled
      else if (command.type === 'verify') {
        frame.verification = command.history.slice(0, command.cursor).map((transaction) => ({
          transactionId: transaction.id,
          ok: true
        }))
      }
      frame.acknowledged.push(command.commandId)
      return copy(frame)
    }),
    apply: vi.fn(
      async (
        projectId: string,
        applyId: string,
        revision: number,
        _screenshotPath?: string
      ): Promise<DesignApplyReceipt> => {
        receipt = designReceipt({
          id: applyId,
          projectId,
          turnId: applyId,
          draftRevision: revision
        })
        sourceRevision = 'source-2'
        return copy(receipt)
      }
    ),
    finish: vi.fn(
      async (
        _projectId: string,
        _applyId: string,
        verified: boolean
      ): Promise<DesignApplyReceipt> => {
        if (!receipt) throw new Error('No Apply receipt')
        receipt = { ...receipt, phase: verified ? 'deployed' : 'needs-review' }
        return copy(receipt)
      }
    )
  } satisfies DesignStudioApi
  return {
    api,
    stored: () => copy(stored),
    frame: () => copy(frame),
    setFrame: (value: DesignSnapshot | null) => {
      frame = copy(value)
    },
    setSource: (value: string) => {
      sourceRevision = value
    },
    setDocument: (value: string) => {
      documentId = value
    },
    setReceipt: (value: DesignApplyReceipt | null) => {
      receipt = copy(value)
    }
  }
}
