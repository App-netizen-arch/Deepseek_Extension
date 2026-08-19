# Better DeepSeek Local Runtime — Phase 1

This directory contains the local-only runtime required by the Better DeepSeek agent architecture, including the Phase 1 native Code Agent bridge.

## Security boundary

- Listens only on `127.0.0.1`.
- Every authenticated REST request uses `Authorization: Bearer <token>`.
- WebSocket clients authenticate with a token in their first message; unauthenticated sockets are closed after 5 seconds.
- The runtime never binds to `0.0.0.0` and does not expose a public API.
- SQLite state and audit data stay under `runtime/data/` and are ignored by Git.
- No cloud upload is implemented.
- Code execution uses a server-side language allowlist and argument arrays only; shell command strings are never accepted.
- Languages are disabled by default and must be explicitly enabled through the authenticated local API.
- Code is written to a 0600 temporary file and execution is bounded by a 15-second one-shot timeout, 1 MiB captured output, 256 KiB source input, and three concurrent jobs.
- Timeout cleanup kills the process tree on supported platforms.

## Setup

```bash
cd runtime
npm install
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

For Lean 4, `BDS_WORKSPACE` should point at the local Lake project so `lake env lean` can resolve its environment and imports. Zig and Python one-shot programs run from isolated temporary directories.

## Endpoints

```text
GET  /health
GET  /v1/health
GET  /v1/status                       authenticated
GET  /v1/code/languages               authenticated
POST /v1/code/languages/enable        authenticated
POST /v1/code/execute                 authenticated
POST /v1/tags/parse                   authenticated
POST /v1/audit                        authenticated
WS   /ws                              authenticated after first message
```

Enable a language explicitly before execution:

```bash
curl -H "Authorization: Bearer $BDS_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"language":"zig","enabled":true}' \
  http://127.0.0.1:3037/v1/code/languages/enable
```

Run a local program directly:

```bash
curl -H "Authorization: Bearer $BDS_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"language":"zig","code":"const std = @import(\"std\"); pub fn main() !void { std.debug.print(\"hello\\n\", .{}); }","timeout_seconds":15}' \
  http://127.0.0.1:3037/v1/code/execute
```

## BDS:LOCAL_EXEC

DeepSeek can emit:

```text
BDS:LOCAL_EXEC
language = "zig"
code = "const std = @import(\"std\"); ..."
timeout = 15
```

The extension's tag bridge forwards the full assistant message over the authenticated WebSocket. The runtime parses the tag, validates the language against the immutable server-side command map, executes the generated file locally, and returns a structured `code/result` event containing `stdout`, `stderr`, `exit_code`, `duration_ms`, `truncated`, and `timed_out`.

Supported Phase 1 languages and command maps:

```json
{
  "zig": ["zig", "run", "<temporary-file>"],
  "lean4": ["lake", "env", "lean", "<temporary-file>"],
  "python": ["python3", "<temporary-file>"]
}
```

The placeholders above are conceptual; the runtime constructs the final argument array in server-side TypeScript. Web content cannot change the executable or add arbitrary arguments.

## Chrome integration overlay

`../extension-integration/` contains the drop-in runtime client, tag bridge, and status UI intended to be imported into the existing Better DeepSeek MV3 extension. This remains an integration overlay, not a replacement extension.
