import { Plug, PlugZap } from 'lucide-react'

export default function ConnectBanner({ conn, onDisconnect, disabled }) {
  if (conn.state === 'idle') return null
  const label = conn.state === 'connected' ? 'Connected' : conn.state === 'disconnecting' ? 'Disconnecting…' : 'Connecting…'
  const tone = conn.state === 'connected' ? 'bg-emerald-900/40 border-emerald-800 text-emerald-200' : 'bg-sky-900/40 border-sky-800 text-sky-200'
  return (
    <div className={`flex items-center gap-2 px-4 py-2 text-sm border-b ${tone}`}>
      {conn.state === 'connected' ? <PlugZap className="w-4 h-4" /> : <Plug className="w-4 h-4 animate-pulse" />}
      <span className="font-semibold">{label}</span>
      <span className="font-mono text-xs">{conn.email} · {conn.license ? conn.license.slice(0, 8) + '…' : ''}</span>
      <div className="flex-1" />
      <button onClick={onDisconnect} disabled={disabled || conn.state !== 'connected'}
        className="rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 px-3 py-1 text-xs font-semibold">Disconnect</button>
    </div>
  )
}
