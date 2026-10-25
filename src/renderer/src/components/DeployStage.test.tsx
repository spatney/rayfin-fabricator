import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import DeployStage from './DeployStage'
import { isRaySentAway } from './mascot/stage'

vi.mock('./mascot/stage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mascot/stage')>()),
  isRaySentAway: vi.fn(() => false)
}))

afterEach(() => {
  cleanup()
  vi.mocked(isRaySentAway).mockReturnValue(false)
})

const RUN = [
  'Deploying Boo to Fabric…\n',
  '👀 Found Rayfin project root: C:\\Users\\sachi\\RayfinProjects\\boo\n',
  '[rayfin] license: Checking user license\n',
  '[rayfin] workspace: Resolving workspace\n',
  '[rayfin] item: Resolving Rayfin item\n',
  '[rayfin] settings: Applying runtime settings\n',
  '[rayfin] data: Applying database configuration\n'
]

const said = (): string => document.querySelector('.mascot-bubble')?.textContent ?? ''

describe('the deploy screen', () => {
  it('is Ray’s, unless he was sent away', () => {
    render(<DeployStage log={RUN.slice(0, 1)} name="Boo" firstDeploy />)
    expect(screen.getByRole('button', { name: /Ray, the Fabricator stingray/ })).toBeTruthy()
    expect(said()).toBe('Boo’s first trip to Fabric! I’ll swim it over.')
    cleanup()

    vi.mocked(isRaySentAway).mockReturnValue(true)
    const { container } = render(<DeployStage log={RUN.slice(0, 1)} name="Boo" />)
    expect(screen.queryByRole('button', { name: /Ray/ })).toBeNull()
    expect(container.querySelector('.dstage-logo')).not.toBeNull()
  })

  it('lists the steps Rayfin reports, in its own words for the one in progress', () => {
    const { rerender } = render(<DeployStage log={RUN} name="Boo" />)
    const steps = within(screen.getByRole('list', { name: 'Deploy steps' }))
      .getAllByRole('listitem')
      .map((li) => [li.getAttribute('data-state'), li.textContent])
    expect(steps).toEqual([
      ['done', 'Connecting to Fabric'],
      ['done', 'Finding your workspace'],
      ['done', 'Setting up your app in Fabric'],
      ['done', 'Applying settings'],
      ['active', 'Updating your databaseApplying database configuration'],
      ['todo', 'Building and uploading your app'],
      ['todo', 'Going live']
    ])
    expect(screen.getByRole('status').textContent).toBe('Updating your database')

    rerender(
      <DeployStage
        log={[
          ...RUN,
          '[rayfin] static: Deploying static content\n',
          '🎉 Project "boo" is now deployed to Fabric!\n'
        ]}
        name="Boo"
      />
    )
    expect(screen.getByRole('heading').textContent).toBe('Boo is live')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })
})