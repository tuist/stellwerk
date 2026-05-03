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

function mockExecutor(over: Partial<Executor> = {}): Executor & { spawnCalls: SpawnOpts[]; destroyCalls: string[] } {
  const spawnCalls: SpawnOpts[] = []
  const destroyCalls: string[] = []
  return {
    spawnCalls,
    destroyCalls,
    spawnRunner:
      over.spawnRunner ??
      (async (opts) => {
        spawnCalls.push(opts)
        return 'runner-1'
      }),
    destroyRunner:
      over.destroyRunner ??
      (async (id) => {
        destroyCalls.push(id)
      }),
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
    expect(doc.paths['/runners']).toHaveProperty('post')
    expect(doc.paths['/runners/{id}']).toHaveProperty('delete')
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

describe('POST /runners', () => {
  const spawnBody = {
    forge: 'github',
    scope: { installationId: '99', repoFullName: 'octo/repo' },
    repoUrl: 'https://github.com/octo/repo',
    labels: ['self-hosted', 'stellwerk'],
  }

  it('mints a token and spawns a runner', async () => {
    const forge = mockForge()
    const exec = mockExecutor()
    const app = createApp(deps({ forge, executor: exec }))
    const res = await app.request('/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spawnBody),
    })
    expect(res.status).toBe(202)
    const payload = (await res.json()) as { runnerId: string; jobId: string }
    expect(payload.runnerId).toBe('runner-1')
    expect(payload.jobId).toMatch(/^manual-/)
    expect(exec.spawnCalls).toHaveLength(1)
    expect(exec.spawnCalls[0]).toMatchObject({
      forge: 'github',
      registrationToken: 'tok-xyz',
      labels: spawnBody.labels,
      repoUrl: spawnBody.repoUrl,
    })
  })

  it('echoes a caller-supplied jobId', async () => {
    const app = createApp(deps())
    const res = await app.request('/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spawnBody, jobId: 'custom-1' }),
    })
    const payload = (await res.json()) as { jobId: string }
    expect(payload.jobId).toBe('custom-1')
  })

  it('returns 404 when the forge is not configured', async () => {
    const app = createApp(deps())
    const res = await app.request('/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spawnBody, forge: 'gitlab' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 502 when the executor fails', async () => {
    const exec = mockExecutor({
      spawnRunner: async () => {
        throw new Error('boom')
      },
    })
    const app = createApp(deps({ executor: exec }))
    const res = await app.request('/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spawnBody),
    })
    expect(res.status).toBe(502)
  })
})

describe('DELETE /runners/:id', () => {
  it('asks the executor to destroy the runner and returns 204', async () => {
    const exec = mockExecutor()
    const app = createApp(deps({ executor: exec }))
    const res = await app.request('/runners/runner-1', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(exec.destroyCalls).toEqual(['runner-1'])
  })

  it('returns 502 when the executor fails', async () => {
    const exec = mockExecutor({
      destroyRunner: async () => {
        throw new Error('boom')
      },
    })
    const app = createApp(deps({ executor: exec }))
    const res = await app.request('/runners/runner-1', { method: 'DELETE' })
    expect(res.status).toBe(502)
  })
})

describe('MCP runner tools', () => {
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

  it('exposes spawn_runner and destroy_runner alongside the read tools', async () => {
    const app = createApp(deps())
    const payload = await callMcp<{ result: { tools: { name: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    const names = payload.result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['destroy_runner', 'health', 'list_forges', 'spawn_runner'])
  })

  it('spawn_runner provisions a runner via the executor', async () => {
    const exec = mockExecutor()
    const app = createApp(deps({ executor: exec }))
    const payload = await callMcp<{ result: { content: { text: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'spawn_runner',
        arguments: {
          forge: 'github',
          scope: { installationId: '99', repoFullName: 'octo/repo' },
          repoUrl: 'https://github.com/octo/repo',
          labels: ['self-hosted', 'stellwerk'],
        },
      },
    })
    const result = JSON.parse(payload.result.content[0]?.text ?? '{}') as { runnerId: string }
    expect(result.runnerId).toBe('runner-1')
    expect(exec.spawnCalls).toHaveLength(1)
  })

  it('destroy_runner asks the executor to destroy', async () => {
    const exec = mockExecutor()
    const app = createApp(deps({ executor: exec }))
    await callMcp(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'destroy_runner', arguments: { id: 'runner-1' } },
    })
    expect(exec.destroyCalls).toEqual(['runner-1'])
  })
})

describe('vi smoke', () => {
  it('vitest is wired', () => {
    expect(vi).toBeDefined()
  })
})
