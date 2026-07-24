//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useSketchContext } from "@/hooks/sketch.context";
import { cn } from "@/lib/utils";

import { PenIcon } from "./icons";

/**
 * Hand-drawn ("sketch") chart toggle wired to the app's `SketchContext`. When
 * active, every `<Chart>` renders its spec with Graphein's wobbly, hand-drawn
 * look. Drop it next to `<ThemeToggle />` in the `PageShell` `actions` slot.
 *
 * @example
 * ```tsx
 * <PageShell title="Overview" actions={<><SketchToggle /><ThemeToggle /></>}>…</PageShell>
 * ```
 */
export function SketchToggle({ className }: { className?: string }) {
    const { sketch, toggleSketch } = useSketchContext();
    return (
        <button
            type="button"
            onClick={toggleSketch}
            aria-pressed={sketch}
            aria-label={
                sketch ? "Switch to clean charts" : "Switch to hand-drawn charts"
            }
            title={sketch ? "Clean charts" : "Hand-drawn charts"}
            className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors",
                sketch
                    ? "border-primary bg-primary-soft text-primary-strong"
                    : "border-border text-foreground-secondary hover:bg-accent hover:text-foreground",
                className,
            )}
        >
            <PenIcon size={16} />
        </button>
    );
}
