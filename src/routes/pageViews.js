import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'
import { identityId } from '../identity.js'

export const pageViewsRoutes = new Hono()

/** Hostname of a URL, a bare host, or a Host header — lowercased, no www, no port. */
function normalizeHost(value) {
  let v = String(value || '').trim().toLowerCase()
  if (!v) return ''
  try {
    // a full URL, e.g. an Origin header
    v = new URL(v).hostname
  } catch {
    // a bare host, possibly with a port
    v = v.replace(/^https?:\/\//, '').split('/')[0]
  }
  return v.replace(/^www\./, '').split(':')[0]
}

/**
 * Reduce a referrer to a stable traffic-source label.
 *
 * Real traffic arrives with a full URL (https://www.google.com/...), so we parse
 * the host rather than storing raw referrer strings — otherwise "traffic sources"
 * would fill with one row per unique URL. The returned labels are Title Case to
 * match the colour map in Keel's Overview UI.
 */
export function sourceFromReferrer(referrer, selfHost = null) {
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

  // Internal navigation is not a traffic source. When someone browses the site
  // itself, document.referrer is the site's own previous page, so the shop's own
  // domain would otherwise be reported as the referrer and dominate its
  // breakdown. Compare against the host the request actually arrived on, which
  // is correct for a custom domain and for a *.vercel.app production domain
  // alike (unlike filtering vercel.app by suffix, which would throw away the
  // real traffic of shops hosted there).
  if (selfHost) {
    const self = normalizeHost(selfHost)
    if (self && self === host) return 'Direct'
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
  // Anonymous first-party identity, grouped not trusted. See identity.js for
  // why a malformed id must cost the identity, not the event.
  //
  // z.unknown().optional(), not z.string(): a numeric or object id would fail
  // the schema and reject the whole page view, which is the one outcome this is
  // written to prevent. `.optional()` matters too - a bare z.unknown() is
  // required in zod v4 and would reject every view with no identity.
  // Omitted by a storefront whose visitor asked not to be tracked, and the
  // owner-facing "visitors today" figure simply counts fewer people rather
  // than guessing at any.
  visitor_id: z.unknown().optional(),
  session_id: z.unknown().optional(),
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

  const { page, product_name, referrer, visitor_id, session_id } = parsed.data
  if (!page) return c.json({ error: 'page is required' }, 400)

  // Prefer the actual browser referrer header; fall back to what the client sent
  // (beacon requests can omit it, and it arrives as p_referrer in some paths).
  const rawReferrer = c.req.header('referer') || referrer || null

  // The host the request arrived on, so an internal hop (previous page of the
  // same site) is attributed to Direct rather than to the shop's own domain.
  const selfHost = c.req.header('origin') || c.req.header('host') || null

  const { error } = await supabase.from('page_views').insert({
    shop_id: shopId,
    page,
    product_name: product_name || null,
    referrer: sourceFromReferrer(rawReferrer, selfHost),
    // Grouping keys only. shop_id above is derived from the site token, so a
    // visitor id can join one shop's rows together and can never move a row
    // between shops.
    visitor_id: identityId(visitor_id),
    session_id: identityId(session_id),
  })

  if (error) {
    console.error('[page-views] insert failed:', error.message)
    return c.json({ error: 'Failed to record view' }, 500)
  }

  return c.json({ ok: true }, 201)
})
