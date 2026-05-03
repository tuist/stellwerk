import { base64ToBytes, bytesToBase64, hexToBytes, stringToBytes, timingSafeEqual } from './encoding.ts'

function stripPem(pem: string): { kind: 'pkcs8' | 'pkcs1'; der: Uint8Array } {
  const match = pem.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END/)
  if (!match) throw new Error('Invalid PEM: missing PRIVATE KEY block')
  const kind = match[1] ? 'pkcs1' : 'pkcs8'
  const body = match[2]!.replace(/\s+/g, '')
  return { kind, der: base64ToBytes(body) }
}

// PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo wrapper.
// Wraps the existing DER in: SEQUENCE { INTEGER 0, AlgorithmIdentifier(rsaEncryption), OCTET STRING { ... } }.
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ])
  const version = new Uint8Array([0x02, 0x01, 0x00])
  const octetHeader = derLengthPrefix(0x04, pkcs1.length)
  const inner = concat(version, algId, octetHeader, pkcs1)
  const outerHeader = derLengthPrefix(0x30, inner.length)
  return concat(outerHeader, inner)
}

function derLengthPrefix(tag: number, length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length])
  if (length < 0x100) return new Uint8Array([tag, 0x81, length])
  if (length < 0x10000) return new Uint8Array([tag, 0x82, length >> 8, length & 0xff])
  return new Uint8Array([tag, 0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Import an RSA private key (PEM, either PKCS#8 or PKCS#1) for RS256 signing. */
export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const { kind, der } = stripPem(pem)
  const pkcs8 = kind === 'pkcs8' ? der : pkcs1ToPkcs8(der)
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export async function signRs256(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data as BufferSource)
  return new Uint8Array(sig)
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource))
}

/** Verify a `sha256=<hex>` HMAC signature against `body` using `secret`. Constant-time. */
export async function verifyHmacSha256Hex(secret: string, body: string, sigHeader: string): Promise<boolean> {
  const prefix = 'sha256='
  if (!sigHeader.startsWith(prefix)) return false
  return verifyHmacSha256HexRaw(secret, body, sigHeader.slice(prefix.length))
}

/** Verify a raw hex HMAC-SHA256 signature against `body` using `secret`. Constant-time. */
export async function verifyHmacSha256HexRaw(secret: string, body: string, sigHex: string): Promise<boolean> {
  const expected = hexToBytes(sigHex)
  const mac = await hmacSha256(stringToBytes(secret), stringToBytes(body))
  return timingSafeEqual(mac, expected)
}

export async function verifyStandardWebhookSha256(
  signingToken: string,
  messageId: string,
  timestamp: string,
  body: string,
  sigHeader: string,
): Promise<boolean> {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false

  const keyBytes = signingToken.startsWith('whsec_')
    ? base64ToBytes(signingToken.slice('whsec_'.length))
    : stringToBytes(signingToken)
  const message = `${messageId}.${timestamp}.${body}`
  const mac = await hmacSha256(keyBytes, stringToBytes(message))
  const expected = stringToBytes(`v1,${bytesToBase64(mac)}`)
  return sigHeader.split(' ').some((sig) => timingSafeEqual(expected, stringToBytes(sig)))
}
