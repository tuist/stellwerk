import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from '../src/app.ts'
import type { Forge, JobEvent } from '../src/forge.ts'
import type { Executor, SpawnOpts } from '../src/executor.ts'

function mockForge(over: Partial<Forge> & { event?: JobEvent | null } = {}): Forge & { mintCalls: number } {
  const m = {
    kind: 'github' as const,
    mintCalls: 0,
    verifyWebhook: over.verifyWebhook ?? (async () => true),
    parseJobEvent: over.parseJobEvent ?? (() => over.event ?? null),
    mintRunnerToken:
      over.mintRunnerToken ??
      (async () => {
        m.mintCalls++
        return 'tok-xyz'
      }),
  }
  return m
}

function mockExecutor(over: Partial<Executor> = {}): Executor & { spawnCalls: SpawnOpts[] } {
  const calls: SpawnOpts[] = []
  return {
    spawnCalls: calls,
    spawnRunner:
      over.spawnRunner ??
      (async (opts) => {
        calls.push(opts)
        return 'runner-1'
      }),
    destroyRunner: over.destroyRunner ?? (async () => {}),
  }
}

function deps(over: Partial<AppDeps> & { forge?: Forge; executor?: Executor; required?: string[] } = {}): AppDeps {
  const forge = over.forge ?? mockForge()
  return {
    forges: { github: { forge, webhookSecret: 'shh' } },
    executor: over.executor ?? mockExecutor(),
    requiredLabels: over.required ?? ['self-hosted', 'stellwerk'],
    log: () => {},
  }
}

const queuedEvent: JobEvent = {
  action: 'queued',
  jobId: '42',
  labels: ['self-hosted', 'stellwerk'],
  repoUrl: 'https://github.com/octo/repo',
  scope: { forge: 'github', installationId: '99', repoFullName: 'octo/repo' },
}

describe('POST /webhook/:forge', () => {
  it('returns 404 when forge is not configured', async () => {
    const app = createApp(deps())
    const res = await app.request('/webhook/gitlab', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 401 on signature failure', async () => {
    const forge = mockForge({ verifyWebhook: async () => false })
    const app = createApp(deps({ forge }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('ignores non-job events', async () => {
    const forge = mockForge({ event: null })
    const app = createApp(deps({ forge }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ignored: true })
  })

  it('ignores non-queued actions without spawning', async () => {
    const forge = mockForge({ event: { ...queuedEvent, action: 'completed' } })
    const exec = mockExecutor()
    const app = createApp(deps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(exec.spawnCalls).toHaveLength(0)
  })

  it('skips jobs missing required labels', async () => {
    const forge = mockForge({ event: { ...queuedEvent, labels: ['self-hosted'] } })
    const exec = mockExecutor()
    const app = createApp(deps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ reason: 'label-mismatch' })
    expect(exec.spawnCalls).toHaveLength(0)
  })

  it('mints a token and spawns a runner on a matching queued job', async () => {
    const forge = mockForge({ event: queuedEvent })
    const exec = mockExecutor()
    const app = createApp(deps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, runnerId: 'runner-1' })
    expect(exec.spawnCalls).toHaveLength(1)
    expect(exec.spawnCalls[0]).toMatchObject({
      forge: 'github',
      registrationToken: 'tok-xyz',
      labels: queuedEvent.labels,
      jobId: '42',
    })
  })

  it('returns 502 when executor fails', async () => {
    const forge = mockForge({ event: queuedEvent })
    const exec = mockExecutor({
      spawnRunner: async () => {
        throw new Error('boom')
      },
    })
    const app = createApp(deps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
  })

  it('matches everything when no required labels', async () => {
    const forge = mockForge({ event: { ...queuedEvent, labels: ['anything'] } })
    const exec = mockExecutor()
    const app = createApp(deps({ forge, executor: exec, required: [] }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    expect(exec.spawnCalls).toHaveLength(1)
  })
})

describe('healthz', () => {
  it('returns ok', async () => {
    const app = createApp(deps())
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('vi smoke', () => {
  it('vitest is wired', () => {
    expect(vi).toBeDefined()
  })
})
