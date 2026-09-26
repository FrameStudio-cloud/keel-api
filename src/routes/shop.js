import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const shopRoutes = new Hono()

/**
 * Was previously an unauthenticated tenant enumeration: it returned id, name
 * and slug for every shop on the platform. Removed — a site already knows which
 * shop it belongs to via its site token, so there is no legitimate caller.
 *
 * If a site is mid-migration and still needs to resolve its own shop from a
 * slug, use /api/shop (below), which is now scoped to the caller's own shop.
 */

// GET /api/shop -> the caller's own shop only.
shopRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('shops')
    .select('id, name, slug, business_category')
    .eq('id', shopId)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: 'Shop not found' }, 404)

  return c.json(data)
})
