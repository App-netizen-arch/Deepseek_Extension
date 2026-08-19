import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateBearer } from "./auth.js";
import { HOST, LIMITS, PORT, TOKEN } from "./config.js";
import { RuntimeStore } from "./store.js";
import { ALLOWED_PHASE0_TAGS, type WsEvent, type WsHello } from "./protocol.js";
import { parseBdsTags, type BdsTag } from "./tag-parser.js";
import { CODE_COMMANDS, CODE_LIMITS, executeLocalCode, type LocalExecRequest, type SupportedLanguage } from "./code-agent.js";
import { activeWebTaskCount, cancelWebTask, runWebAgent, type WebAgentRequest } from "./web-agent.js";
import { analyzeMath, type MathAnalyzeRequest } from "./mathbridge.js";

const store = new RuntimeStore();
const startedAt = Date.now();
const clients = new Set<WebSocket>();
const authenticated = new WeakSet<WebSocket>();
const activeCodeJobs = new Set<Promise<unknown>>();
const webTaskResults = new Map<string, unknown>();
const mathTaskResults = new Map<string, unknown>();
const SUPPORTED_LANGUAGES = Object.keys(CODE_COMMANDS) as SupportedLanguage[];

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > LIMITS.httpBodyBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(event: WsEvent): void {
  const encoded = JSON.stringify(event);
  for (const client of clients) {
    if (authenticated.has(client) && client.readyState === 1) client.send(encoded);
  }
}

function sendStatus(socket: WebSocket): void {
  socket.send(JSON.stringify({
    type: "runtime/status",
    payload: {
      status: "ready",
      phase: 3,
      code_active_jobs: activeCodeJobs.size,
      web_active_tasks: activeWebTaskCount(),
    },
  } satisfies WsEvent));
}

function languagePolicies(): Record<string, boolean> {
  return store.listLanguagePolicies(SUPPORTED_LANGUAGES);
}

function tagToExecutionRequest(tag: BdsTag): LocalExecRequest {
  const language = tag.attributes.language;
  const code = tag.attributes.code;
  const timeout = tag.attributes.timeout;
  if (typeof language !== "string" || !SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)) {
    throw new Error("BDS:LOCAL_EXEC language is not allowlisted");
  }
  if (typeof code !== "string" || !code.trim()) throw new Error("BDS:LOCAL_EXEC code is required");
  if (!store.isLanguageEnabled(language)) throw new Error(`language ${language} is disabled; enable it explicitly first`);
  return { language, code, ...(typeof timeout === "number" ? { timeout_seconds: timeout } : {}) };
}

async function executeLocalExecTag(tag: BdsTag, socket: WebSocket): Promise<void> {
  if (activeCodeJobs.size + activeWebTaskCount() >= LIMITS.maxConcurrentJobs) {
    socket.send(JSON.stringify({ type: "runtime/error", payload: { message: "maximum concurrent background jobs reached" } } satisfies WsEvent));
    return;
  }
  let job: Promise<unknown> | undefined;
  try {
    const request = tagToExecutionRequest(tag);
    job = executeLocalCode(request, store);
    activeCodeJobs.add(job);
    const result = await job;
    socket.send(JSON.stringify({ type: "code/result", payload: result } satisfies WsEvent));
  } catch (error) {
    socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "code execution failed" } } satisfies WsEvent));
  } finally {
    if (job) activeCodeJobs.delete(job);
  }
}

function tagToWebRequest(tag: BdsTag): WebAgentRequest {
  const goal = tag.attributes.goal;
  if (typeof goal !== "string" || !goal.trim()) throw new Error("BDS:WEB_AGENT goal is required");
  const maxPages = tag.attributes.max_pages;
  const maxDepth = tag.attributes.max_depth;
  const timeBudget = tag.attributes.time_budget;
  const startUrl = tag.attributes.start_url;
  return {
    goal,
    ...(typeof startUrl === "string" ? { start_url: startUrl } : {}),
    ...(typeof maxPages === "number" ? { max_pages: maxPages } : {}),
    ...(typeof maxDepth === "number" ? { max_depth: maxDepth } : {}),
    ...(typeof timeBudget === "number" ? { time_budget_minutes: timeBudget } : {}),
    output_mode: "summary",
  };
}

function startWebTask(request: WebAgentRequest, send: (event: WsEvent) => void): void {
  if (activeCodeJobs.size + activeWebTaskCount() >= LIMITS.maxConcurrentJobs) {
    throw new Error("maximum concurrent background jobs reached");
  }
  void runWebAgent(request, store, (event) => {
    send({ type: "web/event", payload: event });
    if ((event.type === "completed" || event.type === "cancelled") && event.payload.task_id) {
      webTaskResults.set(String(event.payload.task_id), event.payload.result ?? event.payload);
    }
  }).catch((error) => {
    send({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "web agent failed" } });
  });
}

function tagToMathRequest(tag: BdsTag): MathAnalyzeRequest {
  const kind = tag.attributes.kind ?? tag.attributes.type;
  const content = tag.attributes.content;
  if (kind !== "latex" && kind !== "mathml" && kind !== "image") throw new Error("BDS:MATH_ANALYZE requires kind=latex, mathml, or image");
  if (typeof content !== "string" || !content.trim()) throw new Error("BDS:MATH_ANALYZE content is required");
  const engine = tag.attributes.engine;
  return {
    type: "equation",
    content,
    kind,
    ...(typeof tag.attributes.source_url === "string" ? { source_url: tag.attributes.source_url } : {}),
    ...(typeof tag.attributes.page_title === "string" ? { page_title: tag.attributes.page_title } : {}),
    ...(engine === "pix2tex" || engine === "pix2text" || engine === "auto" ? { engine } : {}),
  };
}

async function executeMathTag(tag: BdsTag, socket: WebSocket): Promise<void> {
  try {
    const request = tagToMathRequest(tag);
    const result = await analyzeMath(request, store);
    const id = `math-${Date.now()}`;
    mathTaskResults.set(id, result);
    socket.send(JSON.stringify({ type: "math/result", payload: { id, result } } satisfies WsEvent));
  } catch (error) {
    socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "math analysis failed" } } satisfies WsEvent));
  }
}

export function createRuntimeServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/v1/health") {
      json(res, 200, { ok: true, service: "better-deepseek-local-runtime", host: HOST, port: PORT, uptimeMs: Date.now() - startedAt, phase: 3 });
      return;
    }

    if (!authenticateBearer(req.headers.authorization, TOKEN)) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/v1/status") {
        json(res, 200, {
          ok: true,
          status: "ready",
          phase: 3,
          clients: clients.size,
          code_agent: { languages: languagePolicies(), active_jobs: activeCodeJobs.size, limits: CODE_LIMITS },
          web_agent: { active_tasks: activeWebTaskCount(), limits: { max_pages: 25, max_depth: 3, time_budget_minutes: 20, domain_requests_per_minute: 10 } },
          mathbridge: { supported_inputs: ["latex", "mathml", "image"], ocr_engines: ["pix2tex", "pix2text"], local_only: true },
        });
        return;
      }

      if (req.method === "GET" && req.url === "/v1/code/languages") {
        json(res, 200, { ok: true, languages: SUPPORTED_LANGUAGES.map((language) => ({ language, enabled: store.isLanguageEnabled(language) })) });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/code/languages/enable") {
        const body = JSON.parse(await readBody(req)) as { language?: string; enabled?: boolean };
        if (!body.language || !SUPPORTED_LANGUAGES.includes(body.language as SupportedLanguage) || typeof body.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "language and boolean enabled are required" });
          return;
        }
        store.setLanguageEnabled(body.language, body.enabled);
        json(res, 200, { ok: true, language: body.language, enabled: body.enabled });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/code/execute") {
        const body = JSON.parse(await readBody(req)) as LocalExecRequest;
        if (!body.language || !SUPPORTED_LANGUAGES.includes(body.language as SupportedLanguage)) {
          json(res, 400, { ok: false, error: "language is not allowlisted" });
          return;
        }
        if (!store.isLanguageEnabled(body.language)) {
          json(res, 403, { ok: false, error: `language ${body.language} is disabled; enable it explicitly first` });
          return;
        }
        if (activeCodeJobs.size + activeWebTaskCount() >= LIMITS.maxConcurrentJobs) {
          json(res, 429, { ok: false, error: "maximum concurrent background jobs reached" });
          return;
        }
        const job = executeLocalCode(body, store);
        activeCodeJobs.add(job);
        try {
          const result = await job;
          broadcast({ type: "code/result", payload: result });
          json(res, 200, { ok: true, result });
        } finally {
          activeCodeJobs.delete(job);
        }
        return;
      }

      if (req.method === "POST" && req.url === "/v1/web/start") {
        const body = JSON.parse(await readBody(req)) as WebAgentRequest;
        const result = await runWebAgent(body, store, (event) => broadcast({ type: "web/event", payload: event }));
        webTaskResults.set(result.task_id, result);
        json(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/v1/web/status/")) {
        const taskId = decodeURIComponent(req.url.slice("/v1/web/status/".length));
        const result = webTaskResults.get(taskId);
        json(res, result ? 200 : 404, result ? { ok: true, result } : { ok: false, error: "task_not_found" });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/web/cancel") {
        const body = JSON.parse(await readBody(req)) as { task_id?: string };
        if (!body.task_id || !cancelWebTask(body.task_id)) {
          json(res, 404, { ok: false, error: "task_not_found" });
          return;
        }
        json(res, 200, { ok: true, task_id: body.task_id, cancelled: true });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/math/analyze") {
        const body = JSON.parse(await readBody(req)) as MathAnalyzeRequest;
        const result = await analyzeMath(body, store);
        const id = `math-${Date.now()}`;
        mathTaskResults.set(id, result);
        json(res, 200, { ok: true, id, result });
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/v1/math/result/")) {
        const id = decodeURIComponent(req.url.slice("/v1/math/result/".length));
        const result = mathTaskResults.get(id);
        json(res, result ? 200 : 404, result ? { ok: true, id, result } : { ok: false, error: "math_result_not_found" });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/tags/parse") {
        const body = JSON.parse(await readBody(req)) as { text?: string };
        const text = typeof body.text === "string" ? body.text : "";
        const tags = parseBdsTags(text);
        const unsupported = tags.filter((tag) => !ALLOWED_PHASE0_TAGS.has(tag.name)).map((tag) => tag.name);
        store.audit("tags.parse", { count: tags.length, unsupported });
        json(res, 200, { ok: true, tags, unsupported });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/audit") {
        const body = JSON.parse(await readBody(req)) as { eventType?: string; payload?: unknown };
        if (!body.eventType || typeof body.eventType !== "string") {
          json(res, 400, { ok: false, error: "eventType is required" });
          return;
        }
        store.audit(body.eventType, body.payload ?? null);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      json(res, 400, { ok: false, error: message });
    }
  });

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMessageBytes });
  wsServer.on("connection", (socket) => {
    clients.add(socket);
    let authed = false;
    const timeout = setTimeout(() => {
      if (!authed) socket.close(1008, "authentication required");
    }, 5000);

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as WsHello | { type: string; requestId?: string; payload?: unknown };
        if (!authed) {
          if (message.type !== "auth" || typeof (message as WsHello).token !== "string") {
            socket.close(1008, "authentication required");
            return;
          }
          if (!authenticateBearer(`Bearer ${(message as WsHello).token}`, TOKEN)) {
            store.audit("ws.auth.failure", {});
            socket.close(1008, "invalid token");
            return;
          }
          authed = true;
          authenticated.add(socket);
          clearTimeout(timeout);
          store.audit("ws.auth.success", {});
          sendStatus(socket);
          return;
        }

        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "runtime/pong", requestId: (message as { requestId?: string }).requestId } satisfies WsEvent));
          return;
        }
        if (message.type === "status") {
          sendStatus(socket);
          return;
        }
        if (message.type === "web/start") {
          const payload = (message as { payload?: WebAgentRequest }).payload;
          if (!payload) throw new Error("missing web agent payload");
          startWebTask(payload, (event) => socket.send(JSON.stringify(event)));
          return;
        }
        if (message.type === "web/cancel") {
          const taskId = String((message as { payload?: { task_id?: string } }).payload?.task_id ?? "");
          if (!taskId || !cancelWebTask(taskId)) throw new Error("web task not found");
          socket.send(JSON.stringify({ type: "web/event", payload: { type: "cancelled", payload: { task_id: taskId } } } satisfies WsEvent));
          return;
        }
        if (message.type === "tags") {
          const payload = (message as { payload?: { text?: string } }).payload ?? {};
          const text = typeof payload.text === "string" ? payload.text : "";
          const tags = parseBdsTags(text);
          const unsupported = tags.filter((tag) => !ALLOWED_PHASE0_TAGS.has(tag.name)).map((tag) => tag.name);
          store.audit("tags.detected", { count: tags.length, unsupported });
          socket.send(JSON.stringify({ type: "runtime/tags", payload: { tags, unsupported } } satisfies WsEvent));
          const localExec = tags.find((tag) => tag.name === "LOCAL_EXEC");
          if (localExec) void executeLocalExecTag(localExec, socket);
          const webAgent = tags.find((tag) => tag.name === "WEB_AGENT");
          if (webAgent) {
            try { startWebTask(tagToWebRequest(webAgent), (event) => socket.send(JSON.stringify(event))); }
            catch (error) { socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "web agent failed" } } satisfies WsEvent)); }
          }
          const mathAnalyze = tags.find((tag) => tag.name === "MATH_ANALYZE");
          if (mathAnalyze) void executeMathTag(mathAnalyze, socket);
          return;
        }
        if (message.type === "code/execute") {
          const payload = (message as { payload?: LocalExecRequest }).payload;
          if (!payload) throw new Error("missing code execution payload");
          if (!SUPPORTED_LANGUAGES.includes(payload.language as SupportedLanguage)) throw new Error("language is not allowlisted");
          if (!store.isLanguageEnabled(payload.language)) throw new Error(`language ${payload.language} is disabled`);
          if (activeCodeJobs.size + activeWebTaskCount() >= LIMITS.maxConcurrentJobs) throw new Error("maximum concurrent background jobs reached");
          const job = executeLocalCode(payload, store);
          activeCodeJobs.add(job);
          job.then((result) => socket.send(JSON.stringify({ type: "code/result", payload: result } satisfies WsEvent)))
            .catch((error) => socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "code execution failed" } } satisfies WsEvent)))
            .finally(() => activeCodeJobs.delete(job));
          return;
        }
        if (message.type === "math/analyze") {
          const payload = (message as { payload?: MathAnalyzeRequest }).payload;
          if (!payload) throw new Error("missing math analysis payload");
          void analyzeMath(payload, store)
            .then((result) => socket.send(JSON.stringify({ type: "math/result", payload: { id: `math-${Date.now()}`, result } } satisfies WsEvent)))
            .catch((error) => socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "math analysis failed" } } satisfies WsEvent)));
          return;
        }

        store.audit("ws.message.unsupported", { type: message.type });
        socket.send(JSON.stringify({ type: "runtime/error", payload: { message: `unsupported message: ${message.type}` } } satisfies WsEvent));
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "invalid message";
        socket.send(JSON.stringify({ type: "runtime/error", payload: { message: messageText } } satisfies WsEvent));
      }
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  });

  server.on("close", () => {
    wsServer.close();
    for (const client of clients) client.close();
    store.close();
  });

  return server;
}
