import type { Executor, RunnerVolume, SpawnOpts } from '../executor.ts'
import { googleAccessToken } from '../util/gcp.ts'
import { runnerEnv, runnerImage, safeName, volumeName } from './common.ts'

export interface GcpBatchExecutorOptions {
  project: string
  location: string
  accessToken?: string
  serviceAccountEmail?: string
  privateKeyPem?: string
  runtimeServiceAccountEmail?: string
  network?: string
  subnetwork?: string
  noExternalIpAddress?: boolean
  machineType?: string
  provisioningModel?: 'STANDARD' | 'SPOT'
  cpuMilli?: string
  memoryMib?: string
  bootDiskMib?: string
  imageNamespace?: string
  imageOverrides?: Partial<Record<SpawnOpts['forge'], string>>
  jobPrefix?: string
  cacheGcsBucket?: string
  apiBaseUrl?: string
  tokenUrl?: string
  now?: Date
  fetchFn?: typeof fetch
}

interface GcpVolumeMapping {
  taskVolumes: unknown[]
  containerVolumes: string[]
  disks: unknown[]
}

export class GcpBatchExecutor implements Executor {
  private readonly apiBase: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: GcpBatchExecutorOptions) {
    this.apiBase = opts.apiBaseUrl ?? 'https://batch.googleapis.com/v1'
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const jobId = this.jobId(opts)
    const volumes = gcpVolumeMapping(opts.volumes ?? [], this.opts.cacheGcsBucket)
    const allocationPolicy: Record<string, unknown> = {
      instances: [
        {
          policy: {
            ...(this.opts.machineType ? { machineType: this.opts.machineType } : {}),
            ...(this.opts.provisioningModel ? { provisioningModel: this.opts.provisioningModel } : {}),
            ...(volumes.disks.length > 0 ? { disks: volumes.disks } : {}),
          },
        },
      ],
      ...(this.opts.runtimeServiceAccountEmail
        ? { serviceAccount: { email: this.opts.runtimeServiceAccountEmail } }
        : {}),
    }
    const networkInterfaces = this.networkInterfaces()
    if (networkInterfaces.length > 0) allocationPolicy.network = { networkInterfaces }

    const body = {
      taskGroups: [
        {
          taskCount: '1',
          parallelism: '1',
          taskSpec: {
            runnables: [
              {
                container: {
                  imageUri: runnerImage(this.opts, opts.forge),
                  ...(volumes.containerVolumes.length > 0 ? { volumes: volumes.containerVolumes } : {}),
                },
              },
            ],
            computeResource: {
              cpuMilli: this.opts.cpuMilli ?? '2000',
              memoryMib: this.opts.memoryMib ?? '2048',
              ...(this.opts.bootDiskMib ? { bootDiskMib: this.opts.bootDiskMib } : {}),
            },
            maxRetryCount: 0,
            environment: { variables: runnerEnv(opts) },
            ...(volumes.taskVolumes.length > 0 ? { volumes: volumes.taskVolumes } : {}),
          },
        },
      ],
      allocationPolicy,
      labels: {
        'managed-by': 'stellwerk',
        forge: opts.forge,
      },
      logsPolicy: { destination: 'CLOUD_LOGGING' },
    }

    const token = await googleAccessToken({
      accessToken: this.opts.accessToken,
      serviceAccountEmail: this.opts.serviceAccountEmail,
      privateKeyPem: this.opts.privateKeyPem,
      tokenUrl: this.opts.tokenUrl,
      now: this.opts.now,
      fetchFn: this.fetchFn,
    })
    const parent = `projects/${this.opts.project}/locations/${this.opts.location}`
    const res = await this.fetchFn(`${this.apiBase}/${parent}/jobs?job_id=${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`GCP Batch: create job failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { name?: string }
    return data.name ?? `${parent}/jobs/${jobId}`
  }

  async destroyRunner(id: string): Promise<void> {
    const token = await googleAccessToken({
      accessToken: this.opts.accessToken,
      serviceAccountEmail: this.opts.serviceAccountEmail,
      privateKeyPem: this.opts.privateKeyPem,
      tokenUrl: this.opts.tokenUrl,
      now: this.opts.now,
      fetchFn: this.fetchFn,
    })
    const name = id.startsWith('projects/')
      ? id
      : `projects/${this.opts.project}/locations/${this.opts.location}/jobs/${id}`
    const res = await this.fetchFn(`${this.apiBase}/${name}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`GCP Batch: delete job failed: ${res.status} ${await res.text()}`)
    }
  }

  private jobId(opts: SpawnOpts): string {
    const suffix = crypto.randomUUID().slice(0, 8)
    return safeName(`${this.opts.jobPrefix ?? 'stellwerk'}-${opts.forge}-${opts.jobId}-${suffix}`)
  }

  private networkInterfaces(): unknown[] {
    if (!this.opts.network && !this.opts.subnetwork && this.opts.noExternalIpAddress === undefined) return []
    return [
      {
        ...(this.opts.network ? { network: this.opts.network } : {}),
        ...(this.opts.subnetwork ? { subnetwork: this.opts.subnetwork } : {}),
        ...(this.opts.noExternalIpAddress === undefined ? {} : { noExternalIpAddress: this.opts.noExternalIpAddress }),
      },
    ]
  }
}

function gcpVolumeMapping(volumes: RunnerVolume[], cacheGcsBucket: string | undefined): GcpVolumeMapping {
  const mapped: GcpVolumeMapping = { taskVolumes: [], containerVolumes: [], disks: [] }
  for (let i = 0; i < volumes.length; i++) {
    const volume = volumes[i]!
    const name = volumeName(volume.name, `${volume.kind}-${i}`)
    const mount = `${volume.mountPath}:${volume.mountPath}${volume.kind !== 'scratch' && volume.mode === 'ro' ? ':ro' : ''}`
    mapped.containerVolumes.push(mount)

    if (volume.kind === 'cache') {
      if (!cacheGcsBucket) throw new Error('GCP Batch: cache volumes require cacheGcsBucket')
      mapped.taskVolumes.push({
        mountPath: volume.mountPath,
        gcs: { remotePath: `${cacheGcsBucket}/${volume.scope ?? 'pool'}/${safeName(volume.key)}` },
      })
    } else if (volume.kind === 'scratch') {
      mapped.taskVolumes.push({ mountPath: volume.mountPath, deviceName: name })
      mapped.disks.push({
        deviceName: name,
        newDisk: { type: 'pd-balanced', sizeGb: String(volume.sizeGb ?? 20) },
      })
    } else if (volume.id.startsWith('gcs://')) {
      mapped.taskVolumes.push({ mountPath: volume.mountPath, gcs: { remotePath: volume.id.slice('gcs://'.length) } })
    } else if (volume.id.startsWith('nfs://')) {
      const { server, remotePath } = parseNfs(volume.id)
      mapped.taskVolumes.push({ mountPath: volume.mountPath, nfs: { server, remotePath } })
    } else {
      mapped.taskVolumes.push({
        mountPath: volume.mountPath,
        deviceName: name,
        ...(volume.mode === 'ro' ? { mountOptions: ['ro'] } : {}),
      })
      mapped.disks.push({ deviceName: name, existingDisk: volume.id })
    }
  }
  return mapped
}

function parseNfs(value: string): { server: string; remotePath: string } {
  const withoutScheme = value.slice('nfs://'.length)
  const slash = withoutScheme.indexOf('/')
  if (slash === -1) throw new Error('GCP Batch: NFS volume id must be nfs://server/path')
  return { server: withoutScheme.slice(0, slash), remotePath: withoutScheme.slice(slash) }
}
