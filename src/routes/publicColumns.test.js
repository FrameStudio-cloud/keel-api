import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * Five public routes used `select('*')`.
 *
 * `AGENTS.md` states "name the columns you select, never `select('*')`" as a rule
 * because of two live leaks: `store_settings` handed out a shop's Paystack
 * subaccount code, and `chat_config` would have published a bring-your-own Groq
 * key the first time a shop set one. Both happened with no code change for anyone
 * to review, which is the property a wildcard has and a column list does not.
 *
 * These assertions are on the query that was BUILT, not on the source text, for
 * the same reason services.test.js asserts there: a refactor that keeps the
 * comment while restoring the wildcard would pass a grep.
 */

const calls = []
let nextResult = { data: [], error: null }

function recorder(table) {
  const rec = { table, filters: {}, selected: null, order: [] }
  const api = {
    select(cols) {
      rec.selected = cols
      return api
    },
    eq(col, value) {
      rec.filters[col] = value
      return api
    },
    or() {
      return api
    },
    is() {
      return api
    },
    in(col, values) {
      rec.inFilter = { col, values }
      return api
    },
    order(col, opts) {
      rec.order.push({ col, asc: opts?.ascending })
      return api
    },
    limit(n) {
      rec.limit = n
      return api
    },
    gte() {
      return api
    },
    lte() {
      return api
    },
    maybeSingle() {
      calls.push(rec)
      return Promise.resolve(nextResult)
    },
    single() {
      return api.maybeSingle()
    },
    then(resolve) {
      calls.push(rec)
      return Promise.resolve(nextResult).then(resolve)
    },
  }
  return api
}

vi.mock('../db.js', () => ({ supabase: { from: (t) => recorder(t) } }))

const { bannersRoutes } = await import('./banners.js')
const { catalogueRoutes } = await import('./catalogue.js')
const { pageContentRoutes } = await import('./pageContent.js')
const { chatRoutes } = await import('./chat.js')

const SHOP_A = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'

function mount(routeFactory, prefix, suffix = '', query = '') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('shopId', SHOP_A)
    c.set('canWrite', false)
    await next()
  })
  app.route(prefix, routeFactory())
  return app.request(`${prefix}${suffix}${query ? `?${query}` : ''}`)
}

function selectOf(table) {
  const rec = calls.find((c) => c.table === table)
  expect(rec, `no query was built against ${table}`).toBeDefined()
  return rec
}

beforeEach(() => {
  calls.length = 0
  nextResult = { data: [], error: null }
})

describe.each([
  ['banners', () => mount(() => bannersRoutes, '/api/banners'), ['id', 'title', 'image_url', 'sort_order']],
  [
    'catalogue',
    () => mount(() => catalogueRoutes, '/api/catalogue'),
    ['id', 'name', 'price', 'image', 'available', 'product_id', 'sale_price'],
  ],
  [
    'page_content',
    () => mount(() => pageContentRoutes, '/api/page-content', '', 'page=home'),
    ['id', 'page_key', 'section_key', 'content'],
  ],
  [
    'chat_faqs',
    () => mount(() => chatRoutes, '/api/chat', '/faqs'),
    ['id', 'question', 'answer', 'sort_order'],
  ],
  [
    'chat_messages',
    () =>
      mount(
        () => chatRoutes,
        '/api/chat',
        '/messages',
        'ids=11111111-1111-1111-1111-111111111111'
      ),
    ['id', 'question', 'answer', 'status', 'customer_name'],
  ],
])('%s names its columns', (table, request, required) => {
  it('is not a wildcard', async () => {
    await request()
    const rec = selectOf(table)
    expect(rec.selected).not.toBe('*')
    expect(rec.selected.split(',').length).toBeGreaterThan(1)
  })

  it('does not leak shop_id back', async () => {
    // The caller knows its own shop from the token. Echoing the id is noise, and
    // it is the one field a careless future wildcard re-adds first.
    await request()
    expect(selectOf(table).selected.split(',')).not.toContain('shop_id')
  })

  it('includes what the storefront needs to render', async () => {
    await request()
    const cols = selectOf(table).selected.split(',')
    for (const col of required) expect(cols, col).toContain(col)
  })
})

describe('every one of these routes is still scoped to the token', () => {
  // Pulling a wildcard is a refactor of the select; the tenant filter must move
  // with it. One missing `.eq('shop_id', …)` on the service-role connection is a
  // cross-tenant read with nothing behind it to catch it.
  it.each([
    ['banners', () => mount(() => bannersRoutes, '/api/banners')],
    ['catalogue', () => mount(() => catalogueRoutes, '/api/catalogue')],
    [
      'page_content',
      () => mount(() => pageContentRoutes, '/api/page-content', '', 'page=home'),
    ],
    ['chat_faqs', () => mount(() => chatRoutes, '/api/chat', '/faqs')],
    [
      'chat_messages',
      () =>
        mount(
          () => chatRoutes,
          '/api/chat',
          '/messages',
          'ids=11111111-1111-1111-1111-111111111111'
        ),
    ],
  ])('%s filters by the token shop', async (table, request) => {
    await request()
    expect(selectOf(table).filters.shop_id).toBe(SHOP_A)
  })
})
