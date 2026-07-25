#!/usr/bin/env node
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { config } from 'dotenv'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createKeelMcpServer } from './mcp/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const server = createKeelMcpServer()
const transport = new StdioServerTransport()
await server.connect(transport)
