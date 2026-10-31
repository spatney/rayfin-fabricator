import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ChatPluginId, McpServer } from '@shared/ipc'
import { DATA_KINDS, type DataKind } from '@renderer/fabricData'
import { moveMenuFocus } from '@renderer/menuFocus'
import { menuLayout, type MenuLayout } from '@renderer/menuLayout'
import { useSuppressPreview } from '@renderer/overlay'
import { Codicon, ImageIcon } from '../icons'
import { serverSummary } from '../mcp/mcpConfig'
import { mcpPluginId, type ChatPlugin } from './plugins'
import fabricSvg from '../../assets/brands/fabric.svg'
import '../models/modelPicker.css'

const MAIN_WIDTH = 236
const FLY_WIDTH = 236
const GAP = 6
const PLUGINS_WIDTH = 300

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
  attaching,
  imageNote,
  onImage,
  onConnectData,
  onReferenceFile
}: {
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

/**
 * The composer's plugins, beside the "+" menu: services chat can look things up
 * with while it builds, such as Fabric IQ, and, with the MCP servers
 * experiment, the MCP servers you added. Each is off until turned on, and
 * changes from the chat's next message; the trigger names the ones that are on.
 */
export function PluginsMenu({
  plugins,
  servers,
  on,
  disabled = false,
  onToggle,
  onManageServers,
  onLearnMore
}: {
  /** The plugins chat offers. */
  plugins: readonly ChatPlugin[]
  /** The MCP servers you added, while the MCP servers experiment is on. */
  servers?: readonly McpServer[]
  /** The ids of the plugins on in this chat. */
  on: readonly string[]
  /** While the assistant is working: plugins change between messages. */
  disabled?: boolean
  onToggle: (plugin: ChatPluginId, on: boolean) => void
  /** Open the MCP servers dialog, adding a server when `add` is set. */
  onManageServers?: (add: boolean) => void
  onLearnMore?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<MenuLayout>({ side: 'right', style: {} })
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Wider than the narrowest chat pane, so it can reach over the preview.
  useSuppressPreview(open)

  const names = [
    ...plugins.filter((p) => on.includes(p.id)).map((p) => p.name),
    ...(servers ?? []).filter((s) => on.includes(mcpPluginId(s.id))).map((s) => s.name)
  ].join(', ')

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false)
    }
    const resize = (): void => setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', resize)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
    )
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function openMenu(): void {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setLayout(menuLayout(r, 'up', PLUGINS_WIDTH + 12))
    setOpen(true)
  }

  function closeMenu(focusTrigger = true): void {
    setOpen(false)
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  return (
    <div
      ref={rootRef}
      className="composer-menu plugins-menu"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${names ? 'composer-pill pl-pill' : 'composer-icon-btn'}${open ? ' is-open' : ''}`}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={names ? `Plugins: ${names}` : 'Plugins'}
        title={
          disabled
            ? 'Plugins can’t be changed while the assistant is working'
            : names
              ? `Plugins: ${names}`
              : 'Plugins'
        }
      >
        <Codicon name="plug" />
        {names && <span className="composer-pill-label pl-pill-label">{names}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`mp-pop mp-pop--up mp-pop--${layout.side}`}
            style={layout.style}
          >
            <div
              ref={panelRef}
              className="mp-panel pl-panel"
              role="menu"
              aria-label="Plugins"
              onKeyDown={(event) => moveMenuFocus(event, '[role^="menuitem"]')}
            >
              <div className="mp-heading" aria-hidden="true">
                Plugins
              </div>
              {plugins.map((p) => {
                const isOn = on.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isOn}
                    className="mp-item pl-item"
                    onClick={() => onToggle(p.id, !isOn)}
                  >
                    <img src={p.logo} alt="" draggable={false} className="am-icon" />
                    <span className="mp-item-text">
                      <span className="mp-item-label">
                        {p.name}
                        {p.experiment && (
                          <span className="mp-badge mp-badge--inline">Experiment</span>
                        )}
                      </span>
                      <span className="mp-item-desc">{p.description}</span>
                    </span>
                    <span
                      className={`switch switch--sm${isOn ? ' switch--on' : ''}`}
                      aria-hidden="true"
                    >
                      <span className="switch-knob" />
                    </span>
                  </button>
                )
              })}
              {servers && (
                <>
                  <div className="mp-sep" role="separator" />
                  <div className="mp-heading" aria-hidden="true">
                    MCP servers
                    <span className="mp-badge mp-badge--inline">Experiment</span>
                  </div>
                  {servers.map((s) => {
                    const id = mcpPluginId(s.id)
                    const isOn = on.includes(id)
                    const summary = serverSummary(s)
                    return (
                      <button
                        key={id}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={isOn}
                        className="mp-item pl-item pl-item--mcp"
                        title={summary}
                        onClick={() => onToggle(id, !isOn)}
                      >
                        <Codicon
                          name={s.transport === 'stdio' ? 'terminal' : 'globe'}
                          className="am-icon"
                        />
                        <span className="mp-item-text">
                          <span className="mp-item-label">{s.name}</span>
                          <span className="mp-item-desc">
                            {s.readOnly ? `Read-only · ${summary}` : summary}
                          </span>
                        </span>
                        <span
                          className={`switch switch--sm${isOn ? ' switch--on' : ''}`}
                          aria-hidden="true"
                        >
                          <span className="switch-knob" />
                        </span>
                      </button>
                    )
                  })}
                  {onManageServers && (
                    <button
                      type="button"
                      role="menuitem"
                      className="mp-item mp-quiet"
                      onClick={() => {
                        closeMenu(false)
                        onManageServers(servers.length === 0)
                      }}
                    >
                      <Codicon
                        name={servers.length ? 'settings-gear' : 'add'}
                        className="am-icon"
                      />
                      <span className="mp-item-label am-label">
                        {servers.length ? 'Manage MCP servers…' : 'Add an MCP server…'}
                      </span>
                    </button>
                  )}
                </>
              )}
              <p className="mp-note">
                {servers
                  ? 'Chat uses a plugin only when a request needs it. Fabric IQ and Work IQ only read; an MCP server can do whatever its tools do.'
                  : 'Chat looks things up with a plugin only when a request needs it. Plugins only read.'}
              </p>
              {onLearnMore && (
                <>
                  <div className="mp-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="mp-item mp-quiet"
                    onClick={() => {
                      closeMenu(false)
                      onLearnMore()
                    }}
                  >
                    <Codicon name="book" className="am-icon" />
                    <span className="mp-item-label am-label">Learn about plugins</span>
                  </button>
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
