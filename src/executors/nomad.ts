import type { Executor, RunnerVolume, SpawnOpts } from '../executor.ts'
import type { ForgeKind } from '../forge.ts'
import { runnerEnv, runnerImage, safeName, volumeName } from './common.ts'

export interface NomadExecutorOptions {
  address: string
  token?: string
  namespace?: string
  region?: string
  datacenters?: string[]
  jobPrefix?: string
  cpuMhz?: number
  memoryMb?: number
  imageNamespace?: string
  imageOverrides?: Partial<Record<ForgeKind, string>>
  fetchFn?: typeof fetch
}

interface NomadVolumeMapping {
  groupVolumes: Record<string, { Type: string; Source: string; ReadOnly: boolean }>
  taskMounts: Array<{ Volume: string; Destination: string; ReadOnly: boolean }>
  ephemeralDiskMb?: number
}

export class NomadExecutor implements Executor {
  private readonly apiBase: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: NomadExecutorOptions) {
    this.apiBase = opts.address.replace(/\/$/, '')
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const jobId = this.jobId(opts)
    const mapping = nomadVolumeMapping(opts.volumes ?? [])
    const task: Record<string, unknown> = {
      Name: 'runner',
      Driver: 'docker',
      Config: { image: runnerImage(this.opts, opts.forge) },
      Env: runnerEnv(opts),
      Resources: {
        CPU: this.opts.cpuMhz ?? 1000,
        MemoryMB: this.opts.memoryMb ?? 2048,
      },
      ...(mapping.taskMounts.length > 0 ? { VolumeMounts: mapping.taskMounts } : {}),
    }
    const taskGroup: Record<string, unknown> = {
      Name: 'runner',
      Count: 1,
      RestartPolicy: { Attempts: 0, Mode: 'fail' },
      ReschedulePolicy: { Attempts: 0, Unlimited: false },
      Tasks: [task],
      ...(Object.keys(mapping.groupVolumes).length > 0 ? { Volumes: mapping.groupVolumes } : {}),
      ...(mapping.ephemeralDiskMb ? { EphemeralDisk: { SizeMB: mapping.ephemeralDiskMb } } : {}),
    }
    const job: Record<string, unknown> = {
      ID: jobId,
      Name: jobId,
      Type: 'batch',
      Meta: { stellwerk_job_id: opts.jobId, stellwerk_forge: opts.forge },
      TaskGroups: [taskGroup],
      ...(this.opts.datacenters?.length ? { Datacenters: this.opts.datacenters } : {}),
      ...(this.opts.namespace ? { Namespace: this.opts.namespace } : {}),
      ...(this.opts.region ? { Region: this.opts.region } : {}),
    }

    await this.request('POST', this.qualifyPath('/jobs'), { Job: job })
    return jobId
  }

  async destroyRunner(id: string): Promise<void> {
    const path = this.qualifyPath(`/job/${encodeURIComponent(id)}`, { purge: 'true' })
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Nomad: destroy failed: ${res.status} ${await res.text()}`)
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Nomad: ${method} ${path} failed: ${res.status} ${await res.text()}`)
    }
    return res
  }

  private headers(): Record<string, string> {
    return this.opts.token ? { 'x-nomad-token': this.opts.token } : {}
  }

  private qualifyPath(path: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams()
    if (this.opts.namespace) params.set('namespace', this.opts.namespace)
    if (this.opts.region) params.set('region', this.opts.region)
    for (const [key, value] of Object.entries(extra)) params.set(key, value)
    const qs = params.toString()
    return `/v1${path}${qs ? `?${qs}` : ''}`
  }

  private jobId(opts: SpawnOpts): string {
    const suffix = crypto.randomUUID().slice(0, 8)
    return safeName(`${this.opts.jobPrefix ?? 'stellwerk'}-${opts.forge}-${opts.jobId}-${suffix}`)
  }
}

function nomadVolumeMapping(volumes: RunnerVolume[]): NomadVolumeMapping {
  const groupVolumes: NomadVolumeMapping['groupVolumes'] = {}
  const taskMounts: NomadVolumeMapping['taskMounts'] = []
  let ephemeralDiskMb: number | undefined
  for (let i = 0; i < volumes.length; i++) {
    const volume = volumes[i]!
    if (volume.kind === 'cache') {
      throw new Error('Nomad: cache volumes are not supported; declare a Nomad host volume and use kind=persistent')
    }
    if (volume.kind === 'scratch') {
      const mb = volume.sizeGb ? volume.sizeGb * 1024 : 1024
      ephemeralDiskMb = (ephemeralDiskMb ?? 0) + mb
      continue
    }
    const name = volumeName(volume.name, `persistent-${i}`)
    const readOnly = volume.mode === 'ro'
    groupVolumes[name] = { Type: 'host', Source: volume.id, ReadOnly: readOnly }
    taskMounts.push({ Volume: name, Destination: volume.mountPath, ReadOnly: readOnly })
  }
  return { groupVolumes, taskMounts, ephemeralDiskMb }
}
