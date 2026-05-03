import { describe, expect, it } from 'vitest'
import { CodebergForge } from '../src/forges/codeberg.ts'

function forge() {
  return new CodebergForge({ webhookSecret: 'shh', accessToken: 'pat-123' })
}

describe('CodebergForge.verifyWebhook', () => {
  it('accepts Forgejo raw hex signatures', async () => {
    const body = JSON.stringify({ action: 'queued' })
    const sig = await hmacHex('shh', body)
    const ok = await forge().verifyWebhook('shh', body, new Headers({ 'x-forgejo-signature': sig }))
    expect(ok).toBe(true)
  })

  it('accepts GitHub-compatible signatures', async () => {
    const body = JSON.stringify({ action: 'queued' })
    const sig = 'sha256=' + (await hmacHex('shh', body))
    const ok = await forge().verifyWebhook('shh', body, new Headers({ 'x-hub-signature-256': sig }))
    expect(ok).toBe(true)
  })

  it('rejects missing signatures', async () => {
    await expect(forge().verifyWebhook('shh', '{}', new Headers())).resolves.toBe(false)
  })
})

describe('CodebergForge.parseJobEvent', () => {
  const payload = JSON.stringify({
    action: 'queued',
    workflow_job: {
      id: 42,
      status: 'queued',
      labels: ['ubuntu-latest', 'docker'],
    },
    repository: {
      full_name: 'pep/test',
      html_url: 'https://codeberg.org/pep/test',
      clone_url: 'https://codeberg.org/pep/test.git',
    },
  })

  it('parses a queued workflow_job', () => {
    const evt = forge().parseJobEvent(payload, new Headers({ 'x-forgejo-event-type': 'workflow_job' }))
    expect(evt).toEqual({
      action: 'queued',
      jobId: '42',
      labels: ['ubuntu-latest', 'docker'],
      repoUrl: 'https://codeberg.org/pep/test',
      forgeUrl: 'https://codeberg.org',
      scope: { forge: 'codeberg', repoFullName: 'pep/test' },
    })
  })

  it('ignores waiting jobs and non-workflow events', () => {
    const waiting = payload.replaceAll('"queued"', '"waiting"')
    expect(forge().parseJobEvent(waiting, new Headers({ 'x-forgejo-event-type': 'workflow_job' }))).toBeNull()
    expect(forge().parseJobEvent(payload, new Headers({ 'x-forgejo-event-type': 'push' }))).toBeNull()
  })
})

describe('CodebergForge.mintRunnerToken', () => {
  it('returns a static registration token when configured', async () => {
    const codeberg = new CodebergForge({ webhookSecret: 'shh', registrationToken: 'runner-static' })
    await expect(codeberg.mintRunnerToken({ forge: 'codeberg', repoFullName: 'pep/test' }, [])).resolves.toBe(
      'runner-static',
    )
  })

  it('fetches a repo registration token through the Forgejo API', async () => {
    let requestedUrl = ''
    const codeberg = new CodebergForge({
      webhookSecret: 'shh',
      accessToken: 'pat-123',
      serverUrl: 'https://codeberg.example.com',
      fetch: async (input) => {
        requestedUrl = String(input)
        return new Response(JSON.stringify({ token: 'runner-dynamic' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(codeberg.mintRunnerToken({ forge: 'codeberg', repoFullName: 'pep/test' }, [])).resolves.toBe(
      'runner-dynamic',
    )
    expect(requestedUrl).toBe('https://codeberg.example.com/api/v1/repos/pep/test/actions/runners/registration-token')
  })
})

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body) as BufferSource))
  let hex = ''
  for (let i = 0; i < mac.length; i++) hex += mac[i]!.toString(16).padStart(2, '0')
  return hex
}
