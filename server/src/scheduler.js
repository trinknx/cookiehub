import cron from 'node-cron'

export function hoursToPattern(h) {
  return h === 24 ? '0 0 * * *' : `0 */${h} * * *`
}

export function createScheduler({ getSetting, startCheckAll }) {
  let task = null
  return {
    reschedule() {
      if (task) { task.stop(); task = null }
      if (getSetting('auto_check_enabled') !== 'true') return
      const h = Math.min(168, Math.max(1, Number(getSetting('auto_check_interval_hours')) || 6))
      task = cron.schedule(hoursToPattern(h), () => { try { startCheckAll() } catch { /* already running */ } })
    }
  }
}
