import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileNode, StudioProject, TeamManifest } from '@shared/ipc'
import { emptyDataModel, parseProjectDataModel, type DataModel } from '../../model/parseSchema'
import { loadProjectFabricConfig } from '../../model/fabricConfig'
import {
  buildArchitecture,
  describeAppIdentity,
  parseRayfinConfig,
  type AppArchitecture
} from '../../model/architecture'
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

export type BlueprintView = 'architecture' | 'data' | 'semantic'

const VIEW_PREF_PREFIX = 'rayfin.model.view.'
/** Enough for any real functions folder; a runaway tree doesn't stall the tab. */
const MAX_FUNCTION_FILES = 40

function readViewPref(projectId: string): BlueprintView | null {
  try {
    const v = localStorage.getItem(VIEW_PREF_PREFIX + projectId)
    return v === 'architecture' || v === 'data' || v === 'semantic' ? v : null
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

/** Every source file under the functions package's `src/`. */
async function readFunctionSources(
  projectId: string,
  functionsPath: string
): Promise<{ path: string; text: string }[]> {
  let tree: FileNode[] = []
  try {
    tree = await window.api.projects.files.tree(projectId)
  } catch {
    return []
  }
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

interface Loaded {
  dataModel: DataModel
  arch: AppArchitecture | { error: string }
}

async function loadBlueprint(projectId: string, projectName: string): Promise<Loaded> {
  const ymlText = (await readText(projectId, 'rayfin/rayfin.yml')) ?? (await readText(projectId, 'rayfin/rayfin.yaml'))
  const functionsPath = (ymlText && parseRayfinConfig(ymlText)?.functions.path) || 'rayfin/functions'
  const [dataModel, fabric, functionSources] = await Promise.all([
    parseProjectDataModel(projectId).catch((): DataModel => emptyDataModel()),
    loadProjectFabricConfig(projectId).catch(() => null),
    readFunctionSources(projectId, functionsPath)
  ])
  const arch = buildArchitecture({
    projectName,
    rayfinYml: ymlText,
    fabric,
    dataModel,
    functionSources
  })
  return { dataModel, arch }
}

/**
 * The Blueprint tab: how the app is put together. Three views share one header:
 *
 *  - **Architecture**: the app's parts, what it connects to, and which identity
 *    each connection signs in as (each person, or the app, and whose credentials);
 *  - **Data model**: the entity diagram of the app's data model (`rayfin/data`,
 *    or the data package rayfin.yml names);
 *  - **Semantic model**: live diagrams of the semantic models it uses (shown
 *    only when it uses some, from `fabric.yaml` or a connector).
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
  const [modelRequest, setModelRequest] = useState<{ key: string; nonce: number } | null>(null)
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
  const hasSemantic = semanticModels.length > 0
  // A remembered Semantic model view falls back when the app no longer has one.
  const active: BlueprintView = view === 'semantic' && !hasSemantic ? 'architecture' : view

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
  const openSemanticModel = useCallback(
    (key: string): void => {
      pick('semantic')
      setModelRequest({ key, nonce: Date.now() })
    },
    [pick]
  )

  const tables = loaded?.dataModel.entities.length ?? 0
  const tabs: { id: BlueprintView; label: string; icon: string; count?: number }[] = [
    { id: 'architecture', label: 'Architecture', icon: 'type-hierarchy-sub' },
    { id: 'data', label: 'Data model', icon: 'database', count: tables || undefined },
    ...(hasSemantic
      ? [
          {
            id: 'semantic' as const,
            label: 'Semantic model',
            icon: 'graph',
            count: semanticModels.length > 1 ? semanticModels.length : undefined
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
  } else if (active === 'semantic') {
    body = (
      <SemanticModelView
        projectId={project.id}
        models={semanticModels}
        refreshKey={refreshKey}
        onSignedIn={onSignedIn}
        selectRequest={modelRequest}
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
        onOpenSemanticModel={openSemanticModel}
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
