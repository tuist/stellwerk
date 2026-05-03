import type { Executor, RunnerVolume, SpawnOpts } from '../executor.ts'
import type { ForgeKind } from '../forge.ts'
import { runnerEnv, runnerImage, safeName } from './common.ts'

export interface HetznerExecutorOptions {
  apiToken: string
  serverType?: string
  image?: string
  location?: string
  datacenter?: string
  sshKeys?: Array<string | number>
  networks?: number[]
  labels?: Record<string, string>
  enableIpv4?: boolean
  enableIpv6?: boolean
  imageNamespace?: string
  imageOverrides?: Partial<Record<ForgeKind, string>>
  apiBaseUrl?: string
  fetchFn?: typeof fetch
}

const DEFAULT_API = 'https://api.hetzner.cloud/v1'
const DEFAULT_SERVER_TYPE = 'cx22'
const DEFAULT_IMAGE = 'ubuntu-24.04'

interface HetznerVolumeAttachments {
  ids: number[]
  dockerMounts: Array<{ source: string; target: string }>
}

export class HetznerExecutor implements Executor {
  private readonly apiBase: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: HetznerExecutorOptions) {
    this.apiBase = (opts.apiBaseUrl ?? DEFAULT_API).replace(/\/$/, '')
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const name = this.serverName(opts)
    const attachments = hetznerVolumes(opts.volumes ?? [])
    const userData = renderCloudInit({
      image: runnerImage(this.opts, opts.forge),
      env: runnerEnv(opts),
      dockerMounts: attachments.dockerMounts,
    })
    const body: Record<string, unknown> = {
      name,
      server_type: this.opts.serverType ?? DEFAULT_SERVER_TYPE,
      image: this.opts.image ?? DEFAULT_IMAGE,
      user_data: userData,
      labels: {
        'stellwerk.dev/forge': safeName(opts.forge),
        'stellwerk.dev/job-id': safeName(opts.jobId),
        ...this.opts.labels,
      },
      ...(this.opts.location ? { location: this.opts.location } : {}),
      ...(this.opts.datacenter ? { datacenter: this.opts.datacenter } : {}),
      ...(this.opts.sshKeys?.length ? { ssh_keys: this.opts.sshKeys } : {}),
      ...(this.opts.networks?.length ? { networks: this.opts.networks } : {}),
      ...(attachments.ids.length > 0 ? { volumes: attachments.ids, automount: false } : {}),
      ...(this.opts.enableIpv4 === false || this.opts.enableIpv6 === false
        ? {
            public_net: {
              enable_ipv4: this.opts.enableIpv4 ?? true,
              enable_ipv6: this.opts.enableIpv6 ?? true,
            },
          }
        : {}),
    }
    const res = await this.fetchFn(`${this.apiBase}/servers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Hetzner: spawn failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { server?: { id?: number } }
    if (typeof data.server?.id !== 'number') {
      throw new Error('Hetzner: spawn response missing server.id')
    }
    return String(data.server.id)
  }

  async destroyRunner(id: string): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Hetzner: destroy failed: ${res.status} ${await res.text()}`)
    }
  }

  private serverName(opts: SpawnOpts): string {
    const suffix = crypto.randomUUID().slice(0, 8)
    return safeName(`stellwerk-${opts.forge}-${opts.jobId}-${suffix}`)
  }
}

function hetznerVolumes(volumes: RunnerVolume[]): HetznerVolumeAttachments {
  const ids: number[] = []
  const dockerMounts: Array<{ source: string; target: string }> = []
  for (const volume of volumes) {
    if (volume.kind === 'scratch') continue
    if (volume.kind === 'cache') {
      throw new Error('Hetzner: cache volumes are not supported; use object storage from inside the runner')
    }
    if (volume.mode === 'ro' || volume.mode === 'rw-shared') {
      throw new Error('Hetzner: volumes can only be attached read-write to one server at a time')
    }
    const numericId = Number(volume.id)
    if (!Number.isInteger(numericId)) {
      throw new Error(`Hetzner: persistent volume id must be a numeric Hetzner volume id, got ${volume.id}`)
    }
    ids.push(numericId)
    dockerMounts.push({ source: `/mnt/HC_Volume_${numericId}`, target: volume.mountPath })
  }
  return { ids, dockerMounts }
}

interface CloudInitInput {
  image: string
  env: Record<string, string>
  dockerMounts: Array<{ source: string; target: string }>
}

function renderCloudInit(input: CloudInitInput): string {
  const envFile = Object.entries(input.env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const dockerArgs = ['--rm', '--name=stellwerk-runner', '--network=host', '--env-file=/etc/stellwerk/runner.env']
  for (const mount of input.dockerMounts) {
    dockerArgs.push(`-v`, `${shellQuote(mount.source)}:${shellQuote(mount.target)}`)
  }
  const dockerCmd = `docker run ${dockerArgs.join(' ')} ${shellQuote(input.image)}`
  const lines = [
    '#cloud-config',
    'package_update: true',
    'packages:',
    '  - docker.io',
    'write_files:',
    `  - path: /etc/stellwerk/runner.env`,
    `    permissions: '0600'`,
    `    content: |`,
    ...envFile.split('\n').map((line) => `      ${line}`),
    'runcmd:',
    `  - systemctl enable --now docker`,
    ...input.dockerMounts.map((mount) => `  - mkdir -p ${shellQuote(mount.target)}`),
    `  - ${dockerCmd}`,
  ]
  return `${lines.join('\n')}\n`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
