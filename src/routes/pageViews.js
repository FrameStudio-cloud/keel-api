import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const pageViewsRoutes = new Hono()

/**
 * Reduce a referrer to a stable traffic-source label.
 *
 * Real traffic arrives with a full URL (https://www.google.com/...), so we parse
 * the host rather than storing raw referrer strings — otherwise "traffic sources"
 * would fill with one row per unique URL. The returned labels are Title Case to
 * match the colour map in Keel's Overview UI.
 */
export function sourceFromReferrer(referrer) {
  if (!referrer) return 'Direct'

  let host
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // not a parseable URL — a bare host like "google.com" is still useful
    host = String(referrer).trim().toLowerCase().replace(/^www\./, '')
    if (!host || host.includes('/') || host.includes(' ')) return 'Direct'
  }

  // Local and preview hosts are not traffic. A Vercel preview or a local dev
  // server would otherwise show up as its own "source" and dilute real numbers.
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) {
    return 'Direct'
  }

  const exact = {
    'google.com': 'Google',
    'bing.com': 'Bing',
    'duckduckgo.com': 'DuckDuckGo',
    'facebook.com': 'Facebook',
    'fb.com': 'Facebook',
    'instagram.com': 'Instagram',
    'tiktok.com': 'TikTok',
    't.co': 'X',
    'x.com': 'X',
    'twitter.com': 'X',
    'wa.me': 'WhatsApp',
    'api.whatsapp.com': 'WhatsApp',
    'web.whatsapp.com': 'WhatsApp',
    'youtube.com': 'YouTube',
    'm.youtube.com': 'YouTube',
    'linkedin.com': 'LinkedIn',
    'l.facebook.com': 'Facebook',
    'l.instagram.com': 'Instagram',
  }
  if (exact[host]) return exact[host]

  // Google properties are regional (google.co.ke, google.co.uk, ...)
  if (host === 'google' || host.startsWith('google.')) return 'Google'

  // Unknown but still a real referrer: show the bare host, minus noise.
  return host.replace(/^www\./, '').slice(0, 40) || 'Direct'
}

// `.nullish()` not `.optional()`: JSON clients commonly send an explicit
// null rather than omitting the key, and optional() alone rejects that.
const bodySchema = z.object({
  page: z.string().max(300).nullish(),
  product_name: z.string().max(160).nullish(),
  referrer: z.string().max(500).nullish(),
})

// Requires a write token: enforced by siteAuth() before we get here.
pageViewsRoutes.post('/', async (c) => {
  const shopId = shopIdOf(c)

  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = bodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    return c.json({ error: 'Invalid payload' }, 400)
  }

  const { page, product_name, referrer } = parsed.data
  if (!page) return c.json({ error: 'page is required' }, 400)

  // Prefer the actual browser referrer header; fall back to what the client sent
  // (beacon requests can omit it, and it arrives as p_referrer in some paths).
  const rawReferrer = c.req.header('referer') || referrer || null

  const { error } = await supabase.from('page_views').insert({
    shop_id: shopId,
    page,
    product_name: product_name || null,
    referrer: sourceFromReferrer(rawReferrer),
  })

  if (error) {
    console.error('[page-views] insert failed:', error.message)
    return c.json({ error: 'Failed to record view' }, 500)
  }

  return c.json({ ok: true }, 201)
})
