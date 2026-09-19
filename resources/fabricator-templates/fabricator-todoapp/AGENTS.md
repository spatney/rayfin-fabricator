# Todo App agent guide

Work in the existing Fabric-authenticated React + Vite app. It already has
sign-in, a typed Rayfin client, and per-user todo records; do not scaffold a
replacement app or a second auth/client layer.

## Read Rayfin documentation before SDK changes

For Rayfin APIs, data, authentication, configuration, or troubleshooting, read
and follow the [rayfin-web-docs skill](.agents/skills/rayfin-web-docs/SKILL.md)
before making changes. It starts at the
[official documentation index](https://rayfin.ai/llms.txt), reads relevant
Markdown guides, and reconciles them with the project's installed versions.
Purely visual changes do not need a Rayfin web lookup.

Use [rayfin.ai](https://rayfin.ai/) for platform explanations and the generated
Rayfin skill, project-local MCP, or `npx rayfin docs` for version-matched APIs.
Do not let a generic website example override this template's workflow rules.

## Existing integration points

| File | Role |
| --- | --- |
| `rayfin/data/Todo.ts` | Todo entity and server-side owner policy |
| `rayfin/data/schema.ts` | `TodoAppSchema` type and `schema` array |
| `src/services/rayfinClient.ts` | Shared typed client |
| `src/services/todos.ts` | Existing todo queries and mutations |
| `src/services/bootstrap.ts` | Deployment configuration and auth initialization |
| `src/hooks/AuthContext.tsx` | `AuthProvider` and `useAuth()` |
| `src/main.tsx` / `src/App.tsx` | Auth is already wired and routes are guarded |

Keep schema registration, the shared client, and the server-side per-user
access policy consistent as the model grows. Do not substitute UI filtering for
entity permissions or remove authentication just to make a preview work.

## Fabricator workflow

- Make the requested changes without enabling unrelated services or integrations.
- Fabricator owns deployment after your turn. Do not run `rayfin up`,
  `npm run rayfin:up`, or `npm run rayfin:db` yourself.
- Do not start dev servers, a local backend, or local test runners. Static
  checks such as `npm run build:fabric` and `npm run lint` are appropriate.
- Authenticated behavior needs a deployed backend and real configuration; use
  Fabricator's preview rather than inventing credentials or mock success.
- Finish with a brief summary of the changes; Fabricator handles the deploy.
