import type {
  DesignApplyReceipt,
  DesignCommandBody,
  DesignDraft,
  DesignSnapshot,
  DesignSource,
  DesignStudioApi
} from '@shared/design'
import type { DesignPreviewTarget } from '../components/PreviewPane'
import {
  assertDesignSnapshot,
  designAssetIds,
  designError,
  hasAppliedSource,
  newDesignDraft
} from './protocol'

export interface DesignSessionView {
  draft: DesignDraft | null
  snapshot: DesignSnapshot | null
  receipt: DesignApplyReceipt | null
  loading: boolean
  ready: boolean
  busy: boolean
  progress: string | null
  savedRevision: number
  error: string | null
  saveError: string | null
  sourceChanged: boolean
  reviewing: boolean
}

export class DesignSession {
  private view: DesignSessionView = {
    draft: null,
    snapshot: null,
    receipt: null,
    loading: true,
    ready: false,
    busy: false,
    progress: null,
    savedRevision: -1,
    error: null,
    saveError: null,
    sourceChanged: false,
    reviewing: false
  }
  private listeners = new Set<() => void>()
  private initialized: Promise<void> | null = null
  private commandTail: Promise<void> = Promise.resolve()
  private saveTail: Promise<void> = Promise.resolve()
  private lastSave: Promise<void> = Promise.resolve()
  private connectionTail: Promise<void> = Promise.resolve()
  private pauseTail: Promise<void> = Promise.resolve()
  private target: DesignPreviewTarget | null = null
  private connectionId = ''
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private frozen = false
  private journalKey = ''
  private preferredSource: DesignSource = 'direct'

  constructor(
    readonly projectId: string,
    private api: DesignStudioApi
  ) {}

  getSnapshot = (): DesignSessionView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<DesignSessionView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }

  reportError = (reason: unknown): void => {
    this.update({ error: designError(reason) })
  }

  initialize(source: DesignSource): Promise<void> {
    if (this.initialized) return this.initialized
    this.preferredSource = source
    this.initialized = (async () => {
      const [saved, sourceRevision, receipt] = await Promise.all([
        this.api.load(this.projectId),
        this.api.sourceRevision(this.projectId),
        this.api.receipt(this.projectId)
      ])
      if (saved && (saved.schemaVersion !== 1 || saved.projectId !== this.projectId)) {
        throw new Error(
          'This design draft belongs to a different project or an unsupported version.'
        )
      }
      const draft = saved ?? newDesignDraft(this.projectId, source, sourceRevision)
      this.journalKey = JSON.stringify([draft.history, draft.cursor])
      this.frozen =
        hasAppliedSource(receipt) && draft.cursor > 0 && receipt?.id !== draft.receipt?.id
      this.update({
        draft,
        receipt,
        loading: false,
        savedRevision: saved ? saved.revision : -1,
        reviewing: this.frozen,
        sourceChanged: draft.cursor > 0 && draft.sourceRevision !== sourceRevision && !this.frozen
      })
      if (!saved) await this.persist(draft)
      if (this.target) await this.reconnect()
    })().catch((reason: unknown) => {
      this.initialized = null
      this.update({ loading: false, error: designError(reason) })
      throw reason
    })
    return this.initialized
  }

  private persist(draft: DesignDraft): Promise<void> {
    const result = this.saveTail.then(async () => {
      const revision = await this.api.save(draft)
      if (revision !== draft.revision)
        throw new Error('The design draft was not acknowledged at the expected revision.')
      this.update({ savedRevision: Math.max(this.view.savedRevision, revision), saveError: null })
    })
    this.lastSave = result
    this.saveTail = result.catch((reason: unknown) => {
      this.update({ saveError: `Draft not saved: ${designError(reason)}` })
    })
    return result
  }

  private accept(snapshot: DesignSnapshot, active = true): void {
    assertDesignSnapshot(snapshot, this.connectionId)
    const previous = this.view.snapshot
    if (previous?.documentId === snapshot.documentId && snapshot.revision < previous.revision)
      return
    this.update({ snapshot, ready: active && snapshot.enabled && Boolean(this.target) })
    if (snapshot.error) this.reportError(snapshot.error)
    const draft = this.view.draft
    if (!draft || this.frozen) return
    const key = JSON.stringify([snapshot.history, snapshot.cursor])
    if (key === this.journalKey && draft.route === snapshot.route) return
    this.journalKey = key
    const next: DesignDraft = {
      ...draft,
      revision: Math.max(draft.revision + 1, snapshot.revision),
      history: snapshot.history,
      cursor: snapshot.cursor,
      route: snapshot.route
    }
    this.update({ draft: next })
    void this.persist(next).catch(this.reportError)
  }

  setTarget = (target: DesignPreviewTarget | null): void => {
    const previous = this.target
    this.target = target
    if (!target) {
      this.generation++
      this.stopPolling()
      this.update({ ready: false })
      const id = this.connectionId
      const documentId = this.view.snapshot?.documentId
      if (id && documentId && !this.frozen) {
        this.pauseTail = this.commandTail
          .then(async () => {
            const snapshot = await this.api.poll(id)
            if (this.connectionId === id && snapshot?.documentId === documentId) {
              this.accept(snapshot, false)
              await this.lastSave
            }
          })
          .catch(this.reportError)
      }
      return
    }
    if (previous?.url === target.url && previous.appUrl === target.appUrl && this.view.ready) return
    void this.reconnect().catch(this.reportError)
  }

  async reconnect(): Promise<void> {
    const generation = ++this.generation
    this.stopPolling()
    this.update({ ready: false, error: null })
    const connect = this.connectionTail.then(async () => {
      const target = this.target
      if (!target || !this.view.draft || generation !== this.generation) return
      await this.commandTail
      await this.pauseTail
      const draft = this.view.draft
      if (!draft || generation !== this.generation) return
      if (this.connectionId) await this.api.disconnect(this.connectionId)
      if (generation !== this.generation) return
      const connectionId = crypto.randomUUID()
      this.connectionId = connectionId
      const history = this.frozen ? [] : draft.history
      const previews = await Promise.all(
        designAssetIds(history).map(
          async (id) => [id, await this.api.assetPreview(this.projectId, id)] as const
        )
      )
      if (generation !== this.generation) return
      const snapshot = await this.api.connect({
        sessionId: connectionId,
        embedded: target.embedded,
        appUrl: target.appUrl,
        history,
        cursor: this.frozen ? 0 : draft.cursor,
        revision: draft.revision,
        route: history.length ? draft.route : undefined,
        assetPreviews: Object.fromEntries(previews)
      })
      if (generation !== this.generation) return
      this.accept(snapshot)
      if (this.frozen) await this.command({ type: 'tool', tool: 'interact' }, true)
      this.schedulePoll(generation)
    })
    this.connectionTail = connect.catch((reason: unknown) => {
      if (generation === this.generation) this.reportError(reason)
    })
    return connect
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedulePoll(generation: number): void {
    this.stopPolling()
    if (!this.target || generation !== this.generation) return
    this.timer = setTimeout(() => {
      this.timer = null
      void (async () => {
        const snapshot = await this.api.poll(this.connectionId)
        if (generation !== this.generation || !this.target) return
        if (
          !snapshot ||
          !snapshot.enabled ||
          this.view.snapshot?.documentId !== snapshot.documentId
        ) {
          this.update({ ready: false })
          await this.reconnect()
          return
        }
        this.accept(snapshot)
        this.schedulePoll(generation)
      })().catch((reason: unknown) => {
        if (generation === this.generation) {
          this.update({ ready: false })
          this.reportError(reason)
        }
      })
    }, 300)
  }

  command(body: DesignCommandBody, internal = false): Promise<DesignSnapshot> {
    const permitted = !this.view.busy || internal
    const result = this.commandTail.then(async () => {
      const snapshot = this.view.snapshot
      if (!snapshot || !this.target || !this.view.ready)
        throw new Error('Wait for the design preview to be ready.')
      if (!permitted) throw new Error('Editing is paused while changes are being applied.')
      const sessionId = this.connectionId
      const commandId = crypto.randomUUID()
      const response = await this.api.command({
        ...body,
        sessionId,
        documentId: snapshot.documentId,
        commandId
      })
      assertDesignSnapshot(response, sessionId)
      if (sessionId !== this.connectionId)
        throw new Error('The preview changed before this edit was acknowledged.')
      if (
        response.documentId !== snapshot.documentId ||
        !response.acknowledged.includes(commandId)
      ) {
        throw new Error(
          'The preview did not acknowledge this edit in the current document. Reconnect before retrying.'
        )
      }
      this.accept(response)
      if (response.error) throw new Error(response.error)
      if (!internal) this.update({ error: null })
      return response
    })
    this.commandTail = result.then(
      () => undefined,
      (reason: unknown) => {
        this.reportError(reason)
      }
    )
    return result
  }

  async flush(): Promise<void> {
    await this.commandTail
    await this.pauseTail
    if (this.target && this.connectionId && this.view.ready) {
      const snapshot = await this.api.poll(this.connectionId)
      if (snapshot) this.accept(snapshot)
    }
    await this.lastSave
    if (this.view.saveError) throw new Error(this.view.saveError)
  }

  async retrySave(): Promise<void> {
    const draft = this.view.draft
    if (draft) await this.persist(draft)
  }

  async suspend(): Promise<void> {
    await this.flush()
    this.generation++
    this.stopPolling()
    this.target = null
    this.update({ ready: false })
    const id = this.connectionId
    await this.connectionTail
    if (id) await this.api.disconnect(id)
    if (this.connectionId === id) this.connectionId = ''
  }

  async setSource(source: DesignSource): Promise<void> {
    if (!this.view.draft || this.view.draft.source === source) return
    if (this.view.busy) throw new Error('Wait for Apply to finish before changing preview sources.')
    await this.suspend()
    const draft = this.view.draft
    if (!draft) throw new Error('The design draft is no longer available.')
    const next = { ...draft, source, revision: draft.revision + 1 }
    this.update({ draft: next })
    await this.persist(next)
  }

  async setViewportWidth(width: number | undefined): Promise<void> {
    if (width !== undefined && (!Number.isInteger(width) || width < 240 || width > 3840)) {
      throw new Error('Choose a viewport width between 240 and 3840 CSS pixels.')
    }
    const draft = this.view.draft
    if (!draft) return
    const next = { ...draft, viewportWidth: width, revision: draft.revision + 1 }
    this.update({ draft: next })
    await this.persist(next)
  }

  async reviewCurrentSource(): Promise<void> {
    await this.flush()
    const draft = this.view.draft
    if (!draft || this.view.snapshot?.conflicts.length) {
      throw new Error('Resolve the draft targets before accepting the current source.')
    }
    const sourceRevision = await this.api.sourceRevision(this.projectId)
    const next = { ...draft, sourceRevision, revision: draft.revision + 1 }
    this.update({ draft: next, sourceChanged: false, error: null })
    await this.persist(next)
  }

  async prepareApply(): Promise<DesignDraft> {
    if (this.view.busy) throw new Error('An Apply is already running.')
    this.update({ busy: true, progress: 'Preparing your changes', error: null })
    try {
      if (this.frozen)
        throw new Error('Review or finish the previous Apply before starting another.')
      await this.command({ type: 'compare', enabled: false }, true)
      await this.command({ type: 'tool', tool: 'interact' }, true)
      await this.flush()
      const draft = this.view.draft
      if (!draft || draft.cursor === 0) throw new Error('Make a visual change before applying.')
      if (this.view.snapshot?.conflicts.length)
        throw new Error('Resolve the highlighted draft targets before applying.')
      const revision = await this.api.sourceRevision(this.projectId)
      if (revision !== draft.sourceRevision) {
        this.update({ sourceChanged: true })
        throw new Error(
          'The app source changed since this draft started. Review the current source before applying.'
        )
      }
      this.frozen = true
      return draft
    } catch (reason) {
      this.finishBusy()
      if (!this.frozen && this.view.ready) {
        await this.command({ type: 'tool', tool: 'select' }, true)
      }
      throw reason
    }
  }

  setProgress(progress: string): void {
    this.update({ progress })
  }

  setReceipt(receipt: DesignApplyReceipt): void {
    const reviewing =
      hasAppliedSource(receipt) &&
      Boolean(this.view.draft?.cursor) &&
      receipt.id !== this.view.draft?.receipt?.id
    this.frozen = this.view.busy || reviewing
    this.update({ receipt, reviewing })
  }

  finishBusy(): void {
    this.update({ busy: false, progress: null })
  }

  startDeploymentRetry(): void {
    if (this.view.busy) throw new Error('An Apply is already running.')
    this.frozen = true
    this.update({ busy: true, progress: 'Deploying your changes', error: null })
  }

  async refreshReceipt(): Promise<DesignApplyReceipt | null> {
    const receipt = await this.api.receipt(this.projectId)
    if (receipt) this.setReceipt(receipt)
    return receipt
  }

  async resumeUnappliedDraft(): Promise<void> {
    if (!this.view.draft?.cursor) return
    if (
      hasAppliedSource(this.view.receipt) &&
      this.view.receipt?.id !== this.view.draft?.receipt?.id
    )
      return
    this.frozen = false
    const error = this.view.error
    this.update({ reviewing: false })
    if (this.target) await this.reconnect()
    if (error) this.update({ error })
  }

  waitForFreshDocument(previousDocumentId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let stop: () => void = () => {}
      const timeout = setTimeout(() => {
        stop()
        reject(
          new Error(
            'The app was deployed, but its refreshed preview is not ready. Open this project in Design and verify the result.'
          )
        )
      }, 15000)
      const check = (): void => {
        if (this.view.ready && this.view.snapshot?.documentId !== previousDocumentId) {
          clearTimeout(timeout)
          stop()
          resolve()
        }
      }
      stop = this.subscribe(check)
      check()
    })
  }

  private async acceptApplied(completed: DesignApplyReceipt): Promise<void> {
    const draft = this.view.draft
    if (!draft) return
    const sourceRevision = await this.api.sourceRevision(this.projectId)
    const next: DesignDraft = {
      ...draft,
      history: [],
      cursor: 0,
      receipt: completed,
      sourceRevision,
      revision: Math.max(draft.revision, this.view.snapshot?.revision ?? 0) + 1
    }
    this.journalKey = JSON.stringify([[], 0])
    this.update({ draft: next, sourceChanged: false, error: null, reviewing: false })
    await this.persist(next)
    this.frozen = false
    await this.reconnect()
  }

  async verifyApplied(): Promise<boolean> {
    const { draft, receipt } = this.view
    if (!draft || !receipt || !this.target) return false
    this.frozen = true
    await this.reconnect()
    const active = draft.history.slice(0, draft.cursor)
    const canSettle = active.every((transaction) =>
      transaction.edits.every(
        (edit) =>
          edit.kind !== 'comment' &&
          edit.kind !== 'annotation' &&
          !(edit.kind === 'image' && edit.property === 'asset')
      )
    )
    const deadline = Date.now() + 10_000
    let verified = false
    do {
      const snapshot = await this.command(
        { type: 'verify', history: draft.history, cursor: draft.cursor },
        true
      )
      const results = snapshot.verification ?? []
      verified =
        active.length > 0 &&
        active.every((transaction) =>
          results.some((result) => result.transactionId === transaction.id && result.ok)
        )
      if (verified || !canSettle || Date.now() >= deadline) break
      // Page load can finish before auth/data-driven components mount.
      await new Promise((resolve) => setTimeout(resolve, 500))
    } while (this.target && this.view.ready)
    const completed = await this.api.finish(this.projectId, receipt.id, verified)
    this.setReceipt(completed)
    if (!verified) return false
    await this.acceptApplied(completed)
    return true
  }

  async confirmReviewedResult(): Promise<void> {
    const receipt = this.view.receipt
    if (!receipt?.deployment?.ok || this.view.busy) {
      throw new Error('Only a completed deployment can be accepted after review.')
    }
    const completed = await this.api.finish(this.projectId, receipt.id, true)
    this.setReceipt(completed)
    await this.acceptApplied(completed)
  }

  async startFreshDraft(): Promise<void> {
    if (this.view.busy) throw new Error('Wait for Apply to finish before starting a new draft.')
    const target = this.target
    const source = this.view.draft?.source ?? this.preferredSource
    await this.suspend()
    await this.api.clear(this.projectId)
    const draft = newDesignDraft(
      this.projectId,
      source,
      await this.api.sourceRevision(this.projectId)
    )
    this.frozen = false
    this.journalKey = JSON.stringify([[], 0])
    this.update({
      draft,
      receipt: null,
      snapshot: null,
      error: null,
      saveError: null,
      sourceChanged: false,
      reviewing: false,
      savedRevision: -1
    })
    await this.persist(draft)
    this.setTarget(target)
  }
}
