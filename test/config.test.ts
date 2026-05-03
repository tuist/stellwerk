import { describe, expect, it } from 'vitest'
import { buildAppDepsFromEnv } from '../src/config.ts'
import { KubernetesExecutor } from '../src/executors/kubernetes.ts'

const githubEnv = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADAN\n-----END PRIVATE KEY-----',
  GITHUB_WEBHOOK_SECRET: 'shh',
}

describe('buildAppDepsFromEnv', () => {
  it('builds the Kubernetes executor and parses runner volumes', () => {
    const deps = buildAppDepsFromEnv({
      ...githubEnv,
      EXECUTOR: 'kubernetes',
      K8S_API_SERVER: 'https://k8s.test',
      K8S_NAMESPACE: 'ci',
      K8S_BEARER_TOKEN: 'k8s-token',
      RUNNER_VOLUMES: JSON.stringify([
        { kind: 'scratch', mountPath: '/work', sizeGb: 20 },
        { kind: 'cache', mountPath: '/cache/npm', key: 'npm', scope: 'repo' },
      ]),
    })

    expect(deps.executor).toBeInstanceOf(KubernetesExecutor)
    expect(deps.runnerVolumes).toEqual([
      { kind: 'scratch', name: undefined, mountPath: '/work', sizeGb: 20 },
      {
        kind: 'cache',
        name: undefined,
        mountPath: '/cache/npm',
        sizeGb: undefined,
        key: 'npm',
        scope: 'repo',
        mode: undefined,
      },
    ])
  })

  it('rejects malformed runner volumes', () => {
    expect(() =>
      buildAppDepsFromEnv({
        ...githubEnv,
        EXECUTOR: 'docker-agent',
        AGENT_URL: 'https://agent.test',
        AGENT_TOKEN: 'agent-token',
        RUNNER_VOLUMES: JSON.stringify([{ kind: 'cache', mountPath: 'relative', key: 'npm' }]),
      }),
    ).toThrow('absolute mountPath')
  })
})
