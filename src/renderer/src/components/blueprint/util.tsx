import type { StudioProject } from '@shared/ipc'
import type { AppIdentityInfo, Identity } from '../../model/architecture'

import type { JSX } from 'react'

export const IDENTITY_LABEL: Record<Identity, string> = { user: 'User’s identity', app: 'App identity', key: 'A key' }

/** What a part's connections use to sign in, as its port says it. */
export const PORT_LABEL: Record<Identity, string> = {
  user: 'Uses user’s identity',
  app: 'Uses app identity',
  key: 'Uses a key'
}

/** The app identity in a few words: who it is, or how it will be decided. */
export function appIdentityName(identity: AppIdentityInfo, deployed: boolean): string {
  return identity.who ?? (deployed ? 'The account that first deployed it' : 'Whoever deploys it first')
}

export const IDENTITY_ICON: Record<Identity, string> = { user: 'person', app: 'robot', key: 'key' }

/** A deployed app's links: its own address, and its item in the Fabric portal. */
export interface DeployState {
  url?: string
  portalUrl?: string
}

export function deployState(project: StudioProject): DeployState {
  return { url: project.lastDeploy?.url, portalUrl: project.lastDeploy?.portalUrl }
}

export function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The Fabric portal this app's tenant uses (it differs in test rings), for links. */
export function portalOrigin(project: StudioProject): string {
  try {
    if (project.lastDeploy?.portalUrl) return new URL(project.lastDeploy.portalUrl).origin
  } catch {
    /* fall through */
  }
  return 'https://app.fabric.microsoft.com'
}

/** A stable hue per name, for marks (the same scheme as the workspace overview). */
export function hueOf(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** The Fabric workspace the app is deployed to, as a lowercase id, when known. */
export function appWorkspaceId(project: StudioProject): string | undefined {
  const fromPortal = /\/groups\/([0-9a-f-]{36})/i.exec(project.lastDeploy?.portalUrl ?? '')?.[1]
  if (fromPortal) return fromPortal.toLowerCase()
  const team = project.team
  const ws = team ? (team.view === 'preview' ? team.preview?.workspaceId : team.production?.workspaceId) : project.workspace
  return ws && /^[0-9a-f-]{36}$/i.test(ws) ? ws.toLowerCase() : undefined
}

/** Microsoft Fabric's mark, for the zones of things that live in Fabric. */
export function FabricMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="bp-fabric-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 9.5 16 4l10 5.5-10 5.5Z" fill="#3fcfaf" />
      <path d="M6 15.5 16 21l10-5.5" fill="none" stroke="#1f9d8b" strokeWidth="3" strokeLinejoin="round" />
      <path d="M6 21.5 16 27l10-5.5" fill="none" stroke="#167a70" strokeWidth="3" strokeLinejoin="round" opacity="0.75" />
    </svg>
  )
}
