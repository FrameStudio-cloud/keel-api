import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Scopes: what a site credential is FOR.
 *
 * A token used to be one boolean (`can_write`), so a string that ships in a
 * storefront's public JavaScript reached every write route on this API — fake
 * analytics, fake callbacks, an LLM budget. A scope makes the limit explicit at
 * the route, so a leaked publishable key costs one capability rather than all of
 * them.
 *
 * Two properties matter more than any individual rule:
 *
 *   1. Reads need `read`. A credential without it is not a reader.
 *   2. An UNMAPPED write fails closed. The safe default for a new endpoint is
 *      "nobody", because the failure is a 403 that names the omission instead of
 *      a route every write token can reach.
 */

const resolveSiteToken = vi.fn()

vi.mock('./db.js', () => ({
  supabase: {
    rpc: (name) => {
      if (name === 'resolve_site_token') return resolveSiteToken()
      return Promise.resolve({ data: null, error: null })
    },
  },
}))

const { siteAuth, requiredScope } = await import('./auth.js')

const SHOP = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'
const SITE = '22222222-3333-4444-5555-666666666666'

function ctx({ method = 'GET', path = '/api/shop', token = 'tok' } = {}) {
  const store = new Map()
  return {
    req: {
      method,
      path,
      header: (name) =>
        String(name).toLowerCase() === 'x-keel-site-token' ? token : undefined,
      query: () => undefined,
    },
    json: (body, status) => ({ body, status }),
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
  }
}

async function run(c) {
  let reachedNext = false
  const response = await siteAuth()(c, async () => {
    reachedNext = true
  })
  return { response, reachedNext, scopes: c.get('scopes') }
}

/** A token row as the database now returns it. */
function token({ scopes, canWrite = true, withScopes = true }) {
  const row = { shop_id: SHOP, site_id: SITE, can_write: canWrite }
  if (withScopes) row.scopes = scopes
  resolveSiteToken.mockResolvedValue({ data: row, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('which scope a request needs', () => {
  it.each([
    ['GET', '/api/shop', 'read'],
    ['HEAD', '/api/catalogue', 'read'],
    ['OPTIONS', '/api/shop', 'read'],
    ['POST', '/api/events', 'analytics'],
    ['POST', '/api/page-views', 'analytics'],
    ['POST', '/api/chat/callbacks', 'inquiry'],
    ['POST', '/api/chat/stock-alerts', 'inquiry'],
    ['POST', '/api/chat/answer', 'inquiry'],
    ['POST', '/api/inquiries', 'inquiry'],
    ['POST', '/api/orders', 'order'],
  ])('%s %s requires %s', (method, path, expected) => {
    expect(requiredScope(method, path)).toBe(expected)
  })

  // The rule that keeps a new endpoint safe. Returning null is what turns an
  // unscoped route into a 403 instead of a route any write token can reach.
  it('returns null for a write with no rule', () => {
    expect(requiredScope('POST', '/api/something-new')).toBeNull()
  })
})

describe('the gate applies the scope', () => {
  it('lets a read+analytics token report an event', async () => {
    token({ scopes: ['read', 'analytics'] })
    const { reachedNext } = await run(ctx({ method: 'POST', path: '/api/events' }))
    expect(reachedNext).toBe(true)
  })

  it('refuses analytics on a route that needs inquiry', async () => {
    token({ scopes: ['read', 'analytics'] })
    const { response, reachedNext } = await run(
      ctx({ method: 'POST', path: '/api/chat/callbacks' })
    )

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(403)
    // The message names the scope, so the fix is obvious rather than a mystery.
    expect(response.body.error).toMatch(/inquiry/)
  })

  it('refuses an unmapped write even for a broadly scoped token', async () => {
    token({ scopes: ['read', 'analytics', 'inquiry', 'order'] })
    const { response, reachedNext } = await run(
      ctx({ method: 'POST', path: '/api/something-new' })
    )

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(403)
    expect(response.body.error).toMatch(/scope rule/)
  })

  // A credential with no `read` is not a reader. Without this, a token issued
  // only to report analytics would still be able to read the whole catalogue.
  it('refuses a read without the read scope', async () => {
    token({ scopes: ['analytics'] })
    const { response, reachedNext } = await run(ctx({ method: 'GET', path: '/api/shop' }))

    expect(reachedNext).toBe(false)
    expect(response.status).toBe(403)
    expect(response.body.error).toMatch(/read/)
  })

  it('puts the scopes on the context for routes that need them', async () => {
    token({ scopes: ['read', 'inquiry'] })
    const { scopes } = await run(ctx({ method: 'GET', path: '/api/shop' }))
    expect(scopes).toEqual(['read', 'inquiry'])
  })

  // Deployment order is not guaranteed: new code can face a database that has
  // not run the scopes migration. An absent `scopes` must fall back to the
  // legacy split, not to an empty list that 403s every read.
  it('falls back to the legacy scopes when the column is absent', async () => {
    token({ withScopes: false, canWrite: true })
    const event = await run(ctx({ method: 'POST', path: '/api/events' }))
    expect(event.reachedNext).toBe(true)

    token({ withScopes: false, canWrite: false })
    const read = await run(ctx({ method: 'GET', path: '/api/shop' }))
    expect(read.reachedNext).toBe(true)
    expect(read.scopes).toEqual(['read'])
  })
})
