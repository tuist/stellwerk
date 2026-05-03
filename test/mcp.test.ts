import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { appDeps, callMcp } from './helpers.ts'

describe('MCP transport', () => {
  it('exposes the full tool surface (read + write) at /mcp', async () => {
    const app = createApp(appDeps())
    const payload = await callMcp<{ result: { tools: { name: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    const names = payload.result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['destroy_runner', 'health', 'list_forges', 'spawn_runner'])
  })

  it('list_forges mirrors GET /forges', async () => {
    const app = createApp(appDeps())
    const payload = await callMcp<{ result: { content: { text: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_forges', arguments: {} },
    })
    const text = payload.result.content[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ forges: [{ kind: 'github' }] })
  })

  it('health returns ok=true', async () => {
    const app = createApp(appDeps())
    const payload = await callMcp<{ result: { content: { text: string }[] } }>(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'health', arguments: {} },
    })
    const text = payload.result.content[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ ok: true })
  })
})
