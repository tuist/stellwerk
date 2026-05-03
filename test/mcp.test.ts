import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { appDeps, withMcpClient } from './helpers.ts'

describe('MCP server', () => {
  it('exposes the full tool surface (read + write)', async () => {
    const { tools } = await withMcpClient(appDeps(), (client) => client.listTools())
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['destroy_runner', 'health', 'list_forges', 'spawn_runner'])
  })

  it('list_forges mirrors GET /forges', async () => {
    const result = await withMcpClient(appDeps(), (client) => client.callTool({ name: 'list_forges', arguments: {} }))
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ forges: [{ kind: 'github' }] })
  })

  it('health returns ok=true', async () => {
    const result = await withMcpClient(appDeps(), (client) => client.callTool({ name: 'health', arguments: {} }))
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ ok: true })
  })
})

describe('POST /mcp (HTTP transport mount)', () => {
  it('serves Streamable HTTP at /mcp', async () => {
    const app = createApp(appDeps())
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/event-stream/)
  })
})
