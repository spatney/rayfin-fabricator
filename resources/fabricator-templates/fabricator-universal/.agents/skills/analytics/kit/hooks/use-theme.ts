//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect } from "react";

/**
 * Detects the current color scheme preference and toggles the `dark`
 * class on `<html>`. Listens for changes to `prefers-color-scheme` and
 * the `data-appearance` attribute on `<html>`.
 */
export function useAppTheme() {
    const [isDark, setIsDark] = useState(() => {
        // Check data-appearance attribute first (set by host environment)
        const appearance = document.documentElement.getAttribute("data-appearance");
        if (appearance === "dark") return true;
        if (appearance === "light") return false;

        // Check for .dark class
        if (document.documentElement.classList.contains("dark")) return true;

        // Fall back to OS preference
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
    });

    useEffect(() => {
        // Sync the .dark class on <html> for Tailwind dark mode
        document.documentElement.classList.toggle("dark", isDark);
    }, [isDark]);

    useEffect(() => {
        // Watch OS-level preference
        const mql = window.matchMedia("(prefers-color-scheme: dark)");
        const onMediaChange = (e: MediaQueryListEvent) => setIsDark(e.matches);
        mql.addEventListener("change", onMediaChange);

        // Watch data-appearance attribute on <html>
        const observer = new MutationObserver(() => {
            const appearance = document.documentElement.getAttribute("data-appearance");
            if (appearance === "dark") setIsDark(true);
            else if (appearance === "light") setIsDark(false);
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-appearance", "class"],
        });

        return () => {
            mql.removeEventListener("change", onMediaChange);
            observer.disconnect();
        };
    }, []);

    const toggleTheme = () => setIsDark((prev: boolean) => !prev);

    return { isDark, toggleTheme };
}
