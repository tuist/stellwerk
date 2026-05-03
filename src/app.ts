import { OpenAPIHono } from '@hono/zod-openapi'
import type { Executor } from './executor.ts'
import type { Forge, ForgeKind } from './forge.ts'
import { defaultLog, type Logger } from './log.ts'
import { createMcpHttpHandler } from './mcp.ts'
import { healthRoute, listForgesRoute, mountOpenApiDocs, webhookRoute } from './openapi.ts'
import { createWebhookHandler } from './webhook.ts'

export interface AppDeps {
  forges: Partial<Record<ForgeKind, { forge: Forge; webhookSecret: string }>>
  executor: Executor
  /** Labels every job must include to be picked up. Empty = match anything. */
  requiredLabels: string[]
  log?: Logger
}

export function createApp(deps: AppDeps) {
  const log = deps.log ?? defaultLog
  const app = new OpenAPIHono()

  app.get('/', (c) => c.text('stellwerk'))
  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200))
  app.openapi(listForgesRoute, (c) => c.json({ forges: configuredForges(deps).map((kind) => ({ kind })) }, 200))
  app.openapi(webhookRoute, createWebhookHandler({ ...deps, log }))

  mountOpenApiDocs(app)
  app.all('/mcp', createMcpHttpHandler({ listForges: () => configuredForges(deps) }))

  return app
}

function configuredForges(deps: AppDeps): ForgeKind[] {
  return (Object.keys(deps.forges) as ForgeKind[]).filter((kind) => deps.forges[kind])
}
