#!/usr/bin/env node
/**
 * ExpressVPN batch license checker (CLI wrapper).
 *
 * Core logic lives in xvpnChecker.js next to this file — the CLI is fully
 * self-contained (the webapp's /api/expressvpn feature was removed).
 *
 * Usage:
 *   node tools/expressvpn/check-licenses.mjs [--file accounts.txt] [--delay 1500]
 *                                             [--out-csv report.csv] [--out-json report.json]
 *
 * Input line format (fields after the first are Key=Value, order-free):
 *   email:password | OVPNUser=... | Plan=1mo | Expire=2026-08-30 | Days=6 |
 *   Status=ACTIVE | License=XXXXXXXX... | PPTP=user/pass
 *
 * Output: CSV + JSON reports next to the script, plus a console table.
 * App is left logged out.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAccountLine, metaOf, checkLicense, connectionState, makeCtl, DEFAULT_CTL } from './xvpnChecker.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : def
}
const inputFile = path.resolve(HERE, arg('file', 'accounts.txt'))
const delayMs = Number(arg('delay', 1500))
const outCsv = path.resolve(HERE, arg('out-csv', 'report.csv'))
const outJson = path.resolve(HERE, arg('out-json', 'report.json'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

const COLS = ['email', 'license', 'claimedStatus', 'claimedExpire', 'claimedDays', 'state', 'liveDays', 'liveExpire', 'payment', 'detail']

function loadAccounts(file) {
  if (!existsSync(file)) throw new Error(`input file not found: ${file}`)
  const map = new Map()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const acc = parseAccountLine(line)
    if (acc && !map.has(acc.license)) map.set(acc.license, acc)
  }
  return [...map.values()]
}

const pad = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n) }

function printTable(rows) {
  const widths = Object.fromEntries(COLS.map(c => [c, Math.min(28, Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)))]))
  console.log('\n' + COLS.map(c => pad(c.toUpperCase(), widths[c])).join(' | '))
  console.log(COLS.map(c => '-'.repeat(widths[c])).join('-+-'))
  for (const r of rows) console.log(COLS.map(c => pad(r[c], widths[c])).join(' | '))
}

const csvEscape = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }

async function main() {
  if (!existsSync(DEFAULT_CTL)) {
    console.error(`expressvpnctl not found at ${DEFAULT_CTL} — is ExpressVPN installed?`)
    process.exit(1)
  }
  const connState = await connectionState(makeCtl())
  if (connState !== 'Disconnected') {
    console.error(`VPN state is "${connState}" — disconnect first:`)
    console.error(`  "${DEFAULT_CTL}" disconnect`)
    process.exit(1)
  }

  const accounts = loadAccounts(inputFile)
  console.log(`Loaded ${accounts.length} unique license(s) from ${inputFile}`)
  if (!accounts.length) { console.error('No License= entries found.'); process.exit(1) }

  const rows = []
  let n = 0
  for (const acc of accounts) {
    n++
    const r = await checkLicense(acc.license)
    rows.push({
      email: acc.email, license: acc.license,
      claimedStatus: metaOf(acc).status, claimedExpire: metaOf(acc).expire, claimedDays: metaOf(acc).days,
      state: r.state, liveDays: r.live?.daysRemaining ?? '', liveExpire: r.live?.expireIso ?? '',
      payment: r.live?.payment ?? '', detail: r.detail,
    })
    console.error(
      `[${n}/${accounts.length}] ${acc.license} -> ${r.state}` +
      (r.live ? ` (${r.live.daysRemaining}d left, expires ${r.live.expireIso})` : '') +
      (r.detail ? ` — ${r.detail}` : '')
    )
    if (n < accounts.length) await sleep(delayMs)
  }

  // leave the app logged out — matches the webapp job's end state
  await makeCtl()(['logout'], 30000)

  writeFileSync(outCsv, '\ufeff' + [COLS.join(','), ...rows.map(r => COLS.map(c => csvEscape(r[c])).join(','))].join('\r\n'), 'utf8')
  writeFileSync(outJson, JSON.stringify({ generatedAt: new Date().toISOString(), input: inputFile, results: rows }, null, 2), 'utf8')
  printTable(rows)

  const counts = rows.reduce((m, r) => ((m[r.state] = (m[r.state] || 0) + 1), m), {})
  console.log(`\nSummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`Reports: ${outCsv}\n         ${outJson}`)
  console.log('App left logged out.')
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })
