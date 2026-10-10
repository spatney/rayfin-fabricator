import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Point } from './motion'

export type ParticleKind = 'bubble' | 'heart' | 'confetti' | 'zzz'

interface Particle {
  id: number
  kind: ParticleKind
  x: number
  y: number
  style: CSSProperties
}

/** The Fabricator mark's blues and greens, plus Ray's pale spot colour. */
const CONFETTI = ['#1183dd', '#15a4d3', '#41c795', '#1d92e2', '#7fd8ee', '#b8e8fb']
const MAX = 90

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

function vars(kind: ParticleKind, i: number): { style: CSSProperties; life: number } {
  switch (kind) {
    case 'bubble': {
      const size = rand(5, 11)
      const dur = rand(1.9, 3)
      const delay = i * 0.2
      return {
        life: (dur + delay) * 1000,
        style: {
          width: size,
          height: size,
          '--dx': `${rand(-14, 14)}px`,
          '--rise': `${rand(70, 140)}px`,
          '--dur': `${dur}s`,
          '--delay': `${delay}s`
        } as CSSProperties
      }
    }
    case 'heart': {
      const dur = rand(0.95, 1.35)
      const delay = i * 0.08
      return {
        life: (dur + delay) * 1000,
        style: {
          '--size': `${rand(11, 16)}px`,
          '--dx': `${rand(-28, 28)}px`,
          '--rise': `${rand(42, 74)}px`,
          '--rot': `${rand(-24, 24)}deg`,
          '--dur': `${dur}s`,
          '--delay': `${delay}s`
        } as CSSProperties
      }
    }
    case 'confetti': {
      const angle = rand(-160, -20) * (Math.PI / 180)
      const speed = rand(110, 300)
      const dur = rand(1.3, 2.1)
      // Little rounded tiles, like the ones the mark is built from.
      const size = rand(4.5, 8)
      return {
        life: dur * 1000,
        style: {
          width: size,
          height: size,
          borderRadius: `${size * 0.28}px`,
          background: CONFETTI[i % CONFETTI.length],
          '--dx': `${Math.cos(angle) * speed}px`,
          '--dy': `${Math.sin(angle) * speed}px`,
          '--fall': `${rand(150, 260)}px`,
          '--rot': `${rand(-900, 900)}deg`,
          '--dur': `${dur}s`,
          '--delay': '0s'
        } as CSSProperties
      }
    }
    case 'zzz': {
      const delay = i * 0.75
      return {
        life: (2.4 + delay) * 1000,
        style: {
          fontSize: `${11 + i * 2}px`,
          '--dx': `${rand(10, 22)}px`,
          '--rise': `${rand(32, 46)}px`,
          '--dur': '2.4s',
          '--delay': `${delay}s`
        } as CSSProperties
      }
    }
  }
}

/** Short-lived effects around Ray. Each burst cleans itself up. */
export function useParticles(): {
  particles: Particle[]
  burst: (kind: ParticleKind, count: number, at: Point) => void
} {
  const [particles, setParticles] = useState<Particle[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Set<number>())

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending) window.clearTimeout(t)
      pending.clear()
    }
  }, [])

  const burst = useCallback((kind: ParticleKind, count: number, at: Point): void => {
    const made: Particle[] = []
    let life = 0
    for (let i = 0; i < count; i++) {
      const v = vars(kind, i)
      life = Math.max(life, v.life)
      made.push({ id: nextId.current++, kind, x: at.x, y: at.y, style: v.style })
    }
    setParticles((prev) => [...prev, ...made].slice(-MAX))
    const ids = new Set(made.map((p) => p.id))
    const timer = window.setTimeout(() => {
      timers.current.delete(timer)
      setParticles((prev) => prev.filter((p) => !ids.has(p.id)))
    }, life + 250)
    timers.current.add(timer)
  }, [])

  return { particles, burst }
}

const HEART =
  'M12 21C5 15.5 1 11.8 1 7.5 1 4.4 3.4 2 6.4 2c2.1 0 4 1.2 5.6 3.2C13.6 3.2 15.5 2 17.6 2 20.6 2 23 4.4 23 7.5c0 4.3-4 8-11 13.5Z'

export function Particles({ particles }: { particles: Particle[] }): JSX.Element {
  return (
    <div className="mascot-fx" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className={`mascot-p mascot-p--${p.kind}`}
          style={{ left: p.x, top: p.y, ...p.style }}
        >
          {p.kind === 'heart' && (
            <svg viewBox="0 0 24 22">
              <path d={HEART} />
            </svg>
          )}
          {p.kind === 'zzz' && 'z'}
        </span>
      ))}
    </div>
  )
}
