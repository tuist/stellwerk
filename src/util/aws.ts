import { bytesToHex, stringToBytes } from './encoding.ts'

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface AwsJsonRequest {
  region: string
  service: string
  target: string
  body: unknown
  credentials: AwsCredentials
  endpoint?: string
  now?: Date
  fetchFn?: typeof fetch
}

export async function awsJsonFetch(opts: AwsJsonRequest): Promise<Response> {
  const endpoint = opts.endpoint ?? `https://${opts.service}.${opts.region}.amazonaws.com/`
  const url = new URL(endpoint)
  const now = opts.now ?? new Date()
  const amzDate = awsDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const payload = JSON.stringify(opts.body)
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-target': opts.target,
    ...(opts.credentials.sessionToken ? { 'x-amz-security-token': opts.credentials.sessionToken } : {}),
  }
  const signedHeaders = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name]!.trim()}\n`).join('')
  const canonicalRequest = [
    'POST',
    url.pathname || '/',
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders.join(';'),
    await sha256Hex(payload),
  ].join('\n')
  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n')
  const signingKey = await awsSigningKey(opts.credentials.secretAccessKey, dateStamp, opts.region, opts.service)
  const signature = bytesToHex(await hmacSha256(signingKey, stringToBytes(stringToSign)))
  const authorization = `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(
    ';',
  )}, Signature=${signature}`

  return (opts.fetchFn ?? fetch)(endpoint, {
    method: 'POST',
    headers: { ...headers, authorization },
    body: payload,
  })
}

async function awsSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const dateKey = await hmacSha256(stringToBytes(`AWS4${secretAccessKey}`), stringToBytes(dateStamp))
  const dateRegionKey = await hmacSha256(dateKey, stringToBytes(region))
  const dateRegionServiceKey = await hmacSha256(dateRegionKey, stringToBytes(service))
  return hmacSha256(dateRegionServiceKey, stringToBytes('aws4_request'))
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource))
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', stringToBytes(data) as BufferSource)
  return bytesToHex(new Uint8Array(hash))
}

function awsDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}
