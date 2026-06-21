import type { RayfinStudioApi } from '../shared/ipc'

declare global {
  interface Window {
    api: RayfinStudioApi
  }
}

export {}
