# 03 — Web Agent Rules

## 1. Invariants

- The agent never invents URLs, quotes, or DOIs.
- The agent never bypasses paywalls, DRM, or anti-bot systems.
- The agent never solves CAPTCHAs automatically.
- The agent never submits passwords or 2FA codes.
- The agent never posts, messages, or modifies remote content.
- The agent respects `robots.txt`, `noindex`, and `nofollow`.

## 2. Risk Tiers

| Risk | Examples | Behavior |
|---|---|---|
| Low | Open page, extract text, follow public link | Automatic |
| Medium | Click pagination, fill search box, expand accordion | Automatic within scope |
| High | Submit contact form, download file, click Delete | Require approval |
| Critical | Login, payment, account change, posting | Never automatic |

## 3. Security Rules

- Runtime binds only to `127.0.0.1`.
- Every request requires a local bearer token.
- The extension must not expose the token to remote pages.
- Web content must never be able to control the agent.
- Prompt injection from pages must be sanitized before LLM input.
- Sensitive pages must never be screenshotted without consent.

## 4. Privacy Rules

- All data is local by default.
- No telemetry unless the user explicitly opts in.
- Session cookies and profiles must be encrypted at rest.
- The user can view and revoke stored sessions at any time.
- Source history must be deletable.

## 5. Operational Limits

- Maximum pages per task: configurable, default 25.
- Maximum link depth: configurable, default 3.
- Maximum time per task: configurable, default 20 minutes.
- Per-domain rate limit: configurable, default 10 requests per minute.
- Maximum downloaded artifact size: configurable, default 25 MB.

## 6. Failure Rules

- A failed page does not fail the whole task.
- A blocked domain is skipped and recorded.
- If a search engine throttles the agent, the agent backs off.
- If the runtime is unreachable, the extension shows a clear error.
- If a source becomes inaccessible, the agent marks it and continues.

## 7. Citation Rules

- Every major claim carries an inline citation.
- Citations include source URL, title, access time, and excerpt.
- Conflicts are reported, not silently resolved.
- Unsupported claims are marked low confidence or removed.
