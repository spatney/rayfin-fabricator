# Todo App

A polished, Fabric-authenticated todo app built on React + Vite and Rayfin data,
tuned for the **Fabricator** deploy-to-test workflow. Each user gets their
own todos via row-level security on a Rayfin data model — sign in with Microsoft,
add tasks, and they're persisted to Fabric.

> This is a Fabricator template: there is **no local backend, dev server, or
> test harness**. You build your app and deploy it to a Fabric test workspace —
> the Fabricator agent does this for you and validates the running app in its
> built-in browser.

## Getting started

In Fabricator, just describe what you want to build. To deploy from the CLI:

```bash
npm run rayfin:up
```

## Project structure

```text
├── rayfin/
│   ├── rayfin.yml          # Fabric service configuration
│   └── data/
│       ├── schema.ts       # Data schema (registers the Todo entity)
│       └── Todo.ts         # Todo entity with per-user access policy
├── src/
│   ├── main.tsx            # Entry point + Rayfin client bootstrap
│   ├── App.tsx             # Routes and auth gate
│   ├── main.css            # Tailwind theme
│   ├── hooks/
│   │   └── AuthContext.tsx # React context wrapping the auth helpers
│   ├── components/
│   │   └── AuthPage.tsx    # Sign-in UI
│   ├── pages/
│   │   └── HomePage.tsx    # The todo list
│   └── services/
│       ├── IAuthService.ts        # Auth service contract + AuthUser type
│       ├── RayfinAuthService.ts   # Fabric brokered auth
│       ├── rayfinClient.ts        # Typed Rayfin client singleton
│       ├── todos.ts               # Todo CRUD against the Rayfin client
│       └── bootstrap.ts           # Reads env, builds the auth service
└── package.json
```

## The data model

`rayfin/data/Todo.ts` defines a `Todo` entity scoped to the signed-in user, so
each person only ever sees their own tasks:

```typescript
import { entity, role, uuid, text, boolean, date } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', { policy: (claims, item) => claims.sub.eq(item.user_id) })
export class Todo {
  @uuid() id!: string;
  @text({ min: 1, max: 100 }) title!: string;
  @boolean() isCompleted!: boolean;
  @date() createdAt!: Date;
  @text() user_id!: string;
}
```

`src/services/todos.ts` wraps the typed Rayfin client with `getTodos`,
`createTodo`, `updateTodo`, and `deleteTodo`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up`) |
| `npm run lint` | Lint with ESLint |
| `npm run rayfin:up` | Deploy the app to a Fabric test workspace |
| `npm run rayfin:db` | Apply data-model changes to the deployed database |
