import { Hono } from 'hono'
import { supabase } from '../db.js'

export const bannersRoutes = new Hono()

bannersRoutes.get('/', async (c) => {
  const shopId = c.req.query('shop_id')
  if (!shopId) return c.json({ error: 'shop_id is required' }, 400)

  const { data, error } = await supabase
    .from('banners')
    .select('*')
    .eq('shop_id', shopId)
    .eq('active', true)
    .order('sort_order', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
