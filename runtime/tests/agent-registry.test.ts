import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BDS_RUNTIME_DB = path.join(os.tmpdir(), `bds-agent-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

const { RuntimeStore } = await import("../src/store.js");
const { AgentRegistry } = await import("../src/agent/registry.js");

let store: InstanceType<typeof RuntimeStore>;
let registry: InstanceType<typeof AgentRegistry>;

const baseSpec = { name: "scout", type: "demo" };

beforeAll(() => {
  store = new RuntimeStore();
  registry = new AgentRegistry(store.db);
});

afterAll(() => {
  store.close();
  try { fs.rmSync(process.env.BDS_RUNTIME_DB!, { force: true }); } catch {}
});

describe("AgentRegistry", () => {
  it("registers an agent in created state with a UUID id", () => {
    const agent = registry.register(baseSpec);
    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.name).toBe("scout");
    expect(agent.type).toBe("demo");
    expect(agent.state).toBe("created");
    expect(agent.permissions).toEqual({});
    expect(agent.context).toEqual({});
    expect(agent.createdAt).toBe(agent.updatedAt);
  });

  it("rejects invalid spawn specs", () => {
    expect(() => registry.register({ name: "  ", type: "demo" })).toThrow(/name is required/);
    expect(() => registry.register({ name: "x".repeat(129), type: "demo" })).toThrow(/exceeds/);
    expect(() => registry.register({ name: "ok", type: "" })).toThrow(/type is required/);
    expect(() => registry.register({ name: "ok", type: "Demo" })).toThrow(/agent type must match/);
    expect(() => registry.register({ name: "ok", type: "1bad" })).toThrow(/agent type must match/);
    expect(() => registry.register({ name: "ok", type: "demo", permissions: [] as never })).toThrow(/permissions must be an object/);
    expect(() => registry.register({ name: "ok", type: "demo", context: "nope" as never })).toThrow(/context must be an object/);
  });

  it("round-trips optional fields through the database", () => {
    const created = registry.register({
      ...baseSpec,
      name: "linked",
      projectId: "proj-1",
      sessionId: "sess-1",
      permissions: { tools: ["fs_read"], maxSubagents: 0 },
      context: { goal: "explore" },
    });
    const loaded = registry.get(created.id)!;
    expect(loaded.projectId).toBe("proj-1");
    expect(loaded.sessionId).toBe("sess-1");
    expect(loaded.permissions).toEqual({ tools: ["fs_read"], maxSubagents: 0 });
    expect(loaded.context).toEqual({ goal: "explore" });
    expect(loaded.parentId).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("lists agents filtered by state, type, and project", () => {
    registry.update(registry.register({ name: "a", type: "demo" }).id, { state: "completed" });
    registry.register({ name: "b", type: "worker" });
    const byState = registry.list({ state: "completed" });
    expect(byState.map((a) => a.name)).toContain("a");
    expect(byState.every((a) => a.state === "completed")).toBe(true);
    expect(registry.list({ type: "worker" }).map((a) => a.name)).toEqual(["b"]);
    expect(registry.list({ projectId: "nope" })).toEqual([]);
  });

  it("updates mutable fields and bumps updatedAt", async () => {
    const agent = registry.register(baseSpec);
    await new Promise((r) => setTimeout(r, 5));
    const updated = registry.update(agent.id, {
      name: "renamed",
      state: "running",
      context: { step: 2 },
      permissions: { tools: ["fs_write"] },
    });
    expect(updated.name).toBe("renamed");
    expect(updated.state).toBe("running");
    expect(updated.context).toEqual({ step: 2 });
    expect(updated.permissions).toEqual({ tools: ["fs_write"] });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(updated.createdAt));
    expect(registry.get(agent.id)?.state).toBe("running");
  });

  it("rejects invalid updates and missing agents", () => {
    const agent = registry.register(baseSpec);
    expect(() => registry.update(agent.id, { state: "flying" as never })).toThrow(/invalid agent state/);
    expect(() => registry.update(agent.id, { name: " " })).toThrow(/name is required/);
    expect(() => registry.update("missing-agent", { state: "paused" })).toThrow(/does not exist/);
  });

  it("enforces parent links and leaf-first deletion", () => {
    const parent = registry.register({ name: "parent", type: "demo" });
    const child = registry.register({ name: "child", type: "demo", parentId: parent.id });
    expect(registry.get(child.id)?.parentId).toBe(parent.id);
    expect(registry.listChildren(parent.id).map((c) => c.id)).toEqual([child.id]);
    expect(() => registry.register({ name: "orphan", type: "demo", parentId: "missing" })).toThrow(/parent agent.*does not exist/);
    expect(() => registry.delete(parent.id)).toThrow(/still has subagents/);
    expect(registry.delete(child.id)).toBe(true);
    expect(registry.delete(parent.id)).toBe(true);
    expect(registry.get(parent.id)).toBeUndefined();
    expect(registry.delete("never-existed")).toBe(false);
  });
});
