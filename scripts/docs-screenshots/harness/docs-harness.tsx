// Renders app components with sample data for screens that are hard to reach in a live
// instance (team workspaces, error dialogs, update prompts). Copied into a checkout's
// src/renderer by capture-harness.ps1; it is never part of the app build.
//
// Open /docs-harness.html?shot=<id>[&theme=light]. Every value here is sample data.
import '@vscode/codicons/dist/codicon.css'
import './assets/main.css'
import { useEffect, useState, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import type {
  AuthStatus,
  ByokModelInfo,
  ByokStatus,
  ChatPlanArtifact,
  CopilotModel,
  DoctorReport,
  FabricCapacitiesResult,
  FabricWorkspace,
  FileNode,
  MigrationInspectedPage,
  MigrationPage,
  MigrationReportItem,
  MigrationState,
  MigrationWorkspace,
  RayfinVersionInfo,
  ReportInspection,
  SecretsState,
  SkillInfo,
  StudioProject,
  TeamEnvStatus,
  TeamOwnersResult,
  TeamReposResult,
  TeamResourceRequest,
  TeamSessionStatus,
  ToolStatus,
  WorkspaceDataItem,
  WorkspaceModel
} from '@shared/ipc'
import { OverlayProvider } from './overlay'
import { ToastProvider } from './toast'
import { applyTheme } from './theme'
import SetupScreen from './screens/SetupScreen'
import { HelpView } from './components/help/HelpView'
import TeamMapView from './components/team/map/TeamMapView'
import { sampleMap, sampleResources, sampleRun, sampleWorkspace } from './components/team/map/fixtures'
import TeamPublishControl from './components/team/TeamPublishControl'
import CreateTeamWorkspaceModal from './components/team/CreateTeamWorkspaceModal'
import RayfinVersionControl from './components/RayfinVersionControl'
import PortConflictModal from './components/PortConflictModal'
import PlanCard from './components/PlanCard'
import SkillsView from './components/SkillsView'
import SecretsView from './components/SecretsView'
import DeployStage from './components/DeployStage'
import PreviewPane from './components/PreviewPane'
import DeploymentsControl from './components/DeploymentsControl'
import AccountMenu from './components/AccountMenu'
import AccountsModal from './components/AccountsModal'
import SettingsModal from './components/SettingsModal'
import BlueprintTab from './components/blueprint/BlueprintTab'
import { ModelPicker } from './components/models/ModelPicker'
import { AddMenu } from './components/chat/ComposerMenus'
import { DataTray } from './components/chat/DataTray'
import ConnectDataModal from './components/ConnectDataModal'
import MigrateReportScreen from './components/migrate/MigrateReportScreen'
import MigrationCard from './components/migrate/MigrationCard'
import type { DataSource } from './fabricData'
import type { ModelSelection } from './modelSelection'
import './components/chat/chat.css'

const ok = <T,>(value: T) => (): Promise<T> => Promise.resolve(value)

/** A Copilot model for the pickers. */
const copilotModel = (
  id: string,
  name: string,
  vendor: string,
  more: Partial<CopilotModel> = {}
): CopilotModel => ({
  id,
  name,
  vendor,
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  category: 'versatile',
  vision: true,
  ...more
})

/** A model on the user's own API key, as the pickers list it. */
const keyModel = (provider: string, providerName: string, id: string, name: string, vendor: string): CopilotModel => ({
  id: `${provider}/${id}`,
  name,
  vendor,
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  vision: true,
  byok: { provider, providerName, ready: true }
})

/** Copilot's models in its order, then the sample user's Anthropic and OpenAI models. */
const sampleModels: CopilotModel[] = [
  copilotModel('claude-sonnet-5.5', 'Claude Sonnet 5.5', 'Anthropic', {
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    contextTiers: [
      { tier: 'default', tokens: 200_000 },
      { tier: 'long_context', tokens: 1_000_000 }
    ]
  }),
  copilotModel('gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI', {
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    contextTiers: [
      { tier: 'default', tokens: 400_000 },
      { tier: 'long_context', tokens: 1_050_000 }
    ]
  }),
  copilotModel('claude-opus-5.5', 'Claude Opus 5.5', 'Anthropic', {
    category: 'powerful',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'high'
  }),
  copilotModel('gpt-6-astra', 'GPT-6 Astra', 'OpenAI', { category: 'powerful' }),
  copilotModel('gemini-4-argon', 'Gemini 4 Argon', 'Google'),
  copilotModel('claude-haiku-5.5', 'Claude Haiku 5.5', 'Anthropic', { category: 'lightweight' }),
  copilotModel('gpt-6-luna', 'GPT-6 Luna', 'OpenAI', { category: 'lightweight' }),
  copilotModel('grok-4.7', 'Grok 4.7', 'xAI'),
  copilotModel('mai-code-2-flash', 'MAI Code 2 Flash', 'Microsoft', { category: 'lightweight' }),
  copilotModel('gemini-3.8-flash', 'Gemini 3.8 Flash', 'Google', { category: 'lightweight' }),
  copilotModel('gpt-6-sol', 'GPT-6 Sol', 'OpenAI'),
  copilotModel('claude-sonnet-5', 'Claude Sonnet 5', 'Anthropic'),
  keyModel('anthropic', 'Anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic'),
  keyModel('anthropic', 'Anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Anthropic'),
  keyModel('openai', 'OpenAI', 'gpt-6-astra', 'GPT-6 Astra', 'OpenAI')
]

/** A model an Anthropic key can use, as Accounts lists it. */
const anthropicModel = (id: string, name: string, recommended: boolean, created: number): ByokModelInfo => ({
  id,
  name,
  contextWindow: id.includes('haiku') ? 200_000 : 1_000_000,
  maxOutput: 64_000,
  vision: true,
  efforts: ['low', 'medium', 'high', 'max'],
  deprecated: false,
  recommended,
  created
})

/** The sample user's providers: an Anthropic key saved, no OpenAI, xAI or Google key yet. */
const sampleByok: ByokStatus = {
  supported: true,
  store: 'Windows Credential Manager',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      description: 'Claude models',
      keyUrl: 'https://platform.claude.com/settings/keys',
      keyPrefix: 'sk-ant-',
      hasKey: true,
      models: [
        anthropicModel('claude-opus-5-5', 'Claude Opus 5.5', true, 5),
        anthropicModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', true, 4),
        anthropicModel('claude-haiku-5-5', 'Claude Haiku 5.5', true, 3),
        anthropicModel('claude-opus-5', 'Claude Opus 5', false, 2),
        anthropicModel('claude-sonnet-5', 'Claude Sonnet 5', false, 1)
      ],
      enabled: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      checkedAt: new Date().toISOString()
    },
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'GPT models',
      keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
      keyPrefix: 'sk-',
      hasKey: false,
      models: [],
      enabled: []
    },
    {
      id: 'xai',
      name: 'xAI',
      description: 'Grok models',
      keyUrl: 'https://console.x.ai/team/default/api-keys',
      keyPrefix: 'xai-',
      hasKey: false,
      models: [],
      enabled: []
    },
    {
      id: 'google',
      name: 'Google',
      description: 'Gemini and Gemma models',
      keyUrl: 'https://aistudio.google.com/apikey',
      keyPrefix: 'AIza',
      hasKey: false,
      models: [],
      enabled: []
    }
  ]
}

const tool = (id: string, name: string, version: string): ToolStatus => ({
  id: id as ToolStatus['id'],
  name,
  found: true,
  satisfied: true,
  version,
  installHint: '',
  autoInstallable: true,
  required: true
})

const builtIn = (id: string, title: string, description: string, category: string, active = false): SkillInfo => ({
  id,
  title,
  description,
  icon: '',
  base: false,
  active,
  category
})
const inApp = (id: string, title: string, description: string, promotable = true): SkillInfo => ({
  id,
  title,
  description,
  icon: '🧩',
  base: false,
  active: true,
  custom: true,
  ...(promotable ? { promotable: true } : {})
})

/** The Skills tab of the sample app (a Universal App project). */
const skills: SkillInfo[] = [
  { id: 'rayfin', title: 'Rayfin essentials', description: 'Core Rayfin knowledge: data models, sign-in, deploys and the CLI.', icon: '◆', base: true, active: true },
  { id: 'rayfin-functions', title: 'Rayfin Functions', description: 'Server-side functions your app can call.', icon: 'λ', base: true, active: true },
  { id: 'rayfin-connectors', title: 'Rayfin Connectors', description: 'Use existing Fabric data: lakehouses, warehouses, SQL databases, semantic models and KQL.', icon: '⇄', base: true, active: true },
  builtIn('polished-ui', 'Polished, modern UI', 'A clean, consistent look: spacing, type, color and components that match.', 'Look & feel', true),
  builtIn('buttery-animations', 'Buttery animations', 'Quick, purposeful motion that never gets in the way.', 'Look & feel'),
  builtIn('responsive-layout', 'Responsive on every screen', 'Layouts that work on phones, tablets and wide desktops.', 'Look & feel', true),
  builtIn('easy-navigation', 'Easy navigation', 'Clear menus and page titles, and links you can share.', 'Experience'),
  builtIn('clear-copy', 'Clear, friendly wording', 'Plain-language labels, buttons, messages and empty states.', 'Experience'),
  builtIn('loading-empty-states', 'Loading & empty states', 'Every screen handles loading, empty, error and success.', 'Experience'),
  builtIn('friendly-forms', 'Friendly forms & validation', 'Forms that guide people, check input early and never lose it.', 'Experience', true),
  builtIn('search-and-filter', 'Search, sort & filter', 'Find records fast in long lists, with filtering done in the query.', 'Data'),
  builtIn('data-viz', 'Beautiful charts & dashboards', 'The right chart for each question, with the key numbers first.', 'Data'),
  builtIn('accessibility', 'Accessible to everyone', 'Works with a keyboard and screen readers, with readable contrast.', 'Quality'),
  builtIn('secure-by-default', 'Secure by default', 'Per-user data rules, signed-in pages and no secrets in the browser.', 'Quality', true),
  builtIn('performance', 'Fast & snappy', 'Quick to load and smooth to use as the app grows.', 'Quality'),
  { id: 'contoso-brand', title: 'Contoso brand', description: 'Our colors, logo use and tone of voice.', icon: '🎨', base: false, active: true, custom: true, library: true },
  inApp('capability-router', 'Capability router', 'START HERE at the beginning of essentially every build request in this universal Rayfin app.'),
  inApp('data-modeling', 'Data modeling', 'Use when the app needs to store or read data: records, a database, entities, lists, or per-user data with row-level security.', false),
  inApp('authentication', 'Enabling authentication', 'Wire the existing Fabric auth into the template’s default authenticated data workflow.'),
  inApp('graphein-visuals', 'Graphein visuals', 'Use when adding a chart, graph, plot, KPI, table, or any data visualization to this app.'),
  inApp('app-design', 'App Design', 'Use when building or modifying the app layout, UI components, or making any visual design decisions.'),
  inApp('rayfin-web-docs', 'Rayfin web documentation', 'Use before implementing or troubleshooting Rayfin-specific behavior.')
]

const secureSkill = `---
name: secure-by-default
description: "Keep the app's data and users safe by default. Use when adding sign-in, entities, permissions, sharing or admin features, or anything that reads or writes people's data. Triggers: security, secure, permissions, access control, row-level security, RLS, policy, private data, owner, sign in, authentication, authorization, secrets, API key, admin, sharing, roles"
metadata:
  author: Fabricator
  version: 1.0.0
---
# Secure by default

Assume any request can come from anyone. The browser can't enforce security; Rayfin's data rules can.

## Data access
- Give every entity explicit role rules. Start closed: grant \`@authenticated()\` access with a row-level policy, and add \`@anonymous()\` access only for data that's meant to be public.
- For per-user data, store the owner (such as \`user_id\`) and scope reads and writes with a policy like \`claims.sub.eq(item.user_id)\`.
- Hiding a button or a page isn't protection. Anything the UI prevents must also be prevented by a policy.

## Sign-in
- Pages that show or change personal data require sign-in.
`

/** Selects the skill card whose name starts with `title` once the list has loaded. */
function SelectSkill({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const id = window.setTimeout(() => {
      const cards = [...document.querySelectorAll<HTMLButtonElement>('.skl-card-main')]
      cards.find((card) => card.textContent?.startsWith(title))?.click()
    }, 500)
    return () => window.clearTimeout(id)
  }, [title])
  return <>{children}</>
}

/** The sample app's function secrets (names and dates only: values are never shown). */
const secrets: SecretsState = {
  status: 'ready',
  functionsEnabled: true,
  rayfinVersion: '1.36.2',
  secrets: [
    {
      name: 'OPENAI_API_KEY',
      description: 'Summarizes expense notes',
      declared: true,
      stored: true,
      createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString()
    },
    {
      name: 'SLACK_WEBHOOK_URL',
      description: 'Posts approved expenses to #finance',
      declared: true,
      stored: false
    },
    {
      name: 'STRIPE_SECRET_KEY',
      description: 'Reimburses approved expenses',
      declared: true,
      stored: true,
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString()
    }
  ]
}

/** Selects the secret row named `name` once the list has loaded. */
function SelectSecret({ name, children }: { name: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const id = window.setTimeout(() => {
      const rows = [...document.querySelectorAll<HTMLButtonElement>('.sec-row')]
      rows.find((row) => row.textContent?.startsWith(name))?.click()
    }, 500)
    return () => window.clearTimeout(id)
  }, [name])
  return <>{children}</>
}

/* Blueprint: the sample app's files, as Blueprint reads them, and what Fabric says about them. */

const FINANCE_WS = '11111111-1111-4111-8111-111111111111'
const FINANCE_WAREHOUSE = '22222222-2222-4222-8222-222222222222'
const SPEND_MODEL = '33333333-3333-4333-8333-333333333333'
const BUDGETS_MODEL = '44444444-4444-4444-8444-444444444444'
const APPS_WS = '55555555-5555-4555-8555-555555555555'
const EXPENSES_ITEM = '66666666-6666-4666-8666-666666666666'
const EXPENSES_URL = 'https://contoso-expenses-1a2b3c4d5e-westus.webapp.fabricapps.net'

/**
 * Contoso Expenses: a website with sign-in, four tables, file storage, two connectors to
 * Finance analytics, two semantic models in fabric.yaml, and four functions that reach
 * Fabric, Azure and a receipt-reading web API.
 */
const expensesFiles: Record<string, string> = {
  'rayfin/rayfin.yml': `id: contoso-expenses
name: Contoso Expenses
version: 1.0.0
services:
  auth:
    enabled: true
    fabric:
      enabled: true
    allowedRedirectUris:
      - http://localhost:5173
      - ${EXPENSES_URL}
  data:
    enabled: true
    dialect: mssql
  staticHosting:
    enabled: true
    folder: dist
    assetAccess: protected
  functions:
    enabled: true
    auth:
      type: application
  storage:
    enabled: true
connectors:
  - name: finance-warehouse
    type: fabric-warehouse
    config:
      workspaceId: ${FINANCE_WS}
      itemId: ${FINANCE_WAREHOUSE}
    auth:
      type: application
    operations:
      - name: read
  - name: spend-model
    type: fabric-semanticmodel
    version: '1'
    config:
      workspaceId: ${FINANCE_WS}
      itemId: ${SPEND_MODEL}
    auth:
      type: delegated
secrets:
  - name: RECEIPT_OCR_KEY
    description: Key for the receipt reader
`,
  'fabric.yaml': `activeProfile: default
profiles:
  default:
    semanticModels:
      spend:
        workspaceId: ${FINANCE_WS}
        itemId: ${SPEND_MODEL}
      budgets:
        workspaceId: ${FINANCE_WS}
        itemId: ${BUDGETS_MODEL}
`,
  'rayfin/data/schema.ts': `import { Category } from './Category.js'
import { Expense } from './Expense.js'
import { Receipt } from './Receipt.js'
import { Report } from './Report.js'
export const schema = [Expense, Report, Receipt, Category]
`,
  'rayfin/data/Expense.ts': `import { entity, authenticated, uuid, text, decimal, date, one } from '@microsoft/rayfin-core'
import { Category } from './Category.js'
import { Report } from './Report.js'
@entity()
@authenticated('*', { policy: (q, claims) => q.where('owner_id', claims.sub) })
export class Expense {
  @uuid() id!: string
  @text() owner_id!: string
  @decimal() amount!: number
  @date() spentAt!: Date
  @one(() => Category) category!: Category
  @one(() => Report) report!: Report
}
`,
  'rayfin/data/Report.ts': `import { entity, anonymous, uuid, text } from '@microsoft/rayfin-core'
@entity()
@anonymous('read')
export class Report {
  @uuid() id!: string
  @text() title!: string
}
`,
  'rayfin/data/Receipt.ts': `import { entity, authenticated, uuid, text, one } from '@microsoft/rayfin-core'
import { Expense } from './Expense.js'
@entity()
@authenticated('*', { policy: (q, claims) => q.where('owner_id', claims.sub) })
export class Receipt {
  @uuid() id!: string
  @text() owner_id!: string
  @text() fileName!: string
  @one(() => Expense) expense!: Expense
}
`,
  'rayfin/data/Category.ts': `import { entity, authenticated, uuid, text } from '@microsoft/rayfin-core'
@entity()
@authenticated('read')
export class Category {
  @uuid() id!: string
  @text() name!: string
}
`,
  'rayfin/functions/src/function_app.ts': `import { AudienceType, UserDataFunctions, type RayfinContext } from '@microsoft/fabric-user-data-functions'
import type { AppSchema } from '../../data/schema.js'

const udf = new UserDataFunctions()

udf.func(
  'summarizeReport',
  async (ctx: RayfinContext<AppSchema, AudienceType.AzureAI>): Promise<string> => ctx.Tokens.AzureAI,
  []
)

udf.func('syncBudgets', async (ctx: RayfinContext<AppSchema, AudienceType.Sql | AudienceType.Fabric>) => 1, [])

udf.func('archiveReceipts', async (ctx: RayfinContext<AppSchema, AudienceType.Storage>) => ctx.Tokens.Storage, [])

udf.func(
  'readReceipt',
  async (ctx: RayfinContext<AppSchema>, image: string) => {
    const res = await fetch('https://api.mindee.net/v1/products/mindee/expense_receipts/v5/predict', {
      method: 'POST',
      headers: { Authorization: 'Token ' + ctx.Secrets.RECEIPT_OCR_KEY },
      body: image
    })
    return res.json()
  },
  []
)
`
}

const OWNER_POLICY = `@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})`

/**
 * Contoso Expenses as a Universal App, with expenses filed in reports and tagged through a
 * join entity: the Data model view's relationship lines. The entities are the ones Learn
 * Rayfin with Ray's lesson 5 shows (scripts/videos/lessons/05-relationships/snippets.ts).
 */
const relationsFiles: Record<string, string> = {
  'rayfin/rayfin.yml': `id: contoso-expenses
name: Contoso Expenses
version: 1.0.0
services:
  auth:
    enabled: true
    fabric:
      enabled: true
  data:
    enabled: true
    dialect: mssql
    path: packages/data
    buildCommand: npm run build
  staticHosting:
    enabled: true
    path: packages/frontend
    folder: dist
    buildCommand: npm run build:fabric
    assetAccess: protected
`,
  'packages/data/src/index.ts': `import { Expense } from './Expense.js';
import { ExpenseTag } from './ExpenseTag.js';
import { Report } from './Report.js';
import { Tag } from './Tag.js';

export { Expense, ExpenseTag, Report, Tag };
export const schema = [Expense, Report, Tag, ExpenseTag];
`,
  'packages/data/src/Expense.ts': `import { date, decimal, entity, one, role, set, text, uuid } from '@microsoft/rayfin-core';
import { Report } from './Report.js';

@entity()
${OWNER_POLICY}
export class Expense {
  @uuid() id!: string;
  @date() spentOn!: Date;
  @decimal({ min: 0 }) amount!: number;
  @set('Travel', 'Meals', 'Software', 'Office')
  category!: 'Travel' | 'Meals' | 'Software' | 'Office';
  @text({ optional: true, max: 500 }) note?: string;
  @date() createdAt!: Date;
  @one(() => Report, { optional: true }) report?: Report;
  @text({ max: 200 }) owner_id!: string;
}
`,
  'packages/data/src/Report.ts': `import { entity, many, role, text, uuid } from '@microsoft/rayfin-core';
import { Expense } from './Expense.js';

@entity()
${OWNER_POLICY}
export class Report {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @many(() => Expense) expenses?: Expense[];
  @text({ max: 200 }) owner_id!: string;
}
`,
  'packages/data/src/Tag.ts': `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
${OWNER_POLICY}
export class Tag {
  @uuid() id!: string;
  @text({ max: 50 }) name!: string;
  @text({ max: 200 }) owner_id!: string;
}
`,
  'packages/data/src/ExpenseTag.ts': `import { entity, one, role, text, uuid } from '@microsoft/rayfin-core';
import { Expense } from './Expense.js';
import { Tag } from './Tag.js';

@entity()
${OWNER_POLICY}
export class ExpenseTag {
  @uuid() id!: string;
  @uuid() expense_id!: string;
  @one(() => Expense) expense!: Expense;
  @uuid() tag_id!: string;
  @one(() => Tag) tag!: Tag;
  @text({ max: 200 }) owner_id!: string;
}
`
}

/**
 * The same app with Report's permission decorator left out: the Data model view's access dots and
 * Harden, as Learn Rayfin with Ray's lesson 6 shows them (`model-access`).
 */
const accessFiles: Record<string, string> = {
  ...relationsFiles,
  'packages/data/src/Report.ts': relationsFiles['packages/data/src/Report.ts']
    .replace(`${OWNER_POLICY}\n`, '')
    .replace('entity, many, role, text', 'entity, many, text')
}

/** The sample app's files a shot reads: the Universal App with related entities for the Data model shots. */
const SHOT_FILES: Record<string, Record<string, string>> = { 'model-relations': relationsFiles, 'model-access': accessFiles }
const projectFiles: Record<string, string> =
  SHOT_FILES[new URLSearchParams(location.search).get('shot') ?? ''] ?? expensesFiles

/** The project's file tree holding `paths`, as `projects.files.tree` returns it. */
function fileTree(paths: string[]): FileNode[] {
  const root: FileNode[] = []
  for (const path of paths) {
    let level = root
    const parts = path.split('/')
    parts.forEach((name, i) => {
      const at = parts.slice(0, i + 1).join('/')
      const leaf = i === parts.length - 1
      let node = level.find((n) => n.path === at)
      if (!node) {
        node = leaf ? { name, path: at, type: 'file' } : { name, path: at, type: 'dir', children: [] }
        level.push(node)
      }
      level = node.children ?? []
    })
  }
  return root
}

/** The workspaces the sample app (Contoso Apps) and its data (Finance analytics) live in. */
const expensesWorkspaces: FabricWorkspace[] = [
  { id: APPS_WS, displayName: 'Contoso Apps', type: 'Workspace', sku: 'F8', region: 'West US', capacityKind: 'fabric', eligible: true },
  { id: FINANCE_WS, displayName: 'Finance analytics', type: 'Workspace', sku: 'F64', region: 'West US 2', capacityKind: 'fabric', eligible: true }
]

/** Semantic models by workspace id. */
const workspaceModels: Record<string, WorkspaceModel[]> = {
  [FINANCE_WS]: [
    { id: SPEND_MODEL, name: 'Spend analysis' },
    { id: BUDGETS_MODEL, name: 'Budgets 2026' }
  ]
}

/** What Add Fabric data finds in each workspace, by name (the Finance warehouse and both
 *  semantic models are already connected to the sample app). */
const workspaceData: Record<string, WorkspaceDataItem[]> = {
  [FINANCE_WS]: [
    { id: BUDGETS_MODEL, name: 'Budgets 2026', type: 'SemanticModel' },
    { id: FINANCE_WAREHOUSE, name: 'Finance warehouse', type: 'Warehouse' },
    { id: 'a1111111-1111-4111-8111-111111111111', name: 'Ledger', type: 'SQLDatabase' },
    { id: 'a2222222-2222-4222-8222-222222222222', name: 'Raw transactions', type: 'Lakehouse' },
    { id: SPEND_MODEL, name: 'Spend analysis', type: 'SemanticModel' },
    { id: 'a3333333-3333-4333-8333-333333333333', name: 'Vendor payments', type: 'Lakehouse' }
  ],
  [APPS_WS]: [{ id: 'a4444444-4444-4444-8444-444444444444', name: 'Contoso Expenses', type: 'SQLDatabase' }]
}

/** Every workspace the sample user can open, for Add Fabric data. */
const dataWorkspaces: FabricWorkspace[] = [
  ...expensesWorkspaces,
  { id: 'b1111111-1111-4111-8111-111111111111', displayName: 'Marketing', type: 'Workspace', sku: 'F8', region: 'West US', capacityKind: 'fabric', eligible: true },
  { id: 'b2222222-2222-4222-8222-222222222222', displayName: 'Operations', type: 'Workspace', sku: 'F16', region: 'West US', capacityKind: 'fabric', eligible: true },
  { id: 'b3333333-3333-4333-8333-333333333333', displayName: 'Sales insights', type: 'Workspace', sku: 'F64', region: 'West US 2', capacityKind: 'fabric', eligible: true }
]

/** What the connect-data shot picks, as chips in the composer waiting for the next message. */
const pickedData: DataSource[] = [
  { workspaceId: FINANCE_WS, workspaceName: 'Finance analytics', item: workspaceData[FINANCE_WS][2] },
  { workspaceId: FINANCE_WS, workspaceName: 'Finance analytics', item: workspaceData[FINANCE_WS][3] }
]

/* Migrate a Power BI report: the sample user's Power BI workspaces and the Sales performance report. */

const SALES_WS = 'c1111111-1111-4111-8111-111111111111'
const SALES_REPORT = 'c2222222-2222-4222-8222-222222222222'
const SALES_MODEL = 'c3333333-3333-4333-8333-333333333333'

/** The workspaces the Azure CLI's account can open, My workspace first, as Fabricator lists them. */
const migrationWorkspaces: MigrationWorkspace[] = [
  { id: 'c0000000-0000-4000-8000-000000000000', name: 'My workspace', personal: true },
  { id: APPS_WS, name: 'Contoso Apps', personal: false, capacityId: 'd1111111-1111-4111-8111-111111111111' },
  { id: FINANCE_WS, name: 'Finance analytics', personal: false, capacityId: 'd2222222-2222-4222-8222-222222222222' },
  { id: 'b1111111-1111-4111-8111-111111111111', name: 'Marketing', personal: false },
  { id: 'b2222222-2222-4222-8222-222222222222', name: 'Operations', personal: false },
  { id: SALES_WS, name: 'Sales analytics', personal: false, capacityId: 'd2222222-2222-4222-8222-222222222222' }
]

/** Power BI reports by workspace id, by name. */
const migrationReports: Record<string, MigrationReportItem[]> = {
  [SALES_WS]: [
    { id: 'c4444444-4444-4444-8444-444444444444', name: 'Customer insights', workspaceId: SALES_WS },
    { id: SALES_REPORT, name: 'Sales performance', workspaceId: SALES_WS },
    { id: 'c5555555-5555-4555-8555-555555555555', name: 'Sales targets 2026', workspaceId: SALES_WS },
    { id: 'c6666666-6666-4666-8666-666666666666', name: 'Store operations', workspaceId: SALES_WS }
  ],
  [FINANCE_WS]: [
    { id: 'c7777777-7777-4777-8777-777777777777', name: 'Budget vs actuals', workspaceId: FINANCE_WS },
    { id: 'c8888888-8888-4888-8888-888888888888', name: 'Spend overview', workspaceId: FINANCE_WS }
  ]
}

const salesPages: MigrationInspectedPage[] = ['Overview', 'Regions', 'Products', 'Customers', 'Store details'].map(
  (displayName, order) => ({ name: `ReportSection${order + 1}`, displayName, order })
)

/** What Fabricator can read of Sales performance: everything, so it can be migrated. */
const salesInspection: ReportInspection = {
  ok: true,
  report: {
    id: SALES_REPORT,
    name: 'Sales performance',
    workspaceId: SALES_WS,
    workspaceName: 'Sales analytics',
    personal: false,
    format: 'PBIR',
    reportType: 'PowerBIReport'
  },
  model: { id: SALES_MODEL, name: 'Sales model', workspaceId: SALES_WS, workspaceName: 'Sales analytics' },
  pages: salesPages,
  checks: {
    definition: { status: 'ok', message: 'Pages, visuals, fields and filters can be read.' },
    model: { status: 'ok', message: 'Copilot can query “Sales model” live.' },
    images: { status: 'ok', message: 'Pages can be exported to PDF for Copilot to look at.' }
  }
}

/** A report page's preview, as the Migration card shows it: shapes only, on a white page. */
function pageThumb(shapes: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
    '<rect width="320" height="180" fill="#ffffff"/><rect x="12" y="10" width="110" height="9" rx="2" fill="#252423"/>' +
    shapes +
    '</svg>'
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const panel = (x: number, y: number, w: number, h: number): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#f3f2f1"/>`

const kpiRow = (count: number): string =>
  Array.from({ length: count }, (_, i) => {
    const w = (296 - (count - 1) * 8) / count
    const x = 12 + i * (w + 8)
    return `${panel(x, 28, w, 30)}<rect x="${x + 6}" y="34" width="${w * 0.5}" height="8" rx="1" fill="#252423"/><rect x="${x + 6}" y="46" width="${w * 0.35}" height="5" rx="1" fill="#a19f9d"/>`
  }).join('')

const columns = (x: number, y: number, w: number, h: number, values: number[], color: string): string =>
  values
    .map((v, i) => {
      const step = w / values.length
      return `<rect x="${x + i * step + step * 0.2}" y="${y + h * (1 - v)}" width="${step * 0.6}" height="${h * v}" fill="${color}"/>`
    })
    .join('')

const bars = (x: number, y: number, w: number, h: number, values: number[], color: string): string =>
  values
    .map((v, i) => {
      const step = h / values.length
      return `<rect x="${x}" y="${y + i * step + step * 0.2}" width="${w * v}" height="${step * 0.6}" fill="${color}"/>`
    })
    .join('')

const trend = (x: number, y: number, w: number, h: number, values: number[], color: string): string =>
  `<polyline fill="none" stroke="${color}" stroke-width="3" points="${values
    .map((v, i) => `${x + (i * w) / (values.length - 1)},${y + h * (1 - v)}`)
    .join(' ')}"/>`

const rows = (x: number, y: number, w: number, count: number): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="9" fill="#118dff"/>` +
  Array.from({ length: count }, (_, i) => `<rect x="${x}" y="${y + 13 + i * 11}" width="${w}" height="6" rx="1" fill="${i % 2 ? '#e1dfdd' : '#edebe9'}"/>`).join('')

/** The five pages of Sales performance, as the export draws them. */
const salesThumbs = [
  pageThumb(
    kpiRow(4) +
      panel(12, 66, 144, 104) +
      columns(18, 76, 132, 86, [0.55, 0.7, 0.62, 0.85, 0.78, 0.95], '#118dff') +
      panel(164, 66, 144, 104) +
      trend(172, 80, 128, 78, [0.3, 0.45, 0.4, 0.62, 0.58, 0.8, 0.9], '#12239e')
  ),
  pageThumb(panel(12, 28, 140, 142) + bars(20, 36, 120, 126, [0.95, 0.8, 0.66, 0.5, 0.38, 0.25], '#e66c37') + panel(160, 28, 148, 142) + rows(168, 38, 132, 9)),
  pageThumb(
    panel(12, 28, 180, 142) +
      '<rect x="20" y="36" width="96" height="126" fill="#118dff"/><rect x="120" y="36" width="64" height="70" fill="#12239e"/>' +
      '<rect x="120" y="110" width="64" height="52" fill="#e66c37"/>' +
      panel(200, 28, 108, 142) +
      columns(206, 40, 96, 120, [0.9, 0.7, 0.55, 0.4], '#6b007b')
  ),
  pageThumb(
    kpiRow(3) +
      panel(12, 66, 120, 104) +
      '<circle cx="72" cy="118" r="34" fill="none" stroke="#118dff" stroke-width="16" stroke-dasharray="120 214"/>' +
      '<circle cx="72" cy="118" r="34" fill="none" stroke="#e66c37" stroke-width="16" stroke-dasharray="60 214" stroke-dashoffset="-120"/>' +
      '<circle cx="72" cy="118" r="34" fill="none" stroke="#12239e" stroke-width="16" stroke-dasharray="34 214" stroke-dashoffset="-180"/>' +
      panel(140, 66, 168, 104) +
      rows(148, 74, 152, 7)
  ),
  pageThumb(kpiRow(2) + panel(12, 66, 296, 104) + rows(20, 74, 280, 7))
]

/** Sales performance's migration once its first page is done: the next one waits for you. */
const salesMigration: MigrationState = {
  version: 1,
  dir: '.fabricator/migration/sales-performance',
  alias: 'salesModel',
  source: {
    reportId: SALES_REPORT,
    reportName: 'Sales performance',
    workspaceId: SALES_WS,
    workspaceName: 'Sales analytics',
    personal: false,
    format: 'PBIR',
    modelId: SALES_MODEL,
    modelName: 'Sales model',
    modelWorkspaceId: SALES_WS,
    modelWorkspaceName: 'Sales analytics'
  },
  stages: {
    definition: { status: 'done' },
    model: { status: 'done' },
    export: { status: 'done' },
    images: { status: 'done' }
  },
  pages: salesPages.map(
    (p, i): MigrationPage => ({
      ...p,
      kind: i === 4 ? 'drillthrough' : 'page',
      hidden: i === 4,
      stem: `0${i + 1}-${p.displayName.toLowerCase().replace(/\s+/g, '-')}`,
      thumb: salesThumbs[i],
      status: i === 0 ? 'done' : 'pending'
    })
  ),
  pdfs: ['export-1.pdf'],
  warnings: [],
  startedAt: '',
  dismissed: false
}

/** Creating a team workspace: one GitHub account with every permission it needs, and Azure signed in. */
const teamEnv: TeamEnvStatus = {
  enabled: true,
  ghInstalled: true,
  ghSignedIn: true,
  ghUser: 'averychen',
  ghMissingScopes: [],
  ghCanDeleteRepos: false,
  ghAccounts: [
    { login: 'averychen', active: true, signedIn: true, missingScopes: [], canDeleteRepos: false }
  ],
  azSignedIn: true,
  azUser: 'avery.chen@contoso.com'
}

/** Where averychen can create the team's repository. */
const teamOwners: TeamOwnersResult = {
  ok: true,
  owners: [
    { login: 'averychen', isOrg: false },
    { login: 'contoso', isOrg: true, canCreate: true }
  ]
}

/** Repositories offered for an existing-repository setup. */
const teamRepos: TeamReposResult = {
  ok: true,
  repos: [{ fullName: 'contoso/finance-apps', description: 'Apps for the finance team' }]
}

/** The Fabric capacities averychen can create the team's workspaces on. */
const teamCapacities: FabricCapacitiesResult = {
  ok: true,
  capacities: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      displayName: 'contoso-f2',
      sku: 'F2',
      region: 'West US',
      kind: 'fabric',
      eligible: true
    },
    {
      id: '88888888-8888-4888-8888-888888888888',
      displayName: 'contoso-f64',
      sku: 'F64',
      region: 'West US 2',
      kind: 'fabric',
      eligible: true
    }
  ]
}

/** `window.api` with sample responses; anything not listed resolves to undefined. */
function installApi(): void {
  const api = {
    openExternal: ok(undefined),
    // The model pickers' lists: Copilot's models, then the ones on your own API keys.
    chat: {
      listModels: ok(sampleModels),
      // Auto's "Optimized for" choices come from Copilot, per account; the sample has none.
      autoTiers: ok(null)
    },
    byok: {
      status: ok(sampleByok)
    },
    // Accounts: the sample user's one account in each service.
    github: {
      accounts: ok({ ghInstalled: true, accounts: [{ login: 'averychen', active: true, signedIn: true }] })
    },
    accounts: {
      fabric: ok({
        accounts: [{ id: 'a1', user: 'avery.chen@contoso.com', tenant: 'contoso.com', active: true, shared: true }],
        sharedTokenStore: false
      }),
      azure: ok({
        azInstalled: true,
        accounts: [
          {
            user: 'avery.chen@contoso.com',
            tenant: 'contoso.com',
            tenantName: 'Contoso',
            subscription: 'Contoso Apps',
            active: true
          }
        ]
      })
    },
    // The native preview surface: every call is a no-op, so a pane renders without one.
    preview: {},
    skills: {
      list: ok(skills),
      source: (_project: string, id: string) =>
        Promise.resolve({
          ok: true,
          installed: true,
          content: id === 'secure-by-default' ? secureSkill : `---\nname: ${id}\ndescription: "Sample."\n---\n# ${id}\n`
        })
    },
    secrets: {
      list: ok(secrets)
    },
    projects: {
      // Settings shows where new projects go.
      state: ok({ workspaceRoot: 'C:\\Users\\avery\\RayfinProjects', activeProjectId: null, projects: [] }),
      files: {
        read: (_project: string, path: string) =>
          Promise.resolve(
            path in projectFiles
              ? { path, size: projectFiles[path].length, content: projectFiles[path] }
              : { path, size: 0, error: 'Not found' }
          ),
        tree: ok(fileTree(Object.keys(projectFiles)))
      }
    },
    fabric: {
      listWorkspaces: ok({ ok: true, workspaces: expensesWorkspaces }),
      listWorkspaceModels: (workspaceId: string) =>
        Promise.resolve({ ok: true, models: workspaceModels[workspaceId.toLowerCase()] ?? [] }),
      listWorkspaceData: (workspaceId: string) =>
        Promise.resolve({ ok: true, items: workspaceData[workspaceId.toLowerCase()] ?? [] }),
      projectSemanticModels: ok([
        { alias: 'spend', workspaceId: FINANCE_WS, itemId: SPEND_MODEL },
        { alias: 'budgets', workspaceId: FINANCE_WS, itemId: BUDGETS_MODEL }
      ])
    },
    deploy: {
      // The sample app's one deployment, deployed a couple of hours ago.
      list: () =>
        Promise.resolve([
          {
            workspaceName: 'Contoso Apps',
            name: 'Development',
            active: true,
            workspaceId: APPS_WS,
            itemId: EXPENSES_ITEM,
            hostingUrl: EXPENSES_URL,
            deployedAt: new Date(Date.now() - 2 * 3_600_000).toISOString()
          }
        ])
    },
    // Migrate a Power BI report: read with the sample user's Azure CLI sign-in.
    migration: {
      workspaces: ok({ ok: true, workspaces: migrationWorkspaces, account: { user: 'avery.chen@contoso.com', domain: 'contoso.com' } }),
      reports: (workspaceId: string) => Promise.resolve({ ok: true, reports: migrationReports[workspaceId] ?? [] }),
      search: ok({ ok: true, reports: [] }),
      inspect: ok(salesInspection)
    },
    team: {
      map: ok(sampleMap()),
      resources: (_id: string, requests: TeamResourceRequest[]) =>
        Promise.resolve({ ok: true, sources: sampleResources(requests) }),
      members: ok({
        ok: true,
        canManage: true,
        members: [
          { login: 'averychen', role: 'owner', pending: false },
          { login: 'amy', role: 'member', pending: false },
          { login: 'bo', role: 'member', pending: true, invitationId: 7 }
        ]
      }),
      health: ok({ ok: true, items: [{ id: 'pipeline', label: 'The pipeline is up to date', state: 'ok', repairable: false }] }),
      fabricAccess: ok({ ok: true, people: [] }),
      diff: ok({ ok: true, truncated: false, files: [] }),
      envStatus: ok(teamEnv),
      owners: ok(teamOwners),
      repos: ok(teamRepos),
      capacities: ok(teamCapacities),
      onProgress: () => () => {}
    },
    help: {
      grounding: ok(groundedHelp),
      prepare: ok(groundedHelp),
      loadHistory: ok(helpConversation),
      saveHistory: ok(undefined),
      clearHistory: ok(undefined),
      cancel: ok(undefined),
      onEvent: () => () => {},
      ask: ok({ text: '', actions: [], citations: [], elapsedMs: 0 })
    }
  }
  const fallback = (target: Record<string, unknown>): unknown =>
    new Proxy(target, {
      get(obj, key: string) {
        if (key in obj) {
          const value = obj[key]
          return value && typeof value === 'object' ? fallback(value as Record<string, unknown>) : value
        }
        if (key.startsWith('on')) return () => () => {}
        return () => Promise.resolve(undefined)
      }
    })
  ;(window as unknown as { api: unknown }).api = fallback(api)
}

const project: StudioProject = {
  id: 'p1',
  name: 'Trip Logger',
  path: 'C:/team/trips/trips',
  addedAt: '',
  team: { workspaceId: sampleWorkspace.id, folder: 'trips', worktree: 'C:/team/trips' }
} as StudioProject

const teamStatus: TeamSessionStatus = {
  ok: true,
  branch: 'fabricator/averychen/trips-20261003-225801',
  unpublished: 2,
  dirty: false,
  behind: 1,
  conflicted: false,
  requireReview: true,
  view: 'preview',
  preview: { environment: 'preview/trips/averychen', state: 'success', url: 'https://example.invalid/trips' },
  production: { environment: 'production/trips', state: 'success', url: 'https://example.invalid/trips' }
} as TeamSessionStatus

const rayfinUpdate: RayfinVersionInfo = {
  version: '1.35.1',
  latest: '1.36.2',
  upgradeAvailable: true,
  packages: [
    { name: '@microsoft/rayfin-cli', kind: 'cli', installed: '1.35.1', latest: '1.36.2', upgradable: true },
    { name: '@microsoft/rayfin-core', kind: 'sdk', installed: '1.35.1', latest: '1.36.2', upgradable: true },
    { name: '@microsoft/rayfin-client', kind: 'sdk', installed: '1.35.1', latest: '1.36.2', upgradable: true }
  ]
}

const noop = (): void => {}
const noopAsync = (): Promise<void> => Promise.resolve()

const plan: ChatPlanArtifact = {
  id: 'plan-contoso-approvals',
  phase: 'review',
  summary:
    'I found the expense model, dashboard, and form flow. This plan adds manager approval without changing how Avery Chen submits expenses.',
  content: [
    '# Add manager approvals',
    '',
    '## Plan',
    '',
    '1. Add an approval status, approver, and decision comment to `Expense`.',
    '2. Update the expense list so pending, approved, and rejected items are easy to scan.',
    '3. Allow only managers to approve or reject an expense with a comment.',
    '4. Add Approve and Reject buttons to each pending expense.',
    '5. Show pending approvals on the dashboard for managers.'
  ].join('\n'),
  actions: ['interactive', 'autopilot', 'autopilot_fleet', 'exit_only'],
  recommendedAction: 'autopilot_fleet',
  todos: [
    {
      id: 'expense-status',
      title: 'Add status, approver, and decision comment fields to Expense',
      status: 'pending'
    },
    {
      id: 'manager-permissions',
      title: 'Let only managers approve or reject expenses',
      status: 'pending'
    },
    {
      id: 'approval-actions',
      title: 'Add Approve and Reject buttons with a comment',
      status: 'pending'
    },
    {
      id: 'dashboard-queue',
      title: 'Show pending approvals on the dashboard',
      status: 'pending'
    },
    {
      id: 'sample-data',
      title: 'Seed Contoso Expenses with realistic approval examples',
      status: 'pending'
    }
  ],
  dependencies: [
    { todoId: 'manager-permissions', dependsOn: 'expense-status' },
    { todoId: 'approval-actions', dependsOn: 'manager-permissions' },
    { todoId: 'dashboard-queue', dependsOn: 'approval-actions' },
    { todoId: 'sample-data', dependsOn: 'expense-status' }
  ],
  questions: []
}

/** A completed setup: every tool installed, both accounts connected. */
const setupDoctor: DoctorReport = {
  ready: true,
  tools: [
    tool('node', 'Node.js', '24.13.0'),
    tool('npm', 'npm', '11.16.0'),
    tool('git', 'Git', '2.49.0'),
    tool('az', 'Azure CLI', '2.83.0'),
    { ...tool('gh', 'GitHub CLI (gh)', '2.95.0'), required: false }
  ]
}

const setupAuth: AuthStatus = {
  copilot: { signedIn: true, user: 'averychen', host: 'github.com' },
  rayfin: { signedIn: true, user: 'avery.chen@contoso.com' },
  az: { signedIn: true, user: 'avery.chen@contoso.com' }
}

const groundedHelp = {
  sourceReady: true,
  docsReady: true,
  notesReady: true,
  reference: 'v1.11.0',
  pinned: true
}

/**
 * One finished Help exchange: a deploy that failed, diagnosed from the journal
 * and the docs, with the button that fixes it. `savedAt` is empty so the shot
 * doesn't show the "picking up where you left off" seam.
 */
const helpConversation = {
  savedAt: '',
  data: [
    {
      id: 'ask-1',
      question: 'why did my deploy fail?',
      attachments: [],
      answer:
        'Your Fabric sign-in expired part way through the deploy, so Fabricator could not upload the app.\n\n' +
        'The deploy stopped with "The access token has expired". Contoso Expenses is still running on the version you deployed on Tuesday — nothing was lost.\n\n' +
        '1. In the account menu, select **Refresh Fabric authentication** and finish signing in.\n' +
        '2. In the app bar, select **Redeploy**.\n\n' +
        'If it stops again at the same point, the workspace may no longer be assigned to a Fabric capacity. ' +
        'See [Deploy problems](https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/deploy).',
      tools: [
        { id: 't1', name: 'read', title: 'Read the activity journal', status: 'done' },
        { id: 't2', name: 'grep', title: 'Searched the documentation for "access token has expired"', status: 'done' },
        { id: 't3', name: 'read', title: 'Read troubleshooting/deploy', status: 'done' }
      ],
      actions: [{ id: 'refresh-fabric-auth', label: 'Refresh Fabric authentication' }],
      citations: [
        {
          title: 'Deploy problems',
          url: 'https://spatney.github.io/rayfin-fabricator/docs/troubleshooting/deploy'
        }
      ],
      status: 'done',
      elapsedMs: 6300
    }
  ]
}

/** Clicks `selector` once the shot has rendered, to open a menu or popover. */
function Open({ selector, children }: { selector: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const id = window.setTimeout(() => document.querySelector<HTMLElement>(selector)?.click(), 300)
    return () => window.clearTimeout(id)
  }, [selector])
  return <>{children}</>
}

/**
 * Clicks each selector in turn once the shot has rendered (a menu, then a list in it), then
 * takes the focus off, so the capture shows no caret or focus ring.
 */
function Steps({ clicks, children }: { clicks: string[]; children: ReactNode }): JSX.Element {
  const key = clicks.join('|')
  useEffect(() => {
    const selectors = key.split('|')
    const timers = selectors.map((selector, i) =>
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(selector)?.click()
        if (i === selectors.length - 1) {
          window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 250)
        }
      }, 300 + i * 400)
    )
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [key])
  return <>{children}</>
}

/** The Build chat's composer, chat-wide beside an empty preview, with its model picker
 *  (and any Fabric data waiting to go with the next message, or a banner above it, such as
 *  a report migration's card). */
function ComposerPicker({
  value,
  data,
  banner,
  project = 'Contoso Expenses'
}: {
  value: ModelSelection
  data?: DataSource[]
  banner?: ReactNode
  project?: string
}): JSX.Element {
  const [selection, setSelection] = useState(value)
  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '720px 1fr' }}>
      <div className="chat" style={{ justifyContent: 'flex-end' }}>
        <div className="composer">
          {banner}
          <div className="composer-box">
            {data && <DataTray sources={data} onOpen={noop} onRemove={noop} />}
            <div className="composer-input-sizer" data-replicated-value="">
              <textarea
                className="composer-input"
                rows={1}
                placeholder={
                  data
                    ? 'Say what to build with this data, or just press Enter to connect it'
                    : `Message Fabricator about ${project}…`
                }
                readOnly
              />
            </div>
            <div className="composer-actions">
              <div className="composer-left">
                <AddMenu
                  locked={false}
                  attaching={false}
                  onImage={noop}
                  onConnectData={noop}
                  onReferenceFile={noop}
                />
                <ModelPicker value={selection} disabled={false} onChange={setSelection} tiers onManageKeys={noop} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ borderLeft: '1px solid var(--border)', background: 'var(--bg-elev)' }} />
    </div>
  )
}

/**
 * Add Fabric data: the sample app deploys to Contoso Apps and connected data from Finance
 * analytics an hour ago, so both are recent. The shot opens Finance analytics, where the app
 * already connects three items, and picks a SQL database and a lakehouse.
 */
function ConnectDataShot(): JSX.Element {
  useState(() => {
    localStorage.setItem('fabricator.data.workspaces', JSON.stringify([{ id: FINANCE_WS, at: Date.now() - 3_600_000 }]))
    const api = window.api as unknown as { fabric: Record<string, unknown> }
    api.fabric.listWorkspaces = ok({ ok: true, workspaces: dataWorkspaces })
    return null
  })
  return (
    <Steps clicks={['.cd-ws-list button:nth-of-type(1)', '.cd-items li:nth-child(3) input', '.cd-items li:nth-child(4) input']}>
      <ConnectDataModal
        project={expensesApp}
        appWorkspaces={[{ workspace: APPS_WS, at: Date.now() - 2 * 3_600_000 }]}
        onClose={noop}
        onAdd={noop}
      />
    </Steps>
  )
}

/**
 * Settings, with its Theme set to the capture's theme. `experiments` opens Experiments and
 * scrolls it into view, the way the Team workspaces docs show it.
 */
function SettingsShot({ experiments = false }: { experiments?: boolean }): JSX.Element {
  useEffect(() => {
    const body = (): HTMLElement | null => document.querySelector<HTMLElement>('.settings-body')
    // Experiments ends at the bottom of the dialog's body, with Diagnostics above it. Placed
    // again when the body resizes: headless Edge sizes the window for the capture afterwards.
    const place = (): void => {
      const card = document.querySelector<HTMLElement>('.set-expander')
      const b = body()
      if (experiments && b && card) {
        b.scrollTop += card.getBoundingClientRect().bottom - (b.getBoundingClientRect().bottom - 20)
      }
    }
    const resized = new ResizeObserver(place)
    const open = window.setTimeout(() => {
      if (experiments) document.querySelector<HTMLElement>('.set-expander-head')?.click()
    }, 300)
    const settle = window.setTimeout(() => {
      place()
      const b = body()
      if (b) resized.observe(b)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }, 900)
    return () => {
      window.clearTimeout(open)
      window.clearTimeout(settle)
      resized.disconnect()
    }
  }, [experiments])
  const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
  return (
    <SettingsModal
      settings={{ theme, experiments: { teamWorkspaces: false } }}
      versions={{ app: '1.21.0', tauri: '2.11.3', webview2: '154.0.4258.62', copilot: '1.0.96' }}
      onChange={noop}
      onClose={noop}
      onManageAccounts={noop}
      onManageKeys={noop}
      onReviewSetup={noop}
    />
  )
}

/** Accounts, scrolled to Model providers: an Anthropic key saved, OpenAI's key being added. */
function ModelProvidersShot(): JSX.Element {
  return (
    <Steps clicks={['[aria-label="Add your OpenAI API key"]']}>
      <AccountsModal
        auth={setupAuth}
        onAuthChanged={noop}
        fabric={{
          busy: false,
          signingIn: false,
          signingOut: false,
          canRefresh: false,
          onSignIn: noop,
          onSignOut: noop,
          onRefresh: noop
        }}
        modelProviders={{ focus: true }}
        onReviewSetup={noop}
        onClose={noop}
      />
    </Steps>
  )
}

/**
 * Types `text` into the input that shows `placeholder` once it renders, then takes the focus
 * off it, so the capture shows no caret or focus ring.
 */
function TypeInto({
  placeholder,
  text,
  children
}: {
  placeholder: string
  text: string
  children: ReactNode
}): JSX.Element {
  useEffect(() => {
    const id = window.setInterval(() => {
      const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
      if (!input) return
      window.clearInterval(id)
      // React ignores a plain `input.value =` on a controlled input: use the native setter and
      // fire the `input` event typing would.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
    }, 100)
    return () => window.clearInterval(id)
  }, [placeholder, text])
  return <>{children}</>
}

/**
 * A Rayfin 1.36 deploy of the sample app, as `rayfin up` streams it, timed so the
 * capture (10 s of virtual time) lands in the build.
 */
const DEPLOY_LOG: Array<[number, string]> = [
  [0, 'Deploying Contoso Expenses to Fabric…\n'],
  [600, '👀 Found Rayfin project root: C:\\Users\\avery\\RayfinProjects\\contoso-expenses\n'],
  [2500, '[rayfin] license: Checking user license\n'],
  [3200, '[rayfin] dependencies: Inspecting project dependencies\n[rayfin] workspace: Resolving workspace\n'],
  [3500, '[rayfin] item: Resolving Rayfin item\n[rayfin] target: Resolving workload endpoint\n'],
  [4200, '[rayfin] settings: Applying runtime settings\n'],
  [4700, '[rayfin] data: Applying database configuration\n'],
  [6000, '[rayfin] persist: Recording deployment\n[rayfin] static: Deploying static content\n']
]

/** The deploy screen in a preview-sized frame, fed the sample deploy's log. */
function Deploying(): JSX.Element {
  const [log, setLog] = useState<string[]>([])
  useEffect(() => {
    const timers = DEPLOY_LOG.map(([at, chunk]) => window.setTimeout(() => setLog((l) => [...l, chunk]), at))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [])
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Headless time runs ahead of CSS transitions: show the bar where it is. */}
      <style>{'.dstage-bar > span { transition: none !important; }'}</style>
      <div
        style={{
          width: 760,
          height: 720,
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden'
        }}
      >
        <DeployStage log={log} name="Contoso Expenses" />
      </div>
    </div>
  )
}

/** The sample app's deploy failing on a Fabric feature its tenant hasn't turned on, as Rayfin 1.36 reports it. */
const FAILED_DEPLOY_LOG = [
  'Deploying Contoso Expenses to Fabric…\n',
  '[rayfin] license: Checking user license\n',
  '[rayfin] dependencies: Inspecting project dependencies\n',
  '[rayfin] workspace: Resolving workspace\n',
  '[rayfin] item: Resolving Rayfin item\n',
  '[rayfin] target: Resolving workload endpoint\n',
  '[rayfin] settings: Applying runtime settings\n',
  '\n❌ Deployment failed: Runtime settings sync failed: 400 Bad Request\n',
  '   Details: The PostgreSQLDatabase feature is not enabled.\n'
]

/** The preview after that deploy failed: Ray above it, offering to find out why. */
function DeployFailed(): JSX.Element {
  const app = {
    id: 'p2',
    name: 'Contoso Expenses',
    path: 'C:/Users/avery/RayfinProjects/contoso-expenses',
    addedAt: '',
    lastDeploy: { url: 'https://contoso-expenses-1a2b3c4d5e-westus.webapp.fabricapps.net', status: 'success' }
  } as StudioProject
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          width: 900,
          height: 560,
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden'
        }}
      >
        <PreviewPane
          project={app}
          deploy={{
            running: false,
            log: FAILED_DEPLOY_LOG,
            result: { ok: false, outcome: 'error', error: '❌ Deployment failed: Runtime settings sync failed: 400 Bad Request' }
          }}
          focused={false}
          onToggleFocus={noop}
          onDiagnoseDeploy={noop}
          onRefreshAuth={noop}
        />
      </div>
    </div>
  )
}

/** The sample app, deployed to its Contoso Apps workspace. */
const expensesApp: StudioProject = {
  id: 'p2',
  name: 'Contoso Expenses',
  path: 'C:/Users/avery/RayfinProjects/contoso-expenses',
  addedAt: '',
  workspace: APPS_WS,
  workspaceName: 'Contoso Apps',
  lastDeploy: {
    url: EXPENSES_URL,
    portalUrl: `https://app.fabric.microsoft.com/groups/${APPS_WS}/appbackends/${EXPENSES_ITEM}`,
    status: 'success'
  }
}

/**
 * The app bar's deployment control, its panel open on the sample app's Development
 * deployment: live, nothing waiting, signed in.
 */
function Deployments(): JSX.Element {
  const app: StudioProject = { ...expensesApp, deploymentNames: { [APPS_WS]: 'Development' } }
  return (
    <header className="app-bar">
      <div className="app-bar-row">
        <div className="app-bar-start" />
        <div className="app-bar-center" />
        <div className="app-bar-end">
          <Open selector=".dep-select">
            <DeploymentsControl
              project={app}
              running={false}
              pending={{ changed: false, files: 0 }}
              onCreate={noop}
              onRedeploy={noop}
              onSwitch={() => Promise.resolve({ ok: true, outcome: 'success' })}
              onChanged={noop}
              account={{ user: 'avery.chen@contoso.com', tenant: 'Contoso' }}
              onManageAccounts={noop}
              onSignIn={noop}
              autoDeploy={{ on: true, onChange: noop }}
            />
          </Open>
          <div className="app-bar-global">
            <AccountMenu
              signedIn
              user="avery.chen@contoso.com"
              tenant="Contoso"
              busy={false}
              signingIn={false}
              signingOut={false}
              refreshing={false}
              canRefresh
              onSignIn={noop}
              onSignOut={noop}
              onRefresh={noop}
              onManageAccounts={noop}
              onOpenSettings={noop}
            />
          </div>
        </div>
      </div>
    </header>
  )
}

/**
 * The account menu, open from the avatar beside the sample app's deployment control: the
 * signed-in Fabric account, its actions and Settings. Opening it focuses its first item, which
 * a mouse click wouldn't show, so the shot hides the focus styling.
 */
function AccountMenuShot(): JSX.Element {
  const app: StudioProject = { ...expensesApp, deploymentNames: { [APPS_WS]: 'Development' } }
  return (
    <header className="app-bar">
      <style>{'.account-pop .account-item:focus-visible { outline: none; background: transparent; }'}</style>
      <div className="app-bar-row">
        <div className="app-bar-start" />
        <div className="app-bar-center" />
        <div className="app-bar-end">
          <DeploymentsControl
            project={app}
            running={false}
            pending={{ changed: false, files: 0 }}
            onCreate={noop}
            onRedeploy={noop}
            onSwitch={() => Promise.resolve({ ok: true, outcome: 'success' })}
            onChanged={noop}
          />
          <div className="app-bar-global">
            <Open selector=".account-trigger">
              <AccountMenu
                signedIn
                user="avery.chen@contoso.com"
                tenant="Contoso"
                busy={false}
                signingIn={false}
                signingOut={false}
                refreshing={false}
                canRefresh
                onSignIn={noop}
                onSignOut={noop}
                onRefresh={noop}
                onManageAccounts={noop}
                onOpenSettings={noop}
              />
            </Open>
          </div>
        </div>
      </div>
    </header>
  )
}

/**
 * Blueprint, filling the window as it fills the Build area: the Architecture view of the sample
 * app, or with `view="data"` its Data model view.
 */
function Blueprint({ view = 'architecture' }: { view?: 'architecture' | 'data' }): JSX.Element {
  // Blueprint opens on the view last chosen for the project.
  localStorage.setItem(`rayfin.model.view.${expensesApp.id}`, view)
  return (
    <div className="workbench" style={{ flex: 1 }}>
      <main className="content">
        <div className="project-pane">
          <BlueprintTab
            project={expensesApp}
            refreshKey={0}
            onOpenFile={noop}
            onSendToChat={noop}
            onOpenSecrets={noop}
            fabricUser="avery.chen@contoso.com"
          />
        </div>
      </main>
    </div>
  )
}

function Shot({ id }: { id: string | null }): JSX.Element {
  switch (id) {
    case 'team-overview': {
      const map = sampleMap()
      // Started a minute and a half ago, so the run's timer reads like a live deploy.
      map.runs = [{ ...sampleRun(), startedAt: new Date(Date.now() - 95_000).toISOString() }]
      return <TeamMapView workspace={sampleWorkspace} initialMap={map} onClose={noop} onOpened={noop} />
    }
    case 'team-publish':
      return (
        <div className="appbar" style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px' }}>
          <Open selector=".team-split-status">
            <TeamPublishControl
              project={project}
              workspaceName={sampleWorkspace.name}
              status={teamStatus}
              syncing={false}
              onPublish={noop}
              onUpdate={noop}
              onCombine={noop}
              onDiscard={noop}
              onSetView={noop}
              onViewLogs={noop}
              onRefresh={noop}
            />
          </Open>
        </div>
      )
    case 'team-create':
      // Its checks pass and its pickers load from the sample `team` API, then the name is typed in.
      return (
        <TypeInto placeholder="Sales team apps" text="Finance Team">
          <CreateTeamWorkspaceModal onClose={noop} onChanged={noop} />
        </TypeInto>
      )
    case 'rayfin-version':
      return (
        <footer className="statusbar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}>
          <Open selector=".ver-btn">
            <RayfinVersionControl info={rayfinUpdate} onUpdate={noop} />
          </Open>
        </footer>
      )
    case 'port-conflict':
      return (
        <PortConflictModal
          conflict={{
            port: 5173,
            occupant: { pid: 18244, name: 'node.exe', commandLine: 'node node_modules/vite/bin/vite.js --port 5173' },
            canStop: true,
            suggestedPort: 5174,
            needsPush: true
          }}
          context="turn"
          busy={null}
          error={null}
          log={[]}
          onUsePort={noop}
          onStop={noop}
          onSkip={noop}
        />
      )
    case 'plan':
      return (
        <main
          className="chat"
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            background:
              'radial-gradient(circle at top, color-mix(in srgb, var(--accent) 16%, transparent), transparent 34%), var(--bg)'
          }}
        >
          <div style={{ width: 740, maxWidth: '100%' }}>
            <div className="turn turn--assistant">
              <div className="turn-main">
                <PlanCard
                  plan={plan}
                  projectName="Contoso Expenses"
                  onContentChange={noop}
                  onResolve={noop}
                  onAnswerQuestion={noop}
                  onResume={noop}
                  onExport={noopAsync}
                />
              </div>
            </div>
          </div>
        </main>
      )
    case 'skills':
      return (
        <SelectSkill title="Secure by default">
          <SkillsView project={{ ...project, id: 'p2', name: 'Contoso Expenses', team: undefined }} onChanged={noop} />
        </SelectSkill>
      )
    case 'secrets':
      return (
        <SelectSecret name="OPENAI_API_KEY">
          <SecretsView
            project={{ ...project, id: 'p2', name: 'Contoso Expenses', team: undefined }}
            onChanged={noop}
            onSendToChat={noop}
          />
        </SelectSecret>
      )
    case 'setup':
      return (
        <SetupScreen
          doctor={setupDoctor}
          auth={setupAuth}
          refreshing={false}
          onRefresh={noopAsync}
          onEnter={noop}
        />
      )
    case 'help':
      return <HelpView onClose={noop} onAction={noop} onReportIssue={noop} appVersion="1.11.0" />
    case 'deploy-progress':
      return <Deploying />
    case 'deploy-error':
      return <DeployFailed />
    case 'deployments':
      return <Deployments />
    case 'account-menu':
      return <AccountMenuShot />
    case 'blueprint':
      return <Blueprint />
    case 'model-relations':
    case 'model-access':
      return <Blueprint view="data" />
    case 'model-picker':
      return (
        <Steps clicks={['.mp-pill', '[data-sub="model"]']}>
          <ComposerPicker value={{ model: 'claude-opus-5.5', effort: 'high', autoTier: '', contextTier: '' }} />
        </Steps>
      )
    case 'model-providers':
      return <ModelProvidersShot />
    case 'add-menu':
      return (
        <Steps clicks={['.add-menu .composer-icon-btn', '[data-sub="data"]']}>
          <ComposerPicker value={{ model: 'claude-opus-5.5', effort: 'high', autoTier: '', contextTier: '' }} />
        </Steps>
      )
    case 'connect-data':
      return <ConnectDataShot />
    case 'data-chips':
      return (
        <ComposerPicker
          value={{ model: 'claude-opus-5.5', effort: 'high', autoTier: '', contextTier: '' }}
          data={pickedData}
        />
      )
    case 'settings':
      return <SettingsShot />
    case 'settings-experiments':
      return <SettingsShot experiments />
    case 'migrate-report':
      // The picker opens on Contoso Apps, where the sample app deploys; the shot opens Sales
      // analytics and picks Sales performance, and Fabricator shows what it can read of it.
      return (
        <Steps clicks={['.mig-ws li:nth-child(6) button', '.mig-reports li:nth-child(2) button']}>
          <MigrateReportScreen recentWorkspaces={[APPS_WS]} onCancel={noop} onPicked={noop} />
        </Steps>
      )
    case 'migration-card':
      return (
        <ComposerPicker
          value={{ model: 'claude-opus-5.5', effort: 'high', autoTier: '', contextTier: '' }}
          project="Sales performance"
          banner={
            <MigrationCard
              state={salesMigration}
              drawing={false}
              chaining={false}
              onNext={noop}
              onRest={noop}
              onStopRest={noop}
              onRetry={noop}
              onSkipImages={noop}
              onDismiss={noop}
            />
          }
        />
      )
    default:
      return <p style={{ padding: 24 }}>Unknown shot: {String(id)}</p>
  }
}

installApi()
const params = new URLSearchParams(location.search)
applyTheme(params.get('theme') === 'light' ? 'light' : 'dark')
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <OverlayProvider>
    <ToastProvider>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Shot id={params.get('shot')} />
      </div>
    </ToastProvider>
  </OverlayProvider>
)
