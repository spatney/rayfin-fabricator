//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useThemeContext } from "@/hooks/theme.context";
import { cn } from "@/lib/utils";

import { MoonIcon, SunIcon } from "./icons";

/**
 * Light/dark toggle wired to the app's `ThemeContext`. Drop it into the
 * `PageShell` `actions` slot.
 *
 * @example
 * ```tsx
 * <PageShell title="Overview" actions={<ThemeToggle />}>…</PageShell>
 * ```
 */
export function ThemeToggle({ className }: { className?: string }) {
    const { isDark, toggleTheme } = useThemeContext();
    return (
        <button
            type="button"
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-foreground-secondary transition-colors hover:bg-accent hover:text-foreground",
                className,
            )}
        >
            {isDark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
    );
}
