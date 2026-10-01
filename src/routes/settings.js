import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const settingsRoutes = new Hono()

/**
 * The columns a storefront legitimately needs in order to render itself.
 *
 * This was `select('*')`, which returned all 34 columns of the row - including
 * `paystack_subaccount_code`, the full `paystack_subaccount` jsonb (bank name,
 * business name, account number), `store_phone`, `store_address` and the owner's
 * email inside `notification_preferences`. None of that is needed to draw a shop.
 *
 * Naming the columns is the point: `select('*')` means every column added to
 * store_settings from now on is published to the internet automatically, and
 * nobody reviews it. A new column is a decision, not a side effect.
 *
 * `feature_toggles` is a jsonb of `{ <featureKey>: { enabled: boolean } }` — a
 * shop's own on/off switches, with no credential in it. It was absent here, and
 * the result was not a missing nicety: a storefront gating components on it got
 * nothing back, every gate read `undefined`, and each of those features silently
 * never rendered. Keel showed the owner a working "Back to Top" switch and
 * toggling it did nothing. The keys are the same ones the site's manifest
 * declares under `features`, which is what makes the two halves line up.
 *
 * If a storefront needs a field that is not here, add it deliberately and say why
 * in the commit - do not widen the whole row.
 */
const PUBLIC_SETTINGS = [
  'shop_id',
  'store_name',
  'description',
  'about',
  'tagline',
  'store_phone',
  'whatsapp',
  'store_address',
  'business_hours',
  'currency_symbol',
  'logo_url',
  'instagram',
  'facebook',
  'tiktok',
  'primary_color',
  'secondary_color',
  'accent_color',
  'name_accent',
  'featured_product_ids',
  'website_url',
  'feature_toggles',
]

settingsRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('store_settings')
    .select(PUBLIC_SETTINGS.join(','))
    .eq('shop_id', shopId)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: 'Settings not found' }, 404)

  return c.json(data)
})
