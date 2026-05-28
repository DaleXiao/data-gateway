import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'

// ─── Minimal D1 stub ────────────────────────────────────────────
// Simulates just enough of D1 for unit tests (no real Cloudflare runtime needed)
type Row = { date: string; payload_json: string; updated_at: number }
type TopicRow = {
  id: string
  text: string
  importance: number
  category: string | null
  scope: string | null
  ts: number
  snapshot_at: number
}

function makeD1Stub() {
  const _store = new Map<string, Row>()
  const _topics = new Map<string, TopicRow>()

  function makeStmt(sql: string) {
    const sqlStr = sql.trim()
    const args: unknown[] = []
    const stmt = {
      _sql: sqlStr,
      _args: args,
      bind(...a: unknown[]) {
        args.push(...a)
        return stmt
      },
      async run() {
        if (sqlStr.startsWith('INSERT INTO health_daily')) {
          const [date, payload_json, updated_at] = args as [string, string, number]
          _store.set(date, { date, payload_json, updated_at })
        } else if (sqlStr.startsWith('DELETE FROM important_topics')) {
          _topics.clear()
        } else if (sqlStr.startsWith('INSERT INTO important_topics')) {
          const [id, text, importance, category, scope, ts, snapshot_at] = args as [
            string, string, number, string | null, string | null, number, number
          ]
          _topics.set(id, { id, text, importance, category, scope, ts, snapshot_at })
        }
        return { success: true, meta: {} }
      },
      async all() {
        if (sqlStr.includes('health_daily')) {
          const [from, to] = args as [string, string]
          const results = [..._store.values()]
            .filter((r) => r.date >= from && r.date <= to)
            .sort((a, b) => a.date.localeCompare(b.date))
          return { results }
        }
        if (sqlStr.includes('important_topics')) {
          const limit = Number(args[0] ?? 50)
          const results = [..._topics.values()]
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

// ─── SPEC-267 important-topics tests ─────────────────────────
describe('POST /ingest/memcare/important-topics — auth', () => {
  it('rejects missing Authorization', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot_at: Date.now(), items: [] }),
      },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /ingest/memcare/important-topics — validation', () => {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TEST_TOKEN}`,
  }

  it('rejects missing snapshot_at', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers, body: JSON.stringify({ items: [] }) },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects > 100 items', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      id: `m${i}`, text: 't', importance: 0.9, timestamp: 1,
    }))
    const res = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers, body: JSON.stringify({ snapshot_at: Date.now(), items }) },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects importance out of range', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST', headers,
        body: JSON.stringify({
          snapshot_at: Date.now(),
          items: [{ id: 'a', text: 't', importance: 1.5, timestamp: 1 }],
        }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects text > 2000 chars', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST', headers,
        body: JSON.stringify({
          snapshot_at: Date.now(),
          items: [{ id: 'a', text: 'x'.repeat(2001), importance: 0.9, timestamp: 1 }],
        }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })
})

describe('important-topics — ingest + read + replace semantics', () => {
  const env = makeEnv()
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TEST_TOKEN}`,
  }

  it('ingests then reads top-N sorted desc by importance', async () => {
    const snapshot_at = Date.now()
    const items = [
      { id: 'a', text: 'low',  importance: 0.81, category: 'fact', scope: 's', timestamp: 100 },
      { id: 'b', text: 'high', importance: 0.95, category: 'preference', scope: 's', timestamp: 200 },
      { id: 'c', text: 'mid',  importance: 0.88, timestamp: 150 },
    ]
    const post = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers, body: JSON.stringify({ snapshot_at, items }) },
      env
    )
    expect(post.status).toBe(200)
    const postJson = await post.json() as { ok: boolean; count: number; snapshot_at: number }
    expect(postJson.ok).toBe(true)
    expect(postJson.count).toBe(3)

    const get = await app.request('/api/memcare/important-topics?limit=10', {}, env)
    expect(get.status).toBe(200)
    const data = await get.json() as { items: Array<{ id: string; importance: number }>; snapshot_at: number; stale: boolean }
    expect(data.items.map((x) => x.id)).toEqual(['b', 'c', 'a'])
    expect(data.snapshot_at).toBe(snapshot_at)
    expect(data.stale).toBe(false)
  })

  it('full-table replace: second ingest wipes first', async () => {
    const snapshot_at = Date.now()
    const post = await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST', headers,
        body: JSON.stringify({
          snapshot_at,
          items: [{ id: 'only', text: 'only one', importance: 0.99, timestamp: 1 }],
        }),
      },
      env
    )
    expect(post.status).toBe(200)

    const get = await app.request('/api/memcare/important-topics?limit=50', {}, env)
    const data = await get.json() as { items: Array<{ id: string }> }
    expect(data.items.length).toBe(1)
    expect(data.items[0].id).toBe('only')
  })

  it('limit caps at 100', async () => {
    const get = await app.request('/api/memcare/important-topics?limit=9999', {}, env)
    expect(get.status).toBe(200)
  })

  it('empty store → stale=true, snapshot_at=0', async () => {
    const freshEnv = makeEnv()
    const get = await app.request('/api/memcare/important-topics', {}, freshEnv)
    const data = await get.json() as { items: unknown[]; snapshot_at: number; stale: boolean }
    expect(data.items.length).toBe(0)
    expect(data.snapshot_at).toBe(0)
    expect(data.stale).toBe(true)
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
