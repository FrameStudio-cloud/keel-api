import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const bannersRoutes = new Hono()

/**
 * What a storefront may see of a banner.
 *
 * `select('*')` was here. Every column on this table happens to be display data
 * today, which is exactly the argument that ages badly — the rule is that a new
 * column is a decision, not something a wildcard publishes the day someone adds
 * it. `shop_id` is deliberately absent: the token already names the shop, and
 * echoing it implies a multi-tenant response that never exists.
 */
const PUBLIC_BANNER_COLUMNS = [
  'id',
  'type',
  'title',
  'subtitle',
  'message',
  'image_url',
  'link_url',
  'active',
  'sort_order',
]

bannersRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('banners')
    .select(PUBLIC_BANNER_COLUMNS.join(','))
    .eq('shop_id', shopId)
    .eq('active', true)
    .order('sort_order', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
