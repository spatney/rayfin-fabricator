import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { MascotContext, useMascot } from './context'
import { MascotRoamer, type VisitPhase } from './Roamer'
import type { Occasion } from './lines'

export type InstallStatus = 'idle' | 'running' | 'success' | 'error'

interface Session {
  occasion: Occasion
  status: InstallStatus
  /** Ran long enough for Ray to show up. Quick checks never summon him. */
  engaged: boolean
  timer: number
  bounds?: RefObject<HTMLElement | null>
}

interface Visit {
  id: number
  occasion: Occasion
  phase: VisitPhase
  phaseKey: number
}

interface StageApi {
  report: (
    id: string,
    occasion: Occasion,
    status: InstallStatus,
    bounds?: RefObject<HTMLElement | null>
  ) => void
  drop: (id: string) => void
}

const StageContext = createContext<StageApi | null>(null)

/** How long an install runs before Ray swims in. */
const DELAY: Record<Occasion, number> = { create: 700, clone: 700, prepare: 1600 }

/** Sent away: he stays away until Fabricator restarts. */
let dismissed = false

/** For tests: bring him back after he was sent away. */
export function resetMascotForTests(): void {
  dismissed = false
}

/**
 * The one Ray in the app. Screens report their installs through
 * {@link useMascotInstall}; the stage decides when he swims in, celebrates,
 * frets, or leaves. Living above the screens lets him stay on through a hand-off,
 * such as a clone finishing and the opened project checking its packages.
 */
function MascotStage({ children }: { children: ReactNode }): JSX.Element {
  const enabled = useMascot()
  const sessions = useRef(new Map<string, Session>()).current
  const [visit, setVisit] = useState<Visit | null>(null)
  const visitRef = useRef(visit)
  visitRef.current = visit
  const boundsRef = useRef<RefObject<HTMLElement | null> | undefined>(undefined)

  const running = useCallback(
    (): Session | undefined =>
      [...sessions.values()].find((s) => s.engaged && s.status === 'running'),
    [sessions]
  )

  const toPhase = useCallback((phase: VisitPhase, occasion?: Occasion): void => {
    setVisit((v) =>
      v ? { ...v, phase, phaseKey: v.phaseKey + 1, occasion: occasion ?? v.occasion } : v
    )
  }, [])

  /** Leave once nothing he was keeping company is still going. */
  const settle = useCallback((): void => {
    if (running()) return
    setVisit((v) =>
      v && (v.phase === 'running' || v.phase === 'error')
        ? { ...v, phase: 'leaving', phaseKey: v.phaseKey + 1 }
        : v
    )
  }, [running])

  const engage = useCallback(
    (id: string): void => {
      const session = sessions.get(id)
      if (!session || session.status !== 'running' || dismissed) return
      session.engaged = true
      if (session.bounds) boundsRef.current = session.bounds
      setVisit((v) =>
        !v
          ? { id: Date.now(), occasion: session.occasion, phase: 'running', phaseKey: 0 }
          : v.phase === 'running'
            ? v
            : { ...v, occasion: session.occasion, phase: 'running', phaseKey: v.phaseKey + 1 }
      )
    },
    [sessions]
  )

  const api = useMemo<StageApi>(
    () => ({
      report(id, occasion, status, bounds) {
        let session = sessions.get(id)
        if (!session) {
          session = { occasion, status: 'idle', engaged: false, timer: 0 }
          sessions.set(id, session)
        }
        const prev = session.status
        session.occasion = occasion
        session.bounds = bounds ?? session.bounds
        session.status = status
        if (prev === status) return
        window.clearTimeout(session.timer)

        if (status === 'running') {
          // A retry while he's still here picks straight back up.
          if (session.engaged && visitRef.current) engage(id)
          else {
            session.engaged = false
            session.timer = window.setTimeout(() => engage(id), DELAY[occasion])
          }
          return
        }
        if (!session.engaged) return
        if (status === 'success') {
          if (!running()) toPhase('success', occasion)
        } else if (status === 'error') {
          toPhase('error', occasion)
        } else {
          session.engaged = false
          settle()
        }
      },
      drop(id) {
        const session = sessions.get(id)
        if (!session) return
        window.clearTimeout(session.timer)
        sessions.delete(id)
        if (session.engaged && session.status !== 'success') settle()
      }
    }),
    [engage, running, sessions, settle, toPhase]
  )

  // Turned off in Settings: he leaves at once, mid-sentence or not.
  useEffect(() => {
    if (!enabled) setVisit(null)
  }, [enabled])

  const getBounds = useCallback(
    (): DOMRect | null => boundsRef.current?.current?.getBoundingClientRect() ?? null,
    []
  )

  const onGone = useCallback((): void => {
    const next = running()
    setVisit(
      next && !dismissed
        ? { id: Date.now(), occasion: next.occasion, phase: 'running', phaseKey: 0 }
        : null
    )
  }, [running])

  const onDismiss = useCallback((): void => {
    dismissed = true
    toPhase('bye')
  }, [toPhase])

  return (
    <StageContext.Provider value={api}>
      {children}
      {enabled && visit && (
        <MascotRoamer
          key={visit.id}
          occasion={visit.occasion}
          phase={visit.phase}
          phaseKey={visit.phaseKey}
          getBounds={getBounds}
          onGone={onGone}
          onDismiss={onDismiss}
        />
      )}
    </StageContext.Provider>
  )
}

/**
 * Whether Ray may appear (Settings → Appearance → Ray), and the stage he
 * appears on. Wrap the app in this once.
 */
export function MascotProvider({
  enabled,
  children
}: {
  enabled: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <MascotContext.Provider value={enabled}>
      <MascotStage>{children}</MascotStage>
    </MascotContext.Provider>
  )
}

/**
 * Report an install so Ray can keep the user company. He swims in once it has
 * run for a moment, celebrates a success, frets over a failure, and leaves when
 * the screen goes away. Without a {@link MascotProvider} this does nothing.
 *
 * `bounds` is the area he should swim in; mark content he must not cover with
 * `data-mascot-avoid`. Call `succeed()` when a success unmounts the screen in the
 * same moment, before a status update could be seen.
 */
export function useMascotInstall(
  occasion: Occasion,
  status: InstallStatus,
  bounds?: RefObject<HTMLElement | null>
): { succeed: () => void } {
  const api = useContext(StageContext)
  const id = useId()
  useEffect(() => {
    api?.report(id, occasion, status, bounds)
  }, [api, id, occasion, status, bounds])
  useEffect(() => () => api?.drop(id), [api, id])
  return useMemo(
    () => ({ succeed: () => api?.report(id, occasion, 'success', bounds) }),
    [api, id, occasion, bounds]
  )
}
