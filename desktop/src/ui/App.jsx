import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardCopy, PlayCircle, Plus, ShieldOff, Trash2, Upload } from 'lucide-react'
import ImportDialog from './ImportDialog.jsx'
import ConnectBanner from './ConnectBanner.jsx'
import JobBar from './JobBar.jsx'

const PILL = 'rounded px-1.5 py-0.5 text-[11px] font-semibold'
const STATE_STYLE = {
  valid: 'bg-emerald-600/30 text-emerald-300',
  expired: 'bg-amber-500/30 text-amber-300',
  canceled: 'bg-orange-600/30 text-orange-300',
  invalid: 'bg-red-600/30 text-red-300',
  unknown: 'bg-slate-600/40 text-slate-300',
}
const fmtDate = ts => (ts ? new Date(ts).toLocaleString() : '—')
const err = e => e?.message || String(e)

export default function App() {
  const [items, setItems] = useState([])
  const [ctlOk, setCtlOk] = useState(null)
  const [job, setJob] = useState(null)
  const [conn, setConn] = useState(null)
  const [pending, setPending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [toast, setToast] = useState('')
  const flash = msg => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  const load = useCallback(async () => {
    try { setItems(await window.xvpn.accountsList()) } catch (e) { flash(err(e)) }
  }, [])

  useEffect(() => {
    load().catch(() => {})
    Promise.all([
      window.xvpn.ctlAvailable(),
      window.xvpn.checkStatus(),
      window.xvpn.connectStatus(),
    ]).then(([ctl, job, conn]) => {
      setCtlOk(ctl); setJob(job); setConn(conn); setLoaded(true)
    }).catch(e => flash(err(e)))
    const offP = window.xvpn.onCheckProgress(s => { setJob(s); if (!s.running && s.total) load().catch(() => {}) })
    const offC = window.xvpn.onConnectState(setConn)
    return () => { offP(); offC() }
  }, [load])

  const counts = useMemo(() => items.reduce((m, a) => ((m[a.state] = (m[a.state] || 0) + 1), m), {}), [items])

  const checkAll = async () => {
    setPending(true)
    try {
      const r = await window.xvpn.checkStart(filter)
      setJob({ running: true, total: r.total, done: 0, failed: 0, current: null })
    } catch (e) { flash(err(e)) }
    finally { setPending(false) }
  }
  const cancel = async () => { await window.xvpn.checkCancel().catch(() => {}) }
  const remove = async license => {
    try { await window.xvpn.accountsDelete(license); load().catch(() => {}) } catch (e) { flash(err(e)) }
  }
  const connect = async license => {
    setPending(true)
    try { await window.xvpn.connectConnect(license) } catch (e) { flash(err(e)) }
    finally { setPending(false) }
  }
  const doExport = async () => {
    try {
      const text = await window.xvpn.accountsExport()
      await navigator.clipboard.writeText(text)
      flash(`${items.length} licenses copied to clipboard`)
    } catch (e) { flash(err(e)) }
  }
  const copy = (v, what) => navigator.clipboard.writeText(v).then(() => flash(`${what} copied`), () => {})

  const busy = job?.running
  const locked = busy || pending || conn?.state !== 'idle'
  const guard = !loaded || !ctlOk || locked

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {ctlOk === false && (
        <div className="bg-amber-900/40 border-b border-amber-800 text-amber-200 px-4 py-2 text-sm flex items-center gap-2">
          <ShieldOff className="w-4 h-4" /> expressvpnctl not found — import/export/list work, check/connect disabled.
        </div>
      )}
      <ConnectBanner conn={conn || { state: 'idle' }} onDisconnect={async () => { try { await window.xvpn.connectDisconnect() } catch (e) { flash(err(e)) } }} disabled={!ctlOk} />

      <header className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 flex-wrap">
        <h1 className="font-bold text-lg mr-2">XVPN Manager</h1>
        {Object.entries(counts).map(([s, n]) => (
          <span key={s} className={`${PILL} ${STATE_STYLE[s] || STATE_STYLE.unknown}`}>{s}: {n}</span>
        ))}
        <div className="flex-1" />
        <button onClick={() => setImportOpen(true)} className="flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-2 font-semibold text-sm">
          <Plus className="w-4 h-4" /> Import
        </button>
        <button onClick={doExport} className="flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-2 font-semibold text-sm">
          <Upload className="w-4 h-4" /> Export
        </button>
        <button onClick={checkAll} disabled={guard}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 font-semibold text-sm text-white ${guard ? 'bg-violet-900/50 cursor-not-allowed' : 'bg-violet-600 hover:bg-violet-500'}`}>
          <PlayCircle className="w-4 h-4" /> {busy ? `Checking… (${(job.done + job.failed)}/${job.total})` : `Check ${filter === 'unknown' ? 'Unknown' : 'All'}`}
        </button>
        <button onClick={() => setFilter(f => (f === 'all' ? 'unknown' : 'all'))} title="toggle check filter"
          className="rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-2 text-xs font-mono">
          filter: {filter}
        </button>
      </header>

      {busy && <JobBar job={job} onCancel={cancel} />}

      <main className="p-4">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-400 border-b border-slate-800">
            <tr>
              <th className="py-2">State</th><th>Email</th><th>Plan</th><th>Expire</th>
              <th>Live</th><th>Payment</th><th>Checked</th><th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(a => {
              const m = a.meta ? JSON.parse(a.meta) : {}
              return (
                <tr key={a.license} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                  <td className="py-2"><span className={`${PILL} ${STATE_STYLE[a.state] || STATE_STYLE.unknown}`}>{a.state}</span></td>
                  <td className="font-mono text-xs">{a.email}</td>
                  <td>{m.plan || '—'}</td>
                  <td className="text-xs">{m.expire || '—'}{m.days ? ` (${m.days}d)` : ''}</td>
                  <td className="text-xs">{a.live_days != null ? `${a.live_days}d · ${a.live_expire || '?'}` : '—'}</td>
                  <td className="text-xs">{a.live_payment || m.payment || '—'}</td>
                  <td className="text-xs text-slate-400">{fmtDate(a.checked_at)}</td>
                  <td className="text-right whitespace-nowrap">
                    <button title="Copy license" onClick={() => copy(a.license, 'License')} className="rounded p-1.5 hover:bg-slate-700 text-slate-300"><ClipboardCopy className="w-4 h-4" /></button>
                    <button title="Connect" disabled={guard} onClick={() => connect(a.license)}
                      className="rounded p-1.5 hover:bg-slate-700 text-emerald-400 disabled:opacity-30"><PlayCircle className="w-4 h-4" /></button>
                    <button title="Delete" onClick={() => remove(a.license)} className="rounded p-1.5 hover:bg-slate-700 text-red-400"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!items.length && <p className="text-slate-500 text-sm mt-8 text-center">No licenses — Import to start.</p>}
      </main>

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onDone={r => { flash(`Imported ${r.imported}, updated ${r.updated} (${r.lines} lines)`); load().catch(() => {}) }} />}
      {toast && <div className="fixed bottom-4 right-4 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm shadow-lg">{toast}</div>}
    </div>
  )
}
