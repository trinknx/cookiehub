import { fetch as undiciFetch, ProxyAgent, Agent } from 'undici'
import { SocksClient } from 'socks'
import { getSetting } from './db.js'
import { decryptJSON } from './crypto.js'
import { toHeaderString } from './cookieFormat.js'

const CONCURRENCY = 3
const SERVICE_GAP_MS = 1000
const TIMEOUT_MS = 15000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function createEngine({ db, adapters }) {
  const lastReq = new Map()
  const dispatchers = new Map()
  const inflight = new Set()
  const job = { running: false, pending: 0, done: 0, failed: 0 }

  const getServiceSetting = key =>
    db.prepare('SELECT proxy, disabled FROM service_settings WHERE service_key=?').get(key)

  function buildDispatcher(proxyUrl) {
    if (!proxyUrl) return undefined
    if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl)
    const u = new URL(proxyUrl)
    let d
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      d = new ProxyAgent({ uri: proxyUrl })
    } else if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') {
      d = new Agent({
        connect: async ({ hostname, port }, callback) => {
          try {
            const { socket } = await SocksClient.createConnection({
              proxy: {
                host: u.hostname, port: Number(u.port || 1080), type: 5,
                userId: decodeURIComponent(u.username || ''),
                password: decodeURIComponent(u.password || '')
              },
              command: 'connect',
              destination: { host: hostname, port: Number(port) }
            })
            callback(null, { socket })
          } catch (e) { callback(e, null) }
        }
      })
    } else {
      throw new Error(`unsupported proxy protocol: ${u.protocol}`)
    }
    dispatchers.set(proxyUrl, d)
    return d
  }

  const proxyFor = serviceKey =>
    getServiceSetting(serviceKey)?.proxy ?? getSetting(db, 'proxy_global') ?? null

  async function runCheck(cookieId) {
    if (inflight.has(cookieId)) { const e = new Error('already checking'); e.status = 409; throw e }
    const row = db.prepare('SELECT * FROM cookies WHERE id=?').get(cookieId)
    if (!row) { const e = new Error('cookie not found'); e.status = 404; throw e }
    const adapter = adapters.get(row.service_key)
    if (!adapter) { const e = new Error('unknown service'); e.status = 422; throw e }
    inflight.add(cookieId)
    await acquire()
    const proxy = proxyFor(row.service_key)
    const start = Date.now()
    try {
      const cookies = decryptJSON(row.content_enc)
      const cookieHeader = toHeaderString(cookies)
      const dispatcher = buildDispatcher(proxy)
      const boundFetch = async (url, init = {}) => {
        const wait = lastReq.get(row.service_key) + SERVICE_GAP_MS - Date.now()
        if (wait > 0) await sleep(wait)
        lastReq.set(row.service_key, Date.now())
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
        try {
          return await undiciFetch(url, { ...init, dispatcher, signal: ctrl.signal, headers: { 'user-agent': UA, ...(init.headers || {}) } })
        } finally { clearTimeout(t) }
      }
      const result = await adapter.check({ cookieHeader, cookies, fetch: boundFetch, log: () => {} })
      const status = result.status === 'live' ? 'live' : 'die'
      const now = Date.now()
      if (status === 'live') {
        db.prepare('UPDATE cookies SET status=?, account_info=COALESCE(?, account_info), last_checked_at=?, updated_at=? WHERE id=?')
          .run(status, result.accountInfo ? JSON.stringify(result.accountInfo) : null, now, now, cookieId)
      } else {
        db.prepare('UPDATE cookies SET status=?, last_checked_at=?, updated_at=? WHERE id=?')
          .run(status, now, now, cookieId)
      }
      log(cookieId, status, result.reason || '', result.accountInfo || null, proxy, Date.now() - start)
      return status
    } catch (e) {
      log(cookieId, 'error', e.message, null, proxy, Date.now() - start)
      return 'error'
    } finally {
      releaseSlot()
      inflight.delete(cookieId)
    }
  }

  const log = (cookieId, status, reason, detail, proxy, duration) =>
    db.prepare('INSERT INTO check_logs(cookie_id,status,reason,detail,proxy_used,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(cookieId, status, reason, detail ? JSON.stringify(detail) : null, proxy, duration, Date.now())

  // simple semaphore
  let active = 0
  const waiting = []
  const acquire = () => {
    if (active < CONCURRENCY) { active++; return Promise.resolve() }
    return new Promise(r => waiting.push(r)).then(() => {})
  }
  const releaseSlot = () => {
    if (waiting.length) waiting.shift()()
    else active--
  }

  function startCheckAll(serviceKey) {
    if (job.running) { const e = new Error('check-all already running'); e.status = 409; throw e }
    let sql = 'SELECT c.id, c.service_key FROM cookies c LEFT JOIN service_settings s ON s.service_key = c.service_key WHERE COALESCE(s.disabled, 0) = 0'
    const params = []
    if (serviceKey) { sql += ' AND c.service_key = ?'; params.push(serviceKey) }
    const rows = db.prepare(sql).all(...params)
    job.running = true; job.pending = rows.length; job.done = 0; job.failed = 0
    ;(async () => {
      await Promise.all(rows.map(async r => {
        const st = await runCheck(r.id)
        job.pending--
        if (st === 'error') job.failed++; else job.done++
      }))
      job.running = false
    })()
    return { queued: rows.length }
  }

  const jobStatus = () => ({ ...job })

  return { runCheck, startCheckAll, jobStatus, buildDispatcher, proxyFor }
}
