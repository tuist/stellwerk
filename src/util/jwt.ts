import { bytesToBase64Url, stringToBytes } from './encoding.ts'
import { signRs256 } from './crypto.ts'

export interface Rs256JwtClaims {
  iss: string
  iat: number
  exp: number
  [k: string]: unknown
}

/** Sign an RS256 JWT. Returns the compact serialization. */
export async function signJwtRs256(claims: Rs256JwtClaims, key: CryptoKey): Promise<string> {
  const header = bytesToBase64Url(stringToBytes(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = bytesToBase64Url(stringToBytes(JSON.stringify(claims)))
  const signingInput = `${header}.${payload}`
  const sig = await signRs256(key, stringToBytes(signingInput))
  return `${signingInput}.${bytesToBase64Url(sig)}`
}
