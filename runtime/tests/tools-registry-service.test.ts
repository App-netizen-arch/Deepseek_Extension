import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "bds-tools-svc-ws-"));
const DB = path.join(os.tmpdir(), `bds-tools-svc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.BDS_WORKSPACE = WS;
process.env.BDS_RUNTIME_DB = DB;

const { RuntimeStore } = await import("../src/store.js");
const { ToolRegistry } = await import("../src/mcp/registry.js");
const { ToolInvocationService } = await import("../src/mcp/service.js");
const { createBuiltinTools } = await import("../src/mcp/builtin.js");
const { AgentRunner } = await import("../src/agent/runner.js");
const { AgentRegistry } = await import("../src/agent/registry.js");
const { TaskQueue } = await import("../src/agent/queue.js");
const { Agent } = await import("../src/agent/agent.js");
import type { Tool } from "../src/mcp/tool.js";
import type { AgentDescriptor, AgentPlan } from "../src/agent/agent.js";

let store: InstanceType<typeof RuntimeStore>;

/** Deterministic echo tool in every risk tier for service-level tests. */
function tierTool(level: "low" | "medium" | "high" | "critical"): Tool {
  return {
    name: `echo_${level}`,
    description: `echo (${level})`,
    parameters: { type: "object", properties: { value: { type: "string" } } },
    permissionLevel: level,
    async execute(params) {
      return { echoed: (params as { value?: string }).value ?? null };
    },
  };
}

/** Stub agent that exercises callTool end-to-end. */
class ToolUserAgent extends Agent {
  protected async doPlan(): Promise<AgentPlan> {
    return { summary: "write then read a file via tools" };
  }
  protected async doExecute(): Promise<unknown> {
    await this.callTool("fs_write", { path: "from-agent.txt", content: "written by agent" });
    const read = (await this.callTool("fs_read", { path: "from-agent.txt" })) as { content?: string };
    return { content: read.content };
  }
}

beforeAll(() => {
  store = new RuntimeStore();
});

afterAll(() => {
  store.close();
  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(DB, { force: true }); } catch {}
});

describe("ToolRegistry", () => {
  it("registers, lists, enables and disables tools", () => {
    const registry = new ToolRegistry();
    registry.register(tierTool("low"));
    expect(registry.get("echo_low")?.name).toBe("echo_low");
    expect(registry.list()[0]).toMatchObject({ name: "echo_low", enabled: true, permissionLevel: "low" });
    registry.disable("echo_low");
    expect(registry.isEnabled("echo_low")).toBe(false);
    registry.enable("echo_low");
    expect(registry.isEnabled("echo_low")).toBe(true);
    expect(() => registry.enable("nope")).toThrow(/unknown tool/);
    expect(() => registry.register({ ...tierTool("low"), name: "Bad Name!" })).toThrow(/invalid tool name/);
    expect(() => registry.register({ ...tierTool("low"), name: "x", permissionLevel: "extreme" as never })).toThrow(/invalid permission level/);
    expect(() => registry.register({ ...tierTool("low"), name: "x", description: "" })).toThrow(/description is required/);
  });

  it("persists disabled state across restarts via SQLite", () => {
    const first = new ToolRegistry(store);
    first.register(tierTool("medium"));
    first.disable("echo_medium");
    // Simulate a process restart against the same database.
    const second = new ToolRegistry(store);
    second.register(tierTool("medium"));
    expect(second.isEnabled("echo_medium")).toBe(false);
    second.enable("echo_medium");
    expect(second.isEnabled("echo_medium")).toBe(true);
  });
});

describe("ToolInvocationService", () => {
  function makeService(ttlMs?: number): InstanceType<typeof ToolInvocationService> {
    const registry = new ToolRegistry(store);
    for (const t of [tierTool("low"), tierTool("high"), tierTool("critical")]) registry.register(t);
    return new ToolInvocationService(registry, store, WS, ttlMs ? { approvalTtlMs: ttlMs, pollMs: 25 } : { pollMs: 25 });
  }

  it("executes low-risk tools immediately", async () => {
    const result = await makeService().invoke({ agentId: "a1" }, "echo_low", { value: "hi" });
    expect(result).toEqual({ echoed: "hi" });
  });

  it("rejects unknown, disabled, critical, and non-granted tools", async () => {
    const svc = makeService();
    await expect(svc.invoke({ agentId: "a1" }, "missing_tool", {})).rejects.toThrow(/unknown tool/);

    const registry = new ToolRegistry(store);
    registry.register(tierTool("low"));
    registry.disable("echo_low");
    const restricted = new ToolInvocationService(registry, store, WS, { pollMs: 25 });
    await expect(restricted.invoke({ agentId: "a1" }, "echo_low", {})).rejects.toThrow(/disabled/);
    await expect(svc.invoke({ agentId: "a1" }, "echo_critical", {})).rejects.toThrow(/critical risk/);
    await expect(
      svc.invoke({ agentId: "a1", permissions: { tools: ["fs_read"] } }, "echo_low", {}),
    ).rejects.toThrow(/not permitted for agent/);
  });

  it("holds high-risk calls until an approval is granted", async () => {
    const svc = makeService();
    const pending = svc.invoke({ agentId: "a2", taskId: "task-7" }, "echo_high", { value: "go" });
    // Wait for the approval row, then approve it concurrently.
    for (let i = 0; i < 50 && store.listPendingApprovals().length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const approvals = store.listPendingApprovals() as Array<{ id: string; action: string; task_id: string }>;
    expect(approvals.length).toBeGreaterThan(0);
    const approval = approvals.find((a) => a.action === "tool:echo_high")!;
    expect(approval.task_id).toBe("task-7");
    store.decideApproval(approval.id, "approved");
    await expect(pending).resolves.toEqual({ echoed: "go" });
  });

  it("rejects high-risk calls when denied or expired", async () => {
    const svc = makeService();
    const denied = svc.invoke({ agentId: "a3" }, "echo_high", {});
    for (let i = 0; i < 50 && store.listPendingApprovals().length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const row = store.listPendingApprovals().at(-1) as { id: string };
    store.decideApproval(row.id, "denied");
    await expect(denied).rejects.toThrow(new RegExp(`approval_denied:${row.id}`));

    const expiring = makeService(1100); // clamped minimum keeps this test fast
    const expired = expiring.invoke({ agentId: "a4" }, "echo_high", {});
    await expect(expired).rejects.toThrow(/approval_expired:/);
  }, 15000);
});

describe("agents calling tools through the runner", () => {
  it("routes callTool through the permission pipeline", async () => {
    const registry = new AgentRegistry(store.db);
    const queue = new TaskQueue(store.db);
    const toolRegistry = new ToolRegistry(store);
    for (const t of createBuiltinTools()) toolRegistry.register(t);
    const service = new ToolInvocationService(toolRegistry, store, WS, { pollMs: 25 });
    const runner = new AgentRunner(registry, queue, (d: AgentDescriptor) => new ToolUserAgent(d), {
      concurrency: 2,
      toolInvoker: (caller, name, params) => service.invoke(caller, name, params),
    });

    const { agent, task } = runner.spawn({ name: "tool-user", type: "demo" }, { task: {} });
    void agent;
    await runner.waitIdle();
    const record = queue.get(task!.id)!;
    expect(record.status).toBe("completed");
    expect((record.result as { content?: string }).content).toBe("written by agent");
    expect(fs.readFileSync(path.join(WS, "from-agent.txt"), "utf8")).toBe("written by agent");
  });

  it("blocks agents whose permission list excludes the tool", async () => {
    const registry = new AgentRegistry(store.db);
    const queue = new TaskQueue(store.db);
    const toolRegistry = new ToolRegistry(store);
    for (const t of createBuiltinTools()) toolRegistry.register(t);
    const service = new ToolInvocationService(toolRegistry, store, WS, { pollMs: 25 });
    const runner = new AgentRunner(registry, queue, (d: AgentDescriptor) => new ToolUserAgent(d), {
      concurrency: 1,
      toolInvoker: (caller, name, params) => service.invoke(caller, name, params),
    });

    const { task } = runner.spawn(
      { name: "restricted", type: "demo", permissions: { tools: ["git_status"] } },
      { task: {}, priority: 9 },
    );
    await runner.waitIdle();
    const record = queue.get(task!.id)!;
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/not permitted for agent/);
  });
});
