import type { Forge, ForgeKind, JobEvent, JobScope } from '../forge.ts'
import { stringToBytes, timingSafeEqual } from '../util/encoding.ts'
import { verifyStandardWebhookSha256 } from '../util/crypto.ts'

export interface GitlabForgeOptions {
  accessToken: string
  webhookSecret: string
  /** Defaults to gitlab.com. */
  baseUrl?: string
  /** Tags this Stellwerk pool registers on GitLab runners. */
  runnerTags?: string[]
  /** Override for testing. */
  fetch?: typeof fetch
}

interface GitlabJobHookPayload {
  object_kind: 'build'
  build_id: number | string
  build_status: string
  project_id: number | string
  runner?: { tags?: string[] } | null
  repository?: { homepage?: string; url?: string; git_http_url?: string }
  project?: {
    id?: number | string
    web_url?: string
    http_url?: string
    path_with_namespace?: string
  }
}

const DEFAULT_BASE_URL = 'https://gitlab.com'

export class GitlabForge implements Forge {
  readonly kind: ForgeKind = 'gitlab'
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: GitlabForgeOptions) {
    this.baseUrl = trimTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL)
    this.fetchFn = opts.fetch ?? fetch
  }

  async verifyWebhook(secret: string, body: string, headers: Headers): Promise<boolean> {
    const standardSignature = headers.get('webhook-signature')
    if (standardSignature) {
      const id = headers.get('webhook-id')
      const timestamp = headers.get('webhook-timestamp')
      if (!id || !timestamp) return false
      return verifyStandardWebhookSha256(secret, id, timestamp, body, standardSignature)
    }

    const token = headers.get('x-gitlab-token')
    return token ? timingSafeEqual(stringToBytes(secret), stringToBytes(token)) : false
  }

  parseJobEvent(body: string, headers: Headers): JobEvent | null {
    if (headers.get('x-gitlab-event') !== 'Job Hook') return null

    let payload: GitlabJobHookPayload
    try {
      payload = JSON.parse(body) as GitlabJobHookPayload
    } catch {
      return null
    }

    if (payload.object_kind !== 'build') return null

    const action = actionForBuildStatus(payload.build_status)
    if (!action) return null

    const projectId = payload.project?.id ?? payload.project_id
    const repoUrl = payload.project?.web_url ?? payload.repository?.homepage ?? payload.repository?.url
    if (projectId == null || !repoUrl) return null

    const labels = this.opts.runnerTags ?? payload.runner?.tags ?? []

    return {
      action,
      jobId: String(payload.build_id),
      labels,
      repoUrl,
      forgeUrl: originOf(repoUrl) ?? this.baseUrl,
      scope: {
        forge: 'gitlab',
        projectId: String(projectId),
      },
    }
  }

  async mintRunnerToken(scope: JobScope, labels: string[]): Promise<string> {
    if (!scope.projectId) throw new Error('GitLab: missing projectId on scope')

    const body = new URLSearchParams({
      runner_type: 'project_type',
      project_id: scope.projectId,
      description: `stellwerk-${scope.projectId}-${Date.now()}`,
      run_untagged: labels.length === 0 ? 'true' : 'false',
    })
    if (labels.length > 0) body.set('tag_list', labels.join(','))

    const res = await this.fetchFn(`${this.baseUrl}/api/v4/user/runners`, {
      method: 'POST',
      headers: {
        'private-token': this.opts.accessToken,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    if (!res.ok) {
      throw new Error(`GitLab: create runner failed: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as { token?: string }
    if (!data.token) throw new Error('GitLab: create runner response did not include token')
    return data.token
  }
}

function actionForBuildStatus(status: string): JobEvent['action'] | null {
  if (status === 'created' || status === 'pending') return 'queued'
  if (status === 'running') return 'in_progress'
  if (status === 'success' || status === 'failed' || status === 'canceled' || status === 'skipped') {
    return 'completed'
  }
  return null
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '')
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
