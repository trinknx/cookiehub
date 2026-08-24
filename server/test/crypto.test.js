import { describe, it, expect, beforeEach } from 'vitest'
import { initEncryption, generateKeyB64, encryptJSON, decryptJSON } from '../src/crypto.js'

describe('crypto', () => {
  beforeEach(() => initEncryption(generateKeyB64()))
  it('round-trips an object', () => {
    const data = [{ name: 'SecureSessionId', value: 'v1', domain: '.netflix.com' }]
    expect(decryptJSON(encryptJSON(data))).toEqual(data)
  })
  it('uses a fresh IV per call (different ciphertexts)', () => {
    expect(encryptJSON({ a: 1 }).equals(encryptJSON({ a: 1 }))).toBe(false)
  })
  it('rejects tampered ciphertext', () => {
    const buf = encryptJSON({ a: 1 }); buf[buf.length - 1] ^= 0xff
    expect(() => decryptJSON(buf)).toThrow()
  })
  it('rejects wrong key size', () => {
    expect(() => initEncryption(Buffer.alloc(8).toString('base64'))).toThrow(/32 bytes/)
  })
})
