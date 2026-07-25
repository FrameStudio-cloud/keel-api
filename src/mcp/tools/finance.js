import { z } from 'zod'
import { supabase } from '../../db.js'
import { paginateQuery } from '../lib/paginate.js'
import { withCache, invalidateCache } from '../lib/cache.js'

function invalidateFinanceCache() {
  invalidateCache('tool:list_expenses:')
  invalidateCache('tool:get_profit_loss:')
  invalidateCache('tool:get_dashboard_summary:')
}

export const listExpenses = {
  name: 'list_expenses',
  description: 'List expenses with optional date range and category filter',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    start_date: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
    category: z.string().optional().describe('Filter by expense category'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum results'),
    offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
  },
  handler: withCache(async ({ shop_id, start_date, end_date, category, limit = 50, offset = 0 }) => {
    const extras = []
    if (category) extras.push({ type: 'eq', column: 'category', value: category })
    if (start_date) extras.push({ type: 'gte', column: 'expense_date', value: start_date })
    if (end_date) extras.push({ type: 'lte', column: 'expense_date', value: end_date })

    const { data: expenses, total } = await paginateQuery({
      table: 'expenses',
      shop_id,
      page: Math.floor(offset / limit),
      pageSize: limit,
      extraFilters: extras,
    })

    return {
      content: [{ type: 'text', text: JSON.stringify({ expenses, total, limit, offset }, null, 2) }],
    }
  }, { key: 'tool:list_expenses', ttl: 30_000 }),
}

export const createExpense = {
  name: 'create_expense',
  description: 'Record a new business expense',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    description: z.string().min(1).describe('Expense description'),
    amount: z.number().nonnegative().describe('Expense amount'),
    category: z.string().default('General').describe('Expense category'),
    payment_method: z.string().default('Cash').describe('Payment method used'),
    expense_date: z.string().optional().describe('Date of expense (YYYY-MM-DD), defaults to today'),
  },
  handler: async ({ shop_id, description, amount, category = 'General', payment_method = 'Cash', expense_date }) => {
    const payload = { shop_id, description, amount, category, payment_method }
    if (expense_date) payload.expense_date = expense_date

    const { data, error } = await supabase.from('expenses').insert(payload).select().single()
    if (error) throw new Error(error.message)

    invalidateFinanceCache()
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  },
}

export const getProfitLoss = {
  name: 'get_profit_loss',
  description: 'Get profit and loss summary for a date range',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    start_date: z.string().describe('Start date (YYYY-MM-DD or ISO 8601)'),
    end_date: z.string().describe('End date (YYYY-MM-DD or ISO 8601)'),
  },
  handler: withCache(async ({ shop_id, start_date, end_date }) => {
    const [salesRes, expensesRes] = await Promise.all([
      supabase
        .from('sales')
        .select('amount, method, quantity')
        .eq('shop_id', shop_id)
        .gte('created_at', start_date)
        .lte('created_at', end_date)
        .limit(2000),
      supabase
        .from('expenses')
        .select('amount, category')
        .eq('shop_id', shop_id)
        .gte('expense_date', start_date)
        .lte('expense_date', end_date)
        .limit(2000),
    ])

    if (salesRes.error) throw new Error(salesRes.error.message)
    if (expensesRes.error) throw new Error(expensesRes.error.message)

    const sales = salesRes.data || []
    const expenses = expensesRes.data || []

    const totalRevenue = sales.reduce((sum, s) => sum + Number(s.amount), 0)
    const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0)
    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0)

    const byMethod = {}
    for (const s of sales) {
      byMethod[s.method] = (byMethod[s.method] || 0) + Number(s.amount)
    }

    const byCategory = {}
    for (const e of expenses) {
      byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount)
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          period: { start: start_date, end: end_date },
          revenue: { total: totalRevenue, total_quantity: totalQuantity, by_payment_method: byMethod },
          expenses: { total: totalExpenses, by_category: byCategory },
          net_profit: totalRevenue - totalExpenses,
          transaction_count: { sales: sales.length, expenses: expenses.length },
        }, null, 2),
      }],
    }
  }, { key: 'tool:get_profit_loss', ttl: 30_000 }),
}

export const financeTools = [listExpenses, createExpense, getProfitLoss]
