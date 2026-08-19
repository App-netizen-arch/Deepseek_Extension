export interface WsHello {
  type: "auth";
  token: string;
}

export interface WsMessage {
  type: "status" | "tags" | "ping" | "code/execute" | "web/start" | "web/cancel" | "math/analyze";
  requestId?: string;
  payload?: unknown;
}

export interface WsEvent {
  type: "runtime/status" | "runtime/tags" | "runtime/error" | "runtime/pong" | "code/result" | "web/event" | "math/result";
  requestId?: string;
  payload?: unknown;
}

export const ALLOWED_PHASE0_TAGS = new Set([
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
]);
