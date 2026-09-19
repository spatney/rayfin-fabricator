# Todo App

A polished, Fabric-authenticated todo app built on React + Vite and Rayfin data,
tuned for the **Fabricator** deploy-to-test workflow. Each user gets their
own todos via row-level security on a Rayfin data model — sign in with Microsoft,
add tasks, and they're persisted to Fabric.

> This is a Fabricator template: Fabricator deploys the agent's changes to a
> Fabric test workspace and shows the running app in its built-in browser.
> Its normal agent workflow uses that deployed backend rather than starting
> local servers or a test harness.

## Getting started

In Fabricator, describe what you want to build; Fabricator handles deployment
after the agent's changes. For manual CLI deployment outside that workflow:

```bash
npm run rayfin:up
```

## Documentation

Visit [Rayfin](https://rayfin.ai/) or
[browse the documentation](https://rayfin.ai/docs) for platform guides,
authentication, data modeling, SDK APIs, and limitations.

Coding agents start with [AGENTS.md](AGENTS.md) and use the
[rayfin-web-docs skill](.agents/skills/rayfin-web-docs/SKILL.md) before
Rayfin-specific changes. The skill reads relevant website pages and checks their
SDK/CLI versions against the project instead of copying incompatible examples.

## Project structure

```text
├── AGENTS.md               # Template-specific agent workflow
├── .agents/skills/
│   └── rayfin-web-docs/    # Official docs lookup for Rayfin changes
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
each person only ever sees their own tasks.

Read the entity in the project alongside the official
[modeling guide](https://rayfin.ai/docs/data/modeling) and
[permissions guide](https://rayfin.ai/docs/data/permissions) when extending it.
Keep the entity registered in `rayfin/data/schema.ts` and preserve its
server-side owner policy.

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
