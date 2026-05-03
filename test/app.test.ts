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

describe('GET /forges', () => {
  it('lists configured forges', async () => {
    const app = createApp(deps())
    const res = await app.request('/forges')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ forges: [{ kind: 'github' }] })
  })
})

describe('GET /openapi.json', () => {
  it('serves an OpenAPI document that documents the public routes', async () => {
    const app = createApp(deps())
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as {
      openapi: string
      info: { title: string }
      paths: Record<string, Record<string, unknown>>
    }
    expect(doc.openapi).toMatch(/^3\./)
    expect(doc.info.title).toBe('Stellwerk')
    expect(doc.paths['/healthz']).toHaveProperty('get')
    expect(doc.paths['/forges']).toHaveProperty('get')
    expect(doc.paths['/webhook/{forge}']).toHaveProperty('post')
  })
})

describe('POST /mcp', () => {
  async function callMcp<T = unknown>(app: ReturnType<typeof createApp>, body: unknown): Promise<T> {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) throw new Error(`no data line in SSE response: ${text}`)
    return JSON.parse(dataLine.slice('data: '.length)) as T
  }

  it('lists tools mirroring the REST surface', async () => {
    const app = createApp(deps())
    const payload = await callMcp<{ result: { tools: { name: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    const names = payload.result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['health', 'list_forges'])
  })

  it('exposes list_forges that mirrors GET /forges', async () => {
    const app = createApp(deps())
    const payload = await callMcp<{ result: { content: { type: string; text: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_forges', arguments: {} },
    })
    const text = payload.result.content[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ forges: [{ kind: 'github' }] })
  })
})

describe('vi smoke', () => {
  it('vitest is wired', () => {
    expect(vi).toBeDefined()
  })
})
