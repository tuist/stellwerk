import { describe, expect, it } from 'vitest'
import { bytesToBase64Url, bytesToHex, hexToBytes, stringToBytes, timingSafeEqual } from '../src/util/encoding.ts'

describe('encoding', () => {
  it('bytesToHex/hexToBytes round-trip', () => {
    const data = new Uint8Array([0, 1, 15, 16, 254, 255])
    expect(bytesToHex(data)).toBe('00010f10feff')
    expect(hexToBytes('00010f10feff')).toEqual(data)
  })

  it('bytesToBase64Url emits unpadded url-safe', () => {
    expect(bytesToBase64Url(stringToBytes('any carnal pleasure.'))).toBe('YW55IGNhcm5hbCBwbGVhc3VyZS4')
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
  })

  it('timingSafeEqual is length-aware', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})
