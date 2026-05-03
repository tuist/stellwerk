import type { Forge, ForgeKind, JobEvent, JobScope } from '../forge.ts'
import { importRsaPrivateKey, verifyHmacSha256Hex } from '../util/crypto.ts'
import { signJwtRs256 } from '../util/jwt.ts'

export interface GithubForgeOptions {
  appId: string
  privateKeyPem: string
  webhookSecret: string
  /** Override for testing. */
  apiBaseUrl?: string
}

interface WorkflowJobPayload {
  action: 'queued' | 'in_progress' | 'completed' | 'waiting'
  workflow_job: {
    id: number
    run_url: string
    labels: string[]
    html_url?: string
  }
  repository: {
    full_name: string
    html_url: string
  }
  installation?: { id: number }
}

const DEFAULT_API = 'https://api.github.com'

export class GithubForge implements Forge {
  readonly kind: ForgeKind = 'github'
  private readonly apiBase: string
  private keyPromise: Promise<CryptoKey> | undefined

  constructor(private readonly opts: GithubForgeOptions) {
    this.apiBase = opts.apiBaseUrl ?? DEFAULT_API
  }

  async verifyWebhook(secret: string, body: string, headers: Headers): Promise<boolean> {
    const sig = headers.get('x-hub-signature-256')
    if (!sig) return false
    return verifyHmacSha256Hex(secret, body, sig)
  }

  parseJobEvent(body: string, headers: Headers): JobEvent | null {
    if (headers.get('x-github-event') !== 'workflow_job') return null
    let payload: WorkflowJobPayload
    try {
      payload = JSON.parse(body) as WorkflowJobPayload
    } catch {
      return null
    }
    if (payload.action !== 'queued' && payload.action !== 'in_progress' && payload.action !== 'completed') {
      return null
    }
    const installationId = payload.installation?.id
    if (installationId == null) return null
    return {
      action: payload.action,
      jobId: String(payload.workflow_job.id),
      labels: payload.workflow_job.labels ?? [],
      repoUrl: payload.repository.html_url,
      scope: {
        forge: 'github',
        installationId: String(installationId),
        repoFullName: payload.repository.full_name,
      },
    }
  }

  async mintRunnerToken(scope: JobScope): Promise<string> {
    if (!scope.installationId) throw new Error('GitHub: missing installationId on scope')
    if (!scope.repoFullName) throw new Error('GitHub: missing repoFullName on scope')
    const installationToken = await this.exchangeAppJwtForInstallationToken(scope.installationId)
    const url = `${this.apiBase}/repos/${scope.repoFullName}/actions/runners/registration-token`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `token ${installationToken}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stellwerk',
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub: registration-token failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { token: string }
    return data.token
  }

  private async appJwt(): Promise<string> {
    const key = await this.privateKey()
    const now = Math.floor(Date.now() / 1000)
    return signJwtRs256({ iss: this.opts.appId, iat: now - 30, exp: now + 9 * 60 }, key)
  }

  private privateKey(): Promise<CryptoKey> {
    if (!this.keyPromise) this.keyPromise = importRsaPrivateKey(this.opts.privateKeyPem)
    return this.keyPromise
  }

  private async exchangeAppJwtForInstallationToken(installationId: string): Promise<string> {
    const jwt = await this.appJwt()
    const url = `${this.apiBase}/app/installations/${installationId}/access_tokens`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stellwerk',
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub: installation token exchange failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { token: string }
    return data.token
  }
}
