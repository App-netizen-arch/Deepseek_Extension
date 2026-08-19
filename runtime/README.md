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
