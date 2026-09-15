import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { FileContent, FileNode, StudioProject } from '@shared/ipc'
import { monacoLanguage } from '../monaco'
import { Codicon, EditorIcon } from './icons'
import HistoryView from './HistoryView'
import SkillsView from './SkillsView'

interface Props {
  project: StudioProject
  /** Bumped by the parent when files may have changed (e.g. after a chat turn). */
  refreshKey: number
  /** Ask the parent to deploy the current code (used by History → Restore). */
  onRequestDeploy?: () => void
  /** Hand a slice of history (commit/file/comparison) to the Build chat. */
  onSendToChat?: (display: string, prompt: string) => void
  /** Open a specific project file in the Files browser (e.g. from the Model tab). */
  openRequest?: { path: string; nonce: number }
  /** Called after a skill is toggled in the Skills sub-view (parent refreshes). */
  onSkillsChanged?: () => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Project-relative paths (lowercased) opened by default on first entry to Files. */
const DEFAULT_FILES = ['rayfin/rayfin.yml', 'rayfin/rayfin.yaml']

type CodeTab = 'files' | 'history' | 'skills'

const codeTabKey = (projectId: string): string => `rayfin.code.tab.${projectId}`
const codeFileKey = (projectId: string): string => `rayfin.code.file.${projectId}`

function readCodeTab(projectId: string): CodeTab {
  try {
    const value = localStorage.getItem(codeTabKey(projectId))
    return value === 'history' || value === 'skills' ? value : 'files'
  } catch {
    return 'files'
  }
}

function writeCodeTab(projectId: string, tab: CodeTab): void {
  try {
    localStorage.setItem(codeTabKey(projectId), tab)
  } catch {
    // Ignore storage failures; persistence is a convenience only.
  }
}

function readCodeFile(projectId: string): string | null {
  try {
    return localStorage.getItem(codeFileKey(projectId)) || null
  } catch {
    return null
  }
}

function writeCodeFile(projectId: string, path: string | null): void {
  try {
    if (path) {
      localStorage.setItem(codeFileKey(projectId), path)
    } else {
      localStorage.removeItem(codeFileKey(projectId))
    }
  } catch {
    // Ignore storage failures; persistence is a convenience only.
  }
}

/** Depth-first search for the first file node matching `pred`. */
function findFile(nodes: FileNode[], pred: (n: FileNode) => boolean): FileNode | null {
  for (const node of nodes) {
    if (node.type === 'file') {
      if (pred(node)) return node
    } else if (node.children) {
      const hit = findFile(node.children, pred)
      if (hit) return hit
    }
  }
  return null
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

interface TreeRowProps {
  node: FileNode
  depth: number
  selectedPath: string | null
  onSelect: (node: FileNode) => void
}

function TreeRow({ node, depth, selectedPath, onSelect }: TreeRowProps): JSX.Element {
  const isAncestor =
    node.type === 'dir' &&
    selectedPath != null &&
    (selectedPath === node.path || selectedPath.startsWith(`${node.path}/`))
  const [open, setOpen] = useState(isAncestor)
  // Auto-expand folders that contain the selected file (e.g. the default pick),
  // without ever force-collapsing folders the user has opened.
  useEffect(() => {
    if (isAncestor) setOpen(true)
  }, [isAncestor])
  const indent = 8 + depth * 12

  if (node.type === 'dir') {
    return (
      <div>
        <button
          className={`tree-row tree-row--dir${node.ignored ? ' tree-row--ignored' : ''}`}
          style={{ paddingLeft: indent }}
          onClick={() => setOpen((o) => !o)}
          title={node.ignored ? 'Ignored by Git' : undefined}
        >
          <span className="tree-caret">
            <Codicon name={open ? 'chevron-down' : 'chevron-right'} />
          </span>
          <span className="tree-name">{node.name}</span>
        </button>
        {open &&
          node.children?.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </div>
    )
  }

  return (
    <button
      className={`tree-row tree-row--file${selectedPath === node.path ? ' tree-row--active' : ''}${
        node.ignored ? ' tree-row--ignored' : ''
      }`}
      style={{ paddingLeft: indent + 14 }}
      onClick={() => onSelect(node)}
      title={node.ignored ? `${node.path} — ignored by Git` : undefined}
    >
      <span className="tree-name">{node.name}</span>
      {node.ignored && <span className="tree-ignored-tag">ignored</span>}
    </button>
  )
}

/** Read-only project code browser: a file tree + a Monaco (VS Code) viewer. */
function FilesView({
  project,
  refreshKey,
  theme,
  openRequest
}: Props & { theme: string }): JSX.Element {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const [selectedState, setSelectedState] = useState(() => ({
    projectId: project.id,
    path: openRequest?.path ?? readCodeFile(project.id)
  }))
  const selected = selectedState.projectId === project.id ? selectedState.path : null
  const [file, setFile] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  // Guards the one-time default pick so we never override a manual selection.
  const didDefaultRef = useRef(false)
  /** Latest read wins so a slower default-config read cannot overwrite an external request. */
  const fileReadRef = useRef(0)
  const requestedPathRef = useRef(openRequest?.path)
  requestedPathRef.current = openRequest?.path

  const loadTree = useCallback(async (): Promise<void> => {
    setTree(await window.api.projects.files.tree(project.id))
  }, [project.id])

  const readPath = useCallback(
    async (path: string): Promise<void> => {
      const request = ++fileReadRef.current
      setLoading(true)
      try {
        const next = await window.api.projects.files.read(project.id, path)
        if (request === fileReadRef.current) setFile(next)
      } finally {
        if (request === fileReadRef.current) setLoading(false)
      }
    },
    [project.id]
  )

  // Reset the default-pick guard when switching projects, then restore any
  // file remembered for the new project.
  useEffect(() => {
    didDefaultRef.current = false
    fileReadRef.current += 1
    setSelectedState({
      projectId: project.id,
      path: requestedPathRef.current ?? readCodeFile(project.id)
    })
    setFile(null)
    setTree(null)
  }, [project.id])

  useEffect(() => {
    if (selectedState.projectId === project.id) writeCodeFile(project.id, selectedState.path)
  }, [project.id, selectedState])

  // Load (and refresh) the tree; re-read the open file when files may have changed.
  useEffect(() => {
    void loadTree()
  }, [loadTree, refreshKey])

  // On first entry, open the project's Rayfin config (rayfin/rayfin.yml). Skipped
  // once the user has picked a file, so manual selections are never overridden.
  useEffect(() => {
    if (!tree || didDefaultRef.current || selected || openRequest?.path) return
    didDefaultRef.current = true
    const target = findFile(tree, (n) => DEFAULT_FILES.includes(n.path.toLowerCase()))
    if (target) setSelectedState({ projectId: project.id, path: target.path })
  }, [project.id, tree, selected])

  useEffect(() => {
    if (selected) void readPath(selected)
  }, [refreshKey, selected, readPath])

  // Honour an external request before passive effects can choose the default config file.
  useLayoutEffect(() => {
    if (!openRequest?.path) return
    didDefaultRef.current = true
    setSelectedState({ projectId: project.id, path: openRequest.path })
  }, [openRequest?.nonce, openRequest?.path, project.id])

  const onSelect = useCallback(
    (node: FileNode): void => {
      setSelectedState({ projectId: project.id, path: node.path })
    },
    [project.id]
  )

  const copy = (): void => {
    if (!file?.content) return
    void navigator.clipboard.writeText(file.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="code-viewer">
      <div className="code-tree">
        <div className="code-tree-head">
          <span>Files</span>
          <button
            className="btn btn--xs btn--ghost"
            onClick={() => void loadTree()}
            title="Refresh"
          >
            <Codicon name="refresh" />
          </button>
        </div>
        <div className="code-tree-body">
          {tree === null ? (
            <div className="code-tree-empty">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="code-tree-empty">No files found.</div>
          ) : (
            tree.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selected}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </div>

      <div className="code-main">
        {selected && (
          <div className="code-head">
            <span className="code-path" title={selected}>
              {selected}
            </span>
            <span className="code-head-spacer" />
            {file && !file.error && file.size > 0 && (
              <span className="code-size">{formatBytes(file.size)}</span>
            )}
            {file?.content != null && (
              <button className="btn btn--xs btn--ghost" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
        )}

        <div className="code-body">
          {!selected ? (
            <div className="code-empty">Select a file to view its code.</div>
          ) : loading ? (
            <div className="code-empty">Loading…</div>
          ) : file?.error ? (
            <div className="code-empty code-empty--err">{file.error}</div>
          ) : file?.binary ? (
            <div className="code-empty">Binary file — not shown.</div>
          ) : file?.tooLarge ? (
            <div className="code-empty">
              File is too large to preview ({formatBytes(file.size)}).
            </div>
          ) : file?.content === '' ? (
            <div className="code-empty">Empty file.</div>
          ) : file?.content != null ? (
            <div className="code-editor-host">
              <Editor
                height="100%"
                theme={theme}
                language={monacoLanguage(selected)}
                value={file.content}
                loading={<div className="code-empty">Loading editor…</div>}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  fontSize: 12.5,
                  fontFamily: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
                  lineNumbers: 'on',
                  renderLineHighlight: 'all',
                  renderWhitespace: 'selection',
                  smoothScrolling: true,
                  automaticLayout: true,
                  wordWrap: 'off',
                  contextmenu: false,
                  scrollbar: { useShadows: false }
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The Code tab: a "Files" browser and a "History" timeline of changes, switched
 * with a segmented control. Both share one resolved Monaco theme so the editor
 * and diff editor stay in sync with the app's light/dark mode.
 */
export default function CodeViewer({
  project,
  refreshKey,
  onRequestDeploy,
  onSendToChat,
  openRequest,
  onSkillsChanged
}: Props): JSX.Element {
  const [tabState, setTabState] = useState(() => ({
    projectId: project.id,
    tab: readCodeTab(project.id)
  }))
  const tab = tabState.projectId === project.id ? tabState.tab : 'files'
  const [editorHint, setEditorHint] = useState(false)
  const theme = useEditorTheme()

  useEffect(() => {
    setTabState({ projectId: project.id, tab: readCodeTab(project.id) })
  }, [project.id])

  useEffect(() => {
    if (tabState.projectId === project.id) writeCodeTab(project.id, tabState.tab)
  }, [project.id, tabState])

  // An external open request always lands in the Files browser.
  useEffect(() => {
    if (openRequest?.path) setTabState({ projectId: project.id, tab: 'files' })
  }, [openRequest?.nonce, openRequest?.path, project.id])

  const openInEditor = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.openInEditor(project.id)
      setEditorHint(!res.opened)
    } catch {
      setEditorHint(true)
    }
  }, [project.id])

  return (
    <div className="code-shell">
      <div className="code-toolbar">
        <div className="code-seg" role="tablist" aria-label="Code view">
          <button
            className={`code-seg-btn${tab === 'files' ? ' code-seg-btn--on' : ''}`}
            role="tab"
            aria-selected={tab === 'files'}
            onClick={() => setTabState({ projectId: project.id, tab: 'files' })}
          >
            Files
          </button>
          <button
            className={`code-seg-btn${tab === 'history' ? ' code-seg-btn--on' : ''}`}
            role="tab"
            aria-selected={tab === 'history'}
            onClick={() => setTabState({ projectId: project.id, tab: 'history' })}
          >
            History
          </button>
          <button
            className={`code-seg-btn${tab === 'skills' ? ' code-seg-btn--on' : ''}`}
            role="tab"
            aria-selected={tab === 'skills'}
            onClick={() => setTabState({ projectId: project.id, tab: 'skills' })}
          >
            Skills
          </button>
        </div>
        {tab === 'history' && (
          <span className="code-toolbar-hint">
            A timeline of every change to your app — pick one to see what changed.
          </span>
        )}
        <span className="code-toolbar-spacer" />
        <button
          className="btn btn--xs btn--ghost code-open-editor"
          onClick={() => void openInEditor()}
          title="Open this project's folder in VS Code"
        >
          <EditorIcon className="btn-ico" />
          Open in VS Code
        </button>
      </div>
      {editorHint && (
        <div className="code-editor-hint" role="status">
          <span className="code-editor-hint-text">
            VS Code isn’t installed, so we opened the project folder instead.
          </span>
          <button
            className="code-editor-hint-link"
            onClick={() => void window.api.openExternal('https://code.visualstudio.com/')}
          >
            Get VS Code
          </button>
          <button
            className="code-editor-hint-x"
            onClick={() => setEditorHint(false)}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {tab === 'files' ? (
        <FilesView
          project={project}
          refreshKey={refreshKey}
          theme={theme}
          openRequest={openRequest}
        />
      ) : tab === 'history' ? (
        <HistoryView
          project={project}
          refreshKey={refreshKey}
          theme={theme}
          onRequestDeploy={onRequestDeploy}
          onSendToChat={onSendToChat}
        />
      ) : (
        <SkillsView project={project} onChanged={() => onSkillsChanged?.()} />
      )}
    </div>
  )
}
