import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf } from '../auth.js'

export const chatRoutes = new Hono()

/**
 * The chat widget's own configuration, and nothing else.
 *
 * This was `select('*')` on a table that also holds `groq_api_key`,
 * `whatsapp_token`, `whatsapp_verify_token` and `whatsapp_pin`. Verified live
 * while the hostname fallback still existed: the route answered an
 * unauthenticated request with 20 fields. The secrets on the probed shop were
 * empty, so nothing actually leaked - but the first shop to set a bring-your-own
 * Groq key or connect a WhatsApp number would have published it, and nobody would
 * have reviewed the change, because `select('*')` requires no change to make.
 */
const PUBLIC_CHAT_CONFIG = [
  'shop_id',
  'enabled',
  'welcome_message',
  'widget_color',
  'position',
  'whatsapp_number',
  'quick_replies',
  'whatsapp_bot_enabled',
  'whatsapp_bot_number',
]

chatRoutes.get('/config', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('chat_config')
    .select(PUBLIC_CHAT_CONFIG.join(','))
    .eq('shop_id', shopId)
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

chatRoutes.get('/faqs', async (c) => {
  const shopId = shopIdOf(c)

  const { data, error } = await supabase
    .from('chat_faqs')
    .select('*')
    .eq('shop_id', shopId)
    .order('sort_order', { ascending: true })
    .limit(200)

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

chatRoutes.get('/messages', async (c) => {
  const shopId = shopIdOf(c)
  const ids = c.req.query('ids')
  if (!ids) return c.json([])

  const idList = ids.split(',').filter(Boolean)
  if (idList.length === 0) return c.json([])
  // Bound the list: this used to be unbounded, so `?ids=1,2,3,...` walked the
  // whole table in one request.
  if (idList.length > 100) return c.json({ error: 'Too many ids' }, 400)

  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .in('id', idList)
    // The filter that was missing. Without it this route resolved whichever shop
    // the caller authenticated as, then returned messages for every shop whose id
    // appeared in the list - a cross-tenant read reachable with any valid token,
    // or with none at all back when the hostname fallback existed. Ids are
    // sequential, so enumeration is trivial.
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

chatRoutes.post('/callbacks', async (c) => {
  const shopId = shopIdOf(c)
  const body = await c.req.json()
  if (!body.name || !body.phone) {
    return c.json({ error: 'name and phone are required' }, 400)
  }

  const { error } = await supabase.from('chat_callbacks').insert({
    // Derived from the token, never from the body. This used to be
    // `body.shop_id`, which let a write-token holder file a callback against
    // any other tenant.
    shop_id: shopId,
    name: body.name,
    phone: body.phone,
    question: body.question || '',
    status: 'pending',
  })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

chatRoutes.post('/answer', async (c) => {
  const { shopContext, question } = await c.req.json()
  if (!question) return c.json({ error: 'question is required' }, 400)

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return c.json({ error: 'GROQ_API_KEY not configured' }, 500)

  const productsBlock = shopContext?.products?.length
    ? shopContext.products.map(p =>
        `- ${p.name} (${p.category}) — Ksh ${p.price}${p.inStock ? '' : ' — OUT OF STOCK'}`
      ).join('\n')
    : 'No products available.'

  const faqsBlock = shopContext?.faqs?.length
    ? shopContext.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : 'No FAQs available.'

  const systemPrompt = `You are a friendly Kenyan shop assistant for ${shopContext?.shopName || 'the shop'}. Answer customer questions based ONLY on the shop information provided below. Be conversational, use Kenyan English, and keep responses concise.

Shop Information:
- Name: ${shopContext?.shopName || 'N/A'}
- Description: ${shopContext?.description || 'N/A'}
- Location: ${shopContext?.location || 'N/A'}
- Hours: ${shopContext?.hours || 'N/A'}
- Delivery: ${shopContext?.deliveryInfo || 'N/A'}

Products Available:
${productsBlock}

FAQs:
${faqsBlock}

Respond with valid JSON only (no markdown, no code fences):
{
  "answer": "your friendly response here",
  "outOfStockProduct": null or "product name if a requested item is out of stock",
  "suggestedAlternative": null or "alternative product name if applicable",
  "orderReady": false or true if customer clearly wants to order,
  "orderItems": null or [{ "name": "product name", "quantity": 1, "price": 0 }]
}`

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
          { role: 'user', content: question },
        ],
        temperature: 0.7,
        max_tokens: 1024,
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
      parsed = { answer: content, outOfStockProduct: null, suggestedAlternative: null, orderReady: false, orderItems: null }
    }

    return c.json(parsed)
  } catch (err) {
    console.error('Chat answer error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

chatRoutes.post('/stock-alerts', async (c) => {
  const shopId = shopIdOf(c)
  const body = await c.req.json()
  if (!body.product_name) {
    return c.json({ error: 'product_name is required' }, 400)
  }

  const { error } = await supabase.from('chat_stock_alerts').insert({
    // Token-derived, not body-derived: see the note on /callbacks.
    shop_id: shopId,
    product_name: body.product_name,
    customer_note: body.customer_note || '',
    status: 'pending',
  })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})
