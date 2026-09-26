import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const productRoutes = new Hono()

productRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('products')
    .select('id, name, category, price, cost_price, stock, barcode, image, created_at')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
