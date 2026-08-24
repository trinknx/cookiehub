export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  // only a missing/expired session kicks the user to /login — a 401 with a different
  // code (e.g. bad_credentials on password change) is a form error, not a logout
  if (res.status === 401 && json?.error?.code === 'unauthenticated' && !location.pathname.startsWith('/login')) {
    location.href = '/login'
    throw new Error('unauthenticated')
  }
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`)
  return json
}
