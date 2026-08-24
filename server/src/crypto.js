import crypto from 'node:crypto'

let KEY = null

export function initEncryption(keyB64) {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes')
  KEY = key
}

export function generateKeyB64() {
  return crypto.randomBytes(32).toString('base64')
}

export function encryptJSON(obj) {
  if (!KEY) throw new Error('encryption not initialized')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function decryptJSON(buf) {
  if (!KEY) throw new Error('encryption not initialized')
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28)
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
  d.setAuthTag(tag)
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString())
}
