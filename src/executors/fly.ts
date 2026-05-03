import type { Executor, RunnerVolume, SpawnOpts } from '../executor.ts'
import type { ForgeKind } from '../forge.ts'
import { runnerEnv, runnerImage } from './common.ts'

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
  fetchFn?: typeof fetch
}

const DEFAULT_API = 'https://api.machines.dev'

export class FlyExecutor implements Executor {
  private readonly apiBase: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: FlyExecutorOptions) {
    this.apiBase = opts.apiBaseUrl ?? DEFAULT_API
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const url = `${this.apiBase}/v1/apps/${this.opts.app}/machines`
    const mounts = flyMounts(opts.volumes ?? [])
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
        env: runnerEnv(opts),
        ...(mounts.length > 0 ? { mounts } : {}),
      },
    }
    const res = await this.fetchFn(url, {
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
    const res = await this.fetchFn(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Fly: destroy failed: ${res.status} ${await res.text()}`)
    }
  }

  private imageFor(forge: ForgeKind): string {
    return runnerImage(this.opts, forge)
  }
}

function flyMounts(volumes: RunnerVolume[]): Array<{ volume: string; path: string }> {
  const persistent = volumes.filter((volume) => volume.kind === 'persistent')
  if (persistent.length > 1) {
    throw new Error('Fly: only one persistent volume can be mounted per Machine')
  }
  if (volumes.some((volume) => volume.kind === 'cache')) {
    throw new Error('Fly: cache volumes are not shared; use a persistent rw-exclusive volume id')
  }
  return persistent.map((volume) => {
    if (volume.mode === 'rw-shared') {
      throw new Error('Fly: volumes cannot be mounted rw-shared')
    }
    return { volume: volume.id, path: volume.mountPath }
  })
}
