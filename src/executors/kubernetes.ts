import type { Executor, RunnerVolume, SpawnOpts } from '../executor.ts'
import { runnerEnv, runnerImage, safeName, volumeName } from './common.ts'

export interface KubernetesExecutorOptions {
  apiServer: string
  namespace: string
  bearerToken: string
  serviceAccountName?: string
  imagePullSecretName?: string
  imageNamespace?: string
  imageOverrides?: Partial<Record<SpawnOpts['forge'], string>>
  jobPrefix?: string
  cacheClaimPrefix?: string
  ttlSecondsAfterFinished?: number
  cpuRequest?: string
  memoryRequest?: string
  cpuLimit?: string
  memoryLimit?: string
  fetchFn?: typeof fetch
}

interface KubernetesVolumeMapping {
  volumes: unknown[]
  volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>
}

export class KubernetesExecutor implements Executor {
  private readonly apiBase: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: KubernetesExecutorOptions) {
    this.apiBase = opts.apiServer.replace(/\/$/, '')
    this.fetchFn = opts.fetchFn ?? fetch
  }

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const jobName = this.jobName(opts)
    const secretName = `${jobName}-env`
    const labels = {
      'app.kubernetes.io/name': 'stellwerk-runner',
      'app.kubernetes.io/managed-by': 'stellwerk',
      'stellwerk.dev/forge': safeName(opts.forge),
      'stellwerk.dev/job-id': safeName(opts.jobId),
    }
    const env = runnerEnv(opts)
    await this.createSecret(secretName, env, labels)
    await this.createJob(jobName, secretName, opts, labels)
    return `${this.opts.namespace}/${jobName}`
  }

  async destroyRunner(id: string): Promise<void> {
    const { namespace, name } = this.parseId(id)
    await this.deleteResource(`/apis/batch/v1/namespaces/${namespace}/jobs/${name}?propagationPolicy=Background`)
    await this.deleteResource(`/api/v1/namespaces/${namespace}/secrets/${name}-env`)
  }

  private async createSecret(name: string, env: Record<string, string>, labels: Record<string, string>): Promise<void> {
    await this.request(`/api/v1/namespaces/${this.opts.namespace}/secrets`, {
      method: 'POST',
      body: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name, labels },
        type: 'Opaque',
        stringData: env,
      },
    })
  }

  private async createJob(
    name: string,
    secretName: string,
    opts: SpawnOpts,
    labels: Record<string, string>,
  ): Promise<void> {
    const volumeMapping = kubernetesVolumeMapping(opts.volumes ?? [], this.opts.cacheClaimPrefix)
    const resources = this.resources()
    const container: Record<string, unknown> = {
      name: 'runner',
      image: runnerImage(this.opts, opts.forge),
      imagePullPolicy: 'IfNotPresent',
      env: Object.keys(runnerEnv(opts)).map((key) => ({
        name: key,
        valueFrom: { secretKeyRef: { name: secretName, key } },
      })),
      ...(volumeMapping.volumeMounts.length > 0 ? { volumeMounts: volumeMapping.volumeMounts } : {}),
      ...(resources ? { resources } : {}),
    }

    await this.request(`/apis/batch/v1/namespaces/${this.opts.namespace}/jobs`, {
      method: 'POST',
      body: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, labels },
        spec: {
          backoffLimit: 0,
          ttlSecondsAfterFinished: this.opts.ttlSecondsAfterFinished ?? 600,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'Never',
              ...(this.opts.serviceAccountName ? { serviceAccountName: this.opts.serviceAccountName } : {}),
              ...(this.opts.imagePullSecretName ? { imagePullSecrets: [{ name: this.opts.imagePullSecretName }] } : {}),
              containers: [container],
              ...(volumeMapping.volumes.length > 0 ? { volumes: volumeMapping.volumes } : {}),
            },
          },
        },
      },
    })
  }

  private async request(path: string, opts: { method: string; body?: unknown }): Promise<Response> {
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${this.opts.bearerToken}`,
        'content-type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    if (!res.ok) {
      throw new Error(`Kubernetes: ${opts.method} ${path} failed: ${res.status} ${await res.text()}`)
    }
    return res
  }

  private async deleteResource(path: string): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.opts.bearerToken}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Kubernetes: DELETE ${path} failed: ${res.status} ${await res.text()}`)
    }
  }

  private jobName(opts: SpawnOpts): string {
    const suffix = crypto.randomUUID().slice(0, 8)
    return safeName(`${this.opts.jobPrefix ?? 'stellwerk'}-${opts.forge}-${opts.jobId}-${suffix}`, 59)
  }

  private parseId(id: string): { namespace: string; name: string } {
    const [namespace, name] = id.includes('/') ? id.split('/', 2) : [this.opts.namespace, id]
    return { namespace: namespace!, name: name! }
  }

  private resources(): Record<string, unknown> | null {
    const requests = {
      ...(this.opts.cpuRequest ? { cpu: this.opts.cpuRequest } : {}),
      ...(this.opts.memoryRequest ? { memory: this.opts.memoryRequest } : {}),
    }
    const limits = {
      ...(this.opts.cpuLimit ? { cpu: this.opts.cpuLimit } : {}),
      ...(this.opts.memoryLimit ? { memory: this.opts.memoryLimit } : {}),
    }
    return Object.keys(requests).length > 0 || Object.keys(limits).length > 0
      ? {
          ...(Object.keys(requests).length > 0 ? { requests } : {}),
          ...(Object.keys(limits).length > 0 ? { limits } : {}),
        }
      : null
  }
}

function kubernetesVolumeMapping(
  volumes: RunnerVolume[],
  cacheClaimPrefix = 'stellwerk-cache',
): KubernetesVolumeMapping {
  const mapped: KubernetesVolumeMapping = { volumes: [], volumeMounts: [] }
  for (let i = 0; i < volumes.length; i++) {
    const volume = volumes[i]!
    const name = volumeName(volume.name, `${volume.kind}-${i}`)
    mapped.volumeMounts.push({
      name,
      mountPath: volume.mountPath,
      ...(volume.kind !== 'scratch' && volume.mode === 'ro' ? { readOnly: true } : {}),
    })

    if (volume.kind === 'scratch') {
      mapped.volumes.push({
        name,
        emptyDir: volume.sizeGb ? { sizeLimit: `${volume.sizeGb}Gi` } : {},
      })
    } else if (volume.kind === 'persistent') {
      mapped.volumes.push({
        name,
        persistentVolumeClaim: { claimName: volume.id, readOnly: volume.mode === 'ro' },
      })
    } else {
      const claimName = safeName(`${cacheClaimPrefix}-${volume.scope ?? 'pool'}-${volume.key}`)
      mapped.volumes.push({
        name,
        persistentVolumeClaim: { claimName, readOnly: volume.mode === 'ro' },
      })
    }
  }
  return mapped
}
