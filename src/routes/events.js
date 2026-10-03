import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../db.js'
import { shopIdOf, siteIdOf } from '../auth.js'
import { identityId } from '../identity.js'

export const eventsRoutes = new Hono()

/**
 * The closed event vocabulary. Enforced here for a useful 400 message, and
 * again by a foreign key to public.event_types, so a bug in this file still
 * cannot invent an event name.
 *
 * event_types is the single source of truth: the console reads its labels from
 * the same table, so adding an event is one INSERT rather than a change here,
 * in the SDK and in the UI.
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

/**
 * Health resources come from the database, not a constant, so the collector
 * cannot disagree with the console about what a bar can be for.
 *
 * As of 20261002_site_health_resources.sql the question is also per-site: a site
 * may only report what it declared for itself. The SDK no longer filters these
 * names in the browser - health resources became per-site and the SDK cannot know
 * a site's declarations - so this is the gate, and the one that can refuse with a
 * reason attached.
 *
 * A null siteId falls back to the global registry. That is the multi-site case:
 * a shop with two or more active sites cannot be attributed to one of them from
 * a site token, so its resources are checked the old way rather than being
 * refused wholesale.
 */
async function isHealthResource(key, siteId = null) {
  const { data } = await supabase.rpc('is_health_resource', { p_key: key, p_site_id: siteId });
  return data === true;
}

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
  properties: z.record(z.any()).nullish(),
  // nullish, not optional: a client that cannot determine a location (SSR, a
  // worker, a test harness) legitimately sends path: null, and `.optional()`
  // rejects null - which silently drops every event that has no path.
  path: z.string().max(300).nullish(),
  // client clock; clamped server-side so a skewed device cannot backdate forever
  occurred_at: z.number().int().nullish(),
  // Anonymous first-party identity, grouped not trusted. See identity.js for
  // why a malformed id must cost the identity, not the event.
  //
  // z.unknown().optional(), NOT z.string().nullish(). The string schema looked
  // safe and was not: it drops a malformed *string* to null correctly, but a
  // numeric or object id fails the schema, which rejects the whole event. That
  // is exactly the outcome identity.js exists to prevent - one storefront
  // sending the wrong type loses its health reports, its errors and its product
  // views, silently, with a 400 per item and nothing that says why. The SDK
  // only ever sends a string or nothing, so it cannot reach this; it is
  // reachable by a forked or hand-rolled storefront, which is who the principle
  // was written for.
  //
  // `.optional()` is load-bearing, not decoration. In zod v4 a bare z.unknown()
  // is REQUIRED, so it rejects an event that carries no identity at all - which
  // is most of them, since the SDK omits the fields when a visitor opts out.
  // That shipped once and was caught only by testing the absent case; the
  // regression test below exists so it cannot happen again.
  visitor_id: z.unknown().optional(),
  session_id: z.unknown().optional(),
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
/**
 * Which site a shop's events belong to.
 *
 * Only when the shop has exactly one active site. Zero or several means the
 * events stay unattributed rather than being guessed at: guessing would put one
 * site's health on another.
 *
 * This is now the FALLBACK. A token issued for a storefront names its own
 * site_id, which the events route prefers and which is why a shop can run two
 * storefronts without either losing its health. This path only runs for
 * shop-level tokens, which predate per-site tokens.
 *
 * Extracted and exported so it can be tested without a database.
 */
export function singleSiteId(sites) {
  return Array.isArray(sites) && sites.length === 1 ? sites[0].id : null
}

/**
 * Which storefront an event batch belongs to.
 *
 * Precedence is the whole point: a token issued for a storefront names its own
 * site, so it always wins. The single-active-site lookup is only consulted for a
 * shop-level token, which predates per-site tokens and cannot say which storefront
 * it is.
 *
 * That ordering is why a shop can run two storefronts without either losing its
 * health. Inverting it - or applying the lookup even when the token knows better -
 * would put one site's events on the other's dashboard.
 *
 * Pure, so the precedence can be tested without a database.
 */
export function attributedSiteId(tokenSiteId, sites) {
  return tokenSiteId || singleSiteId(sites)
}

eventsRoutes.post('/', async (c) => {
  const shopId = shopIdOf(c)

  // Which storefront these events belong to.
  //
  // The token says, and it is server-resolved from the token row, so it is never a
  // client claim. Two storefronts on one shop therefore each report their own
  // health instead of both going dark.
  //
  // A shop-level token has no site, so we fall back to the old single-active-site
  // lookup and otherwise leave events unattributed rather than guessing.
  //
  // Lazy and memoised because health validation needs it before any row is
  // accepted, and a batch of page views should not pay for a lookup it never
  // uses. One round trip either way - and none at all for a site-scoped token.
  let siteIdPromise = null
  const resolveSiteId = () => {
    const fromToken = siteIdOf(c)
    // Short-circuit before the query: a site-scoped token already knows, and this
    // keeps a batch of page views off the sites table entirely.
    if (fromToken) return Promise.resolve(attributedSiteId(fromToken, null))
    siteIdPromise ??= (async () => {
      const { data: sites } = await supabase
        .from('sites')
        .select('id')
        .eq('shop_id', shopId)
        .eq('active', true);
      return attributedSiteId(null, sites);
    })();
    return siteIdPromise;
  }

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
    const { name, properties, path, occurred_at: at, visitor_id, session_id } = parsed.data

    // health events must name the resource they are about, otherwise the console
    // cannot tell which part of the site is broken — and they must name one the
    // site actually declared, so the console never gains a bar it cannot light
    if (name === 'health_ok' || name === 'health_fail') {
      const res = properties?.resource;
      const known = res ? await isHealthResource(res, await resolveSiteId()) : false;
      if (!known) {
        rejected.push({ name, reason: 'health events need a valid resource' });
        continue;
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
      // Grouping keys only. shop_id above is derived from the token, so a
      // visitor id can join one shop's rows together and can never move a row
      // between shops.
      visitor_id: identityId(visitor_id),
      session_id: identityId(session_id),
      occurred_at: occurred.toISOString(),
    })
  }

  if (!rows.length) {
    return c.json({ error: 'No valid events', rejected }, 400)
  }

  // Reuses the memoised lookup, so a batch that contained a health event has
  // already paid for it and does not query twice.
  const siteId = await resolveSiteId()

  const stamped = rows.map((r) => ({ ...r, site_id: siteId }));

  const { error } = await supabase.from('site_events').insert(stamped);
  if (error) {
    console.error('[events] insert failed:', error.message);
    return c.json({ error: 'Failed to record' }, 500)
  }

  return c.json({ ok: true, accepted: stamped.length, rejected }, 201)
})
