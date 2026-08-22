import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDescriptor } from "../src/agent/agent.js";

const DB_PATH = path.join(os.tmpdir(), `bds-agent-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.BDS_RUNTIME_DB = DB_PATH;
process.env.BDS_RUNTIME_TOKEN = "integration-test-token-0123456789abcdef";

const { RuntimeStore } = await import("../src/store.js");
const { AgentRegistry } = await import("../src/agent/registry.js");
const { TaskQueue } = await import("../src/agent/queue.js");
const { AgentRunner } = await import("../src/agent/runner.js");
const { createDefaultFactory } = await import("../src/agent/demo-agent.js");
const { Agent, assertNotAborted } = await import("../src/agent/agent.js");
const { restrictPermissions, agentDepth, DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENT_DEPTH } = await import("../src/agent/permissions.js");

let store: InstanceType<typeof RuntimeStore>;
let registry: InstanceType<typeof AgentRegistry>;
let queue: InstanceType<typeof TaskQueue>;

/** Test double that hangs until cancelled. */
class HangingAgent extends Agent {
  protected async doPlan() {
    return { summary: "hang" };
  }
  protected async doExecute(): Promise<unknown> {
    while (!this.signal.aborted) await new Promise((r) => setTimeout(r, 5));
    assertNotAborted(this);
    return {};
  }
}

function mixedFactory(): (descriptor: AgentDescriptor) => InstanceType<typeof Agent> {
  const base = createDefaultFactory() as (d: AgentDescriptor) => InstanceType<typeof Agent>;
  return (descriptor) => (descriptor.type === "hang" ? new HangingAgent(descriptor) : base(descriptor));
}

beforeAll(() => {
  store = new RuntimeStore();
  registry = new AgentRegistry(store.db);
  queue = new TaskQueue(store.db);
});

afterAll(() => {
  store.close();
  try {
    fs.rmSync(DB_PATH, { force: true });
    fs.rmSync(`${DB_PATH}-wal`, { force: true });
    fs.rmSync(`${DB_PATH}-shm`, { force: true });
  } catch {}
});

describe("restrictPermissions", () => {
  it("intersects tool lists when both sides define them", () => {
    const child = restrictPermissions({ tools: ["fs_read", "fs_write", "git_status"] }, { tools: ["fs_write", "http_request", "fs_write"] });
    expect(child.tools).toEqual(["fs_write"]);
  });

  it("keeps whichever side defines tools when the other does not", () => {
    expect(restrictPermissions({ tools: ["a"] }, {}).tools).toEqual(["a"]);
    expect(restrictPermissions({}, { tools: ["b"] }).tools).toEqual(["b"]);
    expect(restrictPermissions({}, {}).tools).toBeUndefined();
  });

  it("clamps maxSubagents to the tighter of override vs effective parent limit", () => {
    expect(restrictPermissions({ maxSubagents: 10 }, { maxSubagents: 2 }).maxSubagents).toBe(2);
    // Override can never exceed the parent envelope (default applies).
    expect(restrictPermissions({}, { maxSubagents: 99 }).maxSubagents).toBe(DEFAULT_MAX_SUBAGENTS);
    expect(restrictPermissions({ maxSubagents: 7 }, {}).maxSubagents).toBe(7);
    expect(restrictPermissions({}, {}).maxSubagents).toBe(DEFAULT_MAX_SUBAGENTS);
  });

  it("rejects malformed overrides", () => {
    expect(() => restrictPermissions({}, [] as never)).toThrow(/permissionsOverride must be an object/);
  });
});

describe("subagent spawning (runner)", () => {
  it("inherits project/session scope and clamps permissions to the parent envelope", () => {
    const runner = new AgentRunner(registry, queue, mixedFactory());
    const parent = runner.spawn({
      name: "root",
      type: "demo",
      projectId: "proj-9",
      sessionId: "sess-9",
      permissions: { tools: ["fs_read", "fs_write"] },
    }).agent;

    const clamped = runner.spawn({
      name: "child",
      type: "demo",
      parentId: parent.id,
      permissions: { tools: ["fs_write", "shell_run"] },
    }).agent;
    expect(clamped.parentId).toBe(parent.id);
    expect(clamped.projectId).toBe("proj-9");
    expect(clamped.sessionId).toBe("sess-9");
    expect(clamped.permissions.tools).toEqual(["fs_write"]);

    const plain = runner.spawn({ name: "plain", type: "demo", parentId: parent.id }).agent;
    expect(plain.permissions).toEqual({ tools: ["fs_read", "fs_write"], maxSubagents: DEFAULT_MAX_SUBAGENTS });

    // Explicit child scope wins over inheritance.
    const moved = runner.spawn({ name: "moved", type: "demo", parentId: parent.id, sessionId: "other" }).agent;
    expect(moved.sessionId).toBe("other");
  });

  it("enforces the parent's subagent budget", () => {
    const runner = new AgentRunner(registry, queue, mixedFactory());
    const parent = runner.spawn({ name: "budgeted", type: "demo", permissions: { maxSubagents: 1 } }).agent;
    runner.spawn({ name: "only-child", type: "demo", parentId: parent.id });
    expect(() => runner.spawn({ name: "second-child", type: "demo", parentId: parent.id })).toThrow(/subagent budget \(1\)/);
  });

  it("enforces the global depth limit", () => {
    const runner = new AgentRunner(registry, queue, mixedFactory());
    let current = runner.spawn({ name: "depth-root", type: "demo" }).agent;
    for (let level = 1; level <= MAX_SUBAGENT_DEPTH; level += 1) {
      current = runner.spawn({ name: `depth-${level}`, type: "demo", parentId: current.id }).agent;
      expect(agentDepth(registry, current.id)).toBe(level);
    }
    expect(() => runner.spawn({ name: "too-deep", type: "demo", parentId: current.id })).toThrow(/depth limit/);
  });

  it("refuses to spawn under a terminal parent", () => {
    const runner = new AgentRunner(registry, queue, mixedFactory());
    const parent = runner.spawn({ name: "done-parent", type: "demo" }).agent;
    registry.update(parent.id, { state: "completed" });
    expect(() => runner.spawn({ name: "late-child", type: "demo", parentId: parent.id })).toThrow(/completed agent/);
  });

  it("enqueues and runs the bootstrap task when one is provided", async () => {
    const runner = new AgentRunner(registry, queue, mixedFactory());
    const { agent, task } = runner.spawn({ name: "worker", type: "demo" }, { task: { instruction: "greet" } });
    expect(task?.status).toBe("queued");
    await runner.waitIdle();
    expect(queue.get(task!.id)?.status).toBe("completed");
    expect(registry.get(agent.id)?.state).toBe("completed");
  });
});

describe("subagent lifecycle binding", () => {
  it("cancelling a parent cancels all descendants recursively", async () => {
    const runner = new AgentRunner(registry, queue, mixedFactory(), { concurrency: 4 });
    const root = runner.spawn({ name: "tree-root", type: "hang" }, { task: {} }).agent;
    const child = runner.spawn({ name: "tree-child", type: "hang", parentId: root.id }, { task: {} }).agent;
    const grandchild = runner.spawn({ name: "tree-grandchild", type: "demo", parentId: child.id }).agent;

    for (let i = 0; i < 100 && registry.get(root.id)?.state !== "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    runner.cancel(root.id);
    await runner.waitIdle();

    for (const id of [root.id, child.id, grandchild.id]) {
      expect(registry.get(id)?.state).toBe("cancelled");
    }
    expect(runner.status(root.id).children).toEqual([child.id]);
    expect(collectAllTasksCancelled([root.id, child.id])).toBe(true);
  });

  function collectAllTasksCancelled(agentIds: string[]): boolean {
    return agentIds.every((id) => queue.list({ agentId: id }).every((t) => t.status === "cancelled"));
  }

  it("cancelling a child leaves the parent untouched", () => {
    const runner = new AgentRunner(registry, queue, mixedFactory());
    const parent = runner.spawn({ name: "survivor", type: "demo" }).agent;
    const child = runner.spawn({ name: "leaf", type: "demo", parentId: parent.id }).agent;
    runner.cancel(child.id);
    expect(registry.get(child.id)?.state).toBe("cancelled");
    expect(registry.get(parent.id)?.state).toBe("created");
  });
});

describe("subagents over HTTP", () => {
  it("spawns with parentId + permissionsOverride and cascades cancellation", async () => {
    const { createRuntimeServer } = await import("../src/server.js");
    const server = createRuntimeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: `Bearer ${process.env.BDS_RUNTIME_TOKEN}`, "content-type": "application/json" };
    try {
      const parentRes = await fetch(`${base}/v1/agent/spawn`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "http-parent", type: "demo", permissions: { tools: ["fs_read"], maxSubagents: 1 } }),
      });
      const { agent: parent } = (await parentRes.json()) as { agent: { id: string } };

      const childRes = await fetch(`${base}/v1/agent/spawn`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "http-child",
          type: "demo",
          parentId: parent.id,
          permissionsOverride: { tools: ["fs_read", "shell_run"] },
        }),
      });
      expect(childRes.status).toBe(200);
      const { agent: child } = (await childRes.json()) as { agent: { id: string; permissions: { tools?: string[] } } };
      expect(typeof child.id).toBe("string");
      expect(child.permissions.tools).toEqual(["fs_read"]);

      const list = await fetch(`${base}/v1/agents?parentId=${parent.id}`, { headers: auth });
      const listed = (await list.json()) as { agents: Array<{ id: string }> };
      expect(listed.agents.map((a) => a.id)).toEqual([child.id]);

      const status = await fetch(`${base}/v1/agent/${parent.id}/status`, { headers: auth });
      const snapshot = (await status.json()) as { status: { children: string[] } };
      expect(snapshot.status.children).toEqual([child.id]);

      // Budget of 1 is exhausted -> second child is rejected with 409.
      const overflow = await fetch(`${base}/v1/agent/spawn`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "overflow", type: "demo", parentId: parent.id }),
      });
      expect(overflow.status).toBe(409);

      const cancel = await fetch(`${base}/v1/agent/${parent.id}/cancel`, { method: "POST", headers: auth });
      expect(cancel.status).toBe(200);
      const childStatus = await fetch(`${base}/v1/agent/${child.id}/status`, { headers: auth });
      const childSnapshot = (await childStatus.json()) as { status: { agent: { state: string } } };
      expect(childSnapshot.status.agent.state).toBe("cancelled");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});
