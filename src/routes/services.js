import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const servicesRoutes = new Hono()

/**
 * A storefront's published service list.
 *
 * Until 30 Sep 2026 no route in this service read the `services` table at all,
 * which meant a service business had no way to publish anything. A laundry could
 * take orders in Keel and could not show them to a customer.
 *
 * Read-only and token-scoped. `services` has no secrets, but `select('*')` is
 * still not the habit: it publishes every column added in future without anyone
 * reviewing it. That is exactly how `store_settings` came to hand out a shop's
 * Paystack subaccount code.
 */
const PUBLIC_SERVICE_COLUMNS = [
  'id',
  'category',
  'name',
  'pricing_mode',
  'price',
  'unit_label',
  'description',
  'turnaround_hours',
  'image',
]

servicesRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const category = c.req.query('category')

  let query = supabase
    .from('services')
    .select(PUBLIC_SERVICE_COLUMNS.join(','))
    .eq('shop_id', shopId)
    // `visible` is a soft delete: Services.jsx hides a row rather than removing
    // it, because past orders copy the service name and price onto the line and
    // must keep reading correctly. So a hidden service is unpublished, not gone,
    // and the storefront must not list it.
    .eq('visible', true)

  if (category) query = query.eq('category', category)

  // Category then name, so a storefront can render a stable grouped list. Not
  // created_at: a shop re-ordering its price list should not reshuffle its
  // website, and two services created in the same second have no meaningful
  // order anyway.
  query = query.order('category', { ascending: true }).order('name', { ascending: true })

  const { data, error } = await query

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
