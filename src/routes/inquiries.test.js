import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * The inquiry endpoint is the first write a customer cares about, and the only
 * one on this API that stores contact details on purpose.
 *
 * The properties that matter are all about what the CALLER cannot control:
 * the tenant, the site, and the status. A form is filled in by a stranger, so
 * every field it sends is untrusted input arriving with a credential that ships
 * in the storefront's public JavaScript.
 */

const calls = []
let insertResult = { error: null }

vi.mock('../db.js', () => ({
  supabase: {
    from: (table) => {
      const rec = { table }
      const api = {
        insert(payload) {
          rec.payload = payload
          calls.push(rec)
          return Promise.resolve(insertResult)
        },
      }
      return api
    },
  },
}))

const { inquiriesRoutes } = await import('./inquiries.js')

const SHOP = 'a24f64a5-cd51-4bce-b31b-76fc73355c16'
const OTHER_SHOP = '11111111-2222-3333-4444-555555555555'
const SITE = '22222222-3333-4444-5555-666666666666'
const RATE_SHOP = '99999999-8888-7777-6666-555555555555'

function mount({ shopId = SHOP, siteId = SITE, body } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('shopId', shopId)
    c.set('siteId', siteId)
    await next()
  })
  app.route('/api/inquiries', inquiriesRoutes)

  return app.request('/api/inquiries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      body ?? { name: 'Amina', phone: '0712345678', message: 'Do you deliver to Thika?' }
    ),
  })
}

function inserted() {
  return calls.find((c) => c.table === 'inquiries')
}

beforeEach(() => {
  calls.length = 0
  insertResult = { error: null }
})

describe('what a form must send', () => {
  it.each([
    ['name', { phone: '0712345678' }],
    ['phone', { name: 'Amina' }],
  ])('refuses a body with no %s', async (field, body) => {
    const res = await mount({ body })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(new RegExp(field))
    expect(inserted()).toBeUndefined()
  })

  it('refuses a phone number that is not one', async () => {
    const res = await mount({ body: { name: 'Amina', phone: 'call me' } })
    expect(res.status).toBe(400)
    expect(inserted()).toBeUndefined()
  })

  it('refuses a malformed email rather than storing it', async () => {
    const res = await mount({
      body: { name: 'Amina', phone: '0712345678', email: 'not-an-email' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/email/)
    expect(inserted()).toBeUndefined()
  })

  it('refuses an empty JSON body', async () => {
    const res = await mount({ body: {} })
    expect(res.status).toBe(400)
  })

  it('accepts a form with only the two required fields', async () => {
    const res = await mount({ body: { name: 'Amina', phone: '0712345678' } })
    expect(res.status).toBe(201)
    expect(inserted().payload).toMatchObject({ name: 'Amina', email: null, message: null })
  })
})

describe('the caller cannot choose the tenant, the site or the status', () => {
  it('takes shop_id from the token, not the body', async () => {
    await mount({
      body: { name: 'Amina', phone: '0712345678', shop_id: OTHER_SHOP },
    })
    expect(inserted().payload.shop_id).toBe(SHOP)
    expect(inserted().payload.shop_id).not.toBe(OTHER_SHOP)
  })

  it('takes site_id from the token', async () => {
    await mount()
    expect(inserted().payload.site_id).toBe(SITE)
  })

  // A shop-level token resolves no site. That is supported, and it must record a
  // null rather than guessing a storefront the message never came from.
  it('records no site when the token names none', async () => {
    await mount({ siteId: null })
    expect(inserted().payload.site_id).toBeNull()
  })

  it('always records the message as new', async () => {
    await mount({
      body: { name: 'Amina', phone: '0712345678', status: 'closed' },
    })
    expect(inserted().payload.status).toBe('new')
  })
})

describe('a public form is budgeted', () => {
  it('refuses the 31st message in a minute, per shop', async () => {
    for (let i = 0; i < 30; i += 1) {
      const ok = await mount({ shopId: RATE_SHOP })
      expect(ok.status).toBe(201)
    }

    const limited = await mount({ shopId: RATE_SHOP })
    expect(limited.status).toBe(429)
    expect((await limited.json()).error).toMatch(/too many/i)
  })
})

describe('failures do not become claims', () => {
  it('is a 500, not a 201, when the insert fails', async () => {
    insertResult = { error: { message: 'permission denied for table inquiries' } }
    const res = await mount()
    expect(res.status).toBe(500)

    const body = await res.json()
    // The database message names a table and a privilege. The sender cannot act
    // on either, and a storefront should not learn the schema from an error.
    expect(body.error).not.toMatch(/permission denied|inquiries/)
  })
})
