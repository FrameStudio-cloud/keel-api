import { Hono } from 'hono'

export const manifestRoutes = new Hono()

manifestRoutes.get('/', async (c) => {
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url is required' }, 400)

  try {
    new URL(url)
  } catch {
    return c.json({ error: 'Invalid URL' }, 400)
  }

  try {
    const manifestUrl = `${url.replace(/\/$/, '')}/keel-manifest.json`
    const res = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return c.json({ error: 'Manifest not found', status: res.status }, 404)
    const manifest = await res.json()
    return c.json(manifest)
  } catch (err) {
    return c.json({ error: 'Failed to fetch manifest', detail: err.message }, 502)
  }
})
