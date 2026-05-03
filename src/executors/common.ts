import type { SpawnOpts } from '../executor.ts'
import type { ForgeKind } from '../forge.ts'

export interface ImageOptions {
  imageNamespace?: string
  imageOverrides?: Partial<Record<ForgeKind, string>>
}

export function runnerImage(opts: ImageOptions, forge: ForgeKind): string {
  return opts.imageOverrides?.[forge] ?? `${opts.imageNamespace ?? 'ghcr.io/stellwerk'}/runner-${forge}:latest`
}

export function runnerEnv(opts: SpawnOpts): Record<string, string> {
  return {
    RUNNER_TOKEN: opts.registrationToken,
    RUNNER_REPO_URL: opts.repoUrl,
    ...(opts.forgeUrl ? { RUNNER_FORGE_URL: opts.forgeUrl } : {}),
    RUNNER_LABELS: opts.labels.join(','),
    RUNNER_JOB_ID: opts.jobId,
    STELLWERK_FORGE: opts.forge,
  }
}

export function envPairs(env: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(env).map(([name, value]) => ({ name, value }))
}

export function safeName(value: string, max = 63): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
  const trimmed = out.slice(0, max).replace(/-+$/g, '')
  return trimmed || 'runner'
}

export function volumeName(value: string | undefined, fallback: string): string {
  return safeName(value ?? fallback)
}
