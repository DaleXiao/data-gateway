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

// ── POST /ingest/memcare/important-topics ─────────────────────
// SPEC-267 §3.3 — Bearer-authenticated; full-table replace in a single batch
memcareRouter.post('/important-topics', async (c) => {
  if (!checkBearer(c.req.header('Authorization'), c.env.INGEST_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Body must be an object' }, 400)
  }
  const b = body as Record<string, unknown>
  const snapshotAt = Number(b.snapshot_at)
  const items = b.items
  if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) {
    return c.json({ error: 'snapshot_at must be a positive number (ms)' }, 400)
  }
  if (!Array.isArray(items)) {
    return c.json({ error: 'items must be an array' }, 400)
  }
  if (items.length > 100) {
    return c.json({ error: 'items.length must be <= 100' }, 400)
  }

  // Validate each item
  const rows: Array<{
    id: string
    text: string
    importance: number
    category: string | null
    scope: string | null
    ts: number
  }> = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (typeof it !== 'object' || it === null) {
      return c.json({ error: `items[${i}] must be an object` }, 400)
    }
    const r = it as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : ''
    const text = typeof r.text === 'string' ? r.text : ''
    const importance = Number(r.importance)
    const ts = Number(r.timestamp)
    if (!id) return c.json({ error: `items[${i}].id required` }, 400)
    if (!text) return c.json({ error: `items[${i}].text required` }, 400)
    if (text.length > 2000) return c.json({ error: `items[${i}].text > 2000 chars` }, 400)
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
      return c.json({ error: `items[${i}].importance must be in [0,1]` }, 400)
    }
    if (!Number.isFinite(ts) || ts <= 0) {
      return c.json({ error: `items[${i}].timestamp must be a positive number (ms)` }, 400)
    }
    rows.push({
      id,
      text,
      importance,
      category: typeof r.category === 'string' ? r.category : null,
      scope: typeof r.scope === 'string' ? r.scope : null,
      ts,
    })
  }

  // Full-table replace via D1 batch (atomic)
  const stmts = [c.env.DB_MEMCARE.prepare('DELETE FROM important_topics')]
  for (const r of rows) {
    stmts.push(
      c.env.DB_MEMCARE.prepare(
        `INSERT INTO important_topics (id, text, importance, category, scope, ts, snapshot_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(r.id, r.text, r.importance, r.category, r.scope, r.ts, snapshotAt)
    )
  }
  await c.env.DB_MEMCARE.batch(stmts)

  return c.json({ ok: true, count: rows.length, snapshot_at: snapshotAt })
})

// ── GET /api/memcare/important-topics?limit=50 ────────────────
// SPEC-267 §3.3 — public (CORS via app-level config); returns top-N by importance
memcareRouter.get('/important-topics', async (c) => {
  const rawLimit = Number(c.req.query('limit') ?? '50')
  let limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50
  if (limit <= 0) limit = 50
  if (limit > 100) limit = 100

  const { results } = await c.env.DB_MEMCARE.prepare(
    `SELECT id, text, importance, category, scope, ts, snapshot_at
     FROM important_topics
     ORDER BY importance DESC
     LIMIT ?1`
  )
    .bind(limit)
    .all()

  const items = (results as unknown as Array<Record<string, unknown>>) ?? []
  const snapshotAt = items.length > 0 ? Number(items[0].snapshot_at) : 0
  const stale = snapshotAt > 0 ? snapshotAt < Date.now() - 36 * 3600 * 1000 : true

  return c.json({ items, snapshot_at: snapshotAt, stale })
})
