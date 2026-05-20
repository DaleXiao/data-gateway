import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { memcareRouter } from './routes/memcare'
import { graphRouter } from './routes/graph'

export type Env = {
  DB_MEMCARE: D1Database
  DB_GRAPH: D1Database
  INGEST_TOKEN: string
}

const app = new Hono<{ Bindings: Env }>()

// CORS — read-only GET endpoints are public
app.use(
  '/api/*',
  cors({
    origin: ['https://memcare.openclawd.co', 'https://graph.openclawd.co'],
    allowMethods: ['GET', 'OPTIONS'],
  })
)

// Health check
app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }))

// Business routes
app.route('/api/memcare', memcareRouter)
app.route('/ingest/memcare', memcareRouter)
app.route('/api/graph', graphRouter)
app.route('/ingest/graph', graphRouter)

export default app
