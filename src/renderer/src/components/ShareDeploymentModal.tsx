import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  FabricDeployment,
  FabricDirectoryPerson,
  FabricShareGrant,
  FabricShareModelGrant,
  FabricShareResult,
  SemanticModelRef,
  StudioProject
} from '@shared/ipc'
import { useSuppressPreview } from '../overlay'
import { useModalFocus } from '../modalFocus'
import { useToast } from '../toast'
import { Codicon } from './icons'

interface Props {
  project: StudioProject
  /** The deployment being shared (its `workspaceId` hosts the app). */
  deployment: FabricDeployment
  onClose: () => void
  /** Notify the parent that a Fabric/Azure sign-in just succeeded. */
  onSignedIn?: () => void
}

/** A chosen recipient: always an email, with a friendly name when resolved. */
interface Recipient {
  email: string
  displayName?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Case-insensitive workspace equality (ids can disagree on GUID casing). */
function sameWorkspace(a?: string, b?: string): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

/** A grant's status as an icon + label + tone for a result row. */
function grantStatus(g: FabricShareGrant | FabricShareModelGrant): {
  icon: string
  label: string
  tone: 'ok' | 'skip' | 'error'
} {
  if (!g.ok) return { icon: 'error', label: g.error ?? 'Failed', tone: 'error' }
  if (g.skipped) return { icon: 'check', label: 'Already had access', tone: 'skip' }
  return { icon: 'check', label: 'Shared', tone: 'ok' }
}

/** Teams-like avatar palette; a stable colour is picked per email. */
const AVATAR_COLORS = [
  '#5b8def',
  '#46ccb0',
  '#e0a878',
  '#c8a6f0',
  '#f2749b',
  '#5fc6cc',
  '#8fd6a0',
  '#f5c451'
]

function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

/** Up-to-two-letter initials from a display name (or the email's local part). */
function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0] : nameOrEmail
  const parts = base.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (base.slice(0, 2) || '?').toUpperCase()
}

function Avatar({ name, email }: { name?: string; email: string }): JSX.Element {
  return (
    <span className="share-avatar" style={{ backgroundColor: avatarColor(email) }} aria-hidden="true">
      {initials(name || email)}
    </span>
  )
}

/** Bold the matched substring of `q` within `text` (first occurrence). */
function highlight(text: string, q: string): React.ReactNode {
  const query = q.trim()
  if (!text || !query) return text
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <span className="share-hl">{text.slice(i, i + query.length)}</span>
      {text.slice(i + query.length)}
    </>
  )
}

/**
 * Share a deployed app with tenant users/groups. A people-picker (name/email
 * autocomplete backed by Microsoft Graph) grants each recipient Contributor on
 * the app's hosting workspace and — for every semantic model the app uses in a
 * *different* workspace — Build on that model. Reuses the existing re-auth
 * patterns for an expired Fabric session (`needsLogin`) or a signed-out Azure CLI
 * (`needsAz`, required to resolve recipients).
 */
export default function ShareDeploymentModal({
  project,
  deployment,
  onClose,
  onSignedIn
}: Props): JSX.Element {
  const toast = useToast()
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [draft, setDraft] = useState('')
  const [models, setModels] = useState<SemanticModelRef[] | null>(null)
  const [sharing, setSharing] = useState(false)
  const [reauthing, setReauthing] = useState(false)
  const [result, setResult] = useState<FabricShareResult | null>(null)

  // Directory autocomplete (Graph people search).
  const [suggestions, setSuggestions] = useState<FabricDirectoryPerson[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [searching, setSearching] = useState(false)
  const [activeSuggest, setActiveSuggest] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const searchSeq = useRef(0)

  const busy = sharing || reauthing
  const workspaceId = deployment.workspaceId?.trim() || ''
  const appLabel = deployment.name || deployment.workspaceName
  const appUrl = deployment.hostingUrl || deployment.apiUrl || undefined

  const buildModels = useMemo(
    () => (models ?? []).filter((m) => !sameWorkspace(m.workspaceId, workspaceId)),
    [models, workspaceId]
  )

  useEffect(() => {
    let alive = true
    void window.api.fabric.projectSemanticModels(project.id).then((m) => {
      if (alive) setModels(m)
    })
    return () => {
      alive = false
    }
  }, [project.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || busy) return
      // Escape closes the suggestions first, then the dialog.
      if (showSuggest) setShowSuggest(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, showSuggest])

  // Debounced directory search. The dropdown opens immediately with a spinner so
  // typing feels responsive; it degrades to an "add email" / "no matches" row
  // (and, silently, to nothing when `az` is signed out — submit still prompts).
  useEffect(() => {
    const q = draft.trim()
    // Spaces are allowed — people search by full name ("Ada Lovelace"). Only a
    // comma/semicolon (explicit email separators) skips the lookup; those are
    // handled as a bulk commit instead.
    if (q.length < 1 || /[,;]/.test(q)) {
      setSuggestions([])
      setShowSuggest(false)
      setSearching(false)
      return
    }
    const seq = ++searchSeq.current
    setShowSuggest(true)
    setSearching(true)
    const t = setTimeout(() => {
      void window.api.fabric
        .directorySearch(q)
        .then((res) => {
          if (seq !== searchSeq.current) return
          const taken = new Set(recipients.map((r) => r.email.toLowerCase()))
          const people = (res.ok ? res.people : []).filter(
            (p) => p.email && !taken.has(p.email.toLowerCase())
          )
          setSuggestions(people)
          setActiveSuggest(people.length ? 0 : -1)
          setSearching(false)
        })
        .catch(() => {
          if (seq !== searchSeq.current) return
          setSuggestions([])
          setSearching(false)
        })
    }, 150)
    return () => clearTimeout(t)
  }, [draft, recipients])

  // Keep the keyboard-highlighted suggestion scrolled into view.
  useEffect(() => {
    if (activeSuggest < 0) return
    const items = listRef.current?.querySelectorAll<HTMLElement>('.share-suggest-item')
    const el = items?.[activeSuggest]
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [activeSuggest])

  function addRecipients(next: Recipient[]): void {
    if (next.length === 0) return
    setRecipients((prev) => {
      const merged = [...prev]
      for (const r of next) {
        const lower = r.email.toLowerCase()
        if (!merged.some((e) => e.email.toLowerCase() === lower)) merged.push(r)
      }
      return merged
    })
    setDraft('')
  }

  /** Commit free-typed text as recipients. Splits on comma/semicolon/newline;
   * a chunk is only split on spaces when every space-separated part is itself an
   * email, so a typed name ("Ada Lovelace") stays intact rather than becoming two
   * bad chips. */
  function addFromText(raw: string): void {
    const out: Recipient[] = []
    for (const chunk of raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
      const parts = chunk.split(/\s+/)
      if (parts.length > 1 && parts.every((p) => EMAIL_RE.test(p))) {
        for (const email of parts) out.push({ email })
      } else {
        out.push({ email: chunk })
      }
    }
    addRecipients(out)
  }

  function selectPerson(p: FabricDirectoryPerson): void {
    if (p.email) addRecipients([{ email: p.email, displayName: p.displayName }])
    setSuggestions([])
    setShowSuggest(false)
    setActiveSuggest(-1)
    inputRef.current?.focus()
  }

  function removeRecipient(email: string): void {
    setRecipients((prev) => prev.filter((r) => r.email !== email))
  }

  function onDraftKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (showSuggest && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveSuggest((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveSuggest((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' && activeSuggest >= 0) {
        e.preventDefault()
        selectPerson(suggestions[activeSuggest])
        return
      }
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      addFromText(draft)
    } else if (e.key === 'Backspace' && !draft && recipients.length) {
      setRecipients((prev) => prev.slice(0, -1))
    }
  }

  const pendingDraft = draft.trim()
  const validDraft = EMAIL_RE.test(pendingDraft)
  const invalidEmails = recipients.map((r) => r.email).filter((e) => !EMAIL_RE.test(e))
  // A well-formed but not-yet-committed draft counts as a recipient too.
  const effectiveCount = recipients.length + (validDraft ? 1 : 0)
  const canShare = effectiveCount > 0 && invalidEmails.length === 0 && !!workspaceId && !busy

  async function runShare(): Promise<void> {
    // Fold a valid pending draft into the recipient list before sharing.
    let list = recipients
    if (validDraft && !recipients.some((r) => r.email.toLowerCase() === pendingDraft.toLowerCase())) {
      list = [...recipients, { email: pendingDraft }]
      setRecipients(list)
      setDraft('')
    }
    const emails = list.map((r) => r.email)
    if (emails.length === 0 || invalidEmails.length > 0 || !workspaceId) return
    setSharing(true)
    try {
      const res = await window.api.fabric.shareApp(project.id, workspaceId, emails)
      setResult(res)
      if (res.ok) {
        toast.success(`Shared with ${emails.length} recipient${emails.length === 1 ? '' : 's'}.`, {
          title: 'App shared'
        })
      }
    } catch (err) {
      setResult({ ok: false, recipients: [], error: String(err) })
    } finally {
      setSharing(false)
    }
  }

  /** Re-authenticate (Fabric or Azure) then retry the share automatically. */
  async function reauthAndRetry(kind: 'rayfin' | 'az'): Promise<void> {
    setReauthing(true)
    try {
      const login =
        kind === 'az' ? await window.api.auth.loginAz() : await window.api.auth.loginRayfin()
      if (!login.ok) {
        toast.error(login.error ?? 'Sign-in did not complete. Please try again.', {
          title: 'Sign-in failed'
        })
        return
      }
      onSignedIn?.()
      setResult(null)
    } finally {
      setReauthing(false)
    }
    await runShare()
  }

  /** Copy the deployed app's link to the clipboard (to send to recipients). */
  async function copyLink(): Promise<void> {
    if (!appUrl) return
    try {
      await navigator.clipboard.writeText(appUrl)
      toast.success('App link copied to clipboard.', { title: 'Copied' })
    } catch {
      toast.error('Could not copy the link.', { title: 'Copy failed' })
    }
  }

  const needsLogin = result && !result.ok && result.needsLogin
  const needsAz = result && !result.ok && result.needsAz
  const globalError = result && !result.ok && result.error && !needsLogin && !needsAz

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>Share app</h2>
        </div>

        <div className="modal-body">
          <p className="share-intro">
            Grant people in your tenant access to <strong>{appLabel}</strong>. Each recipient gets
            the <strong>Contributor</strong> role on its workspace
            {buildModels.length > 0 && (
              <>
                {' '}
                and <strong>Build</strong> access to the semantic model
                {buildModels.length === 1 ? '' : 's'} it uses
              </>
            )}
            .
          </p>

          <div className="share-field">
            <label className="share-label" htmlFor={`${titleId}-input`}>
              People or groups
            </label>
            <div className="share-combo">
              <div className="share-chips" onClick={() => inputRef.current?.focus()}>
                {recipients.map((r) => {
                  const bad = !EMAIL_RE.test(r.email)
                  return (
                    <span
                      key={r.email}
                      className={`share-chip${bad ? ' share-chip--bad' : ''}`}
                      title={r.email}
                    >
                      {!bad && <Avatar name={r.displayName} email={r.email} />}
                      <span className="share-chip-name">{r.displayName || r.email}</span>
                      <button
                        type="button"
                        className="share-chip-x"
                        aria-label={`Remove ${r.displayName || r.email}`}
                        onClick={() => removeRecipient(r.email)}
                        disabled={busy}
                      >
                        <Codicon name="close" />
                      </button>
                    </span>
                  )
                })}
                <input
                  id={`${titleId}-input`}
                  ref={inputRef}
                  className="share-chip-input"
                  type="text"
                  autoFocus
                  spellCheck={false}
                  role="combobox"
                  aria-expanded={showSuggest}
                  aria-autocomplete="list"
                  placeholder={recipients.length ? '' : 'Search by name or email'}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onDraftKeyDown}
                  onBlur={() => {
                    // Commit a fully-typed email on blur; keep partial text so an
                    // accidental blur doesn't create a bad chip.
                    if (validDraft) addFromText(draft)
                    setShowSuggest(false)
                  }}
                />
              </div>
              {showSuggest && (
                <ul className="share-suggest" role="listbox" ref={listRef}>
                  {searching && (
                    <li className="share-suggest-state">
                      <span className="btn-spin" aria-hidden="true" /> Searching…
                    </li>
                  )}
                  {!searching &&
                    suggestions.map((p, i) => (
                      <li
                        key={p.id ?? p.email}
                        role="option"
                        aria-selected={i === activeSuggest}
                        className={`share-suggest-item${i === activeSuggest ? ' share-suggest-item--active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveSuggest(i)}
                        onClick={() => selectPerson(p)}
                      >
                        <Avatar name={p.displayName} email={p.email ?? ''} />
                        <span className="share-suggest-text">
                          <span className="share-suggest-name">
                            {highlight(p.displayName || p.email || '', draft)}
                          </span>
                          {p.displayName && p.email && (
                            <span className="share-suggest-mail">{highlight(p.email, draft)}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  {!searching &&
                    suggestions.length === 0 &&
                    (validDraft ? (
                      <li
                        className="share-suggest-item share-suggest-add"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          addFromText(draft)
                          inputRef.current?.focus()
                        }}
                      >
                        <span className="share-avatar share-avatar--add" aria-hidden="true">
                          <Codicon name="add" />
                        </span>
                        <span className="share-suggest-text">
                          <span className="share-suggest-name">Add “{pendingDraft}”</span>
                        </span>
                      </li>
                    ) : (
                      <li className="share-suggest-state">No matches</li>
                    ))}
                </ul>
              )}
            </div>
            {invalidEmails.length > 0 && (
              <span className="share-hint share-hint--bad">
                Not a valid email: {invalidEmails.join(', ')}
              </span>
            )}
          </div>

          {/* What the share will grant, so it's transparent before submitting. */}
          <div className="share-targets">
            <div className="share-target">
              <Codicon name="globe" />
              <span className="share-target-main">{deployment.workspaceName}</span>
              <span className="share-target-tag">Contributor</span>
            </div>
            {models === null ? (
              <div className="share-target share-target--muted">Checking semantic models…</div>
            ) : (
              (models ?? []).map((m) => {
                const build = !sameWorkspace(m.workspaceId, workspaceId)
                return (
                  <div key={`${m.alias}-${m.itemId}`} className="share-target">
                    <Codicon name="database" />
                    <span className="share-target-main">{m.alias}</span>
                    <span className={`share-target-tag${build ? '' : ' share-target-tag--muted'}`}>
                      {build ? 'Build' : 'Covered by workspace'}
                    </span>
                  </div>
                )
              })
            )}
          </div>

          {needsLogin && (
            <div className="share-banner">
              <span>Your Fabric session expired. Sign in to finish sharing.</span>
              <button
                className="btn btn--sm btn--primary"
                disabled={busy}
                onClick={() => void reauthAndRetry('rayfin')}
              >
                {reauthing ? 'Signing in…' : 'Sign in & retry'}
              </button>
            </div>
          )}
          {needsAz && (
            <div className="share-banner">
              <span>Azure CLI sign-in is required to look up recipients in your directory.</span>
              <button
                className="btn btn--sm btn--primary"
                disabled={busy}
                onClick={() => void reauthAndRetry('az')}
              >
                {reauthing ? 'Signing in…' : 'Sign in to Azure & retry'}
              </button>
            </div>
          )}
          {globalError && <div className="share-banner share-banner--bad">{result?.error}</div>}

          {result && result.recipients.length > 0 && (
            <ul className="share-results">
              {result.recipients.map((r) => {
                const app = grantStatus(r.app)
                return (
                  <li key={r.email} className="share-result">
                    <div className="share-result-head">
                      <span className="share-result-email">{r.email}</span>
                    </div>
                    <ul className="share-result-lines">
                      <li className={`share-line share-line--${app.tone}`}>
                        <Codicon name={app.icon} />
                        <span className="share-line-what">App</span>
                        <span className="share-line-status">{app.label}</span>
                      </li>
                      {r.models.map((m) => {
                        const s = grantStatus(m)
                        return (
                          <li
                            key={`${m.alias}-${m.itemId}`}
                            className={`share-line share-line--${s.tone}`}
                          >
                            <Codicon name={s.icon} />
                            <span className="share-line-what">{m.alias ?? 'Model'}</span>
                            <span className="share-line-status">{s.label}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="modal-footer">
          {result?.ok && appUrl && (
            <button className="btn btn--ghost share-copy-link" onClick={() => void copyLink()}>
              <Codicon name="link" /> Copy link
            </button>
          )}
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {result?.ok ? 'Done' : 'Cancel'}
          </button>
          <button className="btn btn--primary" onClick={() => void runShare()} disabled={!canShare}>
            {sharing ? (
              <span className="btn-busy">
                <span className="btn-spin" aria-hidden="true" />
                Sharing…
              </span>
            ) : result ? (
              'Share again'
            ) : (
              'Share'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
