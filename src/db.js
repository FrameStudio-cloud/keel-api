import { createClient } from '@supabase/supabase-js'

let _supabase = null

function getSupabase() {
  if (!_supabase) {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    }
    _supabase = createClient(supabaseUrl, supabaseKey)
  }
  return _supabase
}

export const supabase = new Proxy({}, {
  get(_, prop) {
    return getSupabase()[prop]
  },
  set(_, prop, value) {
    getSupabase()[prop] = value
    return true
  }
})
