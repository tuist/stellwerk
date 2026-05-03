import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { appDeps, mockExecutor, withMcpClient } from './helpers.ts'

const spawnBody = {
  forge: 'github',
  scope: { installationId: '99', repoFullName: 'octo/repo' },
  repoUrl: 'https://github.com/octo/repo',
  labels: ['self-hosted', 'stellwerk'],
}

describe('POST /runners', () => {
  it('mints a token and spawns a runner', async () => {
    const exec = mockExecutor()
    const app = createApp(appDeps({ executor: exec }))
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
    const app = createApp(appDeps())
    const res = await app.request('/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spawnBody, jobId: 'custom-1' }),
    })
    const payload = (await res.json()) as { jobId: string }
    expect(payload.jobId).toBe('custom-1')
  })

  it('returns 404 when the forge is not configured', async () => {
    const app = createApp(appDeps())
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
    const app = createApp(appDeps({ executor: exec }))
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
    const app = createApp(appDeps({ executor: exec }))
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
    const app = createApp(appDeps({ executor: exec }))
    const res = await app.request('/runners/runner-1', { method: 'DELETE' })
    expect(res.status).toBe(502)
  })
})

describe('MCP runner tools', () => {
  it('spawn_runner provisions a runner via the executor', async () => {
    const exec = mockExecutor()
    const result = await withMcpClient(appDeps({ executor: exec }), (client) =>
      client.callTool({ name: 'spawn_runner', arguments: spawnBody }),
    )
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
    expect(JSON.parse(text)).toMatchObject({ runnerId: 'runner-1' })
    expect(exec.spawnCalls).toHaveLength(1)
  })

  it('destroy_runner asks the executor to destroy', async () => {
    const exec = mockExecutor()
    await withMcpClient(appDeps({ executor: exec }), (client) =>
      client.callTool({ name: 'destroy_runner', arguments: { id: 'runner-1' } }),
    )
    expect(exec.destroyCalls).toEqual(['runner-1'])
  })
})
