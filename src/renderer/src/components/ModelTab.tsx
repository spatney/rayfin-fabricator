import { useCallback, useEffect, useState } from 'react'
import type { StudioProject } from '@shared/ipc'
import { parseProjectDataModel, type DataModel } from '../model/parseSchema'
import { loadProjectFabricConfig, type SemanticModelRef } from '../model/fabricConfig'
import ModelView from './ModelView'
import SemanticModelView from './SemanticModelView'

interface Props {
  project: StudioProject
  refreshKey: number
  onOpenFile: (path: string) => void
  onSendToChat: (display: string, prompt: string, stage?: boolean) => void
  onSignedIn?: () => Promise<void> | void
}

type ViewChoice = 'data' | 'semantic'

const VIEW_PREF_PREFIX = 'rayfin.model.view.'

function readViewPref(projectId: string): ViewChoice | null {
  try {
    const v = localStorage.getItem(VIEW_PREF_PREFIX + projectId)
    return v === 'data' || v === 'semantic' ? v : null
  } catch {
    return null
  }
}

/**
 * The Model tab. A project can carry an offline **data model** (`rayfin/data`),
 * a live Fabric **semantic model** (`fabric.yaml`), or both. This wrapper parses
 * the data model and reads `fabric.yaml` once to decide what to show:
 *
 *  - both → a `Data model | Semantic model` toggle (default Data, remembered per project)
 *  - only a semantic model → the semantic diagram
 *  - otherwise → the data-model view (which also owns the "no data model yet" CTA)
 */
export default function ModelTab({
  project,
  refreshKey,
  onOpenFile,
  onSendToChat,
  onSignedIn
}: Props): JSX.Element {
  const [detecting, setDetecting] = useState(true)
  const [dataModel, setDataModel] = useState<DataModel | null>(null)
  const [semanticModels, setSemanticModels] = useState<SemanticModelRef[]>([])
  const [choice, setChoice] = useState<ViewChoice>(() => readViewPref(project.id) ?? 'data')

  useEffect(() => {
    let alive = true
    setDetecting(true)
    Promise.all([
      parseProjectDataModel(project.id).catch(
        (): DataModel => ({ entities: [], relations: [], warnings: [], hasSchema: false })
      ),
      loadProjectFabricConfig(project.id).catch(() => null)
    ]).then(([dm, fc]) => {
      if (!alive) return
      setDataModel(dm)
      setSemanticModels(fc?.models ?? [])
      setChoice(readViewPref(project.id) ?? 'data')
      setDetecting(false)
    })
    return () => {
      alive = false
    }
  }, [project.id, refreshKey])

  const pickView = useCallback(
    (next: ViewChoice): void => {
      setChoice(next)
      try {
        localStorage.setItem(VIEW_PREF_PREFIX + project.id, next)
      } catch {
        /* best-effort */
      }
    },
    [project.id]
  )

  if (detecting) {
    return (
      <div className="model-view">
        <div className="model-empty">Reading your model…</div>
      </div>
    )
  }

  const hasData = (dataModel?.entities.length ?? 0) > 0
  const hasSemantic = semanticModels.length > 0
  const showToggle = hasData && hasSemantic
  const active: ViewChoice = showToggle ? choice : hasSemantic ? 'semantic' : 'data'

  const view =
    active === 'semantic' ? (
      <SemanticModelView
        projectId={project.id}
        models={semanticModels}
        refreshKey={refreshKey}
        onSignedIn={onSignedIn}
      />
    ) : (
      <ModelView
        project={project}
        refreshKey={refreshKey}
        onOpenFile={onOpenFile}
        onSendToChat={onSendToChat}
        providedModel={dataModel}
      />
    )

  if (!showToggle) return view

  return (
    <div className="model-tab">
      <div className="model-tab-switch" role="tablist" aria-label="Model view">
        <button
          role="tab"
          aria-selected={active === 'data'}
          className={`seg-btn${active === 'data' ? ' seg-btn--active' : ''}`}
          onClick={() => pickView('data')}
        >
          Data model
        </button>
        <button
          role="tab"
          aria-selected={active === 'semantic'}
          className={`seg-btn${active === 'semantic' ? ' seg-btn--active' : ''}`}
          onClick={() => pickView('semantic')}
        >
          Semantic model
        </button>
      </div>
      <div className="model-tab-body">{view}</div>
    </div>
  )
}
