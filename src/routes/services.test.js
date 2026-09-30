import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * Tenant isolation on the service list.
 *
 * This route was added 30 Sep 2026 because no route in keel-api read the
 * `services` table at all: a laundry could take orders in Keel and could not
 * show them to a customer. A newly published route on a service-role
 * connection is exactly where a missing `.eq('shop_id', …)` would be invisible,
 * so the property is asserted here rather than left to review.
 *
 * The database cannot catch it. RLS is on `services`, but this connection is the
 * service role, which bypasses RLS entirely - the filter is the only thing
 * standing between one shop's price list and another shop's customer.
 *
 * Assertions are on the query that was BUILT, not on the source text.
 */

const calls = []
let nextResult = { data: [], error: null }

function recorder(table) {
  const rec = { table, filters: {}, selected: null, order: [] }
  const api = {
    select(cols) { rec.op = 'select'; rec.selected = cols; return api },
    eq(col, value) { rec.filters[col] = value; return api },
    order(col, opts) { rec.order.push({ col, asc: opts?.ascending }); return api },
    maybeSingle() { calls.push(rec); return Promise.resolve(nextResult) },
    single() { return api.maybeSingle() },
    then(resolve) { calls.push(rec); return Promise.resolve(nextResult).then(resolve) },
  }
  return api
}

vi.mock('../db.js', () => ({ supabase: { from: (t) => recorder(t) } }))

const { servicesRoutes } = await import('./services.js')

const SHOP_A = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'
const SHOP_B = '11111111-2222-3333-4444-555555555555'

/** Mounts the route with the identity siteAuth would have set. */
function mount({ shopId = SHOP_A, path = '/', query } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('shopId', shopId)
    c.set('canWrite', false)
    await next()
  })
  app.route('/api/services', servicesRoutes)
  // Hono matches a sub-app's `get('/')` at the bare mount point, so a path of
  // '/' means "no suffix". Asking for '/api/services/' returns Hono's own 404 and
  // the handler never runs - which reads as a silent pass, not a failure.
  const suffix = path === '/' ? '' : path
  const qs = query ? `?${query}` : ''
  return app.request(`/api/services${suffix}${qs}`)
}

beforeEach(() => {
  calls.length = 0
  nextResult = { data: [], error: null }
})

describe('the service list is scoped to the caller', () => {
  it('filters by the token shop', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    expect(rec).toBeDefined()
    expect(rec.filters.shop_id).toBe(SHOP_A)
  })

  it('does not honour a shop_id smuggled in the query', async () => {
    await mount({ query: `shop_id=${SHOP_B}` })
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.filters.shop_id).toBe(SHOP_A)
    expect(rec.filters.shop_id).not.toBe(SHOP_B)
  })
})

describe('unpublished services stay unpublished', () => {
  // `visible` is a soft delete, not a removal: Services.jsx hides a row rather
  // than deleting it, because past orders copy the service name and price onto
  // the line and must keep reading correctly. So a hidden service still exists
  // and is still queryable by anyone who forgets this filter.
  it('filters visible to true', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.filters.visible).toBe(true)
  })
})

describe('the response names its columns', () => {
  // `select('*')` publishes every column added in future with nobody reviewing
  // it. That is how store_settings came to hand out a shop's Paystack
  // subaccount code to anyone who sent an Origin header.
  it('is not a wildcard', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.selected).not.toBe('*')
    expect(rec.selected.split(',').length).toBeGreaterThan(1)
  })

  // These two arrived with the 30 Sep baseline. Selecting a column that does not
  // exist is a PostgREST *error*, not an empty result, so the whole feature
  // would read as "no services" forever with no error to explain it - the
  // invoices.total/amount trap.
  it('includes turnaround_hours and image, which the migration added', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    const cols = rec.selected.split(',')
    expect(cols).toContain('turnaround_hours')
    expect(cols).toContain('image')
  })

  it('includes everything a service grid needs to render', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    const cols = rec.selected.split(',')
    for (const needed of ['id', 'name', 'category', 'pricing_mode', 'price', 'unit_label', 'description']) {
      expect(cols, needed).toContain(needed)
    }
  })

  it('does not leak shop_id back', async () => {
    // The caller already knows its own shop from the token; echoing it is noise,
    // and it is the one field a future careless `.select('*')` would re-add.
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.selected.split(',')).not.toContain('shop_id')
  })
})

describe('ordering is stable', () => {
  // Not created_at: re-pricing a service should not reshuffle the shop's
  // website, and two services created in the same second have no meaningful
  // order anyway.
  it('orders by category then name', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.order.map((o) => o.col)).toEqual(['category', 'name'])
    expect(rec.order.every((o) => o.asc === true)).toBe(true)
  })
})

describe('the category filter', () => {
  it('is applied when given', async () => {
    await mount({ query: 'category=laundry' })
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.filters.category).toBe('laundry')
  })

  it('is absent when not given', async () => {
    await mount()
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.filters.category).toBeUndefined()
  })

  // `.eq()` is parameterised, so unlike the `.or()` injection the catalogue
  // route had to guard against, a comma or quote in the value cannot add a
  // condition. Pinned so a future rewrite to `.or()` is a deliberate change.
  it('cannot inject a second filter through the value', async () => {
    await mount({ query: `category=laundry,shop_id.eq.${SHOP_B}` })
    const rec = calls.find((c) => c.table === 'services')
    expect(rec.filters.shop_id).toBe(SHOP_A)
  })
})

describe('an empty shop is not an error', () => {
  it('returns an empty array', async () => {
    nextResult = { data: null, error: null }
    const res = await mount()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('surfaces a database failure as a 500, not as an empty list', async () => {
    // The distinction matters: a laundry with no services yet and a broken
    // query must not look identical to a storefront.
    nextResult = { data: null, error: { message: 'boom' } }
    const res = await mount()
    expect(res.status).toBe(500)
  })
})
