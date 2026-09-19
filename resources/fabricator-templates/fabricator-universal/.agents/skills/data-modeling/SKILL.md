---
name: data-modeling
description: >
  Use when the app needs to store or read data — records, a database, entities,
  CRUD, lists, "save/remember X", or per-user data with row-level security. This
  app's data layer is Rayfin's: you declare entities as TypeScript classes with
  decorators in rayfin/data/, register them in the schema, and read/write them
  through the typed rayfin-client. Covers this template's schema registration,
  client access, and authentication wiring, with official Rayfin references for
  entities, decorators, permissions, queries, and mutations.
  Triggers: data, database, model, entity,
  schema, table, record, CRUD, create, read, update, delete, list, store, save,
  persist, per-user, row-level security, RLS, access control, ownership.
---

# Data modeling — entities, schema, and row-level security

The base template enables `data` with `dialect: mssql` in `rayfin/rayfin.yml`.
Add entity classes under `rayfin/data/`, register them in
`rayfin/data/schema.ts`, and use the existing typed client in
`src/services/rayfinClient.ts`.

**Authenticated access is this template's default.** Pair this pack with the
[authentication skill](../authentication/SKILL.md) for ordinary app records,
per-user data, and row-level security. For explicit anonymous-access requests,
follow the access guidance in `AGENTS.md` and the permissions documentation
before changing that default.

## Rayfin references

Follow the [documentation and version guidance](../../../AGENTS.md#rayfin-documentation)
before implementing the data model. Use the maintained guides rather than
copying generic SDK examples into this skill:

- [Modeling entities](https://rayfin.ai/docs/data/modeling) for decorators,
  field types, relationships, and schema requirements.
- [Querying](https://rayfin.ai/docs/data/querying) for typed reads and pagination.
- [Creating, updating, deleting](https://rayfin.ai/docs/data/mutations) for writes.
- [Permissions and row-level security](https://rayfin.ai/docs/data/permissions)
  for explicit access rules, owner-scoped records, and tenant prerequisites.

For version-matched details, run
`npx rayfin docs search '<topic>' --module guide` from the project root and read
the relevant result. Check the linked agent rules and known limitations before
choosing field constraints or permissions.

## Integrate the model with this template

1. **Check dependencies and service configuration.** The base already includes
   `@microsoft/rayfin-core` and `@microsoft/rayfin-client`. If
   `@microsoft/rayfin-data` is missing, install a version compatible with the
   project's SDK rather than mixing release lines. Confirm `services.data`
   remains enabled with `dialect: mssql` if another pack changed the config.
2. **Define the entities.** Create one class per file under `rayfin/data/`,
   following the modeling guide for the installed version. Declare permissions
   explicitly and follow the documented MSSQL field constraints; do not rely on
   implicit access defaults.
3. **Register every entity.** Update both the `schema` array and
   `UniversalAppSchema` type exported by `rayfin/data/schema.ts`. Keep those
   export names: the existing client imports `UniversalAppSchema` for its type.
4. **Wire authentication for the default data path.** Follow the authentication
   skill to initialize `bootstrapAuth()` and add `AuthProvider` and route guards.
   The existing `getRayfinClient()` throws until bootstrap initializes it.
5. **Reuse the typed client.** Read and write through `getRayfinClient()` using
   the query and mutation guides. For per-user records, derive ownership from
   the signed-in identity and enforce access with server-side entity policies,
   not just UI filters.
6. **Let Fabricator deploy the change.** Its auto-deploy applies the schema and
   ships the frontend; do not run `rayfin up` from the agent.

### Schema registration

For an entity already defined in `rayfin/data/Note.ts`, registration looks like:

```ts
import { Note } from './Note.js';

export type UniversalAppSchema = {
  Note: Note;
};

export const schema = [Note];
```

Import entity modules with the `.js` extension because the data model compiles
as ESM. Keep SDK-specific entity definitions and access policies aligned with
the official, version-compatible documentation rather than expanding this
registration example into another API tutorial.
