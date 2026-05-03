import type { Executor, SpawnOpts } from '../executor.ts'
import type { ForgeKind } from '../forge.ts'

export interface FlyExecutorOptions {
  apiToken: string
  app: string
  /** Image registry namespace; defaults to `ghcr.io/stellwerk`. */
  imageNamespace?: string
  /** Override per-forge image. Falls back to `<namespace>/runner-<forge>:latest`. */
  imageOverrides?: Partial<Record<ForgeKind, string>>
  region?: string
  cpus?: number
  memoryMb?: number
  /** Override for testing. */
  apiBaseUrl?: string
}

const DEFAULT_API = 'https://api.machines.dev'

export class FlyExecutor implements Executor {
  private readonly apiBase: string

  constructor(private readonly opts: FlyExecutorOptions) {
    this.apiBase = opts.apiBaseUrl ?? DEFAULT_API
  }

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const url = `${this.apiBase}/v1/apps/${this.opts.app}/machines`
    const body = {
      region: this.opts.region,
      config: {
        auto_destroy: true,
        restart: { policy: 'no' },
        guest: {
          cpu_kind: 'shared',
          cpus: this.opts.cpus ?? 2,
          memory_mb: this.opts.memoryMb ?? 2048,
        },
        image: this.imageFor(opts.forge),
        env: {
          RUNNER_TOKEN: opts.registrationToken,
          RUNNER_REPO_URL: opts.repoUrl,
          ...(opts.forgeUrl ? { RUNNER_FORGE_URL: opts.forgeUrl } : {}),
          RUNNER_LABELS: opts.labels.join(','),
          RUNNER_JOB_ID: opts.jobId,
          STELLWERK_FORGE: opts.forge,
        },
      },
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Fly: spawn failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { id: string }
    return data.id
  }

  async destroyRunner(id: string): Promise<void> {
    const url = `${this.apiBase}/v1/apps/${this.opts.app}/machines/${id}?force=true`
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Fly: destroy failed: ${res.status} ${await res.text()}`)
    }
  }

  private imageFor(forge: ForgeKind): string {
    return (
      this.opts.imageOverrides?.[forge] ?? `${this.opts.imageNamespace ?? 'ghcr.io/stellwerk'}/runner-${forge}:latest`
    )
  }
}
