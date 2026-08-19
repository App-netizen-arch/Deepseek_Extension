import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { URL } from "node:url";
import type { RuntimeStore } from "./store.js";

export interface WebAgentRequest {
  goal: string;
  start_url?: string;
  max_pages?: number;
  max_depth?: number;
  time_budget_minutes?: number;
  output_mode?: "summary";
}

export interface WebCitation {
  source_url: string;
  source_title: string;
  accessed_at: string;
  excerpt: string;
}

export interface WebPageResult {
  url: string;
  title: string;
  depth: number;
  markdown: string;
  excerpt: string;
  links: string[];
  nofollow: boolean;
}

export interface WebAgentResult {
  goal: string;
  answer: string;
  citations: WebCitation[];
  pages_visited: number;
  duration_ms: number;
  stopped_reason: "completed" | "time_budget" | "page_budget" | "cancelled" | "no_sources";
}

export interface WebAgentEvent {
  type: "started" | "page_visited" | "page_skipped" | "completed" | "cancelled";
  payload: Record<string, unknown>;
}

const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIME_MINUTES = 20;
const MIN_EXCERPT = 280;
const MAX_EXCERPT = 1400;
const MAX_PAGE_TEXT = 50_000;
const USER_AGENT = "BetterDeepSeekLocalRuntime/0.2 (+read-only research agent)";

const activeTasks = new Map<string, { cancel: () => void }>();
const domainAccess = new Map<string, number[]>();

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeRequest(request: WebAgentRequest): Required<Pick<WebAgentRequest, "goal" | "max_pages" | "max_depth" | "time_budget_minutes" | "output_mode">> & Pick<WebAgentRequest, "start_url"> {
  const goal = typeof request.goal === "string" ? request.goal.trim() : "";
  if (!goal) throw new Error("goal is required");
  return {
    goal,
    start_url: request.start_url,
    max_pages: clampInt(request.max_pages, DEFAULT_MAX_PAGES, 1, DEFAULT_MAX_PAGES),
    max_depth: clampInt(request.max_depth, DEFAULT_MAX_DEPTH, 0, DEFAULT_MAX_DEPTH),
    time_budget_minutes: clampInt(request.time_budget_minutes, DEFAULT_TIME_MINUTES, 1, DEFAULT_TIME_MINUTES),
    output_mode: request.output_mode === "summary" ? "summary" : "summary",
  };
}

function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 100));
}

function relevance(goal: string, title: string, text: string): number {
  const terms = tokenize(goal);
  if (!terms.size) return 0;
  const haystack = `${title} ${text.slice(0, 10_000)}`.toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits / terms.size;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function excerptFor(goal: string, title: string, text: string): string {
  const cleaned = cleanText(text).slice(0, MAX_PAGE_TEXT);
  const terms = [...tokenize(goal)].filter((term) => term.length >= 4);
  for (const term of terms) {
    const idx = cleaned.toLowerCase().indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 180);
      const end = Math.min(cleaned.length, start + MAX_EXCERPT);
      const excerpt = cleaned.slice(start, end).trim();
      if (excerpt.length >= MIN_EXCERPT) return excerpt;
    }
  }
  return `${title}: ${cleaned.slice(0, MAX_EXCERPT)}`.slice(0, MAX_EXCERPT);
}

async function robotsAllows(url: URL): Promise<boolean> {
  const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
  try {
    const response = await fetch(robotsUrl, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) return true;
    const body = await response.text();
    let relevant = false;
    let disallow: string[] = [];
    let allow: string[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.split("#", 1)[0].trim();
      if (!line || !line.includes(":")) continue;
      const [keyRaw, valueRaw] = line.split(":", 2);
      const key = keyRaw.trim().toLowerCase();
      const value = valueRaw.trim();
      if (key === "user-agent") {
        relevant = value === "*" || value.toLowerCase().includes("betterdeepseek");
        disallow = [];
        allow = [];
      } else if (relevant && key === "disallow") {
        if (value) disallow.push(value);
      } else if (relevant && key === "allow") {
        if (value) allow.push(value);
      }
    }
    const pathname = url.pathname || "/";
    const matches = (rule: string) => pathname.startsWith(rule);
    const denied = disallow.filter(matches).sort((a, b) => b.length - a.length)[0];
    const permitted = allow.filter(matches).sort((a, b) => b.length - a.length)[0];
    if (!denied) return true;
    return Boolean(permitted && permitted.length >= denied.length);
  } catch {
    return true;
  }
}

function canVisitDomain(url: URL): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (domainAccess.get(url.host) ?? []).filter((timestamp) => timestamp >= cutoff);
  domainAccess.set(url.host, recent);
  if (recent.length >= 10) return false;
  recent.push(now);
  return true;
}

async function extractPage(page: Page, goal: string, url: string, depth: number): Promise<WebPageResult> {
  const data = await page.evaluate(() => {
    const title = document.title || location.href;
    const root = document.querySelector("main, article, [role='main'], body");
    const text = root?.textContent ?? document.body?.textContent ?? "";
    const links = [...document.querySelectorAll("a[href]")].map((node) => ({
      href: (node as HTMLAnchorElement).href,
      text: (node.textContent ?? "").trim(),
    }));
    const nofollow = Boolean(document.querySelector("meta[name='robots'][content*='nofollow' i], meta[name='googlebot'][content*='nofollow' i]"));
    const noindex = Boolean(document.querySelector("meta[name='robots'][content*='noindex' i], meta[name='googlebot'][content*='noindex' i]"));
    return { title, text, links, nofollow, noindex };
  });
  if (data.noindex) throw new Error("page declares noindex");
  const normalizedLinks = data.links
    .map((link) => ({ url: normalizeUrl(link.href, url), text: link.text }))
    .filter((link): link is { url: string; text: string } => Boolean(link.url))
    .filter((link) => new URL(link.url).protocol.startsWith("http"))
    .map((link) => link.url)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 100);
  const markdown = cleanText(data.text).slice(0, MAX_PAGE_TEXT);
  return {
    url,
    title: String(data.title).slice(0, 500),
    depth,
    markdown,
    excerpt: excerptFor(goal, data.title, markdown),
    links: normalizedLinks,
    nofollow: data.nofollow,
  };
}

async function searchStart(page: Page, goal: string): Promise<string[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(goal)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return await page.locator("a.result__a").evaluateAll((anchors) =>
    anchors.map((anchor) => (anchor as HTMLAnchorElement).href).filter(Boolean).slice(0, 10),
  );
}

function synthesize(goal: string, pages: WebPageResult[]): { answer: string; citations: WebCitation[] } {
  const ranked = [...pages].sort((a, b) => relevance(goal, b.title, b.markdown) - relevance(goal, a.title, a.markdown));
  const selected = ranked.slice(0, 8);
  const citations: WebCitation[] = selected.map((page) => ({
    source_url: page.url,
    source_title: page.title,
    accessed_at: new Date().toISOString(),
    excerpt: page.excerpt,
  }));
  if (!selected.length) return { answer: "No accessible sources were found within the configured browsing budget.", citations };
  const lines = selected.map((page, index) => `${index + 1}. **${page.title}** — ${page.excerpt} [${index + 1}]`);
  return {
    answer: `Research goal: ${goal}\n\nThe following evidence was collected from rendered public pages. Each numbered item corresponds to a source citation below.\n\n${lines.join("\n\n")}`,
    citations,
  };
}

export function activeWebTaskCount(): number {
  return activeTasks.size;
}

export function cancelWebTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task) return false;
  task.cancel();
  return true;
}

export async function runWebAgent(
  request: WebAgentRequest,
  store: RuntimeStore,
  onEvent: (event: WebAgentEvent) => void,
): Promise<WebAgentResult & { task_id: string }> {
  const config = normalizeRequest(request);
  const taskId = `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  const deadline = startedAt + config.time_budget_minutes * 60_000;
  let cancelled = false;
  activeTasks.set(taskId, { cancel: () => { cancelled = true; } });
  onEvent({ type: "started", payload: { task_id: taskId, goal: config.goal, max_pages: config.max_pages, max_depth: config.max_depth } });
  store.audit("web.task.start", { taskId, goal: config.goal });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ userAgent: USER_AGENT, javaScriptEnabled: true });
    const page = await context.newPage();
    const pages: WebPageResult[] = [];
    const seen = new Set<string>();
    const queue: Array<{ url: string; depth: number; score: number }> = [];

    if (config.start_url) {
      const start = normalizeUrl(config.start_url);
      if (!start) throw new Error("start_url must be http(s)");
      queue.push({ url: start, depth: 0, score: 1 });
    } else {
      const searchLinks = await searchStart(page, config.goal);
      for (const url of searchLinks) queue.push({ url, depth: 0, score: 1 });
    }

    let stoppedReason: WebAgentResult["stopped_reason"] = "completed";
    while (queue.length && pages.length < config.max_pages) {
      if (cancelled) { stoppedReason = "cancelled"; break; }
      if (Date.now() >= deadline) { stoppedReason = "time_budget"; break; }
      queue.sort((a, b) => b.score - a.score);
      const next = queue.shift();
      if (!next || seen.has(next.url)) continue;
      seen.add(next.url);
      const parsed = new URL(next.url);
      if (!(await robotsAllows(parsed))) {
        store.audit("web.page.skipped", { taskId, url: next.url, reason: "robots" });
        onEvent({ type: "page_skipped", payload: { task_id: taskId, url: next.url, depth: next.depth, reason: "robots" } });
        continue;
      }
      if (!canVisitDomain(parsed)) {
        store.audit("web.page.skipped", { taskId, url: next.url, reason: "domain_rate_limit" });
        onEvent({ type: "page_skipped", payload: { task_id: taskId, url: next.url, depth: next.depth, reason: "domain_rate_limit" } });
        continue;
      }
      try {
        await page.goto(next.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        const result = await extractPage(page, config.goal, next.url, next.depth);
        pages.push(result);
        onEvent({ type: "page_visited", payload: { task_id: taskId, url: result.url, title: result.title, status: "extracted", pages_done: pages.length, pages_total: config.max_pages, depth: result.depth } });
        if (!result.nofollow && next.depth < config.max_depth) {
          for (const link of result.links) {
            if (seen.has(link)) continue;
            const linkUrl = new URL(link);
            if (linkUrl.host === parsed.host || relevance(config.goal, "", link) > 0.05) {
              queue.push({ url: link, depth: next.depth + 1, score: relevance(config.goal, "", link) + 0.2 / (next.depth + 1) });
            }
          }
        }
      } catch (error) {
        store.audit("web.page.error", { taskId, url: next.url, error: error instanceof Error ? error.message : String(error) });
        onEvent({ type: "page_skipped", payload: { task_id: taskId, url: next.url, depth: next.depth, reason: error instanceof Error ? error.message : "page_error" } });
      }
    }

    if (!pages.length && stoppedReason === "completed") stoppedReason = "no_sources";
    if (pages.length >= config.max_pages && queue.length) stoppedReason = "page_budget";
    const synthesized = synthesize(config.goal, pages);
    const result: WebAgentResult & { task_id: string } = {
      task_id: taskId,
      goal: config.goal,
      answer: synthesized.answer,
      citations: synthesized.citations,
      pages_visited: pages.length,
      duration_ms: Date.now() - startedAt,
      stopped_reason: stoppedReason,
    };
    onEvent({ type: cancelled ? "cancelled" : "completed", payload: result });
    store.audit("web.task.finish", { taskId, pages: pages.length, stopped_reason: stoppedReason });
    return result;
  } finally {
    activeTasks.delete(taskId);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
