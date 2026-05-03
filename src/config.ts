import type { AppDeps } from './app.ts'
import { GithubForge } from './forges/github.ts'
import { GitlabForge } from './forges/gitlab.ts'
import { CodebergForge } from './forges/codeberg.ts'
import { FlyExecutor } from './executors/fly.ts'
import { DockerAgentExecutor } from './executors/docker-agent.ts'
import type { Executor } from './executor.ts'

export interface RawEnv {
  EXECUTOR?: string
  RUNNER_LABELS?: string

  // GitHub forge
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
  GITHUB_WEBHOOK_SECRET?: string

  // GitLab forge
  GITLAB_ACCESS_TOKEN?: string
  GITLAB_WEBHOOK_SECRET?: string
  GITLAB_BASE_URL?: string
  GITLAB_RUNNER_TAGS?: string

  // Codeberg forge
  CODEBERG_ACCESS_TOKEN?: string
  CODEBERG_RUNNER_REGISTRATION_TOKEN?: string
  CODEBERG_WEBHOOK_SECRET?: string
  CODEBERG_SERVER_URL?: string
  CODEBERG_API_BASE_URL?: string

  // Fly executor
  FLY_API_TOKEN?: string
  FLY_APP?: string
  FLY_REGION?: string

  // Docker-agent executor
  AGENT_URL?: string
  AGENT_TOKEN?: string
}

export function buildAppDepsFromEnv(env: RawEnv): AppDeps {
  const forges: AppDeps['forges'] = {}
  const requiredLabels = parseList(env.RUNNER_LABELS)

  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET) {
    forges.github = {
      forge: new GithubForge({
        appId: env.GITHUB_APP_ID,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      }),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    }
  }

  if (env.GITLAB_ACCESS_TOKEN && env.GITLAB_WEBHOOK_SECRET) {
    forges.gitlab = {
      forge: new GitlabForge({
        accessToken: env.GITLAB_ACCESS_TOKEN,
        webhookSecret: env.GITLAB_WEBHOOK_SECRET,
        baseUrl: env.GITLAB_BASE_URL,
        runnerTags: parseList(env.GITLAB_RUNNER_TAGS ?? env.RUNNER_LABELS),
      }),
      webhookSecret: env.GITLAB_WEBHOOK_SECRET,
    }
  }

  if (env.CODEBERG_WEBHOOK_SECRET && (env.CODEBERG_ACCESS_TOKEN || env.CODEBERG_RUNNER_REGISTRATION_TOKEN)) {
    forges.codeberg = {
      forge: new CodebergForge({
        accessToken: env.CODEBERG_ACCESS_TOKEN,
        registrationToken: env.CODEBERG_RUNNER_REGISTRATION_TOKEN,
        webhookSecret: env.CODEBERG_WEBHOOK_SECRET,
        serverUrl: env.CODEBERG_SERVER_URL,
        apiBaseUrl: env.CODEBERG_API_BASE_URL,
      }),
      webhookSecret: env.CODEBERG_WEBHOOK_SECRET,
    }
  }

  if (Object.keys(forges).length === 0) {
    throw new Error('no forges configured (set GitHub, GitLab, or Codeberg forge credentials)')
  }

  const executor = buildExecutorFromEnv(env)
  return { forges, executor, requiredLabels }
}

function buildExecutorFromEnv(env: RawEnv): Executor {
  const choice = (env.EXECUTOR ?? 'fly').toLowerCase()
  if (choice === 'fly') {
    if (!env.FLY_API_TOKEN || !env.FLY_APP) {
      throw new Error('EXECUTOR=fly requires FLY_API_TOKEN and FLY_APP')
    }
    return new FlyExecutor({
      apiToken: env.FLY_API_TOKEN,
      app: env.FLY_APP,
      region: env.FLY_REGION,
    })
  }
  if (choice === 'docker-agent') {
    if (!env.AGENT_URL || !env.AGENT_TOKEN) {
      throw new Error('EXECUTOR=docker-agent requires AGENT_URL and AGENT_TOKEN')
    }
    return new DockerAgentExecutor({ agentUrl: env.AGENT_URL, agentToken: env.AGENT_TOKEN })
  }
  throw new Error(`unknown EXECUTOR: ${choice}`)
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
