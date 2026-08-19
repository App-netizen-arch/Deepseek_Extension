# 01 — Global Security Model

## 1. Purpose

This file defines the shared security rules for the Web Agent, Code Agent, and
MathBridge modules. All three modules route through one local runtime and one
security policy engine.

## 2. Network Boundary

- The runtime binds only to `127.0.0.1`.
- It must never listen on `0.0.0.0` or any public interface.
- The extension connects only to `http://127.0.0.1:<port>`.
- HTTPS and remote connections are prohibited by default.

## 3. Authentication

- Every request carries a local bearer token.
- The token is generated during runtime installation.
- The token is stored in extension `chrome.storage.local` only.
- The token is never exposed to remote web pages.
- The token can be rotated by the user.

## 4. Shared Risk Tiers

| Risk | Examples | Behavior |
|---|---|---|
| Low | Open page, extract text, read file, run compile check | Automatic |
| Medium | Follow links, edit file, run test, expand UI element | Automatic within scope |
| High | Submit form, delete file, install package, git commit | Require approval |
| Critical | Login, payment, arbitrary shell, account change | Never automatic |

## 5. Module-Specific Rules

### Web Agent

- Respect `robots.txt`, `noindex`, and `nofollow`.
- No CAPTCHA solving.
- No paywall bypass.
- No credential entry by the agent.
- No posting or messaging.

### Code Agent

- Argument-array commands only.
- Language allowlist only.
- No arbitrary shell strings.
- No package installation without approval.
- No access outside the declared workspace without approval.

### MathBridge

- Local document processing only.
- No document upload unless opted in.
- No fabricated LaTeX or TikZ.
- AI-generated artifacts must be compiled or validated before display.

## 6. Prompt Injection Defense

- File contents, web page text, and OCR output are untrusted input.
- Untrusted input must never be interpreted as tool commands.
- Untrusted input must be delimited and labeled before LLM input.
- The LLM must never receive raw tool control permissions.
- The agent loop is controlled by server-side code, not by the model output.

## 7. Secret Protection

- Do not read `.env`, SSH keys, or token files by default.
- If a file matches a secret pattern, redact before LLM input.
- Never send secrets to remote endpoints.
- Store session cookies and profiles encrypted at rest.

## 8. Resource Limits

| Resource | Default |
|---|---|
| Web pages per task | 25 |
| Web depth | 3 |
| Web task time | 20 minutes |
| One-shot code timeout | 15 seconds |
| Project code timeout | 120 seconds |
| Session timeout | 600 seconds |
| Max output | 1 MB |
| Max memory | 2 GB |
| Max concurrent background jobs | 3 |

## 9. Audit and Deletion

- All actions are recorded in a local audit log.
- The user can inspect every action and decision.
- The user can delete task history, sessions, and extracted documents.
- Audit logs are local only and never uploaded.

## 10. Hard No-Gos

- No CAPTCHA solving.
- No credential storage or password autofill.
- No automatic purchases or payments.
- No paywall or DRM bypass.
- No posting or messaging on social platforms.
- No destructive form submissions.
- No arbitrary shell execution.
- No access beyond explicit user authorization.
- No fabricated citations, LaTeX, or TikZ.
