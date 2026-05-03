import { createRoute, z } from '@hono/zod-openapi'

export const ForgeKindSchema = z.enum(['github', 'gitlab', 'gitea', 'codeberg']).openapi('ForgeKind')

export const HealthSchema = z.object({ ok: z.literal(true) }).openapi('Health')

export const ForgeSchema = z.object({ kind: ForgeKindSchema }).openapi('Forge')

export const ForgeListSchema = z.object({ forges: z.array(ForgeSchema) }).openapi('ForgeList')

export const ErrorSchema = z.object({ error: z.string() }).openapi('Error')

export const WebhookAcceptedSchema = z.object({ ok: z.literal(true), runnerId: z.string() }).openapi('WebhookAccepted')

export const WebhookIgnoredSchema = z
  .object({
    ignored: z.literal(true),
    reason: z.string().optional(),
    action: z.string().optional(),
  })
  .openapi('WebhookIgnored')

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
})

export const healthRoute = createRoute({
  method: 'get',
  path: '/healthz',
  tags: ['system'],
  summary: 'Liveness probe',
  description: 'Returns 200 once the control plane is serving requests.',
  responses: {
    200: { description: 'Service is up', ...jsonContent(HealthSchema) },
  },
})

export const listForgesRoute = createRoute({
  method: 'get',
  path: '/forges',
  tags: ['forges'],
  summary: 'List configured forges',
  description: 'Returns the set of forges this deployment is wired up to handle webhooks for.',
  responses: {
    200: { description: 'Configured forges', ...jsonContent(ForgeListSchema) },
  },
})

export const webhookRoute = createRoute({
  method: 'post',
  path: '/webhook/{forge}',
  tags: ['webhooks'],
  summary: 'Receive a forge webhook',
  description:
    'Forge-driven endpoint. The request body is verified against the forge-specific signature header before being parsed. Clients should not call this directly.',
  request: {
    params: z.object({ forge: ForgeKindSchema }),
    body: {
      required: true,
      description: 'Raw forge webhook payload (signature-verified).',
      content: { 'application/json': { schema: z.unknown().openapi({ type: 'object' }) } },
    },
  },
  responses: {
    200: { description: 'Event accepted but ignored', ...jsonContent(WebhookIgnoredSchema) },
    202: { description: 'Runner spawned', ...jsonContent(WebhookAcceptedSchema) },
    401: { description: 'Invalid signature', ...jsonContent(ErrorSchema) },
    404: { description: 'Forge not configured', ...jsonContent(ErrorSchema) },
    502: { description: 'Forge or executor failure', ...jsonContent(ErrorSchema) },
  },
})
