import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'

// ─── Minimal D1 stub ────────────────────────────────────────────
// Simulates just enough of D1 for unit tests (no real Cloudflare runtime needed)
type HealthRow = { date: string; payload_json: string; updated_at: number }
type ImportantTopicRow = {
  id: string
  text: string
  importance: number
  category: string | null
  scope: string | null
  ts: number
  snapshot_at: number
}

function makeD1Stub() {
  const health = new Map<string, HealthRow>()
  const topics = new Map<string, ImportantTopicRow>()

  function makeStmt(sql: string, boundArgs: unknown[] = []) {
    const sqlStr = sql.trim()
    const args: unknown[] = [...boundArgs]
    const stmt = {
      _sql: sqlStr,
      _args: args,
      bind(...a: unknown[]) {
        return makeStmt(sqlStr, [...args, ...a])
      },
      async run() {
        if (sqlStr.startsWith('INSERT INTO health_daily')) {
          const [date, payload_json, updated_at] = args as [string, string, number]
          health.set(date, { date, payload_json, updated_at })
        } else if (sqlStr.startsWith('DELETE FROM important_topics')) {
          topics.clear()
        } else if (sqlStr.startsWith('INSERT INTO important_topics')) {
          const [id, text, importance, category, scope, ts, snapshot_at] =
            args as [string, string, number, string | null, string | null, number, number]
          topics.set(id, { id, text, importance, category, scope, ts, snapshot_at })
        }
        return { success: true, meta: {} }
      },
      async all() {
        if (sqlStr.includes('health_daily')) {
          const [from, to] = args as [string, string]
          const results = [...health.values()]
            .filter((r) => r.date >= from && r.date <= to)
            .sort((a, b) => a.date.localeCompare(b.date))
          return { results }
        }
        if (sqlStr.includes('important_topics')) {
          const [limit] = args as [number]
          const results = [...topics.values()]
            .sort((a, b) => b.importance - a.importance)
            .slice(0, limit)
          return { results }
        }
        return { results: [] }
      },
    }
    return stmt
  }

  return {
    prepare(sql: string) {
      return makeStmt(sql)
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      // Execute sequentially; semantics good enough for tests
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  }
}

const TEST_TOKEN = 'test-secret-token-123'

function makeEnv() {
  return {
    DB_MEMCARE: makeD1Stub() as unknown as D1Database,
    DB_GRAPH: makeD1Stub() as unknown as D1Database,
    INGEST_TOKEN: TEST_TOKEN,
  }
}

// ─── Tests ──────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await app.request('/health', {}, makeEnv())
    expect(res.status).toBe(200)
    const json = await res.json() as { status: string }
    expect(json.status).toBe('ok')
  })
})

describe('POST /ingest/memcare/health — auth', () => {
  it('rejects missing Authorization', async () => {
    const res = await app.request(
      '/ingest/memcare/health',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2024-01-01' }) },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })

  it('rejects wrong token', async () => {
    const res = await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify({ date: '2024-01-01' }),
      },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /ingest/memcare/health — payload validation', () => {
  it('rejects missing date field', async () => {
    const res = await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ score: 90 }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid date format', async () => {
    const res = await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ date: '20240101' }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /ingest/memcare/health — happy path + UPSERT idempotency', () => {
  const env = makeEnv()
  const payload = { date: '2024-06-15', sleep: 7.5, steps: 8000 }

  it('inserts valid record and returns 200', async () => {
    const res = await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify(payload),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; date: string }
    expect(json.ok).toBe(true)
    expect(json.date).toBe('2024-06-15')
  })

  it('upsert second time does not error (idempotent)', async () => {
    const res = await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ ...payload, sleep: 8.0 }),
      },
      env
    )
    expect(res.status).toBe(200)
  })
})

describe('GET /api/memcare/health', () => {
  it('returns array of records in range', async () => {
    const env = makeEnv()
    // Pre-insert two records
    await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ date: '2024-07-01', score: 80 }),
      },
      env
    )
    await app.request(
      '/ingest/memcare/health',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ date: '2024-07-05', score: 85 }),
      },
      env
    )

    const res = await app.request(
      '/api/memcare/health?from=2024-07-01&to=2024-07-31',
      {},
      env
    )
    expect(res.status).toBe(200)
    const data = await res.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBe(2)
  })
})

// ─── Important Topics (SPEC-267) ────────────────────────────────

const SAMPLE_ITEMS = [
  { id: 'm1', text: 'Dale 节食中', importance: 0.95, category: 'preference', scope: 'fact:user:dale', timestamp: 1700000000000 },
  { id: 'm2', text: '记忆图谱每日 03:10 重建', importance: 0.88, category: 'fact', scope: 'fact:agent:lynx', timestamp: 1700001000000 },
  { id: 'm3', text: 'shipnow 三种情况以外去 speed_<repo>', importance: 0.82, category: 'decision', scope: 'fact:agent:cindy', timestamp: 1700002000000 },
]

describe('POST /ingest/memcare/important-topics — auth + validation', () => {
  it('rejects missing Authorization', async () => {
    const res = await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot_at: Date.now(), items: [] }),
    }, makeEnv())
    expect(res.status).toBe(401)
  })

  it('rejects missing snapshot_at', async () => {
    const res = await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ items: [] }),
    }, makeEnv())
    expect(res.status).toBe(400)
  })

  it('rejects items > 100', async () => {
    const big = Array.from({ length: 101 }, (_, i) => ({ id: `x${i}`, text: 't', importance: 0.5, timestamp: 1 }))
    const res = await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: Date.now(), items: big }),
    }, makeEnv())
    expect(res.status).toBe(400)
  })

  it('rejects importance out of range', async () => {
    const res = await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: Date.now(), items: [{ id: 'a', text: 't', importance: 1.5, timestamp: 1 }] }),
    }, makeEnv())
    expect(res.status).toBe(400)
  })

  it('rejects text > 2000 chars', async () => {
    const long = 'x'.repeat(2001)
    const res = await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: Date.now(), items: [{ id: 'a', text: long, importance: 0.5, timestamp: 1 }] }),
    }, makeEnv())
    expect(res.status).toBe(400)
  })
})

describe('POST /ingest/memcare/important-topics — happy path + replace semantics', () => {
  it('inserts items and returns count', async () => {
    const env = makeEnv()
    const snap = Date.now()
    const res = await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: snap, items: SAMPLE_ITEMS }),
    }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; count: number; snapshot_at: number }
    expect(json.ok).toBe(true)
    expect(json.count).toBe(3)
    expect(json.snapshot_at).toBe(snap)
  })

  it('second ingest replaces (does not accumulate)', async () => {
    const env = makeEnv()
    const snap1 = Date.now()
    await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: snap1, items: SAMPLE_ITEMS }),
    }, env)

    const snap2 = snap1 + 1000
    await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: snap2, items: [{ id: 'only', text: 'one row', importance: 0.9, timestamp: 1 }] }),
    }, env)

    const res = await app.request('/api/memcare/important-topics?limit=50', {}, env)
    const json = await res.json() as { items: unknown[]; snapshot_at: number }
    expect(json.items.length).toBe(1)
    expect(json.snapshot_at).toBe(snap2)
  })
})

describe('GET /api/memcare/important-topics', () => {
  it('returns items ordered by importance DESC, default limit applied', async () => {
    const env = makeEnv()
    const snap = Date.now()
    await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: snap, items: SAMPLE_ITEMS }),
    }, env)

    const res = await app.request('/api/memcare/important-topics', {}, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { items: Array<{ id: string; importance: number }>; snapshot_at: number; stale: boolean }
    expect(json.items.length).toBe(3)
    expect(json.items[0].importance).toBeGreaterThanOrEqual(json.items[1].importance)
    expect(json.items[1].importance).toBeGreaterThanOrEqual(json.items[2].importance)
    expect(json.snapshot_at).toBe(snap)
    expect(json.stale).toBe(false)
  })

  it('limit clamp: limit=500 clamped to 100', async () => {
    const env = makeEnv()
    const snap = Date.now()
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, text: `t${i}`, importance: i / 100, timestamp: 1 }))
    await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: snap, items: many }),
    }, env)

    const res = await app.request('/api/memcare/important-topics?limit=500', {}, env)
    const json = await res.json() as { items: unknown[] }
    expect(json.items.length).toBe(100)
  })

  it('empty table returns items=[], snapshot_at=0, stale=true', async () => {
    const env = makeEnv()
    const res = await app.request('/api/memcare/important-topics', {}, env)
    const json = await res.json() as { items: unknown[]; snapshot_at: number; stale: boolean }
    expect(json.items.length).toBe(0)
    expect(json.snapshot_at).toBe(0)
    expect(json.stale).toBe(true)
  })

  it('stale flag true when snapshot_at older than 36h', async () => {
    const env = makeEnv()
    const oldSnap = Date.now() - 40 * 60 * 60 * 1000
    await app.request('/ingest/memcare/important-topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ snapshot_at: oldSnap, items: [{ id: 'a', text: 't', importance: 0.9, timestamp: 1 }] }),
    }, env)
    const res = await app.request('/api/memcare/important-topics', {}, env)
    const json = await res.json() as { stale: boolean }
    expect(json.stale).toBe(true)
  })
})
