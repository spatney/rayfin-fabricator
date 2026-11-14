import { useEffect, useState, type JSX } from 'react'
import type { SkillInfo } from '@shared/ipc'
import { openDocs } from '../../docsLinks'
import { Trans, useTranslation } from '../../i18n'
import Markdown from '../Markdown'
import Skeleton from '../Skeleton'
import { Codicon } from '../icons'
import { kickerFor, SkillMark, SkillStatus, SkillSwitch, sourceOf } from './presentation'
import { parseSkillFile, type SkillFile } from './skillFile'

/** Trigger phrases shown before "more". */
const TRIGGER_PREVIEW = 12
/** Guidance longer than this many lines starts folded. */
const GUIDANCE_FOLD_LINES = 28

interface InspectorProps {
  projectId: string
  skill: SkillInfo
  /** A change to this skill is being saved. */
  busy: boolean
  onClose: () => void
  onToggle: (skill: SkillInfo) => void
  onUpdate: (skill: SkillInfo) => void
  onRemove: (skill: SkillInfo) => void
  onViewSource: (skill: SkillInfo) => void
  onEdit: (skill: SkillInfo) => void
  onDelete: (skill: SkillInfo) => void
  onSaveToLibrary: (skill: SkillInfo) => void
}

/** Details of the selected skill: what it's for, what it teaches, and what you can do with it. */
export default function SkillInspector({
  projectId,
  skill,
  busy,
  onClose,
  onToggle,
  onUpdate,
  onRemove,
  onViewSource,
  onEdit,
  onDelete,
  onSaveToLibrary
}: InspectorProps): JSX.Element {
  const { t } = useTranslation('skills')
  const source = sourceOf(skill)
  const [file, setFile] = useState<SkillFile | null>(null)
  const [installed, setInstalled] = useState(skill.active)
  const [readError, setReadError] = useState<string | null>(null)
  const [allTriggers, setAllTriggers] = useState(false)
  const [allGuidance, setAllGuidance] = useState(false)

  // The app's copy when it has one, else the copy it would get. Re-read after a change.
  useEffect(() => {
    let alive = true
    window.api.skills
      .source(projectId, skill.id)
      .then((res) => {
        if (!alive) return
        if (res.ok && res.content != null) {
          setFile(parseSkillFile(res.content))
          setInstalled(res.installed)
          setReadError(null)
        } else {
          setFile(null)
          setReadError(res.error ?? t('inspector.readError'))
        }
      })
      .catch((err) => {
        if (!alive) return
        setFile(null)
        setReadError(String(err))
      })
    return () => {
      alive = false
    }
  }, [projectId, skill.id, skill.active, skill.outdated, t])

  const triggers = file?.triggers ?? []
  const shownTriggers = allTriggers ? triggers : triggers.slice(0, TRIGGER_PREVIEW)
  const foldable = (file?.body.split('\n').length ?? 0) > GUIDANCE_FOLD_LINES
  const filePath = `.agents/skills/${skill.id}/SKILL.md`

  return (
    <aside
      className="skl-side skl-side--detail"
      aria-label={t('inspector.label', { title: skill.title })}
    >
      <button
        type="button"
        className="skl-icon-btn skl-side-close"
        onClick={onClose}
        aria-label={t('inspector.close')}
        title={t('inspector.closeTitle')}
      >
        <Codicon name="close" />
      </button>

      <header className="skl-insp-head">
        <SkillMark skill={skill} size="lg" />
        <div className="skl-titles">
          <span className="skl-kicker">{kickerFor(skill)}</span>
          <h3>{skill.title}</h3>
          <SkillStatus skill={skill} />
        </div>
      </header>

      <p className="skl-text">{skill.description}</p>

      {source === 'rayfin' ? (
        <p className="skl-note">
          <Codicon name="lock" />
          <span>{t('inspector.managedNote')}</span>
        </p>
      ) : source === 'app' ? (
        <p className="skl-note">
          <Codicon name="info" />
          <span>{skill.promotable ? t('inspector.appNote') : t('inspector.appNoteLocked')}</span>
        </p>
      ) : (
        <label className="skl-toggle">
          <span className="skl-toggle-text">
            <strong>{t('inspector.use')}</strong>
            <span>{skill.active ? t('inspector.useOn') : t('inspector.useOff')}</span>
          </span>
          <SkillSwitch
            on={skill.active}
            busy={busy}
            label={t('skill.use', { title: skill.title })}
            onChange={() => onToggle(skill)}
          />
        </label>
      )}

      {skill.outdated && skill.active && (
        <div className="skl-update">
          <span>{t('inspector.newer')}</span>
          <button type="button" className="btn btn--xs" disabled={busy} onClick={() => onUpdate(skill)}>
            {busy ? t('skill.updating') : t('actions.update')}
          </button>
        </div>
      )}

      <section className="skl-section-block">
        <h4>{t('inspector.whenHeading')}</h4>
        {readError ? (
          <p className="skl-text">{readError}</p>
        ) : !file ? (
          <Skeleton rows={2} />
        ) : (
          <>
            {file.when && <p className="skl-text">{file.when}</p>}
            {triggers.length > 0 && (
              <div className="skl-chips" role="list" aria-label={t('inspector.triggers')}>
                {shownTriggers.map((trigger) => (
                  <span key={trigger} className="skl-chip" role="listitem">
                    {trigger}
                  </span>
                ))}
                {triggers.length > TRIGGER_PREVIEW && (
                  <button type="button" className="skl-chip skl-chip--more" onClick={() => setAllTriggers((v) => !v)}>
                    {allTriggers
                      ? t('inspector.fewer')
                      : t('inspector.more', { count: triggers.length - TRIGGER_PREVIEW })}
                  </button>
                )}
              </div>
            )}
            {!file.when && triggers.length === 0 && (
              <p className="skl-text">{t('inspector.noTriggers')}</p>
            )}
          </>
        )}
      </section>

      {file?.body && (
        <section className="skl-section-block">
          <h4>{t('inspector.teachesHeading')}</h4>
          <div className={`skl-guidance${foldable && !allGuidance ? ' skl-guidance--folded' : ''}`}>
            <Markdown>{file.body}</Markdown>
          </div>
          {foldable && (
            <button type="button" className="skl-link" onClick={() => setAllGuidance((v) => !v)}>
              {allGuidance ? t('actions.showLess') : t('inspector.showAll')}
            </button>
          )}
        </section>
      )}

      <section className="skl-section-block">
        <h4>{t('inspector.fileHeading')}</h4>
        <div className="skl-file" title={filePath}>
          <Codicon name="file" />
          <span className="skl-file-path">{filePath}</span>
        </div>
        {!installed && <p className="skl-hint">{t('inspector.notInstalled')}</p>}
      </section>

      <div className="skl-actions">
        <button type="button" className="btn btn--sm" onClick={() => onViewSource(skill)}>
          <Codicon name="go-to-file" /> {t('inspector.viewSource')}
        </button>
        {source === 'library' && (
          <>
            <button type="button" className="btn btn--sm" onClick={() => onEdit(skill)}>
              <Codicon name="edit" /> {t('actions.edit')}
            </button>
            <button type="button" className="btn btn--sm skl-danger" onClick={() => onDelete(skill)}>
              <Codicon name="trash" /> {t('actions.delete')}
            </button>
          </>
        )}
        {source === 'app' && (
          <>
            {skill.promotable && (
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => onSaveToLibrary(skill)}>
                <Codicon name="library" /> {t('inspector.saveToLibrary')}
              </button>
            )}
            <button type="button" className="btn btn--sm skl-danger" disabled={busy} onClick={() => onRemove(skill)}>
              <Codicon name="trash" /> {t('actions.remove')}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}

export interface SkillCounts {
  on: number
  always: number
  builtIn: number
  builtInOn: number
  library: number
  libraryOn: number
  appOnly: number
}

/** The side panel while nothing is selected: how skills work, and this app's figures. */
export function SkillsOverview({
  counts,
  updates,
  updating,
  onUpdateAll
}: {
  counts: SkillCounts
  /** Built-in skills in this app with a newer version. */
  updates: number
  updating: boolean
  onUpdateAll: () => void
}): JSX.Element {
  const { t } = useTranslation('skills')
  return (
    <aside className="skl-side skl-side--overview" aria-label={t('overview.label')}>
      <section className="skl-section-block">
        <h4>{t('overview.howTitle')}</h4>
        <ol className="skl-how">
          <li>{t('overview.how1')}</li>
          <li>{t('overview.how2')}</li>
          <li>{t('overview.how3')}</li>
        </ol>
      </section>

      <section className="skl-section-block">
        <h4>{t('overview.inThisApp')}</h4>
        <ul className="skl-facts">
          <li>
            <span>{t('overview.alwaysOn')}</span>
            <span>{counts.always}</span>
          </li>
          <li>
            <span>{t('overview.builtIn')}</span>
            <span>{t('overview.onOf', { on: counts.builtInOn, total: counts.builtIn })}</span>
          </li>
          {counts.library > 0 && (
            <li>
              <span>{t('overview.library')}</span>
              <span>{t('overview.onOf', { on: counts.libraryOn, total: counts.library })}</span>
            </li>
          )}
          {counts.appOnly > 0 && (
            <li>
              <span>{t('overview.appOnly')}</span>
              <span>{counts.appOnly}</span>
            </li>
          )}
        </ul>
      </section>

      {updates > 0 && (
        <section className="skl-section-block">
          <h4>{t('overview.updates')}</h4>
          <p className="skl-text">{t('overview.updatesText', { count: updates })}</p>
          <div>
            <button type="button" className="btn btn--sm" disabled={updating} onClick={onUpdateAll}>
              <Codicon name="arrow-circle-up" /> {updating ? t('skill.updating') : t('overview.updateAll', { count: updates })}
            </button>
          </div>
        </section>
      )}

      <section className="skl-section-block">
        <h4>{t('overview.ownTitle')}</h4>
        <p className="skl-text">
          <Trans t={t} i18nKey="overview.ownText" components={{ strong: <strong /> }} />
        </p>
      </section>

      <button type="button" className="skl-link skl-side-foot" onClick={() => openDocs('skills')}>
        {t('overview.learnMore')} <Codicon name="link-external" />
      </button>
    </aside>
  )
}
