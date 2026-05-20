import { describe, it, expect } from 'vitest'
import app from '../src/index'

// ─── Minimal D1 stub for graph_snapshots ────────────────────────
type Row = {
  snapshot_id: string
  payload_json: string
  node_count: number
  edge_count: number
  updated_at: number
}

function makeD1Stub() {
  const store = new Map<string, Row>()
  return {
    prepare(sql: string) {
      const sqlStr = sql.trim()
      const args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) {
          args.push(...a)
          return stmt
        },
        async run() {
          if (sqlStr.startsWith('INSERT INTO graph_snapshots')) {
            const [snapshot_id, payload_json, node_count, edge_count, updated_at] =
              args as [string, string, number, number, number]
            store.set(snapshot_id, {
              snapshot_id,
              payload_json,
              node_count,
              edge_count,
              updated_at,
            })
          }
          return { success: true, meta: {} }
        },
        async first<T>() {
          if (sqlStr.includes('FROM graph_snapshots')) {
            const [snapshot_id] = args as [string]
            const row = store.get(snapshot_id)
            if (!row) return null
            return {
              payload_json: row.payload_json,
              node_count: row.node_count,
              edge_count: row.edge_count,
              updated_at: row.updated_at,
            } as unknown as T
          }
          return null
        },
        async all() {
          return { results: [] }
        },
      }
      return stmt
    },
  }
}

const TEST_TOKEN = 'test-secret-token-graph'

function makeEnv() {
  return {
    DB_MEMCARE: makeD1Stub() as unknown as D1Database,
    DB_GRAPH: makeD1Stub() as unknown as D1Database,
    INGEST_TOKEN: TEST_TOKEN,
  }
}

const sampleGraph = {
  nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ],
  edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
  meta: { version: 'test-1' },
}

// ─── Auth ────────────────────────────────────────────────────────
describe('POST /ingest/graph/upsert — auth', () => {
  it('rejects missing Authorization', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleGraph),
      },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })

  it('rejects wrong token', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong',
        },
        body: JSON.stringify(sampleGraph),
      },
      makeEnv()
    )
    expect(res.status).toBe(401)
  })
})

// ─── Payload validation ─────────────────────────────────────────
describe('POST /ingest/graph/upsert — payload validation', () => {
  it('rejects non-JSON body', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: 'not-json',
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects body missing nodes/edges arrays', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ nodes: 'oops' }),
      },
      makeEnv()
    )
    expect(res.status).toBe(400)
  })

  it('rejects payload > 8MB via Content-Length', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Length': String(9 * 1024 * 1024),
        },
        body: JSON.stringify(sampleGraph),
      },
      makeEnv()
    )
    expect(res.status).toBe(413)
  })
})

// ─── Happy path + UPSERT idempotency ────────────────────────────
describe('POST /ingest/graph/upsert — happy path', () => {
  const env = makeEnv()

  it('inserts valid snapshot and returns 200', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(sampleGraph),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      snapshot_id: string
      node_count: number
      edge_count: number
    }
    expect(json.ok).toBe(true)
    expect(json.snapshot_id).toBe('latest')
    expect(json.node_count).toBe(3)
    expect(json.edge_count).toBe(2)
  })

  it('UPSERT second time is idempotent and overwrites', async () => {
    const updated = {
      ...sampleGraph,
      nodes: [...sampleGraph.nodes, { id: 'd', label: 'D' }],
    }
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(updated),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { node_count: number }
    expect(json.node_count).toBe(4)
  })

  it('supports custom snapshot_id (versioned)', async () => {
    const res = await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ ...sampleGraph, snapshot_id: 'v-abc123' }),
      },
      env
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { snapshot_id: string }
    expect(json.snapshot_id).toBe('v-abc123')
  })
})

// ─── GET /api/graph ─────────────────────────────────────────────
describe('GET /api/graph', () => {
  it('returns 404 when no snapshot exists', async () => {
    const res = await app.request('/api/graph', {}, makeEnv())
    expect(res.status).toBe(404)
  })

  it('returns the latest snapshot verbatim with metadata headers', async () => {
    const env = makeEnv()
    await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(sampleGraph),
      },
      env
    )

    const res = await app.request('/api/graph', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Snapshot-Id')).toBe('latest')
    expect(res.headers.get('X-Node-Count')).toBe('3')
    expect(res.headers.get('X-Edge-Count')).toBe('2')

    const body = (await res.json()) as typeof sampleGraph
    expect(body.nodes.length).toBe(3)
    expect(body.edges.length).toBe(2)
    expect(body.meta?.version).toBe('test-1')
  })

  it('fetches a specific snapshot_id when provided', async () => {
    const env = makeEnv()
    await app.request(
      '/ingest/graph/upsert',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ ...sampleGraph, snapshot_id: 'v-xyz' }),
      },
      env
    )
    const res = await app.request('/api/graph?snapshot_id=v-xyz', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Snapshot-Id')).toBe('v-xyz')
  })
})
