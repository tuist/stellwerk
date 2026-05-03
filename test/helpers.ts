import { expect } from 'vitest'
import type { createApp, AppDeps } from '../src/app.ts'
import type { Executor, SpawnOpts } from '../src/executor.ts'
import type { Forge, JobEvent } from '../src/forge.ts'

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

export async function callMcp<T = unknown>(app: ReturnType<typeof createApp>, body: unknown): Promise<T> {
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
