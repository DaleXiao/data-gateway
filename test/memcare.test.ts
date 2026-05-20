import { describe, it, expect, beforeAll } from 'vitest'
import app from '../src/index'

// ─── Minimal D1 stub ────────────────────────────────────────────
// Simulates just enough of D1 for unit tests (no real Cloudflare runtime needed)
type Row = { date: string; payload_json: string; updated_at: number }
const _store = new Map<string, Row>()

function makeD1Stub() {
  return {
    prepare(sql: string) {
      const sqlStr = sql.trim()
      const args: unknown[] = []
      return {
        bind(...a: unknown[]) {
          args.push(...a)
          return this
        },
        async run() {
          if (sqlStr.startsWith('INSERT INTO health_daily')) {
            const [date, payload_json, updated_at] = args as [string, string, number]
            _store.set(date, { date, payload_json, updated_at })
          }
          return { success: true, meta: {} }
        },
        async all() {
          if (sqlStr.includes('SELECT') && sqlStr.includes('health_daily')) {
            const [from, to] = args as [string, string]
            const results = [..._store.values()]
              .filter((r) => r.date >= from && r.date <= to)
              .sort((a, b) => a.date.localeCompare(b.date))
            return { results }
          }
          return { results: [] }
        },
      }
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
