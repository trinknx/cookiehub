import { describe, it, expect, vi, beforeEach } from 'vitest'
import { impFetch, _setExecFile } from '../src/impersonate.js'

// Node's builtin namespace is frozen, so vi.mock/vi.spyOn cannot intercept
// child_process — the module exposes _setExecFile as the injection seam.
let execFile

// child stub: captures stdin, invokes the execFile callback per test case
const fakeChild = (onRun, result) => {
  const stdin = { on: () => {}, end: chunk => { if (chunk != null) onRun(JSON.parse(chunk.toString())) } } // probe end() carries no chunk
  queueMicrotask(() => result(stdin))
  return { stdin } // caller expects a child object exposing .stdin
}
const plainChild = () => ({ stdin: { on: () => {}, end: () => {} } })

describe('impersonate bridge', () => {
  beforeEach(() => { execFile = vi.fn(); _setExecFile(execFile) })

  it('finds python with curl_cffi, sends the request on stdin, returns {status, body}', async () => {
    let sent = null
    execFile.mockImplementation((bin, args, opts, cb) =>
      fakeChild(req => { sent = { bin, args, req } }, stdin =>
        cb(null, JSON.stringify({ status: 200, body: '{"user":{}}' }))))
    const r = await impFetch('https://example.com/', { headers: { cookie: 'a=b' }, proxy: 'socks5://h:1' })
    expect(r).toEqual({ status: 200, body: '{"user":{}}' })
    // secrets ride stdin, never argv
    expect(sent.bin).toBe('python')
    expect(sent.args[0]).toMatch(/curl_imp\.py$/)
    expect(sent.req).toEqual({ url: 'https://example.com/', headers: { cookie: 'a=b' }, proxy: 'socks5://h:1', timeout: 12000 })
  })

  it('python without curl_cffi falls through to python3', async () => {
    execFile.mockImplementation((bin, args, _o, cb) => {
      if (args[0] === '-c') return fakeChild(() => {}, stdin => cb(bin === 'python' ? new Error('ModuleNotFoundError') : null))
      return fakeChild(() => {}, stdin => cb(null, JSON.stringify({ status: 200, body: 'ok' })))
    })
    const r = await impFetch('https://example.com/', {})
    expect(r.status).toBe(200)
    expect(execFile.mock.calls.map(c => c[0])).toEqual(['python', 'python3', 'python3'])
  })

  it('caches the interpreter probe across calls', async () => {
    execFile.mockImplementation((bin, args, _o, cb) =>
      fakeChild(() => {}, stdin => cb(null, args[0] === '-c' ? '' : JSON.stringify({ status: 200, body: 'ok' }))))
    await impFetch('https://example.com/')
    await impFetch('https://example.com/')
    // one probe + two helper runs, not a probe per call
    expect(execFile.mock.calls.filter(c => c[1][0] === '-c')).toHaveLength(1)
  })

  it('no interpreter available → throws without spawning the helper', async () => {
    execFile.mockImplementation((_b, _a, _o, cb) => fakeChild(() => {}, stdin => cb(new Error('ENOENT'))))
    await expect(impFetch('https://example.com/')).rejects.toThrow('impersonation unavailable')
    // every execFile call was an interpreter probe, none ran the helper script
    expect(execFile.mock.calls.every(c => c[1][0] === '-c')).toBe(true)
  })

  it('helper non-zero exit surfaces the stderr tail', async () => {
    execFile.mockImplementation((bin, args, _o, cb) => {
      if (args[0] === '-c') return fakeChild(() => {}, stdin => cb(null)) // probe fine, helper fails
      const e = new Error('Command failed'); e.killed = true
      queueMicrotask(() => cb(e, '', 'Traceback … curl_cffi.requests.errors.Timeout'))
      return plainChild()
    })
    await expect(impFetch('https://example.com/')).rejects.toThrow('Timeout')
  })

  it('malformed helper output → throws', async () => {
    execFile.mockImplementation((_b, _a, _o, cb) => {
      queueMicrotask(() => cb(null, 'not json'))
      return plainChild()
    })
    await expect(impFetch('https://example.com/')).rejects.toThrow('non-JSON')
  })
})
