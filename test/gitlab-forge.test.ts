import { describe, expect, it } from 'vitest'
import { GitlabForge } from '../src/forges/gitlab.ts'

function forge() {
  return new GitlabForge({
    accessToken: 'pat-123',
    webhookSecret: 'shh',
    baseUrl: 'https://gitlab.example.com',
    runnerTags: ['linux', 'docker'],
  })
}

describe('GitlabForge.verifyWebhook', () => {
  it('accepts the legacy X-Gitlab-Token header', async () => {
    const ok = await forge().verifyWebhook('shh', '{}', new Headers({ 'x-gitlab-token': 'shh' }))
    expect(ok).toBe(true)
  })

  it('rejects an invalid legacy token', async () => {
    const ok = await forge().verifyWebhook('shh', '{}', new Headers({ 'x-gitlab-token': 'nope' }))
    expect(ok).toBe(false)
  })

  it('accepts GitLab signing-token signatures', async () => {
    const body = JSON.stringify({ object_kind: 'build' })
    const token = 'whsec_' + btoa('raw-key')
    const timestamp = String(Math.floor(Date.now() / 1000))
    const id = 'msg_123'
    const signature = 'v1,' + (await hmacBase64('raw-key', `${id}.${timestamp}.${body}`))

    const ok = await forge().verifyWebhook(
      token,
      body,
      new Headers({
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      }),
    )

    expect(ok).toBe(true)
  })
})

describe('GitlabForge.parseJobEvent', () => {
  const payload = JSON.stringify({
    object_kind: 'build',
    build_id: 1977,
    build_status: 'created',
    project_id: 380,
    runner: null,
    project: {
      id: 380,
      web_url: 'https://gitlab.example.com/gitlab-org/gitlab-test',
      path_with_namespace: 'gitlab-org/gitlab-test',
    },
  })

  it('parses a queued job hook', () => {
    const evt = forge().parseJobEvent(payload, new Headers({ 'x-gitlab-event': 'Job Hook' }))
    expect(evt).toEqual({
      action: 'queued',
      jobId: '1977',
      labels: ['linux', 'docker'],
      repoUrl: 'https://gitlab.example.com/gitlab-org/gitlab-test',
      forgeUrl: 'https://gitlab.example.com',
      scope: { forge: 'gitlab', projectId: '380' },
    })
  })

  it('maps running and terminal statuses', () => {
    const headers = new Headers({ 'x-gitlab-event': 'Job Hook' })
    expect(forge().parseJobEvent(payload.replace('"created"', '"running"'), headers)?.action).toBe('in_progress')
    expect(forge().parseJobEvent(payload.replace('"created"', '"success"'), headers)?.action).toBe('completed')
  })

  it('returns null for non-job hooks and malformed JSON', () => {
    expect(forge().parseJobEvent(payload, new Headers({ 'x-gitlab-event': 'Pipeline Hook' }))).toBeNull()
    expect(forge().parseJobEvent('{bad', new Headers({ 'x-gitlab-event': 'Job Hook' }))).toBeNull()
  })
})

describe('GitlabForge.mintRunnerToken', () => {
  it('creates a project runner and returns its authentication token', async () => {
    let requestedUrl = ''
    let requestedBody = ''
    const gitlab = new GitlabForge({
      accessToken: 'pat-123',
      webhookSecret: 'shh',
      baseUrl: 'https://gitlab.example.com',
      fetch: async (input, init) => {
        requestedUrl = String(input)
        requestedBody = String(init?.body)
        return new Response(JSON.stringify({ token: 'glrt-created' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(gitlab.mintRunnerToken({ forge: 'gitlab', projectId: '380' }, ['linux', 'docker'])).resolves.toBe(
      'glrt-created',
    )
    expect(requestedUrl).toBe('https://gitlab.example.com/api/v4/user/runners')
    expect(requestedBody).toContain('runner_type=project_type')
    expect(requestedBody).toContain('project_id=380')
    expect(requestedBody).toContain('tag_list=linux%2Cdocker')
    expect(requestedBody).toContain('run_untagged=false')
  })
})

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body) as BufferSource))
  let bin = ''
  for (let i = 0; i < mac.length; i++) bin += String.fromCharCode(mac[i]!)
  return btoa(bin)
}
