/**
 * What lesson 3 shows of a Rayfin app: its files, its rayfin.yml, its .deployments.json and its
 * .gitignore, and the one line of TypeScript it shows. `npm run lesson:snippets -- 3`
 * type-checks the TypeScript against the real @microsoft/rayfin-* packages; the rest isn't
 * TypeScript, so each piece names where it comes from.
 *
 * Everything was checked against Rayfin 1.36.2 in the scratch app the lesson tools scaffold
 * with the installed CLI (.cache/rayfin-check/1.36.2/app, a Universal App named "app"), and in
 * that CLI's own source. Check it again when the lesson moves to another Rayfin version.
 */
import type { Snippet } from '../../src/show/snippet.ts';

/** The project's name, as in lesson 2. */
export const APP = 'my-app';

export const SNIPPETS = {
  /**
   * The line pk-3 shows: how the data package registers an entity, as the Universal App's
   * data-modeling pack seeds it (.agents/skills/data-modeling/kit/data/schema.ts has
   * `export const schema = [Item];`). A new app's list is empty.
   */
  register: {
    file: 'packages/data/src/index.ts',
    code: `import { Expense } from './Expense.js';

export const schema = [Expense];`,
  },
  /** Lesson 1's entity, so the registration above compiles. */
  expense: {
    file: 'packages/data/src/Expense.ts',
    hidden: true,
    code: `import { date, decimal, entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Expense {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @decimal() amount!: number;
  @date() spentOn!: Date;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
} satisfies Record<string, Snippet>;

/**
 * A new app's rayfin/rayfin.yml, exactly as create-rayfin writes it for the Universal App, with
 * the project named my-app (the scratch app's has `id: app` and `name: app`).
 */
export const RAYFIN_YML = `id: ${APP}
name: ${APP}
version: 1.0.0
services:
  auth:
    enabled: true
    fabric:
      enabled: true
      externalEntraExchange: true
    password:
      enabled: false
    allowedRedirectUris:
      - http://localhost:5173
  data:
    enabled: false
    path: packages/data
    buildCommand: npm run build
  staticHosting:
    enabled: true
    path: packages/frontend
    folder: dist
    buildCommand: npm run build:fabric
    indexDocument: index.html
    assetAccess: protected
    embedded:
      only: false`;

/**
 * What an app adds to rayfin.yml as it grows, from the complete example in
 * https://rayfin.ai/docs/reference/config/rayfin-yml. Storage turns on with
 * `services.storage.enabled: true`, and a secret needs only its name (same page). "…" stands for
 * required keys left out: enabled functions also need `auth.type: application`, and a connector
 * its `type`, `config` and `auth`.
 */
export const GROWN = {
  functions: { yaml: 'functions:\n  enabled: true\n  …', where: 'services' },
  storage: { yaml: 'storage:\n  enabled: true', where: 'services' },
  connectors: { yaml: 'connectors:\n  - name: sales_warehouse\n    …', where: 'a list' },
  secrets: { yaml: 'secrets:\n  - name: STRIPE_API_KEY', where: 'a list' },
} as const;

/** The sample app's address, as in Fabricator's screenshots and lesson 2. */
export const HOSTING_URL = 'https://rusty-cape-195ef2e475-westus.webapp.fabricapps.net';

/** The hosting address as the card shows it: the sample app's, with its ID left out so the line fits. */
const SHOWN_URL = HOSTING_URL.replace('195ef2e475', '…');

/**
 * rayfin/.deployments.json after one deploy to the "Contoso Apps" workspace. The keys, their
 * order and the workspace key come from the CLI (@microsoft/rayfin-cli
 * dist/utils/deployments-registry.js, upsertDeploymentState, which writes `deployments` and then
 * `active`; the key is the workspace's name, lowercased with dashes). The item name defaults to
 * rayfin.yml's id. "…" stands for IDs, keys and links left out.
 */
export const DEPLOYMENTS_JSON = `{
  "deployments": {
    "contoso-apps": {
      "fabricItemId": "…",
      "itemName": "${APP}",
      "fabricApiUrl": "…",
      "fabricWorkspaceId": "…",
      "fabricTenantId": "…",
      "publishableKey": "…",
      "hostingUrl": "${SHOWN_URL}",
      "fabricDeepLink": "…",
      "deployedAt": "2026-10-12T17:42:05.118Z"
    }
  },
  "active": "contoso-apps"
}`;

/**
 * The variables rayfin dev and rayfin up write to rayfin/.env, in the CLI's order
 * (@microsoft/rayfin-tools-common dist/config/env.js, deploymentInfoToPublicEnv).
 */
export const ENV_VARS = ['RAYFIN_PUBLIC_API_URL', 'RAYFIN_PUBLIC_PUBLISHABLE_KEY', 'RAYFIN_PUBLIC_ITEM_ID', 'RAYFIN_PUBLIC_WORKSPACE_ID'] as const;

/** The Universal App's .gitignore, the block that keeps deployment state out of git. */
export const GITIGNORE = `# Generated deployment and environment state
.env.local
rayfin/.env
rayfin/.env.secrets
rayfin/.deployments.json
packages/functions/deploymentdata.json`;

/** What's in a new app's rayfin folder, before and after rayfin dev or rayfin up runs. */
export const RAYFIN_FOLDER = {
  scaffolded: ['rayfin.yml', '.project.json', '.lockfile.json', '.gitignore', 'tsconfig.json'],
  written: ['.env', '.deployments.json'],
} as const;

/**
 * Real files from a new app, for the cold open's flurry (it has 142 outside node_modules), and
 * the package each belongs to. `other` files drift away when the packages form.
 */
export const FLURRY: ReadonlyArray<{ name: string; home: 'frontend' | 'data' | 'shared' | 'rayfin' | 'other' }> = [
  { name: 'App.tsx', home: 'frontend' },
  { name: 'SKILL.md', home: 'other' },
  { name: 'rayfin.yml', home: 'rayfin' },
  { name: 'vite.config.ts', home: 'frontend' },
  { name: 'package.json', home: 'other' },
  { name: 'index.ts', home: 'data' },
  { name: 'Welcome.tsx', home: 'frontend' },
  { name: 'pack.json', home: 'other' },
  { name: 'tsconfig.base.json', home: 'other' },
  { name: 'index.html', home: 'frontend' },
  { name: 'AGENTS.md', home: 'other' },
  { name: 'index.ts', home: 'shared' },
  { name: 'main.tsx', home: 'frontend' },
  { name: '.lockfile.json', home: 'other' },
  { name: 'README.md', home: 'other' },
  { name: 'use-auth.tsx', home: 'frontend' },
  { name: 'SKILL.md', home: 'other' },
  { name: 'global.css', home: 'frontend' },
  { name: '.mcp.json', home: 'other' },
  { name: 'rayfin-client.ts', home: 'frontend' },
  { name: 'SKILL.md', home: 'other' },
  { name: '.gitignore', home: 'other' },
  { name: 'package.json', home: 'data' },
];

/** A new app's top level, for the tree the packages and config chapters share. */
export const TREE = {
  root: `${APP}/`,
  manifest: 'package.json',
  /** The root package.json's workspaces (the scratch app's own). */
  workspaces: '"workspaces": ["packages/*"]',
  packages: ['frontend', 'data', 'shared'] as const,
  /** Added by the functions pack (@microsoft/rayfin-guide getting-started/project-structure.md). */
  later: 'functions',
} as const;

/** Each package's name in the workspace (rayfin.ai/docs/start/project-structure). */
export const PACKAGE_NAMES = {
  frontend: '@rayfin-app/frontend',
  data: '@rayfin-app/data',
  shared: '@rayfin-app/shared',
  functions: '@rayfin-app/functions',
} as const;
