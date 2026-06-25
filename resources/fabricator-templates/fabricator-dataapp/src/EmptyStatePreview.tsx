//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
    AnimatePresence,
    MotionConfig,
    motion,
    useReducedMotion,
} from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import worldMapUrl from "./empty-state-preview-world-map.png";

/**
 * Animated empty-state preview.
 *
 * Auto-cycles between three skeleton dashboard layouts to hint at the
 * range of visuals, layouts, and inputs the user can build. Each tab
 * re-mounts on entry so chart silhouettes replay their draw-in
 * animations (paths grow, bars rise, arcs sweep, markers pop in).
 *
 * This entire file (and its `empty-state-preview-world-map.png` asset)
 * is meant to be deleted (and `App.tsx` replaced with a
 * real implementation) once the user starts building their dashboard.
 */
export function EmptyStatePreview() {
    const [active, setActive] = useState(0);
    const prefersReducedMotion = useReducedMotion();

    // Auto-advance through tabs. Resets whenever `active` changes so a
    // manual tab click gets a full 3.8s before the next auto-advance.
    // Skipped entirely when the user prefers reduced motion — no auto
    // cycling, no progress-bar animation.
    useEffect(() => {
        if (prefersReducedMotion) return;
        const id = window.setTimeout(() => {
            setActive((i) => (i + 1) % TABS.length);
        }, 3800);
        return () => window.clearTimeout(id);
    }, [active, prefersReducedMotion]);

    const ActiveLayout = TABS[active].layout;

    // Scale the entire dashboard preview down to 75% so it sits comfortably
    // next to the marketing text + button beneath it.
    const SCALE = 0.75;
    const FRAME_W = 670;
    const FRAME_H = 500;
    const TABS_BLOCK_H = 20 + 24; // pill height + marginBottom
    const INNER_W = FRAME_W;
    const INNER_H = TABS_BLOCK_H + FRAME_H;
    const OUTER_W = INNER_W * SCALE;
    const OUTER_H = INNER_H * SCALE;

    return (
        <MotionConfig reducedMotion="user">
        <div
            className="relative flex min-h-full w-full items-center justify-center p-xxxl"
            style={{
                background:
                    "color-mix(in srgb, var(--color-background) 50%, var(--color-muted))",
            }}
        >
            <div className="flex flex-col items-start" style={{ width: OUTER_W }}>
                {/* Scaled dashboard preview */}
                <div
                    role="status"
                    aria-live="polite"
                    aria-label="Loading dashboard preview"
                    style={{ width: OUTER_W, height: OUTER_H }}
                >
                    <div
                        style={{
                            width: INNER_W,
                            height: INNER_H,
                            transform: `scale(${SCALE})`,
                            transformOrigin: "top left",
                        }}
                    >
                        {/* Tab pills */}
                        <div className="flex items-center gap-m mb-xxl">
                            {TABS.map((tab, i) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setActive(i)}
                                    aria-label={`Show ${tab.label} preview`}
                                    aria-pressed={active === i}
                                    className="relative h-5 w-[72px] overflow-hidden rounded-[10px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span
                                        className={`absolute inset-0 rounded-[10px] transition-colors duration-300 ${
                                            active === i ? "" : "bg-foreground/[0.08]"
                                        }`}
                                        style={
                                            active === i
                                                ? {
                                                      background:
                                                          "color-mix(in srgb, var(--color-foreground) 55%, var(--color-background))",
                                                  }
                                                : undefined
                                        }
                                    />
                                    {active === i && !prefersReducedMotion ? (
                                        <motion.span
                                            key={`progress-${tab.id}-${active}`}
                                            aria-hidden
                                            className="absolute bottom-0 left-0 h-full origin-left rounded-[10px] bg-foreground/25"
                                            initial={{ scaleX: 0 }}
                                            animate={{ scaleX: 1 }}
                                            transition={{ duration: 3.8, ease: "linear" }}
                                        />
                                    ) : null}
                                </button>
                            ))}
                        </div>

                        {/* Animated layout swap — fixed frame keeps the layout
                            stable as tabs cycle so nothing jumps around. */}
                        <div className="relative" style={{ width: FRAME_W, height: FRAME_H }}>
                            <AnimatePresence>
                                <motion.div
                                    key={TABS[active].id}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.5, ease: "easeInOut" }}
                                    className="absolute inset-0"
                                >
                                    <ActiveLayout />
                                </motion.div>
                            </AnimatePresence>
                        </div>

                        <span className="sr-only">
                            Loading dashboard preview — {TABS[active].label}
                        </span>
                    </div>
                </div>

                {/* Marketing text + CTA below the preview */}
                <div className="mt-[40px]">
                    <h2 className="font-heading font-semibold text-400 leading-[24px] text-foreground m-0">
                        Hello world
                    </h2>
                    <p className="font-base text-300 leading-300 text-foreground m-0 mt-s max-w-[518px]">
                        This is a blank data app template, with built-in skills and capabilities
                        for visual analytics and data decision-making.
                    </p>
                    <a
                        href="https://go.microsoft.com/fwlink/?LinkId=2365127"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block mt-l px-s py-xs rounded-xl border-0 bg-foreground text-background font-base text-200 cursor-pointer no-underline"
                    >
                        Learn more
                    </a>
                </div>
            </div>
        </div>
        </MotionConfig>
    );
}

/* --------------------------------------------------------------------- */
/* Layouts                                                               */
/* --------------------------------------------------------------------- */

/** Tab 1: two-row chart grid — area + bar over donut + list. */
function OverviewLayout() {
    return (
        <div className="grid h-full w-full grid-rows-2 gap-xl">
            <div className="grid min-h-0 grid-cols-5 gap-xl">
                <SurfaceSkeleton delay={0.05} className="col-span-3 h-full">
                    <AreaChartGhost delay={0.15} />
                </SurfaceSkeleton>
                <SurfaceSkeleton delay={0.1} className="col-span-2 h-full">
                    <BarChartGhost delay={0.2} />
                </SurfaceSkeleton>
            </div>
            <div className="grid min-h-0 grid-cols-5 gap-xl">
                <SurfaceSkeleton delay={0.15} className="col-span-2 h-full">
                    <DonutGhost delay={0.25} />
                </SurfaceSkeleton>
                <SurfaceSkeleton delay={0.2} className="col-span-3 h-full">
                    <ListGhost delay={0.3} />
                </SurfaceSkeleton>
            </div>
        </div>
    );
}

/** Tab 2: Three sparkline cards on top, wide map visual below (taller). */
function GeoLayout() {
    return (
        <div className="grid h-full w-full gap-xl [grid-template-rows:1fr_3fr]">
            <div className="grid min-h-0 grid-cols-3 gap-xl">
                <SurfaceSkeleton delay={0.05} className="h-full">
                    <SparklineGhost delay={0.15} variant="up" />
                </SurfaceSkeleton>
                <SurfaceSkeleton delay={0.1} className="h-full">
                    <SparklineGhost delay={0.2} variant="down" />
                </SurfaceSkeleton>
                <SurfaceSkeleton delay={0.15} className="h-full">
                    <SparklineGhost delay={0.25} variant="up" />
                </SurfaceSkeleton>
            </div>
            <SurfaceSkeleton delay={0.2} className="h-full" bleed>
                <MapGhost delay={0.3} />
            </SurfaceSkeleton>
        </div>
    );
}

/** Tab 3: Summary chart + list on the left, form on the right. */
function FormLayout() {
    return (
        <div className="grid h-full w-full grid-cols-5 gap-xl">
            <div className="col-span-2 grid h-full grid-rows-2 gap-xl">
                <SurfaceSkeleton delay={0.1} className="h-full">
                    <BarChartGhost delay={0.2} />
                </SurfaceSkeleton>
                <SurfaceSkeleton delay={0.15} className="h-full">
                    <ListGhost delay={0.3} />
                </SurfaceSkeleton>
            </div>
            <SurfaceSkeleton delay={0.05} className="col-span-3 h-full">
                <FormGhost delay={0.15} />
            </SurfaceSkeleton>
        </div>
    );
}

const TABS = [
    { id: "overview", label: "Overview", layout: OverviewLayout },
    { id: "geo", label: "Geo", layout: GeoLayout },
    { id: "form", label: "Form", layout: FormLayout },
] as const;

/* --------------------------------------------------------------------- */
/* Shared skeleton primitives                                            */
/* --------------------------------------------------------------------- */

interface SkeletonProps {
    className?: string;
    delay?: number;
}

/** A single shimmer block. Pulses opacity gently. */
function Skeleton({ className = "", delay = 0 }: SkeletonProps) {
    const prefersReducedMotion = useReducedMotion();
    return (
        <motion.div
            initial={{ opacity: 0.5 }}
            animate={
                prefersReducedMotion
                    ? { opacity: 0.5 }
                    : { opacity: [0.35, 0.7, 0.35] }
            }
            transition={
                prefersReducedMotion
                    ? { duration: 0 }
                    : {
                          duration: 1.8,
                          repeat: Infinity,
                          ease: "easeInOut",
                          delay,
                      }
            }
            className={`bg-foreground/[0.16] ${className}`}
        />
    );
}

/** Card-shaped skeleton with a soft border, used as a chart placeholder. */
function SurfaceSkeleton({
    className = "",
    delay = 0,
    children,
    bleed = false,
}: SkeletonProps & { children?: ReactNode; bleed?: boolean }) {
    const prefersReducedMotion = useReducedMotion();
    return (
        <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.45, ease: "easeOut", delay }}
            className={`relative overflow-hidden bg-card rounded-2xl border border-foreground/[0.09] ${className}`}
        >
            <motion.div
                aria-hidden
                initial={{ opacity: 0.4 }}
                animate={
                    prefersReducedMotion
                        ? { opacity: 0.4 }
                        : { opacity: [0.25, 0.55, 0.25] }
                }
                transition={
                    prefersReducedMotion
                        ? { duration: 0 }
                        : {
                              duration: 2.2,
                              repeat: Infinity,
                              ease: "easeInOut",
                              delay,
                          }
                }
                className="absolute inset-0 rounded-2xl"
                style={{
                    background:
                        "linear-gradient(110deg, transparent 30%, color-mix(in srgb, var(--color-foreground) 5%, transparent) 50%, transparent 70%)",
                }}
            />
            {children ? (
                <div className={`relative h-full w-full ${bleed ? "" : "p-l"}`}>
                    {children}
                </div>
            ) : null}
        </motion.div>
    );
}

/* --------------------------------------------------------------------- */
/* Ghost visualizations                                                  */
/* --------------------------------------------------------------------- */

// Visuals use the foreground dark grey for marks rather than the brand
// blue, to read as a quiet, neutral skeleton.
const BRAND = "var(--color-foreground)";
const MUTED_FG = "var(--color-muted-foreground)";

/** Faint area chart silhouette with a baseline grid. */
function AreaChartGhost({ delay = 0 }: { delay?: number }) {
    const linePath =
        "M0 140 C 60 130, 110 90, 170 95 S 280 70, 340 80 S 470 30, 540 55 S 660 110, 720 70 L 800 50";
    const areaPath = `${linePath} L 800 200 L 0 200 Z`;

    return (
        <svg
            viewBox="0 0 800 200"
            preserveAspectRatio="none"
            className="h-full w-full"
            aria-hidden
        >
            <defs>
                <linearGradient id="ghost-area-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={BRAND} stopOpacity="0" />
                </linearGradient>
            </defs>

            {[40, 80, 120, 160].map((y) => (
                <line
                    key={y}
                    x1="0"
                    x2="800"
                    y1={y}
                    y2={y}
                    stroke="transparent"
                    strokeWidth="0"
                />
            ))}

            <AreaFillPulse areaPath={areaPath} delay={delay} />
            <motion.path
                d={linePath}
                fill="none"
                stroke={BRAND}
                strokeOpacity="0.45"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 1.2, ease: "easeOut", delay: delay + 0.1 }}
            />
        </svg>
    );
}

/** Faint bar chart silhouette — chunky bars. */
function BarChartGhost({ delay = 0 }: { delay?: number }) {
    const heights = [55, 30, 70, 45, 85, 38, 60];
    const w = 32;
    const gap = 14;
    const totalW = heights.length * w + (heights.length - 1) * gap;
    const startX = (320 - totalW) / 2;
    return (
        <svg
            viewBox="0 0 320 120"
            preserveAspectRatio="none"
            className="h-full w-full"
            aria-hidden
        >
            <line
                x1="0"
                x2="320"
                y1="118"
                y2="118"
                stroke={MUTED_FG}
                strokeOpacity="0.18"
                strokeWidth="1"
            />
            {heights.map((h, i) => {
                const x = startX + i * (w + gap);
                return (
                    <motion.rect
                        key={i}
                        x={x}
                        width={w}
                        y={118 - h}
                        height={h}
                        rx="4"
                        fill={BRAND}
                        fillOpacity="0.4"
                        initial={{ scaleY: 0, opacity: 0 }}
                        animate={{ scaleY: 1, opacity: 1 }}
                        style={{ transformOrigin: `${x + w / 2}px 118px` }}
                        transition={{
                            duration: 0.6,
                            ease: "easeOut",
                            delay: delay + i * 0.05,
                        }}
                    />
                );
            })}
        </svg>
    );
}

/** Faint donut silhouette — full light-grey ring with a darker arc layered on top. */
function DonutGhost({ delay = 0 }: { delay?: number }) {
    const cx = 60;
    const cy = 60;
    const r = 42;
    const stroke = 16;
    // The dark segment is ~32% of the ring, drawn on top of the light ring so
    // we don't need a gap or precise segment boundaries.
    const darkSweep = 0.32 * Math.PI * 2;
    const startAngle = -Math.PI / 2; // top
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(startAngle + darkSweep);
    const y2 = cy + r * Math.sin(startAngle + darkSweep);
    const darkArc = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${
        darkSweep > Math.PI ? 1 : 0
    } 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;

    const c = 2 * Math.PI * r;

    return (
        <svg viewBox="0 0 120 120" className="mx-auto h-full" aria-hidden>
            {/* Light-grey full ring — draws in clockwise from the top */}
            <motion.circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={MUTED_FG}
                strokeOpacity="0.35"
                strokeWidth={stroke}
                strokeLinecap="butt"
                transform={`rotate(-90 ${cx} ${cy})`}
                initial={{ strokeDasharray: `0 ${c}`, opacity: 0 }}
                animate={{ strokeDasharray: `${c} 0`, opacity: 1 }}
                transition={{ duration: 1, ease: "easeOut", delay }}
            />
            {/* Darker arc on top — draws in via pathLength */}
            <motion.path
                d={darkArc}
                fill="none"
                stroke={MUTED_FG}
                strokeOpacity="0.6"
                strokeWidth={stroke}
                strokeLinecap="butt"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.9, ease: "easeOut", delay: delay + 0.7 }}
            />
        </svg>
    );
}

/** Grayscale world-map silhouette with animated bubble markers. */
function MapGhost({ delay = 0 }: { delay?: number }) {
    // viewBox matches the world-map PNG's intrinsic aspect (960x411) so the
    // image fills it without distortion. Markers are placed in viewBox
    // coordinates over visible land (image is equirectangular cropped to
    // roughly 84°N..-70°S, so lat -> y uses 2.67 px per degree).
    const markers = [
        { cx: 245, cy: 115, r: 14, opacity: 0.7 }, // North America (Chicago)
        { cx: 355, cy: 286, r: 11, opacity: 0.5 }, // South America (São Paulo)
        { cx: 501, cy: 91, r: 13, opacity: 0.65 }, // Europe (Frankfurt)
        { cx: 579, cy: 227, r: 11, opacity: 0.55 }, // Africa (Nairobi)
        { cx: 579, cy: 75, r: 14, opacity: 0.7 }, // Russia (Moscow)
        { cx: 675, cy: 174, r: 12, opacity: 0.55 }, // India (Mumbai)
        { cx: 883, cy: 315, r: 13, opacity: 0.6 }, // Australia (Sydney)
    ];

    return (
        <svg
            viewBox="0 0 960 411"
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full"
            aria-hidden
        >
            {/* World-map PNG underlay */}
            <image
                href={worldMapUrl}
                x="0"
                y="0"
                width="960"
                height="411"
                preserveAspectRatio="xMidYMid meet"
                className="dark:opacity-55"
            />

            {/* Markers — pop in then pulse */}
            {markers.map((m, i) => (
                <g key={i}>
                    <MarkerRipple m={m} delay={delay + 0.5 + i * 0.15} />
                    <motion.circle
                        cx={m.cx}
                        cy={m.cy}
                        r={m.r}
                        fill={BRAND}
                        fillOpacity={m.opacity}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: m.opacity }}
                        transition={{
                            duration: 0.5,
                            ease: "backOut",
                            delay: delay + 0.5 + i * 0.15,
                        }}
                        style={{ transformOrigin: `${m.cx}px ${m.cy}px` }}
                    />
                </g>
            ))}
        </svg>
    );
}

/** Tiny KPI + sparkline pair. */
function SparklineGhost({
    delay = 0,
    variant = "up",
}: {
    delay?: number;
    variant?: "up" | "down";
}) {
    const path =
        variant === "up"
            ? "M0 40 L 30 35 L 60 38 L 90 25 L 120 28 L 150 12 L 180 18"
            : "M0 12 L 30 18 L 60 14 L 90 28 L 120 24 L 150 36 L 180 32";
    return (
        <div className="flex h-full items-center gap-m">
            <div className="flex flex-1 flex-col gap-s">
                <Skeleton className="h-2.5 w-16 rounded-full" delay={delay} />
                <Skeleton className="h-5 w-20 rounded-md" delay={delay + 0.05} />
            </div>
            <svg viewBox="0 0 180 50" className="h-10 w-24" aria-hidden>
                <motion.path
                    d={path}
                    fill="none"
                    stroke={BRAND}
                    strokeOpacity="0.7"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 1, ease: "easeOut", delay: delay + 0.1 }}
                />
            </svg>
        </div>
    );
}

/** A list/table-like silhouette: dense rows of light bars with a small dark chip. */
function ListGhost({ delay = 0 }: { delay?: number }) {
    const rows = [0.95, 0.82, 0.9, 0.78, 0.86, 0.72, 0.92, 0.8, 0.88];
    return (
        <div className="flex h-full flex-col justify-between py-[2px]">
            {rows.map((w, i) => (
                <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.4, ease: "easeOut", delay: delay + i * 0.04 }}
                    className="flex items-center gap-[6px]"
                >
                    <div
                        className="h-[6px] flex-1 rounded-full bg-foreground/[0.12]"
                        style={{ maxWidth: `${w * 100}%` }}
                    />
                    <div className="h-[6px] w-6 rounded-full bg-foreground/[0.35]" />
                </motion.div>
            ))}
        </div>
    );
}

/** Form silhouette: label/input pairs, plus secondary + primary buttons. */
function FormGhost({ delay = 0 }: { delay?: number }) {
    const fields: { labelW: string }[] = [
        { labelW: "w-16" },
        { labelW: "w-20" },
        { labelW: "w-14" },
        { labelW: "w-24" },
        { labelW: "w-16" },
    ];
    return (
        <div className="flex h-full flex-col justify-between gap-m">
            <div className="flex flex-col gap-m">
                {fields.map((f, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                            duration: 0.4,
                            ease: "easeOut",
                            delay: delay + i * 0.06,
                        }}
                        className="flex flex-col gap-s"
                    >
                        <div className={`h-2 ${f.labelW} rounded-full bg-foreground/[0.12]`} />
                        <div className="flex h-6 w-full items-center border border-input bg-background px-m rounded-2xl">
                            <div className="h-2 w-32 rounded-full bg-foreground/[0.12]" />
                        </div>
                    </motion.div>
                ))}
            </div>
            <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: "easeOut", delay: delay + 0.4 }}
                className="flex items-center justify-end gap-m"
            >
                <div className="h-5 w-[72px] rounded-[10px] bg-foreground/[0.12]" />
                <div
                    className="h-5 w-[72px] rounded-[10px]"
                    style={{
                        background:
                            "color-mix(in srgb, var(--color-foreground) 55%, var(--color-background))",
                    }}
                />
            </motion.div>
        </div>
    );
}

/** Infinite opacity pulse on the area-chart fill — held static when the user
 * prefers reduced motion. */
function AreaFillPulse({ areaPath, delay }: { areaPath: string; delay: number }) {
    const prefersReducedMotion = useReducedMotion();
    return (
        <motion.path
            d={areaPath}
            fill="url(#ghost-area-fill)"
            initial={{ opacity: 0.55 }}
            animate={
                prefersReducedMotion
                    ? { opacity: 0.55 }
                    : { opacity: [0.4, 0.75, 0.4] }
            }
            transition={
                prefersReducedMotion
                    ? { duration: 0 }
                    : { duration: 2.6, repeat: Infinity, ease: "easeInOut", delay }
            }
        />
    );
}

/** Infinite ripple ring behind each map marker — held static (invisible) when
 * the user prefers reduced motion. */
function MarkerRipple({
    m,
    delay,
}: {
    m: { cx: number; cy: number; r: number; opacity: number };
    delay: number;
}) {
    const prefersReducedMotion = useReducedMotion();
    if (prefersReducedMotion) return null;
    return (
        <motion.circle
            cx={m.cx}
            cy={m.cy}
            r={m.r * 2.4}
            fill={BRAND}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: [0, 0.18, 0], scale: [0.6, 1.4, 1.8] }}
            transition={{
                duration: 2.2,
                repeat: Infinity,
                ease: "easeOut",
                delay,
            }}
            style={{ transformOrigin: `${m.cx}px ${m.cy}px` }}
        />
    );
}
