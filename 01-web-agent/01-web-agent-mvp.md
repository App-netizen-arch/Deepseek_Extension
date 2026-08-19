# 01 — Web Agent MVP

## 1. Goal

Add a read-only autonomous web research capability to Better DeepSeek.

The MVP must be able to:

- Accept a high-level research goal.
- Search or use a starting URL.
- Open pages in a real Chromium browser.
- Render JavaScript-heavy pages.
- Extract clean markdown.
- Visit multiple pages within a budget.
- Return a cited, synthesized answer.

## 2. Scope

### In scope

- Multi-page reading.
- JavaScript-heavy site rendering.
- Link extraction and simple relevance filtering.
- Page budget and depth limit.
- Basic citation records.
- Pause, cancel, and status display.

### Out of scope for MVP

- Clicking, form filling, scrolling automation.
- Login or session reuse.
- Paywall handling.
- Cross-source fact verification with confidence scores.
- Long-running background jobs.
- Anti-detection hardening.
- User-visible browser actions.

## 3. User Flow

1. User asks a research question on `chat.deepseek.com`.
2. DeepSeek emits `BDS:WEB_AGENT` with a goal.
3. The extension sends the task to the local runtime.
4. The runtime launches Playwright in headless mode.
5. The agent visits pages, extracts markdown, follows links.
6. Progress appears as status cards in the chat.
7. The final answer is injected with source links.

## 4. Tag Format

```

BDS:WEB_AGENT
goal = "Compare recent protein folding models after AlphaFold 3"
max_pages = 10
max_depth = 2
time_budget = 15
output_mode = "summary"

```

## 5. MVP Pipeline

```text
goal
  → planner
  → starting search or URL
  → Playwright navigate
  → render + extract markdown
  → relevance score
  → enqueue promising links
  → repeat until budget reached
  → synthesize answer
  → return with citations
```

## 6. MVP Components

### Extension

- Parse `BDS:WEB_AGENT`.
- Send task to local runtime.
- Render live status.
- Render final answer and source list.

### Local runtime

- Task manager.
- Playwright controller.
- Markdown extractor.
- Link relevance scorer.
- Citation recorder.
- Synthesizer using DeepSeek API.

## 7. MVP Data Structures

### Task

```
{
  "goal": "string",
  "max_pages": 10,
  "max_depth": 2,
  "time_budget_minutes": 15,
  "output_mode": "summary"
}
```

### Citation

```
{
  "source_url": "https://example.com/article",
  "source_title": "Article title",
  "accessed_at": "2026-08-19T12:30:00Z",
  "excerpt": "Relevant excerpt"
}
```

### Event

```
{
  "type": "page_visited",
  "url": "https://example.com",
  "status": "extracted",
  "pages_done": 3,
  "pages_total": 10
}
```

## 8. MVP Acceptance Criteria

- Visits 5–10 relevant pages without human help.
- Renders JavaScript-heavy pages in at least 70% of test cases.
- Produces an answer with clickable source URLs.
- Never invents a URL or quote.
- Cancels cleanly when the user requests it.
- Fails safely if the local runtime is not running.

