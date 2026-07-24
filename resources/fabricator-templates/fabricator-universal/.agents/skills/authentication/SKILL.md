---
name: authentication
description: >
  Use when the user wants to add sign-in, authentication, login, accounts, user
  identity, protected/gated pages, or per-user data to this app. This starter
  ships as a no-auth "hello world" so it previews with no backend, but the full
  Fabric authentication scaffolding is already in the project — this skill wires
  it back in. Covers: AuthProvider + bootstrapAuth in main.tsx, the route auth
  guard in App.tsx, the sign-in page, sign-out, and the env/deploy requirement.
  Triggers: auth, authentication, sign in, sign-in, login, log in, sign out,
  logout, account, user, identity, protect route, require login, gated page,
  who is the current user, Fabric auth, Entra, per-user data.
---

# Enabling authentication

This starter renders a **no-auth hello-world page** so it previews locally
(`npm run preview`) with no backend. The Fabric auth scaffolding is still in the
project, just not wired into the running app. When the user asks for sign-in,
accounts, protected pages, or per-user data, re-enable it with the steps below.

> Authentication needs a deployed Rayfin backend. `rayfin env` injects the
> `VITE_RAYFIN_*` and `VITE_FABRIC_*` vars at build time from the active
> deployment, and `bootstrapAuth()` throws without them — so once auth is wired
> in, the app must be deployed (`npm run rayfin:up`) to run. `npm run preview`
> (no backend) only works while the app stays no-auth.

## What's already in the project

| File | Role |
|------|------|
| `src/services/IAuthService.ts` | Auth contract + `AuthUser` type |
| `src/services/RayfinAuthService.ts` | Fabric brokered auth (the real implementation) |
| `src/services/rayfinClient.ts` | Typed Rayfin client singleton |
| `src/services/bootstrap.ts` | Reads env, builds the auth service |
| `src/hooks/AuthContext.tsx` | `AuthProvider` + `useAuth()` |
| `src/components/AuthPage.tsx` | Sign-in UI |

## Step 1 — wire the provider in `src/main.tsx`

```tsx
import { createRoot } from 'react-dom/client';

import App from '@/App';
import { AuthProvider } from '@/hooks/AuthContext';
import { bootstrapAuth } from '@/services/bootstrap';

import './main.css';

const authService = bootstrapAuth();

createRoot(document.getElementById('root')!).render(
  <AuthProvider authService={authService}>
    <App />
  </AuthProvider>
);
```

## Step 2 — gate routes in `src/App.tsx`

Add an `AuthGuard` that reads `useAuth()` and redirects unauthenticated users to
the sign-in page, then wrap protected routes with it:

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthPage } from '@/components/AuthPage';
import { useAuth } from '@/hooks/AuthContext';
import { HomePage } from '@/pages/HomePage';

function AuthGuard({
  children,
  requireAuth,
}: {
  children: React.ReactNode;
  requireAuth: boolean;
}) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (requireAuth && !isAuthenticated) return <Navigate to="/auth" replace />;
  if (!requireAuth && isAuthenticated) return <Navigate to="/" replace />;

  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/auth"
          element={
            <AuthGuard requireAuth={false}>
              <AuthPage />
            </AuthGuard>
          }
        />
        <Route
          path="/"
          element={
            <AuthGuard requireAuth={true}>
              <HomePage />
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

## Step 3 — use the session in components

Anywhere under `AuthProvider`, call `useAuth()`:

```tsx
const { user, signOut } = useAuth();
// user?.name, user?.email
// <button onClick={() => void signOut()}>Sign out</button>
```

## Step 4 — deploy

```bash
npm run rayfin:up
```

The Fabricator agent then validates the running app in its built-in browser.
`npm run preview` no longer renders once routes require auth (there's no local
session), so preview only the parts you keep public, or preview before gating.
