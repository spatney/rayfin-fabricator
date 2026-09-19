import type { DeployResult } from '@shared/ipc'

export interface DeploymentRequest {
  projectId: string
  workspace?: string
  applyId?: string
}

type Runner = (projectId: string, workspace?: string, applyId?: string) => Promise<DeployResult>
interface Job {
  request: DeploymentRequest
  run: Runner
  result: Promise<DeployResult>
  resolve: (result: DeployResult) => void
}

function key(request: DeploymentRequest): string {
  return JSON.stringify([request.projectId, request.workspace ?? null, request.applyId ?? null])
}

export class DeploymentQueue {
  private pending: Job[] = []
  private active: Job | null = null

  enqueue(request: DeploymentRequest, run: Runner): Promise<DeployResult> {
    const existing =
      this.pending.find((job) => key(job.request) === key(request)) ??
      (request.applyId && this.active && key(this.active.request) === key(request)
        ? this.active
        : undefined)
    if (existing) return existing.result
    let resolve!: (result: DeployResult) => void
    const result = new Promise<DeployResult>((done) => {
      resolve = done
    })
    this.pending.push({ request, run, result, resolve })
    this.advance()
    return result
  }

  cancelPending(error: string): void {
    for (const job of this.pending.splice(0)) job.resolve({ ok: false, outcome: 'error', error })
  }

  private advance(): void {
    if (this.active) return
    const job = this.pending.shift()
    if (!job) return
    this.active = job
    void job
      .run(job.request.projectId, job.request.workspace, job.request.applyId)
      .then(job.resolve, (reason: unknown) => {
        const error = reason instanceof Error ? reason.message : String(reason)
        console.error('Queued deployment failed', reason)
        job.resolve({ ok: false, outcome: 'error', error })
      })
      .finally(() => {
        this.active = null
        this.advance()
      })
  }
}
