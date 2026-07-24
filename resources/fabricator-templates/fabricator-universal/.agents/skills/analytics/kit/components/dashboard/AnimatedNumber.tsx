//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect, useState } from "react";
import { animate, useMotionValue, useReducedMotion } from "framer-motion";

export interface AnimatedNumberProps {
    /** Target numeric value to count to. */
    value: number;
    /** Formats the (interpolated) number to a display string. */
    format: (value: number) => string;
    /** Count-up duration in seconds (default 0.7). */
    duration?: number;
}

/**
 * Animated number that eases from its previous value to the next whenever
 * `value` changes — used for KPI / gauge metrics. Honors
 * `prefers-reduced-motion` (jumps straight to the final value) and always
 * renders the exact formatted target at rest.
 *
 * @example
 * ```tsx
 * <AnimatedNumber value={total} format={resolveFormat("currency")} />
 * ```
 */
export function AnimatedNumber({
    value,
    format,
    duration = 0.7,
}: AnimatedNumberProps) {
    const reduce = useReducedMotion();
    const motionValue = useMotionValue(value);
    const [display, setDisplay] = useState(() => format(value));

    useEffect(() => {
        const apply = (next: number) => setDisplay(format(next));
        if (reduce || !Number.isFinite(value)) {
            apply(value);
            return;
        }
        const controls = animate(motionValue, value, {
            duration,
            ease: "easeOut",
            onUpdate: apply,
        });
        return () => controls.stop();
    }, [value, reduce, duration, format, motionValue]);

    return <>{display}</>;
}
