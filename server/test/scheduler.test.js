import { describe, it, expect } from 'vitest'
import { hoursToPattern } from '../src/scheduler.js'

describe('hoursToPattern', () => {
  it('24h → daily midnight', () => expect(hoursToPattern(24)).toBe('0 0 * * *'))
  it('6h → every 6 hours', () => expect(hoursToPattern(6)).toBe('0 */6 * * *'))
  it('clamps weird input at call sites (pattern still valid cron)', () => {
    expect(hoursToPattern(1)).toBe('0 */1 * * *')
  })
})
