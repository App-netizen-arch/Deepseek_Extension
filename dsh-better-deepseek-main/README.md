# dsh-better-deepseek


DeepSeek Harness bridge plugin for [Better DeepSeek](https://github.com/EdgeTypE/better-deepseek) Chrome extension integration. Provides an HTTP handshake endpoint and session-filtered SSE event streams over `webServer`.

## Installation

### Via DSH (npm)
```bash
dsh plugin --profile web add -w dsh-better-deepseek
```

or

```bash
npx @deepseek-ai/dsh --profile web add -w dsh-better-deepseek
```


<!-- ### Via PowerShell One-Liner (Windows)
```powershell
irm https://raw.githubusercontent.com/EdgeTypE/dsh-better-deepseek/main/scripts/install.ps1 | iex
``` -->

## Plugin

`BetterDeepSeekBridgeService` registers `/api/better-deepseek/*` endpoints on `ctx.webServer`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/better-deepseek/ping` | GET | Handshake and health check |
| `/api/better-deepseek/events` | GET | Server-Sent Events (SSE) live stream |
| `/api/better-deepseek/session.create` | POST | Initialize an agent session with cwd |
| `/api/better-deepseek/session.prompt` | POST | Submit a task/prompt to the session |
| `/api/better-deepseek/session.result` | GET | Fetch final Markdown report and status |
| `/api/better-deepseek/session.cancel` | POST | Cancel a running task |

| Config | Default | Meaning |
|---|---|---|
| `enableCors` | `true` | Enables Access-Control-Allow-Origin headers for cross-origin browser extension requests. |