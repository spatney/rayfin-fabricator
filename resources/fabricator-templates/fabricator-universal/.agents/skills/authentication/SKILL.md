---
name: authentication
description: >
  Wire the existing Fabric auth into the template's default authenticated data
  workflow, or when the user wants sign-in, accounts, login, protected pages,
  per-user data, or row-level security. The starter is a no-auth "hello world"
  with auth scaffolding already present. This skill covers its AuthProvider,
  bootstrapAuth, routes, sign-in page, and deployment configuration; official
  Rayfin docs cover the underlying platform and SDK.
  Triggers: auth, authentication, sign in, sign-in, login, log in, sign out,
  logout, account, user, identity, protect route, require login, gated page,
  data, database, records, per-user, row-level security, who is the current user,
  Fabric auth, Entra.
---

# Enabling authentication

This starter renders a **no-auth hello-world page** that can preview without a
backend. Enable the existing auth scaffolding for the default `data-modeling`
workflow or features that need sign-in, protected routes, or per-user data. A
static page over public data needs no auth.

## Rayfin references

Follow the [documentation and version guidance](../../../AGENTS.md#rayfin-documentation)
before choosing SDK APIs. Use the official guides for platform behavior:

- [Fabric SSO](https://rayfin.ai/docs/auth/fabric-sso) covers popup and embedded
  flows, deployed-backend requirements, and allowed origins.
- [React integration](https://rayfin.ai/docs/auth/react) covers sessions and route
  guarding.

Adapt those patterns to the existing services below rather than replacing them
with a second client or auth context.

## What's already in the project

| File | Role |
|------|------|
| `src/services/IAuthService.ts` | Auth contract + `AuthUser` type |
| `src/services/RayfinAuthService.ts` | Fabric brokered auth (the real implementation) |
| `src/services/rayfinClient.ts` | Typed Rayfin client singleton |
| `src/services/bootstrap.ts` | Reads env, builds the auth service |
| `src/hooks/AuthContext.tsx` | `AuthProvider` + `useAuth()` |
| `src/components/AuthPage.tsx` | Sign-in UI |

## Wire authentication into this template

1. **Initialize once in `src/main.tsx`.** Import `bootstrapAuth` from
   `@/services/bootstrap` and `AuthProvider` from `@/hooks/AuthContext`. Call
   `bootstrapAuth()` once before rendering, then wrap `<App />` with
   `<AuthProvider authService={authService}>`. The entry file already includes
   this wiring as a commented example.
2. **Gate the intended routes in `src/App.tsx`.** Add an `/auth` route using
   `AuthPage`. Use `useAuth()`'s `loading` and `isAuthenticated` values to wait for
   initialization, redirect signed-out users from protected routes to `/auth`,
   and redirect signed-in users away from the sign-in page. Leave genuinely
   public routes ungated.
3. **Reuse the existing context and client.** Components under `AuthProvider`
   use `useAuth()` for `user`, `signIn`, `signOut`, and loading/error state.
   `AuthPage` already starts sign-in from a button click. Data access uses
   `getRayfinClient()` after bootstrap; do not initialize a second client.
4. **Let Fabricator deploy.** Return the changes for its normal auto-deploy
   workflow. Do not run `rayfin up` or `npm run rayfin:up` from the agent.

## Backend configuration and preview

`bootstrapAuth()` requires `VITE_RAYFIN_API_URL`,
`VITE_RAYFIN_PUBLISHABLE_KEY`, `VITE_FABRIC_WORKSPACE_ID`,
`VITE_FABRIC_ITEM_ID`, and `VITE_FABRIC_PORTAL_URL`. `rayfin env` supplies these
from the active deployment for the build. Keep its explicit errors for missing
configuration; placeholder values do not create a working authenticated backend.

The no-backend preview is for the public starter. Authenticated views need a
deployed **backend**, real environment configuration, and a session. This does
not require every frontend to be hosted in Fabric: the SSO popup flow also
supports a local frontend whose origin is registered in `allowedRedirectUris`.
Only the embedded flow requires the Fabric portal iframe. That platform
capability does not change Fabricator's workflow or authorize starting a dev
server during an agent turn.
