import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateBearer } from "./auth.js";
import { HOST, LIMITS, PORT, TOKEN } from "./config.js";
import { RuntimeStore } from "./store.js";
import { ALLOWED_PHASE0_TAGS, type WsEvent, type WsHello } from "./protocol.js";
import { parseBdsTags, type BdsTag } from "./tag-parser.js";
import { CODE_COMMANDS, CODE_LIMITS, executeLocalCode, type LocalExecRequest, type SupportedLanguage } from "./code-agent.js";
import { activeWebTaskCount, cancelWebTask, runWebAgent, type WebAgentRequest } from "./web-agent.js";
import { createLoginSession, saveLoginSession, deleteSession, listStoredSessions, pauseTask, resumeTask, cancelTask, type ProductionWebTaskRequest } from "./web-production.js";
import { runProductionWebAgent } from "./web-production-agent.js";
import { analyzeMath, type MathAnalyzeRequest } from "./mathbridge.js";
import { ingestMathPdf } from "./math-document.js";
import { askMathDocument, type MathAskRequest } from "./math-production.js";
import { renderTikz } from "./tikz.js";

const store = new RuntimeStore();
const startedAt = Date.now();
const clients = new Set<WebSocket>();
const authenticated = new WeakSet<WebSocket>();
const activeCodeJobs = new Set<Promise<unknown>>();
const webTaskResults = new Map<string, unknown>();
const productionTasks = new Set<Promise<unknown>>();
const SUPPORTED_LANGUAGES = Object.keys(CODE_COMMANDS) as SupportedLanguage[];

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { total += chunk.length; if (total > LIMITS.httpBodyBytes) { reject(new Error("request body too large")); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function broadcast(event: WsEvent): void { const encoded = JSON.stringify(event); for (const client of clients) if (authenticated.has(client) && client.readyState === 1) client.send(encoded); }
function sendStatus(socket: WebSocket): void { socket.send(JSON.stringify({ type: "runtime/status", payload: { status: "ready", phase: 4, code_active_jobs: activeCodeJobs.size, web_active_tasks: activeWebTaskCount(), production_tasks: productionTasks.size, math_documents: store.listMathDocuments().length } } satisfies WsEvent)); }
function languagePolicies(): Record<string, boolean> { return store.listLanguagePolicies(SUPPORTED_LANGUAGES); }
function tagToExecutionRequest(tag: BdsTag): LocalExecRequest {
  const language = tag.attributes.language; const code = tag.attributes.code; const timeout = tag.attributes.timeout;
  if (typeof language !== "string" || !SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)) throw new Error("BDS:LOCAL_EXEC language is not allowlisted");
  if (typeof code !== "string" || !code.trim()) throw new Error("BDS:LOCAL_EXEC code is required");
  if (!store.isLanguageEnabled(language)) throw new Error(`language ${language} is disabled; enable it explicitly first`);
  return { language, code, ...(typeof timeout === "number" ? { timeout_seconds: timeout } : {}) };
}
async function executeLocalExecTag(tag: BdsTag, socket: WebSocket): Promise<void> {
  if (activeCodeJobs.size + activeWebTaskCount() + productionTasks.size >= LIMITS.maxConcurrentJobs) { socket.send(JSON.stringify({ type: "runtime/error", payload: { message: "maximum concurrent background jobs reached" } } satisfies WsEvent)); return; }
  let job: Promise<unknown> | undefined;
  try { const request = tagToExecutionRequest(tag); job = executeLocalCode(request, store); activeCodeJobs.add(job); const result = await job; socket.send(JSON.stringify({ type: "code/result", payload: result } satisfies WsEvent)); }
  catch (error) { socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "code execution failed" } } satisfies WsEvent)); }
  finally { if (job) activeCodeJobs.delete(job); }
}
function startWebTask(request: WebAgentRequest, send: (event: WsEvent) => void): void {
  if (activeCodeJobs.size + activeWebTaskCount() + productionTasks.size >= LIMITS.maxConcurrentJobs) throw new Error("maximum concurrent background jobs reached");
  void runWebAgent(request, store, (event) => { send({ type: "web/event", payload: event }); if ((event.type === "completed" || event.type === "cancelled") && event.payload.task_id) webTaskResults.set(String(event.payload.task_id), event.payload.result ?? event.payload); }).catch((error) => send({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "web agent failed" } }));
}
function tagToWebRequest(tag: BdsTag): WebAgentRequest {
  const goal = tag.attributes.goal; if (typeof goal !== "string" || !goal.trim()) throw new Error("BDS:WEB_AGENT goal is required");
  return { goal, ...(typeof tag.attributes.start_url === "string" ? { start_url: tag.attributes.start_url } : {}), ...(typeof tag.attributes.max_pages === "number" ? { max_pages: tag.attributes.max_pages } : {}), ...(typeof tag.attributes.max_depth === "number" ? { max_depth: tag.attributes.max_depth } : {}), ...(typeof tag.attributes.time_budget === "number" ? { time_budget_minutes: tag.attributes.time_budget } : {}), output_mode: "summary" };
}
function triggerWebTag(tag: BdsTag, socket: WebSocket): void { try { startWebTask(tagToWebRequest(tag), (event) => socket.send(JSON.stringify(event))); } catch (error) { socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "web agent failed" } } satisfies WsEvent)); } }
function startProductionTask(request: ProductionWebTaskRequest, send: (event: WsEvent) => void): string {
  if (activeCodeJobs.size + activeWebTaskCount() + productionTasks.size >= LIMITS.maxConcurrentJobs) throw new Error("maximum concurrent background jobs reached");
  const taskId = request.resume_task_id ?? `web-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const task = runProductionWebAgent({ ...request, resume_task_id: taskId }, store, (event) => send({ type: "web/production", payload: event }));
  productionTasks.add(task);
  task.catch((error) => send({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "production web agent failed" } })).finally(() => productionTasks.delete(task));
  return taskId;
}
function parseTagFromText(text: string, name: string): BdsTag | undefined { return parseBdsTags(text).find((tag) => tag.name === name); }

export function createRuntimeServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/v1/health") { json(res, 200, { ok: true, service: "better-deepseek-local-runtime", host: HOST, port: PORT, uptimeMs: Date.now() - startedAt, phase: 4 }); return; }
    if (!authenticateBearer(req.headers.authorization, TOKEN)) { json(res, 401, { ok: false, error: "unauthorized" }); return; }
    try {
      if (req.method === "GET" && req.url === "/v1/status") { json(res, 200, { ok: true, status: "ready", phase: 4, clients: clients.size, code_agent: { languages: languagePolicies(), active_jobs: activeCodeJobs.size, limits: CODE_LIMITS }, web_agent: { active_tasks: activeWebTaskCount(), production_tasks: productionTasks.size, limits: { max_pages: 25, max_depth: 3, time_budget_minutes: 20, domain_requests_per_minute: 10 } }, sessions: store.listWebSessions().length, mathbridge: { documents: store.listMathDocuments().length, max_pdf_bytes: 100 * 1024 * 1024, tikz_compile_timeout_ms: 60_000 } }); return; }
      if (req.method === "GET" && req.url === "/v1/code/languages") { json(res, 200, { ok: true, languages: SUPPORTED_LANGUAGES.map((language) => ({ language, enabled: store.isLanguageEnabled(language) })) }); return; }
      if (req.method === "POST" && req.url === "/v1/code/languages/enable") { const body = JSON.parse(await readBody(req)) as { language?: string; enabled?: boolean }; if (!body.language || !SUPPORTED_LANGUAGES.includes(body.language as SupportedLanguage) || typeof body.enabled !== "boolean") { json(res, 400, { ok: false, error: "language and boolean enabled are required" }); return; } store.setLanguageEnabled(body.language, body.enabled); json(res, 200, { ok: true, language: body.language, enabled: body.enabled }); return; }
      if (req.method === "POST" && req.url === "/v1/code/execute") { const body = JSON.parse(await readBody(req)) as LocalExecRequest; if (!body.language || !SUPPORTED_LANGUAGES.includes(body.language as SupportedLanguage)) { json(res, 400, { ok: false, error: "language is not allowlisted" }); return; } if (!store.isLanguageEnabled(body.language)) { json(res, 403, { ok: false, error: `language ${body.language} is disabled; enable it explicitly first` }); return; } if (activeCodeJobs.size + activeWebTaskCount() + productionTasks.size >= LIMITS.maxConcurrentJobs) { json(res, 429, { ok: false, error: "maximum concurrent background jobs reached" }); return; } const job = executeLocalCode(body, store); activeCodeJobs.add(job); try { const result = await job; broadcast({ type: "code/result", payload: result }); json(res, 200, { ok: true, result }); } finally { activeCodeJobs.delete(job); } return; }
      if (req.method === "POST" && req.url === "/v1/web/start") { const body = JSON.parse(await readBody(req)) as WebAgentRequest; const result = await runWebAgent(body, store, (event) => broadcast({ type: "web/event", payload: event })); webTaskResults.set(result.task_id, result); json(res, 200, { ok: true, result }); return; }
      if (req.method === "GET" && req.url?.startsWith("/v1/web/status/")) { const id = decodeURIComponent(req.url.slice("/v1/web/status/".length)); const result = webTaskResults.get(id); const persisted = store.getWebTask(id); json(res, result || persisted ? 200 : 404, result ? { ok: true, result } : persisted ? { ok: true, result: persisted } : { ok: false, error: "task_not_found" }); return; }
      if (req.method === "POST" && req.url === "/v1/web/cancel") { const body = JSON.parse(await readBody(req)) as { task_id?: string }; if (!body.task_id || !cancelWebTask(body.task_id)) { json(res, 404, { ok: false, error: "task_not_found" }); return; } json(res, 200, { ok: true, task_id: body.task_id, cancelled: true }); return; }
      if (req.method === "POST" && req.url === "/tasks") { const body = JSON.parse(await readBody(req)) as ProductionWebTaskRequest; const taskId = startProductionTask(body, (event) => broadcast(event)); json(res, 202, { ok: true, task_id: taskId, status: "queued" }); return; }
      if (req.method === "GET" && req.url?.match(/^\/tasks\/[^/]+$/)) { const id = decodeURIComponent(req.url.slice("/tasks/".length)); const task = store.getWebTask(id); json(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: "task_not_found" }); return; }
      if (req.method === "GET" && req.url?.match(/^\/tasks\/[^/]+\/events$/)) { const id = decodeURIComponent(req.url.slice("/tasks/".length, -"/events".length)); json(res, 200, { ok: true, task_id: id, events: store.getAuditEventsForTask(id, 500) }); return; }
      if (req.method === "POST" && req.url?.match(/^\/tasks\/[^/]+\/pause$/)) { const id = decodeURIComponent(req.url.slice("/tasks/".length, -"/pause".length)); if (!pauseTask(id)) { json(res, 404, { ok: false, error: "task_not_running" }); return; } json(res, 200, { ok: true, task_id: id, status: "paused" }); return; }
      if (req.method === "POST" && req.url?.match(/^\/tasks\/[^/]+\/resume$/)) { const id = decodeURIComponent(req.url.slice("/tasks/".length, -"/resume".length)); if (!resumeTask(id)) { const persisted = store.getWebTask(id); if (!persisted || persisted.status !== "paused") { json(res, 404, { ok: false, error: "task_not_paused" }); return; } const taskId = startProductionTask({ ...persisted.request, resume_task_id: id }, (event) => broadcast(event)); json(res, 202, { ok: true, task_id: taskId, status: "resuming" }); return; } json(res, 200, { ok: true, task_id: id, status: "resumed" }); return; }
      if (req.method === "POST" && req.url?.match(/^\/tasks\/[^/]+\/cancel$/)) { const id = decodeURIComponent(req.url.slice("/tasks/".length, -"/cancel".length)); if (!cancelTask(id) && !cancelWebTask(id)) { json(res, 404, { ok: false, error: "task_not_running" }); return; } json(res, 200, { ok: true, task_id: id, status: "cancelled" }); return; }
      if (req.method === "GET" && req.url === "/sessions") { json(res, 200, { ok: true, sessions: listStoredSessions(store) }); return; }
      if (req.method === "POST" && req.url === "/sessions") { const body = JSON.parse(await readBody(req)) as { name?: string }; if (!body.name) { json(res, 400, { ok: false, error: "name is required" }); return; } const session = await createLoginSession(body.name); json(res, 200, { ok: true, session, next: "Complete login in the opened browser, then call POST /sessions/:name/save" }); return; }
      if (req.method === "POST" && req.url?.match(/^\/sessions\/[^/]+\/save$/)) { const name = decodeURIComponent(req.url.slice("/sessions/".length, -"/save".length)); await saveLoginSession(name, store); json(res, 200, { ok: true, name, saved: true }); return; }
      if (req.method === "DELETE" && req.url?.startsWith("/sessions/")) { const name = decodeURIComponent(req.url.slice("/sessions/".length)); const removed = await deleteSession(name, store); json(res, removed ? 200 : 404, { ok: removed, name, deleted: removed }); return; }
      if (req.method === "POST" && req.url?.match(/^\/approvals\/[^/]+$/)) { const id = decodeURIComponent(req.url.slice("/approvals/".length)); const body = JSON.parse(await readBody(req)) as { decision?: "approved" | "denied" }; if (body.decision !== "approved" && body.decision !== "denied") { json(res, 400, { ok: false, error: "decision must be approved or denied" }); return; } const current = store.getApproval(id); if (!current) { json(res, 404, { ok: false, error: "approval_not_found" }); return; } if (Date.parse(current.expires_at) <= Date.now()) { store.decideApproval(id, "denied"); json(res, 410, { ok: false, error: "approval_expired" }); return; } const decided = store.decideApproval(id, body.decision); json(res, decided ? 200 : 409, { ok: decided, id, decision: body.decision }); return; }

      if (req.method === "POST" && req.url === "/v1/math/analyze") { const body = JSON.parse(await readBody(req)) as MathAnalyzeRequest; const result = await analyzeMath(body, store); json(res, 200, { ok: true, result }); return; }
      if (req.method === "POST" && req.url === "/v1/math/pdf") { const body = JSON.parse(await readBody(req)) as { file?: string }; if (!body.file) { json(res, 400, { ok: false, error: "file is required" }); return; } const result = await ingestMathPdf(body.file, store); json(res, 200, { ok: true, result }); return; }
      if (req.method === "GET" && req.url === "/v1/math/documents") { json(res, 200, { ok: true, documents: store.listMathDocuments() }); return; }
      if (req.method === "GET" && req.url?.startsWith("/v1/math/documents/")) { const id = decodeURIComponent(req.url.slice("/v1/math/documents/".length)); const row = store.getMathDocument(id); json(res, row ? 200 : 404, row ? { ok: true, document: row.document } : { ok: false, error: "document_not_found" }); return; }
      if (req.method === "DELETE" && req.url?.startsWith("/v1/math/documents/")) { const id = decodeURIComponent(req.url.slice("/v1/math/documents/".length)); const removed = store.deleteMathDocument(id); json(res, removed ? 200 : 404, { ok: removed, id, deleted: removed }); return; }
      if (req.method === "POST" && req.url === "/v1/math/ask") { const body = JSON.parse(await readBody(req)) as MathAskRequest; const result = await askMathDocument(body, store); json(res, 200, { ok: true, result }); return; }
      if (req.method === "POST" && req.url === "/v1/math/tikz") { const body = JSON.parse(await readBody(req)) as { source?: string }; if (typeof body.source !== "string") { json(res, 400, { ok: false, error: "source is required" }); return; } const result = await renderTikz(body.source); json(res, 200, { ok: true, result }); return; }

      if (req.method === "POST" && req.url === "/v1/tags/parse") { const body = JSON.parse(await readBody(req)) as { text?: string }; const text = typeof body.text === "string" ? body.text : ""; const tags = parseBdsTags(text); const unsupported = tags.filter((tag) => !ALLOWED_PHASE0_TAGS.has(tag.name)).map((tag) => tag.name); store.audit("tags.parse", { count: tags.length, unsupported }); json(res, 200, { ok: true, tags, unsupported }); return; }
      if (req.method === "POST" && req.url === "/v1/audit") { const body = JSON.parse(await readBody(req)) as { eventType?: string; payload?: unknown }; if (!body.eventType || typeof body.eventType !== "string") { json(res, 400, { ok: false, error: "eventType is required" }); return; } store.audit(body.eventType, body.payload ?? null); json(res, 200, { ok: true }); return; }
      json(res, 404, { ok: false, error: "not_found" });
    } catch (error) { json(res, 400, { ok: false, error: error instanceof Error ? error.message : "request failed" }); }
  });

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMessageBytes });
  wsServer.on("connection", (socket) => { clients.add(socket); let authed = false; const timeout = setTimeout(() => { if (!authed) socket.close(1008, "authentication required"); }, 5000); socket.on("message", async (data) => { try { const message = JSON.parse(data.toString()) as WsHello | { type: string; requestId?: string; payload?: unknown }; if (!authed) { if (message.type !== "auth" || typeof (message as WsHello).token !== "string") { socket.close(1008, "authentication required"); return; } if (!authenticateBearer(`Bearer ${(message as WsHello).token}`, TOKEN)) { store.audit("ws.auth.failure", {}); socket.close(1008, "invalid token"); return; } authed = true; authenticated.add(socket); clearTimeout(timeout); store.audit("ws.auth.success", {}); sendStatus(socket); return; }
      if (message.type === "ping") { socket.send(JSON.stringify({ type: "runtime/pong", requestId: (message as { requestId?: string }).requestId } satisfies WsEvent)); return; }
      if (message.type === "status") { sendStatus(socket); return; }
      if (message.type === "web/start") { const payload = (message as { payload?: WebAgentRequest }).payload; if (!payload) throw new Error("missing web agent payload"); startWebTask(payload, (event) => socket.send(JSON.stringify(event))); return; }
      if (message.type === "web/cancel") { const taskId = String((message as { payload?: { task_id?: string } }).payload?.task_id ?? ""); if (!taskId || !cancelWebTask(taskId)) throw new Error("web task not found"); socket.send(JSON.stringify({ type: "web/event", payload: { type: "cancelled", payload: { task_id: taskId } } } satisfies WsEvent)); return; }
      if (message.type === "web/production/start") { const payload = (message as { payload?: ProductionWebTaskRequest }).payload; if (!payload) throw new Error("missing production web payload"); const taskId = startProductionTask(payload, (event) => socket.send(JSON.stringify(event))); socket.send(JSON.stringify({ type: "web/production", payload: { type: "started", payload: { task_id: taskId } } } satisfies WsEvent)); return; }
      if (message.type === "web/production/pause") { const id = String((message as { payload?: { task_id?: string } }).payload?.task_id ?? ""); if (!id || !pauseTask(id)) throw new Error("task not running"); return; }
      if (message.type === "web/production/resume") { const id = String((message as { payload?: { task_id?: string } }).payload?.task_id ?? ""); if (!id) throw new Error("task id required"); if (!resumeTask(id)) { const persisted = store.getWebTask(id); if (!persisted) throw new Error("task not found"); startProductionTask({ ...persisted.request, resume_task_id: id }, (event) => socket.send(JSON.stringify(event))); } return; }
      if (message.type === "web/production/cancel") { const id = String((message as { payload?: { task_id?: string } }).payload?.task_id ?? ""); if (!id || !cancelTask(id)) throw new Error("task not running"); return; }
      if (message.type === "math/analyze") { const payload = (message as { payload?: MathAnalyzeRequest }).payload; if (!payload) throw new Error("missing math analyze payload"); const result = await analyzeMath(payload, store); socket.send(JSON.stringify({ type: "math/result", payload: result } satisfies WsEvent)); return; }
      if (message.type === "math/pdf") { const payload = (message as { payload?: { file?: string } }).payload; if (!payload?.file) throw new Error("file is required"); const result = await ingestMathPdf(payload.file, store); socket.send(JSON.stringify({ type: "math/pdf/result", payload: result } satisfies WsEvent)); return; }
      if (message.type === "math/ask") { const payload = (message as { payload?: MathAskRequest }).payload; if (!payload) throw new Error("missing math ask payload"); const result = await askMathDocument(payload, store); socket.send(JSON.stringify({ type: "math/ask/result", payload: result } satisfies WsEvent)); return; }
      if (message.type === "math/tikz") { const payload = (message as { payload?: { source?: string } }).payload; if (!payload?.source) throw new Error("source is required"); const result = await renderTikz(payload.source); socket.send(JSON.stringify({ type: "math/tikz/result", payload: result } satisfies WsEvent)); return; }
      if (message.type === "tags") { const payload = (message as { payload?: { text?: string } }).payload ?? {}; const text = typeof payload.text === "string" ? payload.text : ""; const tags = parseBdsTags(text); const unsupported = tags.filter((tag) => !ALLOWED_PHASE0_TAGS.has(tag.name)).map((tag) => tag.name); store.audit("tags.detected", { count: tags.length, unsupported }); socket.send(JSON.stringify({ type: "runtime/tags", payload: { tags, unsupported } } satisfies WsEvent)); const localExec = tags.find((tag) => tag.name === "LOCAL_EXEC"); if (localExec) void executeLocalExecTag(localExec, socket); const webAgent = tags.find((tag) => tag.name === "WEB_AGENT"); if (webAgent) triggerWebTag(webAgent, socket); const mathAnalyze = tags.find((tag) => tag.name === "MATH_ANALYZE"); if (mathAnalyze) { socket.send(JSON.stringify({ type: "math/action-required", payload: { tag: mathAnalyze, message: "Attach the current equation selection with math/analyze." } } satisfies WsEvent)); } const mathPdf = tags.find((tag) => tag.name === "MATH_PDF"); if (mathPdf && typeof mathPdf.attributes.file === "string") { void ingestMathPdf(mathPdf.attributes.file, store).then((result) => socket.send(JSON.stringify({ type: "math/pdf/result", payload: result } satisfies WsEvent))).catch((error) => socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "Math PDF ingestion failed" } } satisfies WsEvent))); } const mathAsk = tags.find((tag) => tag.name === "MATH_ASK"); if (mathAsk && typeof mathAsk.attributes.document_id === "string" && typeof mathAsk.attributes.question === "string") { void askMathDocument({ document_id: mathAsk.attributes.document_id, question: mathAsk.attributes.question }, store).then((result) => socket.send(JSON.stringify({ type: "math/ask/result", payload: result } satisfies WsEvent))).catch((error) => socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "Math question failed" } } satisfies WsEvent))); } const tikz = tags.find((tag) => tag.name === "TIKZ_RENDER"); if (tikz && typeof tikz.attributes.source === "string") { void renderTikz(tikz.attributes.source).then((result) => socket.send(JSON.stringify({ type: "math/tikz/result", payload: result } satisfies WsEvent))).catch((error) => socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "TikZ render failed" } } satisfies WsEvent))); } return; }
      if (message.type === "code/execute") { const payload = (message as { payload?: LocalExecRequest }).payload; if (!payload) throw new Error("missing code execution payload"); if (!SUPPORTED_LANGUAGES.includes(payload.language as SupportedLanguage)) throw new Error("language is not allowlisted"); if (!store.isLanguageEnabled(payload.language)) throw new Error(`language ${payload.language} is disabled`); if (activeCodeJobs.size + activeWebTaskCount() + productionTasks.size >= LIMITS.maxConcurrentJobs) throw new Error("maximum concurrent background jobs reached"); const job = executeLocalCode(payload, store); activeCodeJobs.add(job); job.then((result) => socket.send(JSON.stringify({ type: "code/result", payload: result } satisfies WsEvent))).catch((error) => socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "code execution failed" } } satisfies WsEvent))).finally(() => activeCodeJobs.delete(job)); return; }
      store.audit("ws.message.unsupported", { type: message.type }); socket.send(JSON.stringify({ type: "runtime/error", payload: { message: `unsupported message: ${message.type}` } } satisfies WsEvent));
    } catch (error) { socket.send(JSON.stringify({ type: "runtime/error", payload: { message: error instanceof Error ? error.message : "invalid message" } } satisfies WsEvent)); } }); socket.on("close", () => { clearTimeout(timeout); clients.delete(socket); }); });
  server.on("upgrade", (req, socket, head) => { const url = new URL(req.url ?? "/", `http://${HOST}`); if (url.pathname !== "/ws") { socket.destroy(); return; } wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req)); });
  server.on("close", () => { wsServer.close(); for (const client of clients) client.close(); store.close(); });
  return server;
}
