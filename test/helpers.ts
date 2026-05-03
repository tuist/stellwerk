import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpDeps, buildRunnerDeps, type AppDeps } from '../src/app.ts'
import type { Executor, SpawnOpts } from '../src/executor.ts'
import type { Forge, JobEvent } from '../src/forge.ts'
import { createMcpServer } from '../src/mcp.ts'

export function mockForge(over: Partial<Forge> & { event?: JobEvent | null } = {}): Forge & { mintCalls: number } {
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

export function mockExecutor(
  over: Partial<Executor> = {},
): Executor & { spawnCalls: SpawnOpts[]; destroyCalls: string[] } {
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

export function appDeps(
  over: Partial<AppDeps> & { forge?: Forge; executor?: Executor; required?: string[] } = {},
): AppDeps {
  const forge = over.forge ?? mockForge()
  return {
    forges: { github: { forge, webhookSecret: 'shh' } },
    executor: over.executor ?? mockExecutor(),
    requiredLabels: over.required ?? ['self-hosted', 'stellwerk'],
    log: () => {},
  }
}

export const queuedEvent: JobEvent = {
  action: 'queued',
  jobId: '42',
  labels: ['self-hosted', 'stellwerk'],
  repoUrl: 'https://github.com/octo/repo',
  scope: { forge: 'github', installationId: '99', repoFullName: 'octo/repo' },
}

export async function withMcpClient<T>(deps: AppDeps, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer(buildMcpDeps(deps, buildRunnerDeps(deps)))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'stellwerk-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return await fn(client)
  } finally {
    await client.close()
    await server.close()
  }
}
