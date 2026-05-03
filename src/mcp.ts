import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from 'hono'
import { z } from 'zod'
import type { ForgeKind } from './forge.ts'
import type { DestroyRunnerResult, SpawnRunnerRequest, SpawnRunnerResult } from './runners.ts'

export interface McpDeps {
  listForges: () => ForgeKind[]
  spawnRunner: (req: SpawnRunnerRequest) => Promise<SpawnRunnerResult>
  destroyRunner: (id: string) => Promise<DestroyRunnerResult>
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

  server.registerTool(
    'spawn_runner',
    {
      title: 'Spawn a runner',
      description:
        'Mints a runner registration token via the configured forge and asks the executor to boot a runner. Same flow as the forge webhook, exposed for clients that want to provision a runner outside of a forge event.',
      inputSchema: {
        forge: z.enum(['github', 'gitlab', 'gitea', 'codeberg']),
        scope: z.object({
          installationId: z.string().optional(),
          projectId: z.string().optional(),
          repoFullName: z.string().optional(),
        }),
        repoUrl: z.string(),
        labels: z.array(z.string()),
        forgeUrl: z.string().optional(),
        jobId: z.string().optional(),
      },
    },
    async (args) => {
      const result = await deps.spawnRunner(args)
      if (result.kind === 'ok') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ runnerId: result.runnerId, jobId: result.jobId }) }],
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true }
    },
  )

  server.registerTool(
    'destroy_runner',
    {
      title: 'Destroy a runner',
      description: 'Asks the executor to destroy a previously-spawned runner. Idempotent on the executor side.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      const result = await deps.destroyRunner(args.id)
      if (result.kind === 'ok') {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true }
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
