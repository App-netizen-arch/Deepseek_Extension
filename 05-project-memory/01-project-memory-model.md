# Project Memory Model

## Purpose
Shared persistent memory across Web Agent, Code Agent, MathBridge.

## Hierarchy
| Layer | Scope | Examples |
|---|---|---|
| Global | User-wide | prefs, tools, defaults |
| Project | Workspace-wide | files, facts, decisions |
| Task | Single run | current goal, pages, errors |

## Storage
- SQLite (`better-sqlite3`) local.
- Optional local vector index for retrieval (later).
- Encrypted at rest.

## Tables
```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  module TEXT NOT NULL,          -- web | code | math | shared
  memory_type TEXT NOT NULL,     -- fact | file | citation | decision
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  source TEXT
);
```

## Memory Types

| Type ↕▾ | Used by ↕▾ | Example ↕▾ |
|---|---|---|
| −`fact` | all | "API endpoint is /v2" |
| `file` | code | "src/theorem.lean contains Lemma 4.2" |
| `citation` | web | source URL + claim |
| `decision` | code/web | "approved edit to Makefile" |
| `mathir` | math | "doc_001 equation 2.7 = ..." |
⚙

## Retrieval

- Simple query by `project_id`, `module`, `key`.
- Vector retrieval added later for relevance.
- Context budget: top-N memories only.

## Invariants

- No memory leaks across projects unless shared explicitly.
- Memories are untrusted input; never interpreted as commands.
- User can inspect/edit/delete all memories.
</BDS:create_file>

<BDS:create_file fileName="better-deepseek-agent-spec/05-project-memory/02-project-memory-rules.md">

```
# Project Memory Rules

## Write Rules
- Memory writes must be explicit via tags or agent tool.
- Store only dense, reusable facts; not full documents.
- Include source/timestamp for auditability.
- Confidence set by writer module.

## Read Rules
- Read only for current project unless global.
- Retrieval limits: max 20 memories per context window.
- Always delimit memory as `[MEMORY]` before LLM input.

## Security
- All local; no cloud sync unless opted in.
- Secrets excluded (`.env`, keys, tokens).
- User approval required for cross-project memory sharing.

## Lifecycle
- Memories stale after 30 days by default; revalidated on access.
- Project deletion removes its memories.
- Audit log records all memory read/write.

## Tags
| Tag | Action |
|---|---|
| `BDS:MEMORY_WRITE` | Upsert memory entry |
| `BDS:MEMORY_READ` | Retrieve relevant memories |
| `BDS:MEMORY_LIST` | List memories for project |
| `BDS:MEMORY_DELETE` | Delete specific entry |
| `BDS:PROJECT_CONTEXT` | Set active project |
