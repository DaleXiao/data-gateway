import { describe, it, expect } from 'vitest'
import app from '../src/index'

// ─── D1 stub supporting important_topics + batch ──────────────────────
type Row = {
  id: string
  text: string
  importance: number
  category: string | null
  scope: string | null
  ts: number
  snapshot_at: number
}

function makeD1Stub() {
  const store: Row[] = []
  function prepare(sql: string) {
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
        execute(sqlStr, args, store)
        return { success: true, meta: {} }
      },
      async all() {
        return { results: query(sqlStr, args, store) }
      },
    }
    return stmt
  }
  return {
    prepare,
    async batch(stmts: Array<{ _sql: string; _args: unknown[] }>) {
      for (const s of stmts) execute(s._sql, s._args, store)
      return stmts.map(() => ({ success: true, meta: {} }))
    },
  }
}

function execute(sql: string, args: unknown[], store: Row[]) {
  if (sql.startsWith('DELETE FROM important_topics')) {
    store.length = 0
    return
  }
  if (sql.startsWith('INSERT INTO important_topics')) {
    const [id, text, importance, category, scope, ts, snapshot_at] = args as [
      string, string, number, string | null, string | null, number, number,
    ]
    store.push({ id, text, importance, category, scope, ts, snapshot_at })
    return
  }
}

function query(sql: string, args: unknown[], store: Row[]) {
  if (sql.startsWith('SELECT') && sql.includes('important_topics')) {
    const limit = Number(args[0] ?? 50)
    return [...store].sort((a, b) => b.importance - a.importance).slice(0, limit)
  }
  return []
}

const TOKEN = 'test-token-it-1'

function makeEnv() {
  return {
    DB_MEMCARE: makeD1Stub() as unknown as D1Database,
    DB_GRAPH: makeD1Stub() as unknown as D1Database,
    INGEST_TOKEN: TOKEN,
  }
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
}

describe('POST /ingest/memcare/important-topics — auth', () => {
  it('rejects missing Authorization', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv(),
    )
    expect(res.status).toBe(401)
  })
  it('rejects wrong token', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: '{}' },
      makeEnv(),
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /ingest/memcare/important-topics — validation', () => {
  it('rejects missing snapshot_at', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ items: [] }) },
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })
  it('rejects items > 100', async () => {
    const big = Array.from({ length: 101 }, (_, i) => ({
      id: `m${i}`, text: 't', importance: 0.9, timestamp: 1,
    }))
    const res = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ snapshot_at: 1, items: big }) },
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })
  it('rejects importance out of [0,1]', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ snapshot_at: 1, items: [{ id: 'a', text: 't', importance: 1.5, timestamp: 1 }] }),
      },
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })
  it('rejects text > 2000 chars', async () => {
    const res = await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          snapshot_at: 1,
          items: [{ id: 'a', text: 'x'.repeat(2001), importance: 0.9, timestamp: 1 }],
        }),
      },
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /ingest/memcare/important-topics + GET round-trip', () => {
  it('ingests and reads back in importance DESC order', async () => {
    const env = makeEnv()
    const snapshot_at = Date.now()
    const items = [
      { id: 'm1', text: 'A', importance: 0.85, category: 'fact', scope: 'global', timestamp: 1000 },
      { id: 'm2', text: 'B', importance: 0.95, category: 'preference', scope: 'global', timestamp: 2000 },
      { id: 'm3', text: 'C', importance: 0.9, timestamp: 3000 },
    ]
    const ingestRes = await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ snapshot_at, items }) },
      env,
    )
    expect(ingestRes.status).toBe(200)
    const ingestJson = await ingestRes.json() as { ok: boolean; count: number; snapshot_at: number }
    expect(ingestJson).toEqual({ ok: true, count: 3, snapshot_at })

    const getRes = await app.request('/api/memcare/important-topics?limit=10', {}, env)
    expect(getRes.status).toBe(200)
    const body = await getRes.json() as { items: Array<{ id: string; importance: number }>; snapshot_at: number; stale: boolean }
    expect(body.items.map((i) => i.id)).toEqual(['m2', 'm3', 'm1'])
    expect(body.snapshot_at).toBe(snapshot_at)
    expect(body.stale).toBe(false)
  })

  it('replaces whole table on second ingest', async () => {
    const env = makeEnv()
    await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          snapshot_at: 1,
          items: [
            { id: 'old1', text: 'x', importance: 0.9, timestamp: 1 },
            { id: 'old2', text: 'y', importance: 0.91, timestamp: 1 },
          ],
        }),
      },
      env,
    )
    await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          snapshot_at: 2,
          items: [{ id: 'new1', text: 'z', importance: 0.99, timestamp: 1 }],
        }),
      },
      env,
    )
    const res = await app.request('/api/memcare/important-topics', {}, env)
    const body = await res.json() as { items: Array<{ id: string }> }
    expect(body.items.map((i) => i.id)).toEqual(['new1'])
  })

  it('marks stale=true when snapshot is older than 36h', async () => {
    const env = makeEnv()
    const oldTs = Date.now() - 48 * 60 * 60 * 1000
    await app.request(
      '/ingest/memcare/important-topics',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          snapshot_at: oldTs,
          items: [{ id: 'a', text: 't', importance: 0.9, timestamp: 1 }],
        }),
      },
      env,
    )
    const res = await app.request('/api/memcare/important-topics', {}, env)
    const body = await res.json() as { stale: boolean }
    expect(body.stale).toBe(true)
  })

  it('returns empty + stale=true when no rows', async () => {
    const res = await app.request('/api/memcare/important-topics', {}, makeEnv())
    const body = await res.json() as { items: unknown[]; snapshot_at: number; stale: boolean }
    expect(body.items).toEqual([])
    expect(body.snapshot_at).toBe(0)
    expect(body.stale).toBe(true)
  })

  it('clamps limit > 100 to 100', async () => {
    const env = makeEnv()
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, text: 't', importance: 0.5 + i / 1000, timestamp: 1,
    }))
    await app.request(
      '/ingest/memcare/important-topics',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ snapshot_at: Date.now(), items }) },
      env,
    )
    const res = await app.request('/api/memcare/important-topics?limit=500', {}, env)
    const body = await res.json() as { items: unknown[] }
    expect(body.items.length).toBe(100)
  })
})
