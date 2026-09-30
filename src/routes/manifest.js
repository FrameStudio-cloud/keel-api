import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const manifestRoutes = new Hono()

/**
 * Fetch a storefront's own keel-manifest.json.
 *
 * The only legitimate caller is a site fetching its own manifest, so the URL is
 * not taken from the request at all. The caller is identified by its token; we
 * read that shop's registered website_url and fetch *that*, and the `url`
 * parameter - which some clients still send - is accepted only if it names the
 * same origin.
 *
 * This route used to fetch any URL supplied in `?url=`. `new URL(url)` only
 * checks that the string parses, and the forced `/keel-manifest.json` suffix
 * constrains the path but not the host, so it was an SSRF primitive. Verified
 * live: `?url=http://localhost:3001` reached this same service and returned a
 * real 404 from it, which is enough to confirm internal reachability and to
 * port-scan the private network by distinguishing 404 from 502.
 *
 * The suffix was never the defence. It bounded *what* could be read, not *where
 * from*.
 */
manifestRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)
  const requested = c.req.query('url')

  if (requested) {
    let parsed
    try {
      parsed = new URL(requested)
    } catch {
      return c.json({ error: 'Invalid URL' }, 400)
    }
    // A storefront's manifest is always served over TLS, so refusing plaintext
    // costs nothing and removes the internal-http reach.
    if (parsed.protocol !== 'https:') {
      return c.json({ error: 'Only https manifests are supported' }, 400)
    }
  }

  // The fetch target is derived from the REGISTERED origin, never from caller
  // input, so no crafted path or host can redirect the request.
  const { data: settings, error: settingsError } = await supabase
    .from('store_settings')
    .select('website_url')
    .eq('shop_id', shopId)
    .maybeSingle()
  if (settingsError) return c.json({ error: settingsError.message }, 500)

  const registered = settings?.website_url
  if (!registered) return c.json({ error: 'No registered website for this shop' }, 404)

  let origin
  let registeredHost
  try {
    const parsed = new URL(registered)
    origin = parsed.origin
    registeredHost = parsed.hostname
  } catch {
    return c.json({ error: 'Registered website_url is unusable' }, 500)
  }

  // Exact host equality, never a substring. `.includes('vercel.app')` is how one
  // shared platform host would authorise every shop hosted on it.
  if (requested) {
    const parsed = new URL(requested)
    if (parsed.hostname !== registeredHost) {
      return c.json({ error: 'url host does not match this shop' }, 403)
    }
  }

  try {
    const res = await fetch(`${origin}/keel-manifest.json`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    })
    if (!res.ok) return c.json({ error: 'Manifest not found', status: res.status }, 404)
    return c.json(await res.json())
  } catch (err) {
    return c.json({ error: 'Failed to fetch manifest', detail: err.message }, 502)
  }
})
