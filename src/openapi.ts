import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { MCP_SERVER_INFO } from './mcp.ts'

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

export const JobScopeSchema = z
  .object({
    installationId: z.string().optional(),
    projectId: z.string().optional(),
    repoFullName: z.string().optional(),
  })
  .openapi('JobScope')

export const SpawnRunnerRequestSchema = z
  .object({
    forge: ForgeKindSchema,
    scope: JobScopeSchema,
    repoUrl: z.string(),
    labels: z.array(z.string()),
    forgeUrl: z.string().optional(),
    jobId: z.string().optional(),
  })
  .openapi('SpawnRunnerRequest')

export const SpawnRunnerResponseSchema = z
  .object({ runnerId: z.string(), jobId: z.string() })
  .openapi('SpawnRunnerResponse')

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

export const spawnRunnerRoute = createRoute({
  method: 'post',
  path: '/runners',
  tags: ['runners'],
  summary: 'Spawn a runner',
  description:
    'Mints a runner registration token via the configured forge and asks the executor to boot a runner. The same flow the webhook uses, exposed for clients that want to provision a runner outside of a forge event.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: SpawnRunnerRequestSchema } },
    },
  },
  responses: {
    202: { description: 'Runner spawned', ...jsonContent(SpawnRunnerResponseSchema) },
    404: { description: 'Forge not configured', ...jsonContent(ErrorSchema) },
    502: { description: 'Forge or executor failure', ...jsonContent(ErrorSchema) },
  },
})

export const destroyRunnerRoute = createRoute({
  method: 'delete',
  path: '/runners/{id}',
  tags: ['runners'],
  summary: 'Destroy a runner',
  description: 'Asks the executor to destroy a previously-spawned runner. Idempotent on the executor side.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: 'Runner destroyed' },
    502: { description: 'Executor failure', ...jsonContent(ErrorSchema) },
  },
})

export function mountOpenApiDocs(app: OpenAPIHono): void {
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Stellwerk',
      version: MCP_SERVER_INFO.version,
      description: 'Self-hostable, pluggable compute orchestrator. v0.1 ships ephemeral CI runners for any git forge.',
    },
  })
  app.get('/docs', swaggerUI({ url: '/openapi.json' }))
}
