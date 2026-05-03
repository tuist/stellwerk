import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { appDeps, mockExecutor, mockForge, queuedEvent } from './helpers.ts'

describe('POST /webhook/:forge', () => {
  it('returns 404 when forge is not configured', async () => {
    const app = createApp(appDeps())
    const res = await app.request('/webhook/gitlab', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 401 on signature failure', async () => {
    const forge = mockForge({ verifyWebhook: async () => false })
    const app = createApp(appDeps({ forge }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('ignores non-job events', async () => {
    const forge = mockForge({ event: null })
    const app = createApp(appDeps({ forge }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ignored: true })
  })

  it('ignores non-queued actions without spawning', async () => {
    const forge = mockForge({ event: { ...queuedEvent, action: 'completed' } })
    const exec = mockExecutor()
    const app = createApp(appDeps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(exec.spawnCalls).toHaveLength(0)
  })

  it('skips jobs missing required labels', async () => {
    const forge = mockForge({ event: { ...queuedEvent, labels: ['self-hosted'] } })
    const exec = mockExecutor()
    const app = createApp(appDeps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ reason: 'label-mismatch' })
    expect(exec.spawnCalls).toHaveLength(0)
  })

  it('mints a token and spawns a runner on a matching queued job', async () => {
    const forge = mockForge({ event: queuedEvent })
    const exec = mockExecutor()
    const app = createApp(appDeps({ forge, executor: exec }))
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
    const app = createApp(appDeps({ forge, executor: exec }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
  })

  it('matches everything when no required labels', async () => {
    const forge = mockForge({ event: { ...queuedEvent, labels: ['anything'] } })
    const exec = mockExecutor()
    const app = createApp(appDeps({ forge, executor: exec, required: [] }))
    const res = await app.request('/webhook/github', { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    expect(exec.spawnCalls).toHaveLength(1)
  })
})
