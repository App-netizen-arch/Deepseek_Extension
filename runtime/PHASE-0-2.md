# Phase 0–2 Implementation Contract

## Phase 0 — Clean baseline

The repository uses the upstream Better DeepSeek extension as its browser product and `runtime/` as the local Node.js companion. Native Android/Kotlin application code is intentionally out of scope; future mobile work is a separate Flutter/Dart companion.

Baseline requirements:

- extension build and unit/integration tests remain green;
- runtime build and tests remain green;
- no duplicate extension implementation is introduced;
- runtime binds only to `127.0.0.1`.

## Phase 1 — Canonical BDS protocol

Protocol version: `1`.

Every new runtime request has:

```json
{
  "version": 1,
  "id": "request-id",
  "type": "tags",
  "timestamp": 0,
  "sessionId": "optional",
  "projectId": "optional",
  "payload": {}
}
```

Responses carry `id`, `timestamp`, `inReplyTo`, `ok`, and either `payload` or a structured `{code,message}` error.

The canonical tag registry is shared by the extension/runtime contract. Existing WebSocket/HTTP endpoints remain backward-compatible; new code should use the versioned envelope instead of inventing endpoint-specific message shapes.

## Phase 2 — Global security policy

All runtime-capable features inherit one policy:

- loopback-only runtime binding;
- bearer authentication with a minimum 32-character token;
- protected workspace paths and secret-file blocking;
- HTTP(S)-only remote URLs and explicit loopback URL validation;
- browser-extension origins allowed, opaque/unknown origins rejected;
- risk tiers: `low`, `medium`, `high`, `critical`;
- `low`/`medium` are allowed within scope;
- `high` requires explicit approval;
- `critical` is never automatically executable;
- request/queue/concurrency resource limits remain centralized.

Untrusted web pages, OCR results, files, and tool output must never become implicit tool instructions. Agent execution is controlled by server-side runtime code.

## Acceptance tests

Phase 0–2 is considered complete when:

1. canonical protocol tests pass;
2. security-policy tests pass;
3. existing runtime tests/build remain green;
4. existing extension tests/build remain green;
5. no Android/native mobile build is required for the desktop release baseline.
