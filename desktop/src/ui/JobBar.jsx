import { Ban } from 'lucide-react'

export default function JobBar({ job, onCancel }) {
  const done = job.done + job.failed
  const pct = job.total ? Math.round((done / job.total) * 100) : 0
  return (
    <div className="px-4 py-2 bg-slate-800/60 border-b border-slate-800 flex items-center gap-3 text-sm">
      <div className="flex-1 h-2 rounded bg-slate-700 overflow-hidden">
        <div className="h-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-400 font-mono">
        {done}/{job.total}{job.failed ? ` · ${job.failed} errors` : ''}{job.current ? ` · ${job.current.slice(0, 8)}…` : ''}
      </span>
      <button onClick={onCancel} className="flex items-center gap-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 px-2 py-1 text-xs">
        <Ban className="w-3 h-3" /> Cancel
      </button>
    </div>
  )
}
