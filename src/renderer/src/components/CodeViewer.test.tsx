import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { FileContent } from '@shared/ipc'
import CodeViewer from './CodeViewer'
import { makeProject } from '../../test/harness'

vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value?: string }) => <pre data-testid="monaco-value">{value}</pre>
}))

vi.mock('../monaco', () => ({
  monacoLanguage: () => 'typescript'
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function content(path: string, text: string): FileContent {
  return { path, size: text.length, content: text }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

describe('CodeViewer external open requests', () => {
  it('keeps the requested table content when an earlier default-config read finishes last', async () => {
    const configPath = 'rayfin/rayfin.yml'
    const tablePath = 'rayfin/data/Account.ts'
    const config = deferred<FileContent>()
    const table = deferred<FileContent>()
    const read = vi.fn((_projectId: string, path: string) =>
      path === configPath ? config.promise : table.promise
    )
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        files: {
          tree: vi.fn(() =>
            Promise.resolve([
              {
                name: 'rayfin',
                path: 'rayfin',
                type: 'dir',
                children: [
                  { name: 'rayfin.yml', path: configPath, type: 'file' },
                  {
                    name: 'data',
                    path: 'rayfin/data',
                    type: 'dir',
                    children: [{ name: 'Account.ts', path: tablePath, type: 'file' }]
                  }
                ]
              }
            ])
          ),
          read
        }
      }
    }

    const project = makeProject('p1')
    const { rerender } = render(<CodeViewer project={project} refreshKey={0} />)

    await waitFor(() => expect(read).toHaveBeenCalledWith(project.id, configPath))

    rerender(
      <CodeViewer project={project} refreshKey={0} openRequest={{ path: tablePath, nonce: 1 }} />
    )
    await waitFor(() => expect(read).toHaveBeenCalledWith(project.id, tablePath))

    await act(async () => {
      table.resolve(content(tablePath, 'export const account = true'))
    })
    expect((await screen.findByTestId('monaco-value')).textContent).toContain(
      'export const account = true'
    )

    await act(async () => {
      config.resolve(content(configPath, 'id: lead-tracker'))
    })
    expect(screen.getByTestId('monaco-value').textContent).toContain('export const account = true')
    expect(screen.queryByText('id: lead-tracker')).toBeNull()
  })
})

describe('CodeViewer files that no longer exist', () => {
  const configPath = 'rayfin/rayfin.yml'
  const gone = 'rayfin/connectors/healthcare/Providers.ts'

  it.each([
    ['remembered from an earlier visit', undefined],
    ['asked for by a link', { path: gone, line: 12, nonce: 1 }]
  ])('opens the Rayfin config instead of one %s', async (_, openRequest) => {
    const read = vi.fn((_projectId: string, path: string) =>
      Promise.resolve<FileContent>(
        path === configPath
          ? content(configPath, 'id: clinic')
          : { path, size: 0, error: 'File not found.', missing: true }
      )
    )
    ;(window as unknown as { api: unknown }).api = {
      projects: {
        files: {
          tree: vi.fn(() =>
            Promise.resolve([
              {
                name: 'rayfin',
                path: 'rayfin',
                type: 'dir',
                children: [{ name: 'rayfin.yml', path: configPath, type: 'file' }]
              }
            ])
          ),
          read
        }
      }
    }
    const project = makeProject('p1')
    localStorage.setItem(`rayfin.code.file.${project.id}`, gone)

    render(<CodeViewer project={project} refreshKey={0} openRequest={openRequest} />)

    expect((await screen.findByTestId('monaco-value')).textContent).toBe('id: clinic')
    expect(read).toHaveBeenCalledWith(project.id, gone)
    expect(screen.queryByText('File not found.')).toBeNull()
    expect(localStorage.getItem(`rayfin.code.file.${project.id}`)).toBe(configPath)
  })
})
