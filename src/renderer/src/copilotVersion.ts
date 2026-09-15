import type { AppVersions } from '@shared/ipc'

/**
 * Human-readable Copilot CLI version for the Settings/About line and bug
 * reports. The Copilot CLI self-updates past the version the SDK bundles, so
 * the *running* version (`copilot`, probed via `--version`) can be newer than
 * the SDK's *pinned* bundle (`copilotBundled`, from the install dir). When the
 * two differ we surface both, e.g. `1.0.74-0 (bundled 1.0.71)`; otherwise just
 * the running version, or `unknown` when it couldn't be probed.
 */
export function formatCopilotCli(
  versions: Pick<AppVersions, 'copilot' | 'copilotBundled'> | null | undefined
): string {
  const running = versions?.copilot
  if (!running) return 'unknown'
  const bundled = versions?.copilotBundled
  return bundled && bundled !== running ? `${running} (bundled ${bundled})` : running
}
