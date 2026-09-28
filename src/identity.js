/**
 * Anonymous visitor identity, as received from a storefront.
 *
 * The SDK mints a random v4 UUID per browser and a second one per 30-minute
 * visit, and sends them as top-level event fields. Two rules govern what the
 * collector accepts, and they are here rather than in either route so the two
 * cannot drift apart.
 *
 * 1. shop identity NEVER comes from here. It comes from the site token, via
 *    shopIdOf(). A visitor id is a grouping key: it can join one shop's rows
 *    together, and it can never move a row between shops, because nothing about
 *    it is used to decide the row's owner.
 *
 * 2. A bad id costs the identity, not the event. That is the whole reason this
 *    is a function and not `z.string().uuid()` in the schema. Rejecting a
 *    malformed id would reject the whole event, and per-item rejections are
 *    silent - so one storefront sending a bad id would lose its health reports,
 *    its errors and its product views, with nothing in any log to explain it.
 *    Losing a visitor count is recoverable. Losing the event that says the shop
 *    is broken is not.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Normalise one identity field, or return null.
 *
 * Anything that is not a v4 UUID becomes null: absent, optional-out, and
 * ignored by every count. A visitor who opted out and a visitor whose client
 * produced junk are indistinguishable in the data, which is the correct
 * outcome - neither can be counted and neither should be guessed at.
 */
export function identityId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // Length is checked BEFORE the pattern, and nothing is truncated. Slicing to
  // 36 and testing would accept "3f2504e0-...-3301" plus any padding as a valid
  // id, which is prefix-match truncation: two different inputs silently become
  // one visitor. A grouping key that is too long is simply not a grouping key.
  if (trimmed.length !== 36) return null
  return UUID_V4.test(trimmed) ? trimmed.toLowerCase() : null
}

/** True when the browser asked not to be tracked, for logging only. */
export function isRefused(value) {
  return value === true || value === '1' || value === 1 || value === 'yes'
}
