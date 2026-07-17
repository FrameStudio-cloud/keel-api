import { Hono } from 'hono'
import { supabase } from '../db.js'

export const productRoutes = new Hono()

productRoutes.get('/', async (c) => {
  const shopId = c.req.query('shop_id')
  if (!shopId) return c.json({ error: 'shop_id is required' }, 400)

  const { data, error } = await supabase
    .from('products')
    .select('id, name, category, price, cost_price, stock, barcode, image, created_at')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
