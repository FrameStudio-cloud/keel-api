import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * Tenant isolation in the route handlers.
 *
 * The September hardening converted the GET routes to `shopIdOf(c)` and left the
 * POST routes reading `body.shop_id`. Nothing caught that, because nothing tested
 * these files. The consequence was that a write-token holder could file a
 * callback, a stock alert, or a caption request against a different tenant, and
 * `GET /api/chat/messages` had no shop filter at all.
 *
 * So these tests assert the property directly: for every route that touches
 * tenant data, the `shop_id` that reaches the database is the one the token
 * resolved to, and never one the caller supplied in a body or query.
 *
 * The supabase client is a recording stub, so the assertions are on the actual
 * query built - not on the source text.
 */

const calls = []
let nextResult = { data: null, error: null }

/** A chainable PostgREST stand-in that records the filters it was given. */
function recorder(table) {
  const rec = { table, op: null, filters: {}, selected: null, payload: null }
  const api = {
    select(columns) {
      rec.op = 'select'
      rec.selected = columns
      return api
    },
    eq(column, value) {
      rec.filters[column] = value
      return api
    },
    in(column, values) {
      rec.filters[`${column}__in`] = values
      return api
    },
    gte() { return api },
    lte() { return api },
    order() { return api },
    limit() { return api },
    // PostgREST builders await to { data, error }, so maybeSingle must resolve
    // to that envelope. Returning the row itself makes every `const { data, error }
    // = await ...maybeSingle()` destructure to undefined, which reads as a silent
    // 404 rather than as a broken stub.
    maybeSingle() {
      calls.push(rec)
      return Promise.resolve(nextResult)
    },
    single() { return api.maybeSingle() },
    then(resolve) {
      calls.push(rec)
      return Promise.resolve(nextResult).then(resolve)
    },
    insert(payload) {
      rec.op = 'insert'
      rec.payload = payload
      calls.push(rec)
      return Promise.resolve(nextResult)
    },
  }
  return api
}

vi.mock('../db.js', () => ({
  supabase: { from: (table) => recorder(table) },
}))

const { chatRoutes } = await import('./chat.js')
const { settingsRoutes } = await import('./settings.js')
const { contentRoutes } = await import('./content.js')
const { manifestRoutes } = await import('./manifest.js')

const SHOP_A = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'
const SHOP_B = '11111111-2222-3333-4444-555555555555'

/**
 * Mounts a route exactly as index.js does, with the identity already in context
 * - i.e. after siteAuth has resolved a token. What is under test here is what the
 * handler does with that identity, not the gate itself (see auth.test.js).
 *
 * `path` is the handler's own path within the mounted sub-app, so the request URL
 * is `prefix + path`, which is how the real router resolves it.
 */
function mount(routes, prefix, { path = '/', shopId = SHOP_A, method = 'GET', body, query } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('shopId', shopId)
    c.set('canWrite', true)
    await next()
  })
  app.route(prefix, routes)
  // Hono matches a sub-app's `get('/')` at the bare mount point, so a path of
  // '/' means "no suffix" - asking for '/api/settings/' returns Hono's own 404
  // and the handler never runs, which reads as a silent pass.
  const suffix = path === '/' ? '' : path
  const qs = query?.q ? `?${query.q}` : ''
  return app.request(`${prefix}${suffix}${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  calls.length = 0
  nextResult = { data: [], error: null }
  // The captions route returns 500 before it queries anything when this is
  // unset, which reads as "the query was never made" rather than as a config
  // problem.
  process.env.GROQ_API_KEY = 'test-key'
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
})

describe('GET /api/chat/messages is scoped to the caller', () => {
  // The cross-tenant read. Sequential integer ids meant `?ids=1,2,3...` walked
  // the table, and with no filter it returned other shops' rows.
  it('filters chat_messages by the token shop, not by the requested ids', async () => {
    await mount(chatRoutes, '/api/chat', { path: '/messages', query: { q: 'ids=1,2,3' } })
    const rec = calls.find((c) => c.table === 'chat_messages')
    expect(rec).toBeDefined()
    expect(rec.filters.shop_id).toBe(SHOP_A)
  })

  it('does not honour a shop_id smuggled in the query', async () => {
    await mount(chatRoutes, '/api/chat', { path: '/messages', query: { q: `ids=1&shop_id=${SHOP_B}` } })
    const rec = calls.find((c) => c.table === 'chat_messages')
    expect(rec.filters.shop_id).toBe(SHOP_A)
    expect(rec.filters.shop_id).not.toBe(SHOP_B)
  })

  it('bounds the number of ids it will accept', async () => {
    // Unbounded `.in()` meant one request could walk the whole table.
    const many = Array.from({ length: 500 }, (_, i) => i + 1).join(',')
    const res = await mount(chatRoutes, '/api/chat', { path: '/messages', query: { q: `ids=${many}` } })
    expect(res.status).toBe(400)
    expect(calls.find((c) => c.table === 'chat_messages')).toBeUndefined()
  })
})

describe('POST routes derive shop_id from the token', () => {
  it('callbacks ignores a forged body shop_id', async () => {
    nextResult = { data: null, error: null }
    await mount(chatRoutes, '/api/chat', {
      path: '/callbacks',
      method: 'POST',
      body: { shop_id: SHOP_B, name: 'Ada', phone: '0700000000' },
    })
    const rec = calls.find((c) => c.table === 'chat_callbacks')
    expect(rec).toBeDefined()
    expect(rec.payload.shop_id).toBe(SHOP_A)
    expect(rec.payload.shop_id).not.toBe(SHOP_B)
  })

  it('stock-alerts ignores a forged body shop_id', async () => {
    await mount(chatRoutes, '/api/chat', {
      path: '/stock-alerts',
      method: 'POST',
      body: { shop_id: SHOP_B, product_name: 'Sandals' },
    })
    const rec = calls.find((c) => c.table === 'chat_stock_alerts')
    expect(rec).toBeDefined()
    expect(rec.payload.shop_id).toBe(SHOP_A)
  })

  it('reads store_settings by the token shop, not the body', async () => {
    await mount(contentRoutes, '/api/content', {
      path: '/captions',
      method: 'POST',
      body: { shopId: SHOP_B, productNames: ['Chair'] },
    })
    const rec = calls.find((c) => c.table === 'store_settings')
    expect(rec).toBeDefined()
    expect(rec.filters.shop_id).toBe(SHOP_A)
  })
})

describe('a storefront is never served another shop’s settings', () => {
  it('scopes store_settings to the token', async () => {
    await mount(settingsRoutes, '/api/settings')
    const rec = calls.find((c) => c.table === 'store_settings')
    expect(rec.filters.shop_id).toBe(SHOP_A)
  })

  // `select('*')` returned all 34 columns, including paystack_subaccount_code,
  // the full paystack_subaccount jsonb, store_phone, store_address and the owner
  // email inside notification_preferences. Naming the columns is the point: with
  // `*`, every column added later is published automatically and nobody reviews
  // it.
  it('names its columns rather than selecting the whole row', async () => {
    await mount(settingsRoutes, '/api/settings')
    const rec = calls.find((c) => c.table === 'store_settings')
    expect(rec.selected).not.toBe('*')
    // A comma-joined list, not a wildcard: this is the assertion that a future
    // column has to be added deliberately.
    expect(typeof rec.selected).toBe('string')
    expect(rec.selected.split(',').length).toBeGreaterThan(1)
  })

  // A shop's OWN contact details are not a secret to that shop - it prints them
  // on its own public site - and a token only ever resolves to its own shop, so
  // store_phone and store_address stay. The columns below are the ones that must
  // never leave the server, and the first is the reason the whole row was unsafe.
  it.each([
    'paystack_subaccount_code',
    'paystack_subaccount',
    'notification_preferences',
  ])('does not publish %s to the storefront', async (column) => {
    await mount(settingsRoutes, '/api/settings')
    const rec = calls.find((c) => c.table === 'store_settings')
    expect(rec.selected.split(',')).not.toContain(column)
  })

  it('keeps the shop its own contact details, which it displays publicly anyway', async () => {
    await mount(settingsRoutes, '/api/settings')
    const rec = calls.find((c) => c.table === 'store_settings')
    const cols = rec.selected.split(',')
    // With the token gate in place these are only ever the caller's own row, and
    // a storefront cannot render a contact section without them.
    for (const own of ['store_phone', 'store_address', 'whatsapp']) {
      expect(cols, own).toContain(own)
    }
  })

  it('keeps the fields a storefront actually needs to render', async () => {
    await mount(settingsRoutes, '/api/settings')
    const rec = calls.find((c) => c.table === 'store_settings')
    const cols = rec.selected.split(',')
    for (const needed of ['store_name', 'currency_symbol', 'logo_url', 'primary_color', 'business_hours']) {
      expect(cols, needed).toContain(needed)
    }
  })
})

describe('chat widget config does not carry the table’s secrets', () => {
  // chat_config also holds groq_api_key, whatsapp_token, whatsapp_verify_token
  // and whatsapp_pin. `select('*')` published all of them; the values happened to
  // be empty on the probed shop, so nothing leaked - but the first shop to set a
  // bring-your-own key would have published it with no code change to review.
  it('names its columns rather than selecting the whole row', async () => {
    await mount(chatRoutes, '/api/chat', { path: '/config' })
    const rec = calls.find((c) => c.table === 'chat_config')
    expect(rec.selected).not.toBe('*')
  })

  it.each(['groq_api_key', 'whatsapp_token', 'whatsapp_verify_token', 'whatsapp_pin', 'plan_tier'])(
    'does not publish %s',
    async (column) => {
      await mount(chatRoutes, '/api/chat', { path: '/config' })
      const rec = calls.find((c) => c.table === 'chat_config')
      expect(rec.selected.split(',')).not.toContain(column)
    }
  )
})

describe('/api/manifest is not an SSRF primitive', () => {
  beforeEach(() => {
    nextResult = { data: { website_url: 'https://kikoi-opal.vercel.app/' }, error: null }
  })

  it('refuses a url whose host is not this shop’s registered host', async () => {
    const res = await mount(manifestRoutes, '/api/manifest', {
      query: { q: 'url=http://localhost:3001' },
    })
    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a shared platform host that a substring match would have accepted', async () => {
    const res = await mount(manifestRoutes, '/api/manifest', {
      query: { q: 'url=https://vercel.app/keel-manifest.json' },
    })
    expect(res.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a plaintext url, which is how the internal http reach worked', async () => {
    const res = await mount(manifestRoutes, '/api/manifest', {
      query: { q: 'url=http://169.254.169.254/latest/meta-data' },
    })
    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches the REGISTERED origin, not the url it was handed', async () => {
    await mount(manifestRoutes, '/api/manifest', {
      query: { q: 'url=https://kikoi-opal.vercel.app/anything' },
    })
    const [url] = fetch.mock.calls[0]
    // Built from store_settings.website_url, so no crafted path can redirect it.
    expect(url).toBe('https://kikoi-opal.vercel.app/keel-manifest.json')
  })

  it('does not follow redirects', async () => {
    await mount(manifestRoutes, '/api/manifest', {
      query: { q: 'url=https://kikoi-opal.vercel.app' },
    })
    const [, init] = fetch.mock.calls[0]
    expect(init.redirect).toBe('error')
  })
})
