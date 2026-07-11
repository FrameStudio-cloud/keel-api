import { Hono } from 'hono'
import { supabase } from '../db.js'

export const settingsRoutes = new Hono()

settingsRoutes.get('/', async (c) => {
  const shopId = c.req.query('shop_id')
  if (!shopId) return c.json({ error: 'shop_id is required' }, 400)

  const { data, error } = await supabase
    .from('store_settings')
    .select('*')
    .eq('shop_id', shopId)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: 'Settings not found' }, 404)

  return c.json(data)
})
