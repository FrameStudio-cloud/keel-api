import { z } from 'zod'
import { supabase } from '../../db.js'
import { paginateQuery } from '../lib/paginate.js'
import { withCache, invalidateCache } from '../lib/cache.js'

function invalidateProductCache() {
  invalidateCache('tool:list_products:')
  invalidateCache('tool:get_dashboard_summary:')
  invalidateCache('tool:get_low_stock_products:')
  invalidateCache('tool:get_slow_moving_stock:')
  invalidateCache('tool:get_profit_margins:')
}

export const listProducts = {
  name: 'list_products',
  description: 'List inventory products with optional search and category filter',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    search: z.string().optional().describe('Search term for product name, category, or barcode'),
    category: z.string().optional().describe('Filter by product category'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum results to return'),
    offset: z.number().int().min(0).default(0).describe('Offset for pagination'),
  },
  handler: withCache(async ({ shop_id, search, category, limit = 50, offset = 0 }) => {
    const extras = []
    if (category) extras.push({ type: 'eq', column: 'category', value: category })

    const { data: products, total } = await paginateQuery({
      table: 'products',
      columns: 'id, name, category, price, cost_price, stock, barcode, image, created_at',
      shop_id,
      page: Math.floor(offset / limit),
      pageSize: limit,
      searchTerm: search,
      searchColumns: ['name', 'category', 'barcode'],
      extraFilters: extras,
    })

    return {
      content: [{ type: 'text', text: JSON.stringify({ products, total, limit, offset }, null, 2) }],
    }
  }, { key: 'tool:list_products', ttl: 30_000 }),
}

export const getProduct = {
  name: 'get_product',
  description: 'Get a single product by ID with full details and attribute values',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    product_id: z.string().uuid().describe('The product ID'),
  },
  handler: withCache(async ({ shop_id, product_id }) => {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('shop_id', shop_id)
      .eq('id', product_id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!product) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Product not found' }) }], isError: true }

    const { data: attrs } = await supabase
      .from('product_attribute_values')
      .select('id, value, attribute:attribute_id(id, name, type)')
      .eq('product_id', product_id)

    return {
      content: [{ type: 'text', text: JSON.stringify({ ...product, attributes: attrs || [] }, null, 2) }],
    }
  }, { key: 'tool:get_product', ttl: 30_000 }),
}

export const createProduct = {
  name: 'create_product',
  description: 'Add a new product to inventory, optionally with category attribute values',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    name: z.string().min(1).describe('Product name'),
    price: z.number().nonnegative().describe('Selling price'),
    stock: z.number().int().min(0).default(0).describe('Initial stock quantity'),
    cost_price: z.number().nonnegative().optional().describe('Cost price for profit calculation'),
    category: z.string().optional().describe('Product category'),
    barcode: z.string().optional().describe('Barcode number'),
    image: z.string().url().optional().describe('Product image URL'),
    attributes: z.array(z.object({
      attribute_id: z.string().uuid().describe('The category attribute ID'),
      value: z.string().min(1).describe('Attribute value (pipe-delimited ||| for multi-value text)'),
    })).optional().describe('Category attribute values for this product'),
  },
  handler: async ({ shop_id, name, price, stock = 0, cost_price, category, barcode, image, attributes }) => {
    const payload = { shop_id, name, price, stock }
    if (cost_price !== undefined) payload.cost_price = cost_price
    if (category) payload.category = category
    if (barcode) payload.barcode = barcode
    if (image) payload.image = image

    const { data, error } = await supabase.from('products').insert(payload).select().single()
    if (error) throw new Error(error.message)

    if (attributes && attributes.length > 0) {
      const attrRows = attributes.map(a => ({
        shop_id,
        product_id: data.id,
        attribute_id: a.attribute_id,
        value: a.value,
      }))

      const { error: attrErr } = await supabase.from('product_attribute_values').insert(attrRows)
      if (attrErr) throw new Error(`Product created but attributes failed: ${attrErr.message}`)
    }

    invalidateProductCache()
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  },
}

export const updateProduct = {
  name: 'update_product',
  description: 'Update an existing product',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    product_id: z.string().uuid().describe('The product ID'),
    name: z.string().min(1).optional().describe('Product name'),
    price: z.number().nonnegative().optional().describe('Selling price'),
    stock: z.number().int().min(0).optional().describe('Stock quantity'),
    cost_price: z.number().nonnegative().optional().describe('Cost price'),
    category: z.string().optional().describe('Product category'),
    barcode: z.string().optional().describe('Barcode number'),
    image: z.string().url().optional().describe('Product image URL'),
  },
  handler: async ({ shop_id, product_id, ...fields }) => {
    const updates = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) updates[k] = v
    }
    if (Object.keys(updates).length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'No fields to update' }) }], isError: true }
    }

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('shop_id', shop_id)
      .eq('id', product_id)
      .select()
      .single()

    if (error) throw new Error(error.message)
    invalidateProductCache()
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  },
}

export const deleteProduct = {
  name: 'delete_product',
  description: 'Delete a product from inventory',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    product_id: z.string().uuid().describe('The product ID'),
  },
  handler: async ({ shop_id, product_id }) => {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('shop_id', shop_id)
      .eq('id', product_id)

    if (error) throw new Error(error.message)
    invalidateProductCache()
    return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, product_id }) }] }
  },
}

export const adjustStock = {
  name: 'adjust_stock',
  description: 'Adjust product stock level atomically — updates stock and logs movement in a single database transaction',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    product_id: z.string().uuid().describe('The product ID'),
    change: z.number().int().describe('Stock change (positive = add stock, negative = remove stock)'),
    reason: z.string().min(1).describe('Reason for the stock adjustment'),
  },
  handler: async ({ shop_id, product_id, change, reason }) => {
    const { data, error } = await supabase.rpc('mcp_adjust_stock', {
      p_shop_id: shop_id,
      p_product_id: product_id,
      p_change: change,
      p_reason: reason,
    })

    if (error) {
      if (error.message.includes('Insufficient stock') || error.message.includes('Product not found')) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }], isError: true }
      }
      throw new Error(error.message)
    }

    invalidateProductCache()
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  },
}

export const findProductByBarcode = {
  name: 'find_product_by_barcode',
  description: 'Look up a product by its barcode',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    barcode: z.string().min(1).describe('The barcode to search for'),
  },
  handler: withCache(async ({ shop_id, barcode }) => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('shop_id', shop_id)
      .eq('barcode', barcode)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return { content: [{ type: 'text', text: JSON.stringify({ found: false }) }] }

    return { content: [{ type: 'text', text: JSON.stringify({ found: true, product: data }, null, 2) }] }
  }, { key: 'tool:find_product_by_barcode', ttl: 15_000 }),
}

export const productTools = [listProducts, getProduct, createProduct, updateProduct, deleteProduct, adjustStock, findProductByBarcode]
