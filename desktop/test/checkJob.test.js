import { describe, it, expect } from 'vitest'
import { createCheckJob } from '../src/main/checkJob.js'

const setup = (licenses, checkImpl) => {
  const applied = []
  const events = []
  const job = createCheckJob({
    selectLicenses: () => licenses,
    applyResult: (l, r) => applied.push([l, r]),
    check: checkImpl || (async l => ({ state: 'valid', detail: '', live: null })),
    delayMs: 0,
    onEvent: s => events.push(s),
  })
  return { job, applied, events }
}
const idle = async j => { for (let i = 0; i < 200; i++) { if (!j.status().running) return; await new Promise(r => setTimeout(r, 10)) } }

describe('checkJob', () => {
  it('runs serially over all licenses, applying results and emitting progress', async () => {
    const order = []
    const { job, applied, events } = setup(['A', 'B', 'C'], async l => { order.push(l); return { state: 'valid', detail: '', live: null } })
    const r = job.start('all')
    expect(r).toEqual({ started: true, total: 3 })
    await idle(job)
    expect(order).toEqual(['A', 'B', 'C'])
    expect(applied).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ running: false, done: 3, failed: 0 })
  })

  it('counts failures and records error detail without stopping', async () => {
    const { job, applied } = setup(['A', 'B'], async l => { if (l === 'A') throw new Error('boom'); return { state: 'valid', detail: '', live: null } })
    job.start('all')
    await idle(job)
    expect(job.status().failed).toBe(1)
    expect(job.status().done).toBe(1)
    expect(applied[0][1].detail).toBe('boom')
    expect(applied[0][1].state).toBe('unknown')
  })

  it('start throws job_running while busy, no_accounts when empty', async () => {
    const { job } = setup(['A'], async () => { await new Promise(r => setTimeout(r, 50)); return { state: 'valid', detail: '', live: null } })
    job.start('all')
    expect(() => job.start('all')).toThrowError(/\balready running\b/)
    await idle(job)
    const empty = setup([])
    expect(() => empty.job.start('all')).toThrowError(/\bnothing to check\b/)
  })

  it('cancel stops after the current license', async () => {
    const seen = []
    const { job } = setup(['A', 'B', 'C'], async l => { seen.push(l); return { state: 'valid', detail: '', live: null } })
    job.start('all')
    job.cancel()
    await idle(job)
    expect(seen.length).toBeLessThanOrEqual(2) // current one finishes, rest skipped
    expect(job.status().running).toBe(false)
  })

  it('cancel() returns true only while running — false before start and after a cancelled run', async () => {
    const { job } = setup(['A', 'B', 'C'])
    expect(job.cancel()).toBe(false) // never started
    job.start('all')
    expect(job.cancel()).toBe(true) // running → cancel requested
    await idle(job)
    expect(job.cancel()).toBe(false) // run already finished cancelled; stale true would lie
  })

  it('clears running when the initial progress event throws', async () => {
    let eventCount = 0
    const job = createCheckJob({
      selectLicenses: () => ['A'],
      applyResult: () => {},
      check: async () => ({ state: 'valid', detail: '', live: null }),
      delayMs: 0,
      onEvent: () => { if (++eventCount === 1) throw new Error('event boom') },
    })
    job.start('all')
    await new Promise(r => setTimeout(r, 0))
    expect(job.status()).toMatchObject({ running: false, current: null, error: 'event boom' })
  })

  it('cancel interrupts an inter-license delay promptly', async () => {
    const seen = []
    const job = createCheckJob({
      selectLicenses: () => ['A', 'B'],
      applyResult: () => {},
      check: async l => { seen.push(l); return { state: 'valid', detail: '', live: null } },
      delayMs: 250,
    })
    job.start('all')
    await new Promise(r => setTimeout(r, 25))
    const cancelledAt = Date.now()
    job.cancel()
    await idle(job)
    expect(Date.now() - cancelledAt).toBeLessThan(150)
    expect(job.status().running).toBe(false)
    expect(seen).toEqual(['A'])
  })

  it('exposes only the documented status fields', () => {
    const { job } = setup(['A'])
    expect(job.status()).toEqual({
      running: false,
      total: 0,
      done: 0,
      failed: 0,
      current: null,
      error: '',
    })
  })
})
