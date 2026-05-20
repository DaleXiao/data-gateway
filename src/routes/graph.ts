import { Hono } from 'hono'
import type { Env } from '../index'

export const graphRouter = new Hono<{ Bindings: Env }>()

// 8 MB upper bound on raw ingest payload (graph.json ≈ 1.5MB today, plenty of headroom)
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

// ── Auth helper ──────────────────────────────────────────────
function checkBearer(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false
  const parts = authHeader.split(' ')
  return parts[0] === 'Bearer' && parts[1] === token
}

// ── POST /ingest/graph/upsert ────────────────────────────────
// Bearer-authenticated; accepts full graph payload {nodes, edges, meta?}
// UPSERT by snapshot_id (default "latest")
graphRouter.post('/upsert', async (c) => {
  if (!checkBearer(c.req.header('Authorization'), c.env.INGEST_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Reject oversize bodies up front using Content-Length when present
  const cl = c.req.header('Content-Length')
  if (cl && Number(cl) > MAX_PAYLOAD_BYTES) {
    return c.json({ error: 'Payload too large', max_bytes: MAX_PAYLOAD_BYTES }, 413)
  }

  // Read raw text so we can double-check size and avoid re-stringifying on write
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return c.json({ error: 'Failed to read body' }, 400)
  }
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return c.json({ error: 'Payload too large', max_bytes: MAX_PAYLOAD_BYTES }, 413)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Body must be an object' }, 400)
  }
  const record = body as Record<string, unknown>

  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    return c.json({ error: 'Missing required fields: nodes[], edges[]' }, 400)
  }

  const snapshotId =
    typeof record.snapshot_id === 'string' && record.snapshot_id.length > 0
      ? record.snapshot_id
      : 'latest'

  const nodeCount = (record.nodes as unknown[]).length
  const edgeCount = (record.edges as unknown[]).length
  const updatedAt = Date.now()

  await c.env.DB_GRAPH.prepare(
    `INSERT INTO graph_snapshots (snapshot_id, payload_json, node_count, edge_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(snapshot_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       node_count   = excluded.node_count,
       edge_count   = excluded.edge_count,
       updated_at   = excluded.updated_at`
  )
    .bind(snapshotId, raw, nodeCount, edgeCount, updatedAt)
    .run()

  return c.json({
    ok: true,
    snapshot_id: snapshotId,
    node_count: nodeCount,
    edge_count: edgeCount,
    updated_at: updatedAt,
  })
})

// ── GET /api/graph ───────────────────────────────────────────
// Public (CORS); returns latest snapshot JSON payload as-is
graphRouter.get('/', async (c) => {
  const snapshotId = c.req.query('snapshot_id') ?? 'latest'

  const row = await c.env.DB_GRAPH.prepare(
    `SELECT payload_json, node_count, edge_count, updated_at
     FROM graph_snapshots WHERE snapshot_id = ?1`
  )
    .bind(snapshotId)
    .first<{
      payload_json: string
      node_count: number
      edge_count: number
      updated_at: number
    }>()

  if (!row) {
    return c.json({ error: 'Snapshot not found', snapshot_id: snapshotId }, 404)
  }

  // Stream the stored JSON verbatim so payload shape matches graph-export.py output
  return new Response(row.payload_json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Snapshot-Id': snapshotId,
      'X-Node-Count': String(row.node_count),
      'X-Edge-Count': String(row.edge_count),
      'X-Updated-At': String(row.updated_at),
      'Cache-Control': 'public, max-age=60',
    },
  })
})
