import { describe, expect, it } from 'vitest'
import { importRsaPrivateKey, verifyHmacSha256Hex } from '../src/util/crypto.ts'
import { bytesToBase64Url, bytesToHex, stringToBytes } from '../src/util/encoding.ts'
import { signJwtRs256 } from '../src/util/jwt.ts'

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    stringToBytes(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, stringToBytes(body) as BufferSource))
  return bytesToHex(mac)
}

describe('verifyHmacSha256Hex', () => {
  it('accepts a valid sha256= header', async () => {
    const sig = await hmacHex('shh', 'hello')
    expect(await verifyHmacSha256Hex('shh', 'hello', `sha256=${sig}`)).toBe(true)
  })

  it('rejects a tampered body', async () => {
    const sig = await hmacHex('shh', 'hello')
    expect(await verifyHmacSha256Hex('shh', 'hello!', `sha256=${sig}`)).toBe(false)
  })

  it('rejects unprefixed signatures', async () => {
    const sig = await hmacHex('shh', 'hello')
    expect(await verifyHmacSha256Hex('shh', 'hello', sig)).toBe(false)
  })
})

async function generatePkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const b64 = btoa(String.fromCharCode(...pkcs8))
  const wrapped = b64.match(/.{1,64}/g)!.join('\n')
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  }
}

describe('jwt RS256', () => {
  it('round-trips via Web Crypto verify', async () => {
    const { pem, publicKey } = await generatePkcs8Pem()
    const key = await importRsaPrivateKey(pem)
    const jwt = await signJwtRs256({ iss: 'app-1', iat: 1700000000, exp: 1700000600 }, key)
    const [headerB64, payloadB64, sigB64] = jwt.split('.')
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy()

    const headerJson = JSON.parse(atob(headerB64!.replace(/-/g, '+').replace(/_/g, '/')))
    expect(headerJson).toEqual({ alg: 'RS256', typ: 'JWT' })

    const sig = Uint8Array.from(
      atob(sigB64!.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sigB64!.length + 3) % 4)),
      (c) => c.charCodeAt(0),
    )
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      sig as BufferSource,
      stringToBytes(`${headerB64}.${payloadB64}`) as BufferSource,
    )
    expect(ok).toBe(true)
  })
})

describe('importRsaPrivateKey', () => {
  it('rejects invalid PEM', async () => {
    await expect(importRsaPrivateKey('not a pem')).rejects.toThrow(/Invalid PEM/)
  })

  it('uses the bytesToBase64Url helper for predictable output', () => {
    expect(bytesToBase64Url(new Uint8Array([1, 2, 3]))).toBe('AQID')
  })
})
