export function createScheduler({ getSetting, startCheckAll }) {
  let timer = null
  return {
    reschedule() {
      if (timer) { clearInterval(timer); timer = null }
      if (getSetting('auto_check_enabled') !== 'true') return
      const h = Math.min(168, Math.max(1, Number(getSetting('auto_check_interval_hours')) || 6))
      timer = setInterval(() => { try { startCheckAll() } catch { /* already running */ } }, h * 3600 * 1000)
    }
  }
}
