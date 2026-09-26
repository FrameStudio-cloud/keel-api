import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { config } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
console.error('1. dirname:', __dirname)
const p = resolve(__dirname, '../.env')
console.error('2. dotenv path:', p)
const r = config({ path: p })
console.error('3. parsed:', r.parsed ? Object.keys(r.parsed).join(',') : 'no parse')
console.error('4. SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'MISSING')
