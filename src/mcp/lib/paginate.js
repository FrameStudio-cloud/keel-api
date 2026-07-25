import { supabase } from '../../db.js'

export async function paginateQuery({
  table,
  columns = '*',
  shop_id,
  page = 0,
  pageSize = 50,
  orderBy = 'created_at',
  ascending = false,
  searchTerm,
  searchColumns = [],
  extraFilters = [],
}) {
  let query = supabase
    .from(table)
    .select(columns, { count: 'exact' })
    .eq('shop_id', shop_id)

  if (searchTerm && searchColumns.length > 0) {
    const escaped = searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_')
    const conditions = searchColumns.map(col => `${col}.ilike.%${escaped}%`).join(',')
    query = query.or(conditions)
  }

  for (const filter of extraFilters) {
    if (filter.type === 'eq') query = query.eq(filter.column, filter.value)
    else if (filter.type === 'gte') query = query.gte(filter.column, filter.value)
    else if (filter.type === 'lte') query = query.lte(filter.column, filter.value)
    else if (filter.type === 'in') query = query.in(filter.column, filter.value)
  }

  const from = page * pageSize
  const to = from + pageSize - 1

  const { data, error, count } = await query
    .order(orderBy, { ascending })
    .range(from, to)

  if (error) throw new Error(error.message)

  return { data: data || [], total: count ?? 0, page, pageSize }
}
