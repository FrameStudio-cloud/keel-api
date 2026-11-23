import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const contentRoutes = new Hono()

/**
 * Content ideas for the marketing composer, and nothing else.
 *
 * POST /captions lived here until 24 Nov 2026. It generated Instagram captions
 * with an LLM, reachable by a credential that ships in the storefront's public
 * JavaScript — so any visitor could make Keel spend Groq money, and a rate limit
 * was the only thing standing in the way of that. Writing captions is a dashboard
 * job (the dashboard already does it through an edge function), no storefront
 * called the route, and a storefront never needs to generate copy about its own
 * products. Removed rather than scoped: a scope would have made an endpoint that
 * should not exist on this API safe to have.
 */

contentRoutes.get('/ideas', async (c) => {
  const shopId = shopIdOf(c)

  const { data: settings } = await supabase
    .from('store_settings')
    .select('low_stock_threshold')
    .eq('shop_id', shopId)
    .maybeSingle()

  const threshold = settings?.low_stock_threshold ?? 5

  const [newArrivals, bestSellers, lowStock] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, price, image, stock, created_at')
      .eq('shop_id', shopId)
      .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      .order('created_at', { ascending: false })
      .limit(10),

    supabase
      .from('products')
      .select('id, name, price, image, stock')
      .eq('shop_id', shopId)
      .order('created_at', { ascending: false })
      .limit(200),

    supabase
      .from('products')
      .select('id, name, price, image, stock')
      .eq('shop_id', shopId)
      .lte('stock', threshold)
      .order('stock', { ascending: true })
      .limit(10),
  ])

  const ideas = []

  if (newArrivals.data) {
    for (const p of newArrivals.data) {
      ideas.push({
        type: 'new_arrival',
        productId: p.id,
        name: p.name,
        price: p.price,
        image: p.image,
        stock: p.stock,
        reason: 'Just added to your inventory',
        createdAt: p.created_at,
      })
    }
  }

  if (lowStock.data) {
    for (const p of lowStock.data) {
      if (!ideas.some(i => i.productId === p.id)) {
        ideas.push({
          type: 'low_stock',
          productId: p.id,
          name: p.name,
          price: p.price,
          image: p.image,
          stock: p.stock,
          reason: `Only ${p.stock} remaining`,
          createdAt: null,
        })
      }
    }
  }

  if (bestSellers.data && bestSellers.data.length > 0) {
    const ids = bestSellers.data.map(p => p.id)
    const { data: salesData } = await supabase
      .from('sales')
      .select('product_id, product_name')
      .in('product_id', ids)
      .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())

    const salesCount = {}
    if (salesData) {
      for (const s of salesData) {
        salesCount[s.product_id] = (salesCount[s.product_id] || 0) + 1
      }
    }

    const sorted = [...bestSellers.data]
      .map(p => ({ ...p, salesCount: salesCount[p.id] || 0 }))
      .filter(p => p.salesCount > 0)
      .sort((a, b) => b.salesCount - a.salesCount)
      .slice(0, 10)

    for (const p of sorted) {
      if (!ideas.some(i => i.productId === p.id)) {
        ideas.push({
          type: 'best_seller',
          productId: p.id,
          name: p.name,
          price: p.price,
          image: p.image,
          stock: p.stock,
          reason: `${p.salesCount} sold this month`,
          createdAt: null,
        })
      }
    }
  }

  ideas.sort((a, b) => {
    const order = { new_arrival: 0, low_stock: 1, best_seller: 2 }
    if (order[a.type] !== order[b.type]) return order[a.type] - order[b.type]
    if (a.createdAt && b.createdAt) return new Date(b.createdAt) - new Date(a.createdAt)
    return 0
  })

  return c.json(ideas.slice(0, 20))
})
