/**
 * Minimal MCP (Model Context Protocol) client over streamable HTTP.
 *
 * Speaks JSON-RPC 2.0: `initialize` -> `notifications/initialized` ->
 * `tools/list` / `tools/call`. Responses may arrive as plain JSON or as an
 * SSE stream (`text/event-stream`); both are handled. Remote tools are
 * wrapped as local {@link Tool}s so they pass through the exact same
 * registry/permission/approval pipeline as built-in tools.
 */
import { randomUUID } from "node:crypto";
import { secureUrl } from "../security-policy.js";
import type { Tool, ToolPermissionLevel } from "./tool.js";

/** A configured remote MCP server endpoint. */
export interface McpRemoteServer {
  /** Registry-safe server identifier ([a-z0-9_-]). */
  name: string;
  /** HTTP(S) endpoint of the MCP server. */
  url: string;
  /** Risk tier applied to every tool from this server (default medium). */
  risk?: ToolPermissionLevel;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RemoteToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

function sanitizeServerName(name: string): string {
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
  return name;
}

async function rpc(server: McpRemoteServer, method: string, params?: unknown, session?: string): Promise<unknown> {
  const url = secureUrl(server.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), server.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, ...(params !== undefined ? { params } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`MCP ${method} failed with HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    let payload = raw;
    if (contentType.includes("text/event-stream")) {
      payload = extractSseData(raw);
    }
    const parsed = JSON.parse(payload) as JsonRpcResponse | JsonRpcResponse[];
    const entry = Array.isArray(parsed) ? parsed.find((m) => m.result !== undefined || m.error !== undefined) : parsed;
    if (!entry) throw new Error(`MCP ${method} returned no payload`);
    if (entry.error) throw new Error(`MCP ${method} error ${entry.error.code}: ${entry.error.message}`);
    return entry.result;
  } finally {
    clearTimeout(timer);
  }
}

function extractSseData(raw: string): string {
  for (const frame of raw.split("\n\n").reverse()) {
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) return line.slice(5).trim();
    }
  }
  throw new Error("MCP SSE stream contained no data frame");
}

function notify(server: McpRemoteServer, method: string, session: string): Promise<void> {
  // Notifications carry no id and expect no response body.
  const url = secureUrl(server.url);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
  }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Perform the initialize handshake and return the session id.
 * Servers that skip initialization still work: a failed handshake is
 * non-fatal and calls proceed without a session header.
 */
async function openSession(server: McpRemoteServer): Promise<string | undefined> {
  try {
    const url = secureUrl(server.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), server.timeoutMs ?? 30_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "better-deepseek-runtime", version: "0.3.0" },
          },
        }),
        signal: controller.signal,
      });
      const session = response.headers.get("mcp-session-id");
      if (session) await notify(server, "notifications/initialized", session);
      return session ?? undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/** Fetch the remote tool list (`tools/list`). */
export async function listRemoteTools(server: McpRemoteServer): Promise<RemoteToolSpec[]> {
  const session = await openSession(server);
  const result = (await rpc(server, "tools/list", {}, session)) as { tools?: RemoteToolSpec[] };
  return Array.isArray(result?.tools) ? result.tools : [];
}

/** Call a remote tool (`tools/call`) and flatten its text content. */
export async function callRemoteTool(server: McpRemoteServer, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const session = await openSession(server);
  const result = (await rpc(server, "tools/call", { name: toolName, arguments: args }, session)) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  if (result?.isError) throw new Error("remote tool reported an error");
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text;
}

/** Wrap discovered remote tools as locally registered {@link Tool}s. */
export async function discoverRemoteTools(server: McpRemoteServer): Promise<Tool[]> {
  sanitizeServerName(server.name);
  const specs = await listRemoteTools(server);
  const level: ToolPermissionLevel = server.risk ?? "medium";
  return specs.map((spec) => {
    const tool: Tool = {
      name: `mcp_${server.name}_${spec.name}`,
      description: spec.description ? `[mcp:${server.name}] ${spec.description}` : `[mcp:${server.name}] ${spec.name}`,
      parameters: {
        type: "object",
        ...schemaProperties(spec.inputSchema),
      },
      permissionLevel: level,
      async execute(params) {
        return callRemoteTool(server, spec.name, params as Record<string, unknown>);
      },
    };
    return tool;
  });
}

function schemaProperties(inputSchema: Record<string, unknown> | undefined): Pick<Tool["parameters"], "properties" | "required"> {
  if (!inputSchema || inputSchema.type !== "object") return {};
  const out: Pick<Tool["parameters"], "properties" | "required"> = {};
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    out.properties = inputSchema.properties as Tool["parameters"]["properties"];
  }
  if (Array.isArray(inputSchema.required)) out.required = inputSchema.required as string[];
  return out;
}
