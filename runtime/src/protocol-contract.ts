export const BDS_PROTOCOL_VERSION = 1 as const;

export type BdsRequestKind =
  | "status"
  | "tags"
  | "ping"
  | "code/execute"
  | "web/start"
  | "web/cancel"
  | "web/production/start"
  | "web/production/pause"
  | "web/production/resume"
  | "web/production/cancel"
  | "math/analyze"
  | "math/pdf"
  | "math/ask"
  | "math/tikz";

export type BdsEventKind =
  | "runtime/status"
  | "runtime/tags"
  | "runtime/error"
  | "runtime/pong"
  | "code/result"
  | "web/event"
  | "web/production"
  | "math/result"
  | "math/pdf/result"
  | "math/ask/result"
  | "math/tikz/result"
  | "math/action-required";

export interface BdsRequestEnvelope<T = unknown> {
  version: typeof BDS_PROTOCOL_VERSION;
  id: string;
  type: BdsRequestKind;
  timestamp: number;
  sessionId?: string;
  projectId?: string;
  payload?: T;
}

export interface BdsResponseEnvelope<T = unknown> {
  version: typeof BDS_PROTOCOL_VERSION;
  id: string;
  type: BdsEventKind;
  timestamp: number;
  inReplyTo?: string;
  ok: boolean;
  payload?: T;
  error?: { code: string; message: string };
}

export function makeRequest<T>(id: string, type: BdsRequestKind, payload?: T, context?: Pick<BdsRequestEnvelope, "sessionId" | "projectId">): BdsRequestEnvelope<T> {
  return { version: BDS_PROTOCOL_VERSION, id, type, timestamp: Date.now(), ...(context?.sessionId ? { sessionId: context.sessionId } : {}), ...(context?.projectId ? { projectId: context.projectId } : {}), ...(payload === undefined ? {} : { payload }) };
}

export function makeResponse<T>(requestId: string, type: BdsEventKind, ok: true, payload?: T): BdsResponseEnvelope<T>;
export function makeResponse(requestId: string, type: BdsEventKind, ok: false, error: { code: string; message: string }): BdsResponseEnvelope<never>;
export function makeResponse<T>(requestId: string, type: BdsEventKind, ok: boolean, value?: T | { code: string; message: string }): BdsResponseEnvelope<T> {
  if (ok) return { version: BDS_PROTOCOL_VERSION, id: crypto.randomUUID(), type, timestamp: Date.now(), inReplyTo: requestId, ok: true, ...(value === undefined ? {} : { payload: value as T }) };
  return { version: BDS_PROTOCOL_VERSION, id: crypto.randomUUID(), type, timestamp: Date.now(), inReplyTo: requestId, ok: false, error: value as { code: string; message: string } };
}

export function validateRequestEnvelope(value: unknown): asserts value is BdsRequestEnvelope {
  if (!value || typeof value !== "object") throw new Error("invalid protocol envelope");
  const v = value as Record<string, unknown>;
  if (v.version !== BDS_PROTOCOL_VERSION) throw new Error("unsupported BDS protocol version");
  if (typeof v.id !== "string" || v.id.length < 1 || v.id.length > 128) throw new Error("invalid request id");
  if (typeof v.type !== "string") throw new Error("request type is required");
  if (!Number.isSafeInteger(v.timestamp)) throw new Error("invalid request timestamp");
  if (v.sessionId !== undefined && (typeof v.sessionId !== "string" || v.sessionId.length > 128)) throw new Error("invalid sessionId");
  if (v.projectId !== undefined && (typeof v.projectId !== "string" || v.projectId.length > 128)) throw new Error("invalid projectId");
}

export const CANONICAL_BDS_TAGS = Object.freeze([
  "AGENT_STATUS",
  "AGENT_CONTROL",
  "LOCAL_EXEC",
  "WEB_AGENT",
  "MATH_ANALYZE",
  "MATH_PDF",
  "MATH_ASK",
  "TIKZ_RENDER",
  "CODE_AGENT",
  "AGENT_LOGIN",
  "MEMORY_WRITE",
  "MEMORY_READ",
  "MEMORY_LIST",
  "MEMORY_DELETE",
  "PROJECT_CONTEXT",
  "AGENT_DEFINE",
  "SUBAGENT",
  "MCP_MANAGE",
  "WORKFLOW",
  "SKILL_LOAD",
  "PERMISSION_SET",
  "CONFIG_SET",
  "SESSION_EXPORT",
  "VISUALIZER",
  "COWORK",
  "CODE_PANEL",
  "CHAT_CLEAN",
] as const);

export function isCanonicalBdsTag(name: string): boolean {
  return (CANONICAL_BDS_TAGS as readonly string[]).includes(name);
}
