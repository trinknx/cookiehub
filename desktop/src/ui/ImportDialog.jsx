import { useState } from 'react'
import { X } from 'lucide-react'

export default function ImportDialog({ onClose, onDone }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const r = await window.xvpn.accountsImport(text)
      onDone(r)
      onClose()
    } catch (e) { setError(e?.message || String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-slate-800 rounded-xl p-5 w-full max-w-2xl space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Import licenses</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-700"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-slate-400">Paste vault lines (email:password | … | License=…). Junk lines are skipped; duplicates by license update in place.</p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={12} autoFocus
          className="w-full rounded-lg bg-slate-900 border border-slate-700 p-3 font-mono text-xs" placeholder="email:password | Plan=1mo | License=EXXXX…" />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm hover:bg-slate-700">Cancel</button>
          <button onClick={submit} disabled={busy || !text.trim()} className="rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white">
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
