import type { Executor, RunnerVolume, SpawnOpts } from '../executor.ts'
import type { AwsCredentials } from '../util/aws.ts'
import { awsJsonFetch } from '../util/aws.ts'
import { envPairs, runnerEnv, runnerImage, safeName, volumeName } from './common.ts'

export interface AwsEcsExecutorOptions {
  region: string
  credentials: AwsCredentials
  cluster: string
  subnets: string[]
  executionRoleArn: string
  taskRoleArn?: string
  securityGroups?: string[]
  assignPublicIp?: boolean
  familyPrefix?: string
  launchType?: 'EC2' | 'FARGATE' | 'EXTERNAL' | 'MANAGED_INSTANCES'
  platformVersion?: string
  cpu?: string
  memoryMb?: string
  imageNamespace?: string
  imageOverrides?: Partial<Record<SpawnOpts['forge'], string>>
  logGroupName?: string
  logStreamPrefix?: string
  ebsVolumeRoleArn?: string
  endpoint?: string
  now?: Date
  fetchFn?: typeof fetch
}

export class AwsEcsExecutor implements Executor {
  constructor(private readonly opts: AwsEcsExecutorOptions) {}

  async spawnRunner(opts: SpawnOpts): Promise<string> {
    const taskDefinitionArn = await this.registerTaskDefinition(opts)
    const body: Record<string, unknown> = {
      cluster: this.opts.cluster,
      taskDefinition: taskDefinitionArn,
      count: 1,
      startedBy: safeName(`stellwerk-${opts.jobId}`, 36),
      enableECSManagedTags: true,
      tags: ecsTags(opts),
      overrides: {
        containerOverrides: [{ name: 'runner', environment: envPairs(runnerEnv(opts)) }],
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.opts.subnets,
          ...(this.opts.securityGroups?.length ? { securityGroups: this.opts.securityGroups } : {}),
          assignPublicIp: this.opts.assignPublicIp ? 'ENABLED' : 'DISABLED',
        },
      },
    }
    const volumeConfigurations = ecsVolumeConfigurations(opts.volumes ?? [], this.opts.ebsVolumeRoleArn)
    if (volumeConfigurations.length > 0) body.volumeConfigurations = volumeConfigurations
    if (this.opts.launchType) body.launchType = this.opts.launchType
    else body.launchType = 'FARGATE'
    if (this.opts.platformVersion) body.platformVersion = this.opts.platformVersion

    const res = await this.ecs('AmazonEC2ContainerServiceV20141113.RunTask', body)
    const data = (await res.json()) as { tasks?: Array<{ taskArn?: string }>; failures?: Array<{ reason?: string }> }
    if (data.failures?.length) {
      throw new Error(`AWS ECS: run task failed: ${JSON.stringify(data.failures)}`)
    }
    const taskArn = data.tasks?.[0]?.taskArn
    if (!taskArn) throw new Error('AWS ECS: run task response did not include taskArn')
    return taskArn
  }

  async destroyRunner(id: string): Promise<void> {
    const res = await awsJsonFetch({
      region: this.opts.region,
      service: 'ecs',
      target: 'AmazonEC2ContainerServiceV20141113.StopTask',
      body: {
        cluster: this.opts.cluster,
        task: id,
        reason: 'stellwerk destroyRunner',
      },
      credentials: this.opts.credentials,
      endpoint: this.opts.endpoint,
      now: this.opts.now,
      fetchFn: this.opts.fetchFn,
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`AWS ECS: stop task failed: ${res.status} ${await res.text()}`)
    }
  }

  private async registerTaskDefinition(opts: SpawnOpts): Promise<string> {
    const volumeDefinitions = ecsVolumeDefinitions(opts.volumes ?? [])
    const container: Record<string, unknown> = {
      name: 'runner',
      image: runnerImage(this.opts, opts.forge),
      essential: true,
      mountPoints: ecsMountPoints(opts.volumes ?? []),
      ...(this.opts.logGroupName
        ? {
            logConfiguration: {
              logDriver: 'awslogs',
              options: {
                'awslogs-group': this.opts.logGroupName,
                'awslogs-region': this.opts.region,
                'awslogs-stream-prefix': this.opts.logStreamPrefix ?? 'stellwerk',
              },
            },
          }
        : {}),
    }
    const body: Record<string, unknown> = {
      family: safeName(`${this.opts.familyPrefix ?? 'stellwerk-runner'}-${opts.forge}`),
      networkMode: 'awsvpc',
      requiresCompatibilities: [this.opts.launchType ?? 'FARGATE'],
      cpu: this.opts.cpu ?? '2048',
      memory: this.opts.memoryMb ?? '4096',
      executionRoleArn: this.opts.executionRoleArn,
      ...(this.opts.taskRoleArn ? { taskRoleArn: this.opts.taskRoleArn } : {}),
      containerDefinitions: [container],
      ...(volumeDefinitions.length > 0 ? { volumes: volumeDefinitions } : {}),
    }
    const res = await this.ecs('AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition', body)
    const data = (await res.json()) as { taskDefinition?: { taskDefinitionArn?: string } }
    const arn = data.taskDefinition?.taskDefinitionArn
    if (!arn) throw new Error('AWS ECS: register task definition response did not include taskDefinitionArn')
    return arn
  }

  private async ecs(target: string, body: unknown): Promise<Response> {
    const res = await awsJsonFetch({
      region: this.opts.region,
      service: 'ecs',
      target,
      body,
      credentials: this.opts.credentials,
      endpoint: this.opts.endpoint,
      now: this.opts.now,
      fetchFn: this.opts.fetchFn,
    })
    if (!res.ok) {
      throw new Error(`AWS ECS: ${target} failed: ${res.status} ${await res.text()}`)
    }
    return res
  }
}

function ecsTags(opts: SpawnOpts): Array<{ key: string; value: string }> {
  return [
    { key: 'managed-by', value: 'stellwerk' },
    { key: 'forge', value: opts.forge },
    { key: 'job-id', value: opts.jobId },
  ]
}

function ecsVolumeDefinitions(volumes: RunnerVolume[]): unknown[] {
  return volumes.map((volume, index) => {
    const name = volumeName(volume.name, `${volume.kind}-${index}`)
    if (volume.kind === 'persistent' && volume.id.startsWith('fs-')) {
      return {
        name,
        efsVolumeConfiguration: {
          fileSystemId: volume.id,
          rootDirectory: '/',
          transitEncryption: 'ENABLED',
        },
      }
    }
    return { name, configuredAtLaunch: true }
  })
}

function ecsMountPoints(volumes: RunnerVolume[]): unknown[] {
  return volumes.map((volume, index) => ({
    sourceVolume: volumeName(volume.name, `${volume.kind}-${index}`),
    containerPath: volume.mountPath,
    readOnly: volume.kind !== 'scratch' && volume.mode === 'ro',
  }))
}

function ecsVolumeConfigurations(volumes: RunnerVolume[], roleArn: string | undefined): unknown[] {
  return volumes.flatMap((volume, index) => {
    if (volume.kind === 'persistent' && volume.id.startsWith('fs-')) return []
    if (volume.kind !== 'scratch' && volume.mode === 'rw-shared') {
      throw new Error('AWS ECS: rw-shared volumes require EFS, set persistent.id to an EFS file system id')
    }
    return [
      {
        name: volumeName(volume.name, `${volume.kind}-${index}`),
        managedEBSVolume: {
          encrypted: true,
          volumeType: 'gp3',
          sizeInGiB: volume.sizeGb ?? 20,
          ...(roleArn ? { roleArn } : {}),
          terminationPolicy: { deleteOnTermination: volume.kind !== 'persistent' },
        },
      },
    ]
  })
}
