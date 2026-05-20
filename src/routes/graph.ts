import { Hono } from 'hono'
import type { Env } from '../index'

export const graphRouter = new Hono<{ Bindings: Env }>()

// ── Auth helper ──────────────────────────────────────────────
function checkBearer(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false
  const parts = authHeader.split(' ')
  return parts[0] === 'Bearer' && parts[1] === token
}

// ── Payload size guard ──────────────────────────────────────
// CF Worker request body limit is 100 MB, but graph.json is ~1.5 MB.
// Cap explicit at 8 MB to fail fast on runaway exports.
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

// ── POST /ingest/graph/upsert ────────────────────────────────
// Bearer-authenticated; accepts full graph snapshot {nodes, edges, meta?}
// Stores under snapshot_id (defaults to "latest"); UPSERT-style replace.
graphRouter.post('/upsert', async (c) => {
  if (!checkBearer(c.req.header('Authorization'), c.env.INGEST_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Read raw text first so we can size-check before parse
  const raw = await c.req.text()
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return c.json(
      { error: 'Payload too large', limit_bytes: MAX_PAYLOAD_BYTES, got_bytes: raw.length },
      413
    )
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'Payload must be an object' }, 400)
  }

  const record = body as Record<string, unknown>
  const nodes = record.nodes
  const edges = record.edges

  if (!Array.isArray(nodes)) {
    return c.json({ error: 'Missing or non-array field: nodes' }, 400)
  }
  if (!Array.isArray(edges)) {
    return c.json({ error: 'Missing or non-array field: edges' }, 400)
  }

  const snapshotId =
    typeof record.snapshot_id === 'string' && record.snapshot_id.length > 0
      ? record.snapshot_id
      : 'latest'

  const payloadJson = raw // store the canonical JSON we received
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
    .bind(snapshotId, payloadJson, nodes.length, edges.length, updatedAt)
    .run()

  return c.json({
    ok: true,
    snapshot_id: snapshotId,
    node_count: nodes.length,
    edge_count: edges.length,
    updated_at: updatedAt,
  })
})

// ── GET /api/graph ───────────────────────────────────────────
// Returns the "latest" snapshot. CORS-open (read-only).
graphRouter.get('/', async (c) => {
  const snapshotId = c.req.query('snapshot_id') ?? 'latest'

  const row = await c.env.DB_GRAPH.prepare(
    `SELECT payload_json, node_count, edge_count, updated_at
     FROM graph_snapshots
     WHERE snapshot_id = ?1`
  )
    .bind(snapshotId)
    .first<{ payload_json: string; node_count: number; edge_count: number; updated_at: number }>()

  if (!row) {
    return c.json({ error: 'snapshot not found', snapshot_id: snapshotId }, 404)
  }

  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    return c.json({ error: 'corrupt snapshot payload' }, 500)
  }

  // Attach lightweight meta on top of the user payload (non-destructive: only if it's an object)
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    ;(payload as Record<string, unknown>)._meta = {
      snapshot_id: snapshotId,
      node_count: row.node_count,
      edge_count: row.edge_count,
      updated_at: row.updated_at,
    }
  }

  return c.json(payload)
})
