const sleep = async (ms, cancelled) => {
  const end = Date.now() + ms
  while (!cancelled()) {
    const remaining = end - Date.now()
    if (remaining <= 0) return
    await new Promise(r => setTimeout(r, Math.min(50, remaining)))
  }
}

// Serial license-check job. One ExpressVPN daemon ⇒ no concurrency; one job
// at a time. Errors from individual checks are recorded (state stays
// 'unknown' — a failed probe is not a dead license).
export function createCheckJob({ selectLicenses, applyResult, check, delayMs = 1500, onEvent = () => {} }) {
  const job = { running: false, total: 0, done: 0, failed: 0, current: null, error: '', cancelRequested: false }
  const status = () => ({
    running: job.running,
    total: job.total,
    done: job.done,
    failed: job.failed,
    current: job.current,
    error: job.error,
  })
  const emit = () => onEvent(status())

  async function run(licenses) {
    try {
      job.running = true; job.total = licenses.length; job.done = 0; job.failed = 0
      job.current = null; job.error = ''; job.cancelRequested = false
      emit()
      for (let i = 0; i < licenses.length; i++) {
        if (job.cancelRequested) break
        job.current = licenses[i]; emit()
        try {
          applyResult(licenses[i], await check(licenses[i]))
          job.done++
        } catch (e) {
          job.failed++; job.error = e.message
          applyResult(licenses[i], { state: 'unknown', detail: e.message, live: null })
        }
        emit()
        if (i < licenses.length - 1 && !job.cancelRequested) await sleep(delayMs, () => job.cancelRequested)
      }
    } finally {
      job.running = false; job.current = null; emit()
    }
  }

  return {
    start(filter) {
      if (job.running) { const e = new Error('a check job is already running'); e.code = 'job_running'; throw e }
      const licenses = selectLicenses(filter)
      if (!licenses.length) { const e = new Error('nothing to check'); e.code = 'no_accounts'; throw e }
      run(licenses).catch(e => { job.error = e.message })
      return { started: true, total: licenses.length }
    },
    cancel: () => { if (job.running) job.cancelRequested = true; return job.cancelRequested },
    status,
  }
}
