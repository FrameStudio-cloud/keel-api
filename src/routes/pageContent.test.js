import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * `page_key` is NOT unique across the two content models, and that was found
 * live rather than reasoned about.
 *
 * A laundry shop in Kariani carried 11 `page_content` rows copied from a
 * clothing template — "What is a kikoi? A traditional Kenyan garment woven from
 * cotton fabric", a wholesale minimum of 20 items, Mombasa. Never edited by the
 * shop, and invisible while the shop had no site.
 *
 * The moment a site went live, `GET /api/page-content?section=hero` matched the
 * legacy `(page_key='about', section_key='hero')` row and rendered
 * "Woven on the Kenyan Coast, Worn Around the World" as a laundry's headline.
 *
 * So: a shop can hold a legacy `('about', 'hero')` row and a section-addressed
 * `(null, 'hero')` row, and the section filter alone cannot tell them apart.
 */

const calls = []
let nextResult = { data: [], error: null }

function recorder(table) {
  const rec = { table, filters: {}, nulls: [] }
  const api = {
    select() { return api },
    eq(col, value) { rec.filters[col] = value; return api },
    is(col, value) {
      rec.nulls.push({ col, value })
      if (value === null) rec.filters[col] = null
      return api
    },
    then(resolve) { calls.push(rec); return Promise.resolve(nextResult).then(resolve) },
  }
  return api
}

vi.mock('../db.js', () => ({ supabase: { from: (t) => recorder(t) } }))

const { pageContentRoutes } = await import('./pageContent.js')

const SHOP = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'

function mount(query = '') {
  const app = new Hono()
  app.use('*', async (c, next) => { c.set('shopId', SHOP); await next() })
  app.route('/api/page-content', pageContentRoutes)
  return app.request(`/api/page-content${query}`)
}

beforeEach(() => {
  calls.length = 0
  nextResult = { data: [], error: null }
})

describe('a section-only read never sees legacy page-scoped content', () => {
  // THE BUG. Both models use `hero` as a section_key.
  it('additionally requires page_key to be null', async () => {
    await mount('?section=hero')
    const rec = calls.find((c) => c.table === 'page_content')
    expect(rec.filters.section_key).toBe('hero')
    expect(rec.nulls).toContainEqual({ col: 'page_key', value: null })
  })

  it('would fail if the null filter were dropped', async () => {
    // Documents exactly what regressed, so the mutation is self-explanatory.
    const rec = { filters: { section_key: 'hero' } }
    expect(rec.filters.page_key).toBeUndefined()
  })
})

describe('a page read is unchanged', () => {
  // kikoi still reads `?page=home` and its rows keep their page_key. This must
  // not regress, or a live shop loses its content.
  it('filters by page_key and does not require null', async () => {
    await mount('?page=home')
    const rec = calls.find((c) => c.table === 'page_content')
    expect(rec.filters.page_key).toBe('home')
    expect(rec.nulls).toHaveLength(0)
  })

  it('still narrows by section when both are given', async () => {
    await mount('?page=about&section=story')
    const rec = calls.find((c) => c.table === 'page_content')
    expect(rec.filters.page_key).toBe('about')
    expect(rec.filters.section_key).toBe('story')
    // Legacy addressing deliberately skips the null filter.
    expect(rec.nulls).toHaveLength(0)
  })
})

describe('a read with neither is not a dump', () => {
  it('returns an empty array without touching the database', async () => {
    const res = await mount('')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    // Returning every row would hand the caller content it cannot address.
    expect(calls.find((c) => c.table === 'page_content')).toBeUndefined()
  })
})

describe('every read is shop-scoped', () => {
  it('includes the token shop', async () => {
    await mount('?section=hero')
    expect(calls.find((c) => c.table === 'page_content').filters.shop_id).toBe(SHOP)
  })
})
