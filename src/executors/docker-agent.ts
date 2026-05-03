import type { Executor, SpawnOpts } from '../executor.ts'

export interface DockerAgentExecutorOptions {
  agentUrl: string
  agentToken: string
  /** Per-forge image override. */
  imageOverrides?: Partial<Record<SpawnOpts['forge'], string>>
  imageNamespace?: string
}

export class DockerAgentExecutor implements Executor {
  constructor(private readonly opts: DockerAgentExecutorOptions) {}

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const res = await fetch(`${this.opts.agentUrl.replace(/\/$/, '')}/spawn`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        image: this.imageFor(opts.forge),
        env: {
          RUNNER_TOKEN: opts.registrationToken,
          RUNNER_REPO_URL: opts.repoUrl,
          ...(opts.forgeUrl ? { RUNNER_FORGE_URL: opts.forgeUrl } : {}),
          RUNNER_LABELS: opts.labels.join(','),
          RUNNER_JOB_ID: opts.jobId,
          STELLWERK_FORGE: opts.forge,
        },
      }),
    })
    if (!res.ok) {
      throw new Error(`docker-agent: spawn failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { id: string }
    return data.id
  }

  async destroyRunner(id: string): Promise<void> {
    const res = await fetch(`${this.opts.agentUrl.replace(/\/$/, '')}/destroy/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.agentToken}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`docker-agent: destroy failed: ${res.status} ${await res.text()}`)
    }
  }

  private imageFor(forge: SpawnOpts['forge']): string {
    return (
      this.opts.imageOverrides?.[forge] ?? `${this.opts.imageNamespace ?? 'ghcr.io/stellwerk'}/runner-${forge}:latest`
    )
  }
}
