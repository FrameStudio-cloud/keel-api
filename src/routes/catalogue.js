import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const catalogueRoutes = new Hono()

/**
 * Postgres uuid, exactly. Used to gate anything that gets interpolated into a
 * PostgREST filter string.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

catalogueRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const id = c.req.query('id')
  const available = c.req.query('available')

  // A malformed id is a bad request, not a server fault.
  //
  // The id used to go straight into the .or() filter, so `?id=1` reached
  // Postgres, which raised "invalid input syntax for type uuid" and came back
  // as a 500. That is the worst possible shape for this endpoint: a typo in a
  // URL is indistinguishable from the API being down, and the storefront's
  // health lamp reported "API error: 500" for a site that was working fine.
  //
  // Rejecting it here also closes a filter-injection path. `.or()` takes a
  // comma-separated expression, so a crafted id could have injected a second
  // condition and changed which rows matched - the tenant boundary held via the
  // .eq('shop_id', ...) above, but the filter itself was caller-controlled.
  // Only a NON-EMPTY id is validated. An empty ?id= is treated as "no filter",
  // which is what it has always meant - a caller that appends the parameter
  // unconditionally should not start getting a 400.
  if (id && !UUID.test(id)) {
    return c.json({ error: 'id must be a uuid' }, 400)
  }

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
