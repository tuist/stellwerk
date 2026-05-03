import { describe, expect, it } from 'vitest'
import { GithubForge } from '../src/forges/github.ts'

const dummyKey = `-----BEGIN PRIVATE KEY-----\nMIIBVQIBADAN\n-----END PRIVATE KEY-----`

function forge() {
  return new GithubForge({ appId: '1', privateKeyPem: dummyKey, webhookSecret: 'shh' })
}

describe('GithubForge.parseJobEvent', () => {
  const queuedPayload = JSON.stringify({
    action: 'queued',
    workflow_job: { id: 42, run_url: 'https://api/x', labels: ['self-hosted', 'stellwerk'] },
    repository: { full_name: 'octo/repo', html_url: 'https://github.com/octo/repo' },
    installation: { id: 99 },
  })

  it('parses a queued workflow_job', () => {
    const headers = new Headers({ 'x-github-event': 'workflow_job' })
    const evt = forge().parseJobEvent(queuedPayload, headers)
    expect(evt).toEqual({
      action: 'queued',
      jobId: '42',
      labels: ['self-hosted', 'stellwerk'],
      repoUrl: 'https://github.com/octo/repo',
      scope: { forge: 'github', installationId: '99', repoFullName: 'octo/repo' },
    })
  })

  it('returns null for non-job events', () => {
    const headers = new Headers({ 'x-github-event': 'ping' })
    expect(forge().parseJobEvent(queuedPayload, headers)).toBeNull()
  })

  it('returns null for actions we ignore (e.g. waiting)', () => {
    const headers = new Headers({ 'x-github-event': 'workflow_job' })
    const body = queuedPayload.replace('"queued"', '"waiting"')
    expect(forge().parseJobEvent(body, headers)).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const headers = new Headers({ 'x-github-event': 'workflow_job' })
    expect(forge().parseJobEvent('{bad', headers)).toBeNull()
  })

  it('returns null when installation is missing', () => {
    const headers = new Headers({ 'x-github-event': 'workflow_job' })
    const body = queuedPayload.replace('"installation":{"id":99}', '"installation":null')
    expect(forge().parseJobEvent(body, headers)).toBeNull()
  })
})
