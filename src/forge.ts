export type ForgeKind = 'github' | 'gitlab' | 'gitea' | 'codeberg'

export interface JobScope {
  forge: ForgeKind
  installationId?: string
  projectId?: string
  repoFullName?: string
}

export interface JobEvent {
  action: 'queued' | 'in_progress' | 'completed'
  jobId: string
  scope: JobScope
  labels: string[]
  repoUrl: string
  forgeUrl?: string
}

export interface Forge {
  readonly kind: ForgeKind
  verifyWebhook(secret: string, body: string, headers: Headers): Promise<boolean>
  parseJobEvent(body: string, headers: Headers): JobEvent | null
  mintRunnerToken(scope: JobScope, labels: string[]): Promise<string>
}
