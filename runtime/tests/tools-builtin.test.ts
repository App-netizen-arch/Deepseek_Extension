import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "bds-tools-ws-"));
process.env.BDS_WORKSPACE = WS;
process.env.BDS_RUNTIME_DB = path.join(os.tmpdir(), `bds-tools-builtin-${Date.now()}.db`);

const { createBuiltinTools } = await import("../src/mcp/builtin.js");
const { validateParams } = await import("../src/mcp/tool.js");

const tools = new Map(
  createBuiltinTools({ allowedHttpDomains: ["127.0.0.1", "localhost"] }).map((t) => [t.name, t] as const),
);
const ctx = (agentId = "test-agent") => ({ agentId, workspace: WS });

function tool(name: string): NonNullable<ReturnType<typeof tools.get>> {
  const t = tools.get(name);
  if (!t) throw new Error(`missing builtin ${name}`);
  return t;
}

let httpServer: import("node:http").Server;
let httpPort = 0;

beforeAll(async () => {
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: WS });
  const http = await import("node:http");
  httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello:${req.method}`);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  httpPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
});

describe("built-in tools", () => {
  it("declares all eight tools with expected risk tiers", () => {
    const levels = Object.fromEntries([...tools.values()].map((t) => [t.name, t.permissionLevel]));
    expect(levels).toEqual({
      fs_read: "low",
      fs_write: "medium",
      fs_edit: "medium",
      shell_run: "high",
      git_status: "low",
      git_diff: "low",
      git_commit: "high",
      http_request: "medium",
    });
  });

  it("fs_read reads workspace files but not secrets or escapes", async () => {
    fs.writeFileSync(path.join(WS, "note.txt"), "hello world");
    await expect(tool("fs_read").execute({ path: "note.txt" }, ctx())).resolves.toEqual({ path: "note.txt", content: "hello world" });
    await expect(tool("fs_read").execute({ path: "../outside.txt" }, ctx())).rejects.toThrow();
    await expect(tool("fs_read").execute({ path: ".env" }, ctx())).rejects.toThrow(/denied/);
    await expect(tool("fs_read").execute({}, ctx())).rejects.toThrow(/missing required param: path/);
  });

  it("fs_write creates files and enforces the size cap", async () => {
    await tool("fs_write").execute({ path: "sub/dir/file.md", content: "# hi" }, ctx());
    expect(fs.readFileSync(path.join(WS, "sub/dir/file.md"), "utf8")).toBe("# hi");
    await expect(
      tool("fs_write").execute({ path: "big.bin", content: "x".repeat(10 * 1024 * 1024 + 1) }, ctx()),
    ).rejects.toThrow(/maxWorkspaceFileBytes/);
  });

  it("fs_edit replaces exactly one occurrence", async () => {
    fs.writeFileSync(path.join(WS, "edit.txt"), "alpha beta alpha");
    await expect(tool("fs_edit").execute({ path: "edit.txt", find: "alpha", replacement: "X" }, ctx())).rejects.toThrow(/exactly once/);
    await expect(tool("fs_edit").execute({ path: "edit.txt", find: "beta", replacement: "B" }, ctx())).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(path.join(WS, "edit.txt"), "utf8")).toBe("alpha B alpha");
  });

  it("shell_run allowlists executables and blocks eval patterns", async () => {
    const result = await tool("shell_run").execute({ command: "node", args: ["--version"] }, ctx());
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^v\d+/);
    await expect(tool("shell_run").execute({ command: "./evil.sh" }, ctx())).rejects.toThrow(/not allowlisted/);
    await expect(tool("shell_run").execute({ command: "python3", args: ["-c", "print(1)"] }, ctx())).rejects.toThrow(/eval|inline/);
    await expect(tool("shell_run").execute({ command: "npm", args: ["install", "x"] }, ctx())).rejects.toThrow();
  });

  it("git_status and git_diff run inside the workspace repo", async () => {
    const status = await tool("git_status").execute({}, ctx());
    expect(status.code).toBe(0);
    const diff = await tool("git_diff").execute({}, ctx());
    expect(diff.code).toBe(0);
  });

  it("git_commit commits staged changes", async () => {
    fs.writeFileSync(path.join(WS, "tracked.txt"), "v1\n");
    execSync("git add tracked.txt", { cwd: WS });
    const result = await tool("git_commit").execute({ message: "test commit" }, ctx());
    expect(result.code).toBe(0);
    const log = execSync("git log -1 --format=%s", { cwd: WS }).toString().trim();
    expect(log).toBe("test commit");
    await expect(tool("git_commit").execute({ message: "" }, ctx())).rejects.toThrow(/commit message/);
  });

  it("http_request allows listed domains and rejects everything else", async () => {
    const ok = await tool("http_request").execute({ url: `http://127.0.0.1:${httpPort}/x` }, ctx());
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("hello:GET");
    await expect(tool("http_request").execute({ url: "https://example.com/" }, ctx())).rejects.toThrow(/allowlist/);
    await expect(tool("http_request").execute({ url: "file:///etc/passwd" }, ctx())).rejects.toThrow(/file URLs/);
    await expect(tool("http_request").execute({ url: `http://127.0.0.1:${httpPort}/`, method: "TRACE" }, ctx())).rejects.toThrow(/not allowed/);
    await expect(tool("http_request").execute({ url: "http://user:pass@127.0.0.1/x" }, ctx())).rejects.toThrow(/credentials/);
  });

  it("validateParams enforces types", () => {
    const schema = { type: "object" as const, properties: { n: { type: "number" as const } }, required: ["n"] };
    expect(validateParams(schema, { n: 3 })).toEqual({ n: 3 });
    expect(() => validateParams(schema, {})).toThrow(/missing required param: n/);
    expect(() => validateParams(schema, { n: "3" })).toThrow(/must be number/);
    expect(() => validateParams(schema, [1])).toThrow(/must be an object/);
  });
});
