# data-gateway

Unified data service layer for openclawd.co — CF Worker + D1 (Hono).

## Architecture

```
Local cron ──POST /ingest/* (Bearer)──> data.openclawd.co (Worker)
                                           │
                                           ├── D1: openclaw-memcare
                                           └── D1: openclaw-graph

memcare.openclawd.co  ──GET /api/memcare/*──┘  (CORS + cache)
```

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Gateway health check |
| POST | `/ingest/memcare/health` | Bearer | Ingest daily health JSON |
| GET | `/api/memcare/health?from=&to=` | none | Query health records |

## Setup

```bash
npm install

# Create D1 databases
wrangler d1 create openclaw-memcare
wrangler d1 create openclaw-graph

# Update wrangler.toml with the returned database_ids

# Apply schema
wrangler d1 execute openclaw-memcare --file=migrations/0001_init.sql --remote

# Set secret
wrangler secret put INGEST_TOKEN

# Deploy
npm run deploy
```

## Tests

```bash
npm test
```

## Spec

SPEC-215 — data-gateway 数据/代码分离 (P1 memcare 灰度切换)
