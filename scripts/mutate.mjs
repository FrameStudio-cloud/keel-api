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
