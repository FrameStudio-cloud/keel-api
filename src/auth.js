import { supabase } from './db.js'

/**
 * Site identity for client-facing sites (mini-catalogues, storefront templates).
 *
 * A site presents a per-shop token in `x-keel-site-token`. The token is the ONLY
 * source of shop identity: whatever `shop_id` a caller sends in the query string
 * is ignored. That is what stops one shop from reading another shop's data.
 *
 * Token types:
 *   read_token   -> GET only
 *   write_token  -> GET + POST
 *
 * Fallback for sites that have not been migrated yet: if NO token is presented we
 * try to identify the shop from the request's Origin/Referer hostname matched
 * against the shop's registered website_url. That is tenant-safe (a caller can
 * only ever resolve the shop that owns the hostname it came from) and lets us
 * roll out without an outage. It never honours a client-supplied shop_id.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function tokenFrom(c) {
  return (
    c.req.header('x-keel-site-token') ||
    c.req.header('x-keel-token') ||
    c.req.query('site_token') ||
    ''
  )
}

async function resolveByToken(token) {
  const { data, error } = await supabase.rpc('resolve_site_token', {
    p_token: token,
  })
  if (error) {
    console.error('[auth] resolve_site_token failed:', error.message)
    return null
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return { shopId: row.shop_id, canWrite: row.can_write === true }
}

async function hostnameOf(c) {
  const candidates = [
    c.req.header('origin'),
    c.req.header('referer'),
  ]
  for (const raw of candidates) {
    if (!raw) continue
    try {
      const host = new URL(raw).hostname
      // localhost / preview deploys can't match a registered website_url
      if (host && host !== 'localhost' && !host.endsWith('.local')) return host
    } catch {
      // not a URL, ignore
    }
  }
  return null
}

/**
 * Fallback identification for unmigrated sites: match the caller's hostname
 * against the website_url the shop registered in Keel. Only ever returns the
 * shop that owns that hostname.
 */
async function resolveByHostname(host) {
  const { data, error } = await supabase
    .from('store_settings')
    .select('shop_id')
    .ilike('website_url', `%${host}%`)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[auth] hostname lookup failed:', error.message)
    return null
  }
  if (!data) return null
  return { shopId: data.shop_id, canWrite: false }
}

/** In-memory fixed-window rate limiter, keyed by token. */
const buckets = new Map()

function rateLimit(key, max, windowMs) {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now - b.start > windowMs) {
    buckets.set(key, { start: now, count: 1 })
    return true
  }
  b.count += 1
  return b.count <= max
}

// keep the map from growing without bound
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of buckets) if (now - v.start > 60_000) buckets.delete(k)
}, 60_000).unref?.()

export function siteAuth({ write = { max: 60, windowMs: 60_000 } } = {}) {
  return async (c, next) => {
    if (c.req.path === '/') return next()

    const token = tokenFrom(c)
    let identity = null

    if (token) {
      identity = await resolveByToken(token)
      if (!identity) {
        return c.json({ error: 'Invalid or revoked site token' }, 401)
      }
      if (!identity.canWrite && !rateLimit(`w:${token}`, write.max, write.windowMs)) {
        return c.json({ error: 'Too many requests' }, 429)
      }
    } else {
      const host = await hostnameOf(c)
      if (host) identity = await resolveByHostname(host)
      if (!identity) {
        return c.json(
          {
            error:
              'Missing site token. Pass x-keel-site-token, or serve this request from a hostname registered as a shop website_url.',
          },
          401
        )
      }
    }

    c.set('shopId', identity.shopId)
    c.set('canWrite', identity.canWrite)
    c.set('viaToken', Boolean(token))

    if (WRITE_METHODS.has(c.req.method) && !identity.canWrite) {
      return c.json({ error: 'This endpoint requires a write token' }, 403)
    }

    // best-effort last-used stamp; never block the response on it
    if (token) {
      supabase.rpc('touch_site_token', { p_token: token }).then(
        () => {},
        () => {}
      )
    }

    await next()
  }
}

/** Convenience accessor so routes stop trusting c.req.query('shop_id'). */
export function shopIdOf(c) {
  const id = c.get('shopId')
  if (!id) throw new Error('shopId missing from context — is siteAuth() mounted?')
  return id
}
