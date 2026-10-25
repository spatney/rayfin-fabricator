import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { FileNode, StudioProject, TeamManifest } from '@shared/ipc'
import { emptyDataModel, parseProjectDataModel, type DataModel } from '../../model/parseSchema'
import { loadProjectFabricConfig } from '../../model/fabricConfig'
import {
  buildArchitecture,
  describeAppIdentity,
  parseRayfinConfig,
  SQL_CONNECTOR_TYPES,
  type AppArchitecture,
  type ConnectorConfig
} from '../../model/architecture'
import {
  buildSqlSource,
  connectorDir,
  metadataPaths,
  type SqlSourceFiles,
  type SqlSourceModel
} from '../../model/sqlSource'
import ModelView from '../ModelView'
import SemanticModelView from '../SemanticModelView'
import { Codicon } from '../icons'
import ArchitectureView from './ArchitectureView'
import { BlueprintHeadSlot } from './ViewHead'
import './blueprint.css'

interface Props {
  project: StudioProject
  /** Bumped by the parent when files may have changed (e.g. after a chat turn). */
  refreshKey: number
  onOpenFile: (path: string) => void
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
  onSignedIn?: () => Promise<void> | void
  /** The Fabric account Fabricator deploys with: whose credentials a personal app uses. */
  fabricUser?: string
  /** A team app's workspace settings, which name the service principals that deploy it. */
  teamManifest?: TeamManifest
  /** Open Code → Secrets. */
  onOpenSecrets?: () => void
}

export type BlueprintView = 'architecture' | 'data' | 'fabric'

const VIEW_PREF_PREFIX = 'rayfin.model.view.'
/** Enough for any real functions folder; a runaway tree doesn't stall the tab. */
const MAX_FUNCTION_FILES = 40
/** Entity files read per SQL connector (one per table the app uses, plus schema.ts). */
const MAX_CONNECTOR_FILES = 150

function readViewPref(projectId: string): BlueprintView | null {
  try {
    const v = localStorage.getItem(VIEW_PREF_PREFIX + projectId)
    // The Fabric data view was called Semantic model before it drew SQL sources too.
    if (v === 'semantic') return 'fabric'
    return v === 'architecture' || v === 'data' || v === 'fabric' ? v : null
  } catch {
    return null
  }
}

async function readText(projectId: string, path: string): Promise<string | null> {
  try {
    const fc = await window.api.projects.files.read(projectId, path)
    if (fc.error || fc.binary || fc.tooLarge) return null
    return fc.content ?? null
  } catch {
    return null
  }
}

async function readTree(projectId: string): Promise<FileNode[]> {
  try {
    return await window.api.projects.files.tree(projectId)
  } catch {
    return []
  }
}

/** Every source file under the functions package's `src/`. */
async function readFunctionSources(
  projectId: string,
  tree: FileNode[],
  functionsPath: string
): Promise<{ path: string; text: string }[]> {
  const prefix = `${functionsPath}/src/`
  const paths: string[] = []
  const walk = (nodes: FileNode[]): void => {
    for (const n of nodes) {
      if (n.ignored) continue
      if (n.type === 'dir') {
        // Only go down the way to the functions folder, and inside it.
        if (prefix.startsWith(`${n.path}/`) || n.path.startsWith(prefix)) walk(n.children ?? [])
      } else if (n.path.startsWith(prefix) && /\.[cm]?[jt]s$/.test(n.path) && !/\.d\.[cm]?ts$/.test(n.path)) {
        paths.push(n.path)
      }
    }
  }
  walk(tree)
  const read = await Promise.all(
    paths.slice(0, MAX_FUNCTION_FILES).map(async (path) => ({ path, text: await readText(projectId, path) }))
  )
  return read.flatMap((r) => (r.text == null ? [] : [{ path: r.path, text: r.text }]))
}

/** The files directly inside a project folder, from the tree. */
function filesIn(tree: FileNode[], dir: string): string[] {
  let nodes = tree
  for (const path of dir.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))) {
    const next = nodes.find((n) => n.type === 'dir' && n.path.toLowerCase() === path.toLowerCase())
    if (!next) return []
    nodes = next.children ?? []
  }
  return nodes.filter((n) => n.type === 'file').map((n) => n.path)
}

/** A connector's metadata.json, from where current or older Rayfin CLIs write it. */
async function readMetadata(projectId: string, connectorName: string): Promise<SqlSourceFiles['metadata']> {
  for (const path of metadataPaths(connectorName)) {
    let fc
    try {
      fc = await window.api.projects.files.read(projectId, path)
    } catch {
      continue
    }
    if (fc.tooLarge) return { path, text: null, problem: 'metadata.json is too large to read.' }
    if (fc.error) continue
    return { path, text: fc.binary ? null : (fc.content ?? '') }
  }
  return undefined
}

/** Each SQL connector's tables: its metadata.json and the entity files beside it. */
async function readSqlSources(
  projectId: string,
  tree: FileNode[],
  connectors: ConnectorConfig[]
): Promise<SqlSourceModel[]> {
  return Promise.all(
    connectors.map(async (connector) => {
      const dir = connectorDir(connector.name)
      const warnings: string[] = []
      let paths = filesIn(tree, dir).filter((p) => /\.[cm]?ts$/.test(p) && !/\.d\.[cm]?ts$/.test(p))
      if (paths.length > MAX_CONNECTOR_FILES) {
        warnings.push(`Read the first ${MAX_CONNECTOR_FILES} of ${paths.length} files in ${dir}/.`)
        paths = paths.slice(0, MAX_CONNECTOR_FILES)
      }
      const [metadata, files] = await Promise.all([
        readMetadata(projectId, connector.name),
        Promise.all(paths.map(async (path) => ({ path, text: await readText(projectId, path) })))
      ])
      return buildSqlSource({
        connector,
        metadata,
        files: files.flatMap((f) => (f.text == null ? [] : [{ path: f.path, text: f.text }])),
        warnings
      })
    })
  )
}

interface Loaded {
  dataModel: DataModel
  arch: AppArchitecture | { error: string }
  sqlSources: SqlSourceModel[]
}

async function loadBlueprint(projectId: string, projectName: string): Promise<Loaded> {
  const ymlText = (await readText(projectId, 'rayfin/rayfin.yml')) ?? (await readText(projectId, 'rayfin/rayfin.yaml'))
  const config = ymlText ? parseRayfinConfig(ymlText) : null
  const functionsPath = config?.functions.path || 'rayfin/functions'
  const sqlConnectors = (config?.connectors ?? []).filter((c) => SQL_CONNECTOR_TYPES.has(c.type))
  const tree = readTree(projectId)
  const [dataModel, fabric, functionSources, sqlSources] = await Promise.all([
    parseProjectDataModel(projectId).catch((): DataModel => emptyDataModel()),
    loadProjectFabricConfig(projectId).catch(() => null),
    tree.then((nodes) => readFunctionSources(projectId, nodes, functionsPath)),
    tree.then((nodes) => readSqlSources(projectId, nodes, sqlConnectors))
  ])
  const arch = buildArchitecture({
    projectName,
    rayfinYml: ymlText,
    fabric,
    dataModel,
    functionSources
  })
  return { dataModel, arch, sqlSources }
}

/**
 * The Blueprint tab: how the app is put together. Three views share one header:
 *
 *  - **Architecture**: the app's parts, what it connects to, and which identity
 *    each connection signs in as (each person, or the app, and whose credentials);
 *  - **Data model**: the entity diagram of the app's data model (`rayfin/data`,
 *    or the data package rayfin.yml names);
 *  - **Fabric data**: diagrams of the Fabric data it connects to (shown only
 *    when it connects to some): semantic models, read live from `fabric.yaml` or
 *    a connector, and the tables of its SQL database, warehouse and lakehouse
 *    connectors, read from the project.
 *
 * The chosen view is remembered per project.
 */
export default function BlueprintTab({
  project,
  refreshKey,
  onOpenFile,
  onSendToChat,
  onSignedIn,
  fabricUser,
  teamManifest,
  onOpenSecrets
}: Props): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [view, setView] = useState<BlueprintView>(() => readViewPref(project.id) ?? 'architecture')
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [entityRequest, setEntityRequest] = useState<{ entity: string; nonce: number } | null>(null)
  const [sourceRequest, setSourceRequest] = useState<{ key: string; nonce: number } | null>(null)
  const [activeAccount, setActiveAccount] = useState<string | undefined>(undefined)

  // The sign-in status doesn't always name the account; the account list does.
  useEffect(() => {
    if (fabricUser || project.team || !window.api?.accounts?.fabric) return
    let alive = true
    window.api.accounts.fabric().then(
      (res) => {
        // Active account first.
        if (alive) setActiveAccount((res.accounts.find((a) => a.active) ?? res.accounts[0])?.user || undefined)
      },
      () => {
        /* stays unknown */
      }
    )
    return () => {
      alive = false
    }
  }, [fabricUser, project.team])

  useEffect(() => {
    let alive = true
    void loadBlueprint(project.id, project.name).then((next) => {
      if (alive) setLoaded(next)
    })
    return () => {
      alive = false
    }
  }, [project.id, project.name, refreshKey])

  const pick = useCallback(
    (next: BlueprintView): void => {
      setView(next)
      try {
        localStorage.setItem(VIEW_PREF_PREFIX + project.id, next)
      } catch {
        /* best-effort */
      }
    },
    [project.id]
  )

  const arch = loaded && !('error' in loaded.arch) ? loaded.arch : null
  const semanticModels = useMemo(() => arch?.semanticModels ?? [], [arch])
  const sqlSources = useMemo(() => loaded?.sqlSources ?? [], [loaded])
  const fabricSources = semanticModels.length + sqlSources.length
  // A remembered Fabric data view falls back when the app no longer connects to any.
  const active: BlueprintView = view === 'fabric' && !fabricSources ? 'architecture' : view

  const owner = fabricUser || activeAccount
  const appIdentity = useMemo(
    () => describeAppIdentity({ team: project.team ? teamManifest : undefined, fabricUser: owner }),
    [project.team, teamManifest, owner]
  )
  const workspaceName = project.team
    ? project.team.view === 'preview'
      ? teamManifest?.fabric.previews.name
      : teamManifest?.fabric.production.name
    : project.workspaceName

  const openEntity = useCallback(
    (entity: string): void => {
      pick('data')
      setEntityRequest(entity ? { entity, nonce: Date.now() } : null)
    },
    [pick]
  )
  const openFabricData = useCallback(
    (key: string): void => {
      pick('fabric')
      setSourceRequest({ key, nonce: Date.now() })
    },
    [pick]
  )

  const tables = loaded?.dataModel.entities.length ?? 0
  const tabs: { id: BlueprintView; label: string; icon: string; count?: number }[] = [
    { id: 'architecture', label: 'Architecture', icon: 'type-hierarchy-sub' },
    { id: 'data', label: 'Data model', icon: 'database', count: tables || undefined },
    ...(fabricSources
      ? [
          {
            id: 'fabric' as const,
            label: 'Fabric data',
            icon: 'plug',
            count: fabricSources > 1 ? fabricSources : undefined
          }
        ]
      : [])
  ]

  let body: JSX.Element
  if (!loaded) {
    body = <div className="model-empty">Reading your app…</div>
  } else if (active === 'data') {
    body = (
      <ModelView
        project={project}
        refreshKey={refreshKey}
        onOpenFile={onOpenFile}
        onSendToChat={onSendToChat}
        providedModel={loaded.dataModel}
        focusRequest={entityRequest}
      />
    )
  } else if (active === 'fabric') {
    body = (
      <SemanticModelView
        projectId={project.id}
        models={semanticModels}
        sqlSources={sqlSources}
        refreshKey={refreshKey}
        onSignedIn={onSignedIn}
        onOpenFile={onOpenFile}
        onSendToChat={onSendToChat}
        selectRequest={sourceRequest}
      />
    )
  } else if ('error' in loaded.arch) {
    body = (
      <div className="model-empty model-empty--cta">
        <div className="model-empty-title">Couldn’t draw the app</div>
        <p className="model-empty-sub">{loaded.arch.error}</p>
        <button className="btn btn--primary" onClick={() => onOpenFile('rayfin/rayfin.yml')}>
          Open rayfin.yml
        </button>
      </div>
    )
  } else {
    body = (
      <ArchitectureView
        arch={loaded.arch}
        project={project}
        appIdentity={appIdentity}
        workspaceName={workspaceName}
        onOpenFile={onOpenFile}
        onSendToChat={onSendToChat}
        onOpenEntity={openEntity}
        onOpenFabricData={openFabricData}
        onOpenSecrets={onOpenSecrets}
      />
    )
  }

  return (
    <div className="bp-tab">
      <div className="bp-head">
        <div className="seg bp-seg" role="tablist" aria-label="Blueprint views">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={active === t.id}
              className={`seg-btn${active === t.id ? ' seg-btn--active' : ''}`}
              onClick={() => pick(t.id)}
            >
              <Codicon name={t.icon} />
              {t.label}
              {t.count !== undefined && <span className="bp-seg-count">{t.count}</span>}
            </button>
          ))}
        </div>
        <div className="bp-head-slot" ref={setSlot} />
      </div>
      <div className="bp-tab-body" role="tabpanel">
        {slot && <BlueprintHeadSlot.Provider value={slot}>{body}</BlueprintHeadSlot.Provider>}
      </div>
    </div>
  )
}
