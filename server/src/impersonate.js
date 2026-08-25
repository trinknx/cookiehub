import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// One-shot python runner for the curl_imp.py helper script. The request (url,
// headers, proxy, timeout) travels on stdin as JSON so secrets like the cookie
// header never appear in argv / process listings; stdout carries {status, body}.
const SCRIPT = fileURLToPath(new URL('./curl_imp.py', import.meta.url))
const REQUEST_TIMEOUT_MS = 12000 // curl_cffi per-request deadline (a bit under the engine's 15s)
const CHILD_TIMEOUT_MS = 20000 // hard kill deadline for the whole subprocess
const PROBE_TIMEOUT_MS = 8000

// Node's builtin module namespace is frozen (vi.mock/vi.spyOn cannot
// intercept it), so tests swap the spawner through this seam.
let execFileImpl = execFile
export const _setExecFile = fn => { execFileImpl = fn; pyBin = null }

// Cache the interpreter that has curl_cffi: 'python' | 'python3' | false (none).
// False is sticky for the process lifetime — install python + restart to retry.
let pyBin = null
export const _resetPythonProbe = () => { pyBin = null }

const execPy = (bin, request) => new Promise((resolve, reject) => {
  const child = execFileImpl(bin, [SCRIPT], { timeout: CHILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, stdout, stderr) => {
    if (e) {
      // killed: timeout / spawn failure / non-zero exit — stderr tail carries the python traceback
      const tail = stderr.trim().slice(-300)
      reject(new Error(`${e.message}${tail ? `: ${tail}` : ''}`))
      return
    }
    resolve(stdout)
  })
  // child may die before reading stdin — swallow EPIPE so the callback error path runs
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(request))
})

async function findPython() {
  if (pyBin !== null) return pyBin
  for (const bin of ['python', 'python3']) {
    try {
      await new Promise((resolve, reject) => {
        const c = execFileImpl(bin, ['-c', 'import curl_cffi'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, e => e ? reject(e) : resolve())
        c.stdin.end()
      })
      pyBin = bin
      return bin
    } catch { /* try the next interpreter name */ }
  }
  pyBin = false
  return false
}

// Chrome-impersonated GET (curl_cffi). Needed for sites behind a Cloudflare
// browser challenge — chatgpt.com 403-challenges Node TLS fingerprints (undici,
// node:http2) regardless of cookie validity (verified 2026-08-25). Proxy must
// be an http(s):// or socks5(h):// URL — the same formats the app validates.
// Returns { status, body }; throws on subprocess/transport failure.
export async function impFetch(url, { headers, proxy, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const bin = await findPython()
  if (!bin) throw new Error('impersonation unavailable: python with curl_cffi not installed')
  const out = await execPy(bin, { url, headers, proxy: proxy || null, timeout })
  let parsed
  try { parsed = JSON.parse(out) } catch { throw new Error(`helper returned non-JSON output: ${out.slice(0, 120)}`) }
  if (typeof parsed?.status !== 'number' || typeof parsed?.body !== 'string') throw new Error('helper returned malformed response')
  return parsed
}
