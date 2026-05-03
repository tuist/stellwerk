import { importRsaPrivateKey } from './crypto.ts'
import { signJwtRs256 } from './jwt.ts'

export interface GoogleAccessTokenOptions {
  accessToken?: string
  serviceAccountEmail?: string
  privateKeyPem?: string
  scope?: string
  tokenUrl?: string
  now?: Date
  fetchFn?: typeof fetch
}

const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export async function googleAccessToken(opts: GoogleAccessTokenOptions): Promise<string> {
  if (opts.accessToken) return opts.accessToken
  if (!opts.serviceAccountEmail || !opts.privateKeyPem) {
    throw new Error('GCP: access token or service account credentials are required')
  }
  const tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const key = await importRsaPrivateKey(opts.privateKeyPem)
  const assertion = await signJwtRs256(
    {
      iss: opts.serviceAccountEmail,
      scope: opts.scope ?? DEFAULT_SCOPE,
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    },
    key,
  )
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })
  const res = await (opts.fetchFn ?? fetch)(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!res.ok) {
    throw new Error(`GCP: token exchange failed: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('GCP: token exchange response did not include access_token')
  return data.access_token
}
