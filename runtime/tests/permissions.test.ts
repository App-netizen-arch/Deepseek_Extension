import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionRuleRecord } from "../src/security/permissions.js";
import type { Tool } from "../src/mcp/tool.js";
import type { AgentDescriptor, AgentPlan } from "../src/agent/agent.js";

const DB = path.join(os.tmpdir(), `bds-permissions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.BDS_RUNTIME_DB = DB;

const { RuntimeStore } = await import("../src/store.js");
const { PermissionStore, checkPermission } = await import("../src/security/permissions.js");
const { ToolRegistry } = await import("../src/mcp/registry.js");
const { ToolInvocationService } = await import("../src/mcp/service.js");
const { AgentRunner } = await import("../src/agent/runner.js");
const { AgentRegistry } = await import("../src/agent/registry.js");
const { TaskQueue } = await import("../src/agent/queue.js");
const { Agent, } = await import("../src/agent/agent.js");

let store: InstanceType<typeof RuntimeStore>;
let permissions: InstanceType<typeof PermissionStore>;

function rule(partial: Partial<PermissionRuleRecord>): PermissionRuleRecord {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    tool: "*",
    decision: "allow",
    grantedBy: "test",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

/** Echo tool in a given tier that records params as its result. */
function tierTool(level: "low" | "medium" | "high" | "critical"): Tool {
  return {
    name: `echo_${level}`,
    description: `echo (${level})`,
    parameters: { type: "object", properties: { value: { type: "string" }, path: { type: "string" } } },
    permissionLevel: level,
    async execute(params) {
      return { echoed: (params as Record<string, unknown>).value ?? (params as Record<string, unknown>).path ?? null };
    },
  };
}

beforeAll(() => {
  store = new RuntimeStore();
  permissions = new PermissionStore(store.db);
});

afterAll(() => {
  store.close();
  try { fs.rmSync(DB, { force: true }); } catch {}
});

describe("glob matching", () => {
  const base = { agentId: "a1", tool: "fs_write" };

  function decisionFor(pattern: string | undefined, resource?: string): string | undefined {
    const rules = [rule({ tool: "fs_write", ...(pattern !== undefined ? { pathPattern: pattern } : {}) })];
    return checkPermission(rules, { ...base, ...(resource !== undefined ? { resource } : {}) });
  }

  it("supports **, *, and exact-path globs", () => {
    expect(decisionFor("src/**/*.rs", "src/main.rs")).toBe("allow");
    expect(decisionFor("src/**/*.rs", "src/deep/nested/mod.rs")).toBe("allow");
    expect(decisionFor("src/**/*.rs", "src/main.ts")).toBeUndefined();
    expect(decisionFor("src/**/*.rs", "srcx/main.rs")).toBeUndefined();
    expect(decisionFor("docs/*.md", "docs/readme.md")).toBe("allow");
    expect(decisionFor("docs/*.md", "docs/sub/readme.md")).toBeUndefined();
    expect(decisionFor("Cargo.toml", "Cargo.toml")).toBe("allow");
    expect(decisionFor("Cargo.toml", "cargo.toml")).toBeUndefined(); // case-sensitive
    expect(decisionFor("*", "anything")).toBe("allow");
  });

  it("does not match when a pattern exists but no resource is supplied", () => {
    expect(decisionFor("src/**/*.rs")).toBeUndefined();
    expect(checkPermission([rule({ tool: "t" })], { agentId: "a", tool: "t" })).toBe("allow"); // pattern-less rules are resource-agnostic
  });
});

describe("checkPermission evaluation", () => {
  it("applies deny > ask > allow precedence among matching rules", () => {
    const req = { agentId: "a", tool: "shell_run" };
    expect(checkPermission([rule({ tool: "shell_run", decision: "allow" }), rule({ tool: "shell_run", decision: "deny" })], req)).toBe("deny");
    expect(checkPermission([rule({ tool: "shell_run", decision: "allow" }), rule({ tool: "shell_run", decision: "ask" })], req)).toBe("ask");
    expect(checkPermission([rule({ tool: "shell_run", decision: "deny" }), rule({ tool: "*", decision: "ask" })], req)).toBe("deny");
    expect(checkPermission([], req)).toBeUndefined();
  });

  it("ignores expired rules and scopes by agent", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const req = { agentId: "a", tool: "git_commit" };
    expect(checkPermission([rule({ tool: "git_commit", expiresAt: past })], req)).toBeUndefined();
    expect(checkPermission([rule({ tool: "git_commit", expiresAt: future })], req)).toBe("allow");
    // Global rule reaches every agent; agent-specific does not leak sideways.
    expect(checkPermission([rule({ tool: "git_commit", agentId: undefined })], { agentId: "whoever", tool: "git_commit" })).toBe("allow");
    expect(checkPermission([rule({ tool: "git_commit", agentId: "b" })], req)).toBeUndefined();
  });
});

describe("PermissionStore", () => {
  it("validates input and persists rules with ttl", () => {
    expect(() => permissions.add({ tool: "fs_read", decision: "maybe" as never })).toThrow(/decision must be/);
    expect(() => permissions.add({ tool: "", decision: "allow" })).toThrow(/tool is required/);
    expect(() => permissions.add({ tool: "BAD NAME!", decision: "allow" })).toThrow(/invalid tool pattern/);
    expect(() => permissions.add({ tool: "fs_read", decision: "allow", ttlSeconds: -5 })).toThrow(/ttlSeconds must be positive/);

    const rec = permissions.add({ tool: "fs_read", decision: "allow", ttlSeconds: 120, grantedBy: "tester" });
    expect(rec.expiresAt).toBeDefined();
    expect(rec.grantedBy).toBe("tester");

    const listed = permissions.list({ tool: "fs_read" });
    expect(listed.map((r) => r.id)).toContain(rec.id);
    expect(permissions.revoke(rec.id)).toBe(true);
    expect(permissions.revoke(rec.id)).toBe(false);
    expect(permissions.list({ tool: "fs_read" }).map((r) => r.id)).not.toContain(rec.id);
  });

  it("prunes expired rules lazily", () => {
    const temp = new PermissionStore(store.db);
    const dying = temp.add({ tool: "legacy_tool", decision: "deny", ttlSeconds: 1 });
    const living = temp.add({ tool: "modern_tool", decision: "allow" });
    const row = store.db.prepare("SELECT expires_at FROM permissions WHERE id=?").get(dying.id) as { expires_at: string };
    store.db.prepare("UPDATE permissions SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), dying.id);
    temp.list();
    const remaining = store.db.prepare("SELECT id FROM permissions").all().map((r) => (r as { id: string }).id);
    expect(remaining).not.toContain(dying.id);
    expect(remaining).toContain(living.id);
    void row;
  });
});

describe("rule-aware invocation service", () => {
  function makeService(opts: Partial<ConstructorParameters<typeof ToolInvocationService>[3]> = {}): InstanceType<typeof ToolInvocationService> {
    const registry = new ToolRegistry(store);
    registry.register(tierTool("low"));
    registry.register(tierTool("medium"));
    registry.register(tierTool("high"));
    registry.register(tierTool("critical"));
    return new ToolInvocationService(registry, store, process.cwd(), { pollMs: 25, ...opts });
  }

  it("lets an explicit allow rule pre-consent a HIGH tool", async () => {
    const svc = makeService({ permissions });
    permissions.add({ tool: "echo_high", decision: "allow", agentId: "granted-agent" });
    const result = await svc.invoke({ agentId: "granted-agent" }, "echo_high", { value: "pre-approved" });
    expect(result).toEqual({ echoed: "pre-approved" });
    expect(store.listPendingApprovals()).toHaveLength(0);
  });

  it("forces approval for MEDIUM tools under an ask rule", async () => {
    const svc = makeService({ permissions });
    permissions.add({ tool: "echo_medium", decision: "ask", agentId: "cautious" });
    const pending = svc.invoke({ agentId: "cautious" }, "echo_medium", { value: "guarded" });
    for (let i = 0; i < 50 && store.listPendingApprovals().length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    const approval = store.listPendingApprovals().find((a) => (a as { action: string }).action === "tool:echo_medium") as { id: string };
    expect(approval).toBeDefined();
    store.decideApproval(approval.id, "approved");
    await expect(pending).resolves.toEqual({ echoed: "guarded" });
  });

  it("denies LOW tools under a deny rule and scopes denies by path glob", async () => {
    const svc = makeService({ permissions });
    permissions.add({ tool: "echo_low", decision: "deny", agentId: "restricted", pathPattern: "secrets/**" });
    await expect(svc.invoke({ agentId: "restricted" }, "echo_low", { path: "secrets/key.txt" })).rejects.toThrow(/denied by permission rule/);
    await expect(svc.invoke({ agentId: "restricted" }, "echo_low", { path: "public/readme.md" })).resolves.toEqual({ echoed: "public/readme.md" });
  });

  it("keeps CRITICAL denied unless an allow rule consents", async () => {
    const svc = makeService({ permissions });
    await expect(svc.invoke({ agentId: "a9" }, "echo_critical", {})).rejects.toThrow(/critical risk/);
    permissions.add({ tool: "echo_critical", decision: "allow", agentId: "a9", ttlSeconds: 60 });
    await expect(svc.invoke({ agentId: "a9" }, "echo_critical", { value: "consented" })).resolves.toEqual({ echoed: "consented" });
    // Other agents remain denied.
    await expect(svc.invoke({ agentId: "someone-else" }, "echo_critical", {})).rejects.toThrow(/critical risk/);
  });

  it("falls back to the default risk policy when no rule matches", async () => {
    const svc = makeService({ permissions, approvalTtlMs: 1100 });
    await expect(svc.invoke({ agentId: "a1" }, "echo_low", { value: "x" })).resolves.toEqual({ echoed: "x" });
    await expect(svc.invoke({ agentId: "a1" }, "echo_high", { value: "y" })).rejects.toThrow(/approval_denied|approval_expired/);
  }, 15000);

  it("expires grants so consent does not outlive its session", async () => {
    const svc = makeService({ permissions, approvalTtlMs: 1500 });
    permissions.add({ tool: "echo_high", decision: "allow", agentId: "session-agent", ttlSeconds: 1 });
    // While the grant is live the call is pre-consented.
    const early = await svc.invoke({ agentId: "session-agent" }, "echo_high", { value: "early" });
    expect(early).toEqual({ echoed: "early" });
    // After expiry the same call requires consent again.
    await new Promise((r) => setTimeout(r, 1200));
    const late = svc.invoke({ agentId: "session-agent" }, "echo_high", { value: "late" });
    for (let i = 0; i < 100 && store.listPendingApprovals().length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    const rows = store.listPendingApprovals() as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    store.decideApproval(rows.at(-1)!.id, "denied");
    await expect(late).rejects.toThrow(/approval_denied/);
  }, 20000);

  it("pushes newly created approvals to listeners", async () => {
    const pushes: Array<{ id: string }> = [];
    const svc = makeService({ permissions, onApprovalRequested: (info) => pushes.push({ id: info.id }) });
    const pending = svc.invoke({ agentId: "pushy" }, "echo_high", {});
    for (let i = 0; i < 50 && pushes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(pushes.length).toBe(1);
    const row = store.getApproval(pushes[0]!.id) as { status: string };
    expect(row.status).toBe("pending");
    store.decideApproval(pushes[0]!.id, "denied");
    await expect(pending).rejects.toThrow(/approval_denied/);
  }, 15000);
});

describe("end-to-end approval flow through the runner", () => {
  class CarefulAgent extends Agent {
    protected async doPlan(): Promise<AgentPlan> {
      return { summary: "call a high-risk tool after user consent" };
    }
    protected async doExecute(): Promise<unknown> {
      const result = (await this.callTool("echo_high", { value: "needs consent" })) as { echoed?: string };
      return { gotIt: result.echoed };
    }
  }

  it("agent requests, user approves mid-flight, agent continues to completion", async () => {
    const agentRegistry = new AgentRegistry(store.db);
    const queue = new TaskQueue(store.db);
    const toolRegistry = new ToolRegistry(store);
    toolRegistry.register(tierTool("high"));
    const pushes: Array<{ id: string }> = [];
    const service = new ToolInvocationService(toolRegistry, store, process.cwd(), {
      pollMs: 25,
      permissions,
      onApprovalRequested: (info) => pushes.push({ id: info.id }),
    });
    const runner = new AgentRunner(agentRegistry, queue, (d: AgentDescriptor) => new CarefulAgent(d), {
      concurrency: 1,
      toolInvoker: (caller, name, params) => service.invoke(caller, name, params),
    });

    const spawned = runner.spawn({ name: "careful", type: "demo" }, { task: {} });
    // Wait for the WS-push equivalent, i.e. the approval record existing.
    for (let i = 0; i < 100 && pushes.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(pushes.length).toBe(1);
    const pendingRows = store.listPendingApprovals() as Array<{ id: string; action: string }>;
    expect(pendingRows.some((a) => a.action === "tool:echo_high")).toBe(true);
    // The extension would POST /approvals/:id here; decide directly.
    store.decideApproval(pushes[0]!.id, "approved");
    await runner.waitIdle();
    const record = queue.get(spawned.task!.id)!;
    expect(record.status).toBe("completed");
    expect((record.result as { gotIt?: string }).gotIt).toBe("needs consent");
    // A second run asks again (no lingering grant). The user denies every
    // attempt; each denial consumes one retry until the budget is exhausted.
    const pushCountBefore = pushes.length;
    expect(pushCountBefore).toBe(1);
    const second = runner.spawn({ name: "careful-two", type: "demo" }, { task: {}, priority: 9 });
    for (let i = 0; i < 100 && pushes.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(pushes.length).toBe(2);
    const denier = setInterval(() => {
      for (const approval of store.listPendingApprovals() as Array<{ id: string; action: string }>) {
        if (approval.action === "tool:echo_high") store.decideApproval(approval.id, "denied");
      }
    }, 50);
    try {
      for (let i = 0; i < 280 && queue.get(second.task!.id)?.status !== "failed"; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      clearInterval(denier);
    }
    expect(queue.get(second.task!.id)?.status).toBe("failed");
    expect(queue.get(second.task!.id)?.error).toMatch(/approval_denied/);
    // Retries produced additional approval requests beyond the first two.
    expect(pushes.length).toBeGreaterThan(pushCountBefore);
  }, 30000);
});
