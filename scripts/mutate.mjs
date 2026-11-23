// Mutation harness: reintroduce each fixed bug, confirm the suite catches it,
// then restore. Prints a pass/fail line per mutation.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MUTATIONS = [
  ['src/routes/chat.js', /\.eq\('shop_id', shopId\)\s*\n\s*\.order\('created_at'/, ".order('created_at'", 'chat messages: shop filter removed'],
  ['src/routes/chat.js', /shop_id: shopId,(\s*\n\s*name: body\.name,)/, 'shop_id: body.shop_id,$1', 'chat callbacks: body.shop_id'],
  ['src/routes/chat.js', /shop_id: shopId,(\s*\n\s*product_name: body\.product_name,)/, 'shop_id: body.shop_id,$1', 'chat stock-alerts: body.shop_id'],
  ['src/routes/chat.js', /\.select\(PUBLIC_CHAT_CONFIG\.join\(','\)\)/, ".select('*')", 'chat config: select(*)'],
  ['src/routes/chat.js', /if \(idList\.length > 100\) return c\.json\(\{ error: 'Too many ids' \}, 400\)/, '', 'chat messages: id cap removed'],
  ['src/routes/settings.js', /\.select\(PUBLIC_SETTINGS\.join\(','\)\)/, ".select('*')", 'settings: select(*)'],
  ['src/routes/manifest.js', /if \(parsed\.hostname !== registeredHost\) \{/, 'if (false) {', 'manifest: host allowlist removed'],
  ['src/routes/manifest.js', /if \(parsed\.protocol !== 'https:'\) \{/, 'if (false) {', 'manifest: https-only removed'],
  ['src/routes/manifest.js', /redirect: 'error',/, '', 'manifest: redirect:error removed'],
  ['src/auth.js', /if \(token\) \{/, 'if (true) {', 'auth: token branch widened to accept no token'],
  ['src/auth.js', /const budget = identity\.canWrite \? write : read/, 'const budget = read', 'auth: rate limit un-inverted'],
  ['src/auth.js', /canWrite: row\.can_write === true/, 'canWrite: !!row.can_write', 'auth: can_write loosened'],
  ['src/routes/services.js', /^\s*\.eq\('shop_id', shopId\)\s*$/m, '', 'services: shop filter removed'],
  ['src/routes/services.js', /\.eq\('visible', true\)/, '', 'services: hidden rows published'],
  ['src/routes/services.js', /\.select\(PUBLIC_SERVICE_COLUMNS\.join\(','\)\)/, ".select('*')", 'services: select(*)'],
  ['src/routes/services.js', /order\('category', \{ ascending: true \}\)\.order\('name', \{ ascending: true \}\)/, ".order('created_at', { ascending: false })", 'services: unstable ordering'],
  ['src/routes/services.js', /if \(error\) return c\.json\(\{ error: error\.message \}, 500\)/, 'if (error) return c.json([])', 'services: DB error looks like empty'],
  ['src/routes/pageContent.js', /\.is\('page_key', null\)/, '', 'page-content: legacy rows leak into sections'],
  ['src/routes/pageContent.js', /if \(page\) \{/, 'if (false) {', 'page-content: page addressing removed'],
  ['src/routes/pageContent.js', /return c\.json\(\[\]\)/, "return supabase.from('page_content').select('*').eq('shop_id', shopId).limit(5).then(r => r.data || [])", 'page-content: unaddressed read becomes a dump'],

  // Added 24 Nov 2026 with Phase 1 of the custom-site-integration plan. Each of
  // these is a guard that did not exist before that day, so the suite had never
  // been seen to fail on it.
  ['src/routes/banners.js', /\.select\(PUBLIC_BANNER_COLUMNS\.join\(','\)\)/, ".select('*')", 'banners: select(*)'],
  ['src/routes/catalogue.js', /\.select\(PUBLIC_CATALOGUE_COLUMNS\.join\(','\)\)/, ".select('*')", 'catalogue: select(*)'],
  ['src/routes/pageContent.js', /\.select\(PUBLIC_PAGE_CONTENT_COLUMNS\.join\(','\)\)/, ".select('*')", 'page-content: select(*)'],
  ['src/routes/chat.js', /\.select\(PUBLIC_FAQ_COLUMNS\.join\(','\)\)/, ".select('*')", 'chat faqs: select(*)'],
  ['src/routes/chat.js', /\.select\(PUBLIC_MESSAGE_COLUMNS\.join\(','\)\)/, ".select('*')", 'chat messages: select(*)'],
  ['src/routes/chat.js', /if \(!rateLimit\(`llm:\$\{shopId\}`, 20, 60_000\)\) \{/, 'if (false) {', 'chat answer: LLM budget removed'],
  ['src/routes/chat.js', /\.select\('name, category, price, stock'\)\s*\n\s*\.eq\('shop_id', shopId\)/, ".select('name, category, price, stock')", 'chat answer: context not shop-scoped'],
  ['src/groq.js', /\.eq\('key', 'ai_model_chain'\)/, ".eq('key', 'a_different_key')", 'groq: chain read from the wrong key'],
  ['src/groq.js', /if \(!\/<think\/i\.test\(raw\)\) return raw/, 'return raw', 'groq: reasoning not stripped'],
  ['src/groq.js', /console\.error\('\[groq\]', lastError, detail\)\n\s*continue/, "console.error('[groq]', lastError, detail); break", 'groq: retired model stops the chain'],

  // Phase 3: scope enforcement.
  ['src/auth.js', /if \(!identity\.scopes\.includes\(needed\)\) \{/, 'if (false) {', 'auth: scope not enforced'],
  ['src/auth.js', /if \(needed === null\) \{/, 'if (false) {', 'auth: unmapped write allowed'],
  ['src/auth.js', /\? \['read', 'analytics', 'inquiry'\]/, "? ['read']", 'auth: legacy fallback narrowed'],

  // Phase 6: the inquiry endpoint. Every one of these is a field a public form
  // must not be able to choose.
  ['src/routes/inquiries.js', /shop_id: shopId,/, 'shop_id: body.shop_id,', 'inquiries: body shop_id'],
  ['src/routes/inquiries.js', /site_id: siteId,/, 'site_id: body.site_id,', 'inquiries: body site_id'],
  ['src/routes/inquiries.js', /status: 'new',/, 'status: body.status,', 'inquiries: body status'],
  ['src/routes/inquiries.js', /if \(!rateLimit\(`inquiry:\$\{shopId\}`, 30, 60_000\)\) \{/, 'if (false) {', 'inquiries: rate limit removed'],
]

let caught = 0
for (const [file, pattern, replacement, label] of MUTATIONS) {
  const original = readFileSync(file, 'utf8')
  if (!pattern.test(original)) {
    console.log(`SKIP (no match)   ${label}`)
    continue
  }
  const mutated = original.replace(pattern, replacement)
  if (mutated === original) {
    console.log(`SKIP (no change)  ${label}`)
    continue
  }
  writeFileSync(file, mutated)
  let failed = false
  try {
    execSync('npx vitest run', { stdio: 'pipe' })
  } catch {
    failed = true
  }
  writeFileSync(file, original)
  const restored = readFileSync(file, 'utf8') === original
  console.log(`${failed ? 'CAUGHT ' : 'MISSED '}  ${label.padEnd(38)} restored=${restored}`)
  if (failed) caught++
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the suite`)
process.exit(caught === MUTATIONS.length ? 0 : 1)
