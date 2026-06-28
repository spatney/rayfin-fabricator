//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createRoot } from "react-dom/client";

import { FilterStateProvider } from "@/components/dashboard/filters/filter-state";
import { useAppTheme } from "@/hooks/use-theme";
import { ThemeContext } from "@/hooks/theme.context";

import { Gallery } from "./Gallery";

import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../global.css";

function GalleryRoot() {
    const { isDark, toggleTheme } = useAppTheme();
    return (
        <ThemeContext.Provider value={{ isDark, toggleTheme }}>
            <FilterStateProvider>
                <Gallery />
            </FilterStateProvider>
        </ThemeContext.Provider>
    );
}

createRoot(document.getElementById("root")!).render(<GalleryRoot />);
