# Project Memory API

## Endpoints (local runtime)
```text
GET    /memory/projects
POST   /memory/projects
GET    /memory/projects/:id/memories
POST   /memory/projects/:id/memories
GET    /memory/projects/:id/memories/search?q=...
DELETE /memory/projects/:id/memories/:memory_id
```

## Tag Format

```
BDS:MEMORY_WRITE
  project = "mathlib-fork"
  module = "math"
  type = "fact"
  key = "lemma_4_2_location"
  value = "Real/Basic.lean line 450"
  confidence = 0.95

BDS:MEMORY_READ
  project = "mathlib-fork"
  query = "Lemma 4.2 dependencies"
  max_results = 5
```

## Request/Response

### Write

```
{"project":"mathlib-fork","module":"math","type":"fact","key":"lemma_4_2_location","value":"Real/Basic.lean:450"}
```

Response: `{"id":"mem_001","status":"stored"}`

### Read

```
{"project":"mathlib-fork","query":"lemma 4.2","max_results":5}
```

Response:

```
{"results":[{"key":"lemma_4_2_location","value":"Real/Basic.lean:450","module":"math","confidence":0.95}]}
```

</BDS:create_file>

<BDS:create_file fileName="better-deepseek-agent-spec/06-kilo-code-components.md">

```
# Kilo Code Component Adoption

## Adopt (High Value)
| Component | BDS Implementation | Tag |
|---|---|---|
| Agents as files | `.better-deepseek/agents/*.md` | `BDS:AGENT_DEFINE` |
| Subagents | child loop with restricted tools | `BDS:SUBAGENT` |
| MCP Manager | local MCP server registry | `BDS:MCP_MANAGE` |
| Workflows | `.better-deepseek/workflows/*.md` | `BDS:WORKFLOW` |
| Skills as files | `.better-deepseek/skills/*/SKILL.md` | `BDS:SKILL_LOAD` |
| Granular permissions | glob rules in `config.jsonc` | `BDS:PERMISSION_SET` |
| JSONC config | `~/.better-deepseek/config.jsonc`, project `.better-deepseek.jsonc` | `BDS:CONFIG_SET` |
| Transcript export | `.better-deepseek/transcripts/*.md` | `BDS:SESSION_EXPORT` |
| Charts | route numeric output to `BDS:VISUALIZER` | existing |
| Subagent viewer | read-only panels in extension | UI |

## Skip for v1
- Autocomplete/FIM — IDE feature
- Multi-surface (JetBrains/CLI) — Chrome-only
- PR import/review annotations — requires GitHub
- 500+ model marketplace — DeepSeek primary
- Cost status bar — unnecessary

## New Tags
```

BDS:AGENT_DEFINE
agent = "math-prover"
file = "~/.better-deepseek/agents/math-prover.md"
activate = true

BDS:SUBAGENT
agent = "lean-checker"
task = "Check all Lean files in workspace"
max_iterations = 10

BDS:MCP_MANAGE
action = "add"
server = "exa"
url = "[https://mcp.exa.ai/mcp](https://mcp.exa.ai/mcp)"

BDS:WORKFLOW
name = "paper-analysis"
inputs = {"paper":"/path/paper.pdf","question":"Explain main theorem"}

BDS:PERMISSION_SET
rules = [
{"tool":"edit_file","allow":["src/**/*.lean"],"deny":["**/.env"]}
]

```

## Runtime Architecture (extended)
```text
Local Runtime
├── Gateway / Security Policy
├── Agent Loader
├── Subagent Manager
├── MCP Manager
├── Workflow Engine
├── Skill Loader
├── Permission Engine (glob)
├── Config Loader (JSONC)
├── Transcript Store
├── Chart Bridge
└── Tool Executor
    ├── File System (edit_file, read_file)
    ├── Shell / Compilers / Provers
    ├── Playwright Browser
    └── MathBridge
```

## Note

Targeted file editing already exists in Code Agent spec (`edit_file`). No duplicate.
