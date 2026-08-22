# Better DeepSeek Local Runtime — Phase 5

This directory contains the local-first runtime required by the Better DeepSeek agent architecture, including the native Code Agent, Web Agent MVP/production layer, MathBridge MVP, and MathBridge production document pipeline.

## Security boundary

- Runtime services listen only on `127.0.0.1`.
- Authenticated APIs require `Authorization: Bearer <token>`.
- WebSocket clients authenticate with the same local token.
- The runtime never accepts raw shell command strings.
- Code tools operate only inside `BDS_WORKSPACE` unless a future explicitly approved extension permits otherwise.
- `.env`, SSH keys, token files, `.git`, and dependency trees are excluded from default code search/file access.
- Destructive code actions require an expiring approval.
- No package installation, sudo, login, or account changes are performed by the Code Agent.
- No telemetry or cloud upload is implemented by the runtime by default.

## Setup

```bash
cd runtime
npm install
npx playwright install chromium
TOKEN=$(node scripts/setup-token.mjs)
export BDS_RUNTIME_TOKEN="$TOKEN"
export BDS_SESSION_KEY="$(openssl rand -hex 32)"
export BDS_WORKSPACE="/absolute/path/to/project"
export BDS_DOCUMENT_ROOT="/absolute/path/to/papers"
export BDS_DEEPSEEK_API_KEY="<your-key>"
export BDS_DEEPSEEK_MODEL="deepseek-v4-pro"
npm run build
npm start
```

The main runtime listens on port `3037` by default. The production Code Agent runs in the same Node process on `3038` by default (`BDS_CODE_PORT` can override it). Both services bind only to `127.0.0.1`.

DeepSeek's current API is OpenAI-compatible at `https://api.deepseek.com`, supports V4-Pro/V4-Flash, and supports function/tool calling. The runtime sends only the explicitly selected workspace context and tool-call messages; secrets are not part of the default tool surface. urlDeepSeek API documentationhttps://api-docs.deepseek.com/quick_start/pricing-details-cny/

## Production Code Agent

The production Code Agent implements the workspace/tool execution plane described by the specification.

### Tag

```text
BDS:CODE_AGENT
  task = "Fix the failing Lean 4 proof"
  workspace = "/absolute/path/to/project"
  max_iterations = 30
  approval = "auto_for_known"
  tools = ["fs", "shell", "git", "lean4"]
```

The extension routes `BDS:CODE_AGENT` over the dedicated authenticated Code Agent WebSocket:

```text
WS ws://127.0.0.1:3038/code/ws
```

### Production APIs

```text
GET    /code/health
GET    /code/workspace
POST   /code/workspace/index
POST   /code/tasks
GET    /code/tasks/:id
POST   /code/tasks/:id/pause
POST   /code/tasks/:id/resume
POST   /code/tasks/:id/cancel
POST   /code/tools/:tool
POST   /code/approvals/:id
GET    /code/memory
WS     /code/ws
```

### Tool surface

Low-risk tools include file reading, directory listing, code search, Git status/diff, LSP diagnostics, and workspace memory.

Medium-risk tools include targeted file edits, file writes, project builds/tests, compiler/prover checks, and explicitly argument-array based `shell.run`.

High-risk tools include file deletion and Git commit. They create five-minute approvals containing the exact tool and arguments. Approval is required before the destructive action executes.

The runtime validates all model-generated tool-call JSON before execution. Every executable is selected from a server-side allowlist; shell commands are always arrays passed to `spawn()` with `shell:false`.

### Agent loop

```text
task
 → DeepSeek tool-call planner
 → inspect workspace
 → search/read
 → targeted edit
 → compile/test/proof check
 → inspect error
 → repeat
 → final summary
```

The loop is bounded by `max_iterations` (1–30). Tasks and checkpoints are persisted in SQLite. Pause/resume/cancel are checked between model and tool turns.

### Workspace memory

Repo-specific memory is stored in SQLite using `(workspace, key)` and is accessible through the Code Agent memory endpoint. The memory layer remains local and is scoped to the configured workspace.

### First-class compiler/prover commands

The server-side command map includes adapters for Zig, Lean 4/Lake, Rust/Cargo, Coq, Isabelle, Python/pytest, and SageMath. Languages can remain disabled for the existing one-shot `BDS:LOCAL_EXEC` path, while production compiler checks are still constrained to the fixed command map.

## MathBridge production

### PDF → MathIR

```text
BDS:MATH_PDF
  file = "/absolute/path/to/papers/paper.pdf"
  mode = "full"
  output = "mathir"
```

REST:

```text
POST /v1/math/pdf
GET  /v1/math/documents
GET  /v1/math/documents/:id
DELETE /v1/math/documents/:id
```

### MathIR reasoning

```text
BDS:MATH_ASK
  document_id = "doc_001"
  question = "Explain the proof of Theorem 5.2"
```

REST:

```text
POST /v1/math/ask
```

Only retrieved MathIR context is eligible for reasoning; the original PDF is not automatically forwarded.

### TikZ

```text
BDS:TIKZ_RENDER
  source = "\\begin{tikzpicture}..."
  output = "svg"
```

REST:

```text
POST /v1/math/tikz
```

The existing MathBridge MVP and production validation layers remain active.

## Production Web Agent

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

## Agent Core (Phase A)

The agent orchestration layer lives in `src/agent/` and persists through the shared SQLite database (migration v4: `agents`, `tasks`).

### Components

| Module | Role |
|---|---|
| `agent/agent.ts` | `AgentState` machine (`created → planning → running → completed/failed/cancelled`, plus `waiting_approval` and `paused`), `AgentPermissions`, `AgentDescriptor`, abstract `Agent` base class with cooperative cancellation (`signal`). |
| `agent/registry.ts` | SQLite CRUD for agents: `register`, `get`, `list(filters)`, `update`, `delete` (leaf-first), `listChildren`. |
| `agent/queue.ts` | Durable task queue: priority 1–10 (10 = highest, oldest first), transactional claim, `ack`/`nack` (bounded retries) /`requeue`/`failTask`, per-agent cancel. Capacity limited by `SECURITY_LIMITS.maxQueueDepth`. |
| `agent/runner.ts` | Drives the lifecycle: claims tasks, launches agent instances, mirrors every state change to the registry, emits events, enforces concurrency. Owns subagent spawning and recursive cancellation. |
| `agent/permissions.ts` | Subagent permission inheritance: tool lists intersect, limits take the minimum (`DEFAULT_MAX_SUBAGENTS=4`, `MAX_SUBAGENT_DEPTH=3`). |
| `mcp/tool.ts` | Tool contract: name, description, JSON-schema parameters, risk tier (`low`/`medium`/`high`/`critical`), execute. |
| `mcp/builtin.ts` | Built-in tools wrapping the hardened code-production helpers (workspace confinement, secret denial, process allowlist). |
| `mcp/registry.ts` | Tool registry with enable/disable persisted in SQLite (`runtime_meta`). |
| `mcp/service.ts` | Invocation gate: registry -> enabled -> agent tool list -> shared risk policy; `high` blocks on an expiring approval, `critical` is denied. |
| `mcp/client.ts` | Minimal MCP streamable-HTTP client (`initialize`, `tools/list`, `tools/call`); remote tools register under `mcp_<server>_<tool>` and pass through the same permission pipeline. |
| `workflow/loader.ts` | Parses/validates `.yml`/`.yaml`/`.json` definitions from `<workspace>/.better-deepseek/workflows` (or `BDS_WORKFLOWS_DIR`): DAG checks, duplicate ids, cycles. |
| `workflow/template.ts` | `{{path}}` interpolation over `{ input, ...stepsById }`; whole-string templates preserve value types, embedded ones stringify. |
| `workflow/runner.ts` | Durable run engine (migration v5 `workflow_runs`): DAG scheduling with bounded concurrency, per-step retries/timeouts, `when` guards, `continue_on_error`, cancellation cascading through the supervisor agent. |
| `agent/demo-agent.ts` | `demo` type — logs "Hello, I am agent X" and completes; reference implementation for new types. |

New agent types implement `doPlan`/`doExecute` and register in `createDefaultFactory()`. Agents invoke tools inside their execution hooks via `this.callTool(name, params)`.

### REST API

All routes require the bearer token.

```text
POST /v1/agent/spawn            { name, type, permissionsOverride?, context?, parentId?, projectId?, sessionId?, task? }
POST /v1/agent/:id/start        -> 202 { agent_id, task_id }
POST /v1/agent/:id/pause
POST /v1/agent/:id/resume
POST /v1/agent/:id/cancel       (cancels the whole subagent subtree)
GET  /v1/agent/:id/status       -> { status: { agent, currentTask?, recentTasks[], children[] } }
GET  /v1/agents?state=&type=&parentId=
```

### Subagents

- `parentId` makes the new agent a subagent: it inherits the parent's `projectId`/`sessionId` unless explicitly overridden.
- `permissionsOverride` is clamped to the parent envelope — tool lists intersect, `maxSubagents` takes the minimum. Overrides can never expand capability.
- A parent rejects further children once its `maxSubagents` budget (default 4) is exhausted, and spawning below depth 3 is refused.
- Spawning under a terminal (completed/failed/cancelled) parent is rejected.
- Cancelling an agent cancels its entire descendant subtree; cancellation never flows upward.
- Passing `task` on spawn enqueues a bootstrap task payload immediately.

### Tools & MCP

Built-in tools (risk tier in parentheses): `fs_read` (low), `fs_write` (medium), `fs_edit` (medium), `shell_run` (high, allowlisted executables only), `git_status` (low), `git_diff` (low), `git_commit` (high), `http_request` (medium, domain allowlist via `BDS_TOOL_ALLOWED_DOMAINS`, redirects not followed).

```text
GET  /v1/tools                     -> tool descriptors + mcp server list
POST /v1/tools/:name/enable
POST /v1/tools/:name/disable
POST /v1/tools/invoke              { agent_id?, tool, params }  (403 on denied/expired approval)
GET  /approvals/pending            -> unresolved approvals (tool + task actions)
POST /approvals/:id                { decision: "approved" | "denied" }
GET  /v1/mcp/servers               -> connected MCP servers
POST /v1/mcp/connect               { name, url }
WS   tools/list | tools/invoke     -> tool/list | tool/result
```

Enforcement order for every call: registry existence -> enabled flag -> agent's `permissions.tools` list -> shared risk policy. `high` tools create an expiring approval (default 5 minutes, `BDS_TOOL_APPROVAL_TTL_MS` to override) and block until a decision arrives over REST/WS; expired approvals are auto-denied and audited.

MCP servers configured in `.better-deepseek.jsonc` (`mcp: [{ name, url, enabled }]`) are auto-connected at startup; failures are logged and non-fatal. Remote tools inherit the server's risk tier (default medium).

### Workflows

Definitions live in `<workspace>/.better-deepseek/workflows/*.yml|json` (override with `BDS_WORKFLOWS_DIR`). Steps may be `tool` (registry tool through the permission pipeline) or `agent` (spawns a subagent under a per-run supervisor, so run cancellation cancels the whole subtree).

```yaml
name: Research and Summarize
description: Search web, extract, summarize.
steps:
  - id: search
    type: tool
    tool: web_search
    params: { query: "{{input.topic}}" }
  - id: extract
    type: tool
    tool: fs_read          # any registered tool
    depends_on: [search]
    params: { path: "{{search.result.path}}" }
  - id: summarize
    type: agent            # agent TYPE (e.g. demo); params become its task payload
    agent: demo
    depends_on: [extract]
    retries: 2             # retry budget for transient failures
    when: "{{extract.result.content}}"   # skip step when falsy
    timeout_ms: 60000      # hard per-step deadline (default 120000)
    continue_on_error: true              # dependents still run if this fails
```

Semantics: steps without `depends_on` run in declared order; independent ready steps launch concurrently (per-run cap 4). A failed step fails the run unless every dependent is released via `continue_on_error`; dependents of unreleased failures are `skipped`. Templates resolve against `{ input, ...stepsById }` (`{{input.x}}`, `{{stepid.result.y}}`, or `{{steps.stepid.result.y}}`).

```text
GET  /v1/workflows                 -> available definitions
POST /v1/workflow/run              { name, input } -> 202 { run_id }
GET  /v1/workflow/:id/status       -> full run record (status + per-step states)
GET  /v1/workflow/runs             -> recent runs
POST /v1/workflow/:id/cancel       -> cancels run + supervisor subtree (200/409)
WS   workflow/run | workflow/cancel -> workflow/event broadcasts
```

Run states: `pending -> running -> completed | failed | cancelled`. Step states: `pending -> running -> completed | failed | skipped`.

### WebSocket commands

Authenticated clients send `{ type, payload }`; lifecycle events broadcast as `agent/event`, status replies as `agent/status`.

```text
agent/spawn | agent/start | agent/pause | agent/resume | agent/cancel | agent/status
```

### Semantics

- `start` is rejected for terminal or already-running/planning agents.
- Paused agents keep queued tasks parked; `resume` releases them.
- `cancel` aborts in-flight work via the agent's signal and cancels all its non-terminal tasks (`cancelled`, never retried).
- Failed attempts retry up to `maxRetries` (default 3), then the task and agent end `failed`.
- Deterministic launch failures (unknown type) fail immediately without consuming retries.
