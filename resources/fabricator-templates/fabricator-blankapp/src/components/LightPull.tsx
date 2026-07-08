import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * A hanging light bulb with a real beaded pull-chain. The chain is simulated
 * with lightweight Verlet physics, so you can grab the knob, swing it, and give
 * it a tug — it settles naturally, and a firm pull (or a tap) toggles the theme
 * between dark ("lights off") and light ("lights on").
 */

const N = 10; // chain nodes (node 0 is pinned to the bulb)
const SEG = 5.5; // rest length between beads (SVG units)
const GRAVITY = 0.9;
const FRICTION = 0.99;
const ITER = 16; // constraint relaxation passes
const ANCHOR = { x: 22, y: 101 }; // where the chain meets the bulb cap
const REST_END_Y = ANCHOR.y + (N - 1) * SEG;
const MAX_REACH = (N - 1) * SEG * 1.7;
const PULL_TOGGLE = 22; // pull the knob this far below rest to switch
const SLEEP = 0.05; // motion below this settles the simulation

type Node = { x: number; y: number; px: number; py: number };

export function LightPull({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cordRef = useRef<SVGPolylineElement>(null);
  const beadsRef = useRef<(SVGCircleElement | null)[]>([]);
  const nodes = useRef<Node[]>(
    Array.from({ length: N }, (_, i) => ({
      x: ANCHOR.x,
      y: ANCHOR.y + i * SEG,
      px: ANCHOR.x,
      py: ANCHOR.y + i * SEG,
    }))
  );
  const drag = useRef({ active: false, x: 0, y: 0, moved: 0, t: 0 });
  const wakeRef = useRef<() => void>(() => {});
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let sleeping = false;
    let stopped = false;

    function step() {
      const ns = nodes.current;
      for (let i = 1; i < N; i++) {
        if (drag.current.active && i === N - 1) continue;
        const n = ns[i];
        const vx = (n.x - n.px) * FRICTION;
        const vy = (n.y - n.py) * FRICTION;
        n.px = n.x;
        n.py = n.y;
        n.x += vx;
        n.y += vy + GRAVITY;
      }
      ns[0].x = ANCHOR.x;
      ns[0].y = ANCHOR.y;
      if (drag.current.active) {
        let dx = drag.current.x - ANCHOR.x;
        let dy = drag.current.y - ANCHOR.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > MAX_REACH) {
          dx = (dx / d) * MAX_REACH;
          dy = (dy / d) * MAX_REACH;
        }
        ns[N - 1].x = ANCHOR.x + dx;
        ns[N - 1].y = ANCHOR.y + dy;
      }
      for (let k = 0; k < ITER; k++) {
        for (let i = 0; i < N - 1; i++) {
          const a = ns[i];
          const b = ns[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          const diff = (dist - SEG) / dist;
          const ox = dx * diff;
          const oy = dy * diff;
          const aPinned = i === 0;
          const bPinned = drag.current.active && i + 1 === N - 1;
          if (aPinned && bPinned) continue;
          if (aPinned) {
            b.x -= ox;
            b.y -= oy;
          } else if (bPinned) {
            a.x += ox;
            a.y += oy;
          } else {
            a.x += ox * 0.5;
            a.y += oy * 0.5;
            b.x -= ox * 0.5;
            b.y -= oy * 0.5;
          }
        }
        ns[0].x = ANCHOR.x;
        ns[0].y = ANCHOR.y;
      }
    }

    function draw() {
      const ns = nodes.current;
      cordRef.current?.setAttribute(
        'points',
        ns.map((n) => `${n.x.toFixed(2)},${n.y.toFixed(2)}`).join(' ')
      );
      for (let i = 0; i < N; i++) {
        const c = beadsRef.current[i];
        if (c) {
          c.setAttribute('cx', ns[i].x.toFixed(2));
          c.setAttribute('cy', ns[i].y.toFixed(2));
        }
      }
      // keep the invisible grab target on top of the knob
      const hit = beadsRef.current[N];
      if (hit) {
        hit.setAttribute('cx', ns[N - 1].x.toFixed(2));
        hit.setAttribute('cy', ns[N - 1].y.toFixed(2));
      }
    }

    function motion() {
      const ns = nodes.current;
      let e = 0;
      for (let i = 1; i < N; i++) {
        e += Math.abs(ns[i].x - ns[i].px) + Math.abs(ns[i].y - ns[i].py);
      }
      return e;
    }

    function loop() {
      step();
      draw();
      if (!drag.current.active && motion() < SLEEP) {
        sleeping = true;
        return;
      }
      raf = requestAnimationFrame(loop);
    }

    wakeRef.current = () => {
      if (stopped || reduce) return;
      if (sleeping) {
        sleeping = false;
        raf = requestAnimationFrame(loop);
      }
    };

    // Settle once so the chain hangs straight, then idle until touched.
    if (reduce) {
      draw();
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  function toSvg(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  const onPointerDown = (e: ReactPointerEvent<SVGCircleElement>) => {
    const p = toSvg(e.clientX, e.clientY);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { active: true, x: p.x, y: p.y, moved: 0, t: Date.now() };
    wakeRef.current();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGCircleElement>) => {
    if (!drag.current.active) return;
    const p = toSvg(e.clientX, e.clientY);
    if (!p) return;
    drag.current.moved += Math.hypot(p.x - drag.current.x, p.y - drag.current.y);
    drag.current.x = p.x;
    drag.current.y = p.y;
    wakeRef.current();
  };

  const onPointerUp = () => {
    if (!drag.current.active) return;
    const pulled = nodes.current[N - 1].y - REST_END_Y;
    const tap = drag.current.moved < 4 && Date.now() - drag.current.t < 250;
    drag.current.active = false;
    wakeRef.current();
    if (pulled > PULL_TOGGLE || tap) onToggleRef.current();
  };

  return (
    <div
      className="lightpull"
      role="button"
      tabIndex={0}
      aria-pressed={on}
      aria-label={on ? 'Turn the lights off' : 'Turn the lights on'}
      title={on ? 'Lights on — pull the chain to switch off' : 'Lights off — pull the chain to switch on'}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <svg
        ref={svgRef}
        className="lightpull-svg"
        viewBox="-28 0 100 210"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="lp-warm" cx="50%" cy="42%" r="62%">
            <stop offset="0%" stopColor="#fff6cf" />
            <stop offset="55%" stopColor="#ffd576" />
            <stop offset="100%" stopColor="#f2b73f" />
          </radialGradient>
          <radialGradient id="lp-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffd678" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffd678" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* warm halo — visible only when lit */}
        <ellipse className="halo" cx="22" cy="73" rx="58" ry="58" fill="url(#lp-halo)" />

        {/* wire from the top to the bulb */}
        <line className="cord" x1="22" y1="0" x2="22" y2="56" strokeWidth="1.5" />

        {/* glass */}
        <path
          className="glass"
          strokeWidth="1.4"
          d="M22 56 C13 56 6 62.5 6 71 C6 77 9.5 80.5 12 84 C13.6 86.2 14 87.6 14 90 L30 90 C30 87.6 30.4 86.2 32 84 C34.5 80.5 38 77 38 71 C38 62.5 31 56 22 56 Z"
        />
        {/* filament */}
        <path
          className="filament"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M15.5 74 Q19 81 22 74 Q25 81 28.5 74"
        />
        {/* screw cap */}
        <path
          className="cap"
          d="M15 91 h14 v2.4 h-14 z M16 95 h12 v2.4 h-12 z M17.4 99 h9 v2.4 h-9 z"
        />

        {/* the beaded pull-chain (positions driven by the physics loop) */}
        <polyline ref={cordRef} className="chain-cord" fill="none" points="" />
        {Array.from({ length: N }).map((_, i) => (
          <circle
            key={i}
            ref={(el) => {
              beadsRef.current[i] = el;
            }}
            className={`chain-bead${i === N - 1 ? ' chain-knob' : ''}`}
            r={i === N - 1 ? 4.2 : 2.2}
            cx={ANCHOR.x}
            cy={ANCHOR.y + i * SEG}
          />
        ))}
        {/* invisible, generous grab target that tracks the knob */}
        <circle
          ref={(el) => {
            beadsRef.current[N] = el;
          }}
          className="chain-hit"
          r="13"
          cx={ANCHOR.x}
          cy={REST_END_Y}
          fill="transparent"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </svg>
    </div>
  );
}
