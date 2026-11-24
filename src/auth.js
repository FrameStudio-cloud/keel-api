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
 * There is deliberately no fallback. An earlier version identified the shop from
 * the request's Origin/Referer hostname when no token was presented, matched with
 * `.ilike('website_url', '%host%')`, and called that tenant-safe. It was not:
 *
 *   1. Origin and Referer are ordinary request headers. `curl -H "Origin:
 *      https://kikoi-opal.vercel.app"` sets one, so a browser convention was being
 *      used as an authentication control.
 *   2. The match was a substring test, so `Origin: https://vercel.app` also
 *      resolved a shop registered at `kikoi-opal.vercel.app`.
 *
 * Verified live before removal: with a forged Origin header and no credential of
 * any kind, `GET /api/settings` returned a real tenant's `paystack_subaccount_code`,
 * `paystack_subaccount.bank_name`, `store_phone`, `store_address` and the owner's
 * email from `notification_preferences`. Every read route leaked. This is why the
 * rule is "a token, or nothing": the token is a secret the caller has to possess,
 * and a request header is not.
 *
 * Both storefronts with a registered website_url hold an active token, so the
 * migration path is issuing one and setting it in the site's build.
 */

/**
 * The HTTP verbs that carry a body. Kept for the scope map's readability; routing
 * no longer keys authority off the verb — see the note in the middleware.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Reads, for requiredScope(). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/**
 * What each route is FOR.
 *
 * A token used to be one boolean, so a credential that ships in a storefront's
 * public JavaScript could do everything this API can do — write fake analytics
 * with a token issued for a catalogue, or spend an LLM budget with one issued
 * for analytics. A scope makes the credential's purpose explicit, so a leak
 * costs one capability instead of all of them.
 *
 * Reads need `read`. Every write is listed here, matched on the path.
 */
const SCOPE_RULES = [
  [/^\/api\/events(\/|$)/, 'analytics'],
  [/^\/api\/page-views(\/|$)/, 'analytics'],
  [/^\/api\/chat\/callbacks(\/|$)/, 'inquiry'],
  [/^\/api\/chat\/stock-alerts(\/|$)/, 'inquiry'],
  // The assistant is a customer conversation answered on the shop's behalf, so it
  // shares the customer-input scope. It has no caller today; if a public widget
  // becomes real, give it its own scope and a monthly allowance rather than
  // widening this one.
  [/^\/api\/chat\/answer(\/|$)/, 'inquiry'],
  [/^\/api\/inquiries(\/|$)/, 'inquiry'],
  [/^\/api\/orders(\/|$)/, 'order'],
]

/**
 * The scope a request needs, or null when no rule covers it.
 *
 * Exported so it can be tested without a database, and so a refusal can name the
 * scope instead of saying "forbidden".
 *
 * A null return is a FAILURE, not a pass: an unmapped write must not be
 * reachable by every write token just because somebody added a route and forgot
 * to scope it. Failing closed here turns that into a 403 with a message saying
 * what to edit, which is how the omission gets noticed.
 */
export function requiredScope(method, path) {
  if (READ_METHODS.has(method)) return 'read'
  for (const [pattern, scope] of SCOPE_RULES) {
    if (pattern.test(path)) return scope
  }
  return null
}

/**
 * The token is read from headers only.
 *
 * `?site_token=` used to be accepted, which is the reason a token ends up in
 * access logs, browser history and Referer headers. If a storefront still sends
 * it there, it fails with a 401 that says exactly what to do instead.
 */
function tokenFrom(c) {
  return c.req.header('x-keel-site-token') || c.req.header('x-keel-token') || ''
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
  // siteId is null for a shop-level token. That is not an error: those still work,
  // they just leave attribution to the single-active-site fallback in events.js.
  //
  // `scopes` arrived on 24 Nov 2026. Code deployed against a database that
  // predates that migration gets no `scopes` at all, and an empty list would 403
  // every read — so a missing value falls back to the legacy split rather than
  // to nothing. Absent is not the same as empty.
  const scopes = Array.isArray(row.scopes)
    ? row.scopes
    : row.can_write === true
      ? ['read', 'analytics', 'inquiry']
      : ['read']

  return {
    shopId: row.shop_id,
    siteId: row.site_id ?? null,
    canWrite: row.can_write === true,
    scopes,
  }
}

/**
 * In-memory fixed-window rate limiter.
 *
 * Keyed by the presented token, so one shop's traffic can never exhaust another's
 * budget.
 */
const buckets = new Map()

/**
 * Exported because the Groq routes budget per-request spend (an LLM call is the
 * only thing on this API that costs money per request) and should use this
 * limiter rather than grow a second implementation of the same window.
 *
 * Reminder: in-memory, therefore per replica. See AGENTS.md, "Rate limiting".
 */
export function rateLimit(key, max, windowMs) {
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

/**
 * @param {object} [opts]
 * @param {{max:number,windowMs:number}} [opts.read]    budget for a read token
 * @param {{max:number,windowMs:number}} [opts.write]   budget for a write token
 * @param {{max:number,windowMs:number}} [opts.preAuth] DoS guard on the token table
 */
export function siteAuth({
  read = { max: 120, windowMs: 60_000 },
  write = { max: 60, windowMs: 60_000 },
  preAuth = { max: 300, windowMs: 60_000 },
} = {}) {
  return async (c, next) => {
    const token = tokenFrom(c)
    let identity = null

    if (token) {
      // Bound the cost of a token flood BEFORE any database work, so guessing
      // cannot be used to hammer resolve_site_token.
      //
      // This bucket is keyed by token, which means a VALID token passes through
      // it too - we cannot know validity until we have queried. So it is a DoS
      // guard, not a client budget, and it is deliberately set well above
      // `read`/`write`. An earlier draft used a small value here (10/min) and
      // silently throttled every legitimate read to 10 requests a minute, because
      // a test asserting "read tokens are limited" could not tell the two
      // buckets apart.
      if (!rateLimit(`a:${token}`, preAuth.max, preAuth.windowMs)) {
        return c.json({ error: 'Too many requests' }, 429)
      }
      identity = await resolveByToken(token)
      if (!identity) {
        return c.json({ error: 'Invalid or revoked site token' }, 401)
      }
      // The budget follows the credential's authority. This was previously
      // `!identity.canWrite && !rateLimit(...)`, which applied the WRITE budget
      // to READ tokens and left write tokens entirely unlimited - the guard
      // contradicted both the parameter name and the commit message.
      const budget = identity.canWrite ? write : read
      if (!rateLimit(`w:${token}`, budget.max, budget.windowMs)) {
        return c.json({ error: 'Too many requests' }, 429)
      }
    } else {
      return c.json(
        {
          error:
            'Missing site token. Pass x-keel-site-token. Tokens are issued per storefront; a request with no token is not identified with a shop.',
        },
        401
      )
    }

    c.set('shopId', identity.shopId)
    c.set('siteId', identity.siteId)
    c.set('canWrite', identity.canWrite)
    c.set('scopes', identity.scopes)
    c.set('viaToken', true)

    // ⚠️ THERE IS NO "POST NEEDS A WRITE TOKEN" GATE HERE, AND REMOVING IT IS THE
    // POINT OF SCOPES.
    //
    // It used to read `WRITE_METHODS.has(method) && !canWrite -> 403`, which meant a
    // PUBLISHABLE key could not POST anything — including the analytics event and
    // the inquiry it is explicitly scoped for. The only way to send either from a
    // browser was to ship the SECRET key, which is the one thing this whole model
    // exists to avoid.
    //
    // Authority is now the scope list alone: a publishable token carries
    // read|analytics|inquiry and does exactly those; `order` is what still needs the
    // secret. `can_write` stays on the context for compatibility, but routing no
    // longer reads it — two gates for one decision is how a guard stops being
    // testable.
    const needed = requiredScope(c.req.method, c.req.path)
    if (needed === null) {
      return c.json(
        {
          error:
            'This endpoint has no scope rule, so a site token cannot write to it. ' +
            'Add it to SCOPE_RULES in auth.js rather than widening a scope.',
        },
        403
      )
    }
    if (!identity.scopes.includes(needed)) {
      return c.json({ error: `This endpoint requires the ${needed} scope` }, 403)
    }

    // best-effort last-used stamp; never block the response on it
    supabase.rpc('touch_site_token', { p_token: token }).then(
      () => {},
      () => {}
    )

    await next()
  }
}

/** Convenience accessor so routes stop trusting c.req.query('shop_id'). */
export function shopIdOf(c) {
  const id = c.get('shopId')
  if (!id) throw new Error('shopId missing from context — is siteAuth() mounted?')
  return id
}

/**
 * Which storefront presented the token, or null.
 *
 * Deliberately does NOT throw when absent, unlike shopIdOf. A null siteId is a
 * legitimate state meaning "shop-level token" - the shop is still known, only the
 * storefront is not. Throwing here would turn a supported configuration into a 500
 * on the routes that accept it.
 *
 * Server-resolved from the token, so it is never a client claim.
 */
export function siteIdOf(c) {
  return c.get('siteId') ?? null
}
