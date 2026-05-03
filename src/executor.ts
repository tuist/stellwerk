import type { ForgeKind } from './forge.ts'

export interface SpawnOpts {
  forge: ForgeKind
  registrationToken: string
  repoUrl: string
  forgeUrl?: string
  labels: string[]
  jobId: string
}

export interface Executor {
  spawnRunner(opts: SpawnOpts): Promise<string>
  destroyRunner(id: string): Promise<void>
}
