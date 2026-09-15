# Analytics npm modules

`pack.json` is the machine-readable source of truth — `npm run pack:add --
analytics` installs exactly what's below. This file explains it.

## How versions are reconciled

The **base template owns the shared toolchain** — `react`, `react-dom`, `vite`,
`typescript`, `eslint`, `tailwindcss`, `@tailwindcss/vite`,
`@vitejs/plugin-react-swc`, `graphein`, and the `@microsoft/rayfin-*` core. The
analytics pack therefore **only adds the packages the dashboard kit needs**,
pinned to versions that agree with the base. Enabling analytics doesn't bump or
re-resolve the base toolchain, so the install is small and fast — only the
net-new packages, served from Fabricator's **warm offline package cache**.

If you enable analytics by hand instead of `pack:add`, add only these — don't
change the base toolchain versions.

## Dependencies (analytics-only)

- `@fontsource-variable/inter`: `^5.2.8`
- `@fontsource-variable/jetbrains-mono`: `^5.2.8`
- `@fontsource-variable/space-grotesk`: `^5.2.10`
- `@microsoft/fabric-app-data`: `1.1.0`
- `@microsoft/fabric-app-data-embed-client`: `1.0.0`
- `@microsoft/fabric-app-data-proxy`: `1.0.0`
- `@microsoft/rayfin-data`: `^1.33.2`
- `@microsoft/rayfin-lib`: `^1.33.2`
- `clsx`: `^2.1.1`
- `framer-motion`: `^12.40.0`
- `tailwind-merge`: `^3.6.0`

## devDependencies (analytics-only)

- `@graphein/node`: `>=0.16.0` — headless render for `npm run preview`
- `@microsoft/fabric-app-data-cli`: `1.1.0` — `fabric-app-data generate` in `build:fabric`
- `@microsoft/fabric-app-data-cli-proxy`: `1.0.0`
- `@microsoft/rayfin-mcp`: `^1.33.2`

## Not included

`lucide-react`, `react-error-boundary`, and `rollup-plugin-license` are **not**
installed: nothing in `kit/**` imports or references them (the kit ships its own
`components/dashboard/icons.tsx` and error states). Leaving them out keeps the
install lean. Add them back only if you introduce code that needs them.
