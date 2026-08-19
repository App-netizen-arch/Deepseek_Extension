# Better DeepSeek Local Runtime — Phase 4

This directory contains the local-first runtime required by the Better DeepSeek agent architecture, including the native Code Agent, Web Agent MVP, MathBridge MVP, and the first production Web Agent layer.

## Security boundary

- Listens only on `127.0.0.1`.
- Every authenticated REST request uses `Authorization: Bearer <token>`.
- WebSocket clients authenticate in their first message; unauthenticated sockets are closed after 5 seconds.
- The runtime never binds to `0.0.0.0`.
- SQLite state and audit data stay under `runtime/data/` and are ignored by Git.
- No telemetry or cloud upload is implemented by the runtime by default.
- Web content is untrusted input and never becomes a tool command.
- Critical actions such as login, payments, posting, and account changes remain outside autonomous execution.

## Setup

```bash
cd runtime
npm install
npx playwright install chromium
TOKEN=$(node scripts/setup-token.mjs)
export BDS_RUNTIME_TOKEN="$TOKEN"
export BDS_SESSION_KEY="$(openssl rand -hex 32)"
export BDS_WORKSPACE="/absolute/path/to/your/project"
npm run build
npm start
```

`setup-token` prints the token instead of writing it to disk. Keep both the runtime token and session key local. The extension stores only the runtime bearer token in `chrome.storage.local`.

## Production Web Agent

The production API follows the specification:

```text
POST   /tasks
GET    /tasks/:id
GET    /tasks/:id/events
POST   /tasks/:id/pause
POST   /tasks/:id/resume
POST   /tasks/:id/cancel
POST   /approvals/:id
GET    /sessions
POST   /sessions
POST   /sessions/:name/save
DELETE /sessions/:name
WS     /ws
```

Task example:

```json
{
  "goal": "Find three independent sources about X",
  "start_url": "https://example.com",
  "max_pages": 20,
  "max_depth": 3,
  "time_budget_minutes": 20,
  "interaction_level": "click",
  "allowed_domains": ["example.com"],
  "blocked_domains": ["social.example"]
}
```

### Interaction levels

- `read-only` — default; open pages and extract content.
- `click` — may click low-risk expanders, pagination, and similar controls.
- `fill-forms` — search-field filling requires an explicit local approval. The runtime never submits forms automatically.

### Persistent sessions

Create a visible login session:

```text
POST /sessions
{"name":"example-account"}
```

A normal browser window opens for the user to log in manually. The runtime never receives or stores the password. When the user is finished:

```text
POST /sessions/example-account/save
```

The browser storage state is encrypted locally with AES-256-GCM before it is written to SQLite. The session is later reusable by a production task through `session_name`. Sessions can be revoked with `DELETE /sessions/:name`.

### Checkpointing and background jobs

Production tasks run in the local runtime rather than inside the extension popup. The task queue, visited URLs, and collected source records are checkpointed to SQLite after each page. A disconnected extension can reconnect and inspect `/tasks/:id`. A paused persisted task can be resumed after the runtime restarts by calling `/tasks/:id/resume`.

Every page/action is recorded in the audit log and can be retrieved through `/tasks/:id/events`.

### Safety and approvals

The production agent respects `robots.txt`, `noindex`, `nofollow`, domain allow/block lists, and the per-domain rate limit. It never solves CAPTCHAs, bypasses paywalls, submits credentials, posts messages, performs payments, or makes account changes automatically.

`fill-forms` creates a five-minute approval request. Approve or deny it with:

```text
POST /approvals/<approval_id>
{"decision":"approved"}
```

An expired or denied approval prevents the form-fill action.

## Existing MVP endpoints

The previous endpoints remain available:

```text
POST /v1/web/start
GET  /v1/web/status/:task_id
POST /v1/web/cancel
POST /v1/code/execute
POST /v1/math/analyze
WS   /ws
```

The Phase 1 Code Agent and Phase 3 MathBridge security boundaries remain unchanged.
