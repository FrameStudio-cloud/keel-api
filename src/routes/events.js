import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const eventsRoutes = new Hono()

/**
 * The closed event vocabulary. Enforced here for a useful 400 message, and
 * again by a CHECK constraint on site_events so a bug in this file still cannot
 * invent an event name.
 */
export const EVENTS = [
  'page_view',
  'health_ok',
  'health_fail',
  'error',
  'product_viewed',
  'add_to_cart',
  'feature_used',
]

const HEALTH_RESOURCES = [
  'settings',
  'catalogue',
  'product',
  'banners',
  'page_content',
]

/**
 * Keys whose values must never reach an analytics table.
 *
 * A storefront has contact forms and a WhatsApp widget, so the obvious thing to
 * write one day is
 *   track("product_viewed", { name, phone, message })
 * which would put customer contact details into an event table, in a different
 * system, with different access, indefinitely.
 *
 * `name` is deliberately NOT stripped: for product_viewed it is the product
 * name, which is already public on the site. Strip the contact-shaped keys
 * instead. The closed vocabulary means there is no event that legitimately
 * carries a customer's details, because none of them is an inquiry event.
 *
 * Also: cap string length, so a stack trace or an over-long field cannot be
 * used to smuggle a payload past the key filter.
 */
const PII_KEY = /(^|_)(phone|email|address|message|notes|note|body|comment|message_body|contact)$/i
const MAX_STRING = 300
const MAX_PROPS = 20

function scrub(value, depth = 0) {
  if (depth > 4) return undefined
  if (value === null || value === undefined) return undefined

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => scrub(v, depth + 1)).filter((v) => v !== undefined)
  }
  if (typeof value === 'object') {
    const out = {}
    let kept = 0
    for (const [k, v] of Object.entries(value)) {
      if (kept >= MAX_PROPS) break
      if (PII_KEY.test(k)) continue
      const s = scrub(v, depth + 1)
      if (s !== undefined) {
        out[k] = s
        kept += 1
      }
    }
    return out
  }
  return undefined
}

const eventSchema = z.object({
  name: z.enum(EVENTS),
  properties: z.record(z.any()).optional(),
  path: z.string().max(300).optional(),
  // client clock; clamped server-side so a skewed device cannot backdate forever
  occurred_at: z.number().int().optional(),
})

/**
 * POST /api/events
 *
 * Accepts a single event or a batch, because the SDK flushes a queue and one
 * request per event would be wasteful. Requires a write token.
 *
 * Health fires on transitions only, so a broken site produces one event per
 * change of state rather than one per page view.
 */
eventsRoutes.post('/', async (c) => {
  const shopId = shopIdOf(c)

  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const raw = Array.isArray(body) ? body : [body]
  if (!raw.length) return c.json({ error: 'No events supplied' }, 400)
  if (raw.length > 20) return c.json({ error: 'Batch too large (max 20)' }, 413)

  const rows = []
  const rejected = []

  for (const item of raw) {
    const parsed = eventSchema.safeParse(item ?? {})
    if (!parsed.success) {
      rejected.push({ name: item?.name ?? null, reason: 'invalid' })
      continue
    }
    const { name, properties, path, occurred_at: at } = parsed.data

    // health events must name the resource they are about, otherwise the console
    // cannot tell which part of the site is broken
    if (name === 'health_ok' || name === 'health_fail') {
      const res = properties?.resource
      if (!HEALTH_RESOURCES.includes(res)) {
        rejected.push({ name, reason: 'health events need a valid resource' })
        continue
      }
    }

    // Clamp a client clock to +/- 1 day so a wrong device clock cannot bury
    // events outside the console's window or fake recency.
    let occurred = new Date()
    if (at) {
      const claimed = new Date(at)
      const skew = Math.abs(claimed.getTime() - Date.now())
      occurred = skew > 86_400_000 ? new Date() : claimed
    }

    rows.push({
      shop_id: shopId,
      name,
      properties: scrub(properties ?? {}) ?? {},
      path: path ? path.slice(0, 300) : null,
      occurred_at: occurred.toISOString(),
    })
  }

  if (!rows.length) {
    return c.json({ error: 'No valid events', rejected }, 400)
  }

  const { error } = await supabase.from('site_events').insert(rows)
  if (error) {
    console.error('[events] insert failed:', error.message)
    return c.json({ error: 'Failed to record' }, 500)
  }

  return c.json({ ok: true, accepted: rows.length, rejected }, 201)
})
