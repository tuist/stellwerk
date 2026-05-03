import { serve } from '@hono/node-server'
import { createApp } from '../src/app.ts'
import { GithubForge } from '../src/forges/github.ts'
import { GitlabForge } from '../src/forges/gitlab.ts'
import { CodebergForge } from '../src/forges/codeberg.ts'
import { FlyExecutor } from '../src/executors/fly.ts'

const WEBHOOK_SECRET = 'smoke-' + crypto.randomUUID()
const PORT = 18787
const BASE = `http://127.0.0.1:${PORT}`

const calls = { installToken: 0, registrationToken: 0, gitlabRunner: 0, codebergToken: 0, flySpawn: 0, flyDestroy: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('api.github.com/app/installations/') && url.endsWith('/access_tokens')) {
    calls.installToken++
    return new Response(JSON.stringify({ token: 'ghs_install_stub' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.includes('api.github.com/repos/') && url.endsWith('/actions/runners/registration-token')) {
    calls.registrationToken++
    return new Response(JSON.stringify({ token: 'AAAAREGTOKEN' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url === 'https://gitlab.com/api/v4/user/runners' && (init?.method ?? 'GET') === 'POST') {
    calls.gitlabRunner++
    return new Response(JSON.stringify({ token: 'glrt_stub' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.includes('codeberg.org/api/v1/repos/') && url.endsWith('/actions/runners/registration-token')) {
    calls.codebergToken++
    return new Response(JSON.stringify({ token: 'codeberg_stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (
    url.startsWith('https://api.machines.dev/v1/apps/') &&
    url.endsWith('/machines') &&
    (init?.method ?? 'GET') === 'POST'
  ) {
    calls.flySpawn++
    return new Response(JSON.stringify({ id: 'mach_stub_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.startsWith('https://api.machines.dev/v1/apps/') && (init?.method ?? 'GET') === 'DELETE') {
    calls.flyDestroy++
    return new Response('', { status: 200 })
  }
  return realFetch(input, init)
}) as typeof fetch

async function generatePem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  let bin = ''
  for (let i = 0; i < pkcs8.length; i++) bin += String.fromCharCode(pkcs8[i]!)
  const b64 = btoa(bin)
  const wrapped = b64.match(/.{1,64}/g)!.join('\n')
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`
}

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

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${label}`)
    pass++
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
    fail++
  }
}

const pem = await generatePem()

const forge = new GithubForge({ appId: '1', privateKeyPem: pem, webhookSecret: WEBHOOK_SECRET })
const gitlabForge = new GitlabForge({
  accessToken: 'glpat-stub',
  webhookSecret: WEBHOOK_SECRET,
  runnerTags: ['self-hosted', 'stellwerk'],
})
const codebergForge = new CodebergForge({ accessToken: 'codeberg-stub', webhookSecret: WEBHOOK_SECRET })
const executor = new FlyExecutor({ apiToken: 'fly-stub', app: 'stellwerk-runners' })
const app = createApp({
  forges: {
    github: { forge, webhookSecret: WEBHOOK_SECRET },
    gitlab: { forge: gitlabForge, webhookSecret: WEBHOOK_SECRET },
    codeberg: { forge: codebergForge, webhookSecret: WEBHOOK_SECRET },
  },
  executor,
  requiredLabels: ['self-hosted', 'stellwerk'],
  log: () => {},
})

const server = serve({ fetch: app.fetch, port: PORT })
await new Promise((r) => setTimeout(r, 50))

console.log(`stellwerk smoke test (Node, ${BASE})\n`)

try {
  // 1. healthz
  {
    const res = await fetch(`${BASE}/healthz`)
    check('GET /healthz → 200', res.status === 200)
    check('GET /healthz body', JSON.stringify(await res.json()) === '{"ok":true}')
  }

  // 2. unknown forge
  {
    const res = await fetch(`${BASE}/webhook/gitea`, { method: 'POST', body: '{}' })
    check('POST /webhook/gitea (unconfigured) → 404', res.status === 404)
  }

  // 3. missing signature
  {
    const res = await fetch(`${BASE}/webhook/github`, { method: 'POST', body: '{}' })
    check('POST /webhook/github (no sig) → 401', res.status === 401)
  }

  // 4. bad signature
  {
    const res = await fetch(`${BASE}/webhook/github`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-event': 'workflow_job' },
      body: '{}',
    })
    check('POST /webhook/github (bad sig) → 401', res.status === 401)
  }

  // 5. valid sig, ping event (ignored)
  {
    const body = JSON.stringify({ zen: 'hi' })
    const sig = 'sha256=' + (await hmacHex(WEBHOOK_SECRET, body))
    const res = await fetch(`${BASE}/webhook/github`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': 'ping', 'content-type': 'application/json' },
      body,
    })
    check('POST /webhook/github ping → 200', res.status === 200)
    check('ping body has ignored=true', (await res.json()).ignored === true)
  }

  // 6. valid sig, completed workflow_job (ignored, no spawn)
  {
    const before = calls.flySpawn
    const body = JSON.stringify({
      action: 'completed',
      workflow_job: { id: 11, run_url: '', labels: ['self-hosted', 'stellwerk'] },
      repository: { full_name: 'octo/repo', html_url: 'https://github.com/octo/repo' },
      installation: { id: 99 },
    })
    const sig = 'sha256=' + (await hmacHex(WEBHOOK_SECRET, body))
    const res = await fetch(`${BASE}/webhook/github`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': 'workflow_job', 'content-type': 'application/json' },
      body,
    })
    check('POST /webhook/github completed → 200', res.status === 200)
    check('completed did not spawn', calls.flySpawn === before)
  }

  // 7. valid sig, queued, label mismatch
  {
    const before = { fly: calls.flySpawn, install: calls.installToken, reg: calls.registrationToken }
    const body = JSON.stringify({
      action: 'queued',
      workflow_job: { id: 22, run_url: '', labels: ['self-hosted'] },
      repository: { full_name: 'octo/repo', html_url: 'https://github.com/octo/repo' },
      installation: { id: 99 },
    })
    const sig = 'sha256=' + (await hmacHex(WEBHOOK_SECRET, body))
    const res = await fetch(`${BASE}/webhook/github`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': 'workflow_job', 'content-type': 'application/json' },
      body,
    })
    check('POST /webhook/github queued/label-miss → 200', res.status === 200)
    const j = (await res.json()) as { reason?: string }
    check('reason=label-mismatch', j.reason === 'label-mismatch')
    check(
      'label-mismatch did not call GitHub',
      calls.installToken === before.install && calls.registrationToken === before.reg,
    )
    check('label-mismatch did not spawn', calls.flySpawn === before.fly)
  }

  // 8. valid sig, queued, label match → full happy path
  {
    const before = { fly: calls.flySpawn, install: calls.installToken, reg: calls.registrationToken }
    const body = JSON.stringify({
      action: 'queued',
      workflow_job: { id: 33, run_url: '', labels: ['self-hosted', 'stellwerk', 'linux'] },
      repository: { full_name: 'octo/repo', html_url: 'https://github.com/octo/repo' },
      installation: { id: 99 },
    })
    const sig = 'sha256=' + (await hmacHex(WEBHOOK_SECRET, body))
    const res = await fetch(`${BASE}/webhook/github`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': sig, 'x-github-event': 'workflow_job', 'content-type': 'application/json' },
      body,
    })
    check('POST /webhook/github queued/match → 202', res.status === 202)
    const j = (await res.json()) as { ok?: boolean; runnerId?: string }
    check('returned runnerId=mach_stub_1', j.ok === true && j.runnerId === 'mach_stub_1')
    check('called GitHub install token exactly once', calls.installToken === before.install + 1)
    check('called GitHub registration token exactly once', calls.registrationToken === before.reg + 1)
    check('called Fly spawn exactly once', calls.flySpawn === before.fly + 1)
  }

  // 9. GitLab queued job → runner create + spawn
  {
    const before = { fly: calls.flySpawn, gitlab: calls.gitlabRunner }
    const body = JSON.stringify({
      object_kind: 'build',
      build_id: 44,
      build_status: 'created',
      project_id: 380,
      project: { id: 380, web_url: 'https://gitlab.com/octo/repo' },
      runner: null,
    })
    const res = await fetch(`${BASE}/webhook/gitlab`, {
      method: 'POST',
      headers: { 'x-gitlab-event': 'Job Hook', 'x-gitlab-token': WEBHOOK_SECRET, 'content-type': 'application/json' },
      body,
    })
    check('POST /webhook/gitlab queued/match → 202', res.status === 202)
    check('called GitLab runner create exactly once', calls.gitlabRunner === before.gitlab + 1)
    check('called Fly spawn for GitLab exactly once', calls.flySpawn === before.fly + 1)
  }

  // 10. Codeberg queued workflow_job → registration token + spawn
  {
    const before = { fly: calls.flySpawn, codeberg: calls.codebergToken }
    const body = JSON.stringify({
      action: 'queued',
      workflow_job: { id: 55, status: 'queued', labels: ['self-hosted', 'stellwerk'] },
      repository: { full_name: 'octo/repo', html_url: 'https://codeberg.org/octo/repo' },
    })
    const sig = await hmacHex(WEBHOOK_SECRET, body)
    const res = await fetch(`${BASE}/webhook/codeberg`, {
      method: 'POST',
      headers: {
        'x-forgejo-signature': sig,
        'x-forgejo-event-type': 'workflow_job',
        'content-type': 'application/json',
      },
      body,
    })
    check('POST /webhook/codeberg queued/match → 202', res.status === 202)
    check('called Codeberg registration token exactly once', calls.codebergToken === before.codeberg + 1)
    check('called Fly spawn for Codeberg exactly once', calls.flySpawn === before.fly + 1)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
} finally {
  server.close()
}

process.exit(fail === 0 ? 0 : 1)
