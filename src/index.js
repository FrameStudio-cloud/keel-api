import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { shopRoutes } from './routes/shop.js'
import { settingsRoutes } from './routes/settings.js'
import { catalogueRoutes } from './routes/catalogue.js'
import { bannersRoutes } from './routes/banners.js'
import { chatRoutes } from './routes/chat.js'

const app = new Hono()

app.use('/*', cors())

app.get('/', (c) => c.json({ ok: true, name: 'keel-api' }))

app.route('/api/shop', shopRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/catalogue', catalogueRoutes)
app.route('/api/banners', bannersRoutes)
app.route('/api/chat', chatRoutes)

const port = parseInt(process.env.PORT || '3001')

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`keel-api running on http://localhost:${info.port}`)
})
