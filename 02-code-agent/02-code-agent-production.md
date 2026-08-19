# 02 — Code Agent Production

## 1. Goal

Turn the MVP execution bridge into a full AI coding agent comparable in workflow
to Claude Code, Codex, or Cursor, while keeping DeepSeek as the reasoning model
and Lean 4, Isabelle, and SageMath as first-class citizens.

## 2. Production Features

| Feature | Description |
|---|---|
| Workspace awareness | Read and understand the user's project files |
| File reading and editing | Apply targeted diffs, not just overwrite |
| Multi-step loop | Plan, edit, run, read errors, repeat |
| Git integration | `status`, `diff`, `commit` with approval |
| Shell execution | Run builds, tests, and project commands |
| LSP integration | Get structured diagnostics for supported languages |
| Theorem prover support | Lean 4, Isabelle, Coq with project/session modes |
| Symbolic computation | SageMath with long-running background support |
| Streaming progress | Show live output for long tasks |
| Approval flow | User approves risky commands |
| Workspace memory | Persist repo-specific notes |

## 3. Agent Loop

```text
task
  → understand
  → inspect workspace
  → search relevant files
  → create edit plan
  → apply diff
  → run build / test / proof check
  → parse failures
  → decide next action
  → repeat until done or budget exhausted
  → return summary and diff
```

## 4. Tool Surface

| Tool ↕▾ | Purpose ↕▾ |
|---|---|
| −`read_file` | Read a file with line numbers |
| −`write_file` | Create or overwrite a file |
| −`edit_file` | Apply a targeted unified diff |
| −`list_dir` | List workspace directory |
| −`search_code` | Grep or regex search |
| `run_shell` | Run a shell command with timeout |
| `run_compiler` | Run a language-specific compiler/prover |
| `git_status` | Show repo state |
| `git_diff` | Show current changes |
| `git_commit` | Commit after user approval |
| `lsp_diagnostics` | Get LSP errors for a file |
| `approve` | Request user approval |
| `memory_write` | Store repo-specific notes |
⚙

## 5. Execution Modes

### Mode A — One-shot

For Zig, Python, Rust, Lua, etc. Run a single file and return output.

### Mode B — Project

For Lean 4 and Coq. Write into a temporary or user workspace and run the project
build command such as `lake env lean` or `lake build`.

### Mode C — Session

For Isabelle and long SageMath jobs. Start a persistent process, send commands,
stream partial output, and keep the session alive between steps.

## 6. Tag Format

```
BDS:CODE_AGENT
  task = "Fix the failing Lean 4 proof"
  workspace = "/home/user/projects/mathlib"
  max_iterations = 30
  approval = "auto_for_known"
  tools = ["fs", "shell", "git", "lean4"]
```

## 7. Production APIs

```
POST   /code/tasks
GET    /code/tasks/:id
POST   /code/tasks/:id/pause
POST   /code/tasks/:id/resume
POST   /code/tasks/:id/cancel
POST   /code/approvals/:id
GET    /code/workspace
POST   /code/workspace/index
GET    /code/health
WS     /code/ws
```

## 8. Production Acceptance Criteria

- Reads, edits, and re-runs a failing Lean 4 proof until it passes.
- Fixes a failing Zig build by reading compiler errors and applying a diff.
- Runs a SageMath computation that takes longer than 60 seconds as a background job.
- Shows streaming output for long-running commands.
- Requests approval before deleting files or committing.
- Never executes arbitrary shell strings.
- Keeps everything local by default.

