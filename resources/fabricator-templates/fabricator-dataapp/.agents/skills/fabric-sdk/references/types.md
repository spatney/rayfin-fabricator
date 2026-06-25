# Fabric SDK — Full Type Reference

## Configuration

```typescript
type WorkspaceId = "me" | (string & {});

interface FabricItemRef {
  workspaceId: WorkspaceId;
  itemId: string;
}

interface FabricConfig {
  semanticModels?: Record<string, FabricItemRef>;
  lakehouses?: Record<string, FabricItemRef>;
  warehouses?: Record<string, FabricItemRef>;
}

interface QueryCacheConfig {
  maxEntries?: number;   // Default: 64
  enabled?: boolean;     // Default: true
}
```

## Query Types

```typescript
interface QueryCacheOptions {
  bypassCache?: boolean;
}
```

## Result Types

```typescript
interface QueryColumn {
  name: string;
  dataType: string;
}

interface QueryTable {
  columns: QueryColumn[];
  rows: unknown[][];
}

interface QueryError {
  category: "api" | "query" | "network" | "unknown";
  message: string;
  code?: string;
  details?: string;
}

type QueryResult =
  | { status: "success"; tables: QueryTable[]; requestId: string }
  | { status: "error"; error: QueryError; requestId: string };

type CachedQueryResult = QueryResult & {
  fromCache: boolean;
  cachedAt?: Date;
};
```

## Client Classes

```typescript
class FabricClient {
  constructor(config: FabricClientConfig);
  semanticModel(alias: string): SemanticModelClient;
  clearCache(): void;
}

class SemanticModelClient {
  query(
    dax: string,
    options?: QueryCacheOptions,
  ): Promise<CachedQueryResult>;
  clearCache(): void;
}
```
