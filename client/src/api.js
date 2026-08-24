export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login'
    throw new Error('unauthenticated')
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`)
  return json
}
