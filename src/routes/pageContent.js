import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const pageContentRoutes = new Hono()

/**
 * What a storefront may see of a content section.
 *
 * `select('*')` was here. `content` is the jsonb block the site renders, so the
 * table's shape is the copy itself — but the rule still applies: a future
 * `internal_notes` or `published_by` column must not appear on a public site
 * because nobody reviewed a wildcard. `shop_id` is omitted for the same reason
 * as everywhere else: the token names the shop.
 */
const PUBLIC_PAGE_CONTENT_COLUMNS = [
  'id',
  'page_key',
  'section_key',
  'content',
  'created_at',
  'updated_at',
]

pageContentRoutes.get('/', async (c) => {
  const shopId = shopIdOf(c)

  const page = c.req.query('page')
  const section = c.req.query('section')

  let query = supabase
    .from('page_content')
    .select(PUBLIC_PAGE_CONTENT_COLUMNS.join(','))
    .eq('shop_id', shopId)

  if (page) {
    // Page-scoped: the original model, still used by kikoi and anything else
    // that addresses content by page + section.
    query = query.eq('page_key', page)
  } else if (section) {
    // Section-scoped: the new model, where the section alone identifies a row.
    //
    // The `page_key is null` filter is the whole point. `section_key` is NOT
    // unique across both models — a shop can hold a legacy `('about', 'hero')`
    // row AND a section-addressed `(null, 'hero')` row, and they would otherwise
    // be indistinguishable. Found live: a laundry shop had 11 leftover rows
    // copied from a clothing template, and `?section=hero` served
    // "Woven on the Kenyan Coast, Worn Around the World" as its headline.
    query = query.eq('section_key', section).is('page_key', null)
  } else {
    // Neither given. Returning every row would leak content the caller cannot
    // address and does not need; an empty array is the honest answer.
    return c.json([])
  }

  if (page && section) query = query.eq('section_key', section)

  const { data, error } = await query

  if (error) return c.json({ error: error.message }, 500)

  return c.json(data || [])
})
