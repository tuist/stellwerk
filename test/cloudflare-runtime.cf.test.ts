import { describe, expect, it } from 'vitest'

describe('Cloudflare runtime', () => {
  it('exposes Workers-only APIs', () => {
    expect(typeof WebSocketPair).toBe('function')
  })
})
