import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import {
  ArrowLeft, ChevronRight, Clapperboard, ClipboardCopy, Copy, Link2, Music2,
  PlayCircle, Plus, RefreshCw, RotateCw, Settings, Trash2, Tv
} from 'lucide-react'

const STATUS_STYLE = { live: 'bg-emerald-600', die: 'bg-red-600', unknown: 'bg-slate-600' }
const SERVICE_STYLE = {
  netflix: { gradient: 'linear-gradient(135deg,#E50914,#B20710)', Icon: Clapperboard, dot: '#E50914' },
  spotify: { gradient: 'linear-gradient(135deg,#1DB954,#169C46)', Icon: Music2, dot: '#1DB954' }
}
const FALLBACK_STYLE = { gradient: 'linear-gradient(135deg,#475569,#1e293b)', Icon: Tv, dot: '#94a3b8' }
const styleFor = key => SERVICE_STYLE[key] || FALLBACK_STYLE

export default function Dashboard() {
  const [view, setView] = useState({ level: 'home' })
  const [items, setItems] = useState([])
  const [services, setServices] = useState([])
  const [fService, setFService] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [job, setJob] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [toast, setToast] = useState('')
  const [servicesErr, setServicesErr] = useState('')
  const pollRef = useRef(null)
  const reqId = useRef(0)
  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const load = useCallback(async () => {
    const id = ++reqId.current
    const p = new URLSearchParams()
    if (fService) p.set('service', fService)
    if (fStatus) p.set('status', fStatus)
    if (q) p.set('q', q)
    p.set('page', String(page))
    const list = await api(`/cookies?${p}`)
    if (id !== reqId.current) return // stale response — a newer request superseded this one
    setItems(list.items)
    setTotal(list.total)
  }, [fService, fStatus, q, page])

  const loadServices = useCallback(async () => {
    try { setServices(await api('/services')); setServicesErr('') }
    catch (e) { setServicesErr(e.message) }
  }, [])

  useEffect(() => { load().catch(e => showToast(e.message)) }, [load])
  useEffect(() => { setPage(1) }, [fService, fStatus, q]) // new filters → back to first page
  useEffect(() => { loadServices() }, [loadServices])

  useEffect(() => {
    if (!job?.running) { clearInterval(pollRef.current); return }
    pollRef.current = setInterval(async () => {
      try {
        const st = await api('/cookies/check-all')
        setJob(st)
        load().catch(() => {}) // refresh list so landed statuses appear immediately
        loadServices() // keep card live/total counts fresh as statuses land
        if (!st.running) showToast(`Check all done: ${st.done} checked, ${st.failed} errors`)
      } catch (err) {
        clearInterval(pollRef.current)
        setJob(null)
        showToast(`poll failed: ${err.message}`)
      }
    }, 2000)
    return () => clearInterval(pollRef.current)
  }, [job?.running, load, loadServices])

  const openService = key => {
    setView({ level: 'service', key })
    setFService(key)
    setQ(''); setFStatus('')
  }
  const backHome = () => { setView({ level: 'home' }); setFService('') }

  const checkOne = async id => {
    try { const r = await api(`/cookies/${id}/check`, { method: 'POST' }); showToast(`check: ${r.status}`); await Promise.all([load(), loadServices()]) }
    catch (e) { showToast(e.message) }
  }
  const checkAll = async service => {
    const svc = service ?? fService
    try { const r = await api('/cookies/check-all', { method: 'POST', body: svc ? { service: svc } : {} }); setJob({ running: true, pending: r.queued, done: 0, failed: 0 }) }
    catch (e) { showToast(e.message) }
  }
  const removeDie = async (key, name) => {
    if (!confirm(`Remove all DIE accounts of ${name}?`)) return
    try {
      const r = await api('/cookies/remove-die', { method: 'POST', body: { service: key } })
      showToast(`removed ${r.removed} die`)
      await Promise.all([load(), loadServices()])
    } catch (e) { showToast(e.message) }
  }

  const copyNft = async id => {
    try {
      const r = await api(`/cookies/${id}/nftoken`, { method: 'POST' })
      await navigator.clipboard.writeText(r.link)
      showToast('nftoken link copied (valid ~1h)')
    } catch (e) { showToast(e.message) }
  }
  const copy = async (id, format) => {
    try {
      const { content } = await api(`/cookies/${id}/export?format=${format}`)
      await navigator.clipboard.writeText(content)
      showToast(`copied as ${format}`)
    } catch (e) { showToast(e.message) }
  }
  const remove = async id => {
    if (!confirm('Delete this cookie?')) return
    await api(`/cookies/${id}`, { method: 'DELETE' }).catch(e => showToast(e.message))
    await Promise.all([load(), loadServices()]).catch(() => {})
  }
  const saveEdit = async (id, body) => {
    try { await api(`/cookies/${id}`, { method: 'PATCH', body }); setDetail(null); await load() }
    catch (e) { showToast(e.message) }
  }

  const current = view.level === 'service' ? services.find(s => s.key === view.key) : null

  return (
    <div className="min-h-screen p-6 space-y-4">
      <header className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold mr-auto">CookieHub</h1>
        <button onClick={loadServices} title="Refresh services"
          className="rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 p-2 text-slate-300"><RotateCw className="w-4 h-4" /></button>
        <button onClick={() => setAddOpen(true)} disabled={!services.length} title={services.length ? 'Add cookies' : 'services unavailable'}
          className="rounded-lg bg-sky-600 hover:bg-sky-500 p-2 text-white disabled:opacity-50"><Plus className="w-4 h-4" /></button>
        <button onClick={() => checkAll()} className="flex items-center gap-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-2 font-semibold text-sm">
          <PlayCircle className="w-4 h-4" />
          {job?.running ? `Checking… (${job.done + job.failed}/${job.done + job.failed + job.pending})` : 'Check All'}
        </button>
        <a href="/settings" title="Settings"
          className="rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 p-2 text-slate-300"><Settings className="w-4 h-4" /></a>
      </header>
      {servicesErr && <div className="rounded bg-red-900/40 border border-red-800 text-red-300 px-4 py-2 text-sm">{servicesErr}</div>}

      {view.level === 'home' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {services.map(s => {
            const { gradient, Icon } = styleFor(s.key)
            return (
              <div key={s.key} onClick={() => openService(s.key)}
                className="cursor-pointer rounded-xl border border-slate-800 bg-slate-900 overflow-hidden hover:border-slate-500 transition-colors">
                <div className="h-28 flex flex-col items-center justify-center gap-1.5" style={{ background: gradient }}>
                  <Icon className="w-10 h-10 text-white" strokeWidth={1.5} />
                  <div className="text-white font-bold">{s.name}</div>
                </div>
                <div className="p-3 space-y-2.5">
                  <div className="flex gap-1.5">
                    <span className="bg-emerald-600 text-white text-xs font-bold rounded-full px-2.5 py-0.5">● {s.liveCount} live</span>
                    <span className="bg-slate-700 text-slate-200 text-xs font-bold rounded-full px-2.5 py-0.5">{s.cookieCount} total</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={e => { e.stopPropagation(); checkAll(s.key) }} title={`Check all ${s.name}`}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/60"><PlayCircle className="w-4 h-4" /></button>
                    <button onClick={e => { e.stopPropagation(); removeDie(s.key, s.name) }} title="Remove die accounts"
                      className="rounded-lg p-1.5 text-red-400 hover:text-red-300 hover:bg-red-600/20"><Trash2 className="w-4 h-4" /></button>
                    <button onClick={e => { e.stopPropagation(); openService(s.key) }} title={`Open ${s.name}`}
                      className="ml-auto rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/60"><ChevronRight className="w-4 h-4" /></button>
                  </div>
                </div>
              </div>
            )
          })}
          {!services.length && !servicesErr && <p className="text-slate-500 col-span-full text-sm">no services</p>}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={backHome}
              className="flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-1.5 text-sm text-slate-300">
              <ArrowLeft className="w-4 h-4" /> All services
            </button>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: styleFor(view.key).dot }} />
              {current?.name || view.key}
            </h2>
            <input value={q} onChange={e => { setPage(1); setQ(e.target.value) }} placeholder="Search label/notes…"
              className="ml-auto rounded bg-slate-800 border border-slate-700 px-3 py-1.5" />
            <select value={fStatus} onChange={e => { setPage(1); setFStatus(e.target.value) }} className="rounded bg-slate-800 border border-slate-700 px-3 py-1.5">
              <option value="">all status</option>
              <option value="live">live</option><option value="die">die</option><option value="unknown">unknown</option>
            </select>
            <button onClick={() => removeDie(view.key, current?.name || view.key)}
              className="flex items-center gap-1.5 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 px-3 py-1.5 text-sm font-semibold">
              <Trash2 className="w-4 h-4" /> Remove die
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-400 text-left">
                <tr><th className="p-3">Label</th><th className="p-3">Service</th><th className="p-3">Status</th><th className="p-3">Account</th><th className="p-3">Checked</th><th className="p-3">Actions</th></tr>
              </thead>
              <tbody>
                {items.map(c => {
                  const checking = job?.running && job.activeIds?.includes(c.id)
                  return (
                    <tr key={c.id} className="border-t border-slate-800 hover:bg-slate-800/40">
                      <td className="p-3 cursor-pointer" onClick={() => setDetail(c)}>{c.label || <span className="text-slate-500">#{c.id}</span>}</td>
                      <td className="p-3">{c.service_key}</td>
                      <td className="p-3">{checking
                        ? <span className="bg-amber-500 animate-pulse text-white text-xs font-bold rounded px-2 py-0.5 uppercase">checking…</span>
                        : <span className={`${STATUS_STYLE[c.status]} text-white text-xs font-bold rounded px-2 py-0.5 uppercase`}>{c.status}</span>}</td>
                      <td className="p-3 text-slate-300">
                        {c.account_info ? [c.account_info.email, c.account_info.plan, c.account_info.country, c.account_info.expiresAt].filter(Boolean).join(' · ') : '—'}
                      </td>
                      <td className="p-3 text-slate-400">{c.last_checked_at ? new Date(c.last_checked_at).toLocaleString() : 'never'}</td>
                      <td className="p-3 whitespace-nowrap">
                        <div className="flex gap-1">
                          <button onClick={() => checkOne(c.id)} disabled={checking} title={checking ? 'check in progress' : 'Check now'}
                            className="rounded-lg p-1.5 text-sky-600 bg-sky-600/20 hover:bg-sky-600/30 disabled:opacity-40"><RefreshCw className="w-4 h-4" /></button>
                          <button onClick={() => copy(c.id, 'header')} title="Copy as header string"
                            className="rounded-lg p-1.5 text-slate-300 bg-slate-700/50 hover:bg-slate-700"><Copy className="w-4 h-4" /></button>
                          <button onClick={() => copy(c.id, 'netscape')} title="Copy as netscape"
                            className="rounded-lg p-1.5 text-slate-300 bg-slate-700/50 hover:bg-slate-700"><ClipboardCopy className="w-4 h-4" /></button>
                          {c.service_key === 'netflix' && (
                            <button onClick={() => copyNft(c.id)} title="Copy nftoken login link"
                              className="rounded-lg p-1.5 text-violet-600 bg-violet-600/20 hover:bg-violet-600/30"><Link2 className="w-4 h-4" /></button>
                          )}
                          <button onClick={() => remove(c.id)} title="Delete"
                            className="rounded-lg p-1.5 text-red-600 bg-red-600/20 hover:bg-red-600/30"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {!items.length && <tr><td colSpan="6" className="p-6 text-center text-slate-500">no cookies — add one</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-3 text-sm text-slate-400">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 disabled:opacity-40">Prev</button>
            <span>page {page} of {Math.max(1, Math.ceil(total / 50))}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={page >= Math.ceil(total / 50)}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </>
      )}

      {addOpen && <AddModal services={services} onClose={() => setAddOpen(false)} onDone={() => { load().catch(() => {}); loadServices() }} showToast={showToast} />}
      {detail && <DetailDrawer cookie={detail} onClose={() => setDetail(null)} onSave={saveEdit} showToast={showToast} />}
      {toast && <div className="fixed bottom-6 right-6 rounded bg-slate-700 px-4 py-2 shadow-lg">{toast}</div>}
    </div>
  )
}

function AddModal({ services, onClose, onDone, showToast }) {
  const [service, setService] = useState(services[0]?.key || '')
  const [label, setLabel] = useState('')
  const [content, setContent] = useState('')
  const [result, setResult] = useState(null)
  const createdAny = useRef(false)
  useEffect(() => { if (!service && services.length) setService(services[0].key) }, [services, service])
  const close = () => { onClose(); if (createdAny.current) onDone() }
  const submit = async e => {
    e.preventDefault()
    try {
      const r = await api('/cookies', { method: 'POST', body: { service, content, label } })
      if (r.created.length) createdAny.current = true
      setResult(r)
      showToast(`imported ${r.created.length}, failed ${r.failed.length}`)
    } catch (err) { showToast(err.message) }
  }
  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4" onClick={close}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} className="bg-slate-800 rounded-xl p-6 w-full max-w-2xl space-y-3">
        <h2 className="text-lg font-bold">Add cookies</h2>
        <div className="flex gap-3">
          <select value={service} onChange={e => setService(e.target.value)} className="rounded bg-slate-900 border border-slate-700 px-3 py-2">
            {services.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="label (optional)"
            className="flex-1 rounded bg-slate-900 border border-slate-700 px-3 py-2" />
        </div>
        <textarea value={content} onChange={e => setContent(e.target.value)} rows={10} required
          placeholder="Netscape, header string (k=v; k=v), or Cookie-Editor JSON — bulk: separate sets with a blank line."
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-xs" />
        <div className="flex gap-2 justify-end">
          <label className="mr-auto cursor-pointer rounded bg-slate-700 hover:bg-slate-600 px-4 py-2 text-sm">Choose file<input type="file" accept=".txt,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; f.text().then(setContent) }} /></label>
          <button type="button" onClick={close} className="rounded bg-slate-700 px-4 py-2">close</button>
          <button className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">import</button>
        </div>
        {result && (
          <div className="text-xs space-y-1 max-h-40 overflow-auto">
            {result.created.map(c => <div key={c.id} className="text-emerald-400">#{c.id} imported ({c.source_format})</div>)}
            {result.failed.map(f => <div key={f.index} className="text-red-400">chunk {f.index}: {f.error}</div>)}
          </div>
        )}
      </form>
    </div>
  )
}

function DetailDrawer({ cookie, onClose, onSave, showToast }) {
  const [label, setLabel] = useState(cookie.label)
  const [notes, setNotes] = useState(cookie.notes || '')
  const [logs, setLogs] = useState([])
  const [logsErr, setLogsErr] = useState('')
  useEffect(() => { api(`/cookies/${cookie.id}/logs`).then(r => setLogs(r.items)).catch(e => setLogsErr(e.message)) }, [cookie.id])
  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-slate-800 w-full max-w-md h-full p-6 space-y-4 overflow-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">#{cookie.id} · {cookie.service_key}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>
        <input value={label} onChange={e => setLabel(e.target.value)} className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" />
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="notes"
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" />
        <button onClick={() => onSave(cookie.id, { label, notes })} className="rounded bg-sky-600 px-4 py-2 font-semibold">save</button>
        <div>
          <h3 className="font-semibold mb-2 text-slate-400">Check history</h3>
          <div className="space-y-1 text-xs">
            {logsErr ? <p className="text-red-400">{logsErr}</p> : (
              <>
                {logs.map(l => (
                  <div key={l.id} className="flex gap-2">
                    <span className={l.status === 'live' ? 'text-emerald-400' : l.status === 'die' ? 'text-red-400' : 'text-amber-400'}>{l.status}</span>
                    <span className="text-slate-500">{new Date(l.created_at).toLocaleString()}</span>
                    <span className="text-slate-400 truncate">{l.reason}</span>
                  </div>
                ))}
                {!logs.length && <p className="text-slate-500">never checked</p>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
