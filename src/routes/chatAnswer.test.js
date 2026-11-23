import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * POST /api/chat/answer had two defects, and only one of them was the model.
 *
 * The other was `body.shopContext`: the route built its prompt from the request
 * body rather than from the shop the token names. No database was read, so it was
 * never a cross-tenant leak — but it made the route an open LLM proxy. A site
 * token ships in a storefront's public JS, so anyone holding one could send
 * arbitrary context and spend Keel's Groq budget on it.
 *
 * These tests pin the fix: the prompt is built from the token's shop, and a body
 * carrying a shop_context is ignored.
 */

const calls = []
let responder = () => ({ data: null, error: null })

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
    order(col, opts) {
      rec.order.push({ col, asc: opts?.ascending })
      return api
    },
    limit(n) {
      rec.limit = n
      return api
    },
    maybeSingle() {
      calls.push(rec)
      return Promise.resolve(responder(table, rec))
    },
    single() {
      return api.maybeSingle()
    },
    then(resolve) {
      calls.push(rec)
      return Promise.resolve(responder(table, rec)).then(resolve)
    },
  }
  return api
}

vi.mock('../db.js', () => ({ supabase: { from: (t) => recorder(t) } }))

const { chatRoutes } = await import('./chat.js')

const SHOP_CONTEXT = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'
const SHOP_RATE = '99999999-8888-7777-6666-555555555555'

function mount({ shopId = SHOP_CONTEXT, body } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('shopId', shopId)
    c.set('canWrite', true)
    await next()
  })
  app.route('/api/chat', chatRoutes)
  return app.request('/api/chat/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { question: 'how much is the kikoi?' }),
  })
}

let lastPrompt = ''

beforeEach(() => {
  calls.length = 0
  lastPrompt = ''
  process.env.GROQ_API_KEY = 'test-key'

  responder = (table) => {
    switch (table) {
      case 'app_config':
        return { data: { value: [{ id: 'test/model' }] }, error: null }
      case 'shops':
        return { data: { name: 'Test Shop' }, error: null }
      case 'store_settings':
        return {
          data: {
            store_name: 'Test Shop',
            store_address: 'Thika',
            business_hours: { mon: { open: '08:00', close: '17:00', active: true } },
          },
          error: null,
        }
      case 'products':
        return {
          data: [{ name: 'Kikoi', category: 'Clothing', price: 1000, stock: 5 }],
          error: null,
        }
      case 'chat_faqs':
        return { data: [{ question: 'Do you deliver?', answer: 'Yes, countrywide.' }], error: null }
      default:
        return { data: null, error: null }
    }
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      lastPrompt = init?.body ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"answer":"Karibu"}' } }] }),
      }
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the prompt is built from the token, not the body', () => {
  it('reads products and faqs for the caller\u2019s shop', async () => {
    const res = await mount()
    expect(res.status).toBe(200)
    expect((await res.json()).answer).toBe('Karibu')

    const products = calls.find((c) => c.table === 'products')
    expect(products.filters.shop_id).toBe(SHOP_CONTEXT)

    const faqs = calls.find((c) => c.table === 'chat_faqs')
    expect(faqs.filters.shop_id).toBe(SHOP_CONTEXT)
  })

  it('ignores a shop_context sent in the body', async () => {
    // The old route would have answered from this context. Nothing from the body
    // may reach the prompt except the question itself.
    await mount({
      body: {
        question: 'what do you sell?',
        shopContext: {
          shopName: 'Attacker Shop',
          products: [{ name: 'BOGUS ITEM', price: 1, inStock: true }],
          faqs: [{ question: 'BOGUS FAQ', answer: 'BOGUS ANSWER' }],
        },
      },
    })

    expect(lastPrompt).not.toContain('BOGUS ITEM')
    expect(lastPrompt).not.toContain('BOGUS FAQ')
    expect(lastPrompt).not.toContain('Attacker Shop')
    // And the real shop's data IS there, so the prompt is not simply empty.
    expect(lastPrompt).toContain('Kikoi')
    expect(lastPrompt).toContain('Do you deliver?')
  })

  it('omits a day whose hours were never configured', async () => {
    // Never "Closed" — a shop that has not told us its Sunday hours has not told
    // us anything, and a bot that guesses the timetable is wrong at 3am.
    await mount()
    expect(lastPrompt).toContain('MON 08:00')
    expect(lastPrompt).not.toContain('SUN')
  })

  it('rejects a missing question without spending a request', async () => {
    const res = await mount({ body: {} })
    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('the route is a budgeted LLM call, not an open proxy', () => {
  it('refuses the 21st request in a minute, per shop', async () => {
    // 20/min. Each shop gets its own bucket, so this uses one that no other test
    // touches — `rateLimit` is module state and would otherwise leak across files.
    for (let i = 0; i < 20; i += 1) {
      const ok = await mount({ shopId: SHOP_RATE })
      expect(ok.status).toBe(200)
    }

    const limited = await mount({ shopId: SHOP_RATE })
    expect(limited.status).toBe(429)
    expect((await limited.json()).error).toMatch(/too many/i)
  })
})
