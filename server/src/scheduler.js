export function createScheduler({ getSetting, startCheckAll }) {
  let timer = null
  return {
    reschedule() {
      if (timer) { clearInterval(timer); timer = null }
      if (getSetting('auto_check_enabled') !== 'true') return
      const h = Math.min(168, Math.max(1, Number(getSetting('auto_check_interval_hours')) || 6))
      timer = setInterval(() => {
        console.log('[cookiehub] scheduled check-all starting')
        try {
          startCheckAll()
        } catch (e) {
          // swallow so one failure never kills the timer — but say what happened
          if (String(e.message).includes('already running')) console.log('[cookiehub] scheduled check-all skipped: already running')
          else console.error('[cookiehub] scheduled check-all failed:', e.message)
        }
      }, h * 3600 * 1000)
    }
  }
}
