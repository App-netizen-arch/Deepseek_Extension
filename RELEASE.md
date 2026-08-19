# Better DeepSeek release guide

## Repository milestones

- `phase-0-clean` / `phase-0-local-runtime`: Phase 0 local runtime baseline.
- `phase-1-code-agent-mvp`: reconstructed Phase 1 milestone ref.
- `phase-2-web-agent-mvp`: reconstructed Phase 2 milestone ref.
- `phase-3-5-production`: Phase 3/4/5 production implementation.
- `phase-6-7-final`: Phase 6/7 Project Memory and orchestration implementation.
- `release-candidate`: final integration, security, Chrome MV3, E2E, and operations gate.

`main` is never used as a scratch phase branch.

## Production startup

```bash
cd runtime
npm install
npx playwright install chromium
export BDS_RUNTIME_TOKEN="$(node scripts/setup-token.mjs)"
export BDS_WORKSPACE="/absolute/path/to/project"
npm run build
npm start
```

The runtime, Code Agent, and Agent Control services bind only to `127.0.0.1` on ports 3037, 3038, and 3039 by default.

## Upgrade procedure

1. Stop the runtime gracefully with SIGTERM.
2. Back up `runtime/data/runtime.db` and any encrypted session/memory stores.
3. Replace application files.
4. Run `npm install` and `npm run build`.
5. Start once; SQLite migrations run automatically and record versions in `schema_migrations`.
6. Run the release verification workflow before accepting new traffic.
7. Reinstall/reload the Chrome unpacked extension if the MV3 package changed.

## Recovery

- SQLite uses WAL mode. Restore the latest database backup before filesystem-level recovery.
- Saved browser sessions are encrypted locally; if the session key is lost, recreate sessions through the visible login flow.
- Interrupted Web/Code tasks remain persisted and can be resumed through their task APIs where supported.
- Runtime shutdown closes all HTTP/WebSocket listeners before exit.
- Orphaned child processes are bounded by the Code Agent timeout/cleanup layer.

## Security operations

- Never bind the runtime to `0.0.0.0` or a public interface.
- Use a high-entropy bearer token of at least 32 bytes.
- Keep `.env`, SSH keys, `.git`, and token material outside agent-readable paths.
- Keep package installation and account changes outside Code Agent capabilities.
- Treat MCP servers as privileged integrations and review their URLs/tools before enabling.
- Review runtime logs for authentication failures, denied paths, approvals, and process errors.

## Release gate

The final release workflow validates:

1. dependency installation;
2. TypeScript build;
3. isolated unit/integration tests;
4. security-policy tests;
5. Chrome MV3 manifest/package checks;
6. a live Chrome E2E against the local runtime.
