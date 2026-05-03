import { OpenAPIHono } from '@hono/zod-openapi'
import type { Executor, RunnerVolume } from './executor.ts'
import type { Forge, ForgeKind } from './forge.ts'
import { defaultLog, type Logger } from './log.ts'
import { createMcpHttpHandler } from './mcp.ts'
import {
  destroyRunnerRoute,
  healthRoute,
  listForgesRoute,
  mountOpenApiDocs,
  spawnRunnerRoute,
  webhookRoute,
} from './openapi.ts'
import {
  createDestroyRunnerHandler,
  createSpawnRunnerHandler,
  destroyRunner,
  provisionRunner,
  type RunnerDeps,
} from './runners.ts'
import { createWebhookHandler } from './webhook.ts'

export interface AppDeps {
  forges: Partial<Record<ForgeKind, { forge: Forge; webhookSecret: string }>>
  executor: Executor
  /** Labels every job must include to be picked up. Empty = match anything. */
  requiredLabels: string[]
  /** Volumes attached to every spawned runner. */
  runnerVolumes?: RunnerVolume[]
  log?: Logger
}

export function createApp(deps: AppDeps) {
  const log = deps.log ?? defaultLog
  const app = new OpenAPIHono()
  const runnerDeps: RunnerDeps = {
    forges: deps.forges,
    executor: deps.executor,
    runnerVolumes: deps.runnerVolumes,
    log,
  }

  app.get('/', (c) => c.text('stellwerk'))
  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200))
  app.openapi(listForgesRoute, (c) => c.json({ forges: configuredForges(deps).map((kind) => ({ kind })) }, 200))
  app.openapi(webhookRoute, createWebhookHandler({ ...deps, log }))
  app.openapi(spawnRunnerRoute, createSpawnRunnerHandler(runnerDeps))
  app.openapi(destroyRunnerRoute, createDestroyRunnerHandler(runnerDeps))

  mountOpenApiDocs(app)
  app.all(
    '/mcp',
    createMcpHttpHandler({
      listForges: () => configuredForges(deps),
      spawnRunner: (req) => provisionRunner(runnerDeps, req),
      destroyRunner: (id) => destroyRunner(runnerDeps, id),
    }),
  )

  return app
}

function configuredForges(deps: AppDeps): ForgeKind[] {
  return (Object.keys(deps.forges) as ForgeKind[]).filter((kind) => deps.forges[kind])
}
