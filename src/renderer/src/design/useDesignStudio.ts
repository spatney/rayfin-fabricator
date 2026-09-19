import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { StudioProject } from '@shared/ipc'
import { DesignSession, type DesignSessionView } from './session'

const EMPTY: DesignSessionView = {
  draft: null,
  snapshot: null,
  receipt: null,
  loading: false,
  ready: false,
  busy: false,
  progress: null,
  savedRevision: -1,
  error: null,
  saveError: null,
  sourceChanged: false,
  reviewing: false
}
const emptySnapshot = (): DesignSessionView => EMPTY
const emptySubscribe = (): (() => void) => () => {}

export function useDesignStudio(
  project: StudioProject | null,
  enabled: boolean,
  onError: (reason: unknown) => void
): { session: DesignSession | null; view: DesignSessionView } {
  const sessions = useRef(new Map<string, DesignSession>())
  const projectId = project?.id
  const session = useMemo(() => {
    if (!projectId) return null
    let item = sessions.current.get(projectId)
    if (!item && !enabled) return null
    if (!item) {
      item = new DesignSession(projectId, window.api.designStudio)
      sessions.current.set(projectId, item)
    }
    return item
  }, [projectId, enabled])
  const view = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  )
  const source = project?.lastDeploy?.url
    ? project.previewMode === 'fabric'
      ? 'fabric'
      : 'direct'
    : 'local'

  useEffect(() => {
    if (!enabled || !session) return
    void session.initialize(source).catch(onError)
  }, [enabled, session, source, onError])
  useEffect(() => {
    if (!enabled || !session) return
    return () => {
      void session.suspend().catch(onError)
    }
  }, [enabled, session, onError])
  useEffect(() => {
    if (!enabled || !session || view.busy || !['editing', 'deploying'].includes(view.receipt?.phase ?? '')) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        await session.refreshReceipt()
        if (!cancelled) timer = setTimeout(() => void poll(), 1000)
      } catch (reason) {
        if (!cancelled) session.reportError(reason)
      }
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [enabled, session, view.busy, view.receipt?.id, view.receipt?.phase])

  return { session, view }
}
