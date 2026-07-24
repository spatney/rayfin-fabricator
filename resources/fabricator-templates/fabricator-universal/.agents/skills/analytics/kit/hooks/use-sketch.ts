//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState } from "react";

/**
 * Global "sketch" (hand-drawn) chart mode. When on, every `<Chart>` injects
 * `sketch: true` into its spec so charts render with Graphein's wobbly,
 * hand-drawn look. Purely presentational and off by default — drop a
 * `<SketchToggle />` in the masthead to flip it.
 */
export function useAppSketch() {
    const [sketch, setSketch] = useState(false);
    const toggleSketch = () => setSketch((prev: boolean) => !prev);
    return { sketch, toggleSketch };
}
