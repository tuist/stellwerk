import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { StreamableHTTPTransport } from '@hono/mcp'
import type { Executor } from './executor.ts'
import type { Forge, ForgeKind } from './forge.ts'
import { createMcpServer, MCP_SERVER_INFO } from './mcp.ts'
import { healthRoute, listForgesRoute, webhookRoute } from './openapi.ts'

export interface AppDeps {
  forges: Partial<Record<ForgeKind, { forge: Forge; webhookSecret: string }>>
  executor: Executor
  /** Labels every job must include to be picked up. Empty = match anything. */
  requiredLabels: string[]
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono()
  const log = deps.log ?? defaultLog

  app.get('/', (c) => c.text('stellwerk'))

  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200))

  app.openapi(listForgesRoute, (c) => {
    const forges = (Object.keys(deps.forges) as ForgeKind[])
      .filter((kind) => deps.forges[kind])
      .map((kind) => ({ kind }))
    return c.json({ forges }, 200)
  })

  app.openapi(webhookRoute, async (c) => {
    const kind = c.req.valid('param').forge
    const entry = deps.forges[kind]
    if (!entry) return c.json({ error: `forge "${kind}" not configured` }, 404)

    const body = await c.req.text()
    const ok = await entry.forge.verifyWebhook(entry.webhookSecret, body, c.req.raw.headers)
    if (!ok) {
      log('webhook signature rejected', { forge: kind })
      return c.json({ error: 'invalid signature' }, 401)
    }

    const event = entry.forge.parseJobEvent(body, c.req.raw.headers)
    if (!event) return c.json({ ignored: true as const }, 200)
    if (event.action !== 'queued') return c.json({ ignored: true as const, action: event.action }, 200)

    if (!hasAllLabels(event.labels, deps.requiredLabels)) {
      log('job skipped (label mismatch)', {
        forge: kind,
        jobId: event.jobId,
        jobLabels: event.labels,
        required: deps.requiredLabels,
      })
      return c.json({ ignored: true as const, reason: 'label-mismatch' }, 200)
    }

    let registrationToken: string
    try {
      registrationToken = await entry.forge.mintRunnerToken(event.scope, event.labels)
    } catch (err) {
      log('mint runner token failed', { forge: kind, jobId: event.jobId, error: String(err) })
      return c.json({ error: 'mint token failed' }, 502)
    }

    let runnerId: string
    try {
      runnerId = await deps.executor.spawnRunner({
        forge: kind,
        registrationToken,
        repoUrl: event.repoUrl,
        forgeUrl: event.forgeUrl,
        labels: event.labels,
        jobId: event.jobId,
      })
    } catch (err) {
      log('executor spawn failed', { forge: kind, jobId: event.jobId, error: String(err) })
      return c.json({ error: 'spawn failed' }, 502)
    }

    log('runner spawned', { forge: kind, jobId: event.jobId, runnerId })
    return c.json({ ok: true as const, runnerId }, 202)
  })

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Stellwerk',
      version: MCP_SERVER_INFO.version,
      description: 'Self-hostable, pluggable compute orchestrator. v0.1 ships ephemeral CI runners for any git forge.',
    },
  })

  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  app.all('/mcp', async (c) => {
    const server = createMcpServer({
      listForges: () => (Object.keys(deps.forges) as ForgeKind[]).filter((kind) => deps.forges[kind]),
    })
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    const res = await transport.handleRequest(c)
    return res ?? c.body(null, 204)
  })

  return app
}

function hasAllLabels(jobLabels: string[], required: string[]): boolean {
  if (required.length === 0) return true
  const set = new Set(jobLabels)
  return required.every((l) => set.has(l))
}

function defaultLog(msg: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ msg, ...fields, ts: new Date().toISOString() }))
}
