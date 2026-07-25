import { z } from 'zod'
import { supabase } from '../../db.js'
import { paginateQuery } from '../lib/paginate.js'
import { withCache, invalidateCache } from '../lib/cache.js'

function invalidateSalesCache() {
  invalidateCache('tool:list_sales:')
  invalidateCache('tool:get_daily_sales_summary:')
  invalidateCache('tool:get_dashboard_summary:')
  invalidateCache('tool:get_profit_loss:')
  invalidateCache('tool:get_profit_margins:')
  invalidateCache('tool:get_slow_moving_stock:')
}

export const listSales = {
  name: 'list_sales',
  description: 'List sales records with optional date range, payment method, and search',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    start_date: z.string().optional().describe('Start date filter (ISO 8601)'),
    end_date: z.string().optional().describe('End date filter (ISO 8601)'),
    method: z.string().optional().describe('Filter by payment method (e.g. Cash, M-Pesa)'),
    search: z.string().optional().describe('Search by product name'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum results'),
    offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
  },
  handler: withCache(async ({ shop_id, start_date, end_date, method, search, limit = 50, offset = 0 }) => {
    const extras = []
    if (method) extras.push({ type: 'eq', column: 'method', value: method })
    if (start_date) extras.push({ type: 'gte', column: 'created_at', value: start_date })
    if (end_date) extras.push({ type: 'lte', column: 'created_at', value: end_date })

    const { data: sales, total } = await paginateQuery({
      table: 'sales',
      shop_id,
      page: Math.floor(offset / limit),
      pageSize: limit,
      searchTerm: search,
      searchColumns: ['product_name', 'method'],
      extraFilters: extras,
    })

    return {
      content: [{ type: 'text', text: JSON.stringify({ sales, total, limit, offset }, null, 2) }],
    }
  }, { key: 'tool:list_sales', ttl: 30_000 }),
}

export const logSale = {
  name: 'log_sale',
  description: 'Record a new sale atomically — creates sale, deducts stock, logs movement in a single database transaction',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    product_id: z.string().uuid().describe('The product ID being sold'),
    product_name: z.string().min(1).describe('Product name (for the sale record)'),
    amount: z.number().nonnegative().describe('Total sale amount'),
    quantity: z.number().int().min(1).default(1).describe('Quantity sold'),
    method: z.string().default('Cash').describe('Payment method (Cash, M-Pesa, Bank, etc.)'),
    mpesa_code: z.string().optional().describe('M-Pesa transaction code if applicable'),
  },
  handler: async ({ shop_id, product_id, product_name, amount, quantity = 1, method = 'Cash', mpesa_code }) => {
    const { data, error } = await supabase.rpc('mcp_log_sale', {
      p_shop_id: shop_id,
      p_product_id: product_id,
      p_product_name: product_name,
      p_amount: amount,
      p_quantity: quantity,
      p_method: method,
      p_mpesa_code: mpesa_code || null,
    })

    if (error) {
      if (error.message.includes('Insufficient stock') || error.message.includes('Product not found')) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }], isError: true }
      }
      throw new Error(error.message)
    }

    invalidateSalesCache()
    return { content: [{ type: 'text', text: JSON.stringify({ sale: data }, null, 2) }] }
  },
}

export const getDailySalesSummary = {
  name: 'get_daily_sales_summary',
  description: 'Get today\'s sales summary with totals by payment method',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
  },
  handler: withCache(async ({ shop_id }) => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(todayStart)
    todayEnd.setHours(23, 59, 59, 999)

    const { data, error } = await supabase
      .from('sales')
      .select('amount, quantity, method')
      .eq('shop_id', shop_id)
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString())

    if (error) throw new Error(error.message)

    const sales = data || []
    const byMethod = {}
    let totalAmount = 0
    let totalQuantity = 0

    for (const s of sales) {
      totalAmount += Number(s.amount) || 0
      totalQuantity += s.quantity || 0
      byMethod[s.method] = byMethod[s.method] || { amount: 0, count: 0 }
      byMethod[s.method].amount += Number(s.amount) || 0
      byMethod[s.method].count += 1
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          date: todayStart.toISOString().slice(0, 10),
          total_sales: sales.length,
          total_amount: totalAmount,
          total_quantity: totalQuantity,
          by_payment_method: byMethod,
        }, null, 2),
      }],
    }
  }, { key: 'tool:get_daily_sales_summary', ttl: 15_000 }),
}

export const salesTools = [listSales, logSale, getDailySalesSummary]
