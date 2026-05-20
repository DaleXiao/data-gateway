import { Hono } from 'hono'
import type { Env } from '../index'

export const memcareRouter = new Hono<{ Bindings: Env }>()

// ── Auth helper ──────────────────────────────────────────────
function checkBearer(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false
  const parts = authHeader.split(' ')
  return parts[0] === 'Bearer' && parts[1] === token
}

// ── POST /ingest/memcare/health ───────────────────────────────
// Bearer-authenticated; accepts health daily JSON; UPSERT by date
memcareRouter.post('/health', async (c) => {
  if (!checkBearer(c.req.header('Authorization'), c.env.INGEST_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  // body must be an object with a "date" field (YYYY-MM-DD)
  if (typeof body !== 'object' || body === null || !('date' in body)) {
    return c.json({ error: 'Missing required field: date' }, 400)
  }

  const record = body as Record<string, unknown>
  const date = String(record.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
  }

  const payloadJson = JSON.stringify(body)
  const updatedAt = Date.now()

  await c.env.DB_MEMCARE.prepare(
    `INSERT INTO health_daily (date, payload_json, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(date) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at   = excluded.updated_at`
  )
    .bind(date, payloadJson, updatedAt)
    .run()

  return c.json({ ok: true, date, updated_at: updatedAt })
})

// ── GET /api/memcare/health?from=YYYY-MM-DD&to=YYYY-MM-DD ─────
memcareRouter.get('/health', async (c) => {
  const from = c.req.query('from') ?? '1970-01-01'
  const to = c.req.query('to') ?? '9999-12-31'

  const { results } = await c.env.DB_MEMCARE.prepare(
    `SELECT date, payload_json FROM health_daily
     WHERE date >= ?1 AND date <= ?2
     ORDER BY date ASC`
  )
    .bind(from, to)
    .all()

  const data = results.map((row) => {
    try {
      return JSON.parse(row.payload_json as string)
    } catch {
      return { date: row.date, _parse_error: true }
    }
  })

  return c.json(data)
})
