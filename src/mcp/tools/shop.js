import { z } from 'zod'
import { supabase } from '../../db.js'
import { withCache, invalidateCache } from '../lib/cache.js'

export const getShopInfo = {
  name: 'get_shop_info',
  description: 'Get shop details including store settings, business category, and subscription info',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
  },
  handler: withCache(async ({ shop_id }) => {
    const [shopRes, settingsRes, configRes] = await Promise.all([
      supabase.from('shops').select('id, name, slug, business_category, subscription_expires_at, category_changed_at').eq('id', shop_id).maybeSingle(),
      supabase.from('store_settings').select('*').eq('shop_id', shop_id).maybeSingle(),
      supabase.from('chat_config').select('plan_tier, enabled, whatsapp_number, widget_color, position').eq('shop_id', shop_id).maybeSingle(),
    ])

    if (shopRes.error) throw new Error(shopRes.error.message)

    const shop = shopRes.data
    if (!shop) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Shop not found' }) }], isError: true }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          shop,
          settings: settingsRes.data || null,
          chat_config: configRes.data || null,
        }, null, 2),
      }],
    }
  }, { key: 'tool:get_shop_info', ttl: 60_000 }),
}

export const updateShopSettings = {
  name: 'update_shop_settings',
  description: 'Update store settings (name, currency, theme, contact info, etc.)',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    store_name: z.string().min(1).optional().describe('Store display name'),
    currency_symbol: z.string().optional().describe('Currency symbol (e.g. KSh, $, €)'),
    theme: z.enum(['light', 'dark']).optional().describe('Theme preference'),
    low_stock_threshold: z.number().int().min(0).optional().describe('Low stock alert threshold'),
    default_payment: z.string().optional().describe('Default payment method'),
    website_url: z.string().optional().describe('Store website URL'),
    whatsapp: z.string().optional().describe('WhatsApp number'),
    email: z.string().email().optional().describe('Store email address'),
    store_phone: z.string().optional().describe('Store phone number'),
    store_address: z.string().optional().describe('Store physical address'),
    receipt_footer: z.string().optional().describe('Text to print on receipts'),
  },
  handler: async ({ shop_id, ...fields }) => {
    const updates = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) updates[k] = v
    }
    if (Object.keys(updates).length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'No fields to update' }) }], isError: true }
    }

    const { data, error } = await supabase
      .from('store_settings')
      .upsert({ shop_id, ...updates }, { onConflict: 'shop_id' })
      .select()
      .single()

    if (error) throw new Error(error.message)
    invalidateCache('tool:get_shop_info:')
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  },
}

export const listCategories = {
  name: 'list_categories',
  description: 'List all business categories with their attributes',
  params: {},
  handler: withCache(async () => {
    const [catRes, attrRes] = await Promise.all([
      supabase.from('categories').select('id, name, slug').order('name', { ascending: true }),
      supabase.from('category_attributes').select('id, category_id, name, type, options, required, sort_order').order('sort_order', { ascending: true }),
    ])

    if (catRes.error) throw new Error(catRes.error.message)
    if (attrRes.error) throw new Error(attrRes.error.message)

    const attrsByCat = {}
    for (const a of attrRes.data || []) {
      attrsByCat[a.category_id] = attrsByCat[a.category_id] || []
      attrsByCat[a.category_id].push(a)
    }

    const categories = (catRes.data || []).map(c => ({
      ...c,
      attributes: attrsByCat[c.id] || [],
    }))

    return { content: [{ type: 'text', text: JSON.stringify({ categories }, null, 2) }] }
  }, { key: 'tool:list_categories', ttl: 300_000 }),
}

export const getCategoryAttributes = {
  name: 'get_category_attributes',
  description: 'Get attributes for a specific business category by slug',
  params: {
    category_slug: z.string().min(1).describe('The category slug (e.g. clothing, electronics, wigs)'),
  },
  handler: withCache(async ({ category_slug }) => {
    const { data: cat, error: catErr } = await supabase
      .from('categories')
      .select('id, name, slug')
      .eq('slug', category_slug)
      .maybeSingle()

    if (catErr) throw new Error(catErr.message)
    if (!cat) return { content: [{ type: 'text', text: JSON.stringify({ error: `Category "${category_slug}" not found` }) }], isError: true }

    const { data: attrs } = await supabase
      .from('category_attributes')
      .select('id, name, type, options, required, sort_order')
      .eq('category_id', cat.id)
      .order('sort_order', { ascending: true })

    return { content: [{ type: 'text', text: JSON.stringify({ category: cat, attributes: attrs || [] }, null, 2) }] }
  }, { key: 'tool:get_category_attributes', ttl: 300_000 }),
}

export const listCatalogue = {
  name: 'list_catalogue',
  description: 'List published catalogue items for the shop',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
    available_only: z.boolean().default(false).describe('Filter to only available items'),
    featured_only: z.boolean().default(false).describe('Filter to only featured items'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum results'),
  },
  handler: withCache(async ({ shop_id, available_only = false, featured_only = false, limit = 50 }) => {
    let query = supabase
      .from('catalogue')
      .select('*')
      .eq('shop_id', shop_id)

    if (available_only) query = query.eq('available', true)
    if (featured_only) query = query.eq('featured', true)

    query = query.order('created_at', { ascending: false }).limit(limit)

    const { data, error } = await query
    if (error) throw new Error(error.message)

    return { content: [{ type: 'text', text: JSON.stringify({ catalogue: data || [], count: (data || []).length }, null, 2) }] }
  }, { key: 'tool:list_catalogue', ttl: 30_000 }),
}

export const listBanners = {
  name: 'list_banners',
  description: 'List active banners for the shop website',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
  },
  handler: withCache(async ({ shop_id }) => {
    const { data, error } = await supabase
      .from('banners')
      .select('*')
      .eq('shop_id', shop_id)
      .eq('active', true)
      .order('sort_order', { ascending: true })

    if (error) throw new Error(error.message)
    return { content: [{ type: 'text', text: JSON.stringify({ banners: data || [] }, null, 2) }] }
  }, { key: 'tool:list_banners', ttl: 60_000 }),
}

export const getChatConfig = {
  name: 'get_chat_config',
  description: 'Get the chat widget configuration and FAQs for the shop',
  params: {
    shop_id: z.string().uuid().describe('The shop ID'),
  },
  handler: withCache(async ({ shop_id }) => {
    const [configRes, faqsRes] = await Promise.all([
      supabase.from('chat_config').select('*').eq('shop_id', shop_id).maybeSingle(),
      supabase.from('chat_faqs').select('*').eq('shop_id', shop_id).order('sort_order', { ascending: true }).limit(200),
    ])

    if (configRes.error) throw new Error(configRes.error.message)
    if (faqsRes.error) throw new Error(faqsRes.error.message)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ config: configRes.data || null, faqs: faqsRes.data || [] }, null, 2),
      }],
    }
  }, { key: 'tool:get_chat_config', ttl: 60_000 }),
}

export const shopTools = [getShopInfo, updateShopSettings, listCategories, getCategoryAttributes, listCatalogue, listBanners, getChatConfig]
