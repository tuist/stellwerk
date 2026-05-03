import type { RouteHandler } from '@hono/zod-openapi'
import type { Executor, RunnerVolume } from './executor.ts'
import type { Forge, ForgeKind } from './forge.ts'
import type { Logger } from './log.ts'
import type { webhookRoute } from './openapi.ts'

export interface WebhookDeps {
  forges: Partial<Record<ForgeKind, { forge: Forge; webhookSecret: string }>>
  executor: Executor
  requiredLabels: string[]
  runnerVolumes?: RunnerVolume[]
  log: Logger
}

export function createWebhookHandler(deps: WebhookDeps): RouteHandler<typeof webhookRoute> {
  return async (c) => {
    const kind = c.req.param('forge') as ForgeKind
    const entry = deps.forges[kind]
    if (!entry) return c.json({ error: `forge "${kind}" not configured` }, 404)

    const body = await c.req.text()
    const ok = await entry.forge.verifyWebhook(entry.webhookSecret, body, c.req.raw.headers)
    if (!ok) {
      deps.log('webhook signature rejected', { forge: kind })
      return c.json({ error: 'invalid signature' }, 401)
    }

    const event = entry.forge.parseJobEvent(body, c.req.raw.headers)
    if (!event) return c.json({ ignored: true as const }, 200)
    if (event.action !== 'queued') return c.json({ ignored: true as const, action: event.action }, 200)

    if (!hasAllLabels(event.labels, deps.requiredLabels)) {
      deps.log('job skipped (label mismatch)', {
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
      deps.log('mint runner token failed', { forge: kind, jobId: event.jobId, error: String(err) })
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
        volumes: deps.runnerVolumes,
      })
    } catch (err) {
      deps.log('executor spawn failed', { forge: kind, jobId: event.jobId, error: String(err) })
      return c.json({ error: 'spawn failed' }, 502)
    }

    deps.log('runner spawned', { forge: kind, jobId: event.jobId, runnerId })
    return c.json({ ok: true as const, runnerId }, 202)
  }
}

function hasAllLabels(jobLabels: string[], required: string[]): boolean {
  if (required.length === 0) return true
  const set = new Set(jobLabels)
  return required.every((l) => set.has(l))
}
