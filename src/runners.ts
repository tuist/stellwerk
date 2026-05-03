import type { RouteHandler } from '@hono/zod-openapi'
import type { Executor, RunnerVolume } from './executor.ts'
import type { Forge, ForgeKind, JobScope } from './forge.ts'
import type { Logger } from './log.ts'
import type { destroyRunnerRoute, spawnRunnerRoute } from './openapi.ts'

export interface RunnerDeps {
  forges: Partial<Record<ForgeKind, { forge: Forge; webhookSecret: string }>>
  executor: Executor
  runnerVolumes?: RunnerVolume[]
  log: Logger
}

export interface SpawnRunnerRequest {
  forge: ForgeKind
  scope: Omit<JobScope, 'forge'>
  repoUrl: string
  labels: string[]
  forgeUrl?: string
  jobId?: string
}

export type SpawnRunnerResult =
  | { kind: 'ok'; runnerId: string; jobId: string }
  | { kind: 'forge-not-configured'; forge: ForgeKind }
  | { kind: 'mint-failed'; error: string }
  | { kind: 'spawn-failed'; error: string }

export type DestroyRunnerResult = { kind: 'ok' } | { kind: 'destroy-failed'; error: string }

export async function provisionRunner(deps: RunnerDeps, req: SpawnRunnerRequest): Promise<SpawnRunnerResult> {
  const entry = deps.forges[req.forge]
  if (!entry) return { kind: 'forge-not-configured', forge: req.forge }

  const scope: JobScope = { forge: req.forge, ...req.scope }
  const jobId = req.jobId ?? `manual-${crypto.randomUUID()}`

  let registrationToken: string
  try {
    registrationToken = await entry.forge.mintRunnerToken(scope, req.labels)
  } catch (err) {
    deps.log('mint runner token failed', { forge: req.forge, jobId, error: String(err) })
    return { kind: 'mint-failed', error: String(err) }
  }

  let runnerId: string
  try {
    runnerId = await deps.executor.spawnRunner({
      forge: req.forge,
      registrationToken,
      repoUrl: req.repoUrl,
      forgeUrl: req.forgeUrl,
      labels: req.labels,
      jobId,
      volumes: deps.runnerVolumes,
    })
  } catch (err) {
    deps.log('executor spawn failed', { forge: req.forge, jobId, error: String(err) })
    return { kind: 'spawn-failed', error: String(err) }
  }

  deps.log('runner spawned', { forge: req.forge, jobId, runnerId, source: 'api' })
  return { kind: 'ok', runnerId, jobId }
}

export async function destroyRunner(deps: RunnerDeps, id: string): Promise<DestroyRunnerResult> {
  try {
    await deps.executor.destroyRunner(id)
    deps.log('runner destroyed', { runnerId: id, source: 'api' })
    return { kind: 'ok' }
  } catch (err) {
    deps.log('executor destroy failed', { runnerId: id, error: String(err) })
    return { kind: 'destroy-failed', error: String(err) }
  }
}

export function createSpawnRunnerHandler(deps: RunnerDeps): RouteHandler<typeof spawnRunnerRoute> {
  return async (c) => {
    const body = c.req.valid('json')
    const result = await provisionRunner(deps, body)
    switch (result.kind) {
      case 'ok':
        return c.json({ runnerId: result.runnerId, jobId: result.jobId }, 202)
      case 'forge-not-configured':
        return c.json({ error: `forge "${result.forge}" not configured` }, 404)
      case 'mint-failed':
        return c.json({ error: 'mint token failed' }, 502)
      case 'spawn-failed':
        return c.json({ error: 'spawn failed' }, 502)
    }
  }
}

export function createDestroyRunnerHandler(deps: RunnerDeps): RouteHandler<typeof destroyRunnerRoute> {
  return async (c) => {
    const { id } = c.req.valid('param')
    const result = await destroyRunner(deps, id)
    if (result.kind === 'ok') return c.body(null, 204)
    return c.json({ error: 'destroy failed' }, 502)
  }
}
