# Better DeepSeek Local Runtime — Phase 2

This directory contains the local-first runtime required by the Better DeepSeek agent architecture, including the native Code Agent and read-only Web Agent MVP.

## Security boundary

- Listens only on `127.0.0.1`.
- Every authenticated REST request uses `Authorization: Bearer <token>`.
- WebSocket clients authenticate with a token in their first message; unauthenticated sockets are closed after 5 seconds.
- The runtime never binds to `0.0.0.0` and does not expose a public API.
- SQLite state and audit data stay under `runtime/data/` and are ignored by Git.
- No telemetry or cloud upload is implemented by the runtime by default.
- Code execution uses a server-side language allowlist and argument arrays only.
- The Web Agent is read-only: it does not log in, submit forms, post, solve CAPTCHAs, bypass paywalls, or modify remote content.
- Web pages are untrusted input and are never treated as tool commands.

## Setup

```bash
cd runtime
npm install
npx playwright install chromium
TOKEN=$(node scripts/setup-token.mjs)
export BDS_RUNTIME_TOKEN="$TOKEN"
export BDS_WORKSPACE="/absolute/path/to/your/project"
npm run build
npm start
```

`setup-token` intentionally prints the token instead of writing it to disk. Keep the token local and store it only in the existing Better DeepSeek extension's `chrome.storage.local` through the runtime bridge.

Optional environment variables:

```text
BDS_RUNTIME_PORT=3037
BDS_RUNTIME_TOKEN=<32+ character token>
BDS_RUNTIME_DB=./data/runtime.db
BDS_WORKSPACE=/absolute/path/to/project
```

## Web Agent MVP

DeepSeek can emit:

```text
BDS:WEB_AGENT
goal = "Compare recent protein folding models after AlphaFold 3"
max_pages = 10
max_depth = 2
time_budget = 15
output_mode = "summary"
```

The runtime launches a headless Chromium instance through Playwright, uses a public search page when no `start_url` is provided, renders JavaScript, extracts readable page text, records citations, follows relevant public links, and stops at the configured page/depth/time budget. Each citation contains the source URL, title, access time, and an excerpt taken from the rendered page.

Web Agent limits are capped at 25 pages, depth 3, 20 minutes per task, and 10 requests per domain per minute. `robots.txt`, `noindex`, and `nofollow` are honored where detectable. Failed or blocked pages are recorded and skipped rather than failing the entire task.

The MVP synthesis is local and deterministic: it ranks collected evidence against the research goal and assembles a cited evidence summary. No remote LLM call is required to run the browser agent.

## Web Agent endpoints

```text
GET  /v1/status                       authenticated
POST /v1/web/start                    authenticated
GET  /v1/web/status/:task_id          authenticated
POST /v1/web/cancel                   authenticated
WS   /ws                              authenticated after first message
```

WebSocket messages:

```text
{"type":"web/start","payload":{"goal":"...","max_pages":10,"max_depth":2,"time_budget_minutes":15}}
{"type":"web/cancel","payload":{"task_id":"web-..."}}
```

The runtime streams `web/event` messages for task start, page visits, skipped pages, completion, and cancellation. Completion includes the synthesized answer and citations.

## Code Agent MVP

The Phase 1 `BDS:LOCAL_EXEC` implementation remains available with explicit language enablement, argument-array execution, 15-second one-shot timeouts, output limits, process cleanup, and SQLite audit events.

## Chrome integration overlay

`../extension-integration/` contains the drop-in runtime client, tag bridge, and status UI intended to be imported into the existing Better DeepSeek MV3 extension. The UI now renders Web Agent progress and source links. This remains an integration overlay, not a replacement extension.
