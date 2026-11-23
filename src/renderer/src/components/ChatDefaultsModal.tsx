import { useEffect, useId, useState, type JSX } from 'react'
import type { ChatDefaults, ChatPluginId, ExperimentFlags } from '@shared/ipc'
import { useTranslation } from '../i18n'
import { useMcpServers } from '../mcpServers'
import { useModalFocus } from '../modalFocus'
import { selectionArgs, selectionOf, type ModelSelection } from '../modelSelection'
import { useSuppressPreview } from '../overlay'
import { mcpPluginId, offeredPlugins } from './chat/plugins'
import { serverSummary } from './mcp/mcpConfig'
import { ModelPicker } from './models/ModelPicker'
import { Item, Section, ToggleRow } from './SettingsModal'

/**
 * Chat defaults: the model and plugins a new project's chat starts with. Each
 * project's chat keeps its own choice after that. Saved as they change; only
 * the plugins chat offers now are shown.
 */
export default function ChatDefaultsModal({
  defaults,
  experiments,
  onChange,
  onClose,
  onManageKeys,
  onManageMcpServers
}: {
  defaults?: ChatDefaults
  experiments?: ExperimentFlags | null
  /** Save the defaults. */
  onChange: (next: ChatDefaults) => void
  onClose: () => void
  /** Open Accounts at Model providers (the model picker's Manage API keys…). */
  onManageKeys?: () => void
  /** Open the MCP servers dialog. */
  onManageMcpServers?: () => void
}): JSX.Element {
  const { t } = useTranslation('models')
  useSuppressPreview()
  const titleId = useId()
  const dialogRef = useModalFocus<HTMLDivElement>()
  const [current, setCurrent] = useState<ChatDefaults>(defaults ?? {})
  // Follow what's saved, which may differ: removing an MCP server turns it off here too.
  const saved = JSON.stringify(defaults ?? {})
  useEffect(() => setCurrent(JSON.parse(saved) as ChatDefaults), [saved])
  const servers = useMcpServers()
  const plugins = current.plugins ?? []

  // The model picker keeps Escape while its menu is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function save(next: ChatDefaults): void {
    setCurrent(next)
    onChange(next)
  }

  function pickModel(selection: ModelSelection): void {
    save({ ...selectionArgs(selection), plugins: current.plugins })
  }

  function toggle(plugin: ChatPluginId, on: boolean): void {
    const rest = plugins.filter((id) => id !== plugin)
    save({ ...current, plugins: on ? [...rest, plugin] : rest })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal chat-defaults-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{t('chatDefaults.title')}</h2>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onClose}
            aria-label={t('chatDefaults.close')}
          >
            ✕
          </button>
        </div>

        <div className="modal-body settings-body">
          <p className="modal-sub">{t('chatDefaults.sub')}</p>
          <Section title={t('chatDefaults.model')}>
            <Item title={t('chatDefaults.model')} desc={t('chatDefaults.modelHint')}>
              <ModelPicker
                value={selectionOf(current)}
                disabled={false}
                onChange={pickModel}
                tiers
                placement="down"
                overDialog
                onManageKeys={onManageKeys}
                label={t('chatDefaults.defaultModel')}
              />
            </Item>
          </Section>
          <Section title={t('chatDefaults.plugins')}>
            {offeredPlugins(experiments).map((p) => (
              <ToggleRow
                key={p.id}
                label={p.name}
                hint={p.description}
                checked={plugins.includes(p.id)}
                onChange={(on) => toggle(p.id, on)}
              />
            ))}
          </Section>
          <Section title={t('chatDefaults.mcpServers')}>
            {servers.map((s) => (
              <ToggleRow
                key={s.id}
                label={s.name}
                hint={serverSummary(s)}
                checked={plugins.includes(mcpPluginId(s.id))}
                onChange={(on) => toggle(mcpPluginId(s.id), on)}
              />
            ))}
            {servers.length === 0 && (
              <Item title={t('chatDefaults.noServers')} desc={t('chatDefaults.noServersHint')}>
                {onManageMcpServers && (
                  <button type="button" className="btn btn--sm" onClick={onManageMcpServers}>
                    {t('chatDefaults.manageServers')}
                  </button>
                )}
              </Item>
            )}
          </Section>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t('actions.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
