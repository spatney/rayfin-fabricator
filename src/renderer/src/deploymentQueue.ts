import type { DeployResult } from '@shared/ipc'

export interface DeploymentRequest {
  projectId: string
  workspace?: string
  automatic?: boolean
}

type Runner = (projectId: string, workspace?: string) => Promise<DeployResult>
interface Job {
  request: DeploymentRequest
  run: Runner
  result: Promise<DeployResult>
  resolve: (result: DeployResult) => void
}

function key(request: DeploymentRequest): string {
  return JSON.stringify([request.projectId, request.workspace ?? null, Boolean(request.automatic)])
}

/**
 * Runs deployments one at a time, in order. A request identical to one that is
 * still waiting shares that job's result instead of deploying twice; a request
 * made while an identical deploy is already running queues a fresh run, so
 * changes made during that deploy still get published.
 */
export class DeploymentQueue {
  private pending: Job[] = []
  private active: Job | null = null

  enqueue(request: DeploymentRequest, run: Runner): Promise<DeployResult> {
    const existing = this.pending.find((job) => key(job.request) === key(request))
    if (existing) return existing.result
    let resolve!: (result: DeployResult) => void
    const result = new Promise<DeployResult>((done) => {
      resolve = done
    })
    this.pending.push({ request, run, result, resolve })
    this.advance()
    return result
  }

  cancelPending(error: string, matches: (request: DeploymentRequest) => boolean = () => true): void {
    this.pending = this.pending.filter((job) => {
      if (!matches(job.request)) return true
      job.resolve({ ok: false, outcome: 'error', error })
      return false
    })
  }

  private advance(): void {
    if (this.active) return
    const job = this.pending.shift()
    if (!job) return
    this.active = job
    void job
      .run(job.request.projectId, job.request.workspace)
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
