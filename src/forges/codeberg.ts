import type { Forge, ForgeKind, JobEvent, JobScope } from '../forge.ts'
import { verifyHmacSha256Hex, verifyHmacSha256HexRaw } from '../util/crypto.ts'

export interface CodebergForgeOptions {
  webhookSecret: string
  /** Defaults to Codeberg. */
  serverUrl?: string
  /** Defaults to `${serverUrl}/api/v1`. */
  apiBaseUrl?: string
  /** Token with access to fetch repo runner registration tokens. */
  accessToken?: string
  /** Static UI-created runner registration token. */
  registrationToken?: string
  /** Override for testing. */
  fetch?: typeof fetch
}

interface CodebergWorkflowJobPayload {
  action: string
  workflow_job?: {
    id: number | string
    labels?: string[]
    status?: string
  }
  repository?: {
    full_name?: string
    html_url?: string
    clone_url?: string
  }
}

const DEFAULT_SERVER_URL = 'https://codeberg.org'

export class CodebergForge implements Forge {
  readonly kind: ForgeKind = 'codeberg'
  private readonly serverUrl: string
  private readonly apiBaseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: CodebergForgeOptions) {
    this.serverUrl = trimTrailingSlash(opts.serverUrl ?? DEFAULT_SERVER_URL)
    this.apiBaseUrl = trimTrailingSlash(opts.apiBaseUrl ?? `${this.serverUrl}/api/v1`)
    this.fetchFn = opts.fetch ?? fetch
  }

  async verifyWebhook(secret: string, body: string, headers: Headers): Promise<boolean> {
    const forgejoSig = headers.get('x-forgejo-signature')
    if (forgejoSig && (await verifyHmacSha256HexRaw(secret, body, forgejoSig))) return true

    const giteaSig = headers.get('x-gitea-signature')
    if (giteaSig && (await verifyHmacSha256HexRaw(secret, body, giteaSig))) return true

    const githubSig = headers.get('x-hub-signature-256')
    return githubSig ? verifyHmacSha256Hex(secret, body, githubSig) : false
  }

  parseJobEvent(body: string, headers: Headers): JobEvent | null {
    const eventType =
      headers.get('x-forgejo-event-type') ??
      headers.get('x-gitea-event-type') ??
      headers.get('x-github-event-type') ??
      headers.get('x-forgejo-event') ??
      headers.get('x-gitea-event') ??
      headers.get('x-github-event')
    if (eventType !== 'workflow_job') return null

    let payload: CodebergWorkflowJobPayload
    try {
      payload = JSON.parse(body) as CodebergWorkflowJobPayload
    } catch {
      return null
    }

    const workflowJob = payload.workflow_job
    const repo = payload.repository
    if (!workflowJob || !repo?.full_name) return null

    const action = actionForWorkflowJob(payload.action, workflowJob.status)
    if (!action) return null

    return {
      action,
      jobId: String(workflowJob.id),
      labels: workflowJob.labels ?? [],
      repoUrl: repo.html_url ?? repo.clone_url ?? `${this.serverUrl}/${repo.full_name}`,
      forgeUrl: this.serverUrl,
      scope: {
        forge: 'codeberg',
        repoFullName: repo.full_name,
      },
    }
  }

  async mintRunnerToken(scope: JobScope, _labels: string[] = []): Promise<string> {
    if (this.opts.registrationToken) return this.opts.registrationToken
    if (!this.opts.accessToken) throw new Error('Codeberg: missing access token or runner registration token')
    if (!scope.repoFullName) throw new Error('Codeberg: missing repoFullName on scope')

    const res = await this.fetchFn(
      `${this.apiBaseUrl}/repos/${encodeRepoFullName(scope.repoFullName)}/actions/runners/registration-token`,
      {
        headers: {
          accept: 'application/json',
          authorization: `token ${this.opts.accessToken}`,
        },
      },
    )
    if (!res.ok) {
      throw new Error(`Codeberg: registration-token failed: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as { token?: string }
    if (!data.token) throw new Error('Codeberg: registration-token response did not include token')
    return data.token
  }
}

function actionForWorkflowJob(action: string, status: string | undefined): JobEvent['action'] | null {
  const value = status ?? action
  if (value === 'queued') return 'queued'
  if (value === 'in_progress') return 'in_progress'
  if (value === 'completed') return 'completed'
  return null
}

function encodeRepoFullName(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/')
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}
