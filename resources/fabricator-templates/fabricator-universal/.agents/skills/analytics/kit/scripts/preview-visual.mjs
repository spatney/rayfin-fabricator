//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Headless visual preview — render a Graphein `ChartSpec` to a PNG **plus a
 * machine-readable render report**, themed to match the deployed app, WITHOUT
 * deploying to Fabric.
 *
 * This is the fast inner loop for "check a visual against live data": fetch rows
 * with `fabric-app-data query`, author a spec, render it here, then read the PNG
 * (you have vision) and the report (clipping / overlap / contrast / counts) to
 * critique it — no deploy round-trip. Fabricator auto-deploys after the turn; this
 * just makes the per-visual presentation check instant.
 *
 * Usage:
 *   node scripts/preview-visual.mjs --spec <path|-> [options]
 *
 * Data — pick at most one; otherwise the spec's inlined `data` array is used:
 *   --query <alias>     Run a DAX query against this fabric.yaml alias, inject the rows.
 *   --dax <DAX>         Inline DAX (with --query).
 *   --dax-file <path>   DAX file (with --query).
 *   --data <path|->     A pre-fetched `fabric-app-data query` JSON result (file or stdin).
 *   --columns <json>    Optional toChartData-style column map, e.g.
 *                       '{"month":"Date[Month]","revenue":"Total Revenue"}'.
 *   --limit <n>         Row cap for --query (default 1000).
 *
 * Rendering:
 *   --out <path>        PNG path (default: a temp file, printed as `out`).
 *   --width <px>        Default 800.   --height <px>  Default 500.   --dpr <n>  Default 2.
 *   --theme light|dark  Match the app's src/global.css tokens (default light).
 *   --no-theme          Don't inject a theme (use the spec's own / Graphein default).
 *
 * Output: writes the PNG and prints a JSON critique to stdout — `ok`, `summary`,
 * `diagnostics`, `lint`, mark/series/color counts, `out`, and any `repaired` patch ops.
 * Exit codes: 0 = rendered · 1 = error.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GlobalFonts } from "@napi-rs/canvas";
import { renderChart } from "@graphein/node";
import { repairSpec, summarize, validateSpec } from "graphein";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** DAX column dataTypes coerced to JS numbers (mirrors src/lib/to-chart-data.ts). */
const NUMERIC_DAX_TYPES = new Set([
    "int64",
    "double",
    "decimal",
    "currency",
    "money",
    "single",
    "float",
    "number",
]);

// --------------------------------------------------------------------------
// Output helpers — stdout is JSON-only so the caller can parse it.
// --------------------------------------------------------------------------

function emit(obj) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function die(code, obj) {
    emit(obj);
    process.exit(code);
}

function usage() {
    process.stderr.write(
        "Usage: node scripts/preview-visual.mjs --spec <path|-> " +
            "[--query <alias> --dax <DAX> | --dax-file <path> | --data <path|->] " +
            "[--columns <json>] [--out <path>] [--width 800] [--height 500] " +
            "[--dpr 2] [--theme light|dark] [--no-theme] [--limit 1000]\n",
    );
}

// --------------------------------------------------------------------------
// Args
// --------------------------------------------------------------------------

const FLAGS = {
    "--spec": "spec",
    "--out": "out",
    "--width": "width",
    "--height": "height",
    "--dpr": "dpr",
    "--theme": "theme",
    "--query": "query",
    "--dax": "dax",
    "--dax-file": "daxFile",
    "--data": "data",
    "--columns": "columns",
    "--limit": "limit",
};

function parseArgs(argv) {
    const args = { width: 800, height: 500, dpr: 2, theme: "light", limit: 1000 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--no-theme") {
            args.noTheme = true;
            continue;
        }
        if (a === "--help" || a === "-h") {
            args.help = true;
            continue;
        }
        const key = FLAGS[a];
        if (!key) {
            usage();
            die(1, { ok: false, rendered: false, error: `Unknown argument: ${a}` });
        }
        const val = argv[++i];
        if (val === undefined) {
            die(1, { ok: false, rendered: false, error: `Missing value for ${a}` });
        }
        args[key] = val;
    }
    args.width = Number(args.width);
    args.height = Number(args.height);
    args.dpr = Number(args.dpr);
    args.limit = Number(args.limit);
    return args;
}

// --------------------------------------------------------------------------
// Input loading
// --------------------------------------------------------------------------

function readInput(arg) {
    return arg === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(path.resolve(arg), "utf8");
}

function loadSpec(arg) {
    let text;
    try {
        text = readInput(arg);
    } catch (e) {
        die(1, { ok: false, rendered: false, error: `Cannot read --spec: ${e.message}` });
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        die(1, { ok: false, rendered: false, error: `--spec is not valid JSON: ${e.message}` });
    }
}

// --------------------------------------------------------------------------
// Theme parity — parse src/global.css tokens into a Graphein ThemeInput.
// Mirrors the role→token bridge in src/lib/graphein-theme.ts so a headless
// preview matches the deployed app's colors (and dark mode).
// --------------------------------------------------------------------------

function extractBlock(css, headerRe) {
    const m = headerRe.exec(css);
    if (!m) return "";
    const start = m.index + m[0].length; // just past the opening "{"
    let depth = 1;
    for (let i = start; i < css.length; i++) {
        const ch = css[i];
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return css.slice(start, i);
    }
    return css.slice(start);
}

function parseVars(block) {
    const out = {};
    const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(block))) out[m[1]] = m[2].trim();
    return out;
}

function readCssTheme(mode) {
    let css;
    try {
        css = readFileSync(path.join(ROOT, "src", "global.css"), "utf8");
    } catch {
        return null; // no global.css → let Graphein use its built-in theme
    }
    const light = parseVars(extractBlock(css, /@theme\b[^{]*\{/));
    const dark = { ...light, ...parseVars(extractBlock(css, /(?:^|[\s,}])\.dark\s*\{/m)) };
    const v = mode === "dark" ? dark : light;

    const palette = [];
    for (let i = 1; i <= 10; i++) {
        const c = v[`--color-chart-${i}`];
        if (c) palette.push(c);
    }
    const color = {
        background: v["--color-card"],
        surface: v["--color-popover"],
        text: v["--color-foreground"],
        textMuted: v["--color-foreground-secondary"],
        axis: v["--color-chart-axis"],
        grid: v["--color-chart-grid"],
        border: v["--color-border"],
        accent: v["--color-primary"],
        palette: palette.length ? palette : undefined,
        positive: v["--color-success"],
        negative: v["--color-destructive"],
    };
    // Drop unresolved tokens so Graphein falls back per-role.
    for (const k of Object.keys(color)) if (color[k] === undefined) delete color[k];
    return { base: mode === "dark" ? "dark" : "light", color };
}

// --------------------------------------------------------------------------
// Fonts — register the bundled Inter (Graphein's default family) for parity.
// --------------------------------------------------------------------------

function registerInter() {
    const dir = path.join(ROOT, "node_modules", "@fontsource-variable", "inter", "files");
    try {
        const files = readdirSync(dir);
        const pick =
            files.find((f) => f.includes("latin") && f.includes("wght-normal") && f.endsWith(".woff2")) ??
            files.find((f) => f.includes("latin") && f.endsWith(".woff2"));
        if (pick) {
            GlobalFonts.registerFromPath(path.join(dir, pick), "Inter");
            return GlobalFonts.has("Inter");
        }
    } catch {
        /* best-effort: a missing font is non-fatal; text falls back to a system sans */
    }
    return false;
}

// --------------------------------------------------------------------------
// Live data — run a DAX query and shape the rows like toChartData.
// --------------------------------------------------------------------------

function runQuery({ alias, dax, daxFile, limit }) {
    let fileArg = daxFile ? path.resolve(daxFile) : null;
    if (!fileArg) {
        fileArg = path.join(mkdtempSync(path.join(tmpdir(), "gp-dax-")), "query.dax");
        writeFileSync(fileArg, dax, "utf8");
    }
    const bin = path.join(
        ROOT,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "fabric-app-data.cmd" : "fabric-app-data",
    );
    const res = spawnSync(bin, ["query", alias, "--file", fileArg, "--limit", String(limit)], {
        cwd: ROOT,
        encoding: "utf8",
        shell: process.platform === "win32",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
        die(1, {
            ok: false,
            rendered: false,
            error: `fabric-app-data query failed (exit ${res.status ?? "n/a"})`,
            stderr: String(res.stderr ?? res.error?.message ?? "").slice(-2000),
        });
    }
    return res.stdout;
}

function extractJson(text) {
    const t = String(text).trim();
    try {
        return JSON.parse(t);
    } catch {
        /* the CLI may prefix log lines — fall back to the first..last bracket */
    }
    const s = t.search(/[[{]/);
    const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (s >= 0 && e > s) {
        try {
            return JSON.parse(t.slice(s, e + 1));
        } catch {
            /* unparseable */
        }
    }
    return null;
}

/** Normalize a query result into `{ columns, rows }` or `{ objects }`. */
function normalizeTable(parsed) {
    if (!parsed) return null;
    if (parsed.table && Array.isArray(parsed.table.rows)) {
        return { columns: parsed.table.columns ?? [], rows: parsed.table.rows };
    }
    if (Array.isArray(parsed.rows)) {
        return { columns: parsed.columns ?? [], rows: parsed.rows };
    }
    if (Array.isArray(parsed)) return { objects: parsed };
    if (Array.isArray(parsed.data)) return { objects: parsed.data };
    return null;
}

function shortName(name) {
    const m = String(name).match(/\[([^\]]+)\]/g);
    return m && m.length ? m[m.length - 1].slice(1, -1) : String(name);
}

function coerceNumber(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function mapRows(table, columnsArg) {
    let columns = null;
    if (columnsArg) {
        try {
            columns = JSON.parse(columnsArg);
        } catch (e) {
            die(1, { ok: false, rendered: false, error: `--columns is not valid JSON: ${e.message}` });
        }
    }

    if (table.objects) {
        if (!columns) return table.objects;
        return table.objects.map((r) => {
            const out = {};
            for (const [key, src] of Object.entries(columns)) {
                out[key] = r[src] ?? r[shortName(src)] ?? null;
            }
            return out;
        });
    }

    const cols = table.columns ?? [];
    const indexByName = new Map();
    cols.forEach((c, i) => indexByName.set(c.name ?? String(i), i));
    cols.forEach((c, i) => {
        const s = shortName(c.name ?? String(i));
        if (!indexByName.has(s)) indexByName.set(s, i);
    });
    const isNumeric = (i) => {
        const c = cols[i];
        return c && c.dataType ? NUMERIC_DAX_TYPES.has(String(c.dataType).toLowerCase()) : false;
    };

    const fields = columns
        ? Object.entries(columns).map(([key, src]) => ({
              key,
              index: typeof src === "number" ? src : indexByName.get(src) ?? -1,
          }))
        : cols.map((c, i) => ({ key: shortName(c.name ?? String(i)), index: i }));

    return table.rows.map((row) => {
        const out = {};
        for (const f of fields) {
            if (f.index < 0) {
                out[f.key] = null;
                continue;
            }
            const raw = row[f.index];
            out[f.key] = isNumeric(f.index) ? coerceNumber(raw) : raw;
        }
        return out;
    });
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.spec) {
        usage();
        process.exit(args.help ? 0 : 1);
    }

    let spec = loadSpec(args.spec);
    if (spec && typeof spec === "object" && spec.spec && spec.type === undefined) {
        spec = spec.spec; // tolerate a `{ spec: {...} }` wrapper
    }

    // Inject rows from a live query or a pre-fetched result.
    if (args.query || args.data) {
        let raw;
        if (args.query) {
            if (!args.dax && !args.daxFile) {
                die(1, { ok: false, rendered: false, error: "--query requires --dax or --dax-file" });
            }
            raw = runQuery({ alias: args.query, dax: args.dax, daxFile: args.daxFile, limit: args.limit });
        } else {
            try {
                raw = readInput(args.data);
            } catch (e) {
                die(1, { ok: false, rendered: false, error: `Cannot read --data: ${e.message}` });
            }
        }
        const table = normalizeTable(extractJson(raw));
        if (!table) {
            die(1, {
                ok: false,
                rendered: false,
                error:
                    "Could not parse query output into rows. Expected a fabric-app-data query JSON " +
                    "({table:{columns,rows}}), a {columns,rows} table, or an array of row objects.",
            });
        }
        spec = { ...spec, data: mapRows(table, args.columns) };
    }

    if (!spec || typeof spec.type !== "string") {
        die(1, { ok: false, rendered: false, error: "Spec must be an object with a string `type`." });
    }

    // Validate → auto-repair safe mistakes before rendering.
    let repaired = [];
    const v1 = validateSpec(spec);
    if (!v1.valid) {
        const r = repairSpec(spec);
        repaired = r.applied ?? [];
        spec = r.spec;
        const v2 = validateSpec(spec);
        if (!v2.valid) {
            die(1, {
                ok: false,
                rendered: false,
                type: spec.type,
                error: "Spec is invalid and could not be auto-repaired.",
                errors: v2.errors,
                repaired,
            });
        }
    }

    const lint = (validateSpec(spec).warnings ?? []).map((w) => ({
        rule: w.rule,
        severity: w.severity,
        message: w.message,
        path: w.path,
    }));
    let summary;
    try {
        summary = summarize(spec);
    } catch {
        summary = undefined;
    }

    // Theme parity (only if the author didn't set one).
    let renderSpec = spec;
    if (!args.noTheme && spec.theme === undefined) {
        const theme = readCssTheme(args.theme === "dark" ? "dark" : "light");
        if (theme) renderSpec = { ...spec, theme };
    }

    const fontParity = registerInter();

    let result;
    try {
        result = renderChart(renderSpec, { width: args.width, height: args.height, dpr: args.dpr });
    } catch (e) {
        die(1, { ok: false, rendered: false, type: spec.type, error: `Render failed: ${e.message}` });
    }

    const out = args.out
        ? path.resolve(args.out)
        : path.join(mkdtempSync(path.join(tmpdir(), "graphein-preview-")), `${spec.type}.png`);
    writeFileSync(out, result.png);

    const report = result.report;
    emit({
        ok: report.ok,
        rendered: true,
        type: report.type,
        out,
        theme: args.noTheme ? null : args.theme,
        fontParity,
        dataRows: Array.isArray(renderSpec.data) ? renderSpec.data.length : null,
        logicalSize: { width: args.width, height: args.height },
        pixelSize: { width: result.width, height: result.height },
        marks: report.markCount,
        series: report.seriesCount,
        colors: report.colorCount,
        summary: report.summary ?? summary ?? null,
        diagnostics: report.diagnostics ?? [],
        lint,
        repaired,
    });
    process.exit(0);
}

main();
