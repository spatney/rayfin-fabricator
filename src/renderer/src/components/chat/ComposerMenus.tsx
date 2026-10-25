import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { DATA_KINDS, type DataKind } from '@renderer/fabricData'
import { moveMenuFocus } from '@renderer/menuFocus'
import { menuLayout, type MenuLayout } from '@renderer/menuLayout'
import { useSuppressPreview } from '@renderer/overlay'
import { Codicon, ImageIcon } from '../icons'
import fabricSvg from '../../assets/brands/fabric.svg'
import '../models/modelPicker.css'

const MAIN_WIDTH = 236
const FLY_WIDTH = 236
const GAP = 6

/** What each kind of Fabric data lets the app do, in a word or two. */
const DATA_HINT: Record<DataKind, string> = {
  semanticmodel: 'DAX',
  warehouse: 'Read & write',
  sqldatabase: 'Read & write',
  lakehouse: 'Read-only'
}

/**
 * The composer's "+" menu, after the model picker: an image, a file, or Fabric
 * data, whose kinds open in a list beside it. Each kind opens the data picker on
 * that kind; "Browse all" opens it on every kind.
 */
export function AddMenu({
  locked,
  attaching,
  imageNote,
  onImage,
  onConnectData,
  onReferenceFile
}: {
  /** The composer is locked (the app's first deploy is running). */
  locked: boolean
  attaching: boolean
  /** Why images can't be added (the chosen model can't read them). */
  imageNote?: string
  onImage: () => void
  /** Open the data picker on one kind of data, or on every kind. */
  onConnectData: (kind?: DataKind) => void
  onReferenceFile: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [fly, setFly] = useState(false)
  const [layout, setLayout] = useState<MenuLayout>({ side: 'right', style: {} })
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  // The list beside the menu can reach over the native preview.
  useSuppressPreview(open && fly)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) closeMenu(false)
    }
    const resize = (): void => closeMenu(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', resize)
    }
  }, [open])

  // Focus the menu's first item when it opens, and the list's when it opens.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() =>
      mainRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [open])
  useEffect(() => {
    if (!fly) return
    const id = requestAnimationFrame(() =>
      flyRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [fly])

  function openMenu(): void {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setLayout(menuLayout(r, 'up', MAIN_WIDTH + GAP + FLY_WIDTH + 12))
    setOpen(true)
  }

  function closeMenu(focusTrigger = true): void {
    setOpen(false)
    setFly(false)
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function closeFly(): void {
    setFly(false)
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLElement>('[data-sub]')?.focus())
  }

  const pick = (action: () => void): void => {
    closeMenu(false)
    action()
  }

  const into = layout.side === 'right' ? 'ArrowRight' : 'ArrowLeft'
  const back = layout.side === 'right' ? 'ArrowLeft' : 'ArrowRight'

  function onMainKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === into && (event.target as HTMLElement).dataset?.sub) {
      event.preventDefault()
      setFly(true)
      return
    }
    moveMenuFocus(event, '[role="menuitem"]')
  }

  function onFlyKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === back) {
      event.preventDefault()
      closeFly()
      return
    }
    moveMenuFocus(event, '[role="menuitem"]')
  }

  return (
    <div
      ref={rootRef}
      className="composer-menu add-menu"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        event.stopPropagation()
        if (fly) closeFly()
        else closeMenu()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-icon-btn${open ? ' is-open' : ''}`}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        disabled={locked}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add images, files or data"
        title="Add images, files or data"
      >
        {attaching ? <span className="step-spin" aria-hidden="true" /> : <Codicon name="add" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`mp-pop mp-pop--up mp-pop--${layout.side} am-pop`}
            style={layout.style}
          >
            <div
              className="mp-panel am-main"
              role="menu"
              aria-label="Add"
              ref={mainRef}
              onKeyDown={onMainKey}
            >
              <button
                type="button"
                role="menuitem"
                className="mp-item"
                disabled={attaching || Boolean(imageNote)}
                title={imageNote}
                onClick={() => pick(onImage)}
              >
                <ImageIcon className="am-icon" />
                <span className="mp-item-text">
                  <span className="mp-item-label">Image</span>
                  {imageNote && <span className="mp-item-desc">{imageNote}</span>}
                </span>
                {!imageNote && <span className="am-hint">Or paste</span>}
              </button>
              <button type="button" role="menuitem" className="mp-item" onClick={() => pick(onReferenceFile)}>
                <Codicon name="mention" className="am-icon" />
                <span className="mp-item-label am-label">File</span>
                <span className="am-hint">
                  <kbd>@</kbd>
                </span>
              </button>
              <div className="mp-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={fly}
                data-sub="data"
                className={`mp-item mp-sub${fly ? ' is-open' : ''}`}
                onClick={() => (fly ? closeFly() : setFly(true))}
              >
                <img src={fabricSvg} alt="" draggable={false} className="am-icon" />
                <span className="mp-item-label am-label">Fabric data</span>
                <Codicon name="chevron-right" className="mp-caret" />
              </button>
            </div>
            {fly && (
              <div
                className="mp-panel mp-fly am-fly"
                role="menu"
                aria-label="Fabric data"
                ref={flyRef}
                onKeyDown={onFlyKey}
              >
                {DATA_KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    role="menuitem"
                    className="mp-item"
                    title={k.hint}
                    onClick={() => pick(() => onConnectData(k.kind))}
                  >
                    <Codicon name={k.icon} className="am-icon" />
                    <span className="mp-item-label am-label">{k.label}</span>
                    <span className="am-hint">{DATA_HINT[k.kind]}</span>
                  </button>
                ))}
                <div className="mp-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="mp-item mp-quiet"
                  onClick={() => pick(() => onConnectData())}
                >
                  <Codicon name="search" className="am-icon" />
                  <span className="mp-item-label am-label">Browse all Fabric data…</span>
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
