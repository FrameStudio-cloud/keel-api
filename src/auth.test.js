import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The identity gate.
 *
 * This file had no tests at all before 30 Sep 2026, which is why the following
 * shipped and ran for a month:
 *
 *   - a shop's `paystack_subaccount_code`, phone, address and owner email were
 *     readable by anyone who could send an `Origin` header, with no credential;
 *   - `GET /api/chat/messages` had no shop filter at all;
 *   - three POST routes wrote `body.shop_id` straight into a row;
 *   - the rate limit guarded read tokens with the WRITE budget and left write
 *     tokens unlimited.
 *
 * Every test here is one of those, pinned. The rule they share: a request header
 * is not a credential, and a token is the only thing that identifies a shop.
 *
 * The supabase client is stubbed at the module boundary so the real database is
 * never touched, and so a token can be made to resolve or fail on demand.
 */

const resolveSiteToken = vi.fn()
const touchSiteToken = vi.fn()

vi.mock('./db.js', () => ({
  supabase: {
    rpc: (...args) => {
      const [name] = args
      if (name === 'resolve_site_token') return resolveSiteToken(...args)
      if (name === 'touch_site_token') return touchSiteToken(...args)
      return Promise.resolve({ data: null, error: null })
    },
  },
}))

const { siteAuth, shopIdOf } = await import('./auth.js')

const SHOP_A = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'
const SHOP_B = '11111111-2222-3333-4444-555555555555'

/** A minimal Hono-shaped context. Only what siteAuth actually touches. */
function ctx({ method = 'GET', path = '/api/shop', headers = {}, query = {}, store = new Map() }) {
  return {
    req: {
      method,
      path,
      header: (name) => headers[String(name).toLowerCase()],
      query: (name) => query[name],
    },
    json: (body, status) => ({ __response: true, body, status }),
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
  }
}

/** Runs the middleware and reports what it decided. */
async function run(c) {
  let reachedNext = false
  const result = await siteAuth()(c, async () => {
    reachedNext = true
  })
  return { response: result, reachedNext, store: c.req.__store }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: a read token for shop A. Individual tests override.
  resolveSiteToken.mockResolvedValue({ data: { shop_id: SHOP_A, can_write: false }, error: null })
  touchSiteToken.mockResolvedValue({ data: null, error: null })
})

describe('a request with no token is never identified with a shop', () => {
  // THE regression. The old code fell back to matching the Origin/Referer
  // hostname against store_settings.website_url with a substring match, which
  // meant `Origin: https://vercel.app` authenticated as a shop registered at
  // kikoi-opal.vercel.app. Verified live: GET /api/settings returned 34 columns
  // including paystack_subaccount_code, with no credential of any kind.
  it('rejects a forged Origin header outright', async () => {
    const c = ctx({ headers: { origin: 'https://kikoi-opal.vercel.app' } })
    const { response, reachedNext } = await run(c)

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/Missing site token/)
  })

  it('rejects a forged Referer header too', async () => {
    const c = ctx({ headers: { referer: 'https://kikoi-opal.vercel.app/' } })
    const { response, reachedNext } = await run(c)

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(401)
  })

  // The substring amplification specifically: a shared platform host must not
  // authorise a shop on that platform.
  it('rejects a bare platform host that the old substring match would have accepted', async () => {
    const c = ctx({ headers: { origin: 'https://vercel.app' } })
    const { response, reachedNext } = await run(c)

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(401)
  })

  it('does not query the database for an uncredentialed request', async () => {
    await run(ctx({ headers: { origin: 'https://kikoi-opal.vercel.app' } }))
    // resolve_site_token is the only lookup that could leak a shop_id, and a
    // tokenless request should not reach it at all.
    expect(resolveSiteToken).not.toHaveBeenCalled()
  })

  it('never sets shopId, so shopIdOf() cannot hand a route a tenant', async () => {
    const c = ctx({ headers: { origin: 'https://kikoi-opal.vercel.app' } })
    await run(c)
    expect(() => shopIdOf(c)).toThrow(/shopId missing/)
  })
})

describe('a token identifies exactly one shop', () => {
  it('resolves the token to its own shop and puts it in context', async () => {
    const store = new Map()
    const c = ctx({ headers: { 'x-keel-site-token': 'read-a' }, store })
    const { reachedNext } = await run(c)

    expect(reachedNext).toBe(true)
    expect(shopIdOf(c)).toBe(SHOP_A)
    expect(c.get('shopId')).toBe(SHOP_A)
  })

  it('accepts the x-keel-token alias', async () => {
    const store = new Map()
    const c = ctx({ headers: { 'x-keel-token': 'read-a' }, store })
    const { reachedNext } = await run(c)

    expect(reachedNext).toBe(true)
    expect(shopIdOf(c)).toBe(SHOP_A)
  })

  it('rejects an unknown or revoked token with 401, and never falls back', async () => {
    resolveSiteToken.mockResolvedValue({ data: null, error: null })
    const c = ctx({ headers: { 'x-keel-site-token': 'nope', origin: 'https://kikoi-opal.vercel.app' } })
    const { response, reachedNext } = await run(c)

    // A bad token must be a hard stop. Falling through to the hostname path here
    // would let anyone with a guessable shop_id-shaped value downgrade to a
    // weaker identity check.
    expect(reachedNext).toBe(false)
    expect(response.status).toBe(401)
  })

  it('treats a database error as no identity rather than as trusted', async () => {
    resolveSiteToken.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const c = ctx({ headers: { 'x-keel-site-token': 'read-a' } })
    const { response, reachedNext } = await run(c)

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(401)
  })

  it('only treats a literal true as write authority', async () => {
    // can_write comes from Postgres. Anything that is not exactly `true` - a
    // string, a number, null - must fail closed, or a malformed row would grant
    // write access.
    for (const value of ['true', 1, 't', null, {}]) {
      resolveSiteToken.mockResolvedValue({ data: { shop_id: SHOP_A, can_write: value }, error: null })
      const store = new Map()
      const c = ctx({ method: 'POST', path: '/api/chat/callbacks', headers: { 'x-keel-site-token': 'w' }, store })
      const { response } = await run(c)
      expect(response.status, `can_write=${JSON.stringify(value)}`).toBe(403)
    }
  })
})

describe('write authority', () => {
  it('blocks a write method for a read token', async () => {
    const c = ctx({ method: 'POST', path: '/api/chat/callbacks', headers: { 'x-keel-site-token': 'read-a' } })
    const { response, reachedNext } = await run(c)

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(403)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks %s for a read token', async (method) => {
    const c = ctx({ method, headers: { 'x-keel-site-token': 'read-a' } })
    const { response } = await run(c)
    expect(response.status).toBe(403)
  })

  it('lets a write token through', async () => {
    resolveSiteToken.mockResolvedValue({ data: { shop_id: SHOP_B, can_write: true }, error: null })
    const store = new Map()
    const c = ctx({ method: 'POST', path: '/api/chat/callbacks', headers: { 'x-keel-site-token': 'w' }, store })
    const { reachedNext } = await run(c)

    expect(reachedNext).toBe(true)
    // And it is the WRITE token's own shop, not shop A's.
    expect(shopIdOf(c)).toBe(SHOP_B)
  })

  it('lets a read token through a GET', async () => {
    const c = ctx({ method: 'GET', headers: { 'x-keel-site-token': 'read-a' } })
    const { reachedNext } = await run(c)
    expect(reachedNext).toBe(true)
  })
})

describe('the token is not accepted in the query string', () => {
  // ?site_token= is why a token ends up in access logs, browser history and
  // Referer headers, where it outlives the request that carried it.
  it('ignores site_token in the query', async () => {
    const c = ctx({ query: { site_token: 'read-a' } })
    const { response, reachedNext } = await run(c)

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(401)
  })
})

describe('rate limiting', () => {
  // The old guard was `!identity.canWrite && !rateLimit(..., write.max, ...)`.
  // That applied the WRITE budget to READ tokens and left write tokens with no
  // limit at all - the opposite of what the parameter name and the commit
  // message both claimed.
  it('gives a write token a SMALLER budget than a read token', async () => {
    // The old guard was `!identity.canWrite && !rateLimit(..., write.max, ...)`:
    // it applied the WRITE budget to READ tokens and left write tokens with no
    // limit at all. Both halves are pinned here with explicit budgets, because
    // the default-constructed middleware cannot tell the two apart.
    const auth = siteAuth({
      read: { max: 20, windowMs: 60_000 },
      write: { max: 5, windowMs: 60_000 },
      preAuth: { max: 1000, windowMs: 60_000 },
    })

    const allowedFor = async (canWrite, token) => {
      resolveSiteToken.mockResolvedValue({ data: { shop_id: SHOP_A, can_write: canWrite }, error: null })
      let allowed = 0
      for (let i = 0; i < 30; i++) {
        const c = ctx({
          method: canWrite ? 'POST' : 'GET',
          headers: { 'x-keel-site-token': token },
        })
        const r = await auth(c, async () => {})
        if (!r || r.status !== 429) allowed++
      }
      return allowed
    }

    expect(await allowedFor(false, 'read-shop')).toBe(20)
    // A write credential is held to the tighter limit, because a write loop is
    // what actually costs money.
    expect(await allowedFor(true, 'write-shop')).toBe(5)
  })

  it('bounds a token flood before the database is touched', async () => {
    resolveSiteToken.mockClear()
    // A small preAuth guard, so the test can reach it in a handful of requests.
    const auth = siteAuth({ preAuth: { max: 3, windowMs: 60_000 } })
    let sawRateLimit = false
    for (let i = 0; i < 6; i++) {
      const c = ctx({ headers: { 'x-keel-site-token': 'guessing' } })
      const r = await auth(c, async () => {})
      if (r && r.status === 429) sawRateLimit = true
    }
    expect(sawRateLimit).toBe(true)
    // The flood was cut off before it could hammer the token table.
    expect(resolveSiteToken.mock.calls.length).toBeLessThanOrEqual(3)
  })

  // The preAuth guard is keyed by token, so a VALID token passes through it too
  // - we cannot know validity until after the query. An earlier draft set it to
  // 10/min and silently throttled every legitimate read to 10 requests a
  // minute. This pins that it sits above the per-credential budgets.
  it('never throttles a valid token below its own read budget', async () => {
    const auth = siteAuth({ read: { max: 12, windowMs: 60_000 } })
    resolveSiteToken.mockResolvedValue({ data: { shop_id: SHOP_A, can_write: false }, error: null })
    let allowed = 0
    for (let i = 0; i < 12; i++) {
      const c = ctx({ headers: { 'x-keel-site-token': 'a-valid-shop' } })
      const r = await auth(c, async () => {})
      if (!r || r.status !== 429) allowed++
    }
    expect(allowed).toBe(12)
  })

  it('keeps one shop from exhausting another shop budget', async () => {
    const auth = siteAuth({ read: { max: 2, windowMs: 60_000 } })
    resolveSiteToken.mockResolvedValue({ data: { shop_id: SHOP_A, can_write: false }, error: null })
    for (let i = 0; i < 5; i++) {
      const c = ctx({ headers: { 'x-keel-site-token': 'noisy-shop' } })
      await auth(c, async () => {})
    }
    // A different token has a different bucket, so a second shop is unaffected.
    const c = ctx({ headers: { 'x-keel-site-token': 'quiet-shop' } })
    const r = await auth(c, async () => {})
    expect(r).toBeUndefined()
  })
})

describe('shopIdOf', () => {
  it('reads only the context, never a query or body value', async () => {
    // A client-supplied shop_id cannot reach a route that uses this helper. The
    // old four routes bypassed it and read body.shop_id directly; those are the
    // cases this function exists to prevent.
    const store = new Map()
    const c = ctx({ headers: { 'x-keel-site-token': 'read-a' }, query: { shop_id: SHOP_B }, store })
    await run(c)

    expect(shopIdOf(c)).toBe(SHOP_A)
    expect(shopIdOf(c)).not.toBe(SHOP_B)
  })

  it('throws rather than returning undefined when siteAuth was not mounted', () => {
    expect(() => shopIdOf(ctx({}))).toThrow(/shopId missing/)
  })
})
