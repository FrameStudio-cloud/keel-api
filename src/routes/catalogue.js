import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const catalogueRoutes = new Hono()

catalogueRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const id = c.req.query('id')
  const available = c.req.query('available')

  let query = supabase
    .from('catalogue')
    .select('*')
    .eq('shop_id', shopId)

  if (id) query = query.or(`id.eq.${id},product_id.eq.${id}`)
  if (available === 'true') query = query.eq('available', true)

  query = query.order('created_at', { ascending: false })

  const { data, error } = await query

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})
