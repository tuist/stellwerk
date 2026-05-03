import type { ForgeKind } from './forge.ts'

export type VolumeMode = 'ro' | 'rw-exclusive' | 'rw-shared'

export type RunnerVolume =
  | {
      kind: 'scratch'
      name?: string
      mountPath: string
      sizeGb?: number
    }
  | {
      kind: 'cache'
      name?: string
      mountPath: string
      key: string
      scope?: 'repo' | 'org' | 'pool'
      sizeGb?: number
      mode?: VolumeMode
    }
  | {
      kind: 'persistent'
      name?: string
      mountPath: string
      id: string
      sizeGb?: number
      mode?: VolumeMode
    }

export interface SpawnOpts {
  forge: ForgeKind
  registrationToken: string
  repoUrl: string
  forgeUrl?: string
  labels: string[]
  jobId: string
  volumes?: RunnerVolume[]
}

export interface Executor {
  spawnRunner(opts: SpawnOpts): Promise<string>
  destroyRunner(id: string): Promise<void>
}
