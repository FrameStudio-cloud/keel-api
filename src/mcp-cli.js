#!/usr/bin/env node
import 'dotenv/config'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createKeelMcpServer } from './mcp/index.js'

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment')
    process.exit(1)
  }

  const server = createKeelMcpServer()
  const transport = new StdioServerTransport()

  await server.connect(transport)
}

main().catch((err) => {
  console.error('keel-mcp fatal error:', err)
  process.exit(1)
})
