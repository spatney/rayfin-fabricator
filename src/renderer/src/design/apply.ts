import type { DesignApplyReceipt, DesignStudioApi } from '@shared/design'
import type { DeployResult } from '@shared/ipc'
import { canRetryDesignDeployment, designError } from './protocol'
import { DesignSession } from './session'

export interface DesignApplyServices {
  api: DesignStudioApi
  capture: () => Promise<string>
  saveScreenshot: (dataUrl: string) => Promise<string>
  cleanupScreenshot: (paths: string[]) => Promise<void>
  deploy: (projectId: string, workspace?: string, applyId?: string) => Promise<DeployResult>
  refresh: () => Promise<void>
  onTurnStart: (projectId: string, turnId: string, count: number) => void
  onTurnComplete: (
    projectId: string,
    turnId: string,
    receipt: DesignApplyReceipt | null,
    error?: string
  ) => void
}

async function deployAndVerify(
  session: DesignSession,
  services: DesignApplyServices,
  receipt: DesignApplyReceipt,
  workspace?: string
): Promise<void> {
  const documentId = session.getSnapshot().snapshot?.documentId
  session.setProgress('Deploying your changes')
  const result = await services.deploy(session.projectId, workspace, receipt.id)
  await session.refreshReceipt()
  await services.refresh()
  if (!result.ok) {
    throw new Error(
      result.error ??
        'Your source was updated, but deployment did not complete. Retry deployment without reapplying.'
    )
  }
  session.setProgress('Checking the refreshed app')
  if (documentId) await session.waitForFreshDocument(documentId)
  const verified = await session.verifyApplied()
  if (!verified)
    session.reportError(
      'The app was deployed. Review the highlighted changes before starting a new draft.'
    )
}

export async function applyDesign(
  session: DesignSession,
  services: DesignApplyServices
): Promise<void> {
  let screenshotPath: string | undefined
  let turnId: string | undefined
  let receipt: DesignApplyReceipt | null = null
  let prepared = false
  try {
    const draft = await session.prepareApply()
    prepared = true
    await session.command({ type: 'capture', enabled: true }, true)
    try {
      screenshotPath = await services.saveScreenshot(await services.capture())
    } catch (reason) {
      session.reportError(
        `Screenshot unavailable; applying the recorded changes without it. ${designError(reason)}`
      )
    } finally {
      await session.command({ type: 'capture', enabled: false }, true)
    }
    await session.command({ type: 'compare', enabled: true }, true)
    turnId = crypto.randomUUID()
    services.onTurnStart(session.projectId, turnId, draft.cursor)
    session.setProgress('Updating your app with Copilot')
    receipt = await services.api.apply(session.projectId, turnId, draft.revision, screenshotPath)
    session.setReceipt(receipt)
    services.onTurnComplete(session.projectId, turnId, receipt)
    turnId = undefined
    if (receipt.phase !== 'source-updated') {
      throw new Error(
        receipt.error ?? 'The source changes need attention before they can be deployed.'
      )
    }
    await deployAndVerify(session, services, receipt)
  } catch (reason) {
    if (turnId) {
      try {
        receipt = await session.refreshReceipt()
      } catch (recoveryError) {
        session.reportError(
          `Could not read the Apply recovery record: ${designError(recoveryError)}`
        )
      }
      services.onTurnComplete(session.projectId, turnId, receipt, designError(reason))
    }
    session.reportError(reason)
    throw reason
  } finally {
    if (prepared) {
      session.finishBusy()
      await session.resumeUnappliedDraft()
    }
    if (screenshotPath) {
      try {
        await services.cleanupScreenshot([screenshotPath])
      } catch (reason) {
        console.error('Could not clean up the design screenshot', reason)
      }
    }
  }
}

export async function retryDesignDeployment(
  session: DesignSession,
  services: DesignApplyServices,
  workspace?: string
): Promise<void> {
  const receipt = await session.refreshReceipt()
  if (!receipt || !canRetryDesignDeployment(receipt)) {
    throw new Error('There is no completed source update ready to retry deployment.')
  }
  session.startDeploymentRetry()
  try {
    await deployAndVerify(session, services, receipt, workspace)
  } finally {
    session.finishBusy()
  }
}
