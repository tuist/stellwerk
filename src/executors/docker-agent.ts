import type { Executor, SpawnOpts } from '../executor.ts'
import { runnerEnv, runnerImage } from './common.ts'

export interface DockerAgentExecutorOptions {
  agentUrl: string
  agentToken: string
  /** Per-forge image override. */
  imageOverrides?: Partial<Record<SpawnOpts['forge'], string>>
  imageNamespace?: string
  fetchFn?: typeof fetch
}

export class DockerAgentExecutor implements Executor {
  constructor(private readonly opts: DockerAgentExecutorOptions) {}

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const res = await (this.opts.fetchFn ?? fetch)(`${this.opts.agentUrl.replace(/\/$/, '')}/spawn`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        image: this.imageFor(opts.forge),
        env: runnerEnv(opts),
        ...(opts.volumes?.length ? { volumes: opts.volumes } : {}),
      }),
    })
    if (!res.ok) {
      throw new Error(`docker-agent: spawn failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { id: string }
    return data.id
  }

  async destroyRunner(id: string): Promise<void> {
    const res = await (this.opts.fetchFn ?? fetch)(
      `${this.opts.agentUrl.replace(/\/$/, '')}/destroy/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.agentToken}` },
      },
    )
    if (!res.ok && res.status !== 404) {
      throw new Error(`docker-agent: destroy failed: ${res.status} ${await res.text()}`)
    }
  }

  private imageFor(forge: SpawnOpts['forge']): string {
    return runnerImage(this.opts, forge)
  }
}
