import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { shopRoutes } from './routes/shop.js'
import { settingsRoutes } from './routes/settings.js'
import { catalogueRoutes } from './routes/catalogue.js'
import { servicesRoutes } from './routes/services.js'
import { bannersRoutes } from './routes/banners.js'
import { chatRoutes } from './routes/chat.js'
import { contentRoutes } from './routes/content.js'
import { productRoutes } from './routes/products.js'
import { manifestRoutes } from './routes/manifest.js'
import { pageContentRoutes } from './routes/pageContent.js'
import { pageViewsRoutes } from './routes/pageViews.js'
import { eventsRoutes } from './routes/events.js'
import { inquiriesRoutes } from './routes/inquiries.js'
import { siteAuth } from './auth.js'

const app = new Hono()

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Failing open is the only workable default here — a new storefront must not
// need a deploy of this service to be allowed to call it — but silently failing
// open is how the policy became `*` without anyone deciding that. Say it at
// boot. Identity still comes from the site token, scoped to one shop, so this is
// defence in depth rather than access control.
if (!allowedOrigins.length) {
  console.warn(
    '[keel-api] ALLOWED_ORIGINS is unset — accepting browser requests from ANY origin. ' +
      'Set it to the real storefront hosts.'
  )
}

app.use(
  '*',
  cors({
    // Defence in depth, not the primary control: identity comes from the
    // site token, and a token is only ever scoped to its own shop.
    origin: allowedOrigins.length ? allowedOrigins : '*',
    allowHeaders: ['Content-Type', 'x-keel-site-token', 'x-keel-token'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  })
)

/**
 * Health + identity, including WHICH BUILD is answering.
 *
 * `version` is the point, not decoration. Until 24 Nov 2026 this answered
 * `{ok, name}` and nothing else, so the deployed commit could not be confirmed
 * from outside the Render dashboard — and this repo has a documented history of
 * features recorded as shipped that were never deployed. A health check that
 * cannot distinguish one build from another is not a health check.
 *
 * RENDER_GIT_COMMIT is injected by Render. npm_package_version covers a local
 * `npm start`. 'dev' is the honest answer when neither exists: a fabricated
 * version is worse than none, because it ends the search.
 */
app.get('/', (c) =>
  c.json({
    ok: true,
    name: 'keel-api',
    version:
      process.env.RENDER_GIT_COMMIT ||
      process.env.npm_package_version ||
      'dev',
  })
)

// Identity gate. Everything below runs with c.get('shopId') set to a shop the
// caller is actually allowed to reach.
app.use('/api/*', siteAuth())

app.route('/api/shop', shopRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/catalogue', catalogueRoutes)
app.route('/api/services', servicesRoutes)
app.route('/api/banners', bannersRoutes)
app.route('/api/chat', chatRoutes)
app.route('/api/content', contentRoutes)
app.route('/api/products', productRoutes)
app.route('/api/manifest', manifestRoutes)
app.route('/api/page-content', pageContentRoutes)
app.route('/api/page-views', pageViewsRoutes)
app.route('/api/events', eventsRoutes)
app.route('/api/inquiries', inquiriesRoutes)

app.onError((err, c) => {
  console.error('[keel-api]', err)
  return c.json({ error: 'Internal error' }, 500)
})

const port = parseInt(process.env.PORT || '3001')

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`keel-api running on http://localhost:${info.port}`)
})
