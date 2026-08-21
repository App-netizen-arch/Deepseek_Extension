import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.BDS_RUNTIME_DB = process.env.BDS_RUNTIME_DB ?? "unused-for-mcp-test.db";

const { discoverRemoteTools, callRemoteTool } = await import("../src/mcp/client.js");
const { ToolRegistry } = await import("../src/mcp/registry.js");
const { ToolInvocationService } = await import("../src/mcp/service.js");
const { RuntimeStore } = await import("../src/store.js");

let server: http.Server;
let port = 0;
let lastSession: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: string; method: string; params?: Record<string, unknown> };
      if (message.method === "initialize") {
        lastSession = `sess-${Date.now()}`;
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": lastSession! });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "mock", version: "1" } } }));
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                { name: "echo", description: "Echo back the text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
                { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === "tools/call") {
        const args = (message.params as { arguments: Record<string, unknown> }).arguments;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(args) }] },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("MCP remote tools", () => {
  it("discovers and registers remote tools through the standard pipeline", async () => {
    const store = new RuntimeStore();
    try {
      const registry = new ToolRegistry(store);
      const tools = await discoverRemoteTools({ name: "mock", url: `http://127.0.0.1:${port}/mcp` });
      expect(tools.map((t) => t.name).sort()).toEqual(["mcp_mock_add", "mcp_mock_echo"]);
      for (const tool of tools) registry.register(tool);
      expect(registry.isEnabled("mcp_mock_echo")).toBe(true);

      const service = new ToolInvocationService(registry, store, process.cwd(), { pollMs: 25 });
      // medium risk -> allowed without approval
      const result = await service.invoke({ agentId: "agent-x" }, "mcp_mock_echo", { text: "hello mcp" });
      expect(result).toBe(JSON.stringify({ text: "hello mcp" }));

      const descriptors = registry.list().filter((t) => t.name.startsWith("mcp_"));
      expect(descriptors.every((t) => t.permissionLevel === "medium")).toBe(true);
      expect(typeof lastSession).toBe("string");
    } finally {
      store.close();
    }
  });

  it("calls remote tools directly and rejects invalid servers", async () => {
    const result = await callRemoteTool({ name: "mock", url: `http://127.0.0.1:${port}/mcp` }, "add", { a: 2, b: 3 });
    expect(result).toBe(JSON.stringify({ a: 2, b: 3 }));
    await expect(discoverRemoteTools({ name: "bad", url: "file:///tmp" })).rejects.toThrow(/file URLs/);
    await expect(discoverRemoteTools({ name: "BAD NAME", url: `http://127.0.0.1:${port}/` })).rejects.toThrow(/invalid MCP server name/);
  });

  it("surfaces remote failures as invocation errors", async () => {
    const store = new RuntimeStore();
    try {
      const registry = new ToolRegistry(store);
      const tools = await discoverRemoteTools({ name: "mock", url: `http://127.0.0.1:${port}/mcp` });
      for (const tool of tools) registry.register(tool);
      const service = new ToolInvocationService(registry, store, process.cwd(), { pollMs: 25 });
      await expect(service.invoke({ agentId: "a" }, "missing_remote", {})).rejects.toThrow(/unknown tool/);
    } finally {
      store.close();
    }
  });
});
