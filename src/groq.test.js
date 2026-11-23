import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The AI routes used a literal `'mixtral-8x7b-32768'`, retired by Groq, so both
 * answered 502 for every caller with nothing in the product saying so. These
 * tests pin the two things that make that recoverable rather than repeatable:
 *
 *   1. the model comes from `app_config.ai_model_chain`, not source
 *   2. a model that fails falls through to the next one
 *
 * The chain column holds two different encodings of the same idea
 * (`suppressReasoning` as an object, or as `true`), so both are covered.
 */

const calls = []
let nextResult = { data: null, error: null }

vi.mock('./db.js', () => ({
  supabase: {
    from: (table) => {
      const rec = { table, filters: {} }
      const api = {
        select(cols) {
          rec.selected = cols
          return api
        },
        eq(col, value) {
          rec.filters[col] = value
          return api
        },
        maybeSingle() {
          calls.push(rec)
          return Promise.resolve(nextResult)
        },
        then(resolve) {
          calls.push(rec)
          return Promise.resolve(nextResult).then(resolve)
        },
      }
      return api
    },
  },
}))

const { modelChain, groqChat, stripThink, FALLBACK_CHAIN } = await import('./groq.js')

beforeEach(() => {
  calls.length = 0
  nextResult = { data: null, error: null }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the model chain comes from the database', () => {
  it('reads the same row the dashboard assistant uses', async () => {
    nextResult = { data: { value: [{ id: 'a/model' }] }, error: null }
    const chain = await modelChain()
    expect(chain.map((m) => m.id)).toEqual(['a/model'])

    const rec = calls.find((c) => c.table === 'app_config')
    expect(rec.selected).toBe('value')
    expect(rec.filters.key).toBe('ai_model_chain')
  })

  it('understands suppressReasoning as an object', async () => {
    nextResult = {
      data: {
        value: [
          { id: 'a/model', suppressReasoning: { reasoning_format: 'hidden' } },
        ],
      },
      error: null,
    }
    const [model] = await modelChain()
    expect(model.body).toEqual({ reasoning_format: 'hidden' })
  })

  it('understands suppressReasoning as the boolean the bot chain uses', async () => {
    nextResult = { data: { value: [{ id: 'a/model', suppressReasoning: true }] }, error: null }
    const [model] = await modelChain()
    expect(model.body).toEqual({ reasoning_format: 'hidden' })
  })

  it('parses a chain stored as a string', async () => {
    nextResult = { data: { value: JSON.stringify([{ id: 'a/model' }]) }, error: null }
    const chain = await modelChain()
    expect(chain.map((m) => m.id)).toEqual(['a/model'])
  })

  // A missing or malformed row must not be a dead feature, but it also must not
  // invent a chain: the fallback is one model, and it is documented as such.
  it.each([
    ['missing', { data: null, error: null }],
    ['null value', { data: { value: null }, error: null }],
    ['not an array', { data: { value: { id: 'a/model' } }, error: null }],
    ['empty array', { data: { value: [] }, error: null }],
    ['no ids', { data: { value: [{ model: 'a/model' }] }, error: null }],
    ['a database error', { data: null, error: { message: 'boom' } }],
  ])('falls back when the chain is %s', async (_label, result) => {
    nextResult = result
    const chain = await modelChain()
    expect(chain.map((m) => m.id)).toEqual(FALLBACK_CHAIN)
  })
})

describe('a failing model falls through to the next', () => {
  it('returns the second model when the first is retired', async () => {
    nextResult = { data: { value: [{ id: 'retired/model' }, { id: 'live/model' }] }, error: null }

    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.model === 'retired/model') {
        return { ok: false, status: 404, text: async () => 'model_not_found' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"answer":"hi"}' } }] }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await groqChat({ apiKey: 'k', messages: [{ role: 'user', content: 'x' }] })
    expect(result.model).toBe('live/model')
    expect(result.content).toBe('{"answer":"hi"}')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats an empty answer as a failure and moves on', async () => {
    nextResult = { data: { value: [{ id: 'empty/model' }, { id: 'live/model' }] }, error: null }

    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      const content = body.model === 'empty/model' ? '' : 'ok'
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await groqChat({ apiKey: 'k', messages: [] })
    expect(result.model).toBe('live/model')
    expect(result.content).toBe('ok')
  })

  it('throws the last failure when every model refuses', async () => {
    nextResult = { data: { value: [{ id: 'one' }, { id: 'two' }] }, error: null }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'overloaded' }))
    )

    await expect(groqChat({ apiKey: 'k', messages: [] })).rejects.toThrow(/503|503/)
  })
})

describe('reasoning blocks never reach a customer', () => {
  it('leaves ordinary text alone', () => {
    expect(stripThink('Karibu! We open at 8.')).toBe('Karibu! We open at 8.')
  })

  it('removes a closed think block', () => {
    expect(stripThink('<think>hmm, price is 100</think>It costs 100.')).toBe('It costs 100.')
  })

  // A block truncated by a low max_tokens has no closing tag. Stripping nothing
  // would ship the reasoning; stripping on the opening tag alone would ship half
  // a sentence. Neither is an answer, so neither is returned.
  it('returns nothing for an unclosed block', () => {
    expect(stripThink('<think>hmm, price is')).toBe('')
  })

  it('removes several blocks', () => {
    expect(stripThink('<think>a</think>One<think>b</think> Two')).toBe('One Two')
  })
})
