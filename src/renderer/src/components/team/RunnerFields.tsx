import { useId, type JSX } from 'react'
import type { TeamRunner, TeamRunnerInfo } from '@shared/ipc'
import { translator, useTranslation } from '../../i18n'

export type RunnerKind = 'hosted' | 'group' | 'labels'

/** Where the pipeline runs, as an owner edits it. */
export interface RunnerDraft {
  kind: RunnerKind
  group: string
  /** Comma-separated. */
  labels: string
}

const splitLabels = (text: string): string[] =>
  text
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)

export function runnerDraft(runner?: TeamRunner | null): RunnerDraft {
  const labels = (runner?.labels ?? []).join(', ')
  if (runner?.group) return { kind: 'group', group: runner.group, labels }
  if (runner?.labels?.length) return { kind: 'labels', group: '', labels }
  return { kind: 'hosted', group: '', labels: '' }
}

/** The choice to save. GitHub-hosted runners is an empty choice: no group, no labels. */
export function draftRunner(draft: RunnerDraft): TeamRunner {
  if (draft.kind === 'group') return { group: draft.group.trim(), labels: splitLabels(draft.labels) }
  if (draft.kind === 'labels') return { labels: splitLabels(draft.labels) }
  return {}
}

export function runnerDraftReady(draft: RunnerDraft): boolean {
  if (draft.kind === 'group') return Boolean(draft.group.trim())
  if (draft.kind === 'labels') return splitLabels(draft.labels).length > 0
  return true
}

/** "Runner group deployers", "Runners labeled self-hosted, linux" or "GitHub-hosted runners". */
export function describeRunner(runner?: TeamRunner | null): string {
  const t = translator('team')
  const labels = runner?.labels ?? []
  if (runner?.group) {
    return labels.length
      ? t('runner.groupLabeled', { group: runner.group, labels: labels.join(', ') })
      : t('runner.group', { group: runner.group })
  }
  return labels.length ? t('runner.labeled', { labels: labels.join(', ') }) : t('runner.hosted')
}

/** Where the pipeline runs now, in words, and whether that needs fixing. */
export function runnerSummary(info: TeamRunnerInfo): { title: string; detail: string; invalid: boolean } {
  const t = translator('team')
  const { repository, organization } = info
  if (repository) {
    return repository.runner
      ? { title: describeRunner(repository.runner), detail: t('runner.everyRun'), invalid: false }
      : {
          title: t('runner.invalid'),
          detail: t('runner.invalidDetail', { value: repository.value }),
          invalid: true
        }
  }
  if (organization) {
    return organization.runner
      ? { title: describeRunner(organization.runner), detail: t('runner.orgChose'), invalid: false }
      : {
          title: t('runner.orgInvalid'),
          detail: t('runner.orgInvalidDetail', { value: organization.value }),
          invalid: true
        }
  }
  return { title: t('runner.hosted'), detail: t('runner.hostedDetail'), invalid: false }
}

/**
 * Where a team workspace's pipeline runs: GitHub-hosted runners, or the
 * organization's own (a runner group, or runners with labels) when it turned
 * GitHub-hosted runners off.
 */
export default function RunnerFields({
  value,
  onChange,
  organization,
  hideLabel = false,
  disabled = false
}: {
  value: RunnerDraft
  onChange: (draft: RunnerDraft) => void
  /** What the organization chose, which "GitHub-hosted runners" leaves in place. */
  organization?: TeamRunner
  /** A heading around the field already says what it is. */
  hideLabel?: boolean
  disabled?: boolean
}): JSX.Element {
  const { t } = useTranslation('team')
  const fieldId = useId()
  const set = (patch: Partial<RunnerDraft>): void => onChange({ ...value, ...patch })
  const hint =
    value.kind === 'group'
      ? t('runner.groupHint')
      : value.kind === 'labels'
        ? t('runner.labelsHint')
        : organization
          ? t('runner.orgHint')
          : t('runner.hostedHint')
  return (
    <div className="field">
      {!hideLabel && (
        <label className="field-label" htmlFor={fieldId}>
          {t('runner.label')}
        </label>
      )}
      <select
        id={fieldId}
        className="field-input"
        aria-label={hideLabel ? t('runner.label') : undefined}
        value={value.kind}
        disabled={disabled}
        onChange={(event) => set({ kind: event.target.value as RunnerKind })}
      >
        <option value="hosted">
          {organization ? t('runner.orgChoice', { runner: describeRunner(organization) }) : t('runner.hosted')}
        </option>
        <option value="group">{t('runner.optionGroup')}</option>
        <option value="labels">{t('runner.optionLabels')}</option>
      </select>
      {value.kind === 'group' && (
        <div className="team-runner-inputs">
          <input
            className="field-input"
            aria-label={t('runner.groupName')}
            placeholder={t('runner.groupName')}
            value={value.group}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => set({ group: event.target.value })}
          />
          <input
            className="field-input"
            aria-label={t('runner.groupLabels')}
            placeholder={t('runner.groupLabelsPlaceholder')}
            value={value.labels}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => set({ labels: event.target.value })}
          />
        </div>
      )}
      {value.kind === 'labels' && (
        <input
          className="field-input"
          aria-label={t('runner.labels')}
          placeholder="self-hosted, linux"
          value={value.labels}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => set({ labels: event.target.value })}
        />
      )}
      <span className="field-hint">{hint}</span>
    </div>
  )
}
