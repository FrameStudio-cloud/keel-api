import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { productTools } from './tools/products.js'
import { salesTools } from './tools/sales.js'
import { financeTools } from './tools/finance.js'
import { reportsTools } from './tools/reports.js'
import { shopTools } from './tools/shop.js'
import { businessOverviewPrompt, inventoryHealthPrompt } from './prompts.js'

export function createKeelMcpServer() {
  const server = new McpServer({
    name: 'keel-mcp',
    version: '1.0.0',
    description: 'MCP server for Keel — interact with your shop data: products, sales, expenses, reports, and settings',
  })

  for (const tool of [...productTools, ...salesTools, ...financeTools, ...reportsTools, ...shopTools]) {
    if (tool.params && Object.keys(tool.params).length > 0) {
      server.tool(tool.name, tool.description, tool.params, tool.handler)
    } else {
      server.tool(tool.name, tool.description, tool.handler)
    }
  }

  server.prompt('business_overview', 'Get a comprehensive business health overview including KPIs, low stock, and recent activity', businessOverviewPrompt.params, businessOverviewPrompt.handler)
  server.prompt('inventory_health', 'Get a snapshot of inventory health — product count, low stock alerts, and slow-moving items', inventoryHealthPrompt.params, inventoryHealthPrompt.handler)

  return server
}
