import { supabase } from './db.js'

/**
 * Which Groq models a route may use, and the call itself.
 *
 * Two routes here hardcoded `'mixtral-8x7b-32768'`: POST /api/chat/answer and
 * POST /api/content/captions. Groq retired that model, so both answered 502 for
 * every caller — and nothing in the product said so, because a 502 from a model
 * name is indistinguishable from a 502 from the network.
 *
 * A model name in source is a scheduled outage. It works until the vendor
 * retires it, then the feature stops with no code change by anyone. The chain
 * lives in `public.app_config.ai_model_chain` — the same row the dashboard
 * assistant reads — so re-pointing it is one UPDATE and no deploy.
 *
 * FALLBACK_CHAIN exists only so a database that cannot be read is not dead on
 * arrival. It is not the contract; the row is.
 */
export const FALLBACK_CHAIN = ['qwen/qwen3.8-27b']

function fallbackModels() {
  return FALLBACK_CHAIN.map((id) => ({ id, body: {} }))
}

/**
 * The chain, normalised to `{ id, body }`.
 *
 * `suppressReasoning` is two different shapes in the same column: an object to
 * spread into the request body (the dashboard chain) or the boolean `true` (the
 * bot chain). Both mean "hide the reasoning"; only the encoding differs, and a
 * parser that handled one would silently drop the other.
 */
export async function modelChain() {
  try {
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'ai_model_chain')
      .maybeSingle()

    const raw = data?.value
    if (!raw) return fallbackModels()

    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return fallbackModels()

    const models = parsed
      .filter((m) => m && typeof m.id === 'string' && m.id)
      .map((m) => {
        const suppress = m.suppressReasoning
        const body =
          suppress === true
            ? { reasoning_format: 'hidden' }
            : suppress && typeof suppress === 'object'
              ? suppress
              : {}
        return { id: m.id, body }
      })

    return models.length ? models : fallbackModels()
  } catch (err) {
    console.error('[groq] model chain unreadable:', err.message)
    return fallbackModels()
  }
}

/**
 * A model that ignores `reasoning_format` emits `...` inline, and a block
 * truncated before its closing tag (a low max_tokens) has no closer to anchor
 * on — so a naive strip leaves raw reasoning in a customer-facing answer.
 *
 * Returns '' for that case. An empty answer is a failed model, not a sentence
 * to ship, and the caller falls through to the next one.
 */
export function stripThink(text) {
  const raw = text || ''
  if (!/<think/i.test(raw)) return raw
  const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim()
  return /<think/i.test(cleaned) ? '' : cleaned
}

/**
 * Ask Groq, walking the chain until one model answers.
 *
 * Falling through matters as much as the call itself: when a vendor retires the
 * first model in the chain, the feature must degrade to the second rather than
 * 502 the whole route. The error carries the last failure, because "AI service
 * error" with no detail is what made the original outage invisible.
 */
export async function groqChat({ apiKey, messages, temperature = 0.7, maxTokens = 1024 }) {
  const chain = await modelChain()
  let lastError = 'no model in the chain'

  for (const model of chain) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model.id,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...model.body,
        }),
      })

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        lastError = `${model.id} → ${res.status}`
        console.error('[groq]', lastError, detail)
        continue
      }

      const data = await res.json()
      const content = stripThink(data.choices?.[0]?.message?.content)
      if (!content) {
        lastError = `${model.id} → empty answer`
        continue
      }

      return { content, model: model.id }
    } catch (err) {
      lastError = `${model.id} → ${err.message}`
    }
  }

  throw new Error(lastError)
}
