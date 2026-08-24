import { describe, it, expect, vi, afterEach } from 'vitest'
import { createScheduler } from '../src/scheduler.js'

afterEach(() => vi.useRealTimers())

describe('createScheduler', () => {
  it('runs startCheckAll once per configured interval', async () => {
    vi.useFakeTimers()
    const settings = { auto_check_enabled: 'true', auto_check_interval_hours: '6' }
    const startCheckAll = vi.fn()
    const scheduler = createScheduler({ getSetting: k => settings[k], startCheckAll })
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000)
    expect(startCheckAll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000)
    expect(startCheckAll).toHaveBeenCalledTimes(2)
  })

  it('no-op when disabled', async () => {
    vi.useFakeTimers()
    const settings = { auto_check_enabled: 'false', auto_check_interval_hours: '6' }
    const startCheckAll = vi.fn()
    const scheduler = createScheduler({ getSetting: k => settings[k], startCheckAll })
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(48 * 3600 * 1000)
    expect(startCheckAll).not.toHaveBeenCalled()
  })

  it('reschedule clears the previous timer', async () => {
    vi.useFakeTimers()
    const settings = { auto_check_enabled: 'true', auto_check_interval_hours: '6' }
    const startCheckAll = vi.fn()
    const scheduler = createScheduler({ getSetting: k => settings[k], startCheckAll })
    scheduler.reschedule()
    settings.auto_check_interval_hours = '12'
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000)
    expect(startCheckAll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000)
    expect(startCheckAll).toHaveBeenCalledTimes(1)
  })

  it('intervals above 24h stay multi-day (cron bug regression)', async () => {
    vi.useFakeTimers()
    const settings = { auto_check_enabled: 'true', auto_check_interval_hours: '168' }
    const startCheckAll = vi.fn()
    const scheduler = createScheduler({ getSetting: k => settings[k], startCheckAll })
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000)
    expect(startCheckAll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(144 * 3600 * 1000)
    expect(startCheckAll).toHaveBeenCalledTimes(1)
  })
})
