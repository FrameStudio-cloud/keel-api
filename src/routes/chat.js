import { Hono } from 'hono'
import { supabase } from '../db.js'
import { shopIdOf, rateLimit } from '../auth.js'
import { groqChat } from '../groq.js'

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

const PUBLIC_FAQ_COLUMNS = ['id', 'question', 'answer', 'sort_order', 'created_at']

/**
 * `chat_messages` is the wildcard that actually mattered: it carries
 * `customer_name`, and any future `customer_phone` or `customer_email` column
 * would have been published to every storefront with no code change to review.
 * `shop_id` is omitted — the token already names the shop.
 */
const PUBLIC_MESSAGE_COLUMNS = [
  'id',
  'question',
  'answer',
  'status',
  'customer_name',
  'feedback',
  'created_at',
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
    .select(PUBLIC_FAQ_COLUMNS.join(','))
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
    .select(PUBLIC_MESSAGE_COLUMNS.join(','))
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

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * A day with no hours is OMITTED, never printed as "Closed".
 *
 * A shop that never configured Tuesday has not told us it is closed on Tuesday.
 * Same rule the Telegram bot follows — a bot that guesses the timetable is a bot
 * that tells a customer the shop is open at 3am.
 */
function hoursLine(businessHours) {
  if (!businessHours || typeof businessHours !== 'object') return 'not published'
  const parts = DAY_ORDER.filter((d) => businessHours[d]?.active).map(
    (d) => `${d.toUpperCase()} ${businessHours[d].open}–${businessHours[d].close}`
  )
  return parts.length ? parts.join(' · ') : 'not published'
}

/**
 * Shop facts for a widget answer, built from the TOKEN's shop.
 *
 * This route used to build its prompt from `body.shopContext`. No database was
 * read, so it was never a tenant leak — but it did make the route an open LLM
 * proxy: a site token ships in a storefront's public JS, so anyone holding one
 * could send arbitrary context and spend Keel's Groq budget on it. Context now
 * comes from the shop the token names, and nothing else.
 */
async function shopContextFor(shopId) {
  const [{ data: shop }, { data: settings }, products, faqs] = await Promise.all([
    supabase.from('shops').select('name').eq('id', shopId).maybeSingle(),
    supabase
      .from('store_settings')
      .select('store_name, store_address, whatsapp, business_hours')
      .eq('shop_id', shopId)
      .maybeSingle(),
    supabase
      .from('products')
      .select('name, category, price, stock')
      .eq('shop_id', shopId)
      .order('name', { ascending: true })
      .limit(40),
    supabase
      .from('chat_faqs')
      .select('question, answer')
      .eq('shop_id', shopId)
      .order('sort_order', { ascending: true })
      .limit(20),
  ])

  return {
    shopName: settings?.store_name || shop?.name || 'the shop',
    location: settings?.store_address || 'N/A',
    hours: hoursLine(settings?.business_hours),
    products: products?.data || [],
    faqs: faqs?.data || [],
  }
}

chatRoutes.post('/answer', async (c) => {
  const shopId = shopIdOf(c)
  const { question } = await c.req.json()
  if (!question) return c.json({ error: 'question is required' }, 400)

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return c.json({ error: 'GROQ_API_KEY not configured' }, 500)

  // An LLM call is the only thing on this API that costs money per request, and
  // the credential that reaches it ships in public JS. Budgeted per SHOP, not
  // per token, so rotating a token does not reset the allowance.
  if (!rateLimit(`llm:${shopId}`, 20, 60_000)) {
    return c.json({ error: 'Too many requests. Try again in a minute.' }, 429)
  }

  const ctx = await shopContextFor(shopId)

  const productsBlock = ctx.products.length
    ? ctx.products
        .map(
          (p) =>
            `- ${p.name} (${p.category || 'uncategorised'}) — Ksh ${p.price}${
              p.stock > 0 ? '' : ' — OUT OF STOCK'
            }`
        )
        .join('\n')
    : 'No products available.'

  const faqsBlock = ctx.faqs.length
    ? ctx.faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : 'No FAQs available.'

  const systemPrompt = `You are a friendly Kenyan shop assistant for ${ctx.shopName}. Answer customer questions based ONLY on the shop information provided below. Be conversational, use Kenyan English, and keep responses concise.

Shop Information:
- Name: ${ctx.shopName}
- Location: ${ctx.location}
- Hours: ${ctx.hours}

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
    const { content } = await groqChat({
      apiKey,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: String(question).slice(0, 1000) },
      ],
      temperature: 0.7,
      maxTokens: 1024,
    })

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = {
        answer: content,
        outOfStockProduct: null,
        suggestedAlternative: null,
        orderReady: false,
        orderItems: null,
      }
    }

    return c.json(parsed)
  } catch (err) {
    console.error('[chat/answer]', err.message)
    return c.json({ error: 'AI service error' }, 502)
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
