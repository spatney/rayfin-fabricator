import { useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
// Point @monaco-editor/react at the locally-bundled Monaco (this app runs offline
// from a file:// renderer). Without this side-effect the editor tries to fetch
// Monaco from the CDN and hangs forever on "Loading editor…". The Code tab pulls
// this in too, but a user can open this preview before ever visiting that tab.
import '../monaco'
import type { SkillInfo, SkillSource } from '@shared/ipc'

interface Props {
  projectId: string
  skill: SkillInfo
  onClose: () => void
}

/** Track the app's resolved theme so Monaco matches light/dark. */
function useEditorTheme(): string {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setDark(el.dataset.theme !== 'light'))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return dark ? 'rayfin-dark' : 'rayfin-light'
}

/**
 * Read-only preview of a skill's raw SKILL.md (YAML frontmatter + markdown body),
 * shown in the same Monaco editor the Code tab uses. Lets a curious user inspect
 * exactly what guidance a skill gives the agent before turning it on.
 */
export default function SkillPreviewModal({ projectId, skill, onClose }: Props): JSX.Element {
  const [source, setSource] = useState<SkillSource | null>(null)
  const theme = useEditorTheme()

  useEffect(() => {
    let alive = true
    void window.api.skills.source(projectId, skill.id).then((s) => {
      if (alive) setSource(s)
    })
    return () => {
      alive = false
    }
  }, [projectId, skill.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--code" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header skill-preview-header">
          <div className="skill-preview-title">
            <span className="skill-preview-icon" aria-hidden="true">
              {skill.icon}
            </span>
            <div>
              <h2>{skill.title}</h2>
              <p className="modal-sub">
                <code>.agents/skills/{skill.id}/SKILL.md</code>
                {source && !source.installed && ' · sample (not yet added)'}
              </p>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </div>
        <div className="modal-body skill-preview-body">
          {!source ? (
            <div className="code-empty">Loading…</div>
          ) : !source.ok ? (
            <div className="code-empty code-empty--err">{source.error}</div>
          ) : (
            <div className="skill-preview-editor">
              <Editor
                height="100%"
                theme={theme}
                language="markdown"
                value={source.content ?? ''}
                loading={<div className="code-empty">Loading editor…</div>}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12.5,
                  fontFamily: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  contextmenu: false,
                  scrollbar: { useShadows: false }
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
