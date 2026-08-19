# Better DeepSeek Local Runtime — Phase 0

This directory contains the local-only runtime required by the Better DeepSeek agent architecture.

## Security boundary

- Listens only on `127.0.0.1`.
- Every authenticated REST request uses `Authorization: Bearer <token>`.
- WebSocket clients authenticate with a token in their first message; unauthenticated sockets are closed after 5 seconds.
- The runtime never binds to `0.0.0.0` and does not expose a public API.
- SQLite state and audit data stay under `runtime/data/` and are ignored by Git.
- No cloud upload is implemented.

## Setup

```bash
cd runtime
npm install
TOKEN=$(node scripts/setup-token.mjs)
export BDS_RUNTIME_TOKEN="$TOKEN"
npm run build
npm start
```

`setup-token` intentionally prints the token instead of writing it to disk. Copy the generated token into the existing Better DeepSeek extension's `chrome.storage.local` through its runtime settings/bridge.

Optional environment variables:

```text
BDS_RUNTIME_PORT=3037
BDS_RUNTIME_TOKEN=<32+ character token>
BDS_RUNTIME_DB=./data/runtime.db
```

## Endpoints

```text
GET  /health
GET  /v1/health
GET  /v1/status                 authenticated
POST /v1/tags/parse             authenticated
POST /v1/audit                  authenticated
WS   /ws                        authenticated after first message
```

## Phase 0 tag handling

The parser recognizes `BDS:<TAG>` markers and simple `key = value` attributes. Values may be quoted strings, booleans, numbers, or JSON arrays/objects.

The runtime only parses and reports tags in Phase 0. It does not execute shell commands, browse pages, modify files, or process PDFs yet.

## Chrome integration overlay

`../extension-integration/` contains the drop-in runtime client, tag bridge, and status UI intended to be imported into the existing Better DeepSeek MV3 extension. This is an integration overlay, not a replacement extension.
