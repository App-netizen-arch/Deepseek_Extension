import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BDS_RUNTIME_DB = path.join(os.tmpdir(), `bds-agent-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const { RuntimeStore } = await import("../src/store.js");
const { TaskQueue } = await import("../src/agent/queue.js");

let store: InstanceType<typeof RuntimeStore>;
let queue: InstanceType<typeof TaskQueue>;

beforeAll(() => {
  store = new RuntimeStore();
  queue = new TaskQueue(store.db);
});

beforeEach(() => {
  // Tests assume a quiet queue; drop leftovers from earlier cases.
  for (const task of queue.list({ status: "queued" })) queue.failTask(task.id, new Error("test cleanup"));
});

afterAll(() => {
  store.close();
  try { fs.rmSync(process.env.BDS_RUNTIME_DB!, { force: true }); } catch {}
});

describe("TaskQueue", () => {
  it("enqueues with defaults and validates specs", () => {
    const task = queue.enqueue({ agentId: "agent-1", type: "run" });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.priority).toBe(5);
    expect(task.status).toBe("queued");
    expect(task.retries).toBe(0);
    expect(task.maxRetries).toBe(3);
    expect(task.payload).toEqual({});

    expect(() => queue.enqueue({ agentId: "", type: "run" })).toThrow(/agentId is required/);
    expect(() => queue.enqueue({ agentId: "a", type: "" })).toThrow(/type is required/);
    expect(() => queue.enqueue({ agentId: "a", type: "run", priority: 0 })).toThrow(/priority/);
    expect(() => queue.enqueue({ agentId: "a", type: "run", priority: 11 })).toThrow(/priority/);
    expect(() => queue.enqueue({ agentId: "a", type: "run", priority: 1.5 })).toThrow(/priority/);
    expect(() => queue.enqueue({ agentId: "a", type: "run", maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => queue.enqueue({ agentId: "a", type: "run", payload: [1] as never })).toThrow(/payload must be an object/);
  });

  it("dequeues highest priority first, then oldest within a priority", async () => {
    const older = queue.enqueue({ agentId: "p5-old", type: "run", priority: 5 });
    await new Promise((r) => setTimeout(r, 15)); // guarantee distinct schedule times
    const high = queue.enqueue({ agentId: "p9", type: "run", priority: 9 });
    await new Promise((r) => setTimeout(r, 15));
    const newer = queue.enqueue({ agentId: "p5-new", type: "run", priority: 5 });
    const low = queue.enqueue({ agentId: "p1", type: "run", priority: 1 });

    expect(queue.dequeue()?.id).toBe(high.id);      // priority wins first
    expect(queue.dequeue()?.id).toBe(older.id);     // same priority -> oldest
    expect(queue.dequeue()?.id).toBe(newer.id);
    expect(queue.dequeue()?.id).toBe(low.id);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("skips excluded agents when dequeuing", () => {
    const a = queue.enqueue({ agentId: "busy-agent", type: "run", priority: 10 });
    const b = queue.enqueue({ agentId: "free-agent", type: "run", priority: 5 });
    expect(queue.dequeue(["busy-agent"])?.id).toBe(b.id);
    queue.requeue(b.id);
    expect(queue.dequeue([b.id])?.id).toBe(a.id);
    queue.requeue(a.id);
    queue.requeue(b.id);
  });

  it("acks running tasks and stores results", () => {
    const task = queue.enqueue({ agentId: "ack-agent", type: "run" });
    expect(queue.ack(task.id)).toBe(false); // still queued, cannot ack
    queue.dequeue();
    expect(queue.ack(task.id, { done: true })).toBe(true);
    const finished = queue.get(task.id)!;
    expect(finished.status).toBe("completed");
    expect(finished.result).toEqual({ done: true });
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.startedAt).toBeTruthy();
  });

  it("retries on nack up to maxRetries, then fails permanently", () => {
    const task = queue.enqueue({ agentId: "retry-agent", type: "run", maxRetries: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(queue.dequeue()?.id).toBe(task.id);
      const retried = queue.nack(task.id, new Error("boom"))!;
      expect(retried.status).toBe("queued");
      expect(retried.retries).toBe(attempt + 1);
    }
    expect(queue.dequeue()?.id).toBe(task.id);
    const failed = queue.nack(task.id, new Error("boom again"))!;
    expect(failed.status).toBe("failed");
    expect(failed.retries).toBe(3);
    expect(failed.error).toMatch(/boom again/);
    expect(failed.finishedAt).toBeTruthy();

    // nack on non-running tasks is ignored
    expect(queue.nack(task.id, new Error("late"))).toBeUndefined();
  });

  it("failTask permanently fails queued or running work without retries", () => {
    const queued = queue.enqueue({ agentId: "stale-1", type: "run" });
    expect(queue.failTask(queued.id, new Error("stale"))).toBe(true);
    expect(queue.get(queued.id)?.status).toBe("failed");

    const running = queue.enqueue({ agentId: "stale-2", type: "run" });
    queue.dequeue();
    expect(queue.failTask(running.id, "string error")).toBe(true);
    const record = queue.get(running.id)!;
    expect(record.status).toBe("failed");
    expect(record.error).toContain("string error");
  });

  it("requeue resets claimed tasks without consuming retries", () => {
    const task = queue.enqueue({ agentId: "requeue-agent", type: "run" });
    queue.dequeue();
    expect(queue.requeue(task.id)).toBe(true);
    const back = queue.get(task.id)!;
    expect(back.status).toBe("queued");
    expect(back.startedAt).toBeUndefined();
    expect(back.retries).toBe(0);
  });

  it("cancels only the target agent's non-terminal tasks", () => {
    const mineQueued = queue.enqueue({ agentId: "cancel-me", type: "run", priority: 5 });
    const other = queue.enqueue({ agentId: "keep-me", type: "run", priority: 1 });
    const mineRunning = queue.enqueue({ agentId: "cancel-me", type: "run", priority: 9 });
    queue.dequeue(); // claims the p9 task from cancel-me

    expect(queue.cancelByAgent("cancel-me")).toBe(2);
    expect(queue.get(mineQueued.id)?.status).toBe("cancelled");
    expect(queue.get(mineRunning.id)?.status).toBe("cancelled");
    expect(queue.get(other.id)?.status).toBe("queued");
  });

  it("tracks depth and enforces the queue capacity limit", () => {
    const before = queue.depth();
    const added = queue.enqueue({ agentId: "depth-agent", type: "run" });
    expect(queue.depth()).toBe(before + 1);
    queue.failTask(added.id, new Error("cleanup"));

    // Fill the queue to the security limit and confirm overflow is rejected.
    const fillers: string[] = [];
    try {
      for (;;) fillers.push(queue.enqueue({ agentId: "flood", type: "run" }).id);
    } catch (error) {
      expect(String(error)).toMatch(/task queue is full/);
    }
    expect(fillers.length).toBeGreaterThan(0);
    expect(fillers.length).toBeLessThanOrEqual(100);
    for (const id of fillers) queue.failTask(id, new Error("drain"));
    expect(queue.depth()).toBe(before);
  });

  it("lists tasks filtered by agent and status", () => {
    const t1 = queue.enqueue({ agentId: "list-agent", type: "run" });
    queue.enqueue({ agentId: "list-agent", type: "probe" });
    const all = queue.list({ agentId: "list-agent" });
    expect(all).toHaveLength(2);
    const onlyRun = queue.list({ agentId: "list-agent", status: "queued" }).filter((t) => t.type === "run");
    expect(onlyRun.map((t) => t.id)).toContain(t1.id);
    expect(() => queue.list({ status: "exploding" as never })).toThrow(/invalid task status/);
  });
});
