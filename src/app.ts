import { Hono } from 'hono'
import type { Executor } from './executor.ts'
import type { Forge, ForgeKind } from './forge.ts'

export interface AppDeps {
  forges: Partial<Record<ForgeKind, { forge: Forge; webhookSecret: string }>>
  executor: Executor
  /** Labels every job must include to be picked up. Empty = match anything. */
  requiredLabels: string[]
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  const log = deps.log ?? defaultLog

  app.get('/', (c) => c.text('stellwerk'))
  app.get('/healthz', (c) => c.json({ ok: true }))

  app.post('/webhook/:forge', async (c) => {
    const kind = c.req.param('forge') as ForgeKind
    const entry = deps.forges[kind]
    if (!entry) return c.json({ error: `forge "${kind}" not configured` }, 404)

    const body = await c.req.text()
    const ok = await entry.forge.verifyWebhook(entry.webhookSecret, body, c.req.raw.headers)
    if (!ok) {
      log('webhook signature rejected', { forge: kind })
      return c.json({ error: 'invalid signature' }, 401)
    }

    const event = entry.forge.parseJobEvent(body, c.req.raw.headers)
    if (!event) return c.json({ ignored: true }, 200)
    if (event.action !== 'queued') return c.json({ ignored: true, action: event.action }, 200)

    if (!hasAllLabels(event.labels, deps.requiredLabels)) {
      log('job skipped (label mismatch)', {
        forge: kind,
        jobId: event.jobId,
        jobLabels: event.labels,
        required: deps.requiredLabels,
      })
      return c.json({ ignored: true, reason: 'label-mismatch' }, 200)
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
    return c.json({ ok: true, runnerId }, 202)
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
