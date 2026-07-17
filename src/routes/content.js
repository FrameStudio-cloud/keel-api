import { Hono } from 'hono'
import { supabase } from '../db.js'

export const contentRoutes = new Hono()

contentRoutes.get('/ideas', async (c) => {
  const shopId = c.req.query('shop_id')
  if (!shopId) return c.json({ error: 'shop_id is required' }, 400)

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

contentRoutes.post('/captions', async (c) => {
  const { shopId, productNames, shopName, tone } = await c.req.json()
  if (!shopId || !productNames || productNames.length === 0) {
    return c.json({ error: 'shop_id and productNames are required' }, 400)
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return c.json({ error: 'GROQ_API_KEY not configured' }, 500)

  const { data: settings } = await supabase
    .from('store_settings')
    .select('store_name, whatsapp')
    .eq('shop_id', shopId)
    .maybeSingle()

  const storeName = shopName || settings?.store_name || 'our shop'
  const whatsapp = settings?.whatsapp || ''
  const productList = productNames.join(', ')

  const toneInstructions = {
    professional: 'Write in a professional, polished tone. Suitable for a business Instagram page.',
    casual: 'Write in a friendly, conversational Kenyan social media tone. Relaxed and relatable.',
    urgent: 'Create urgency and FOMO. Focus on limited stock, time sensitivity, and act-now language.',
  }

  const toneGuide = toneInstructions[tone] || toneInstructions.casual

  const systemPrompt = `You are a social media content writer for ${storeName}, a Kenyan shop. 
Generate exactly 3 Instagram caption options for the following products: ${productList}.

${toneGuide}

For each caption option, also suggest 5-8 relevant hashtags.

Respond with valid JSON only (no markdown, no code fences):
{
  "options": [
    {
      "text": "caption text here...",
      "hashtags": "#hashtag1 #hashtag2 #hashtag3"
    }
  ]
}

Keep each caption under 280 characters. Make them engaging and shoppable. Do NOT use emojis unless the tone is casual.`

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mixtral-8x7b-32768',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Write 3 Instagram captions for: ${productList}` },
        ],
        temperature: 0.8,
        max_tokens: 2048,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Groq API error:', err)
      return c.json({ error: 'AI service error' }, 502)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return c.json({ error: 'Empty AI response' }, 502)

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = {
        options: [
          { text: content, hashtags: '' },
          { text: '', hashtags: '' },
          { text: '', hashtags: '' },
        ],
      }
    }

    return c.json(parsed)
  } catch (err) {
    console.error('Caption generation error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})
