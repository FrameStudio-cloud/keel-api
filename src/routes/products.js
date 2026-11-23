import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const productRoutes = new Hono()

/**
 * What a storefront may see of a product.
 *
 * ⚠️ `cost_price` was in this list, so every storefront published the shop's
 * BUYING price — its margin on every item — to anyone who opened the site's
 * JavaScript. Naming the columns is what stopped a wildcard; it does not stop a
 * column that should never have been named. A site has no use for what the shop
 * paid: it prices from `price`.
 */
const PUBLIC_PRODUCT_COLUMNS = [
  'id',
  'name',
  'category',
  'price',
  'stock',
  'barcode',
  'image',
  'created_at',
]

productRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('products')
    .select(PUBLIC_PRODUCT_COLUMNS.join(','))
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
