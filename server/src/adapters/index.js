import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function loadAdapters(dir = fileURLToPath(new URL('.', import.meta.url))) {
  const map = new Map()
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.js') || f === 'index.js') continue
    const mod = await import(pathToFileURL(path.join(dir, f)).href)
    const a = mod.default ?? mod
    if (!(typeof a.key === 'string' && a.key) || !(typeof a.name === 'string' && a.name) ||
        !(typeof a.defaultDomain === 'string' && a.defaultDomain) || typeof a.check !== 'function') {
      throw new Error(`invalid adapter ${f}: needs key, name, defaultDomain, check()`)
    }
    if (map.has(a.key)) throw new Error(`duplicate adapter key ${a.key} (${f})`)
    map.set(a.key, a)
  }
  return map
}
