import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { config } from 'dotenv'

// Simulate being in src/mcp-cli.js
const fakeUrl = 'file:///C:/Users/Administrator/projects/keel-api/src/mcp-cli.js'
const __dirname = dirname(fileURLToPath(fakeUrl))
console.error('1. dirname:', __dirname)
const p = resolve(__dirname, '../.env')
console.error('2. dotenv path:', p)
console.error('3. file exists:', require('fs').existsSync(p))
const r = config({ path: p })
console.error('4. parsed:', r.parsed ? Object.keys(r.parsed).join(',') : 'no parse')
console.error('5. SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'MISSING')
