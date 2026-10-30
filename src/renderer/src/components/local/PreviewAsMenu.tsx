/**
 * **Preview as**: who the app in the preview signs in as on this computer.
 *
 * Where it belongs: the preview toolbar (`PreviewPane.tsx`), next to the Local /
 * Published switch (after the local status pill), and only in the Local view
 * while the local backend is running and no chat turn runs (Copilot may be
 * checking the app as someone then). The local Fabric host view (Fabric on)
 * signs the app in with the host page's own form, not as this identity, so keep
 * it disabled there:
 *
 * ```tsx
 * {localView && local?.state === 'running' && !turnRunning && (
 *   <PreviewAsMenu
 *     key={project.id}
 *     projectId={project.id}
 *     disabled={transitioning || designActive || previewMode === 'fabric'}
 *   />
 * )}
 * ```
 *
 * It needs nothing else: it reads and sets the backend's sign-in identity
 * (`window.api.local`), hides the native preview while its menu is open (the
 * menu draws over it), and after a switch clears the preview page's storage and
 * reloads it (`window.api.preview.resetSiteData`).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { LocalIdentity, LocalIdentityRequest, LocalStatus, LocalUser } from '@shared/ipc'
import { localBackendStore, toLocalBackendError, type LocalBackendError } from '../../localBackend'
import { moveMenuFocus } from '../../menuFocus'
import { useSuppressPreview } from '../../overlay'
import { Codicon } from '../icons'
import './previewAs.css'

interface Props {
  projectId: string
  /** Not now: the button stays, but can't open, and an open menu closes. */
  disabled?: boolean
  /** The app signs in as someone else now, and the preview loaded again. */
  onSwitched?: () => void
}

/** Who the app in the preview signs in as. */
type Who = { kind: 'developer' } | { kind: 'none' } | { kind: 'user'; username: string }

/** What went wrong, in the backend's words. */
interface Failure {
  message: string
  hint: string | null
}

/** A switch on its way: the menu item it came from, where it goes, and how far it got. */
interface Pending {
  key: string
  who: Who
  adding: boolean
  step: 'identity' | 'reload'
}

/** What the backend said, for one project. */
interface Known {
  projectId: string
  identity: LocalIdentity | null
  users: LocalUser[] | null
}

const ITEM = '[role^="menuitem"]'
/** Keep in step with `.pva-pop`'s width in previewAs.css. */
const POP_WIDTH = 300
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function keyOf(who: Who | null): string {
  if (!who) return ''
  return who.kind === 'user' ? `user:${who.username.toLowerCase()}` : who.kind
}

/** The identity Fabricator keeps for the backend, else the one it started with. */
function whoFromStatus(status: LocalStatus | null): Who | null {
  const flag = status?.signInAs
  if (flag === 'developer' || flag === 'none') return { kind: flag }
  if (flag?.startsWith('user:')) return { kind: 'user', username: flag.slice('user:'.length) }
  const ready = status?.ready?.signInAs
  if (ready?.kind === 'developer' || ready?.kind === 'none') return { kind: ready.kind }
  if (ready?.kind === 'user' && typeof ready.username === 'string') {
    return { kind: 'user', username: ready.username }
  }
  return null
}

function whoFromIdentity(identity: LocalIdentity, fallback: Who | null): Who {
  if (identity.kind !== 'user') return { kind: identity.kind }
  // The user doesn't exist until its first sign-in, so the identity has no name for it yet.
  const named = fallback?.kind === 'user' ? fallback.username : ''
  return { kind: 'user', username: identity.user?.username ?? named }
}

/** The button's text: "You", "Signed out" or the test user's name. */
function whoLabel(who: Who | null): string {
  if (!who) return 'Preview as'
  if (who.kind === 'developer') return 'You'
  if (who.kind === 'none') return 'Signed out'
  return who.username || 'Test user'
}

function whoSentence(who: Who): string {
  if (who.kind === 'developer') return 'The preview is signed in as you.'
  if (who.kind === 'none') return 'The preview isn’t signed in.'
  return `The preview is signed in as ${whoLabel(who)}.`
}

/** How the app looks after a switch to `who`, for "Reload the preview to see the app …". */
function seenAs(who: Who): string {
  if (who.kind === 'developer') return 'as you'
  if (who.kind === 'none') return 'signed out'
  return `as ${whoLabel(who)}`
}

function progress(pending: Pending): string {
  if (pending.step === 'reload') return 'Reloading the preview…'
  if (pending.who.kind === 'none') return 'Signing out…'
  if (pending.adding) return `Adding ${whoLabel(pending.who)}…`
  return pending.who.kind === 'developer'
    ? 'Signing in as you…'
    : `Signing in as ${whoLabel(pending.who)}…`
}

/**
 * Your account: the one the backend signed you in as in this run, else (until
 * then, or while you preview as someone else) the one it knows from before,
 * Microsoft Entra first.
 */
function yourAccount(identity: LocalIdentity | null, users: LocalUser[]): LocalUser | null {
  if (identity?.kind === 'developer' && identity.user) return identity.user
  const yours = users.filter((user) => user.developer)
  const entra = yours.filter((user) => user.signIn.includes('entra'))
  return entra[entra.length - 1] ?? yours[yours.length - 1] ?? null
}

function accountDetail(account: LocalUser | null): string {
  if (!account) return 'Your Microsoft Entra account, or a local account'
  const name = account.email ?? account.username
  // Non-breaking spaces keep the kind of account on one line when the detail wraps.
  return account.signIn.includes('entra')
    ? `${name} · Microsoft\u00a0Entra\u00a0ID`
    : `${name} · local\u00a0account`
}

/** Why `email` can't be a new test user, or `null` when it can. */
function emailProblem(email: string, users: LocalUser[]): string | null {
  if (!email) return 'Enter an email address.'
  if (!EMAIL.test(email)) return 'Enter an email address, like ana@example.com.'
  const existing = users.find(
    (user) => sameName(user.username, email) || (user.email !== null && sameName(user.email, email))
  )
  if (existing?.developer) return 'That’s your own account. Choose You instead.'
  if (existing) return `${existing.username} is already a test user.`
  return null
}

/** `users` with a new test user at the end (the backend lists them oldest first). */
function withUser(users: LocalUser[] | null, user: LocalUser | null): LocalUser[] | null {
  if (!users || !user || user.developer || users.some((known) => known.id === user.id)) return users
  return [...users, user]
}

/** Under the trigger, lined up with its left edge, and kept on screen. */
function placeUnder(trigger: DOMRect): CSSProperties {
  const left = Math.max(8, Math.min(trigger.left, window.innerWidth - POP_WIDTH - 8))
  const top = trigger.bottom + 6
  return { left, top, maxHeight: Math.max(220, window.innerHeight - top - 12) }
}

function failureOf(error: LocalBackendError): Failure {
  return { message: error.message, hint: error.hint ?? null }
}

/**
 * Preview as: a toolbar button that says who the app in the preview signs in
 * as (You, Signed out or a test user), and a menu to switch: you, each local
 * test user, signed out, or a new test user by email. A switch sets the local
 * backend's sign-in identity, which signs every local session out, then clears
 * the preview page's storage and reloads it, so the app signs in again as the
 * new identity. See the top of this file for where it goes.
 */
export default function PreviewAsMenu({
  projectId,
  disabled = false,
  onSwitched
}: Props): JSX.Element {
  const status = useSyncExternalStore(
    localBackendStore.subscribe,
    () => localBackendStore.get(projectId) ?? null
  )
  const [known, setKnown] = useState<Known | null>(null)
  const [loadFailure, setLoadFailure] = useState<Failure | null>(null)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<CSSProperties>({})
  const [pending, setPending] = useState<Pending | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const addItemRef = useRef<HTMLButtonElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Which item takes focus when the menu opens. */
  const focusOnOpen = useRef<'checked' | 'first' | 'last'>('checked')
  /** Bumped by every load and switch, so an answer that comes late is dropped. */
  const loads = useRef(0)
  /** A switch is on its way (set before its first render, so a second press can't start another). */
  const switching = useRef(false)
  const openRef = useRef(false)
  const menuId = useId()
  const inputId = useId()
  const invalidId = useId()

  // The menu draws over the preview, whose native surface paints above all HTML.
  useSuppressPreview(open)

  useEffect(() => {
    openRef.current = open
  }, [open])

  const mine = known?.projectId === projectId ? known : null
  const identity = mine?.identity ?? null
  const users = mine?.users ?? null
  const fallback = whoFromStatus(status)
  const who = identity ? whoFromIdentity(identity, fallback) : fallback

  const remember = useCallback(
    (update: (known: Known) => Partial<Known>): void =>
      setKnown((previous) => {
        const base =
          previous?.projectId === projectId ? previous : { projectId, identity: null, users: null }
        return { ...base, ...update(base) }
      }),
    [projectId]
  )

  const load = useCallback(
    async (withUsers: boolean): Promise<void> => {
      const ticket = ++loads.current
      try {
        const [nextIdentity, nextUsers] = await Promise.all([
          window.api.local.identity(projectId),
          withUsers ? window.api.local.users(projectId) : Promise.resolve(null)
        ])
        if (ticket !== loads.current) return
        remember(() =>
          nextUsers ? { identity: nextIdentity, users: nextUsers } : { identity: nextIdentity }
        )
        setLoadFailure(null)
      } catch (reason) {
        if (ticket === loads.current) setLoadFailure(failureOf(toLocalBackendError(reason)))
      }
    },
    [projectId, remember]
  )

  const close = useCallback((refocus: boolean): void => {
    setOpen(false)
    setAdding(false)
    setDraft('')
    setInvalid(null)
    setFailure(null)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // Another project's menu starts closed.
  useEffect(() => {
    setOpen(false)
    setAdding(false)
    setDraft('')
    setInvalid(null)
    setFailure(null)
    setLoadFailure(null)
  }, [projectId])

  // Who it signs in as, for the button (also while it can't switch): at first,
  // and whenever the backend reports another identity or another start.
  const statusKey = [status?.state, status?.signInAs, status?.ready?.time].join('|')
  useEffect(() => {
    void load(false)
  }, [load, statusKey])

  // The menu shows the latest test users.
  useEffect(() => {
    if (open) void load(true)
  }, [open, load])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open, close])

  // A press anywhere else closes the menu; so does resizing the window, which
  // would leave it behind its button.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) close(false)
    }
    const onResize = (): void => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])
      const target =
        focusOnOpen.current === 'last'
          ? items[items.length - 1]
          : focusOnOpen.current === 'first'
            ? items[0]
            : (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  const openMenu = (focus: 'checked' | 'first' | 'last' = 'checked'): void => {
    if (disabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPlacement(placeUnder(rect))
    focusOnOpen.current = focus
    setOpen(true)
  }

  const closeForm = (): void => {
    setAdding(false)
    setDraft('')
    setInvalid(null)
    addItemRef.current?.focus()
  }

  const switchTo = async (
    key: string,
    next: Who,
    request: LocalIdentityRequest,
    isNew = false
  ): Promise<void> => {
    if (switching.current || disabled) return
    if (key === keyOf(who) && !isNew) {
      close(true)
      return
    }
    switching.current = true
    setPending({ key, who: next, adding: isNew, step: 'identity' })
    setFailure(null)
    let switched = false
    try {
      const answer = await window.api.local.setIdentity(projectId, request)
      // What loads asked before this answer may be the previous identity.
      loads.current += 1
      switched = true
      remember((base) => ({ identity: answer, users: withUser(base.users, answer.user) }))
      setPending({ key, who: next, adding: isNew, step: 'reload' })
      await window.api.preview.resetSiteData()
      if (openRef.current) close(true)
      onSwitched?.()
    } catch (reason) {
      const error = toLocalBackendError(reason)
      setFailure(
        switched
          ? { message: error.message, hint: `Reload the preview to see the app ${seenAs(next)}.` }
          : failureOf(error)
      )
      // Show the menu as the backend has it now (a test user may be gone, say).
      if (openRef.current) void load(true)
    } finally {
      switching.current = false
      setPending(null)
    }
  }

  const submitNewUser = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (switching.current) return
    const email = draft.trim()
    const problem = emailProblem(email, users ?? [])
    if (problem) {
      setInvalid(problem)
      inputRef.current?.focus()
      return
    }
    setInvalid(null)
    void switchTo(
      `user:${email.toLowerCase()}`,
      { kind: 'user', username: email },
      { kind: 'user', user: email, create: true },
      true
    )
  }

  /** Tab leaves the menu from its button, as from any menu button. */
  const leave = (): void => {
    triggerRef.current?.focus()
    close(false)
  }

  const onTab = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const form = formRef.current
    if (form?.contains(target)) {
      const controls = Array.from(form.querySelectorAll<HTMLElement>('input, button'))
      if (event.shiftKey && target === controls[0]) {
        event.preventDefault()
        addItemRef.current?.focus()
      } else if (!event.shiftKey && target === controls[controls.length - 1]) {
        leave()
      }
      return
    }
    // The menu's items are one stop; the form below them is the next.
    if (!event.shiftKey && adding && menuRef.current?.contains(target)) {
      event.preventDefault()
      inputRef.current?.focus()
      return
    }
    leave()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const onTrigger = event.target === triggerRef.current
    if (!open) {
      if (onTrigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        openMenu(event.key === 'ArrowUp' ? 'last' : 'checked')
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (adding && formRef.current?.contains(event.target as Node)) closeForm()
      else close(true)
      return
    }
    if (event.key === 'Tab') {
      onTab(event)
      return
    }
    if (onTrigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])
      items[event.key === 'ArrowUp' ? items.length - 1 : 0]?.focus()
    }
  }

  // A press on the menu's text keeps the keyboard where it was.
  const keepFocus = (event: MouseEvent<HTMLDivElement>): void => {
    if (!(event.target as HTMLElement).closest('button, input, label')) event.preventDefault()
  }

  const label = whoLabel(who)
  const busy = pending !== null
  const current = keyOf(who)
  const account = yourAccount(identity, users ?? [])
  const testUsers = (users ?? []).filter((user) => !user.developer).map((user) => user.username)
  // The test user it signs in as, before its first sign-in creates it.
  if (
    who?.kind === 'user' &&
    who.username &&
    !testUsers.some((name) => sameName(name, who.username))
  ) {
    testUsers.push(who.username)
  }
  const shownFailure = failure ?? (open ? loadFailure : null)
  // A switch failed after its menu was closed: the button says so until the menu shows it.
  const missed = !open && !pending ? failure : null
  const title = pending
    ? progress(pending)
    : missed
      ? `Couldn’t switch who the preview signs in as: ${missed.message}`
      : who
        ? `${whoSentence(who)} Choose who it signs in as.`
        : 'Choose who the app in the preview signs in as.'

  const item = (
    key: string,
    icon: string,
    name: string,
    detail: string | null,
    request: LocalIdentityRequest,
    next: Who,
    tip?: string
  ): JSX.Element => {
    const checked = key === current
    const detailId = `${menuId}-${key}`
    return (
      <button
        key={key}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        aria-disabled={busy || undefined}
        aria-label={name}
        aria-describedby={detail ? detailId : undefined}
        className={`pva-item${pending?.key === key ? ' is-busy' : ''}`}
        title={tip}
        onClick={() => void switchTo(key, next, request)}
      >
        <Codicon name={icon} className="pva-item-icon" />
        <span className="pva-item-text">
          <span className="pva-item-label">{name}</span>
          {detail && (
            <span className="pva-item-detail" id={detailId}>
              {detail}
            </span>
          )}
        </span>
        {pending?.key === key ? (
          <Codicon name="loading" className="codicon-modifier-spin pva-item-spin" />
        ) : (
          <Codicon name="check" className={`pva-check${checked ? '' : ' pva-check--off'}`} />
        )}
      </button>
    )
  }

  return (
    <div className="pva" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={`pva-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={who ? `Preview as: ${label}` : 'Preview as'}
        aria-busy={busy || undefined}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
      >
        {busy ? (
          <Codicon name="loading" className="codicon-modifier-spin" />
        ) : missed ? (
          <Codicon name="warning" className="pva-trigger-warn" />
        ) : (
          <Codicon name={who?.kind === 'none' ? 'circle-slash' : 'account'} />
        )}
        <span className="pva-trigger-label">{label}</span>
        <Codicon name="chevron-down" className="pva-caret" />
      </button>

      {open &&
        createPortal(
          <div ref={popRef} className="pva-pop" style={placement} onMouseDown={keepFocus}>
            <div className="pva-head" aria-hidden="true">
              <span className="pva-title">Preview as</span>
              <span className="pva-sub">Who the app signs in as on this computer</span>
            </div>
            <div
              ref={menuRef}
              className="pva-menu"
              role="menu"
              id={menuId}
              aria-label="Preview as"
              onKeyDown={(event) => moveMenuFocus(event, ITEM)}
            >
              {item(
                'developer',
                'account',
                'You',
                accountDetail(account),
                { kind: 'developer' },
                { kind: 'developer' },
                'Your Microsoft Entra account when you’re signed in to Azure, else a local developer account'
              )}
              {testUsers.length > 0 && (
                <div className="pva-group" role="group" aria-label="Test users">
                  <div className="pva-heading" aria-hidden="true">
                    Test users
                  </div>
                  {testUsers.map((name) =>
                    item(
                      `user:${name.toLowerCase()}`,
                      'account',
                      name,
                      null,
                      { kind: 'user', user: name },
                      { kind: 'user', username: name }
                    )
                  )}
                </div>
              )}
              {item(
                'none',
                'circle-slash',
                'Signed out',
                'No one is signed in',
                { kind: 'none' },
                { kind: 'none' }
              )}
              <div className="pva-sep" role="separator" />
              <button
                ref={addItemRef}
                type="button"
                role="menuitem"
                aria-expanded={adding}
                aria-disabled={busy || undefined}
                className={`pva-item${adding ? ' is-open' : ''}`}
                onClick={() => {
                  if (busy) return
                  if (adding) closeForm()
                  else setAdding(true)
                }}
              >
                <Codicon name="person-add" className="pva-item-icon" />
                <span className="pva-item-text">
                  <span className="pva-item-label">Add test user…</span>
                </span>
              </button>
            </div>

            {adding && (
              <form
                ref={formRef}
                className="pva-add"
                aria-label="Add a test user"
                noValidate
                onSubmit={submitNewUser}
              >
                <label className="pva-add-label" htmlFor={inputId}>
                  Test user’s email
                </label>
                <div className="pva-add-row">
                  <input
                    ref={inputRef}
                    id={inputId}
                    className="pva-add-input"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="name@example.com"
                    value={draft}
                    readOnly={busy}
                    aria-invalid={invalid ? true : undefined}
                    aria-describedby={invalid ? invalidId : undefined}
                    onChange={(event) => {
                      setDraft(event.target.value)
                      setInvalid(null)
                    }}
                  />
                  <button
                    type="submit"
                    className="btn btn--sm btn--primary"
                    aria-disabled={busy || undefined}
                  >
                    {pending?.adding ? 'Adding…' : 'Add'}
                  </button>
                </div>
                {invalid && (
                  <p className="pva-add-invalid" id={invalidId}>
                    {invalid}
                  </p>
                )}
                <p className="pva-add-hint">
                  Test users have no password: they sign in here, through Preview as.
                </p>
              </form>
            )}

            {shownFailure && (
              <div className="pva-failure" role="alert">
                <Codicon name="error" />
                <div className="pva-failure-text">
                  <p className="pva-failure-message">{shownFailure.message}</p>
                  {shownFailure.hint && <p className="pva-failure-hint">{shownFailure.hint}</p>}
                </div>
              </div>
            )}

            <p className="pva-status" role="status">
              {pending ? progress(pending) : ''}
            </p>
            <p className="pva-note">
              Switching clears the preview’s browser storage and reloads it.
            </p>
          </div>,
          document.body
        )}
    </div>
  )
}
