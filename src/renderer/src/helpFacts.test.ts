import { describe, expect, it } from 'vitest'
import type { AuthStatus, DoctorReport, LocalStatus, StudioProject } from '@shared/ipc'
import { accountFacts, setupFacts, workbenchFacts } from './helpFacts'

function tool(id: string, satisfied: boolean, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id === 'az' ? 'Azure CLI' : id,
    found: satisfied,
    satisfied,
    version: satisfied ? '1.0.0' : null,
    installHint: '',
    autoInstallable: true,
    required: true,
    ...extra
  } as DoctorReport['tools'][number]
}

function doctor(tools: DoctorReport['tools']): DoctorReport {
  return { tools, ready: tools.filter((t) => t.required).every((t) => t.satisfied) }
}

function auth(copilot: boolean, az: boolean): AuthStatus {
  return {
    copilot: { signedIn: copilot, user: copilot ? 'octocat' : undefined },
    rayfin: { signedIn: az },
    az: { signedIn: az, user: az ? 'user@contoso.com' : undefined }
  } as AuthStatus
}

describe('setupFacts', () => {
  it('says setup is complete when everything is green', () => {
    const facts = setupFacts(doctor([tool('node', true), tool('git', true)]), auth(true, true))
    expect(facts.some((f) => f.includes('Setup is complete'))).toBe(true)
    expect(facts.some((f) => f.includes('All 2 required tools are installed'))).toBe(true)
    expect(facts.some((f) => f.includes('Signed in to GitHub Copilot as octocat'))).toBe(true)
  })

  // The bug that prompted all of this: a green setup screen, and the assistant
  // reporting old resolved errors as if they were live.
  it('never implies trouble when nothing is wrong', () => {
    const facts = setupFacts(doctor([tool('node', true)]), auth(true, true))
    expect(facts.some((f) => f.includes('not finished'))).toBe(false)
    expect(facts.some((f) => f.includes('not installed'))).toBe(false)
    expect(facts.some((f) => f.includes('Not signed in'))).toBe(false)
  })

  // Azure is optional: tools and Copilot are all it takes to get in.
  it('counts setup as complete without Azure', () => {
    const facts = setupFacts(
      doctor([tool('node', true), tool('git', true), tool('az', false, { required: false })]),
      auth(true, false)
    )
    expect(facts.some((f) => f.includes('Setup is complete'))).toBe(true)
    expect(facts.some((f) => f.includes('Setup is not finished'))).toBe(false)
    expect(facts.some((f) => f.includes('Azure CLI is not installed'))).toBe(false)
    expect(facts.some((f) => f.startsWith('Not signed in to Azure. That is optional'))).toBe(true)
  })

  it('is not finished without GitHub Copilot', () => {
    const facts = setupFacts(doctor([tool('node', true)]), auth(false, true))
    expect(facts.some((f) => f.includes('Setup is not finished'))).toBe(true)
  })

  it('names each missing tool and keeps the ones that work', () => {
    const facts = setupFacts(doctor([tool('node', true), tool('git', false)]), auth(true, false))
    expect(facts).toContain('git is not installed yet.')
    expect(facts).toContain('Installed and working: node.')
    expect(facts.some((f) => f.includes('Setup is not finished'))).toBe(true)
  })

  it('distinguishes a broken version check from a missing tool', () => {
    const facts = setupFacts(
      doctor([tool('node', false, { found: true, checkError: 'exit 1' })]),
      auth(true, true)
    )
    expect(facts).toContain('node is installed but its version check is failing.')
  })

  it('leads with being offline, because it explains the rest', () => {
    const facts = setupFacts(doctor([tool('node', false)]), auth(false, false), { online: false })
    expect(facts[0]).toBe('This computer is currently offline.')
  })

  it('does not claim a tool is missing before the check has run', () => {
    const facts = setupFacts(null, auth(true, true))
    expect(facts).toContain('The tool check has not finished running yet.')
    expect(facts.some((f) => f.includes('not installed'))).toBe(false)
  })

  it('mentions optional tools only when they are present', () => {
    const present = setupFacts(
      doctor([tool('node', true), tool('gh', true, { required: false })]),
      auth(true, true)
    )
    expect(present.some((f) => f.includes('Also installed (optional): gh.'))).toBe(true)

    const absent = setupFacts(
      doctor([tool('node', true), tool('gh', false, { required: false })]),
      auth(true, true)
    )
    expect(absent.some((f) => f.includes('optional'))).toBe(false)
  })
})

describe('accountFacts', () => {
  it('treats an unchecked account as unknown, not signed out', () => {
    const status = {
      copilot: { signedIn: false, checking: true },
      rayfin: { signedIn: false, checking: true },
      az: { signedIn: false, checking: true }
    }
    const facts = accountFacts(status as AuthStatus)
    expect(facts).toEqual([
      'The GitHub Copilot account is still being checked.',
      'The Microsoft Fabric account is still being checked.',
      'The Azure account is still being checked.'
    ])
  })

  it('names who is signed in to each account', () => {
    const facts = accountFacts({
      copilot: { signedIn: true, user: 'octocat' },
      rayfin: { signedIn: true, user: 'ana@contoso.com' },
      az: { signedIn: true, user: 'ana@contoso.com' }
    })
    expect(facts).toEqual([
      'Signed in to GitHub Copilot as octocat.',
      'Signed in to Microsoft Fabric as ana@contoso.com.',
      'Signed in to Azure as ana@contoso.com.'
    ])
  })

  it('describes Fabric and Azure as optional when signed out', () => {
    const facts = accountFacts(null)
    expect(facts).toContain('Not signed in to GitHub Copilot.')
    const fabric = facts.find((f) => f.startsWith('Not signed in to Microsoft Fabric.'))
    expect(fabric).toContain('That is optional')
    expect(fabric).toContain('publish')
    const azure = facts.find((f) => f.startsWith('Not signed in to Azure.'))
    expect(azure).toContain('That is optional')
    expect(azure).toContain('apps build and run on this computer without it')
  })
})

describe('workbenchFacts', () => {
  const project = {
    id: 'p1',
    name: 'Expenses',
    path: 'C:\\apps\\expenses',
    addedAt: '2026-01-01T00:00:00Z'
  } as StudioProject
  const published = {
    ...project,
    lastDeploy: { url: 'https://app.example' },
    workspaceName: 'Sales'
  } as StudioProject

  it('says which app is open and that it is personal', () => {
    const facts = workbenchFacts(project)
    expect(facts[0]).toContain('"Expenses"')
    expect(facts[0]).toContain('personal app')
  })

  it('marks a team app as living in a team workspace', () => {
    const facts = workbenchFacts(project, { team: true })
    expect(facts[0]).toContain('team workspace')
    expect(facts.some((f) => f.includes("the team's pipeline publishes it"))).toBe(true)
  })

  it('names the workspace an app was published to', () => {
    const facts = workbenchFacts(published)
    expect(facts).toContain('"Expenses" has been published to the Sales workspace.')
  })

  // Apps run on this computer from the start: never having published is fine,
  // and the first-deploy gate of earlier releases is gone.
  it('describes an app that was never published as running on this computer', () => {
    const facts = workbenchFacts({ ...project, awaitingFirstDeploy: true } as StudioProject)
    expect(facts).toContain(
      '"Expenses" has never been published, which is fine: it runs on this computer, and publishing is optional.'
    )
    expect(facts.some((f) => /first deploy|deploy/i.test(f))).toBe(false)
  })

  it('reports a running preview and an in-flight publish', () => {
    const facts = workbenchFacts(project, {
      previewUrl: 'http://localhost:5173',
      deploying: true
    })
    expect(facts).toContain('"Expenses" is being published right now.')
    expect(facts.some((f) => f.includes('local preview'))).toBe(true)
  })

  it('says the last publish failed while that is still the latest word', () => {
    const failed = workbenchFacts(project, { deployFailed: true })
    expect(failed.some((f) => f.includes('most recent publish of "Expenses" failed'))).toBe(true)
    // A new publish under way supersedes it.
    const retrying = workbenchFacts(project, { deployFailed: true, deploying: true })
    expect(retrying.some((f) => f.includes('failed'))).toBe(false)
    expect(workbenchFacts(project).some((f) => f.includes('failed'))).toBe(false)
  })

  it('handles no open app', () => {
    expect(workbenchFacts(null, { projectCount: 3 })[0]).toContain('list of 3 app(s)')
    expect(workbenchFacts(null)[0]).toContain('none have been created')
  })
})

describe('the app on this computer', () => {
  const project = {
    id: 'p1',
    name: 'Expenses',
    path: 'C:\\apps\\expenses',
    addedAt: '2026-01-01T00:00:00Z'
  } as StudioProject

  function local(overrides: Partial<LocalStatus> = {}): LocalStatus {
    return {
      projectId: 'p1',
      state: 'running',
      revision: 3,
      phase: null,
      pid: 42,
      version: '0.2.0',
      projectRoot: null,
      signInAs: null,
      ready: null,
      analysis: null,
      schema: null,
      functions: null,
      vite: null,
      config: null,
      warnings: [],
      error: null,
      stopped: null,
      crashes: 0,
      startedAt: null,
      updatedAt: null,
      ...overrides
    }
  }

  it('says the app runs, as the preview’s status shows it', () => {
    expect(workbenchFacts(project, { local: local() })).toContain(
      '"Expenses" is running on this computer; the preview\'s status says "Running".'
    )
    expect(workbenchFacts(project, { local: local({ state: 'restarting' }) })).toContain(
      '"Expenses" is starting on this computer; the preview\'s status says "Restarting…".'
    )
    expect(workbenchFacts(project, { local: local({ state: 'stopped' }) })).toContain(
      '"Expenses" is not running on this computer; the preview\'s status says "Stopped".'
    )
  })

  it('quotes what the preview says about a problem that stopped it', () => {
    const facts = workbenchFacts(project, {
      local: local({
        state: 'error',
        error: {
          code: 'packages-missing',
          message: 'The npm packages aren’t installed.',
          hint: null,
          fatal: true,
          details: null,
          time: null
        }
      })
    })
    const fact = facts.find((f) => f.includes('because of a problem'))
    expect(fact).toContain('the preview says "Your app’s packages aren’t installed"')
    expect(fact).toContain('status says "Error"')
  })

  it('says a change that would delete local data waits for the user', () => {
    const refused = local({
      schema: {
        result: 'refused',
        changes: [],
        losses: ['Note.title (12 values)'],
        message: null,
        live: true,
        time: null
      }
    })
    expect(
      workbenchFacts(project, { local: refused }).some((f) =>
        f.includes('would delete local data, so it waits for the user to decide')
      )
    ).toBe(true)
  })

  it('says which copy of a published app the preview shows', () => {
    const published = { ...project, lastDeploy: { url: 'https://app.example' } } as StudioProject
    expect(
      workbenchFacts(published, { view: 'published', local: local() }).some((f) =>
        f.startsWith('The preview shows the published copy of "Expenses" (Published)')
      )
    ).toBe(true)
    expect(
      workbenchFacts(published, { view: 'local' }).some((f) =>
        f.startsWith('The preview shows the copy of "Expenses" on this computer (Local)')
      )
    ).toBe(true)
    // Before it's published there's only one copy.
    expect(
      workbenchFacts(project, { view: 'local' }).some((f) => f.startsWith('The preview shows'))
    ).toBe(false)
  })

  it('passes on why the preview uses the published backend instead', () => {
    const reason =
      'The logs connector runs only on Fabric, so the preview uses your published app’s backend.'
    const facts = workbenchFacts(project, { fallbackReason: reason, local: local() })
    expect(facts).toContain(
      `The preview of "Expenses" uses its published app's backend, not this computer's, and says: "${reason}"`
    )
    expect(facts.some((f) => f.includes('running on this computer'))).toBe(false)
  })

  it('says nothing about a backend a team app does not have, or one it was not told about', () => {
    const team = workbenchFacts(project, { team: true, local: local() })
    expect(team.some((f) => f.includes('status says'))).toBe(false)
    expect(workbenchFacts(project).some((f) => f.includes('status says'))).toBe(false)
    expect(workbenchFacts(project, { local: null }).some((f) => f.includes('status says'))).toBe(
      false
    )
  })
})

describe('knowing which screen the user is on', () => {
  const project = {
    id: 'p1',
    name: 'Expenses',
    path: 'C:\\apps\\expenses',
    addedAt: '2026-01-01T00:00:00Z'
  } as StudioProject

  // Help offered "Open my projects" while the project list was already on
  // screen; pressing it did nothing. It has to know where the user is.
  it('says when the user is already looking at their list', () => {
    const facts = workbenchFacts(project, { onHome: true })
    expect(facts[0]).toContain('looking at their list of apps')
  })

  it('does not say that while they are working inside an app', () => {
    const facts = workbenchFacts(project)
    expect(facts.some((f) => f.includes('looking at their list'))).toBe(false)
  })

  it('describes an empty list as nothing to open', () => {
    expect(workbenchFacts(null)[0]).toContain('none have been created')
  })
})
