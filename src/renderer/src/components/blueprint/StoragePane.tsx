import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { LocalFile, LocalFiles, LocalStorageFolder, LocalUser } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'
import { toLocalBackendError, type LocalBackendError } from '../../localBackend'
import { drawPdfPages } from '../../migration/pdfPages'
import { useToast } from '../../toast'
import { Codicon } from '../icons'
import { Empty, Pager, Problem } from './dataParts'
import {
  formatBytes,
  formatDate,
  lastPage,
  PAGE_SIZE,
  previewKind,
  type PreviewKind
} from './localData'

/** The most of a text file a preview shows. */
const MAX_TEXT_BYTES = 256 * 1024
/** The pages of a PDF a preview draws. */
const MAX_PDF_PAGES = 5

const KIND_ICON: Record<PreviewKind, string> = {
  image: 'file-media',
  video: 'device-camera-video',
  audio: 'music',
  pdf: 'file-pdf',
  text: 'file-text',
  none: 'file'
}

/** The files table's columns, by their `fields` keys. */
const FILE_COLUMNS = ['name', 'type', 'size', 'owner', 'updated'] as const

/** A storage folder as the Data explorer names it: by its `@blob` class, else by its own name. */
export function folderLabel(folder: LocalStorageFolder): string {
  return folder.displayName ?? folder.name
}

/** Who uploaded a file: a local user's username, else their id; nobody for anonymous uploads. */
function ownerOf(file: LocalFile, users: LocalUser[] | null): string | null {
  if (!file.ownerId) return null
  return users?.find((user) => user.id === file.ownerId)?.username ?? file.ownerId
}

/**
 * A storage folder's files, whatever its rules: a page of them in path order,
 * with their type, size, owner and last change; a preview of the one opened;
 * and deleting one file or clearing the folder (which the Data explorer confirms).
 */
export function FilesPane({
  projectId,
  folder,
  users,
  reloadKey,
  onClear,
  onDelete
}: {
  projectId: string
  folder: LocalStorageFolder
  /** The local users, to name the files' owners. */
  users: LocalUser[] | null
  reloadKey: string
  onClear: (files: number) => void
  onDelete: (file: LocalFile) => void
}): JSX.Element {
  const { t } = useTranslation('data')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<LocalFiles | null>(null)
  const [error, setError] = useState<LocalBackendError | null>(null)
  const [retry, setRetry] = useState(0)
  const [openPath, setOpenPath] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.local.files(projectId, folder.name, offset, PAGE_SIZE).then(
      (next) => {
        if (!alive) return
        // Files went away meanwhile: show the last page there is.
        if (offset > 0 && next.files.length === 0) {
          setOffset(lastPage(next.total))
          return
        }
        setPage(next)
        setError(null)
      },
      (reason: unknown) => {
        if (alive) setError(toLocalBackendError(reason))
      }
    )
    return () => {
      alive = false
    }
  }, [projectId, folder.name, offset, reloadKey, retry])

  const total = page?.total ?? folder.files
  // A deleted file's preview closes with it.
  const opened = page?.files.find((file) => file.path === openPath) ?? null
  let content: ReactNode
  if (error) {
    content = (
      <Problem title={t('files.readError')} error={error} onRetry={() => setRetry((n) => n + 1)} />
    )
  } else if (!page) {
    content = <div className="model-empty">{t('files.reading')}</div>
  } else if (page.files.length === 0) {
    content = <Empty icon="folder" title={t('files.emptyTitle')} sub={t('files.emptySub')} />
  } else {
    content = (
      <>
        <div className="bp-data-files">
          <div className="bp-data-scroll">
            <table className="bp-data-table">
              <thead>
                <tr>
                  {FILE_COLUMNS.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className={column === 'size' ? 'bp-data-num' : undefined}
                    >
                      <span className="bp-data-th">{t(`fields.${column}`)}</span>
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">{t('fields.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.files.map((file) => {
                  const on = file.path === openPath
                  const owner = ownerOf(file, users)
                  const updated = file.updatedAt ? formatDate(file.updatedAt) : null
                  const slash = file.path.lastIndexOf('/')
                  return (
                    <tr key={file.path} className={on ? 'bp-data-tr--on' : undefined}>
                      <td>
                        <button
                          type="button"
                          className="bp-data-file"
                          aria-pressed={on}
                          aria-label={t('files.previewLabel', { path: file.path })}
                          title={file.path}
                          onClick={() => setOpenPath(on ? null : file.path)}
                        >
                          <Codicon name={KIND_ICON[previewKind(file)]} />
                          <span className="bp-data-cell">
                            {slash >= 0 && (
                              <span className="bp-data-file-dir">
                                {file.path.slice(0, slash + 1)}
                              </span>
                            )}
                            {file.path.slice(slash + 1)}
                          </span>
                        </button>
                      </td>
                      <td className="bp-data-td--id">
                        <span className="bp-data-cell" title={file.contentType}>
                          {file.contentType}
                        </span>
                      </td>
                      <td className="bp-data-td--number">
                        <span
                          className="bp-data-cell"
                          title={t('size.bytes', { count: file.size })}
                        >
                          {formatBytes(file.size)}
                        </span>
                      </td>
                      <td className={owner ? undefined : 'bp-data-td--null'}>
                        <span
                          className="bp-data-cell"
                          title={file.ownerId ?? t('files.signedOutUpload')}
                        >
                          {owner ?? t('files.anonymous')}
                        </span>
                      </td>
                      <td className={updated ? 'bp-data-td--date' : 'bp-data-td--null'}>
                        <span className="bp-data-cell" title={file.updatedAt ?? undefined}>
                          {updated ?? '—'}
                        </span>
                      </td>
                      <td className="bp-data-td--actions">
                        <button
                          type="button"
                          className="bp-data-row-btn"
                          aria-label={t('files.deleteLabel', { path: file.path })}
                          onClick={() => onDelete(file)}
                        >
                          <Codicon name="trash" />
                          {t('actions.delete')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {opened && (
            <FilePreview
              key={`${opened.path}|${opened.updatedAt ?? ''}`}
              projectId={projectId}
              folder={folder}
              file={opened}
              owner={ownerOf(opened, users)}
              onClose={() => setOpenPath(null)}
              onDelete={() => onDelete(opened)}
            />
          )}
        </div>
        <Pager offset={offset} shown={page.files.length} total={page.total} onOffset={setOffset} />
      </>
    )
  }

  const label = folderLabel(folder)
  return (
    <section className="bp-data-main" aria-label={t('files.regionLabel', { folder: label })}>
      <div className="bp-data-main-head">
        <h3 className="bp-data-title">{label}</h3>
        {folder.displayName && folder.displayName !== folder.name && (
          <code className="bp-data-folder" title={t('files.folderNameTitle')}>
            {folder.name}
          </code>
        )}
        {!folder.displayName && (
          <span className="bp-chip" title={t('files.orphanTitle')}>
            {t('files.orphan')}
          </span>
        )}
        <span className="bp-data-meta">
          {t('files.meta', { count: total, size: formatBytes(folder.bytes) })}
        </span>
        <div className="model-toolbar-spacer" />
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => onClear(total)}
          disabled={total === 0}
        >
          <Codicon name="trash" />
          {t('files.clear')}
        </button>
      </div>
      {content}
    </section>
  )
}

/** What a preview shows once the file is read. */
type Shown =
  | { kind: 'image'; url: string }
  | { kind: 'video'; url: string }
  | { kind: 'audio'; url: string }
  | { kind: 'text'; text: string; clipped: boolean }
  | { kind: 'pdf'; pages: string[]; total: number }

/** The blob type a preview plays a file as: an SVG stored without a type still needs its own. */
function blobType(file: LocalFile): string {
  if (/\.svg$/i.test(file.name) && !file.contentType.startsWith('image/')) return 'image/svg+xml'
  return file.contentType
}

/** `bytes` (at most {@link MAX_TEXT_BYTES} of `file`) as text; JSON indented when all of it parses. */
function readText(bytes: ArrayBuffer, file: LocalFile): { text: string; clipped: boolean } {
  const clipped = file.size > bytes.byteLength
  const text = new TextDecoder().decode(bytes)
  if (!clipped && (/json/i.test(file.contentType) || /\.json$/i.test(file.name))) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), clipped }
    } catch {
      /* not JSON after all: show it as it is */
    }
  }
  return { text, clipped }
}

/**
 * A stored file: its details, a preview (images, video, audio, text, and the
 * first pages of a PDF), Save a copy and Delete.
 */
function FilePreview({
  projectId,
  folder,
  file,
  owner,
  onClose,
  onDelete
}: {
  projectId: string
  folder: LocalStorageFolder
  file: LocalFile
  owner: string | null
  onClose: () => void
  onDelete: () => void
}): JSX.Element {
  const { t } = useTranslation('data')
  const toast = useToast()
  const kind = previewKind(file)
  const [shown, setShown] = useState<Shown | null>(null)
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (kind === 'none') return
    let alive = true
    let url: string | null = null
    const limit = kind === 'text' ? MAX_TEXT_BYTES : undefined
    window.api.local.file(projectId, folder.name, file.path, limit).then(
      async (bytes) => {
        if (!alive) return
        if (kind === 'text') {
          setShown({ kind, ...readText(bytes, file) })
        } else if (kind === 'pdf') {
          const pages: string[] = []
          try {
            const total = await drawPdfPages(
              bytes,
              async (page, _index, count) => {
                pages.push(page.png)
                if (alive) setShown({ kind, pages: [...pages], total: count })
              },
              () => !alive || pages.length >= MAX_PDF_PAGES
            )
            if (alive) setShown({ kind, pages, total })
          } catch (reason) {
            if (alive) {
              setError({
                message: translator('data')('preview.pdfError', { reason: String(reason) })
              })
            }
          }
        } else {
          url = URL.createObjectURL(new Blob([bytes], { type: blobType(file) }))
          setShown({ kind, url })
        }
      },
      (reason: unknown) => {
        if (alive) setError(toLocalBackendError(reason))
      }
    )
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [projectId, folder.name, file, kind])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const where = await window.api.local.saveFile(projectId, folder.name, file.path)
      if (where) toast.success(t('preview.saved', { name: file.name, where }))
    } catch (reason) {
      const failure = toLocalBackendError(reason)
      toast.error(failure.message, { title: t('preview.saveError') })
    } finally {
      setSaving(false)
    }
  }

  let preview: ReactNode
  if (error) {
    preview = <Problem title={t('preview.error')} error={error} />
  } else if (kind === 'none') {
    preview = (
      <Empty
        icon="file"
        title={t('preview.noneTitle')}
        sub={t('preview.noneSub', { type: file.contentType })}
      />
    )
  } else if (!shown) {
    preview = (
      <div className="model-empty">
        {kind === 'pdf' ? t('preview.drawingPdf') : t('preview.reading')}
      </div>
    )
  } else if (shown.kind === 'image') {
    preview = <img className="bp-data-preview-img" src={shown.url} alt={file.name} />
  } else if (shown.kind === 'video') {
    preview = (
      <video className="bp-data-preview-media" src={shown.url} controls aria-label={file.name} />
    )
  } else if (shown.kind === 'audio') {
    preview = (
      <audio className="bp-data-preview-audio" src={shown.url} controls aria-label={file.name} />
    )
  } else if (shown.kind === 'text') {
    preview = (
      <>
        <pre className="bp-data-preview-text">{shown.text}</pre>
        {shown.clipped && (
          <p className="bp-data-preview-note">
            {t('preview.textClipped', { size: formatBytes(MAX_TEXT_BYTES) })}
          </p>
        )}
      </>
    )
  } else {
    preview = (
      <>
        {shown.pages.map((png, i) => (
          <img
            key={i}
            className="bp-data-preview-page"
            src={png}
            alt={t('preview.page', { page: i + 1, name: file.name })}
          />
        ))}
        {shown.total > shown.pages.length && shown.pages.length >= MAX_PDF_PAGES && (
          <p className="bp-data-preview-note">
            {t('preview.pdfClipped', { shown: shown.pages.length, total: shown.total })}
          </p>
        )}
      </>
    )
  }

  const fields = Object.entries(file.fields ?? {})
  const created = file.createdAt ? formatDate(file.createdAt) : null
  const updated = file.updatedAt ? formatDate(file.updatedAt) : null
  return (
    <aside className="bp-data-preview" aria-label={t('preview.label', { path: file.path })}>
      <div className="bp-data-preview-head">
        <Codicon name={KIND_ICON[kind]} />
        <span className="bp-data-preview-name" title={file.path}>
          {file.name}
        </span>
        <button
          type="button"
          className="model-tool-btn"
          onClick={() => void save()}
          disabled={saving}
          title={t('preview.saveTitle')}
        >
          <Codicon name="desktop-download" />
          {saving ? t('status.saving') : t('preview.save')}
        </button>
        <button type="button" className="model-tool-btn" onClick={onDelete}>
          <Codicon name="trash" />
          {t('actions.delete')}
        </button>
        <button
          type="button"
          className="bp-data-preview-close"
          onClick={onClose}
          aria-label={t('preview.close')}
        >
          <Codicon name="close" />
        </button>
      </div>
      <div className="bp-data-preview-body">{preview}</div>
      <dl className="bp-data-preview-facts">
        <dt>{t('fields.path')}</dt>
        <dd title={file.path}>{file.path}</dd>
        <dt>{t('fields.type')}</dt>
        <dd>{file.contentType}</dd>
        <dt>{t('fields.size')}</dt>
        <dd>
          {formatBytes(file.size)}
          {file.size >= 1024 && (
            <span className="bp-data-preview-dim"> ({t('size.bytes', { count: file.size })})</span>
          )}
        </dd>
        <dt>{t('fields.owner')}</dt>
        <dd>{owner ?? t('files.anonymous')}</dd>
        {created && (
          <>
            <dt>{t('fields.uploaded')}</dt>
            <dd title={file.createdAt ?? undefined}>{created}</dd>
          </>
        )}
        {updated && updated !== created && (
          <>
            <dt>{t('fields.updated')}</dt>
            <dd title={file.updatedAt ?? undefined}>{updated}</dd>
          </>
        )}
        {fields.map(([name, value]) => (
          <FieldFact key={name} name={name} value={value} />
        ))}
      </dl>
    </aside>
  )
}

/** One of the app's own fields of a file. */
function FieldFact({ name, value }: { name: string; value: unknown }): JSX.Element {
  const { t } = useTranslation('data')
  const text =
    value === null || value === undefined
      ? 'null'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return (
    <>
      <dt title={t('preview.fieldTitle')}>{name}</dt>
      <dd title={text}>{text}</dd>
    </>
  )
}
