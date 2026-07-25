const store = new Map()

const defaults = {
  ttl: 30_000,
  maxSize: 200,
}

export function withCache(fn, { ttl = defaults.ttl, key } = {}) {
  return async (...args) => {
    const cacheKey = key ? `${key}:${JSON.stringify(args)}` : `fn:${fn.name}:${JSON.stringify(args)}`
    const existing = store.get(cacheKey)
    if (existing && Date.now() < existing.expiresAt) {
      return existing.data
    }
    const result = await fn(...args)
    if (store.size >= defaults.maxSize) {
      const oldest = [...store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) store.delete(oldest[0])
    }
    store.set(cacheKey, { data: result, expiresAt: Date.now() + ttl })
    return result
  }
}

export function invalidateCache(pattern) {
  if (!pattern) {
    store.clear()
    return
  }
  for (const key of store.keys()) {
    if (key.startsWith(pattern)) store.delete(key)
  }
}
