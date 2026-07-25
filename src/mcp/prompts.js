import { z } from 'zod'

const shopParam = {
  shop_id: z.string().uuid().describe('The shop ID to generate the overview for'),
}

export const businessOverviewPrompt = {
  params: shopParam,
  handler: async () => {
    const prompt = `You are a business analyst looking at a shop's Keel dashboard.

Your job is to produce a clear, actionable business health brief for the shop owner.

Gather data using the available tools — at minimum check the dashboard KPIs, low stock items, and today's sales.

Present a natural-language summary covering:
- Overall health status (revenue, transaction volume)
- Items that need reordering
- Slow-moving stock worth promoting
- One or two specific recommendations

Be warm, concise, and practical. Think "helpful shop assistant giving the morning briefing."`
    return { messages: [{ role: 'user', content: { type: 'text', text: prompt } }] }
  },
}

export const inventoryHealthPrompt = {
  params: shopParam,
  handler: async () => {
    const prompt = `You are doing an inventory health check. Use the available tools to find:
- Total product count
- Products low on stock (check with a reasonable threshold)
- Products that haven't sold well recently

Present a focused summary with clear reorder suggestions. Prioritize items closest to running out.`
    return { messages: [{ role: 'user', content: { type: 'text', text: prompt } }] }
  },
}
