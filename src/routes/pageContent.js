import { Hono } from 'hono'
import { supabase } from '../db.js'

export const pageContentRoutes = new Hono()

pageContentRoutes.get('/', async (c) => {
  const shopId = c.req.query('shop_id')
  if (!shopId) return c.json({ error: 'shop_id is required' }, 400)

  const page = c.req.query('page')
  const section = c.req.query('section')

  let query = supabase
    .from('page_content')
    .select('*')
    .eq('shop_id', shopId)

  if (page) {
    query = query.eq('page_key', page)
  }
  if (section) {
    query = query.eq('section_key', section)
  }

  const { data, error } = await query

  if (error) return c.json({ error: error.message }, 500)

  return c.json(data || [])
})
