import { Hono } from 'hono'
import { supabase } from '../db.js'

export const shopRoutes = new Hono()

shopRoutes.get('/list', async (c) => {
  const { data, error } = await supabase
    .from('shops')
    .select('id, name, slug')
    .order('name', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

shopRoutes.get('/', async (c) => {
  const slug = c.req.query('slug')
  if (!slug) return c.json({ error: 'slug is required' }, 400)

  const { data, error } = await supabase
    .from('shops')
    .select('id, name, slug, business_category')
    .eq('slug', slug)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: 'Shop not found' }, 404)

  return c.json(data)
})
