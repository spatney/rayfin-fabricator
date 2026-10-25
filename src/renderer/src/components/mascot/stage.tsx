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
  type RefObject,
  type JSX,
} from 'react'
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
  /** A screen showing Ray itself opened (`true`) or closed. */
  hold: (id: string, held: boolean) => void
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

/** Sent away from his own button, he said he'd only be in Help from now on. */
export function isRaySentAway(): boolean {
  return dismissed
}

/**
 * The one Ray in the app. Screens report their installs through
 * {@link useMascotInstall}; the stage decides when he swims in, celebrates,
 * frets, or leaves. Living above the screens lets him stay on through a hand-off,
 * such as a clone finishing and the opened project checking its packages.
 * While a screen shows him itself ({@link useRayOnScreen}), he stays off the stage.
 */
function MascotStage({ children }: { children: ReactNode }): JSX.Element {
  const sessions = useRef(new Map<string, Session>()).current
  const holds = useRef(new Set<string>()).current
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
      // Another screen is showing him: he joins this install once it closes.
      if (holds.size) return
      setVisit((v) =>
        !v
          ? { id: Date.now(), occasion: session.occasion, phase: 'running', phaseKey: 0 }
          : v.phase === 'running'
            ? v
            : { ...v, occasion: session.occasion, phase: 'running', phaseKey: v.phaseKey + 1 }
      )
    },
    [sessions, holds]
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
      },
      hold(id, held) {
        if (held) {
          holds.add(id)
          // He's on that screen now, so the roaming one swims off.
          setVisit((v) =>
            v && v.phase !== 'leaving' && v.phase !== 'bye'
              ? { ...v, phase: 'leaving', phaseKey: v.phaseKey + 1 }
              : v
          )
          return
        }
        holds.delete(id)
        const next = running()
        if (holds.size || dismissed || !next) return
        setVisit((v) => v ?? { id: Date.now(), occasion: next.occasion, phase: 'running', phaseKey: 0 })
      }
    }),
    [engage, holds, running, sessions, settle, toPhase]
  )

  const getBounds = useCallback(
    (): DOMRect | null => boundsRef.current?.current?.getBoundingClientRect() ?? null,
    []
  )

  const onGone = useCallback((): void => {
    const next = running()
    setVisit(
      next && !dismissed && holds.size === 0
        ? { id: Date.now(), occasion: next.occasion, phase: 'running', phaseKey: 0 }
        : null
    )
  }, [holds, running])

  const onDismiss = useCallback((): void => {
    dismissed = true
    toPhase('bye')
  }, [toPhase])

  return (
    <StageContext.Provider value={api}>
      {children}
      {visit && (
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

/** The stage Ray appears on. Wrap the app in this once. */
export function MascotProvider({ children }: { children: ReactNode }): JSX.Element {
  return <MascotStage>{children}</MascotStage>
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

/**
 * For a screen that shows Ray itself, such as the deploy screen. While it's
 * open, the roaming Ray swims off and stays away, so there's only ever one of
 * him; he comes back for an install still running once it closes.
 */
export function useRayOnScreen(active: boolean): void {
  const api = useContext(StageContext)
  const id = useId()
  useEffect(() => {
    if (!api || !active) return
    api.hold(id, true)
    return () => api.hold(id, false)
  }, [api, id, active])
}
