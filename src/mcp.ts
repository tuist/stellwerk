import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from 'hono'
import type { ForgeKind } from './forge.ts'

export interface McpDeps {
  listForges: () => ForgeKind[]
}

export const MCP_SERVER_INFO = { name: 'stellwerk', version: '0.1.0' } as const

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { capabilities: { tools: {} } })

  server.registerTool(
    'health',
    {
      title: 'Health check',
      description: 'Returns ok=true once the Stellwerk control plane is serving requests.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    }),
  )

  server.registerTool(
    'list_forges',
    {
      title: 'List configured forges',
      description: 'Returns the set of forges this Stellwerk deployment is wired up to handle webhooks for.',
      inputSchema: {},
    },
    async () => {
      const forges = deps.listForges().map((kind) => ({ kind }))
      return {
        content: [{ type: 'text', text: JSON.stringify({ forges }) }],
      }
    },
  )

  return server
}

export function createMcpHttpHandler(deps: McpDeps): (c: Context) => Promise<Response> {
  return async (c) => {
    const server = createMcpServer(deps)
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    const res = await transport.handleRequest(c)
    return res ?? c.body(null, 204)
  }
}
