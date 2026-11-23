import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../db.js'
import { shopIdOf, siteIdOf, rateLimit } from '../auth.js'

export const inquiriesRoutes = new Hono()

/**
 * A customer message from a storefront's contact form.
 *
 * This is the first WRITE a site can do that a customer cares about. Everything
 * else on this API is either a read or telemetry.
 *
 * Three things are deliberate:
 *
 *   1. `shop_id` and `site_id` come from the token, never the body. The token
 *      already names both, and a body-supplied tenant is how the September
 *      hardening found four routes writing into another shop.
 *   2. It is NOT a `site_events` row. The event collector strips
 *      phone/email/message by design (see events.js); an inquiry is the one thing
 *      that is *supposed* to carry contact details, so it gets its own table with
 *      its own retention and its own access.
 *   3. It is budgeted per shop. The credential that reaches this endpoint ships
 *      in the storefront's public JavaScript, so the only thing between a leaked
 *      key and an owner's inbox is a rate limit.
 */

const PHONE = /^[+()\d][\d\s()+-]{5,30}$/

const inquirySchema = z.object({
  name: z.string().trim().min(1, 'a name is required').max(120),
  phone: z.string().trim().regex(PHONE, 'a phone number is required').max(32),
  email: z.union([z.string().trim().email('that is not an email address').max(200), z.literal('')]).optional(),
  message: z.string().trim().max(2000).optional(),
  // Which product the form was opened from, if any. Free text, not a foreign
  // key: a site may show a catalogue item that Keel has never heard of.
  product_ref: z.string().trim().max(200).optional(),
})

/** The first problem, named, so a site can show it beside the right field. */
function firstIssue(error) {
  const issue = error.issues?.[0]
  return {
    field: issue?.path?.join('.') || 'body',
    message: issue?.message || 'is invalid',
  }
}

inquiriesRoutes.post('/', async (c) => {
  const shopId = shopIdOf(c)

  // A shop-level token has no site. That is legitimate (tokens predate per-site
  // tokens) and simply means the inquiry is not attributed to one storefront.
  const siteId = siteIdOf(c)

  // 30/minute per shop. A form is filled by a human, so this is generous for a
  // real shop and tight enough that a script cannot bury the inbox.
  if (!rateLimit(`inquiry:${shopId}`, 30, 60_000)) {
    return c.json({ error: 'Too many requests. Try again in a minute.' }, 429)
  }

  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // zod strips unknown keys, so a `shop_id` or `status` in the body cannot reach
  // the row. The insert below also names every column it writes.
  const parsed = inquirySchema.safeParse(body ?? {})
  if (!parsed.success) {
    const { field, message } = firstIssue(parsed.error)
    return c.json({ error: `Invalid ${field}: ${message}` }, 400)
  }

  const { name, phone, email, message, product_ref } = parsed.data

  const { error } = await supabase.from('inquiries').insert({
    shop_id: shopId,
    site_id: siteId,
    name,
    phone,
    email: email || null,
    message: message || null,
    product_ref: product_ref || null,
    // Always 'new', never from the body. A sender cannot mark its own message
    // as already dealt with.
    status: 'new',
  })

  if (error) {
    console.error('[inquiries] insert failed:', error.message)
    return c.json({ error: 'Could not send your message' }, 500)
  }

  return c.json({ ok: true }, 201)
})
