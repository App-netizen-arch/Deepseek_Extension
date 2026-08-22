/**
 * Built-in agent tools.
 *
 * All filesystem/process operations delegate to the hardened helpers in
 * `code-production.ts` (workspace confinement, secret-path denial, process
 * allowlist, output caps) so there is exactly one security implementation.
 */
import { SECURITY_LIMITS, securePath, secureUrl } from "../security-policy.js";
import {
  ALLOWED_COMMANDS,
  editFile,
  executeApprovedAction,
  readFile,
  run,
  validateShellArgv,
  writeFile,
} from "../code-production.js";
import { validateParams, type Tool, type ToolContext } from "./tool.js";

const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const SHELL_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 15_000;

/** Options for {@link createBuiltinTools}. */
export interface BuiltinToolOptions {
  /** Hostnames `http_request` may contact. Empty list denies everything. */
  allowedHttpDomains?: readonly string[];
}

function str(params: Record<string, unknown>, key: string): string {
  return String(params[key]);
}

/** Build the built-in tool set. A fresh array is returned each call. */
export function createBuiltinTools(options: BuiltinToolOptions = {}): Tool[] {
  const allowedDomains = new Set((options.allowedHttpDomains ?? []).map((d) => d.toLowerCase()));

  const fsRead: Tool<{ path: string }, { path: string; content: string }> = {
    name: "fs_read",
    description: "Read a UTF-8 text file inside the workspace.",
    parameters: { type: "object", properties: { path: { type: "string", description: "workspace-relative file path" } }, required: ["path"] },
    permissionLevel: "low",
    async execute(params, ctx) {
      const p = validateParams(fsRead.parameters, params);
      return { path: p.path as string, content: await readFile(ctx.workspace, p.path as string) };
    },
  };

  const fsWrite: Tool<{ path: string; content: string }, { ok: true }> = {
    name: "fs_write",
    description: "Create or overwrite a text file inside the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    permissionLevel: "medium",
    async execute(params, ctx) {
      const p = validateParams(fsWrite.parameters, params);
      if ((p.content as string).length > SECURITY_LIMITS.maxWorkspaceFileBytes) {
        throw new Error("content exceeds maxWorkspaceFileBytes");
      }
      await writeFile(ctx.workspace, p.path as string, p.content as string);
      return { ok: true };
    },
  };

  const fsEdit: Tool<{ path: string; find: string; replacement: string }, { ok: true }> = {
    name: "fs_edit",
    description: "Replace exactly one occurrence of `find` with `replacement` in a workspace file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replacement: { type: "string" } },
      required: ["path", "find", "replacement"],
    },
    permissionLevel: "medium",
    async execute(params, ctx) {
      const p = validateParams(fsEdit.parameters, params);
      await editFile(ctx.workspace, p.path as string, p.find as string, p.replacement as string);
      return { ok: true };
    },
  };

  const shellRun: Tool<{ command: string; args?: string[] }, Awaited<ReturnType<typeof run>>> = {
    name: "shell_run",
    description: "Run an allowlisted executable with argument array inside the workspace (no shell).",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array" } },
      required: ["command"],
    },
    permissionLevel: "high",
    async execute(params, ctx) {
      const p = validateParams(shellRun.parameters, params);
      if (p.args !== undefined && !Array.isArray(p.args)) throw new Error("args must be an array");
      const argv = [p.command as string, ...((p.args as string[]) ?? [])];
      if (!argv.every((a) => typeof a === "string")) throw new Error("command/args must be strings");
      validateShellArgv(argv);
      return run(argv, securePath(ctx.workspace), SHELL_TIMEOUT_MS);
    },
  };

  const gitStatus: Tool<Record<string, never>, Awaited<ReturnType<typeof run>>> = {
    name: "git_status",
    description: "Show short git status of the workspace repository.",
    parameters: { type: "object" },
    permissionLevel: "low",
    async execute(_params, ctx) {
      return run([...ALLOWED_COMMANDS["git.status"]], securePath(ctx.workspace), GIT_TIMEOUT_MS);
    },
  };

  const gitDiff: Tool<Record<string, never>, Awaited<ReturnType<typeof run>>> = {
    name: "git_diff",
    description: "Show unstaged changes in the workspace repository.",
    parameters: { type: "object" },
    permissionLevel: "low",
    async execute(_params, ctx) {
      return run([...ALLOWED_COMMANDS["git.diff"]], securePath(ctx.workspace), GIT_TIMEOUT_MS);
    },
  };

  const gitCommit: Tool<{ message: string }, unknown> = {
    name: "git_commit",
    description: "Commit already-staged changes in the workspace repository.",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    permissionLevel: "high",
    async execute(params, ctx) {
      const p = validateParams(gitCommit.parameters, params);
      const message = str(p, "message").trim();
      if (!message || message.length > 500) throw new Error("commit message must be 1-500 characters");
      return executeApprovedAction("git.commit", { message }, securePath(ctx.workspace));
    },
  };

  const httpRequest: Tool<
    { url: string; method?: string; headers?: Record<string, string>; body?: string },
    { status: number; headers: Record<string, string>; body: string; truncated: boolean }
  > = {
    name: "http_request",
    description: "Perform an HTTP(S) request to an explicitly allowed domain. Redirects are not followed.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
      },
      required: ["url"],
    },
    permissionLevel: "medium",
    async execute(params, ctx) {
      const p = validateParams(httpRequest.parameters, params);
      const url = secureUrl(p.url as string);
      if (allowedDomains.size === 0 || !allowedDomains.has(url.hostname.toLowerCase())) {
        throw new Error(`domain ${url.hostname} is not on the http_request allowlist`);
      }
      const method = (typeof p.method === "string" ? p.method : "GET").toUpperCase();
      if (!HTTP_METHODS.has(method)) throw new Error(`method ${method} is not allowed`);
      if (url.username || url.password) throw new Error("credentials in URLs are not permitted");
      const headers = new Headers(p.headers as Record<string, string> | undefined);
      if (ctx.signal?.aborted) throw new Error("aborted before request");
      const controller = new AbortController();
      const abortFromAgent = () => controller.abort();
      ctx.signal?.addEventListener("abort", abortFromAgent, { once: true });
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(url, {
          method,
          headers,
          ...(p.body !== undefined && !["GET", "HEAD"].includes(method) ? { body: p.body as string } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
        const responseHeaders: Record<string, string> = {};
        for (const [k, v] of response.headers) responseHeaders[k] = v;
        const buffer = Buffer.from(await response.arrayBuffer());
        const truncated = buffer.length > MAX_HTTP_RESPONSE_BYTES;
        return {
          status: response.status,
          headers: responseHeaders,
          body: buffer.subarray(0, MAX_HTTP_RESPONSE_BYTES).toString("utf8"),
          truncated,
        };
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", abortFromAgent);
      }
    },
  };

  return [fsRead, fsWrite, fsEdit, shellRun, gitStatus, gitDiff, gitCommit, httpRequest];
}