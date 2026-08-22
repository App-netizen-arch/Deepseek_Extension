import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "bds-skills-ws-"));
const SKILLS = path.join(WS, ".better-deepseek", "skills");
const DB = path.join(os.tmpdir(), `bds-skills-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
fs.mkdirSync(SKILLS, { recursive: true });
process.env.BDS_WORKSPACE = WS;
process.env.BDS_RUNTIME_DB = DB;
process.env.BDS_SKILLS_DIR = SKILLS;
process.env.BDS_RUNTIME_TOKEN = "skills-test-token-0123456789abcdef";

const { RuntimeStore } = await import("../src/store.js");
const { AgentRegistry } = await import("../src/agent/registry.js");
const { TaskQueue } = await import("../src/agent/queue.js");
const { AgentRunner } = await import("../src/agent/runner.js");
const { createDefaultFactory } = await import("../src/agent/demo-agent.js");
const {
  parseSkill,
  loadSkills,
  getSkillsForAgent,
  skillAppliesTo,
  buildSystemPrompt,
} = await import("../src/agent/skill-loader.js");

let store: InstanceType<typeof RuntimeStore>;
let registry: InstanceType<typeof AgentRegistry>;

function writeSkill(relDir: string, content: string): void {
  const dir = path.join(SKILLS, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

beforeAll(() => {
  store = new RuntimeStore();
  registry = new AgentRegistry(store.db);
  writeSkill(
    "python",
    [
      "---",
      "name: Python Best Practices",
      "description: Style and idioms for generated Python.",
      "version: 1.2.0",
      "agents: demo, worker",
      "---",
      "Always prefer pathlib over os.path.",
    ].join("\n"),
  );
  writeSkill(
    "universal",
    ["---", "name: Universal Safety", "version: 0.1", "---", "Never exfiltrate secrets."].join("\n"),
  );
  writeSkill(
    "deep/nested/go",
    ["---", "name: Go Patterns", "agents:", "  - worker", "  - reviewer", "---", "Handle errors explicitly."].join("\n"),
  );
  writeSkill("broken", "no frontmatter here but also no body marker"); // valid actually (body only)
  writeSkill("invalid", "---\nname: [unclosed\n---\nBody"); // invalid YAML frontmatter -> skipped
});

afterAll(() => {
  store.close();
  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(DB, { force: true }); } catch {}
});

describe("skill parsing", () => {
  it("parses frontmatter fields and body", () => {
    const skill = parseSkill(
      ["---", "name: Py Skills", "description: d", 'version: "2.0"', "agents: demo,worker ", "---", "Body line."].join("\n"),
      "/x/py/SKILL.md",
    );
    expect(skill.name).toBe("Py Skills");
    expect(skill.description).toBe("d");
    expect(skill.version).toBe("2.0");
    expect(skill.appliesTo).toEqual(["demo", "worker"]);
    expect(skill.body).toBe("Body line.");
    // Unquoted YAML floats stringify through String()
    const numeric = parseSkill("---\nversion: 2.0\n---\nbody", "/x/n.md");
    expect(numeric.version).toBe("2");
  });

  it("falls back to directory name and global applicability", () => {
    const skill = parseSkill("# just markdown\ncontent", "/root/universal/SKILL.md");
    expect(skill.name).toBe("universal");
    expect(skill.appliesTo).toEqual([]);
    expect(skill.body).toContain("content");
  });

  it("rejects empty bodies and oversize skills", () => {
    expect(() => parseSkill("---\nname: x\n---\n   \n", "empty.md")).toThrow(/no body content/);
    const huge = `---\nname: big\n---\n${"x".repeat(65 * 1024)}`;
    expect(() => parseSkill(huge, "big.md")).toThrow(/exceeds/);
  });

  it("treats unparseable frontmatter as an error", () => {
    expect(() => parseSkill("---\nname: [unclosed\n---\nBody", "bad.md")).toThrow(/invalid frontmatter/);
  });
});

describe("skill discovery and matching", () => {
  it("finds SKILL.md files recursively and skips invalid ones", async () => {
    const all = await loadSkills();
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(["Go Patterns", "Python Best Practices", "Universal Safety", "broken"]);
    expect(all.find((s) => s.name === "Go Patterns")?.appliesTo).toEqual(["worker", "reviewer"]);
  });

  it("matches skills per agent type", async () => {
    const all = await loadSkills();
    const demo = all.filter((s) => skillAppliesTo(s, "demo"));
    expect(demo.map((s) => s.name).sort()).toEqual(["Python Best Practices", "Universal Safety", "broken"]);
    const worker = all.filter((s) => skillAppliesTo(s, "worker"));
    expect(worker.map((s) => s.name).sort()).toEqual(["Go Patterns", "Python Best Practices", "Universal Safety", "broken"]);
    const reviewer = all.filter((s) => skillAppliesTo(s, "reviewer"));
    expect(reviewer.map((s) => s.name).sort()).toEqual(["Go Patterns", "Universal Safety", "broken"]);
    const viaHelper = await getSkillsForAgent("demo");
    expect(viaHelper.length).toBe(3);
  });

  it("composes deterministic system prompts", () => {
    const [py, uni] = [
      { name: "Py", version: "1.0", appliesTo: [], body: "Use pathlib.", file: "a" },
      { name: "Uni", appliesTo: [], body: "Be safe.", file: "b" },
    ] as const;
    const prompt = buildSystemPrompt("Base instructions.", [uni, py]);
    expect(prompt.startsWith("Base instructions.")).toBe(true);
    expect(prompt.indexOf("<skill name=\"Uni\">")).toBeGreaterThan(-1);
    expect(prompt.indexOf('<skill name="Py v1.0">')).toBeGreaterThan(prompt.indexOf("<skill name=\"Uni\">"));
    expect(buildSystemPrompt("", [])).toBe("");
  });
});

describe("runner skill injection", () => {
  function makeRunner(provider: () => ReturnType<typeof loadSkills> extends Promise<infer T> ? () => T : never): InstanceType<typeof AgentRunner> {
    return new AgentRunner(registry, new TaskQueue(store.db), createDefaultFactory(), {
      concurrency: 2,
      skillProvider: provider as never,
    });
  }

  it("records applicable skills in context and surfaces them in results", async () => {
    const skills = [
      { name: "Python Best Practices", description: "style", version: "1.2.0", appliesTo: ["demo"] as readonly string[], body: "Prefer pathlib.", file: "/mem/py" },
      { name: "Zig Tips", appliesTo: ["builder"] as readonly string[], body: "Use comptime.", file: "/mem/zig" },
      { name: "Always", appliesTo: [] as readonly string[], body: "Stay safe.", file: "/mem/always" },
    ];
    const queue = new TaskQueue(store.db);
    const runner = makeRunner(() => skills);
    const { agent, task } = (() => {
      const res = runner.spawn({ name: "skilled", type: "demo" }, { task: {} });
      return { agent: res.agent, task: res.task };
    })();

    // Persisted context carries skill metadata...
    const descriptor = registry.get(agent.id)!;
    expect(descriptor.context.skills).toEqual([
      { name: "Python Best Practices", version: "1.2.0" },
      { name: "Always", version: null },
    ]);
    await runner.waitIdle();
    const record = queue.get(task!.id)!;
    expect(record.status).toBe("completed");
    // ...and the instance prompt reached the executing agent.
    expect((record.result as { skills?: string[] }).skills).toEqual(["Python Best Practices", "Always"]);
    expect((record.result as { message?: string }).message).toBe("Hello, I am agent skilled");
  }, 20000);

  it("injects nothing when no skills apply or provider is absent", async () => {
    const queue = new TaskQueue(store.db);
    const noneRunner = makeRunner(() => [
      { name: "OnlyBuilders", appliesTo: ["builder"], body: "x", file: "/m/z" },
    ]);
    const spawned = noneRunner.spawn({ name: "plain-agent", type: "demo" }, { task: {} });
    expect(spawned.agent.context.skills).toBeUndefined();
    await noneRunner.waitIdle();
    expect(queue.get(spawned.task!.id)?.result).not.toHaveProperty("skills");

    const bareRunner = new AgentRunner(registry, queue, createDefaultFactory());
    const bare = bareRunner.spawn({ name: "bare-agent", type: "demo" }, { task: {} });
    expect(bare.agent.context.skills).toBeUndefined();
    await bareRunner.waitIdle();
  }, 20000);

  it("respects an explicitly provided context.skills", async () => {
    const runner = makeRunner(() => [
      { name: "WouldBeInjected", appliesTo: [], body: "y", file: "/m/y" },
    ]);
    const explicit = runner.spawn({
      name: "explicit-skills",
      type: "demo",
      context: { skills: [{ name: "HandPicked", version: "9" }] },
    }).agent;
    expect(explicit.context.skills).toEqual([{ name: "HandPicked", version: "9" }]);
  });
});

describe("skills over HTTP", () => {
  it("lists, fetches, and reloads skills via authenticated REST", async () => {
    const { createRuntimeServer } = await import("../src/server.js");
    const server = createRuntimeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: `Bearer ${process.env.BDS_RUNTIME_TOKEN}` };
    try {
      const list = await fetch(`${base}/v1/skills`, { headers: auth });
      const listJson = (await list.json()) as { skills: Array<{ name: string; agents: string[] }> };
      const names = listJson.skills.map((s) => s.name);
      expect(names).toContain("Python Best Practices");
      const pyEntry = listJson.skills.find((s) => s.name === "Python Best Practices")!;
      expect(pyEntry.agents.sort()).toEqual(["demo", "worker"]);

      const fetched = await fetch(`${base}/v1/skills/${encodeURIComponent("Python Best Practices")}`, { headers: auth });
      const fetchedJson = (await fetched.json()) as { skill: { content: string } };
      expect(fetchedJson.skill.content).toBe("Always prefer pathlib over os.path.");

      const missing = await fetch(`${base}/v1/skills/${encodeURIComponent("Nope")}`, { headers: auth });
      expect(missing.status).toBe(404);

      writeSkill("late", "---\nname: Late Addition\n---\nLoaded after restart.");
      const reload = await fetch(`${base}/v1/skills/reload`, { method: "POST", headers: auth });
      const reloadJson = (await reload.json()) as { ok: boolean; count: number };
      expect(reloadJson.ok).toBe(true);
      expect(reloadJson.count).toBeGreaterThanOrEqual(5);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});

describe("bds CLI", () => {
  it("adds and lists skills through the bds script", () => {
    const cliDir = path.join(WS, "cli-skills");
    const source = path.join(WS, "source-skill.md");
    fs.writeFileSync(source, "---\nname: CLI Added Skill\nversion: 3\n---\nFrom the CLI.");
    const run = (args: string[], envDir: string) =>
      execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "bds.mjs"), ...args], {
        env: { ...process.env, BDS_SKILLS_DIR: envDir },
        encoding: "utf8",
      });

    const added = JSON.parse(run(["skill", "add", source], cliDir)) as { ok: boolean; added: string; file: string };
    expect(added.ok).toBe(true);
    expect(added.added).toBe("cli-added-skill");
    expect(fs.readFileSync(path.join(cliDir, "cli-added-skill", "SKILL.md"), "utf8")).toContain("From the CLI.");

    const listed = JSON.parse(run(["skill", "list"], cliDir)) as { count: number; skills: Array<{ name: string }> };
    expect(listed.count).toBe(1);
    expect(listed.skills[0]?.name).toBe("CLI Added Skill");
  });
});
