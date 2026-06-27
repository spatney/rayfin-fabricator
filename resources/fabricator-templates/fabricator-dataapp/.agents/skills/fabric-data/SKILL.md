---
name: fabric-data
description: >
  Manage Fabric semantic-model connections with fabric-app-data and query Fabric
  semantic models at runtime with @microsoft/fabric-app-data. Covers fabric.yaml,
  generated TypeScript config, CLI schema/query testing, and essential
  FabricClient/use-semantic-model-query result handling.
---

# Fabric Data — Connections and Runtime Queries

Use this skill when you need to wire a Power BI semantic model, inspect schema, quick-test DAX, or handle query results in the app.

## Fast path

1. Confirm the connection alias in `fabric.yaml`.
2. If no alias exists, add one:
   ```sh
   npx fabric-app-data add <alias> --from-url "<Fabric portal URL>"
   # or, when you have IDs:
   npx fabric-app-data add <alias> -w <workspaceId> -i <itemId>
   ```
   Use `workspaceId: "me"` for My Workspace. The long flags are `--workspace` and `--item`; **do not** use `--workspace-id` or `--item-id`.
3. Regenerate the config:
   ```sh
   npx fabric-app-data generate -o src/fabric.generated.ts
   ```
4. Discover schema or test DAX with the same pipeline the app uses:
   ```sh
   npx fabric-app-data query <alias> --query "EVALUATE INFO.VIEW.TABLES()"
   npx fabric-app-data query <alias> --file src/queries/hero.dax --limit 100
   ```
5. In app code, use the template's query hook; do not hand-edit generated config.

If you only have the workspace + item (dataset) id of the model, wire it with `fabric-app-data add <alias> -w <workspaceId> -i <itemId>`.

## CLI essentials

All commands except `init` walk up from the current directory until they find `fabric.yaml`; run `init` from the project root.

| Command | Use |
|---|---|
| `npx fabric-app-data init [-p <profile>] [--force]` | Create `fabric.yaml` with an active profile. |
| `npx fabric-app-data add <alias> --from-url "<url>"` | Add a semantic model from a Fabric portal URL. |
| `npx fabric-app-data add <alias> -w <workspaceId> -i <itemId>` | Add by explicit IDs. Short flags: `-w`, `-i`; long flags: `--workspace`, `--item`. |
| `npx fabric-app-data remove <alias> [-p <profile>]` | Remove a connection. |
| `npx fabric-app-data list [-p <profile>]` | List connections. |
| `npx fabric-app-data use <profile> [-o <path>]` | Switch active profile and regenerate config. |
| `npx fabric-app-data generate [-p <profile>] [-o src/fabric.generated.ts]` | Generate TypeScript config. |
| `npx fabric-app-data query <alias> --query '<DAX>'` | Execute DAX against a semantic model. Aliases: `execute`, `exec`. |

`query` options:

- `-q, --query <query>` — inline DAX.
- `-f, --file <path>` — `.dax` file.
- `-l, --limit <rows>` — max returned rows; default 1000, max 1000.
- `-p, --profile <name>` — profile; defaults to `activeProfile`.

The CLI caps output at 1000 rows. Trimmed JSON includes `_cliWarning`; refine the DAX with filters or aggregation instead of trying to pull more rows for a visual.

## `fabric.yaml`

```yaml
activeProfile: dev
profiles:
  dev:
    semanticModels:
      sales:
        workspaceId: "00c98f7c-..."
        itemId: "03f2dc11-..."
      myModel:
        workspaceId: "me"
        itemId: "c078a68d-..."
  production:
    semanticModels:
      sales:
        workspaceId: "aabbccdd-..."
        itemId: "11223344-..."
```

Supported URL segments include `semanticmodels`, `modeling`, `lakehouses`, and `warehouses`; semantic-model dashboard work usually needs `semanticModels`.

## Generated contract

`fabric.generated.ts` is auto-generated from the active profile and exports a plain config object:

```ts
export const fabricConfig = {
  semanticModels: {
    sales: {
      workspaceId: "00c98f7c-...",
      itemId: "03f2dc11-...",
    },
  },
} as const;
```

Edit `fabric.yaml`, then regenerate. Never hand-edit `src/fabric.generated.ts`.

## Runtime querying

The template already wires `FabricClient` and exposes `useSemanticModelQuery`; query through that hook unless you are changing plumbing.

```ts
const result = useSemanticModelQuery({ connection, query });

const rows = toChartData(result.data, {
  columns: { Category: "Product[Category]", Revenue: "Revenue" },
});
```

Direct SDK shape, when needed:

```ts
import { FabricClient } from "@microsoft/fabric-app-data";

const client = new FabricClient({ proxy, ...fabricConfig });
const model = client.semanticModel("sales");
const result = await model.query("EVALUATE SUMMARIZECOLUMNS('Product'[Category], \"Revenue\", [Revenue])");

if (result.status === "success") {
  // result.table.columns -> [{ name: "Product[Category]", dataType: "String" }, { name: "Revenue", dataType: "Double" }]
  // result.table.rows    -> [["Bikes", 12345], ["Accessories", 6789]]
} else {
  console.error(result.error.category, result.error.message);
}
```

## Result rules agents must remember

- **Always check `result.status`** when using the SDK result directly; queries never throw.
- Successful queries return one table: `table.columns` metadata and `table.rows` as `unknown[][]`.
- Rows are positional: `rows[i][j]` matches `columns[j]`. Map deliberately before charting.
- Error categories: `query` (bad DAX), `overflow` (unsafe numeric value), `api` (HTTP/Fabric), `network`, `unknown`.
- Date/DateTime values are strings like `"2024-01-15T10:30:00.000"` with **no timezone suffix**. Treat them as timezone-unaware model values.
- Integers outside `Number.MAX_SAFE_INTEGER` return `category: "overflow"` instead of losing precision.

## Caching

Query results are cached in memory by default (LRU, 64 entries). Successes and DAX `query` errors are cached; transient `api`, `network`, and `unknown` errors are not.

```ts
await model.query(dax);                         // cached on repeat
await model.query(dax, { bypassCache: true });  // force fresh
model.clearCache();                             // this model
client.clearCache();                            // all models
```

Disable or tune only when you are changing data plumbing:

```ts
new FabricClient({ proxy, ...fabricConfig, cache: { enabled: true, maxEntries: 64 } });
```

## Minimal types

```ts
type WorkspaceId = "me" | (string & {});
interface FabricItemRef { workspaceId: WorkspaceId; itemId: string }
interface QueryColumn { name: string; dataType: string }
interface QueryTable { columns: QueryColumn[]; rows: unknown[][] }
interface QueryError { category: "api" | "query" | "overflow" | "network" | "unknown"; message: string; code?: string; details?: string }
type QueryResult =
  | { status: "success"; table: QueryTable; requestId: string }
  | { status: "error"; error: QueryError; requestId: string };
type CachedQueryResult = QueryResult & { fromCache: boolean; cachedAt?: Date };
```
