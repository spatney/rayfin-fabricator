import { useEffect, useState, type JSX } from 'react'
import type { SkillInfo } from '@shared/ipc'
import { openDocs } from '../../docsLinks'
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
          setReadError(res.error ?? 'Couldn’t read this skill.')
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
  }, [projectId, skill.id, skill.active, skill.outdated])

  const triggers = file?.triggers ?? []
  const shownTriggers = allTriggers ? triggers : triggers.slice(0, TRIGGER_PREVIEW)
  const foldable = (file?.body.split('\n').length ?? 0) > GUIDANCE_FOLD_LINES
  const filePath = `.agents/skills/${skill.id}/SKILL.md`

  return (
    <aside className="skl-side skl-side--detail" aria-label={`${skill.title} details`}>
      <button
        type="button"
        className="skl-icon-btn skl-side-close"
        onClick={onClose}
        aria-label="Close details"
        title="Close (Esc)"
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
          <span>Rayfin manages this skill. It’s always on and updates with the Rayfin CLI.</span>
        </p>
      ) : source === 'app' ? (
        <p className="skl-note">
          <Codicon name="info" />
          <span>
            {skill.promotable
              ? 'This skill lives only in this app. Save it to your library to use it in other apps.'
              : 'This skill lives only in this app. It can’t be saved to your library under its current name.'}
          </span>
        </p>
      ) : (
        <label className="skl-toggle">
          <span className="skl-toggle-text">
            <strong>Use in this app</strong>
            <span>
              {skill.active
                ? 'Copilot follows it from your next message.'
                : 'Adds it to this app. Every change is saved in History.'}
            </span>
          </span>
          <SkillSwitch
            on={skill.active}
            busy={busy}
            label={`Use ${skill.title} in this app`}
            onChange={() => onToggle(skill)}
          />
        </label>
      )}

      {skill.outdated && skill.active && (
        <div className="skl-update">
          <span>A newer version of this skill is available.</span>
          <button type="button" className="btn btn--xs" disabled={busy} onClick={() => onUpdate(skill)}>
            {busy ? 'Updating…' : 'Update'}
          </button>
        </div>
      )}

      <section className="skl-section-block">
        <h4>When Copilot uses it</h4>
        {readError ? (
          <p className="skl-text">{readError}</p>
        ) : !file ? (
          <Skeleton rows={2} />
        ) : (
          <>
            {file.when && <p className="skl-text">{file.when}</p>}
            {triggers.length > 0 && (
              <div className="skl-chips" role="list" aria-label="Trigger words">
                {shownTriggers.map((trigger) => (
                  <span key={trigger} className="skl-chip" role="listitem">
                    {trigger}
                  </span>
                ))}
                {triggers.length > TRIGGER_PREVIEW && (
                  <button type="button" className="skl-chip skl-chip--more" onClick={() => setAllTriggers((v) => !v)}>
                    {allTriggers ? 'Fewer' : `+${triggers.length - TRIGGER_PREVIEW} more`}
                  </button>
                )}
              </div>
            )}
            {!file.when && triggers.length === 0 && (
              <p className="skl-text">Copilot decides from the skill’s instructions.</p>
            )}
          </>
        )}
      </section>

      {file?.body && (
        <section className="skl-section-block">
          <h4>What it teaches</h4>
          <div className={`skl-guidance${foldable && !allGuidance ? ' skl-guidance--folded' : ''}`}>
            <Markdown>{file.body}</Markdown>
          </div>
          {foldable && (
            <button type="button" className="skl-link" onClick={() => setAllGuidance((v) => !v)}>
              {allGuidance ? 'Show less' : 'Show all'}
            </button>
          )}
        </section>
      )}

      <section className="skl-section-block">
        <h4>File</h4>
        <div className="skl-file" title={filePath}>
          <Codicon name="file" />
          <span className="skl-file-path">{filePath}</span>
        </div>
        {!installed && <p className="skl-hint">Added to this app when you turn the skill on.</p>}
      </section>

      <div className="skl-actions">
        <button type="button" className="btn btn--sm" onClick={() => onViewSource(skill)}>
          <Codicon name="go-to-file" /> View SKILL.md
        </button>
        {source === 'library' && (
          <>
            <button type="button" className="btn btn--sm" onClick={() => onEdit(skill)}>
              <Codicon name="edit" /> Edit
            </button>
            <button type="button" className="btn btn--sm skl-danger" onClick={() => onDelete(skill)}>
              <Codicon name="trash" /> Delete
            </button>
          </>
        )}
        {source === 'app' && (
          <>
            {skill.promotable && (
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => onSaveToLibrary(skill)}>
                <Codicon name="library" /> Save to library
              </button>
            )}
            <button type="button" className="btn btn--sm skl-danger" disabled={busy} onClick={() => onRemove(skill)}>
              <Codicon name="trash" /> Remove
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
  return (
    <aside className="skl-side skl-side--overview" aria-label="About skills">
      <section className="skl-section-block">
        <h4>How skills work</h4>
        <ol className="skl-how">
          <li>Turn a skill on. Fabricator adds its instructions to this app and saves the change in History.</li>
          <li>When a request matches the skill, Copilot reads it and follows its guidance.</li>
          <li>Turn it off at any time. Select a skill to see what it teaches.</li>
        </ol>
      </section>

      <section className="skl-section-block">
        <h4>In this app</h4>
        <ul className="skl-facts">
          <li>
            <span>Always on</span>
            <span>{counts.always}</span>
          </li>
          <li>
            <span>Built-in skills</span>
            <span>
              {counts.builtInOn} of {counts.builtIn} on
            </span>
          </li>
          {counts.library > 0 && (
            <li>
              <span>Your library</span>
              <span>
                {counts.libraryOn} of {counts.library} on
              </span>
            </li>
          )}
          {counts.appOnly > 0 && (
            <li>
              <span>Added in this app</span>
              <span>{counts.appOnly}</span>
            </li>
          )}
        </ul>
      </section>

      {updates > 0 && (
        <section className="skl-section-block">
          <h4>Updates</h4>
          <p className="skl-text">
            {updates === 1
              ? 'A built-in skill in this app has a newer version.'
              : `${updates} built-in skills in this app have a newer version.`}
          </p>
          <div>
            <button type="button" className="btn btn--sm" disabled={updating} onClick={onUpdateAll}>
              <Codicon name="arrow-circle-up" /> {updating ? 'Updating…' : updates === 1 ? 'Update it' : `Update all ${updates}`}
            </button>
          </div>
        </section>
      )}

      <section className="skl-section-block">
        <h4>Your own skills</h4>
        <p className="skl-text">
          Select <strong>New skill</strong> to write one for your brand, your data’s vocabulary or your team’s review
          checklist, or to upload a skill you already have.
        </p>
      </section>

      <button type="button" className="skl-link skl-side-foot" onClick={() => openDocs('skills')}>
        Learn more about skills <Codicon name="link-external" />
      </button>
    </aside>
  )
}
