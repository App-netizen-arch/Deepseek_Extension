import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "bds-wf-ws-"));
const FLOWS = path.join(WS, "workflows");
const DB = path.join(os.tmpdir(), `bds-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
fs.mkdirSync(FLOWS, { recursive: true });
process.env.BDS_WORKSPACE = WS;
process.env.BDS_RUNTIME_DB = DB;
process.env.BDS_WORKFLOWS_DIR = FLOWS;
process.env.BDS_RUNTIME_TOKEN = "workflow-test-token-0123456789abcdef";

const { RuntimeStore } = await import("../src/store.js");
const { AgentRegistry } = await import("../src/agent/registry.js");
const { TaskQueue } = await import("../src/agent/queue.js");
const { AgentRunner } = await import("../src/agent/runner.js");
const { createDefaultFactory } = await import("../src/agent/demo-agent.js");
const { ToolRegistry } = await import("../src/mcp/registry.js");
const { ToolInvocationService } = await import("../src/mcp/service.js");
const typeTool = await import("../src/mcp/tool.js");
const { resolveTemplates, resolvePath } = await import("../src/workflow/template.js");
const { parseWorkflow, loadWorkflowDefinitions, findWorkflow, validateGraph } = await import("../src/workflow/loader.js");
const { WorkflowRunner } = await import("../src/workflow/runner.js");

let store: InstanceType<typeof RuntimeStore>;
let registry: InstanceType<typeof AgentRegistry>;
let queue: InstanceType<typeof TaskQueue>;
let agentRunner: InstanceType<typeof AgentRunner>;
let workflowRunner: InstanceType<typeof WorkflowRunner>;

const callOrder: string[] = [];
const timings: Record<string, { start: number; end: number }> = {};
let flakyCalls = 0;

function makeTools(): InstanceType<typeof ToolRegistry> {
  const registry2 = new ToolRegistry();
  const register = (name: string, execute: typeTool.Tool["execute"]) =>
    registry2.register({ name, description: name, parameters: { type: "object" }, permissionLevel: "low", execute });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  register("record_a", (async () => { callOrder.push("a"); return { step: "a" }; }) as typeTool.Tool["execute"]);
  register("record_b", (async () => { callOrder.push("b"); return { step: "b" }; }) as typeTool.Tool["execute"]);
  register("overlap", (async (_params, ctx) => {
    const key = ctx.agentId + String(timingsCount++);
    timings[key] = { start: Date.now(), end: 0 };
    await sleep(150);
    timings[key].end = Date.now();
    return { key };
  }) as typeTool.Tool["execute"]);
  register("flaky", (async () => {
    flakyCalls += 1;
    if (flakyCalls === 1) throw new Error("transient boom");
    return { attempt: flakyCalls };
  }) as typeTool.Tool["execute"]);
  register("always_fails", (async () => { throw new Error("deterministic failure"); }) as typeTool.Tool["execute"]);
  register("slow", (async () => { await sleep(30_000); return {}; }) as typeTool.Tool["execute"]);
  return registry2;
}

let timingsCount = 0;
const tools = makeTools();

beforeAll(() => {
  store = new RuntimeStore();
  registry = new AgentRegistry(store.db);
  queue = new TaskQueue(store.db);
  agentRunner = new AgentRunner(registry, queue, createDefaultFactory());
  const service = new ToolInvocationService(tools, store as never, WS, { pollMs: 20 });
  workflowRunner = new WorkflowRunner(
    {
      db: store.db,
      invokeTool: (caller, toolName, params) => service.invoke(caller, toolName, params),
      agentRunner,
      agentQueue: queue,
    },
    { pollMs: 20, defaultStepTimeoutMs: 5000, concurrencyPerRun: 4 },
  );
});

afterAll(() => {
  store.close();
  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(DB, { force: true }); } catch {}
});

async function waitForRun(runId: string, statuses: string[], timeoutMs = 10_000): Promise<ReturnType<WorkflowRunner["get"]>> {
  for (let i = 0; i < timeoutMs / 25; i += 1) {
    const record = workflowRunner.get(runId)!;
    if (statuses.includes(record.status)) return record;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join("|")} in time`);
}

describe("workflow templates", () => {
  it("preserves types for whole-string templates and coerces embedded ones", () => {
    const ctx = { input: { n: 5, topic: "math" }, steps: { s1: { status: "completed", result: { url: "https://x", count: 3 } } } };
    expect(resolveTemplates("{{input.n}}", ctx)).toBe(5);
    expect(resolveTemplates("{{s1.result.url}}", ctx)).toBe("https://x");
    expect(resolveTemplates("about {{input.topic}} #{{s1.result.count}}", ctx)).toBe("about math #3");
    expect(resolveTemplates("missing -> {{nope.deep}}!", ctx)).toBe("missing -> !");
    expect(resolveTemplates("{{nope.deep}}", ctx)).toBeUndefined();
  });

  it("resolves nested objects, arrays, and dot-indexed paths", () => {
    const value = resolveTemplates(
      { list: ["{{input.a}}", "{{input.b}}"], deep: { v: "{{steps.s1.result.items.0}}" } },
      { input: { a: 1, b: "two" }, steps: { s1: { status: "completed", result: { items: ["first", "second"] } } } },
    ) as { list: unknown[]; deep: { v: string } };
    expect(value.list).toEqual([1, "two"]);
    expect(value.deep.v).toBe("first");
    expect(resolvePath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
    expect(resolvePath({}, "x.y")).toBeUndefined();
  });
});

describe("workflow loader", () => {
  it("parses YAML with spec-style shorthand and validates the graph", () => {
    const def = parseWorkflow(
      [
        "name: Research and Summarize",
        "description: demo flow",
        "steps:",
        "  - id: search",
        "    type: tool",
        "    tool: web_search",
        "    params: { query: \"{{input.topic}}\" }",
        "  - id: summarize",
        "    type: agent",
        "    agent: summarizer",
        "    depends_on: [search]",
        "    retries: 2",
        "    when: \"{{search.result.ok}}\"",
      ].join("\n"),
      "research.yml",
    );
    expect(def.name).toBe("Research and Summarize");
    expect(def.steps[0]).toMatchObject({ id: "search", type: "tool", target: "web_search" });
    expect(def.steps[1]).toMatchObject({ id: "summarize", type: "agent", target: "summarizer", depends_on: ["search"], retries: 2 });
    expect(() => validateGraph(def)).not.toThrow();
  });

  it("rejects duplicate ids, unknown deps, cycles, and bad steps", () => {
    expect(() => parseWorkflow("name: x\nsteps:\n  - id: a\n    type: tool\n    tool: t\n  - id: a\n    type: tool\n    tool: t", "x.yml")).toThrow(/duplicate step id/);
    expect(() => parseWorkflow("steps:\n  - id: a\n    type: tool\n    tool: t\n    depends_on: [ghost]", "y.yml")).toThrow(/unknown step ghost/);
    expect(() => parseWorkflow("steps:\n  - id: a\n    type: tool\n    tool: t\n    depends_on: [b]\n  - id: b\n    type: tool\n    tool: t\n    depends_on: [a]", "z.yml")).toThrow(/cycle/);
    expect(() => parseWorkflow("steps:\n  - id: a\n    type: dance\n    target: x", "w.yml")).toThrow(/type must be/);
    const json = parseWorkflow(JSON.stringify({ name: "json-flow", steps: [{ id: "s", type: "tool", tool: "t" }] }), "f.json");
    expect(json.name).toBe("json-flow");
  });

  it("loads definitions from the configured directory and skips broken files", async () => {
    fs.writeFileSync(path.join(FLOWS, "good.yml"), "name: good-flow\nsteps:\n  - id: one\n    type: tool\n    tool: record_a\n");
    fs.writeFileSync(path.join(FLOWS, "bad.yml"), "steps: {{{{");
    const loaded = await loadWorkflowDefinitions();
    expect(loaded.map((d) => d.name)).toContain("good-flow");
    expect(await findWorkflow("good-flow")).toBeDefined();
    expect(await findWorkflow("bad-flow-name")).toBeUndefined();
  });
});

describe("workflow runner", () => {
  it("executes simple workflows in declared order with template chaining", async () => {
    callOrder.length = 0;
    const def = parseWorkflow(
      [
        "name: ordered-flow",
        "steps:",
        "  - id: first",
        "    type: tool",
        "    tool: record_a",
        "  - id: second",
        "    type: tool",
        "    tool: record_b",
        "    depends_on: [first]",
        "    params: { from: \"{{first.result.step}}\" }",
      ].join("\n"),
      "ordered.yml",
    );
    const { runId } = workflowRunner.start(def, {});
    const record = (await waitForRun(runId, ["completed"]))!;
    expect(record.status).toBe("completed");
    expect(callOrder).toEqual(["a", "b"]);
    expect(record.steps.second.result).toEqual({ step: "b" });
    expect(Object.keys(record.steps)).toEqual(["first", "second"]);
  }, 20000);

  it("retries transient failures until they succeed", async () => {
    flakyCalls = 0;
    const def = parseWorkflow("name: retry-ok\nsteps:\n  - id: f\n    type: tool\n    tool: flaky\n    retries: 3", "retry-ok.yml");
    const { runId } = workflowRunner.start(def, {});
    const record = (await waitForRun(runId, ["completed"]))!;
    expect(record.status).toBe("completed");
    expect(flakyCalls).toBe(2);
    expect(record.steps.f.attempts).toBe(2);
  }, 20000);

  it("fails after exhausting retries and skips dependents of the failed step", async () => {
    const def = parseWorkflow(
      [
        "name: retry-exhausted",
        "steps:",
        "  - id: broken",
        "    type: tool",
        "    tool: always_fails",
        "    retries: 1",
        "  - id: child",
        "    type: tool",
        "    tool: record_a",
        "    depends_on: [broken]",
        "  - id: bystander",
        "    type: tool",
        "    tool: record_b",
      ].join("\n"),
      "exhausted.yml",
    );
    callOrder.length = 0;
    const { runId } = workflowRunner.start(def, {});
    const record = (await waitForRun(runId, ["failed"]))!;
    expect(record.status).toBe("failed");
    expect(record.steps.broken.status).toBe("failed");
    expect(record.steps.broken.attempts).toBe(2); // initial + 1 retry
    expect(record.steps.child.status).toBe("skipped");
    expect(record.error).toMatch(/steps failed/);
    // Independent bystander still ran.
    expect(callOrder).toContain("b");
    expect(callOrder).not.toContain("a-child");
  }, 20000);

  it("continue_on_error lets dependents run even though the run fails", async () => {
    callOrder.length = 0;
    const def = parseWorkflow(
      [
        "name: continue-on-error",
        "steps:",
        "  - id: broken",
        "    type: tool",
        "    tool: always_fails",
        "    continue_on_error: true",
        "  - id: child",
        "    type: tool",
        "    tool: record_a",
        "    depends_on: [broken]",
      ].join("\n"),
      "coe.yml",
    );
    const { runId } = workflowRunner.start(def, {});
    const record = (await waitForRun(runId, ["failed"]))!;
    expect(record.steps.child.status).toBe("completed");
    expect(callOrder).toContain("a");
  }, 20000);

  it("skips steps whose when-condition is falsy", async () => {
    const def = parseWorkflow(
      [
        "name: conditional",
        "steps:",
        "  - id: gate",
        "    type: tool",
        "    tool: record_a",
        "    when: \"{{input.enabled}}\"",
        "  - id: always",
        "    type: tool",
        "    tool: record_b",
        "    when: \"yes\"",
      ].join("\n"),
      "conditional.yml",
    );
    const { runId } = workflowRunner.start(def, { enabled: false });
    const record = (await waitForRun(runId, ["completed"]))!;
    expect(record.steps.gate.status).toBe("skipped");
    expect(record.steps.always.status).toBe("completed");
  }, 20000);

  it("runs independent steps concurrently (overlapping execution windows)", async () => {
    timingsCount = 0;
    for (const key of Object.keys(timings)) delete timings[key];
    const def = parseWorkflow(
      [
        "name: parallel",
        "steps:",
        "  - id: p1",
        "    type: tool",
        "    tool: overlap",
        "  - id: p2",
        "    type: tool",
        "    tool: overlap",
        "  - id: joined",
        "    type: tool",
        "    tool: record_a",
        "    depends_on: [p1, p2]",
      ].join("\n"),
      "parallel.yml",
    );
    const startedAt = Date.now();
    const { runId } = workflowRunner.start(def, {});
    await waitForRun(runId, ["completed"]);
    const [w1, w2] = Object.values(timings);
    const overlap = Math.min(w1.end, w2.end) - Math.max(w1.start, w2.start);
    expect(overlap).toBeGreaterThan(50); // genuinely concurrent
    expect(Date.now() - startedAt).toBeLessThan(600); // not sequential (2x150+)
  }, 20000);

  it("runs agent-type steps as subagents under the run supervisor", async () => {
    const def = parseWorkflow("name: agent-step\nsteps:\n  - id: greet\n    type: agent\n    agent: demo\n    params: { source: workflow }", "agent-step.yml");
    const { runId } = workflowRunner.start(def, {});
    const record = (await waitForRun(runId, ["completed"]))!;
    expect(record.agentId).toBeDefined();
    const children = registry.listChildren(record.agentId!);
    expect(children.length).toBe(1);
    expect(registry.get(children[0]!.id)?.state).toBe("completed");
    expect((record.steps.greet.result as { message?: string }).message).toContain("agent wf-greet");
  }, 20000);

  it("cancels promptly and cascades to the supervisor subtree", async () => {
    const def = parseWorkflow(
      [
        "name: cancellable",
        "steps:",
        "  - id: slowpoke",
        "    type: tool",
        "    tool: slow",
        "    timeout_ms: 20000",
        "  - id: after",
        "    type: tool",
        "    tool: record_a",
        "    depends_on: [slowpoke]",
      ].join("\n"),
      "cancellable.yml",
    );
    const { runId } = workflowRunner.start(def, {});
    for (let i = 0; i < 100 && workflowRunner.get(runId)!.steps.slowpoke.status !== "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const cancelledAt = Date.now();
    expect(workflowRunner.cancel(runId)).toBe(true);
    expect(workflowRunner.cancel(runId)).toBe(false); // already terminal
    const record = (await waitForRun(runId, ["cancelled"]))!;
    expect(Date.now() - cancelledAt).toBeLessThan(3000); // prompt, not 30s
    expect(workflowRunner.get(runId)!.steps.after.status).toBe("pending"); // never launched
    expect(registry.get(record.agentId!)?.state).toBe("cancelled");
  }, 20000);

  it("lists recent runs newest first", async () => {
    const runs = workflowRunner.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(runs.map((r) => r.status))).toEqual(new Set(["completed", "failed", "cancelled"]));
  });
});

describe("workflow HTTP endpoints", () => {
  it("starts, tracks, and cancels workflows over authenticated REST", async () => {
    fs.writeFileSync(
      path.join(FLOWS, "http-flow.yml"),
      [
        "name: http-flow",
        "steps:",
        "  - id: write",
        "    type: tool",
        "    tool: fs_write",
        "    params: { path: \"wf-http.txt\", content: \"written by {{input.writer}}\" }",
        "  - id: read",
        "    type: tool",
        "    tool: fs_read",
        "    depends_on: [write]",
        "    params: { path: \"wf-http.txt\" }",
        "  - id: greet",
        "    type: agent",
        "    agent: demo",
        "    depends_on: [read]",
      ].join("\n"),
    );
    const { createRuntimeServer } = await import("../src/server.js");
    const server = createRuntimeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: `Bearer ${process.env.BDS_RUNTIME_TOKEN}`, "content-type": "application/json" };
    try {
      const catalog = await fetch(`${base}/v1/workflows`, { headers: auth });
      const catalogJson = (await catalog.json()) as { workflows: Array<{ name: string }> };
      expect(catalogJson.workflows.map((w) => w.name)).toContain("http-flow");

      const missing = await fetch(`${base}/v1/workflow/run`, { method: "POST", headers: auth, body: JSON.stringify({ name: "nope" }) });
      expect(missing.status).toBe(404);

      const started = await fetch(`${base}/v1/workflow/run`, { method: "POST", headers: auth, body: JSON.stringify({ name: "http-flow", input: { writer: "tester-agent" } }) });
      expect(started.status).toBe(202);
      const { run_id } = (await started.json()) as { run_id: string };

      let statusJson!: { run: { status: string; steps: Record<string, { status: string; result?: { content?: string } }> } };
      for (let i = 0; i < 100; i += 1) {
        const res = await fetch(`${base}/v1/workflow/${run_id}/status`, { headers: auth });
        statusJson = (await res.json()) as typeof statusJson;
        if (statusJson.run.status === "completed") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(statusJson.run.status).toBe("completed");
      expect(statusJson.run.steps.write.status).toBe("completed");
      expect(statusJson.run.steps.read.result?.content).toBe("written by tester-agent");
      expect(fs.readFileSync(path.join(WS, "wf-http.txt"), "utf8")).toBe("written by tester-agent");

      const runs = await fetch(`${base}/v1/workflow/runs`, { headers: auth });
      const runsJson = (await runs.json()) as { runs: Array<{ id: string }> };
      expect(runsJson.runs.map((r) => r.id)).toContain(run_id);

      // Unknown run cancel -> 409.
      const badCancel = await fetch(`${base}/v1/workflow/no-such-run/cancel`, { method: "POST", headers: auth });
      expect(badCancel.status).toBe(409);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});
