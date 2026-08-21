import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateBearer } from "./auth.js";
import { HOST, LIMITS, PORT, TOKEN } from "./config.js";
import { RuntimeStore } from "./store.js";
import { ALLOWED_PHASE0_TAGS, isCanonicalBdsTag, type WsEvent, type WsHello } from "./protocol.js";
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
