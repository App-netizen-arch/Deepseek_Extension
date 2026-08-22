import { CANONICAL_BDS_TAGS } from "./protocol-contract.js";
export * from "./protocol-contract.js";

export interface WsHello { type: "auth"; token: string; }
export interface WsMessage {
  type: "status" | "tags" | "ping" | "code/execute" | "web/start" | "web/cancel" | "web/production/start" | "web/production/pause" | "web/production/resume" | "web/production/cancel" | "math/analyze" | "math/pdf" | "math/ask" | "math/tikz" | "agent/spawn" | "agent/start" | "agent/pause" | "agent/resume" | "agent/cancel" | "agent/status" | "tools/list" | "tools/invoke" | "workflow/run" | "workflow/cancel";
  requestId?: string;
  payload?: unknown;
}
export interface WsEvent {
  type: "runtime/status" | "runtime/tags" | "runtime/error" | "runtime/pong" | "code/result" | "web/event" | "web/production" | "math/result" | "math/pdf/result" | "math/ask/result" | "math/tikz/result" | "math/action-required" | "agent/event" | "agent/status" | "tool/result" | "tool/list" | "workflow/event" | "skill/loaded";
  requestId?: string;
  payload?: unknown;
}
export const ALLOWED_PHASE0_TAGS: ReadonlySet<string> = new Set(CANONICAL_BDS_TAGS);
