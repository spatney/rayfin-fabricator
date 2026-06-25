//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useState, useEffect, useCallback } from "react";
import { type CachedQueryResult } from "@microsoft/fabric-app-data";
import { getFabricClient } from "@/lib/fabric-client";

interface UseSemanticModelQueryOptions {
    /** Connection alias from fabric.yaml (e.g., "salesModel"). */
    connection: string;
    /** DAX query string. */
    query: string;
    /** If true, skip reading from cache (still writes the fresh result). */
    bypassCache?: boolean;
}

interface UseSemanticModelQueryResult {
    data: CachedQueryResult | undefined;
    isLoading: boolean;
    error: Error | undefined;
    refetch: () => Promise<void>;
}

/**
 * React hook that executes a DAX query against a Power BI semantic model
 * via the Fabric SDK. Results are cached by the SDK's built-in LRU cache.
 *
 * The connection alias is resolved from `fabric.generated.ts`
 * (managed by `npx fabric-app-data`).
 *
 * @example
 * // Basic usage
 * const { data, isLoading } = useSemanticModelQuery({
 *   connection: "salesModel",
 *   query: 'EVALUATE SUMMARIZE(Sales, Products[Name], "Total", SUM(Sales[Amount]))',
 * });
 *
 * if (data?.status === "success") {
 *   const table = data.table;
 *   // table.columns, table.rows
 * }
 *
 * @example
 * // Handling errors (SDK never throws — check result.status)
 * if (data?.status === "error") {
 *   console.error(data.error.message); // e.g., "401 Unauthorized"
 * }
 *
 * @example
 * // Checking cache status
 * if (data?.fromCache) {
 *   console.log(`Cached at ${data.cachedAt}`);
 * }
 *
 * @example
 * // Bypassing cache for fresh data
 * const { data } = useSemanticModelQuery({
 *   connection: "salesModel",
 *   query: 'EVALUATE ...',
 *   bypassCache: true,
 * });
 */
export function useSemanticModelQuery(
    options: UseSemanticModelQueryOptions,
): UseSemanticModelQueryResult {
    const { connection, query, bypassCache } = options;
    const [data, setData] = useState<CachedQueryResult | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | undefined>();

    const canExecute = Boolean(connection && query);

    const execute = useCallback(async () => {
        if (!canExecute) return;
        setIsLoading(true);
        setError(undefined);

        try {
            const result = await getFabricClient()
                .semanticModel(connection)
                .query(query, { bypassCache });

            setData(result);

            if (result.status === "error") {
                setError(new Error(result.error.message));
            }
        } catch (err) {
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            setIsLoading(false);
        }
    }, [connection, query, bypassCache, canExecute]);

    useEffect(() => {
        execute();
    }, [execute]);

    return { data, isLoading, error, refetch: execute };
}

/**
 * Clears cached query results from the SDK's LRU cache.
 * Pass a connection alias to clear a specific model, or omit to clear all.
 *
 * @example
 * clearQueryCache();              // clear all models
 * clearQueryCache("salesModel");  // clear a specific model
 */
export function clearQueryCache(connection?: string): void {
    if (connection) {
        getFabricClient().semanticModel(connection).clearCache();
    } else {
        getFabricClient().clearCache();
    }
}
