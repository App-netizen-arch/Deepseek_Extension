import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LIMITS, WORKSPACE } from "./config.js";
import type { RuntimeStore } from "./store.js";

export type SupportedLanguage = "zig" | "lean4" | "python";

export interface LocalExecRequest {
  language: string;
  code: string;
  timeout_seconds?: number;
}

export interface LocalExecResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  truncated: boolean;
  timed_out: boolean;
  language: SupportedLanguage;
  command: string[];
}

export const CODE_COMMANDS: Readonly<Record<SupportedLanguage, readonly string[]>> = Object.freeze({
  zig: Object.freeze(["zig", "run"]),
  lean4: Object.freeze(["lake", "env", "lean"]),
  python: Object.freeze(["python3"]),
});

const FILE_NAMES: Record<SupportedLanguage, string> = {
  zig: "main.zig",
  lean4: "Main.lean",
  python: "main.py",
};

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_CODE_BYTES = 256 * 1024;

function normalizeTimeout(seconds: unknown): number {
  const numeric = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 15;
  return Math.max(1_000, Math.min(15_000, Math.floor(numeric * 1_000)));
}

function isSupportedLanguage(value: string): value is SupportedLanguage {
  return value === "zig" || value === "lean4" || value === "python";
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

function boundedAppend(parts: Buffer[], chunk: Buffer, state: { total: number; truncated: boolean }): void {
  const remaining = MAX_OUTPUT_BYTES - state.total;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.byteLength <= remaining) {
    parts.push(chunk);
    state.total += chunk.byteLength;
    return;
  }
  parts.push(chunk.subarray(0, remaining));
  state.total += remaining;
  state.truncated = true;
}

function decode(parts: Buffer[]): string {
  return Buffer.concat(parts).toString("utf8");
}

export async function executeLocalCode(
  request: LocalExecRequest,
  store: RuntimeStore,
): Promise<LocalExecResult> {
  if (!request || typeof request !== "object") throw new Error("invalid execution request");
  if (typeof request.language !== "string" || !isSupportedLanguage(request.language)) {
    throw new Error("language is not allowlisted");
  }
  if (typeof request.code !== "string" || !request.code.trim()) throw new Error("code is required");
  const codeBytes = Buffer.byteLength(request.code, "utf8");
  if (codeBytes > MAX_CODE_BYTES) throw new Error("code exceeds 256 KiB limit");

  const timeoutMs = normalizeTimeout(request.timeout_seconds);
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "bds-exec-"));
  const filePath = path.join(jobDir, FILE_NAMES[request.language]);
  const command = [...CODE_COMMANDS[request.language], filePath];
  const startedAt = Date.now();
  let timedOut = false;
  const stdoutParts: Buffer[] = [];
  const stderrParts: Buffer[] = [];
  const stdoutState = { total: 0, truncated: false };
  const stderrState = { total: 0, truncated: false };

  await fs.writeFile(filePath, request.code, { encoding: "utf8", mode: 0o600 });
  store.audit("code.exec.start", { id: randomUUID(), language: request.language, command });

  try {
    const result = await new Promise<LocalExecResult>((resolve) => {
      const child = spawn(command[0], command.slice(1), {
        cwd: request.language === "lean4" ? WORKSPACE : jobDir,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? os.homedir(),
          TMPDIR: jobDir,
          TEMP: jobDir,
          TMP: jobDir,
        },
      });

      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const stdout = decode(stdoutParts);
        const stderr = decode(stderrParts);
        resolve({
          stdout,
          stderr,
          exit_code: timedOut ? null : exitCode,
          duration_ms: Date.now() - startedAt,
          truncated: stdoutState.truncated || stderrState.truncated,
          timed_out: timedOut,
          language: request.language,
          command,
        });
      };

      child.stdout.on("data", (chunk: Buffer) => boundedAppend(stdoutParts, chunk, stdoutState));
      child.stderr.on("data", (chunk: Buffer) => boundedAppend(stderrParts, chunk, stderrState));
      child.once("error", (error) => {
        stderrParts.push(Buffer.from(error.message));
        finish(1);
      });
      child.once("close", (code) => finish(code));

      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
    });

    store.audit("code.exec.finish", {
      language: result.language,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      truncated: result.truncated,
    });
    return result;
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true });
  }
}

export const CODE_LIMITS = Object.freeze({
  timeout_seconds: TIMEOUT_MS / 1_000,
  max_output_bytes: MAX_OUTPUT_BYTES,
  max_code_bytes: MAX_CODE_BYTES,
  max_memory_bytes: LIMITS.maxMemoryBytes,
});
