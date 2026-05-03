import type { AppDeps } from './app.ts'
import { GithubForge } from './forges/github.ts'
import { GitlabForge } from './forges/gitlab.ts'
import { CodebergForge } from './forges/codeberg.ts'
import { FlyExecutor } from './executors/fly.ts'
import { DockerAgentExecutor } from './executors/docker-agent.ts'
import { KubernetesExecutor } from './executors/kubernetes.ts'
import { AwsEcsExecutor } from './executors/aws-ecs.ts'
import { GcpBatchExecutor } from './executors/gcp-batch.ts'
import { HetznerExecutor } from './executors/hetzner.ts'
import { NomadExecutor } from './executors/nomad.ts'
import type { Executor, RunnerVolume, VolumeMode } from './executor.ts'

export interface RawEnv {
  EXECUTOR?: string
  RUNNER_LABELS?: string
  RUNNER_IMAGE_NAMESPACE?: string
  RUNNER_VOLUMES?: string

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
  FLY_CPUS?: string
  FLY_MEMORY_MB?: string

  // Docker-agent executor
  AGENT_URL?: string
  AGENT_TOKEN?: string

  // Kubernetes executor
  K8S_API_SERVER?: string
  K8S_NAMESPACE?: string
  K8S_BEARER_TOKEN?: string
  K8S_SERVICE_ACCOUNT?: string
  K8S_IMAGE_PULL_SECRET?: string
  K8S_JOB_PREFIX?: string
  K8S_CACHE_CLAIM_PREFIX?: string
  K8S_TTL_SECONDS_AFTER_FINISHED?: string
  K8S_CPU_REQUEST?: string
  K8S_MEMORY_REQUEST?: string
  K8S_CPU_LIMIT?: string
  K8S_MEMORY_LIMIT?: string

  // AWS ECS executor
  AWS_REGION?: string
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_SESSION_TOKEN?: string
  AWS_ECS_CLUSTER?: string
  AWS_ECS_SUBNETS?: string
  AWS_ECS_SECURITY_GROUPS?: string
  AWS_ECS_ASSIGN_PUBLIC_IP?: string
  AWS_ECS_EXECUTION_ROLE_ARN?: string
  AWS_ECS_TASK_ROLE_ARN?: string
  AWS_ECS_FAMILY_PREFIX?: string
  AWS_ECS_LAUNCH_TYPE?: string
  AWS_ECS_PLATFORM_VERSION?: string
  AWS_ECS_CPU?: string
  AWS_ECS_MEMORY_MB?: string
  AWS_ECS_LOG_GROUP?: string
  AWS_ECS_LOG_STREAM_PREFIX?: string
  AWS_ECS_EBS_VOLUME_ROLE_ARN?: string

  // Hetzner Cloud executor
  HETZNER_API_TOKEN?: string
  HETZNER_SERVER_TYPE?: string
  HETZNER_IMAGE?: string
  HETZNER_LOCATION?: string
  HETZNER_DATACENTER?: string
  HETZNER_SSH_KEYS?: string
  HETZNER_NETWORKS?: string
  HETZNER_LABELS?: string
  HETZNER_DISABLE_IPV4?: string
  HETZNER_DISABLE_IPV6?: string

  // Nomad executor
  NOMAD_ADDR?: string
  NOMAD_TOKEN?: string
  NOMAD_NAMESPACE?: string
  NOMAD_REGION?: string
  NOMAD_DATACENTERS?: string
  NOMAD_JOB_PREFIX?: string
  NOMAD_CPU_MHZ?: string
  NOMAD_MEMORY_MB?: string

  // GCP Batch executor
  GCP_PROJECT?: string
  GCP_LOCATION?: string
  GCP_ACCESS_TOKEN?: string
  GCP_SERVICE_ACCOUNT_EMAIL?: string
  GCP_SERVICE_ACCOUNT_PRIVATE_KEY?: string
  GCP_BATCH_RUNTIME_SERVICE_ACCOUNT_EMAIL?: string
  GCP_BATCH_NETWORK?: string
  GCP_BATCH_SUBNETWORK?: string
  GCP_BATCH_NO_EXTERNAL_IP?: string
  GCP_BATCH_MACHINE_TYPE?: string
  GCP_BATCH_PROVISIONING_MODEL?: string
  GCP_BATCH_CPU_MILLI?: string
  GCP_BATCH_MEMORY_MIB?: string
  GCP_BATCH_BOOT_DISK_MIB?: string
  GCP_BATCH_JOB_PREFIX?: string
  GCP_BATCH_CACHE_GCS_BUCKET?: string
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
  return { forges, executor, requiredLabels, runnerVolumes: parseRunnerVolumes(env.RUNNER_VOLUMES) }
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
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
      cpus: parseOptionalInt(env.FLY_CPUS),
      memoryMb: parseOptionalInt(env.FLY_MEMORY_MB),
    })
  }
  if (choice === 'docker-agent') {
    if (!env.AGENT_URL || !env.AGENT_TOKEN) {
      throw new Error('EXECUTOR=docker-agent requires AGENT_URL and AGENT_TOKEN')
    }
    return new DockerAgentExecutor({
      agentUrl: env.AGENT_URL,
      agentToken: env.AGENT_TOKEN,
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
    })
  }
  if (choice === 'kubernetes' || choice === 'k8s') {
    if (!env.K8S_API_SERVER || !env.K8S_NAMESPACE || !env.K8S_BEARER_TOKEN) {
      throw new Error('EXECUTOR=kubernetes requires K8S_API_SERVER, K8S_NAMESPACE, and K8S_BEARER_TOKEN')
    }
    return new KubernetesExecutor({
      apiServer: env.K8S_API_SERVER,
      namespace: env.K8S_NAMESPACE,
      bearerToken: env.K8S_BEARER_TOKEN,
      serviceAccountName: env.K8S_SERVICE_ACCOUNT,
      imagePullSecretName: env.K8S_IMAGE_PULL_SECRET,
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
      jobPrefix: env.K8S_JOB_PREFIX,
      cacheClaimPrefix: env.K8S_CACHE_CLAIM_PREFIX,
      ttlSecondsAfterFinished: parseOptionalInt(env.K8S_TTL_SECONDS_AFTER_FINISHED),
      cpuRequest: env.K8S_CPU_REQUEST,
      memoryRequest: env.K8S_MEMORY_REQUEST,
      cpuLimit: env.K8S_CPU_LIMIT,
      memoryLimit: env.K8S_MEMORY_LIMIT,
    })
  }
  if (choice === 'aws-ecs' || choice === 'ecs') {
    if (
      !env.AWS_REGION ||
      !env.AWS_ACCESS_KEY_ID ||
      !env.AWS_SECRET_ACCESS_KEY ||
      !env.AWS_ECS_CLUSTER ||
      !env.AWS_ECS_SUBNETS ||
      !env.AWS_ECS_EXECUTION_ROLE_ARN
    ) {
      throw new Error(
        'EXECUTOR=aws-ecs requires AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ECS_CLUSTER, AWS_ECS_SUBNETS, and AWS_ECS_EXECUTION_ROLE_ARN',
      )
    }
    return new AwsEcsExecutor({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      },
      cluster: env.AWS_ECS_CLUSTER,
      subnets: parseList(env.AWS_ECS_SUBNETS),
      securityGroups: parseList(env.AWS_ECS_SECURITY_GROUPS),
      assignPublicIp: parseOptionalBool(env.AWS_ECS_ASSIGN_PUBLIC_IP),
      executionRoleArn: env.AWS_ECS_EXECUTION_ROLE_ARN,
      taskRoleArn: env.AWS_ECS_TASK_ROLE_ARN,
      familyPrefix: env.AWS_ECS_FAMILY_PREFIX,
      launchType: parseAwsLaunchType(env.AWS_ECS_LAUNCH_TYPE),
      platformVersion: env.AWS_ECS_PLATFORM_VERSION,
      cpu: env.AWS_ECS_CPU,
      memoryMb: env.AWS_ECS_MEMORY_MB,
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
      logGroupName: env.AWS_ECS_LOG_GROUP,
      logStreamPrefix: env.AWS_ECS_LOG_STREAM_PREFIX,
      ebsVolumeRoleArn: env.AWS_ECS_EBS_VOLUME_ROLE_ARN,
    })
  }
  if (choice === 'gcp-batch' || choice === 'gcp') {
    if (!env.GCP_PROJECT || !env.GCP_LOCATION) {
      throw new Error('EXECUTOR=gcp-batch requires GCP_PROJECT and GCP_LOCATION')
    }
    if (!env.GCP_ACCESS_TOKEN && (!env.GCP_SERVICE_ACCOUNT_EMAIL || !env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY)) {
      throw new Error(
        'EXECUTOR=gcp-batch requires GCP_ACCESS_TOKEN or GCP_SERVICE_ACCOUNT_EMAIL and GCP_SERVICE_ACCOUNT_PRIVATE_KEY',
      )
    }
    return new GcpBatchExecutor({
      project: env.GCP_PROJECT,
      location: env.GCP_LOCATION,
      accessToken: env.GCP_ACCESS_TOKEN,
      serviceAccountEmail: env.GCP_SERVICE_ACCOUNT_EMAIL,
      privateKeyPem: env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY,
      runtimeServiceAccountEmail: env.GCP_BATCH_RUNTIME_SERVICE_ACCOUNT_EMAIL,
      network: env.GCP_BATCH_NETWORK,
      subnetwork: env.GCP_BATCH_SUBNETWORK,
      noExternalIpAddress: parseOptionalBool(env.GCP_BATCH_NO_EXTERNAL_IP),
      machineType: env.GCP_BATCH_MACHINE_TYPE,
      provisioningModel: parseGcpProvisioningModel(env.GCP_BATCH_PROVISIONING_MODEL),
      cpuMilli: env.GCP_BATCH_CPU_MILLI,
      memoryMib: env.GCP_BATCH_MEMORY_MIB,
      bootDiskMib: env.GCP_BATCH_BOOT_DISK_MIB,
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
      jobPrefix: env.GCP_BATCH_JOB_PREFIX,
      cacheGcsBucket: env.GCP_BATCH_CACHE_GCS_BUCKET,
    })
  }
  if (choice === 'hetzner' || choice === 'hetzner-cloud') {
    if (!env.HETZNER_API_TOKEN) {
      throw new Error('EXECUTOR=hetzner requires HETZNER_API_TOKEN')
    }
    return new HetznerExecutor({
      apiToken: env.HETZNER_API_TOKEN,
      serverType: env.HETZNER_SERVER_TYPE,
      image: env.HETZNER_IMAGE,
      location: env.HETZNER_LOCATION,
      datacenter: env.HETZNER_DATACENTER,
      sshKeys: parseList(env.HETZNER_SSH_KEYS),
      networks: parseList(env.HETZNER_NETWORKS).map((value) => {
        const n = Number(value)
        if (!Number.isInteger(n)) throw new Error(`HETZNER_NETWORKS entries must be numeric ids, got ${value}`)
        return n
      }),
      labels: parseLabels(env.HETZNER_LABELS),
      enableIpv4: env.HETZNER_DISABLE_IPV4 ? !parseRequiredBool(env.HETZNER_DISABLE_IPV4) : undefined,
      enableIpv6: env.HETZNER_DISABLE_IPV6 ? !parseRequiredBool(env.HETZNER_DISABLE_IPV6) : undefined,
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
    })
  }
  if (choice === 'nomad') {
    if (!env.NOMAD_ADDR) {
      throw new Error('EXECUTOR=nomad requires NOMAD_ADDR')
    }
    return new NomadExecutor({
      address: env.NOMAD_ADDR,
      token: env.NOMAD_TOKEN,
      namespace: env.NOMAD_NAMESPACE,
      region: env.NOMAD_REGION,
      datacenters: parseList(env.NOMAD_DATACENTERS),
      jobPrefix: env.NOMAD_JOB_PREFIX,
      cpuMhz: parseOptionalInt(env.NOMAD_CPU_MHZ),
      memoryMb: parseOptionalInt(env.NOMAD_MEMORY_MB),
      imageNamespace: env.RUNNER_IMAGE_NAMESPACE,
    })
  }
  throw new Error(`unknown EXECUTOR: ${choice}`)
}

function parseLabels(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  const out: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new Error(`labels must be key=value, got ${trimmed}`)
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseRequiredBool(value: string): boolean {
  const parsed = parseOptionalBool(value)
  if (parsed === undefined) throw new Error(`expected boolean, got ${value}`)
  return parsed
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  if (!Number.isInteger(n)) throw new Error(`expected integer, got ${value}`)
  return n
}

function parseOptionalBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  throw new Error(`expected boolean, got ${value}`)
}

function parseAwsLaunchType(
  value: string | undefined,
): 'EC2' | 'FARGATE' | 'EXTERNAL' | 'MANAGED_INSTANCES' | undefined {
  if (!value) return undefined
  const normalized = value.toUpperCase()
  if (
    normalized === 'EC2' ||
    normalized === 'FARGATE' ||
    normalized === 'EXTERNAL' ||
    normalized === 'MANAGED_INSTANCES'
  ) {
    return normalized
  }
  throw new Error(`unknown AWS_ECS_LAUNCH_TYPE: ${value}`)
}

function parseGcpProvisioningModel(value: string | undefined): 'STANDARD' | 'SPOT' | undefined {
  if (!value) return undefined
  const normalized = value.toUpperCase()
  if (normalized === 'STANDARD' || normalized === 'SPOT') return normalized
  throw new Error(`unknown GCP_BATCH_PROVISIONING_MODEL: ${value}`)
}

function parseRunnerVolumes(value: string | undefined): RunnerVolume[] {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('RUNNER_VOLUMES must be a JSON array')
  return parsed.map(parseRunnerVolume)
}

function parseRunnerVolume(value: unknown): RunnerVolume {
  if (!isRecord(value)) throw new Error('RUNNER_VOLUMES entries must be objects')
  const kind = value.kind
  if (kind !== 'scratch' && kind !== 'cache' && kind !== 'persistent') {
    throw new Error('RUNNER_VOLUMES entries require kind scratch, cache, or persistent')
  }
  if (typeof value.mountPath !== 'string' || !value.mountPath.startsWith('/')) {
    throw new Error('RUNNER_VOLUMES entries require an absolute mountPath')
  }
  const base = {
    name: optionalString(value.name),
    mountPath: value.mountPath,
    sizeGb: optionalNumber(value.sizeGb),
  }
  if (kind === 'scratch') return { kind, ...base }
  const mode = optionalMode(value.mode)
  if (kind === 'cache') {
    if (typeof value.key !== 'string' || value.key.length === 0) throw new Error('cache volumes require key')
    return { kind, ...base, key: value.key, scope: optionalScope(value.scope), mode }
  }
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error('persistent volumes require id')
  return { kind, ...base, id: value.id, mode }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('volume sizeGb must be a number')
  return value
}

function optionalMode(value: unknown): VolumeMode | undefined {
  if (value === undefined) return undefined
  if (value === 'ro' || value === 'rw-exclusive' || value === 'rw-shared') return value
  throw new Error('volume mode must be ro, rw-exclusive, or rw-shared')
}

function optionalScope(value: unknown): 'repo' | 'org' | 'pool' | undefined {
  if (value === undefined) return undefined
  if (value === 'repo' || value === 'org' || value === 'pool') return value
  throw new Error('cache volume scope must be repo, org, or pool')
}
