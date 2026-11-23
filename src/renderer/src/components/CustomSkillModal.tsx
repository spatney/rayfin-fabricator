import { useEffect, useId, useState, type JSX } from 'react'
import Editor from '@monaco-editor/react'
// Point @monaco-editor/react at the locally-bundled Monaco (offline file:// renderer),
// same as the Code tab / SkillPreviewModal. Without this the editor hangs on the CDN.
import '../monaco'
import { Trans, useTranslation } from '../i18n'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import type { CustomSkillActionResult, CustomSkillPreview } from '@shared/ipc'

/** The library skill being edited, or absent when creating a new one. */
interface EditingSkill {
  id: string
  title: string
  description: string
  icon: string
}

interface Props {
  projectId: string
  editing?: EditingSkill | null
  /** Initial state of the "Save to my skill library" checkbox (create mode). */
  defaultToLibrary?: boolean
  onClose: () => void
  /** Called with the refreshed library after a successful save/import. */
  onSaved: (result: CustomSkillActionResult) => void
}

type Tab = 'author' | 'upload'

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

/** Slugify a title the same way the backend does, for the scaffold's frontmatter name. */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A well-formed starter SKILL.md so authors don't start from a blank file. */
function scaffold(title: string): string {
  const name = slugify(title) || 'my-skill'
  const heading = title.trim() || 'My skill'
  return `---
name: ${name}
description: "Use this skill when… describe the situations where the agent should apply it."
metadata:
  author: You
  version: 1.0.0
---
# ${heading}

Describe the guidance the agent should follow when this skill is active.
`
}

/**
 * Add or edit a custom skill for the global, reusable library. Two ways in:
 * **Write** a SKILL.md in-app (a small card form + a Monaco editor), or **Upload**
 * an existing skill folder / `.zip` / `SKILL.md`. Editing an existing library skill
 * opens straight into the Write tab, prefilled from its `meta.json` + SKILL.md.
 */
export default function CustomSkillModal({
  projectId,
  editing,
  defaultToLibrary = false,
  onClose,
  onSaved
}: Props): JSX.Element {
  useSuppressPreview()
  const { t } = useTranslation('skills')
  const theme = useEditorTheme()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  const [tab, setTab] = useState<Tab>('author')
  const [title, setTitle] = useState(editing?.title ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [icon, setIcon] = useState(editing?.icon ?? '🧩')
  const [content, setContent] = useState(() => (editing ? '' : scaffold('')))
  const [contentTouched, setContentTouched] = useState(Boolean(editing))
  const [toLibrary, setToLibrary] = useState(defaultToLibrary)
  const [loading, setLoading] = useState(Boolean(editing))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A picked upload awaiting confirmation (Upload tab), or null before picking. */
  const [uploadPreview, setUploadPreview] = useState<CustomSkillPreview | null>(null)

  // Load the existing SKILL.md when editing.
  useEffect(() => {
    if (!editing) return
    let alive = true
    void window.api.customSkills.source(editing.id).then((s) => {
      if (!alive) return
      if (s.ok && s.content != null) setContent(s.content)
      else if (!s.ok && s.error) setError(s.error)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [editing])

  // While the SKILL.md is still the untouched scaffold, keep it in sync with the title.
  useEffect(() => {
    if (!editing && !contentTouched) setContent(scaffold(title))
  }, [title, editing, contentTouched])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const canSave = title.trim().length > 0 && content.trim().length > 0 && !busy && !loading

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.customSkills.save(
        {
          id: editing?.id,
          title: title.trim(),
          description: description.trim(),
          icon: icon.trim() || undefined,
          content
        },
        projectId,
        toLibrary
      )
      if (result.ok) {
        onSaved(result)
        onClose()
      } else if (result.error) {
        setError(result.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (pick: () => Promise<CustomSkillPreview>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const preview = await pick()
      if (preview.ok) {
        setUploadPreview(preview)
      } else if (preview.error) {
        // A real failure. A cancelled picker returns cancelled:true — ignore it.
        setError(preview.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const addUpload = async (): Promise<void> => {
    if (!uploadPreview?.sourcePath) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.customSkills.addFromPath(
        projectId,
        uploadPreview.sourcePath,
        toLibrary
      )
      if (result.ok) {
        onSaved(result)
        onClose()
      } else if (result.error) {
        setError(result.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal modal--code custom-skill-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{editing ? t('custom.titleEdit') : t('custom.titleAdd')}</h2>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t('actions.close')}
            disabled={busy}
          >
            ✕
          </button>
        </div>

        {!editing && (
          <div className="custom-skill-tabs" role="tablist" aria-label={t('custom.tabs')}>
            <button
              role="tab"
              aria-selected={tab === 'author'}
              className={`custom-skill-tab${tab === 'author' ? ' custom-skill-tab--on' : ''}`}
              onClick={() => setTab('author')}
            >
              {t('custom.write')}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'upload'}
              className={`custom-skill-tab${tab === 'upload' ? ' custom-skill-tab--on' : ''}`}
              onClick={() => setTab('upload')}
            >
              {t('custom.upload')}
            </button>
          </div>
        )}

        <div className="modal-body custom-skill-body">
          {error && <div className="alert alert--error custom-skill-error">{error}</div>}

          {!editing && (
            <label
              className={`custom-skill-library-opt${
                toLibrary ? ' custom-skill-library-opt--on' : ''
              }`}
            >
              <span className="custom-skill-library-opt-text">
                <span className="custom-skill-library-opt-title">{t('custom.libraryTitle')}</span>
                <span className="custom-skill-library-opt-hint">{t('custom.libraryHint')}</span>
              </span>
              <span className={`switch${toLibrary ? ' switch--on' : ''}`}>
                <input
                  type="checkbox"
                  checked={toLibrary}
                  onChange={(e) => setToLibrary(e.target.checked)}
                  disabled={busy}
                />
                <span className="switch-knob" />
              </span>
            </label>
          )}

          {tab === 'author' ? (
            <div className="custom-skill-form">
              <div className="custom-skill-fields">
                <label className="custom-skill-field">
                  <span>{t('custom.titleLabel')}</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('custom.titlePlaceholder')}
                    disabled={busy}
                  />
                </label>
                <label className="custom-skill-field custom-skill-field--icon">
                  <span>{t('custom.iconLabel')}</span>
                  <input
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    maxLength={4}
                    aria-label={t('custom.iconAria')}
                    disabled={busy}
                  />
                </label>
              </div>
              <label className="custom-skill-field">
                <span>{t('custom.descriptionLabel')}</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('custom.descriptionPlaceholder')}
                  disabled={busy}
                />
              </label>

              <div className="custom-skill-editor-label">{t('custom.instructions')}</div>
              <div className="custom-skill-editor">
                {loading ? (
                  <div className="code-empty">{t('status.loading')}</div>
                ) : (
                  <Editor
                    height="100%"
                    theme={theme}
                    language="markdown"
                    value={content}
                    onChange={(value) => {
                      setContent(value ?? '')
                      setContentTouched(true)
                    }}
                    loading={<div className="code-empty">{t('editor.loading')}</div>}
                    options={{
                      readOnly: busy,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      fontSize: 12.5,
                      fontFamily: "'Cascadia Code', 'Consolas', ui-monospace, monospace",
                      lineNumbers: 'on',
                      wordWrap: 'on',
                      scrollbar: { useShadows: false }
                    }}
                  />
                )}
              </div>
              <p className="custom-skill-hint">
                <Trans t={t} i18nKey="custom.hint" components={{ code: <code /> }} />
              </p>
            </div>
          ) : uploadPreview ? (
            <div className="custom-skill-form">
              <div className="custom-skill-preview-card">
                <span className="custom-skill-preview-icon" aria-hidden="true">
                  {uploadPreview.icon}
                </span>
                <div className="custom-skill-preview-meta">
                  <div className="custom-skill-preview-title">{uploadPreview.title}</div>
                  <div className="custom-skill-preview-desc">{uploadPreview.description}</div>
                  {uploadPreview.referenceCount > 0 && (
                    <div className="custom-skill-preview-refs">
                      {t('custom.references', { count: uploadPreview.referenceCount })}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn--xs btn--ghost"
                  disabled={busy}
                  onClick={() => setUploadPreview(null)}
                >
                  {t('custom.chooseDifferent')}
                </button>
              </div>
              <div className="custom-skill-editor-label">{t('custom.previewLabel')}</div>
              <div className="custom-skill-editor">
                <Editor
                  height="100%"
                  theme={theme}
                  language="markdown"
                  value={uploadPreview.content ?? ''}
                  loading={<div className="code-empty">{t('editor.loading')}</div>}
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
              <p className="custom-skill-hint">{t('custom.reviewHint')}</p>
            </div>
          ) : (
            <div className="custom-skill-upload">
              <p className="custom-skill-upload-lead">
                <Trans t={t} i18nKey="custom.uploadLead" components={{ code: <code /> }} />
              </p>
              <div className="custom-skill-upload-actions">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void runImport(() => window.api.customSkills.pickFolderPreview())}
                >
                  {t('custom.chooseFolder')}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void runImport(() => window.api.customSkills.pickFilePreview())}
                >
                  {t('custom.chooseFile')}
                </button>
              </div>
              {busy && <p className="custom-skill-hint">{t('custom.reading')}</p>}
            </div>
          )}
        </div>

        {(tab === 'author' || (tab === 'upload' && uploadPreview)) && (
          <div className="modal-footer">
            <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {t('actions.cancel')}
            </button>
            <button
              className="btn btn--primary"
              onClick={() => void (tab === 'author' ? save() : addUpload())}
              disabled={tab === 'author' ? !canSave : busy}
            >
              {busy ? (
                <span className="btn-busy">
                  <span className="btn-spin" aria-hidden="true" />
                  {t('status.saving')}
                </span>
              ) : editing ? (
                t('custom.saveChanges')
              ) : (
                t('custom.addSkill')
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
