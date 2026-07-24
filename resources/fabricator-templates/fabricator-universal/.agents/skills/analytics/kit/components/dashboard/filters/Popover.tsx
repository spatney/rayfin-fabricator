//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { cn } from "@/lib/utils";

/**
 * Props for the inline dashboard popover primitive.
 *
 * @example
 * ```tsx
 * <Popover trigger="Region">
 *   <div>Popover content</div>
 * </Popover>
 * ```
 */
export interface PopoverProps {
    /** The clickable trigger (rendered inside a <button>). */
    trigger: ReactNode;
    /** Panel content. */
    children: ReactNode;
    /** Align the panel to the start (left) or end (right) of the trigger (default "start"). */
    align?: "start" | "end";
    /** Panel min width in px (default 220). */
    minWidth?: number;
    className?: string;
    /** Optional controlled open state. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

/**
 * Accessible, non-portal popover for slicer panels and compact dashboard menus.
 *
 * @example
 * ```tsx
 * <Popover trigger={<span>Category</span>} align="end">
 *   <button type="button">Clear</button>
 * </Popover>
 * ```
 */
export function Popover({
    trigger,
    children,
    align = "start",
    minWidth = 220,
    className,
    open,
    onOpenChange,
}: PopoverProps): JSX.Element {
    const [internalOpen, setInternalOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    const reduceMotion = useReducedMotion();
    const isControlled = open !== undefined;
    const isOpen = open ?? internalOpen;

    const setPopoverOpen = useCallback(
        (nextOpen: boolean) => {
            if (!isControlled) setInternalOpen(nextOpen);
            onOpenChange?.(nextOpen);
        },
        [isControlled, onOpenChange],
    );

    useEffect(() => {
        if (!isOpen) return undefined;

        const handlePointerDown = (event: PointerEvent) => {
            if (!wrapperRef.current?.contains(event.target as Node)) {
                setPopoverOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setPopoverOpen(false);
                triggerRef.current?.focus();
            }
        };

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [isOpen, setPopoverOpen]);

    return (
        <div ref={wrapperRef} className={cn("relative inline-block", className)}>
            <button
                ref={triggerRef}
                type="button"
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={() => setPopoverOpen(!isOpen)}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
                {trigger}
            </button>
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        id={panelId}
                        role="dialog"
                        initial={
                            reduceMotion
                                ? { opacity: 0 }
                                : { opacity: 0, scale: 0.98, y: -4 }
                        }
                        animate={
                            reduceMotion
                                ? { opacity: 1 }
                                : { opacity: 1, scale: 1, y: 0 }
                        }
                        exit={
                            reduceMotion
                                ? { opacity: 0 }
                                : { opacity: 0, scale: 0.98, y: -4 }
                        }
                        transition={{ duration: reduceMotion ? 0 : 0.14 }}
                        className={cn(
                            "absolute z-20 mt-2 rounded-xl border border-border bg-popover p-2 shadow-lg",
                            align === "end" ? "right-0" : "left-0",
                        )}
                        style={{ minWidth }}
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
