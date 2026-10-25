import { useId, type JSX } from 'react'
import type { TeamRunner, TeamRunnerInfo } from '@shared/ipc'

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
  const labels = runner?.labels ?? []
  if (runner?.group) {
    return labels.length ? `Runner group ${runner.group}, labeled ${labels.join(', ')}` : `Runner group ${runner.group}`
  }
  return labels.length ? `Runners labeled ${labels.join(', ')}` : 'GitHub-hosted runners'
}

/** Where the pipeline runs now, in words, and whether that needs fixing. */
export function runnerSummary(info: TeamRunnerInfo): { title: string; detail: string; invalid: boolean } {
  const { repository, organization } = info
  if (repository) {
    return repository.runner
      ? { title: describeRunner(repository.runner), detail: 'Every pipeline run uses these runners.', invalid: false }
      : {
          title: 'The runner setting isn’t valid',
          detail: `FABRICATOR_RUNS_ON is ${repository.value}, which GitHub can’t use, so pipeline runs can’t start.`,
          invalid: true
        }
  }
  if (organization) {
    return organization.runner
      ? { title: describeRunner(organization.runner), detail: 'Your organization chose these runners.', invalid: false }
      : {
          title: 'Your organization’s runner setting isn’t valid',
          detail: `It shares FABRICATOR_RUNS_ON as ${organization.value}, which GitHub can’t use.`,
          invalid: true
        }
  }
  return { title: 'GitHub-hosted runners', detail: 'GitHub runs the pipeline on its ubuntu-latest runners.', invalid: false }
}

const NEEDS = 'Runners need Linux with bash, curl and git.'

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
  const fieldId = useId()
  const set = (patch: Partial<RunnerDraft>): void => onChange({ ...value, ...patch })
  const hint =
    value.kind === 'group'
      ? `Ask a GitHub organization owner which runner group this repository can use. ${NEEDS}`
      : value.kind === 'labels'
        ? `A runner needs every label. Separate labels with commas. ${NEEDS}`
        : organization
          ? 'The runners your organization chose for Fabricator.'
          : 'If your organization turned off GitHub-hosted runners, choose its runner group or labels instead.'
  return (
    <div className="field">
      {!hideLabel && (
        <label className="field-label" htmlFor={fieldId}>
          Where the pipeline runs
        </label>
      )}
      <select
        id={fieldId}
        className="field-input"
        aria-label={hideLabel ? 'Where the pipeline runs' : undefined}
        value={value.kind}
        disabled={disabled}
        onChange={(event) => set({ kind: event.target.value as RunnerKind })}
      >
        <option value="hosted">
          {organization ? `Your organization’s choice: ${describeRunner(organization)}` : 'GitHub-hosted runners'}
        </option>
        <option value="group">A runner group</option>
        <option value="labels">Runners with labels</option>
      </select>
      {value.kind === 'group' && (
        <div className="team-runner-inputs">
          <input
            className="field-input"
            aria-label="Runner group name"
            placeholder="Runner group name"
            value={value.group}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => set({ group: event.target.value })}
          />
          <input
            className="field-input"
            aria-label="Runner labels (optional)"
            placeholder="Labels (optional), such as linux"
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
          aria-label="Runner labels"
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
