import { describe, it, expect } from 'vitest'
import { parseBillingIso } from '../src/billingDate.js'

describe('parseBillingIso', () => {
  // every case below is a real nextBillingDate captured from live accounts
  it('English (baseline)', () => {
    expect(parseBillingIso('24 September 2026')).toBe('2026-09-24')
    expect(parseBillingIso('1 March 2027')).toBe('2027-03-01')
  })
  it('Vietnamese numeric months', () => {
    expect(parseBillingIso('26 tháng 9, 2026')).toBe('2026-09-26')
    expect(parseBillingIso('2 tháng 12, 2026')).toBe('2026-12-02')
  })
  it('Spanish / Portuguese', () => {
    expect(parseBillingIso('23 de septiembre de 2026')).toBe('2026-09-23')
    expect(parseBillingIso('5 de outubro de 2026')).toBe('2026-10-05')
  })
  it('Turkish with diacritics', () => {
    expect(parseBillingIso('25 Ağustos 2026')).toBe('2026-08-25')
  })
  it('Arabic with Arabic-Indic digits (both name sets)', () => {
    expect(parseBillingIso('٢٤ أيلول ٢٠٢٦')).toBe('2026-09-24') // Levantine أيلول
    expect(parseBillingIso('١٥ سبتمبر ٢٠٢٦')).toBe('2026-09-15') // MDA سبتمبر
    expect(parseBillingIso('٣ كانون الثاني ٢٠٢٧')).toBe('2027-01-03')
  })
  it('French / German / Indonesian', () => {
    expect(parseBillingIso('14 août 2026')).toBe('2026-08-14')
    expect(parseBillingIso('3. Oktober 2026')).toBe('2026-10-03')
    expect(parseBillingIso('17 September 2026')).toBe('2026-09-17')
  })
  it('unparseable input → null (no throw)', () => {
    expect(parseBillingIso('whenever')).toBeNull()
    expect(parseBillingIso('')).toBeNull()
    expect(parseBillingIso(null)).toBeNull()
    expect(parseBillingIso(undefined)).toBeNull()
    expect(parseBillingIso('32 VX 2026')).toBeNull() // day and month both missing/garbage
  })
  it('calendar sanity: impossible dates → null', () => {
    expect(parseBillingIso('31 tháng 2, 2027')).toBeNull()
    expect(parseBillingIso('31 septembre 2026')).toBeNull()
  })
})
