import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDescriptor, AgentPlan, AgentTaskView } from "../src/agent/agent.js";

const DB_PATH = path.join(os.tmpdir(), `bds-agent-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.BDS_RUNTIME_DB = DB_PATH;
process.env.BDS_RUNTIME_TOKEN = "integration-test-token-0123456789abcdef";

const { RuntimeStore } = await import("../src/store.js");
const { AgentRegistry } = await import("../src/agent/registry.js");
const { TaskQueue } = await import("../src/agent/queue.js");
const { AgentRunner } = await import("../src/agent/runner.js");
const { createDefaultFactory } = await import("../src/agent/demo-agent.js");
const { Agent, assertNotAborted } = await import("../src/agent/agent.js");

let store: InstanceType<typeof RuntimeStore>;
let registry: InstanceType<typeof AgentRegistry>;
let queue: InstanceType<typeof TaskQueue>;

/** Test double that fails `failTimes` attempts before succeeding. */
class FlakyAgent extends Agent {
  constructor(descriptor: AgentDescriptor, private readonly failTimes: number, private readonly attempts: string[]) {
    super(descriptor);
  }
  protected async doPlan(): Promise<AgentPlan> {
    return { summary: "flaky plan" };
  }
  protected async doExecute(task: AgentTaskView): Promise<unknown> {
    this.attempts.push(task.id);
    if (this.attempts.length <= this.failTimes) throw new Error(`attempt ${this.attempts.length} failed`);
    return { attempts: this.attempts.length };
  }
}

/** Test double that hangs until cancelled. */
class HangingAgent extends Agent {
  protected async doPlan(): Promise<AgentPlan> {
    return { summary: "hang plan" };
  }
  protected async doExecute(): Promise<unknown> {
    while (!this.signal.aborted) await new Promise((r) => setTimeout(r, 5));
    assertNotAborted(this);
    return {};
  }
}

/** Test double whose work takes a fixed, observable amount of time. */
class SlowAgent extends Agent {
  protected async doPlan(): Promise<AgentPlan> {
    return { summary: "slow plan" };
  }
  protected async doExecute(): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 150));
    return { done: true };
  }
}

function stubFactory(failTimes: number, hang: boolean, attempts: string[] = []) {
  return (descriptor: AgentDescriptor) =>
    hang ? new HangingAgent(descriptor) : new FlakyAgent(descriptor, failTimes, attempts);
}

beforeAll(() => {
  store = new RuntimeStore();
  registry = new AgentRegistry(store.db);
  queue = new TaskQueue(store.db);
});

afterAll(() => {
  store.close();
  try { fs.rmSync(DB_PATH, { force: true }); fs.rmSync(`${DB_PATH}-wal`, { force: true }); fs.rmSync(`${DB_PATH}-shm`, { force: true }); } catch {}
});

describe("agent lifecycle (runner)", () => {
  it("spawn -> start -> complete records the greeting and final state", async () => {
    const events: Array<{ kind: string; agentId: string }> = [];
    const runner = new AgentRunner(registry, queue, createDefaultFactory(), { onEvent: (e) => events.push(e) });
    const agent = registry.register({ name: "hello-agent", type: "demo" });
    const task = runner.start(agent.id);
    await runner.waitIdle();

    const descriptor = registry.get(agent.id)!;
    expect(descriptor.state).toBe("completed");
    const finished = queue.get(task.id)!;
    expect(finished.status).toBe("completed");
    expect((finished.result as { message?: string }).message).toBe("Hello, I am agent hello-agent");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("start_requested");
    expect(kinds).toContain("task_completed");

    // Restarting a finished agent is rejected.
    expect(() => runner.start(agent.id)).toThrow(/cannot be started/);
  });

  it("start on an unknown or already-running agent is rejected", () => {
    const runner = new AgentRunner(registry, queue, createDefaultFactory());
    expect(() => runner.start("no-such-agent")).toThrow(/does not exist/);
    const id = registry.register({ name: "double", type: "demo" }).id;
    const first = runner.start(id);
    // The synchronous tick inside start() already claimed the task; the
    // agent is planning/running and a second start must be rejected.
    expect(queue.get(first.id)?.status).toBe("running");
    expect(() => runner.start(id)).toThrow(/already (planning|running)/);
    runner.cancel(id); // cleanup
  });

  it("retries failed executions until they succeed", async () => {
    const attempts: string[] = [];
    const factory = stubFactory(1, false, attempts);
    const runner = new AgentRunner(registry, queue, factory);
    const agent = registry.register({ name: "flaky", type: "demo" });
    const task = runner.start(agent.id);
    await runner.waitIdle();

    expect(attempts.length).toBe(2);
    expect(queue.get(task.id)?.status).toBe("completed");
    expect(registry.get(agent.id)?.state).toBe("completed");
  });

  it("marks the agent failed when retries are exhausted", async () => {
    const attempts: string[] = [];
    const factory = stubFactory(99, false, attempts);
    const runner = new AgentRunner(registry, queue, factory, { concurrency: 1 });
    const agent = registry.register({ name: "doomed", type: "demo" });
    const task = runner.start(agent.id);
    await runner.waitIdle();

    expect(attempts.length).toBeGreaterThan(1); // retried
    const record = queue.get(task.id)!;
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/failed/);
    expect(registry.get(agent.id)?.state).toBe("failed");
  });

  it("cancel aborts in-flight work without retrying it", async () => {
    const runner = new AgentRunner(registry, queue, stubFactory(0, true));
    const agent = registry.register({ name: "hanger", type: "demo" });
    const task = runner.start(agent.id);

    // Wait until the agent is actually running before cancelling.
    for (let i = 0; i < 100 && registry.get(agent.id)?.state !== "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    runner.cancel(agent.id);
    await runner.waitIdle();

    expect(registry.get(agent.id)?.state).toBe("cancelled");
    const record = queue.get(task.id)!;
    expect(record.status).toBe("cancelled"); // dropped, never re-run
    expect(record.finishedAt).toBeTruthy();
  });

  it("pauses before start defers work; resume lets it complete", async () => {
    const runner = new AgentRunner(registry, queue, createDefaultFactory());
    const agent = registry.register({ name: "punctual", type: "demo" });
    runner.pause(agent.id);
    expect(registry.get(agent.id)?.state).toBe("paused");
    runner.start(agent.id);
    await runner.waitIdle();
    expect(registry.get(agent.id)?.state).toBe("paused"); // untouched while paused
    expect(queue.list({ agentId: agent.id }).every((t) => t.status === "queued")).toBe(true);

    runner.resume(agent.id);
    for (let i = 0; i < 100 && registry.get(agent.id)?.state !== "completed"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.get(agent.id)?.state).toBe("completed");
  });

  it("pausing mid-execution does not cause a spurious retry", async () => {
    const events: Array<{ kind: string }> = [];
    const runner = new AgentRunner(registry, queue, (d) => new SlowAgent(d), { onEvent: (e) => events.push(e) });
    const agent = registry.register({ name: "slowpoke", type: "demo" });
    const task = runner.start(agent.id);
    for (let i = 0; i < 100 && registry.get(agent.id)?.state !== "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    runner.pause(agent.id); // lands while doExecute is still sleeping
    await runner.waitIdle();
    expect(registry.get(agent.id)?.state).toBe("completed");
    const record = queue.get(task.id)!;
    expect(record.status).toBe("completed");
    expect(record.retries).toBe(0); // no wasted attempt from the pause race
    expect(events.some((e) => e.kind === "task_failed")).toBe(false);
  });

  it("cancelling also cancels still-queued tasks of the same agent", () => {
    const runner = new AgentRunner(registry, queue, createDefaultFactory());
    const agent = registry.register({ name: "pending", type: "demo" });
    const t1 = runner.start(agent.id);
    const t2 = queue.enqueue({ agentId: agent.id, type: "run" });
    runner.cancel(agent.id);
    expect(queue.get(t1.id)?.status).toBe("cancelled");
    expect(queue.get(t2.id)?.status).toBe("cancelled");
    expect(registry.get(agent.id)?.state).toBe("cancelled");
    expect(runner.status(agent.id).agent.state).toBe("cancelled");
  });

  it("fails fast on unsupported agent types instead of retrying", async () => {
    const runner = new AgentRunner(registry, queue, createDefaultFactory());
    const agent = registry.register({ name: "alien", type: "worker" }); // no such implementation yet
    const task = runner.start(agent.id);
    await runner.waitIdle();
    const record = queue.get(task.id)!;
    expect(record.status).toBe("failed");
    expect(record.retries).toBe(0);
    expect(record.error).toMatch(/unsupported agent type/);
  });

  it("exposes status snapshots with current and recent tasks", async () => {
    const runner = new AgentRunner(registry, queue, createDefaultFactory());
    const agent = registry.register({ name: "reporter", type: "demo" });
    const task = runner.start(agent.id);
    await runner.waitIdle();
    const snapshot = runner.status(agent.id);
    expect(snapshot.agent.name).toBe("reporter");
    expect(snapshot.currentTask).toBeUndefined(); // nothing running anymore
    expect(snapshot.recentTasks.map((t) => t.id)).toContain(task.id);
  });
});

describe("agent lifecycle (HTTP endpoints)", () => {
  it("serves the full lifecycle over authenticated REST", async () => {
    const { createRuntimeServer } = await import("../src/server.js");
    const server = createRuntimeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: `Bearer ${process.env.BDS_RUNTIME_TOKEN}` };
    try {
      const denied = await fetch(`${base}/v1/agents`);
      expect(denied.status).toBe(401);

      const spawn = await fetch(`${base}/v1/agent/spawn`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "http-demo", type: "demo", context: { via: "http" } }),
      });
      expect(spawn.status).toBe(200);
      const { agent } = (await spawn.json()) as { agent: { id: string; state: string } };
      expect(agent.state).toBe("created");

      const list = await fetch(`${base}/v1/agents?state=created`, { headers: auth });
      const listed = (await list.json()) as { agents: Array<{ id: string }> };
      expect(listed.agents.map((a) => a.id)).toContain(agent.id);

      const missing = await fetch(`${base}/v1/agent/does-not-exist/status`, { headers: auth });
      expect(missing.status).toBe(404);

      const start = await fetch(`${base}/v1/agent/${agent.id}/start`, { method: "POST", headers: auth });
      expect(start.status).toBe(202);
      const started = (await start.json()) as { task_id: string };

      let statusJson!: { status: { agent: { state: string }; recentTasks: Array<{ id: string; result?: { message?: string } }> } };
      for (let i = 0; i < 100; i += 1) {
        const res = await fetch(`${base}/v1/agent/${agent.id}/status`, { headers: auth });
        statusJson = (await res.json()) as typeof statusJson;
        if (statusJson.status.agent.state === "completed") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(statusJson.status.agent.state).toBe("completed");
      expect(statusJson.status.recentTasks.find((t) => t.id === started.task_id)?.result?.message)
        .toBe("Hello, I am agent http-demo");

      // Terminal agents cannot be paused.
      const pause = await fetch(`${base}/v1/agent/${agent.id}/pause`, { method: "POST", headers: auth });
      expect(pause.status).toBe(409);

      // Spawn validation errors surface as 400.
      const bad = await fetch(`${base}/v1/agent/spawn`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ type: "demo" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});
