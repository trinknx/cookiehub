import { useEffect, useState } from 'react'
import { api } from '../api'

export default function Settings() {
  const [s, setS] = useState(null)
  const [services, setServices] = useState([])
  const [msg, setMsg] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [failed, setFailed] = useState(false)
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' })
  const flash = m => { setMsg(m); setTimeout(() => setMsg(''), 2500) }

  const reload = () => Promise.all([api('/settings'), api('/services')])
    .then(([sv, svcs]) => { setS(sv); setServices(svcs) })
    .catch(e => { setLoadErr(e.message); setFailed(true) })
  useEffect(() => { reload() }, [])

  const save = async e => {
    e.preventDefault()
    try { await api('/settings', { method: 'PUT', body: s }); flash('saved') }
    catch (err) { flash(err.message) }
  }
  const changePw = async e => {
    e.preventDefault()
    try { await api('/settings/password', { method: 'POST', body: pw }); setPw({ currentPassword: '', newPassword: '' }); flash('password changed') }
    catch (err) { flash(err.message) }
  }
  const patchService = async (key, body) => {
    try { await api(`/services/${key}`, { method: 'PATCH', body }); reload() }
    catch (err) { flash(err.message); reload() }
  }

  if (!s && failed) return (
    <div className="min-h-screen p-8 max-w-3xl space-y-4">
      <div className="rounded bg-red-900/40 border border-red-800 text-red-300 px-4 py-2 text-sm">{loadErr}</div>
      <button onClick={() => { setFailed(false); setLoadErr(''); reload() }}
        className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">Retry</button>
    </div>
  )
  if (!s) return <div className="p-8 text-slate-400">loading…</div>
  return (
    <div className="min-h-screen p-6 max-w-3xl space-y-8">
      <header className="flex items-center">
        <h1 className="text-2xl font-bold mr-auto">Settings</h1>
        <a href="/" className="text-slate-400 hover:text-slate-200 underline text-sm">← dashboard</a>
      </header>
      {msg && <div className="rounded bg-slate-700 px-4 py-2">{msg}</div>}

      <form onSubmit={save} className="bg-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="font-bold">General</h2>
        <label className="block text-sm">
          Global proxy (http://, https://, socks5:// — empty = direct)
          <input value={s.proxyGlobal || ''} onChange={e => setS({ ...s, proxyGlobal: e.target.value || null })}
            placeholder="socks5://user:pass@1.2.3.4:1080"
            className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-xs" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.autoCheckEnabled} onChange={e => setS({ ...s, autoCheckEnabled: e.target.checked })} />
          Auto-check every
          <input type="number" min="1" max="168" value={s.autoCheckIntervalHours}
            onChange={e => setS({ ...s, autoCheckIntervalHours: Number(e.target.value) })}
            className="w-20 rounded bg-slate-900 border border-slate-700 px-2 py-1" />
          hours
        </label>
        <button className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">save</button>
      </form>

      <div className="bg-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="font-bold">Services</h2>
        {services.map(sv => (
          <div key={sv.key} className="flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3 first:border-0 first:pt-0">
            <span className="font-semibold">{sv.name}</span>
            <span className="text-xs text-slate-400">{sv.cookieCount} cookies · {sv.disabled ? 'disabled' : 'enabled'}</span>
            <input placeholder={`proxy override for ${sv.key} (empty = global, direct = no proxy)`}
              defaultValue={sv.proxy ?? ''}
              id={`proxy-${sv.key}`}
              className="flex-1 min-w-48 rounded bg-slate-900 border border-slate-700 px-3 py-1.5 font-mono text-xs" />
            <button onClick={() => patchService(sv.key, { proxy: document.getElementById(`proxy-${sv.key}`).value || null })}
              className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-sm">set proxy</button>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={!sv.disabled}
                onChange={e => patchService(sv.key, { disabled: !e.target.checked })} /> enabled
            </label>
          </div>
        ))}
      </div>

      <form onSubmit={changePw} className="bg-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="font-bold">Change password</h2>
        <input type="password" placeholder="current password" value={pw.currentPassword}
          onChange={e => setPw({ ...pw, currentPassword: e.target.value })}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" required />
        <input type="password" placeholder="new password (8+ chars)" value={pw.newPassword} minLength={8}
          onChange={e => setPw({ ...pw, newPassword: e.target.value })}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2" required />
        <button className="rounded bg-sky-600 hover:bg-sky-500 px-4 py-2 font-semibold">change</button>
      </form>
    </div>
  )
}
