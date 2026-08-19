# 03 — Code Agent Rules

## 1. Invariants

- The runtime never accepts arbitrary shell strings as a single string.
- All commands must be argument arrays.
- The LLM sees a tool allowlist, not raw system access.
- The runtime never runs code outside the declared workspace without approval.
- The runtime never installs packages without user approval.
- The runtime never runs interactive prompts.

## 2. Language Allowlist

- Languages are disabled by default.
- The user explicitly enables each language.
- Enabling a language may require a confirmation dialog.
- The command map is server-side and cannot be changed by web content.

## 3. Risk Tiers

| Risk | Examples | Behavior |
|---|---|---|
| Low | Run compile check, read file, git status | Automatic |
| Medium | Edit file, run test, run build | Automatic within workspace |
| High | Delete file, git commit, install package, run outside workspace | Require approval |
| Critical | Arbitrary shell, sudo, account changes | Never automatic |

## 4. Resource Limits

| Limit | Default |
|---|---|
| One-shot timeout | 15 seconds |
| Project timeout | 120 seconds |
| Session timeout | 600 seconds |
| Maximum output | 1 MB |
| Maximum memory | 2 GB |
| Maximum background jobs | 3 |

## 5. Security Rules

- Runtime binds only to `127.0.0.1`.
- Every request requires a bearer token.
- File contents are treated as untrusted input.
- Prompt injection from source files must be sanitized before LLM input.
- No secrets are sent to the LLM unless explicitly allowed.
- The runtime must not read `.env`, SSH keys, or token files by default.

## 6. Execution Rules

- Use `spawn`, not `exec`, and never `eval`.
- Always pass arguments as arrays.
- Redirect stdout and stderr separately.
- Kill the process tree on timeout.
- Capture and limit both output size and duration.
- Never leave orphaned child processes.

## 7. Approval Rules

- Approvals must show the exact command and affected files.
- Approvals expire after 5 minutes.
- A denied approval cancels the current step, not the whole task.
- The user can set a policy for repeated low-risk commands.
