//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createContext, useContext } from "react";

interface SketchContextValue {
    /** Whether hand-drawn ("sketch") chart rendering is active. */
    sketch: boolean;
    /** Flip sketch mode on/off. */
    toggleSketch: () => void;
}

export const SketchContext = createContext<SketchContextValue>({
    sketch: false,
    toggleSketch: () => {},
});

export function useSketchContext() {
    return useContext(SketchContext);
}
