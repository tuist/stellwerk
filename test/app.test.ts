import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { appDeps } from './helpers.ts'

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const app = createApp(appDeps())
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET /forges', () => {
  it('lists configured forges', async () => {
    const app = createApp(appDeps())
    const res = await app.request('/forges')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ forges: [{ kind: 'github' }] })
  })
})

describe('GET /openapi.json', () => {
  it('serves an OpenAPI document that documents the public routes', async () => {
    const app = createApp(appDeps())
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
