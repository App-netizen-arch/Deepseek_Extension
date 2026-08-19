# 01 — Code Agent MVP

## 1. Goal

Build a local native code execution bridge inside Better DeepSeek.

The MVP must be able to:

- Accept code written by DeepSeek.
- Send it to the user's local machine.
- Run it with the real installed compiler or interpreter.
- Return `stdout`, `stderr`, and `exit_code`.
- Support at least Zig and Lean 4.
- Stop safely on timeout or error.

## 2. User Flow

1. User asks DeepSeek to write and run Zig code.
2. DeepSeek emits `BDS:LOCAL_EXEC` with code.
3. The extension sends the code to the local runtime.
4. The runtime runs the code with the real `zig` binary.
5. Output appears as a card in `chat.deepseek.com`.
6. DeepSeek may read the errors and fix the code.

## 3. Tag Format

```

BDS:LOCAL_EXEC
language = "zig"
code = "const std = @import("std"); ..."
timeout = 15

```

## 4. MVP Command Map

```json
{
  "zig": ["zig", "run", "-"],
  "lean4": ["lake", "env", "lean"],
  "python": ["python3", "-"]
}
```

## 5. MVP Pipeline

```
code
  → local runtime
  → validate language against allowlist
  → create temp workspace
  → run command as argument array
  → capture stdout, stderr, exit code
  → enforce timeout and output limit
  → return result card to chat
```

## 6. MVP Components

### Extension

- Parse `BDS:LOCAL_EXEC`.
- Send request to local runtime with bearer token.
- Render stdout, stderr, and status.
- Provide a copy button for output.

### Local runtime

- Authenticate requests.
- Validate language allowlist.
- Write code to a temporary file.
- Execute with `spawn`, not a shell string.
- Enforce timeout, memory, and output limits.
- Return structured result.

## 7. MVP Data Structures

### Request

```
{
  "language": "zig",
  "code": "const std = @import(\"std\"); pub fn main() void {}",
  "timeout_seconds": 15
}
```

### Result

```
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "duration_ms": 123,
  "truncated": false
}
```

## 8. MVP Acceptance Criteria

- Zig code compiles and runs locally, not in the browser.
- Lean 4 code can be checked with `lake env lean`.
- A deliberate infinite loop is killed at the timeout.
- The runtime never accepts arbitrary shell strings.
- The extension shows clear errors when the runtime is down.
- Only allowlisted languages may run.

