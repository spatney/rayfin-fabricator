//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Shared dev-time guardrail. The single most common mistake when wiring a
 * visual is a key (a spec `encoding` field name, or a `KpiCard` `valueKey`)
 * that doesn't match a mapped column (wrong casing, an un-aliased DAX name like
 * `[Total Revenue]`, or forgetting `toChartData`) — which silently renders the
 * empty state. This prints one loud, actionable console warning per missing key
 * instead, so the mistake is obvious without a deploy. No-op in production builds.
 */
export function warnMissingKeys(
    component: string,
    rows: ReadonlyArray<Record<string, unknown>> | undefined,
    keys: ReadonlyArray<string | undefined | null>,
): void {
    if (!import.meta.env.DEV) return;
    if (!rows || rows.length === 0) return;

    const first = rows[0];
    if (!first || typeof first !== "object") return;

    const available = Object.keys(first);
    const availableLabel = available.length ? available.join(", ") : "(none)";

    const seen = new Set<string>();
    for (const key of keys) {
        if (typeof key !== "string" || key.length === 0) continue;
        if (available.includes(key) || seen.has(key)) continue;
        seen.add(key);
        console.warn(
            `[${component}] key "${key}" was not found in the mapped rows, so this ` +
                `visual renders its empty state. Available keys: ${availableLabel}. ` +
                `Fix the casing, or alias the column in ` +
                `toChartData({ columns: { ${key}: "Table[Column]" } }).`,
        );
    }
}
