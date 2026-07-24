//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { resolveColor } from "@/lib/chartTokens";

export interface SparklineProps {
    /** A list of numbers, or objects keyed by `dataKey`. */
    data: ReadonlyArray<number | Record<string, unknown>>;
    /** Accessor when `data` holds objects (default `"value"`). */
    dataKey?: string;
    /** Line/fill color — a chart token, role, `var(--…)`, or hex. */
    color?: string;
    /** Pixel height (default 40). */
    height?: number;
    /** Filled area (default) or a bare line. */
    variant?: "area" | "line";
    className?: string;
}

/** Measure an element's width with a `ResizeObserver` (0 until first layout). */
function useElementWidth<T extends HTMLElement>() {
    const [width, setWidth] = useState(0);
    const observer = useRef<ResizeObserver | null>(null);
    const ref = useCallback((node: T | null) => {
        observer.current?.disconnect();
        if (!node) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) setWidth(entry.contentRect.width);
        });
        ro.observe(node);
        observer.current = ro;
    }, []);
    useEffect(() => () => observer.current?.disconnect(), []);
    return { ref, width };
}

/** Build the line + area SVG paths, breaking at non-finite values. */
function buildPaths(values: number[], width: number, height: number) {
    const inner = Math.max(0, height - 4);
    const finite = values.filter((value) => Number.isFinite(value));
    const min = finite.length ? Math.min(...finite) : 0;
    const max = finite.length ? Math.max(...finite) : 1;
    const span = max - min || 1;
    const xAt = (index: number) =>
        values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width;
    const yAt = (value: number) => 2 + (1 - (value - min) / span) * inner;

    let line = "";
    let area = "";
    let run: Array<[number, number]> = [];
    const flush = () => {
        if (run.length === 0) return;
        const pts = run.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`);
        line += `M${pts.join("L")}`;
        const first = run[0];
        const last = run[run.length - 1];
        area += `M${first[0].toFixed(2)} ${height}L${pts.join("L")}L${last[0].toFixed(2)} ${height}Z`;
        run = [];
    };
    values.forEach((value, index) => {
        if (Number.isFinite(value)) run.push([xAt(index), yAt(value)]);
        else flush();
    });
    flush();
    return { line, area };
}

/**
 * Compact, axis-less trend line for KPI cards and inline cells — a tiny
 * hand-rolled SVG sparkline (no charting library). Pass a raw `number[]` (or
 * objects + `dataKey`).
 *
 * @example
 * ```tsx
 * <Sparkline data={[12, 18, 9, 22, 17, 25]} color="chart-1" />
 * ```
 */
export function Sparkline({
    data,
    dataKey = "value",
    color,
    height = 40,
    variant = "area",
    className,
}: SparklineProps) {
    const gradientId = useId().replace(/:/g, "");
    const stroke = resolveColor(color, 0);
    const { ref, width } = useElementWidth<HTMLDivElement>();

    const values = (
        typeof data[0] === "number"
            ? (data as ReadonlyArray<number>)
            : (data as ReadonlyArray<Record<string, unknown>>).map((row) =>
                  Number(row[dataKey]),
              )
    ).map((value) => (Number.isFinite(value) ? value : Number.NaN));

    const { line: linePath, area: areaPath } =
        width > 0 && values.length > 0
            ? buildPaths(values, width, height)
            : { line: "", area: "" };

    return (
        <div ref={ref} className={className} style={{ height }}>
            {width > 0 && (
                <svg width={width} height={height} role="img" aria-hidden>
                    <defs>
                        <linearGradient
                            id={gradientId}
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                        >
                            <stop
                                offset="0%"
                                stopColor={stroke}
                                stopOpacity={0.35}
                            />
                            <stop
                                offset="100%"
                                stopColor={stroke}
                                stopOpacity={0}
                            />
                        </linearGradient>
                    </defs>
                    {variant === "area" && (
                        <path d={areaPath} fill={`url(#${gradientId})`} />
                    )}
                    <path
                        d={linePath}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={1.75}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            )}
        </div>
    );
}
