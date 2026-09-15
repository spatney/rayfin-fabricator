import type { RayfinStudioApi } from '@shared/ipc'

type PreviewMutations = Pick<
  RayfinStudioApi['preview'],
  'showUrl' | 'navigate' | 'setBounds' | 'hide' | 'suppress' | 'reload' | 'back' | 'forward'
>

/**
 * Creation is asynchronous; later moves/hides must not reach Rust before the
 * child exists. Keep this queue with the API, not with a mount of PreviewPane.
 */
export function serializePreviewMutations(api: PreviewMutations): PreviewMutations {
  let pendingShow: Promise<void> | null = null
  const enqueue = (command: () => Promise<void>, showing = false): Promise<void> => {
    let result: Promise<void>
    try {
      result = pendingShow ? pendingShow.then(command) : command()
    } catch (error) {
      result = Promise.reject(error)
    }
    const settled = result.catch((error: unknown) => {
      console.error('Native preview command failed', error)
    })
    // Only showUrl is an async Rust command. Do not hold live resize/hide
    // commands behind delayed IPC replies once creation/show has completed.
    if (showing) {
      pendingShow = settled
      void settled.then(() => {
        if (pendingShow === settled) pendingShow = null
      })
    }
    return result
  }
  return {
    showUrl: (url, bounds) => enqueue(() => api.showUrl(url, bounds), true),
    navigate: (url, bounds) => enqueue(() => api.navigate(url, bounds)),
    setBounds: (bounds) => enqueue(() => api.setBounds(bounds)),
    hide: () => enqueue(() => api.hide()),
    suppress: (bounds) => enqueue(() => api.suppress(bounds)),
    reload: () => enqueue(() => api.reload()),
    back: () => enqueue(() => api.back()),
    forward: () => enqueue(() => api.forward())
  }
}
