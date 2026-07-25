import { z } from 'zod'
import { supabase } from '../../db.js'
import { withCache } from '../lib/cache.js'

export const getDashboardSummary = {
  name: 'get_dashboard_summary',
  description: 'Get the KPI overview for the dashboard — today\'s sales, total products, low stock count, chart data, top products',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    low_stock_threshold: z.number().int().min(0).default(6).describe('Threshold for low stock alerts'),
  },
  handler: withCache(async ({ shop_id, low_stock_threshold = 6 }) => {
    const { data, error } = await supabase.rpc('get_dashboard_summary', {
      p_shop_id: shop_id,
      p_threshold: low_stock_threshold,
    })

    if (error) throw new Error(error.message)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }, { key: 'tool:get_dashboard_summary', ttl: 30_000 }),
}

export const getProfitMargins = {
  name: 'get_profit_margins',
  description: 'Get profit margins per product — revenue, cost, profit, and margin percentage',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
  },
  handler: withCache(async ({ shop_id }) => {
    const { data, error } = await supabase.rpc('get_profit_margins', { p_shop_id: shop_id })

    if (error) throw new Error(error.message)
    return { content: [{ type: 'text', text: JSON.stringify(data || [], null, 2) }] }
  }, { key: 'tool:get_profit_margins', ttl: 60_000 }),
}

export const getLowStockProducts = {
  name: 'get_low_stock_products',
  description: 'Get products with stock at or below a threshold',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    threshold: z.number().int().min(0).default(6).describe('Stock threshold'),
  },
  handler: withCache(async ({ shop_id, threshold = 6 }) => {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, category, price, stock, image')
      .eq('shop_id', shop_id)
      .lte('stock', threshold)
      .order('stock', { ascending: true })
      .limit(200)

    if (error) throw new Error(error.message)
    const products = data || []

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: products.length, threshold, products }, null, 2),
      }],
    }
  }, { key: 'tool:get_low_stock_products', ttl: 30_000 }),
}

export const getSlowMovingStock = {
  name: 'get_slow_moving_stock',
  description: 'Find products with low or no sales in the last 30 days',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    min_sales: z.number().int().min(0).default(3).describe('Minimum sales count to not be considered slow-moving'),
  },
  handler: withCache(async ({ shop_id, min_sales = 3 }) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()

    const { data: salesData, error: salesErr } = await supabase
      .from('sales')
      .select('product_id, product_name')
      .eq('shop_id', shop_id)
      .gte('created_at', thirtyDaysAgo)
      .limit(5000)

    if (salesErr) throw new Error(salesErr.message)

    const soldCount = {}
    for (const s of salesData || []) {
      soldCount[s.product_id] = (soldCount[s.product_id] || 0) + 1
    }

    const { data: allProducts, error: productsErr } = await supabase
      .from('products')
      .select('id, name, category, price, stock')
      .eq('shop_id', shop_id)
      .limit(5000)

    if (productsErr) throw new Error(productsErr.message)

    const slow = (allProducts || [])
      .filter(p => (soldCount[p.id] || 0) < min_sales)
      .map(p => ({ ...p, sales_30d: soldCount[p.id] || 0 }))
      .sort((a, b) => a.sales_30d - b.sales_30d)
      .slice(0, 10)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ min_sales_threshold: min_sales, slow_moving_products: slow }, null, 2),
      }],
    }
  }, { key: 'tool:get_slow_moving_stock', ttl: 60_000 }),
}

export const reportsTools = [getDashboardSummary, getProfitMargins, getLowStockProducts, getSlowMovingStock]
