import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function Login() {
  const [session, setSession] = useState(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const nav = useNavigate()

  const loadSession = () => api('/auth/session').then(setSession).catch(e => { setError(e.message); setFailed(true) })
  useEffect(() => { loadSession() }, [])

  const submit = async e => {
    e.preventDefault(); setError('')
    if (!session) return
    if (session.needsSetup && pw !== pw2) return setError('passwords do not match')
    setBusy(true)
    try {
      await api(`/auth/${session.needsSetup ? 'setup' : 'login'}`, { method: 'POST', body: { password: pw } })
      nav('/')
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  if (!session && failed) return (
    <div className="min-h-screen grid place-items-center">
      <div className="w-80 space-y-4 bg-slate-800 p-8 rounded-xl shadow-lg text-center">
        <p className="text-red-400 text-sm">{error}</p>
        <button onClick={() => { setFailed(false); setError(''); loadSession() }}
          className="w-full rounded bg-sky-600 hover:bg-sky-500 py-2 font-semibold">Retry</button>
      </div>
    </div>
  )

  if (!session) return <div className="min-h-screen grid place-items-center text-slate-400">loading…</div>
  return (
    <div className="min-h-screen grid place-items-center">
      <form onSubmit={submit} className="w-80 space-y-4 bg-slate-800 p-8 rounded-xl shadow-lg">
        <h1 className="text-2xl font-bold text-center">CookieHub</h1>
        <p className="text-sm text-slate-400 text-center">{session.needsSetup ? 'First run — create your password' : 'Sign in'}</p>
        <input type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:border-sky-500" required minLength={8} />
        {session.needsSetup && (
          <input type="password" placeholder="Confirm password" value={pw2} onChange={e => setPw2(e.target.value)}
            className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 focus:outline-none focus:border-sky-500" required minLength={8} />
        )}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button disabled={busy} className="w-full rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 py-2 font-semibold">
          {busy ? '…' : session.needsSetup ? 'Create password' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
