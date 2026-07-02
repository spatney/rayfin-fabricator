# Contributing to Fabricator

Thanks for your interest in contributing to Fabricator. This is a personal, free-time project maintained by Sachin Patney (GitHub [@spatney](https://github.com/spatney)). The author works at Microsoft, but this is **not** a Microsoft product and is not affiliated with, endorsed by, or supported by Microsoft. Maintenance is best-effort.

Repository: https://github.com/spatney/rayfin-fabricator

## What this project is

Fabricator is a Windows desktop app for building "Rayfin apps" via chat. It uses Tauri v2 with a Rust backend and a React 18 + TypeScript renderer built with Vite. It wraps the GitHub Copilot CLI for authoring and the Rayfin CLI (`rayfin up`) for deploy, preview, debug, and validation on Microsoft Fabric.

You author locally, but deploy, preview, debug, and validate remotely on Microsoft Fabric.

## Prerequisites

- Windows 10/11 with the WebView2 runtime
- Node.js 20+ and npm
- Rust stable with MSVC and the Tauri prerequisites
- Git
- Rayfin CLI and GitHub Copilot CLI available locally, for example through `npx rayfin` and the Copilot CLI

## Development setup

1. Clone the repository.
2. Install dependencies with `npm ci`.
3. Start the app with `npm run dev`.

## Useful scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Runs the Tauri app with the Vite renderer. |
| `npm run build` | Builds the NSIS installer. |
| `npm run dev:renderer` | Runs the renderer development server. |
| `npm run build:renderer` | Builds the renderer. |
| `npm run typecheck` | Runs TypeScript type checking. |
| `npm run lint` | Runs lint checks. |
| `npm run format` | Formats code with Prettier. |

## Verification before opening a PR

Please run:

```powershell
npm run typecheck
npm run lint
npm run build:renderer
```

If you changed Rust code, also run Cargo from `src-tauri`:

```powershell
cd src-tauri
& "$env:USERPROFILE\.cargo\bin\cargo.exe" check
```

Cargo may not be on `PATH`, so the explicit path above is often safest on Windows.

## Project layout

- `src-tauri/` - Rust/Tauri backend.
  - `src/commands/` - IPC handlers.
  - `src/services/` - exec, preview, store, and telemetry services.
  - `vendor/wry/` - vendored `wry` crate with a one-line WebView2 device-compliance SSO patch.
- `src/renderer/` - React + TypeScript UI.
  - `screens/` - top-level renderer screens.
  - `components/` - reusable UI components.
- `src/shared/ipc.ts` - shared IPC types.
- `docs/` - project docs, including `DEPLOY.md` and `VENDORED-WRY-PATCH.md`.
- `analytics/` - Application Insights KQL.

## Coding conventions

- Keep changes focused and surgical.
- Use TypeScript with the existing ESLint and Prettier setup.
- Run `npm run format` for formatting.
- Rust code uses 2-space indentation.
- Do not include secrets in source code.

## Commit and PR conventions

- Commit messages should be concise, imperative, sentence-case, and have no type prefix.
- Open PRs against https://github.com/spatney/rayfin-fabricator.
- Link related issues where possible.
- Include screenshots or notes for UI changes.
- Update docs when behavior, setup, or release steps change.

## Vendored wry patch

The vendored `wry` crate includes a one-line WebView2 device-compliance SSO patch. If Tauri is upgraded and brings in a new `wry`, the patch must be re-applied. See `docs/VENDORED-WRY-PATCH.md` before changing Tauri or `wry`.

## Releases

Pushing a version tag drives `.github/workflows/release.yml`. The release workflow builds the NSIS installer and injects the Application Insights connection string from the `APPINSIGHTS_CONNECTION_STRING` GitHub Actions secret into `resources/telemetry.json` at build time.

`deploy.ps1` is a maintainer-only script that provisions Azure Application Insights and sets that secret.

### Code signing (maintainers)

Release installers are signed with **Azure Trusted Signing** (a.k.a. Azure Artifact Signing) when the required GitHub Actions settings are present. The release workflow signs both the app executable and the NSIS installer through Tauri's `signCommand` and [`artifact-signing-cli`](https://github.com/Levminer/trusted-signing-cli). When the signing credentials are absent (forks, PR builds), the installer is still produced — just unsigned — so contributors never need a certificate to build.

To enable signing, set the following on the repository (**Settings → Secrets and variables → Actions**):

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_SIGNING_CLIENT_ID` | App registration (client) ID |
| Secret | `AZURE_SIGNING_CLIENT_SECRET` | App registration client secret |
| Secret | `AZURE_SIGNING_TENANT_ID` | Directory (tenant) ID |
| Variable | `AZURE_SIGNING_ENDPOINT` | Region endpoint, e.g. `https://eus.codesigning.azure.net` |
| Variable | `AZURE_SIGNING_ACCOUNT` | Trusted Signing account name |
| Variable | `AZURE_SIGNING_CERT_PROFILE` | Certificate profile name |

The app registration's service principal needs the **Artifact Signing Certificate Profile Signer** role on the signing account. Signing removes the "Unknown Publisher" prompt immediately; Microsoft SmartScreen still builds per-certificate reputation over time, so brand-new releases may show a SmartScreen prompt until enough downloads accrue.

## Issues and pull requests

Please file issues and pull requests at https://github.com/spatney/rayfin-fabricator.
