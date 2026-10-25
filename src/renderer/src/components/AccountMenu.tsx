import { useEffect, useId, useRef, useState, type ReactNode, type JSX } from 'react'
import { useSuppressPreview } from '../overlay'
import { moveMenuFocus } from '../menuFocus'
import { Codicon, ReloadIcon, SignOutIcon } from './icons'

/** Up-to-two-letter initials for the signed-in user's avatar, derived from their
 * email (e.g. "first.last@…" → "FL", "sapatney@…" → "SA"). */
export function avatarInitials(email: string | null | undefined): string {
  if (!email) return '?'
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[.\-_]+/).filter(Boolean)
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : local.slice(0, 2)
  return letters.toUpperCase() || '?'
}

interface Props {
  /** The shared Rayfin CLI (Fabric) session. */
  signedIn: boolean
  user?: string
  /** Readable name of the tenant (directory) the Fabric account signs in to. */
  tenant?: string
  /** The Fabric sign-in hasn't been verified yet this launch. */
  checking?: boolean
  /** A Fabric sign-in, sign-out, credential refresh, or deploy is running. */
  busy: boolean
  signingIn: boolean
  signingOut: boolean
  refreshing: boolean
  /** A credential refresh needs an open project's CLI. */
  canRefresh: boolean
  onSignIn: () => void
  onSignOut: () => void
  onRefresh: () => void
  /** Open the Accounts dialog: every account Fabricator uses. */
  onManageAccounts: () => void
  /** Open Settings. */
  onOpenSettings: () => void
}

const ITEM = '[role="menuitem"]'

/**
 * The app bar's account control, which also holds Settings. Signed in to
 * Fabric, it's the user's avatar and opens a menu with the account actions
 * (manage every account, refresh credentials, sign out) and Settings. Signed
 * out, "Sign in to Fabric" stays one click away, with the rest behind its caret.
 * While the launch check runs it's a neutral placeholder rather than a premature
 * sign-in prompt.
 */
export default function AccountMenu({
  signedIn,
  user,
  tenant,
  checking = false,
  busy,
  signingIn,
  signingOut,
  refreshing,
  canRefresh,
  onSignIn,
  onSignOut,
  onRefresh,
  onManageAccounts,
  onOpenSettings
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const isOpen = open
  const pending = checking && !signedIn

  // The menu drops over the preview, whose native surface paints above all HTML.
  useSuppressPreview(isOpen)

  // A press anywhere else closes the menu — including another bar menu's trigger,
  // which stops its click from bubbling.
  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (e: Event): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const id = requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLButtonElement>(`${ITEM}:not(:disabled)`)?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [isOpen])

  // Focus returns to the trigger before the action runs, so a dialog it opens
  // hands focus back to the account control when it closes.
  const pick = (action: () => void): void => {
    triggerRef.current?.focus()
    setOpen(false)
    action()
  }

  const refreshItem = canRefresh && (
    <MenuItem
      disabled={busy}
      onClick={() => pick(onRefresh)}
      icon={<ReloadIcon />}
      title="Clear the shared Rayfin CLI credentials and sign in again"
    >
      {refreshing ? 'Refreshing authentication…' : 'Refresh Fabric authentication'}
    </MenuItem>
  )

  return (
    <div
      className="account"
      ref={rootRef}
      onKeyDown={(e) => {
        if (!isOpen) return
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
          triggerRef.current?.focus()
          return
        }
        // Tabbing away leaves the menu, as with any menu button.
        if (e.key === 'Tab') {
          setOpen(false)
          return
        }
        moveMenuFocus(e, ITEM)
      }}
    >
      {signedIn || pending ? (
        <button
          ref={triggerRef}
          type="button"
          className={`account-trigger${isOpen ? ' is-open' : ''}${pending ? ' account-trigger--checking' : ''}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-controls={isOpen ? menuId : undefined}
          aria-label={pending ? 'Account: checking sign-in' : user ? `Account: ${user}` : 'Account'}
          title={
            pending
              ? 'Checking your Microsoft Fabric sign-in…'
              : [user ? `Signed in to Fabric as ${user}` : 'Signed in to Fabric', tenant]
                  .filter(Boolean)
                  .join(' · ')
          }
          onClick={() => setOpen((o) => !o)}
        >
          {pending ? <span className="account-trigger-dots" aria-hidden="true" /> : avatarInitials(user)}
        </button>
      ) : (
        <div className="seg seg--toolbar account-signin">
          <button className="seg-btn" disabled={busy} onClick={onSignIn}>
            {signingIn ? 'Signing in…' : 'Sign in to Fabric'}
          </button>
          <button
            ref={triggerRef}
            type="button"
            className="seg-btn seg-btn--icon account-signin-more"
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-controls={isOpen ? menuId : undefined}
            aria-label="Settings and accounts"
            title="Settings and accounts"
            onClick={() => setOpen((o) => !o)}
          >
            <Codicon name="chevron-down" />
          </button>
        </div>
      )}

      {isOpen && (
        <div className="account-pop">
          {signedIn ? (
            <div className="account-pop-head">
              <span className="account-pop-avatar" aria-hidden="true">
                {avatarInitials(user)}
              </span>
              <span className="account-pop-id">
                <span className="account-pop-user" title={user}>
                  {user ?? 'Signed in'}
                </span>
                <span className="account-pop-sub">
                  Microsoft Fabric{tenant ? ` · ${tenant}` : ''}
                </span>
              </span>
            </div>
          ) : (
            <div className="account-pop-head">
              <span className="account-pop-id">
                <span className="account-pop-user">
                  {pending ? 'Checking your Fabric sign-in…' : 'Not signed in to Fabric'}
                </span>
                {!pending && canRefresh && (
                  <span className="account-pop-sub">
                    Refresh clears stale credentials, then signs you in again.
                  </span>
                )}
              </span>
            </div>
          )}
          <div className="account-pop-items" role="menu" id={menuId} aria-label="Fabric account">
            <MenuItem
              disabled={false}
              onClick={() => pick(onManageAccounts)}
              icon={<Codicon name="account" />}
              title="See and change every account Fabricator uses"
            >
              Manage accounts…
            </MenuItem>
            {!pending && refreshItem}
            {signedIn && (
              <MenuItem disabled={busy} onClick={() => pick(onSignOut)} icon={<SignOutIcon />}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </MenuItem>
            )}
            {/* The rest is about the account; Settings is the app's. */}
            <div className="account-sep" role="separator" />
            <MenuItem
              disabled={false}
              onClick={() => pick(onOpenSettings)}
              icon={<Codicon name="settings-gear" />}
              title="Theme, text size, experiments and more"
            >
              Settings
            </MenuItem>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  disabled,
  title,
  onClick,
  children
}: {
  icon: ReactNode
  disabled: boolean
  title?: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="account-item"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="account-item-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </button>
  )
}
