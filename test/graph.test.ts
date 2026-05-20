import { describe, it, expect } from 'vitest'
import app from '../src/index'

// ─── Minimal D1 stub for graph_snapshots ────────────────────────
type Row = { snapshot_id: string; payload_json: string; node_count: number; edge_count: number; updated_at: number }

function makeGraphD1Stub() {
  const _store = new Map<string, Row>()
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
          if (sqlStr.startsWith('INSERT INTO graph_snapshots')) {
            const [snapshot_id, payload_json, node_count, edge_count, updated_at] = args as [
              string, string, number, number, number,
            ]
            _store.set(snapshot_id, { snapshot_id, payload_json, node_count, edge_count, updated_at })
          }
          return { success: true, meta: {} }
        },
        async first<T>() {
          if (sqlStr.includes('SELECT') && sqlStr.includes('graph_snapshots')) {
            const [snapshot_id] = args as [string]
            return (_store.get(snapshot_id) as unknown as T) ?? null
          }
          return null
        },
      }
    },
  }
}

const TEST_TOKEN = 'graph-' + 'test-' + 'tok-xyz'

function makeEnv() {
  return {
    DB_MEMCARE: makeGraphD1Stub() as unknown as D1Database,
    DB_GRAPH: makeGraphD1Stub() as unknown as D1Database,
    INGEST_TOKEN: TEST_TOKEN,
  }
}

// ─── Tests ──────────────────────────────────────────────────────

describe('POST /ingest/graph/upsert — auth', () => {
  it('rejects missing Authorization', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: [], edges: [] }) },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })

  it('rejects wrong token', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'wrong-tok-12345' },
        body: JSON.stringify({ nodes: [], edges: [] }),
      },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /ingest/graph/upsert — payload validation', () => {
  it('rejects missing nodes array', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ edges: [] }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects missing edges array', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ nodes: [] }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: 'not-json{',
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects payload > 8MB', async () => {
    // Build a ~9MB body
    const huge = 'x'.repeat(9 * 1024 * 1024)
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: huge,
      },
      makeEnv()
    )
    expect(res.status).toBe(413)
  })
})

describe('POST /ingest/graph/upsert — happy path + idempotency', () => {
  it('upserts a snapshot and returns counts', async () => {
    const env = makeEnv()
    const payload = {
      nodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
    }
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify(payload),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; snapshot_id: string; node_count: number; edge_count: number }
    expect(json.ok).toBe(true)
    expect(json.snapshot_id).toBe('latest')
    expect(json.node_count).toBe(3)
    expect(json.edge_count).toBe(2)
  })

  it('upsert a second time overwrites', async () => {
    const env = makeEnv()
    const first = { nodes: [{ id: 'n1' }], edges: [] }
    const second = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }
    await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify(first),
      },
      env
    )
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify(second),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { node_count: number; edge_count: number }
    expect(json.node_count).toBe(2)
    expect(json.edge_count).toBe(1)
  })

  it('honors custom snapshot_id', async () => {
    const env = makeEnv()
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ snapshot_id: 'v-abc123', nodes: [], edges: [] }),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = await res.json() as { snapshot_id: string }
    expect(json.snapshot_id).toBe('v-abc123')
  })
})

describe('GET /api/graph', () => {
  it('returns 404 when snapshot missing', async () => {
    const res = await app.request('/api/graph', {}, makeEnv())
    expect(res.status).toBe(404)
  })

  it('returns latest snapshot with _meta after ingest', async () => {
    const env = makeEnv()
    await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ nodes: [{ id: 'x' }], edges: [] }),
      },
      env
    )
    const res = await app.request('/api/graph', {}, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { nodes: unknown[]; edges: unknown[]; _meta?: { node_count: number; edge_count: number; snapshot_id: string } }
    expect(Array.isArray(data.nodes)).toBe(true)
    expect(data._meta?.node_count).toBe(1)
    expect(data._meta?.snapshot_id).toBe('latest')
  })
})
