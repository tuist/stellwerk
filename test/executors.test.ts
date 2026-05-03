import { describe, expect, it } from 'vitest'
import { AwsEcsExecutor } from '../src/executors/aws-ecs.ts'
import { DockerAgentExecutor } from '../src/executors/docker-agent.ts'
import { FlyExecutor } from '../src/executors/fly.ts'
import { GcpBatchExecutor } from '../src/executors/gcp-batch.ts'
import { HetznerExecutor } from '../src/executors/hetzner.ts'
import { KubernetesExecutor } from '../src/executors/kubernetes.ts'
import type { SpawnOpts } from '../src/executor.ts'

const spawnOpts: SpawnOpts = {
  forge: 'github',
  registrationToken: 'tok-123',
  repoUrl: 'https://github.com/octo/repo',
  labels: ['self-hosted', 'stellwerk'],
  jobId: '42',
}

interface FetchCall {
  url: string
  init: RequestInit
  body: unknown
}

function captureFetch(responses: unknown[] = [{ id: 'runner-1' }]): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined
    calls.push({ url: String(input), init: init ?? {}, body })
    const response = responses.shift() ?? {}
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchFn: fetchFn as typeof fetch, calls }
}

describe('FlyExecutor', () => {
  it('mounts one persistent volume on the Machine config', async () => {
    const { fetchFn, calls } = captureFetch([{ id: 'machine-1' }])
    const executor = new FlyExecutor({
      apiToken: 'fly-token',
      app: 'runners',
      apiBaseUrl: 'https://fly.test',
      fetchFn,
    })

    await executor.spawnRunner({
      ...spawnOpts,
      volumes: [{ kind: 'persistent', id: 'vol_123', mountPath: '/cache', mode: 'rw-exclusive' }],
    })

    expect(calls[0]?.url).toBe('https://fly.test/v1/apps/runners/machines')
    expect(calls[0]?.body).toMatchObject({
      config: {
        image: 'ghcr.io/stellwerk/runner-github:latest',
        mounts: [{ volume: 'vol_123', path: '/cache' }],
      },
    })
  })

  it('rejects shared cache volumes because Fly volumes are host-local', async () => {
    const executor = new FlyExecutor({
      apiToken: 'fly-token',
      app: 'runners',
      apiBaseUrl: 'https://fly.test',
      fetchFn: captureFetch().fetchFn,
    })

    await expect(
      executor.spawnRunner({
        ...spawnOpts,
        volumes: [{ kind: 'cache', key: 'npm', scope: 'repo', mountPath: '/cache' }],
      }),
    ).rejects.toThrow('Fly: cache volumes are not shared')
  })
})

describe('DockerAgentExecutor', () => {
  it('forwards volumes to the agent protocol', async () => {
    const { fetchFn, calls } = captureFetch([{ id: 'container-1' }])
    const executor = new DockerAgentExecutor({
      agentUrl: 'https://agent.test/',
      agentToken: 'agent-token',
      fetchFn,
    })

    await executor.spawnRunner({
      ...spawnOpts,
      volumes: [{ kind: 'scratch', name: 'work', mountPath: '/work', sizeGb: 20 }],
    })

    expect(calls[0]?.url).toBe('https://agent.test/spawn')
    expect(calls[0]?.body).toMatchObject({
      image: 'ghcr.io/stellwerk/runner-github:latest',
      volumes: [{ kind: 'scratch', name: 'work', mountPath: '/work', sizeGb: 20 }],
    })
  })
})

describe('KubernetesExecutor', () => {
  it('creates a Secret and Job with Kubernetes-native volumes', async () => {
    const { fetchFn, calls } = captureFetch([{}, {}])
    const executor = new KubernetesExecutor({
      apiServer: 'https://k8s.test',
      namespace: 'ci',
      bearerToken: 'k8s-token',
      cacheClaimPrefix: 'cache',
      fetchFn,
    })

    const id = await executor.spawnRunner({
      ...spawnOpts,
      volumes: [
        { kind: 'scratch', name: 'work', mountPath: '/work', sizeGb: 10 },
        { kind: 'cache', name: 'npm', key: 'npm', mountPath: '/cache/npm' },
        { kind: 'persistent', name: 'shared', id: 'shared-pvc', mountPath: '/mnt/shared', mode: 'ro' },
      ],
    })

    expect(id).toMatch(/^ci\/stellwerk-github-42-/)
    expect(calls[0]?.url).toBe('https://k8s.test/api/v1/namespaces/ci/secrets')
    expect(calls[0]?.body).toMatchObject({ stringData: { RUNNER_TOKEN: 'tok-123' } })
    expect(calls[1]?.url).toBe('https://k8s.test/apis/batch/v1/namespaces/ci/jobs')
    expect(calls[1]?.body).toMatchObject({
      spec: {
        template: {
          spec: {
            containers: [
              {
                image: 'ghcr.io/stellwerk/runner-github:latest',
                volumeMounts: [
                  { name: 'work', mountPath: '/work' },
                  { name: 'npm', mountPath: '/cache/npm' },
                  { name: 'shared', mountPath: '/mnt/shared', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'work', emptyDir: { sizeLimit: '10Gi' } },
              { name: 'npm', persistentVolumeClaim: { claimName: 'cache-pool-npm', readOnly: false } },
              { name: 'shared', persistentVolumeClaim: { claimName: 'shared-pvc', readOnly: true } },
            ],
          },
        },
      },
    })
  })
})

describe('AwsEcsExecutor', () => {
  it('registers a task definition and runs an ECS task', async () => {
    const { fetchFn, calls } = captureFetch([
      { taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:task-definition/stellwerk:1' } },
      { tasks: [{ taskArn: 'arn:aws:ecs:task/cluster/task-1' }] },
    ])
    const executor = new AwsEcsExecutor({
      region: 'us-east-1',
      endpoint: 'https://ecs.test/',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
      cluster: 'ci',
      subnets: ['subnet-1'],
      executionRoleArn: 'arn:aws:iam::123:role/ecsTaskExecutionRole',
      now: new Date('2026-05-03T12:00:00Z'),
      fetchFn,
    })

    const id = await executor.spawnRunner({
      ...spawnOpts,
      volumes: [{ kind: 'scratch', name: 'work', mountPath: '/work', sizeGb: 30 }],
    })

    expect(id).toBe('arn:aws:ecs:task/cluster/task-1')
    expect(calls[0]?.init.headers).toMatchObject({
      'x-amz-target': 'AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition',
    })
    expect(calls[0]?.body).toMatchObject({
      containerDefinitions: [
        {
          image: 'ghcr.io/stellwerk/runner-github:latest',
          mountPoints: [{ sourceVolume: 'work', containerPath: '/work', readOnly: false }],
        },
      ],
      volumes: [{ name: 'work', configuredAtLaunch: true }],
    })
    expect(calls[1]?.init.headers).toMatchObject({
      'x-amz-target': 'AmazonEC2ContainerServiceV20141113.RunTask',
    })
    expect(calls[1]?.body).toMatchObject({
      volumeConfigurations: [
        {
          name: 'work',
          managedEBSVolume: { sizeInGiB: 30, terminationPolicy: { deleteOnTermination: true } },
        },
      ],
    })
  })
})

describe('HetznerExecutor', () => {
  it('creates a server with cloud-init user_data and returns the numeric id as a string', async () => {
    const { fetchFn, calls } = captureFetch([{ server: { id: 987654 }, action: { id: 1 } }])
    const executor = new HetznerExecutor({
      apiToken: 'hetz-token',
      location: 'fsn1',
      apiBaseUrl: 'https://hetz.test/v1',
      fetchFn,
    })

    const id = await executor.spawnRunner(spawnOpts)

    expect(id).toBe('987654')
    expect(calls[0]?.url).toBe('https://hetz.test/v1/servers')
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer hetz-token' })
    const body = calls[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({
      server_type: 'cx22',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      labels: { 'stellwerk.dev/forge': 'github', 'stellwerk.dev/job-id': '42' },
    })
    expect(typeof body.name).toBe('string')
    expect(body.name as string).toMatch(/^stellwerk-github-42-/)
    expect(body.user_data).toContain('#cloud-config')
    expect(body.user_data).toContain('RUNNER_TOKEN=tok-123')
    expect(body.user_data).toContain('docker run')
    expect(body.user_data).toContain("'ghcr.io/stellwerk/runner-github:latest'")
  })

  it('attaches persistent volumes by numeric id and bind-mounts them in docker run', async () => {
    const { fetchFn, calls } = captureFetch([{ server: { id: 1 }, action: { id: 1 } }])
    const executor = new HetznerExecutor({
      apiToken: 'hetz-token',
      apiBaseUrl: 'https://hetz.test/v1',
      fetchFn,
    })

    await executor.spawnRunner({
      ...spawnOpts,
      volumes: [{ kind: 'persistent', id: '12345', mountPath: '/cache', mode: 'rw-exclusive' }],
    })

    const body = calls[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ volumes: [12345], automount: false })
    expect(body.user_data).toContain('/mnt/HC_Volume_12345')
    expect(body.user_data).toContain("'/cache'")
  })

  it('rejects cache volumes', async () => {
    const executor = new HetznerExecutor({
      apiToken: 'hetz-token',
      apiBaseUrl: 'https://hetz.test/v1',
      fetchFn: captureFetch().fetchFn,
    })

    await expect(
      executor.spawnRunner({
        ...spawnOpts,
        volumes: [{ kind: 'cache', key: 'npm', scope: 'repo', mountPath: '/cache' }],
      }),
    ).rejects.toThrow('Hetzner: cache volumes are not supported')
  })

  it('treats 404 on destroy as already gone', async () => {
    const fetchFn = (async () => new Response('', { status: 404 })) as typeof fetch
    const executor = new HetznerExecutor({
      apiToken: 'hetz-token',
      apiBaseUrl: 'https://hetz.test/v1',
      fetchFn,
    })
    await expect(executor.destroyRunner('999')).resolves.toBeUndefined()
  })
})

describe('GcpBatchExecutor', () => {
  it('creates a Batch job with container env and GCS cache volume', async () => {
    const { fetchFn, calls } = captureFetch([{ name: 'projects/p/locations/us-central1/jobs/job-1' }])
    const executor = new GcpBatchExecutor({
      project: 'p',
      location: 'us-central1',
      apiBaseUrl: 'https://batch.test/v1',
      accessToken: 'gcp-token',
      cacheGcsBucket: 'ci-cache',
      fetchFn,
    })

    const id = await executor.spawnRunner({
      ...spawnOpts,
      volumes: [{ kind: 'cache', key: 'npm', scope: 'repo', mountPath: '/cache/npm' }],
    })

    expect(id).toBe('projects/p/locations/us-central1/jobs/job-1')
    expect(calls[0]?.url).toMatch(/^https:\/\/batch\.test\/v1\/projects\/p\/locations\/us-central1\/jobs\?job_id=/)
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer gcp-token' })
    expect(calls[0]?.body).toMatchObject({
      taskGroups: [
        {
          taskSpec: {
            runnables: [{ container: { imageUri: 'ghcr.io/stellwerk/runner-github:latest' } }],
            environment: { variables: { RUNNER_TOKEN: 'tok-123' } },
            volumes: [{ mountPath: '/cache/npm', gcs: { remotePath: 'ci-cache/repo/npm' } }],
          },
        },
      ],
    })
  })
})
