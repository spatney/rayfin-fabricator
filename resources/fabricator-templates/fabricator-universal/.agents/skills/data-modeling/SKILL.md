---
name: data-modeling
description: >
  Use when the app needs to store or read data — records, a database, entities,
  CRUD, lists, "save/remember X", or per-user data with row-level security. This
  app's data layer is Rayfin's: you declare entities as TypeScript classes with
  decorators in rayfin/data/, register them in the schema, and read/write them
  through the typed rayfin-client. Covers: defining an @entity, field decorators,
  registering it, per-entity access with @role, owner-only row-level security,
  and the client query/mutation API. Triggers: data, database, model, entity,
  schema, table, record, CRUD, create, read, update, delete, list, store, save,
  persist, per-user, row-level security, RLS, access control, ownership.
---

# Data modeling — entities, schema, and row-level security

This app persists data with **Rayfin data**. You define entities as decorated
TypeScript classes under `rayfin/data/`, register them in
`rayfin/data/schema.ts`, and read/write them with the typed client from
`src/services/rayfinClient.ts` (`getRayfinClient()`).

The `data` service is already enabled in `rayfin/rayfin.yml`
(`data: { enabled: true, dialect: mssql }`), so you don't need to turn anything
on — just add entities.

> **Data means auth — wire it in.** Rayfin data is always accessed as an
> **authenticated user** (there's no anonymous/public data access on Fabric — see
> Notes). So adding data isn't complete until authentication is wired in: follow
> the **`authentication`** skill (`AuthProvider` + `bootstrapAuth()` in
> `src/main.tsx`, the route guard in `src/App.tsx`). Per-user rows and row-level
> security key off the signed-in identity. Only a purely **static page over
> public data** (no Rayfin data) can skip auth.

## Step 1 — install the data package

```bash
npm install @microsoft/rayfin-data
```

(`@microsoft/rayfin-core` — which provides the decorators — and
`@microsoft/rayfin-client` are already in the base app.)

## Step 2 — define an entity

Create one file per entity under `rayfin/data/`, e.g. `rayfin/data/Note.ts`:

```ts
import { entity, role, text, boolean, date, uuid } from '@microsoft/rayfin-core';

@entity()
export class Note {
  @uuid() id!: string;
  @text({ min: 1, max: 200 }) title!: string;
  @text() body!: string;
  @boolean() pinned!: boolean;
  @date() createdAt!: Date;
}
```

Common field decorators: `@uuid()`, `@text({ min, max })`, `@boolean()`,
`@date()`, plus number/relation decorators. If you're unsure of a decorator or
option, check the docs: `rayfin docs search '<topic>' --module guide`.

## Step 3 — register it in the schema

`rayfin/data/schema.ts` starts empty. Add each entity to the exported `schema`
array and the schema type so the client is typed:

```ts
import { Note } from './Note.js';

export type UniversalAppSchema = {
  Note: Note;
};

export const schema = [Note];
```

> Import entities with the `.js` extension (`'./Note.js'`) — Rayfin compiles the
> data model as ESM. The client's generic type comes from
> `UniversalAppSchema` (already referenced by `src/services/rayfinClient.ts`).

## Step 4 — read and write with the client

```ts
import { getRayfinClient } from '@/services/rayfinClient';

const client = getRayfinClient();

// query
const notes = await client.data.Note
  .select(['id', 'title', 'body', 'pinned', 'createdAt'])
  .orderBy({ createdAt: 'desc' })
  .execute();

// create / update / delete
const note = await client.data.Note.create({ title, body, pinned: false, createdAt: new Date() });
await client.data.Note.update({ id }, { pinned: true });
await client.data.Note.delete({ id });
const one = await client.data.Note.findById(id);
```

## Row-level security (owner-only data)

When the user wants "each person sees only their own …", first turn on
**authentication** (see the `authentication` skill), then add an owner column and
a `@role` policy so the platform enforces access **server-side**:

```ts
import { entity, role, text, boolean, date, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Note {
  @uuid() id!: string;
  @text({ min: 1, max: 200 }) title!: string;
  @text() body!: string;
  @boolean() pinned!: boolean;
  @date() createdAt!: Date;
  @text() user_id!: string;
}
```

- `@role('authenticated', '*', { policy })` grants all operations (`'*'`) to
  authenticated users, but the `policy` restricts each row to its owner —
  `claims.sub` (the signed-in user id) must equal the row's `user_id`.
- Stamp `user_id` from the session on create:

  ```ts
  const session = client.auth.getSession();
  if (!session.isAuthenticated || !session.user) throw new Error('Not signed in.');
  await client.data.Note.create({ /* … */, user_id: session.user.id });
  ```

Row-level security is enforced by Rayfin on the server — the client can't read or
write another user's rows regardless of what the UI does.

## Notes

- **Stable features only.** Use `@authenticated` / `@role('authenticated', …)`;
  don't reach for experimental anonymous/public access (it doesn't deploy on
  Fabric). If asked for public data, say so and use authenticated access.
- Fabricator auto-deploys after your turn — don't run `rayfin up`. A data-model
  change ships and migrates on that deploy.
